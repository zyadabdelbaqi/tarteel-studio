import { supabaseClient, state } from './store.js';
import { UI } from './ui.js';
import { checkFeaturePermission, enforceSingleSession, checkAuth, loadUserPlan, updateProfileUI, signInWithGoogle, loadTestimonials } from './auth.js';
import { updateExportButtonState, resetExportUI, secureExport, audioBufferToWavBytes } from './export.js';
import { initRenderer, startMainSyncLoop, ensureFontLoaded } from './renderer.js';
import { initAudio, stopAudio, playSeamless, clearLocalAudioFile, updateAudioEffectParams, fetchAudioBuffer } from './audio.js';
import { getCache, setCache } from './db.js';

const surahSlugs = [
    "alfatihah", "albaqarah", "ali-imran", "annisa", "almaidah", "alanam", "alaraf", "alanfal", "attawbah", "yunus",
    "hud", "yusuf", "arrad", "ibrahim", "alhijr", "annahl", "alisra", "alkahf", "maryam", "ta-ha",
    "alanbiya", "alhajj", "almuminun", "annur", "alfurqan", "ashshuara", "annaml", "alqasas", "alankabut", "arrum",
    "luqman", "assajdah", "alahzab", "saba", "fatir", "yasin", "assaffat", "sad", "azzumar", "ghafir",
    "fussilat", "ashshura", "azzukhruf", "addukhan", "aljathiyah", "alahqaf", "muhammad", "alfath", "alhujurat", "qaf",
    "adhdhariyat", "attur", "annajm", "alqamar", "arrahman", "alwaqiah", "alhadid", "almujadila", "alhashr", "almumtahanah",
    "assaff", "aljumuah", "almunafiqun", "attaghabun", "attalaq", "attahrim", "almulk", "alqalam", "alhaqqah", "almaarij",
    "nuh", "aljinn", "almuzzammil", "almuddathir", "alqiyamah", "alinsan", "almursalat", "annaba", "annaziat", "abasa",
    "attakwir", "alinfitar", "almutaffifin", "alinshiqaq", "alburuj", "attariq", "alala", "alghashiyah", "alfajr", "albalad",
    "ashshams", "allayl", "adduhaa", "ashsharh", "attin", "alalaq", "alqadr", "albayyinah", "azzalzalah", "aladiyat",
    "alqariah", "attakathur", "alasr", "alhumazah", "alfil", "quraysh", "almaun", "alkawthar", "alkafirun", "annasr",
    "almasad", "alikhlas", "alfalaq", "annas"
];

    async function checkAppUpdates() {
        try {
            if (!supabaseClient) return;
            
            const { data, error } = await supabaseClient
                .from('app_updates')
                .select('*')
                .eq('is_active', true)
                .limit(1)
                .maybeSingle();

            if (error || !data) return;

            const lastSeenUpdateId = localStorage.getItem('last_seen_update');

            if (data.id !== lastSeenUpdateId) {
                const safeTitle = data.title || 'تحديث جديد';
                const safeContent = data.content || '';
                
                UI.updateTitle.textContent = safeTitle;
                UI.updateContent.textContent = ''; // تفريغ المحتوى
                
                // بناء الأسطر الجديدة بأمان تام باستخدام الـ DOM بدلاً من innerHTML
                safeContent.split(/(?:\r\n|\r|\n)/g).forEach((line, idx, arr) => {
                    UI.updateContent.appendChild(document.createTextNode(line));
                    if (idx < arr.length - 1) UI.updateContent.appendChild(document.createElement('br'));
                });
                
                UI.updatesModal.style.display = 'flex';
                if (window.lucide) window.lucide.createIcons();

                UI.closeUpdateBtn.onclick = () => {
                    localStorage.setItem('last_seen_update', data.id);
                    UI.updatesModal.style.display = 'none';
                };
            }
        } catch (e) { console.error("Error checking updates:", e); }
    }

    function loadHeavyScripts() {
        if (!document.getElementById('fixWebmScript')) {
            const script = document.createElement('script');
            script.id = 'fixWebmScript';
            script.src = 'js/lib/fix-webm-duration.min.js';
            script.defer = true;
            script.onload = () => {
                if (!window.fixWebmDuration && window.ysFixWebmDuration) window.fixWebmDuration = window.ysFixWebmDuration;
            };
            document.body.appendChild(script);
        }
    }

    async function start() {
        if (window.lucide) window.lucide.createIcons();
        if (typeof fbq !== 'undefined') {
            fbq('track', 'ViewContent');
        }
        if (supabaseClient) {
            const urlHasAuthParams = window.location.hash.includes('access_token=') || window.location.hash.includes('refresh_token=') || window.location.search.includes('code=');
            
            const { data: { session } } = await supabaseClient.auth.getSession();
            
            if (urlHasAuthParams) {
                // إزالة رموز تسجيل الدخول من الرابط بعد معالجتها لمنع سرقة الجهاز القديم للجلسة عند الريفريش
                const cleanUrl = window.location.href.split('#')[0].split('?')[0];
                window.history.replaceState(null, '', cleanUrl);
            }

            state.user = session?.user || null;
            if (state.user) {
                const isValid = await enforceSingleSession(state.user);
                if (isValid) {
                    await loadUserPlan().catch(e => console.warn("Initial load plan error:", e));
                    // جلب البيانات الأحدث من السيرفر للتأكد من عدم تسجيل الدخول من جهاز آخر أثناء إغلاق الصفحة
                    supabaseClient.auth.getUser().then(({ data: { user } }) => {
                        if (user) enforceSingleSession(user);
                    });
                }
            }

            supabaseClient.auth.onAuthStateChange(async (_event, session) => {
                if (_event === 'SIGNED_IN' && typeof fbq !== 'undefined') {
                    fbq('track', 'CompleteRegistration');
                }
                const isNewLogin = _event === 'SIGNED_IN' && !state.user && session?.user;
                state.user = session?.user || null;
                
                // إظهار شاشة التحميل إذا كان هذا تسجيل دخول جديد
                if (isNewLogin) {
                    if (UI.globalLoader) {
                        if (UI.globalLoaderText) UI.globalLoaderText.innerText = "جاري إعداد بيانات حسابك...";
                        UI.globalLoader.classList.remove('hidden');
                        setTimeout(() => {
                            UI.globalLoader.style.opacity = '1';
                            UI.globalLoader.style.pointerEvents = 'auto';
                        }, 10);
                    }
                }

                if (state.user) {
                    const isValid = await enforceSingleSession(state.user);
                    if (!isValid) return;
                    await loadUserPlan().catch(e => console.warn("Auth change plan error:", e));
                }
                checkAuth();

                // إخفاء شاشة التحميل بعد الانتهاء من المزامنة
                if (isNewLogin) {
                    if (UI.globalLoader) {
                        UI.globalLoader.style.opacity = '0';
                        UI.globalLoader.style.pointerEvents = 'none';
                        setTimeout(() => UI.globalLoader.classList.add('hidden'), 500);
                    }
                }

                if (state.user && sessionStorage.getItem('pendingExport') === 'true') {
                    document.getElementById('landingPage').style.display = 'none';
                    sessionStorage.removeItem('pendingExport');
                    UI.authScreen.classList.add('hidden');
                    loadHeavyScripts();
                    if (state.exportBlobUrl) resetExportUI(); else UI.confirmModal.style.display = 'flex';
                }
            });
        }
        checkAuth();
        updateExportButtonState();

        // إضافة فحص دوري للجلسة لمنع استخدام الحساب على أكثر من جهاز في نفس الوقت
        let isCheckingSession = false;
        setInterval(async () => {
            if (state.user && !state.isExporting && !isCheckingSession) {
                isCheckingSession = true;
                try {
                    const { data: { user }, error } = await supabaseClient.auth.getUser();
                    if (user && !error) {
                        enforceSingleSession(user);
                    }
                } catch (e) {} finally {
                    isCheckingSession = false;
                }
            }
        }, 15000); // الفحص كل 15 ثانية لتخفيف الضغط على الشبكة ومنع تكدس الطلبات

        await Promise.all([loadReciters(), loadSurahs(), loadTranslations()]);
        await loadTestimonials(); // جلب التقييمات الحقيقية
        checkAppUpdates(); // فحص التحديثات وعرضها إذا لزم الأمر

        // قراءة السورة المطلوبة من الرابط لصفحات الـ SEO التلقائية
        const urlParams = new URLSearchParams(window.location.search);
        let targetSurah = urlParams.get('surah');
        const pathMatch = window.location.pathname.match(/surah-([a-z0-9-]+)-video/i);
        if (pathMatch) {
            const slugIndex = surahSlugs.indexOf(pathMatch[1]);
            if (slugIndex !== -1) targetSurah = slugIndex + 1;
        }

        let shouldOpenStudio = urlParams.get('app') === 'true';

        if (targetSurah && !isNaN(targetSurah) && targetSurah >= 1 && targetSurah <= 114) {
            state.selectedSurah = parseInt(targetSurah);
            Array.from(UI.surah.options).forEach(opt => opt.selected = (opt.value == state.selectedSurah));
            shouldOpenStudio = true;
        }

        if (shouldOpenStudio) {
            // الدخول للاستوديو وتخطي الصفحة الرئيسية مباشرة
            const lp = document.getElementById('landingPage');
            if (lp) {
                lp.style.display = 'none';
                lp.style.opacity = '0';
                lp.style.pointerEvents = 'none';
            }
            loadHeavyScripts();
        }

        initRenderer();

        setupEvents();

        const savedState = sessionStorage.getItem('editorState');
        if (savedState) {
            try {
                const s = JSON.parse(savedState);
                state.selectedSurah = s.state.selectedSurah;
                state.selectedReciter = s.state.selectedReciter;
                state.selectedTranslation = isNaN(s.state.selectedTranslation) ? s.state.selectedTranslation : 'english';

                await updateContent();

                for (const key in s.ui) {
                    if (UI[key]) {
                        if (UI[key].type === 'checkbox') UI[key].checked = s.ui[key];
                        else UI[key].value = s.ui[key];
                    }
                }

                if (s.state.backgroundUrl && s.state.mediaType === 'image') {
                    state.mediaType = 'image';
                    state.backgroundUrl = s.state.backgroundUrl;
                    state.bgImg.src = state.backgroundUrl;

                    document.querySelectorAll('.asset-thumb').forEach(t => t.classList.remove('active'));
                    document.querySelectorAll('#stockImages img').forEach(img => {
                        const baseUrl = img.src.split('?')[0];
                        if (state.backgroundUrl.startsWith(baseUrl)) {
                            img.classList.add('active');
                        }
                    });
                }

                if (UI.canvasSize) UI.canvasSize.dispatchEvent(new Event('change'));
                renderReciterButtons(UI.reciterSearch.value);
                updateDurationDisplay();
            } catch (e) { console.error(e); await updateContent(); }
            sessionStorage.removeItem('editorState');
        } else {
            await updateContent();
            // تعيين خلفية افتراضية (Default Background)
            const defaultBg = "img/backgrounds/bg1.webp";
            state.backgroundUrl = defaultBg;
            state.bgImg.src = defaultBg;
            const firstThumb = document.querySelector('#stockImages img');
            if (firstThumb) firstThumb.classList.add('active');
            
            // مزامنة قيمة ظل الآيات الافتراضية في الواجهة
            if (UI.shadowBlur) UI.shadowBlur.value = 15;
            if (UI.shadowBlurVal) UI.shadowBlurVal.innerText = '15';
        }

        if (state.user && sessionStorage.getItem('pendingExport') === 'true') {
            document.getElementById('landingPage').style.display = 'none';
            sessionStorage.removeItem('pendingExport');
            UI.authScreen.classList.add('hidden');
            loadHeavyScripts();
            if (state.exportBlobUrl) resetExportUI(); else UI.confirmModal.style.display = 'flex';
        }

        // إجبار الواجهة على مزامنة جميع أشرطة التمرير مع حالة التطبيق والمعاينة فور فتح الموقع
        const syncVisualStates = [
            UI.fontSize, UI.bgBlur, UI.bgZoom, UI.opacityRange,
            UI.shadowBlur, UI.textY, UI.transShadowBlur, UI.animIntensity,
            UI.surahY, UI.surahX, UI.surahFontSize, UI.waveformY, UI.waveformHeight
        ];
        syncVisualStates.forEach(el => {
            if (el) el.dispatchEvent(new Event('input', { bubbles: true }));
        });

        startMainSyncLoop(); // Start data syncing loop

        // إخفاء شاشة التحميل العامة بعد انتهاء تجهيز الموقع
        if (UI.globalLoader) {
            UI.globalLoader.style.opacity = '0';
            UI.globalLoader.style.pointerEvents = 'none';
            setTimeout(() => UI.globalLoader.classList.add('hidden'), 500);
        }
    }

        async function loadReciters() {
            try {
                let data = await getCache('reciters');
                if (!data) {
                    const res = await fetch('https://api.quran.com/api/v4/resources/recitations?language=ar');
                    data = await res.json();
                    await setCache('reciters', data);
                }

                const customReciters = [
                    { id: 101, reciter_name: "Maher Al Muaiqly", style: "Murattal", translated_name: { name: "ماهر المعيقلي" } },
                    { id: 102, reciter_name: "Yasser Al Dossary", style: "Murattal", translated_name: { name: "ياسر الدوسري" } },
                    { id: 103, reciter_name: "Ahmed Al Ajmi", style: "Murattal", translated_name: { name: "أحمد العجمي" } },
                    { id: 104, reciter_name: "Abdur-Rahman as-Sudais", style: "Murattal", translated_name: { name: "عبدالرحمن السديس" } },
                    { id: 105, reciter_name: "Saad Al-Ghamdi", style: "Murattal", translated_name: { name: "سعد الغامدي" } },
                    { id: 106, reciter_name: "Ali Jaber", style: "Murattal", translated_name: { name: "علي جابر" } },
                    { id: 107, reciter_name: "Shahriar Parhizgar", style: "Murattal", translated_name: { name: "شهريار برهيزكار" } },
                    { id: 108, reciter_name: "Karim Mansoori", style: "Murattal", translated_name: { name: "كريم المنصوري" } },
                    { id: 109, reciter_name: "Nabil Rifa3i", style: "Murattal", translated_name: { name: "نبيل الرفاعي" } },
                    { id: 110, reciter_name: "Sahl Yassin", style: "Murattal", translated_name: { name: "سهل ياسين" } },
                    { id: 111, reciter_name: "Yassin Al Jazaery", style: "Murattal", translated_name: { name: "ياسين الجزائري" } },
                    { id: 112, reciter_name: "Nasser Alqatami", style: "Murattal", translated_name: { name: "ناصر القطامي" } },
                    { id: 113, reciter_name: "Muhammad Jibreel", style: "Murattal", translated_name: { name: "محمد جبريل" } },
                    { id: 114, reciter_name: "Muhammad Ayyoub", style: "Murattal", translated_name: { name: "محمد أيوب" } },
                    { id: 115, reciter_name: "Mahmoud Ali Al Banna", style: "Murattal", translated_name: { name: "محمود علي البناء" } },
                    { id: 117, reciter_name: "Fares Abbad", style: "Murattal", translated_name: { name: "فارس عباد" } }
                ];

                const priorityIds = [7, 104, 4, 101, 102, 117, 105, 2, 103, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 93, 156, 86, 5, 11, 3, 10];
                state.reciters = [...customReciters, ...data.recitations].sort((a, b) => {
                    const indexA = priorityIds.indexOf(a.id);
                    const indexB = priorityIds.indexOf(b.id);
                    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
                    return indexA !== -1 ? -1 : (indexB !== -1 ? 1 : 0);
                });
                renderReciterButtons("");
            } catch (e) { console.error(e); }
        }

        async function loadTranslations() {
            try {
                const localTranslations = [
                    { id: 'bengali', language_name: 'Bengali', name: 'Bengali' },
                    { id: 'chinese', language_name: 'Chinese', name: 'Chinese' },
                    { id: 'english', language_name: 'English', name: 'English' },
                    { id: 'french', language_name: 'French', name: 'French' },
                    { id: 'indonesian', language_name: 'Indonesian', name: 'Indonesian' },
                    { id: 'russian', language_name: 'Russian', name: 'Russian' },
                    { id: 'spanish', language_name: 'Spanish', name: 'Spanish' },
                    { id: 'swedish', language_name: 'Swedish', name: 'Swedish' },
                    { id: 'turkish', language_name: 'Turkish', name: 'Turkish' },
                    { id: 'urdu', language_name: 'Urdu', name: 'Urdu' }
                ];
                state.translations = localTranslations.sort((a, b) => a.language_name.localeCompare(b.language_name));
                UI.translationSelect.innerHTML = state.translations.map(t =>
                `<option value="${t.id}" ${t.id === 'english' ? 'selected' : ''}>[${t.language_name.toUpperCase()}] ${t.name}</option>`
                ).join('');
            } catch (e) { console.error("Translations Load Error:", e); }
        }

        function getArabicStyle(style) {
            if (!style) return "مرتل";
            const s = style.toLowerCase();
            if (s.includes("mujawwad") || s.includes("مجود")) return "مجود";
            if (s.includes("muallim") || s.includes("معلم")) return "معلم";
            return "مرتل";
        }

        function updateActiveAccordionHeight() {
        }

        function renderReciterButtons(filter) {
            UI.reciters.innerHTML = "";
            const filtered = state.reciters.filter(r => (r.translated_name?.name || "").includes(filter) || (r.reciter_name || "").toLowerCase().includes(filter.toLowerCase()));
            filtered.forEach(r => {
                const btn = document.createElement('button');
                btn.className = `reciter-btn ${state.selectedReciter === r.id ? 'active' : ''}`;
                const arabicStyle = getArabicStyle(r.style);
            
            const safeReciterName = r.translated_name?.name || r.reciter_name || 'قارئ غير معروف';
            const nameSpan = document.createElement('span');
            nameSpan.textContent = safeReciterName;
            
            const badgeSpan = document.createElement('span');
            badgeSpan.className = "style-badge";
            badgeSpan.textContent = arabicStyle;
            
            btn.appendChild(nameSpan);
            btn.appendChild(badgeSpan);
                btn.onclick = () => { if(state.isExporting) return; state.selectedReciter = r.id; renderReciterButtons(filter); updateContent(); };
                UI.reciters.appendChild(btn);
            });
        }

        async function loadSurahs() {
            let data = await getCache('surahs');
            if (!data) {
                const res = await fetch('data/surahs.json');
                data = await res.json();
                await setCache('surahs', data);
            }
            state.surahs = data.chapters;
            UI.surah.innerHTML = state.surahs.map(s => `<option value="${s.id}">${s.id}. ${s.name_arabic}</option>`).join('');
        }

        function updateSurahNavigation() {
            const navSection = document.getElementById('surahNavigation');
            if (!navSection || !state.surahs || !state.surahs.length) return;
            
            const currentIdx = parseInt(state.selectedSurah);
            const prevLink = document.getElementById('prevSurahLink');
            const prevName = document.getElementById('prevSurahName');
            const nextLink = document.getElementById('nextSurahLink');
            const nextName = document.getElementById('nextSurahName');

            if (currentIdx > 1) {
                const prevId = currentIdx - 1; const prevSurah = state.surahs.find(s => s.id == prevId); const prevSlug = surahSlugs[prevId - 1] || `surah-${prevId}`;
                prevLink.href = `/surah-${prevSlug}-video`; prevName.innerText = `سورة ${prevSurah ? prevSurah.name_arabic : ''}`;
                prevLink.classList.remove('invisible');
            } else { prevLink.classList.add('invisible'); prevLink.removeAttribute('href'); }
            
            if (currentIdx < 114) {
                const nextId = currentIdx + 1; const nextSurah = state.surahs.find(s => s.id == nextId); const nextSlug = surahSlugs[nextId - 1] || `surah-${nextId}`;
                nextLink.href = `/surah-${nextSlug}-video`; nextName.innerText = `سورة ${nextSurah ? nextSurah.name_arabic : ''}`;
                nextLink.classList.remove('invisible');
            } else { nextLink.classList.add('invisible'); nextLink.removeAttribute('href'); }

            // navSection.classList.remove('hidden');
            if (window.lucide) window.lucide.createIcons();

            updateSeoContent();
        }

        function updateSeoContent() {
            const seoSection = document.getElementById('dynamicSeoSection');
            if (!seoSection || !state.surahs || !state.surahs.length) return;
            
            const currentIdx = parseInt(state.selectedSurah);
            const surahObj = state.surahs.find(s => s.id == currentIdx);
            const arabicName = surahObj ? surahObj.name_arabic : '';
            const versesCount = surahObj ? surahObj.verses_count : '';
            const revelationPlace = surahObj ? (surahObj.revelation_place === 'makkah' ? 'مكية' : 'مدنية') : '';
            const revelationText = revelationPlace ? `، وهي سورة ${revelationPlace} وعدد آياتها ${versesCount} آية` : '';

            seoSection.innerHTML = `
                <div class="p-4 bg-[var(--input-bg)] rounded-xl border border-[var(--border-color)] shadow-sm text-zinc-400 text-right" dir="rtl">
                    <h2 class="text-sm font-bold mb-2 text-[var(--text-main)]">صانع فيديوهات قرآنية: تصميم فيديو سورة ${arabicName} احترافي</h2>
                    <p class="text-[10px] mb-3 leading-relaxed">
                        صمم فيديو تلاوة سورة ${arabicName} بصوت عذب مع مزامنة دقيقة للنص العثماني.
                        أداة Tarteel Studio تتيح لك صناعة فيديوهات قرآنية مذهلة ومشاركتها كـ ريلز (Reels) أو تيك توك أو يوتيوب شورتس بسهولة وخلال ثوانٍ.
                    </p>
                    <h3 class="text-xs font-bold mb-2 text-[var(--text-main)]">معلومات ونبذة عن سورة ${arabicName}</h3>
                    <p class="text-[10px] leading-relaxed">
                        سورة ${arabicName} هي السورة رقم ${currentIdx} في الترتيب القرآني${revelationText}.
                        صمم الآن مقطع فيديو مميز لتلاوة سورة ${arabicName} بخطوط عربية أصيلة مثل خط المصحف، وشارك الأجر مع متابعيك.
                    </p>
                </div>
            `;
            // seoSection.classList.remove('hidden');
        }

        let fetchingDurations = false;
        let currentFetchId = 0;
        async function fetchDurationsForRange(startIdx, endIdx) {
            if (state.audioMode !== 'online') return;
            
            let missingIdxs = [];
            for (let i = startIdx; i < endIdx; i++) {
                if (!state.audioCache[i] && state.ayahs[i] && state.ayahs[i].audioUrl && !state.ayahs[i].apiDuration) {
                    missingIdxs.push(i);
                }
            }
            // إيقاف الجلب التلقائي إذا كان عدد الآيات كبيراً جداً لمنع تعليق الشبكة وجعل الحساب لحظياً
            if (missingIdxs.length === 0 || missingIdxs.length > 20) return;

            const fetchId = ++currentFetchId;
            fetchingDurations = true;
            try {
                initAudio(); // تهيئة الصوت بدون انتظار لتجنب تعليق المتصفح إذا لم يتفاعل المستخدم بعد
                const CONCURRENCY = 5;
                for (let i = 0; i < missingIdxs.length; i += CONCURRENCY) {
                    if (currentFetchId !== fetchId) break;
                    const chunk = missingIdxs.slice(i, i + CONCURRENCY);
                    const chunkPromises = chunk.map(idx => {
                        return fetchAudioBuffer(state.ayahs[idx].audioUrl).then(buf => {
                            if (buf && currentFetchId === fetchId) { state.audioCache[idx] = buf; return true; }
                            return false;
                        });
                    });
                    await Promise.all(chunkPromises);
                    // لا نحدث الواجهة مع كل دفعة لتجنب تذبذب الأرقام المزعج، نحدثها في النهاية مرة واحدة
                }
            } catch (e) { console.error("Prefetch audio error:", e); }
            finally { 
                if (currentFetchId === fetchId) { 
                    fetchingDurations = false; 
                    updateDurationDisplay(true); // تحديث الواجهة فور الانتهاء بالرقم النهائي
                } 
            }
        }

        function updateDurationDisplay(skipFetch = false) {
            const startIdx = (parseInt(UI.vStart.value) || 1) - 1;
            const endIdx = parseInt(UI.vEnd.value) || state.ayahs.length;
            const versesCount = endIdx - startIdx;
            
            if (versesCount <= 0 || startIdx < 0 || endIdx > state.ayahs.length) {
                 state.previewTimeStr = "";
                 if (UI.rangeHint) {
                     UI.rangeHint.innerHTML = '';
                     UI.rangeHint.classList.add('hidden');
                 }
                 return;
            }
            
            let durationSec = 0;
            let isExact = false;

            if (state.audioMode === 'local' && state.timings && state.timings.length > 0) {
                const startT = state.timings[startIdx] || 0;
                let endT = state.timings[endIdx];
                if (endT === undefined || endT === Infinity) {
                    if (state.localAudioBuffer) endT = state.localAudioBuffer.duration;
                    else if (UI.localAudioPlayer && UI.localAudioPlayer.duration) endT = UI.localAudioPlayer.duration;
                    else endT = startT + (versesCount * 5);
                }
                durationSec = Math.max(0, endT - startT);
                isExact = true;
            } else {
                let exactDuration = 0;
                let uncachedChars = 0;
                let uncachedVerses = 0;
                let allExact = true;

                for (let i = startIdx; i < endIdx; i++) {
                    if (state.audioCache && state.audioCache[i]) {
                        const buf = state.audioCache[i];
                        let realDur = buf.duration;
                        const isAjmi = state.selectedReciter === 103;
                        const threshold = isAjmi ? 0.03 : 0.015;
                        const data = buf.getChannelData(0);
                        for (let j = data.length - 1; j > 0; j--) {
                            if (Math.abs(data[j]) > threshold) {
                                realDur = Math.min(buf.duration, (j / buf.sampleRate) + (isAjmi ? 0.05 : 0.15));
                                break;
                            }
                        }
                        const overlap = Math.min(realDur / 2, isAjmi ? 0.4 : 0.25);
                        if (i === endIdx - 1) exactDuration += realDur;
                        else exactDuration += (realDur - overlap);
                    } else if (state.ayahs[i] && state.ayahs[i].apiDuration > 0) {
                        let realDur = state.ayahs[i].apiDuration;
                        const isAjmi = state.selectedReciter === 103;
                        const overlap = Math.min(realDur / 2, isAjmi ? 0.4 : 0.25);
                        if (i === endIdx - 1) exactDuration += realDur;
                        else exactDuration += Math.max(0, realDur - overlap);
                    } else {
                        allExact = false;
                        uncachedVerses++;
                        if (state.ayahs[i] && state.ayahs[i].text_uthmani) {
                            uncachedChars += state.ayahs[i].text_uthmani.length;
                        }
                    }
                }

                if (allExact && exactDuration > 0) {
                    durationSec = exactDuration;
                    isExact = true;
                } else {
                    const reciter = state.reciters ? state.reciters.find(r => r.id === state.selectedReciter) : null;
                    const style = reciter && reciter.style ? reciter.style.toLowerCase() : "";
                    const rName = reciter ? (reciter.translated_name?.name || reciter.reciter_name || "").toLowerCase() : "";
                    const isMujawwad = style.includes('mujawwad') || style.includes('مجود');
                    
                    // معادلة ديناميكية تعتمد على سرعة قراءة القارئ ليتغير الوقت فوراً عند التبديل
                    let charsPerSec = 6.0;
                    let pausePerVerse = 2.0;

                    if (isMujawwad || rName.match(/عبدالباسط|بناء|حذيفي|حصري|منشاوي|طبلاوي|basit|banna|huthaify|husary|minshawi|tablawi/)) {
                        charsPerSec = 4.5; pausePerVerse = 2.8;
                    } else if (rName.match(/معيقلي|دوسري|سديس|شريم|قطامي|فارس|عباد|ياسر|سعود|muaiqly|dossary|sudais|shuraym|qatami|fares|abbad|yasser|saud/)) {
                        charsPerSec = 8.5; pausePerVerse = 1.5;
                    } else if (rName.match(/عفاسي|عجمي|رفاعي|جبريل|غامدي|جابر|برهيزكار|منصوري|afasy|ajmi|rifai|jibreel|ghamdi|jaber|parhizgar|mansoori/)) {
                        charsPerSec = 5.5; pausePerVerse = 2.2;
                    }
                    
                    const estimatedUncached = (uncachedChars / charsPerSec) + (uncachedVerses * pausePerVerse);

                    // جلب الأوقات الدقيقة في الخلفية إذا لم تكن موجودة وكان العدد معقولاً لتجنب البطء
                    if (!skipFetch && uncachedVerses <= 20) fetchDurationsForRange(startIdx, endIdx);
                    
                    if (uncachedVerses <= 20 && fetchingDurations) {
                        durationSec = -1; // تفعيل حالة التحميل
                    } else {
                        durationSec = exactDuration + estimatedUncached;
                        isExact = false;
                    }
                }
            }

            if (durationSec === -1) {
                state.previewTimeStr = "جاري الحساب...";
                if (UI.rangeHint) {
                    UI.rangeHint.innerHTML = `<div class="flex items-center justify-center gap-1.5 mt-3 text-xs font-medium text-zinc-300 bg-[var(--panel-bg)] py-2 px-3 rounded-xl border border-[var(--border-color)] shadow-sm"><i data-lucide="loader-2" class="w-4 h-4 text-[#007AFF] animate-spin"></i> <span class="text-[#007AFF] font-bold mx-1" dir="rtl">جاري الحساب...</span></div>`;
                    UI.rangeHint.classList.remove('hidden');
                    if (window.lucide) window.lucide.createIcons();
                }
            } else if (durationSec > 0) {
                const totalSecs = Math.floor(durationSec);
                const m = Math.floor(totalSecs / 60);
                const s = totalSecs % 60;
                const countStr = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
                
                state.previewTimeStr = countStr;
                if (UI.rangeHint) {
                    UI.rangeHint.innerHTML = `<div class="flex items-center justify-center gap-1.5 mt-3 text-xs font-medium text-zinc-300 bg-[var(--panel-bg)] py-2 px-3 rounded-xl border border-[var(--border-color)] shadow-sm"><i data-lucide="clock" class="w-4 h-4 text-[#007AFF]"></i> <span>المدة المتوقعة:</span> <span class="text-[#007AFF] font-bold mx-1" dir="ltr">${countStr}</span> ${isExact ? '' : '<span class="text-[10px] text-zinc-500">(تقريبية)</span>'}</div>`;
                    UI.rangeHint.classList.remove('hidden');
                    if (window.lucide) window.lucide.createIcons();
                }
            } else {
                state.previewTimeStr = "";
                if (UI.rangeHint) {
                    UI.rangeHint.classList.add('hidden');
                }
            }
        }

        async function updateContent(resetVerseRange = false) {
            UI.loader.classList.remove('hidden');
            stopAudio();
            if (resetVerseRange) UI.vStart.value = 1;
            state.audioCache = {}; // تفريغ الكاش الصوتي عند تغيير السورة أو القارئ لمنع تداخل الأصوات
            try {
                if (!state.selectedTranslation || !isNaN(state.selectedTranslation)) {
                    state.selectedTranslation = 'english';
                }

                const textKey = `text_ar_${state.selectedSurah}`;
                let textData = await getCache(textKey);
                if (!textData) {
                    const textRes = await fetch(`https://api.quran.com/api/v4/verses/by_chapter/${state.selectedSurah}?language=ar&fields=text_uthmani,page_number,code_v1,code_v2&per_page=300`);
                    textData = await textRes.json();
                    await setCache(textKey, textData);
                }

                const transKey = `trans_file_${state.selectedTranslation}`;
                let transData = await getCache(transKey);
                if (!transData) {
                    try {
                        const transRes = await fetch(`data/translation/${state.selectedTranslation}.json`);
                        transData = await transRes.json();
                        await setCache(transKey, transData);
                    } catch(e) {
                        console.error("Failed to load local translation file", e);
                        transData = [];
                    }
                }

                let surahTranslations = [];
                if (Array.isArray(transData)) {
                    let surahObj = transData.find(s => s.id == state.selectedSurah);
                    if (!surahObj && transData[state.selectedSurah - 1]) {
                        surahObj = transData[state.selectedSurah - 1];
                    }
                    if (surahObj && surahObj.verses) {
                        surahTranslations = surahObj.verses;
                    } else if (Array.isArray(surahObj)) {
                        surahTranslations = surahObj;
                    } else {
                        surahTranslations = transData;
                    }
                } else if (transData && transData[state.selectedSurah]) {
                    surahTranslations = transData[state.selectedSurah];
                } else if (transData && transData.verses) {
                    surahTranslations = transData.verses;
                }

                let audioFiles = [];
                if ([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 117].includes(state.selectedReciter)) {
                    let baseUrl = "";
                    if (state.selectedReciter === 101) baseUrl = "https://everyayah.com/data/MaherAlMuaiqly128kbps/";
                        else if (state.selectedReciter === 102) baseUrl = "https://everyayah.com/data/Yasser_Ad-Dussary_128kbps/";
                            else if (state.selectedReciter === 103) baseUrl = "https://everyayah.com/data/Ahmed_ibn_Ali_al-Ajamy_128kbps_ketaballah.net/";
                                else if (state.selectedReciter === 104) baseUrl = "https://mirrors.quranicaudio.com/everyayah/Abdurrahmaan_As-Sudais_192kbps/";
                                    else if (state.selectedReciter === 105) baseUrl = "https://everyayah.com/data/Ghamadi_40kbps/";
                                        else if (state.selectedReciter === 106) baseUrl = "https://everyayah.com/data/Ali_Jaber_64kbps/";
                                            else if (state.selectedReciter === 107) baseUrl = "https://everyayah.com/data/Parhizgar_48kbps/";
                                                else if (state.selectedReciter === 108) baseUrl = "https://everyayah.com/data/Karim_Mansoori_40kbps/";
                                                    else if (state.selectedReciter === 109) baseUrl = "https://everyayah.com/data/Nabil_Rifa3i_48kbps/";
                                                        else if (state.selectedReciter === 110) baseUrl = "https://everyayah.com/data/Sahl_Yassin_128kbps/";
                                                            else if (state.selectedReciter === 111) baseUrl = "https://everyayah.com/data/warsh/warsh_yassin_al_jazaery_64kbps/";
                                                                else if (state.selectedReciter === 112) baseUrl = "https://everyayah.com/data/Nasser_Alqatami_128kbps/";
                                                                    else if (state.selectedReciter === 113) baseUrl = "https://everyayah.com/data/Muhammad_Jibreel_128kbps/";
                                                                    else if (state.selectedReciter === 114) baseUrl = "https://everyayah.com/data/Muhammad_Ayyoub_128kbps/";
                                                                        else if (state.selectedReciter === 115) baseUrl = "https://everyayah.com/data/mahmoud_ali_al_banna_32kbps/";
                                                                        else if (state.selectedReciter === 115) baseUrl = "https://everyayah.com/data/mahmoud_ali_al_banna_32kbps/";
                                                                            else if (state.selectedReciter === 117) baseUrl = "https://everyayah.com/data/Fares_Abbad_64kbps/";

                                    audioFiles = textData.verses.map(v => {
                                        const [s, a] = v.verse_key.split(':');
                                        return { verse_key: v.verse_key, url: `${baseUrl}${s.padStart(3, '0')}${a.padStart(3, '0')}.mp3` };
                                    });
                } else {
                    const audioKey = `audio_${state.selectedReciter}_${state.selectedSurah}`;
                    let audioData = await getCache(audioKey);
                    if (!audioData) {
                        const audioRes = await fetch(`https://api.quran.com/api/v4/recitations/${state.selectedReciter}/by_chapter/${state.selectedSurah}?per_page=300`);
                        audioData = await audioRes.json();
                        await setCache(audioKey, audioData);
                    }
                    audioFiles = audioData.audio_files;
                }

                state.ayahs = textData.verses.map((v, index) => {
                    const af = audioFiles.find(f => f.verse_key === v.verse_key);
                    let finalUrl = null;
                    let apiDur = 0;
                    if (af && af.url) {
                        if (af.url.startsWith('http')) finalUrl = af.url;
                        else if (af.url.startsWith('//')) finalUrl = `https:${af.url}`;
                            else { const cleanPath = af.url.startsWith('/') ? af.url.slice(1) : af.url; finalUrl = `https://verses.quran.com/${cleanPath}`; }
                        if (af.duration) apiDur = parseFloat(af.duration);
                    }
                    
                    let transText = "";
                    const ayahId = index + 1;
                    const transItem = surahTranslations.find(t => t.id == ayahId) || surahTranslations[index];
                    if (transItem && transItem.translation) {
                        transText = transItem.translation;
                    } else if (typeof transItem === 'string') {
                        transText = transItem;
                    }
                    
                    return { ...v, audioUrl: finalUrl, apiDuration: apiDur, translation: transText.replace(/<[^>]*>?/gm, '').trim() };
                });

                const total = state.ayahs.length;
                const currentEnd = parseInt(UI.vEnd.value);
                // ضبط نهاية النطاق إذا كان غير صالح أو عند طلب إعادة التعيين
                if (resetVerseRange || isNaN(currentEnd) || currentEnd > total) UI.vEnd.value = total;

                UI.vStart.max = total;
                UI.vStart.min = 1;
                UI.vEnd.max = total;
                UI.vEnd.min = 1;

                // تصحيح البداية إذا كانت خارج حدود السورة الحالية (يمنع اختفاء النص عند التحديث)
                const currentStart = parseInt(UI.vStart.value);
                if (isNaN(currentStart) || currentStart > total) UI.vStart.value = 1;

                state.currentAyahIndex = (parseInt(UI.vStart.value) || 1) - 1;
                if (window.location.search.includes("surah")) {
                    updateSurahNavigation();
                }
                updateDurationDisplay();
            } catch (e) { console.error("API Error:", e); } finally { UI.loader.classList.add('hidden'); }
        }

        function toggleTheme() {
            state.isLightMode = !state.isLightMode;
            document.body.classList.toggle('dark-mode', !state.isLightMode);
            UI.themeToggle.innerHTML = `<i data-lucide="${state.isLightMode ? 'moon' : 'sun'}" class="w-5 h-5 block"></i>`; lucide.createIcons();
        }

        function createCustomDropdown(selectElement, withSearch = false) {
            if (!selectElement) return;

            const wrapper = document.createElement('div');
            wrapper.className = 'custom-select-wrapper';
            selectElement.parentNode.insertBefore(wrapper, selectElement);
            wrapper.appendChild(selectElement);
            selectElement.style.display = 'none';

            const trigger = document.createElement('button');
            trigger.className = 'custom-select-trigger';
            trigger.innerHTML = `<span></span><i data-lucide="chevron-down" class="w-4 h-4 transition-transform duration-300"></i>`;
            wrapper.appendChild(trigger);

            const optionsContainer = document.createElement('div');
            optionsContainer.className = 'custom-select-options custom-scroll';
            wrapper.appendChild(optionsContainer);

            let searchInput = null;
            if (withSearch) {
                const searchWrapper = document.createElement('div');
                searchWrapper.className = 'sticky z-20 pb-2 mb-2';
                searchWrapper.style.top = '-0.5rem';
                searchWrapper.style.marginTop = '-0.5rem';
                searchWrapper.style.marginLeft = '-0.5rem';
                searchWrapper.style.marginRight = '-0.5rem';
                searchWrapper.style.padding = '0.5rem 0.5rem 0 0.5rem';
                searchWrapper.style.backgroundColor = 'var(--panel-bg)';

                searchInput = document.createElement('input');
                searchInput.type = 'text';
                searchInput.placeholder = 'بحث...';
                searchInput.className = 'w-full bg-[var(--input-bg)] text-[var(--text-main)] border border-[var(--border-color)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]';
                
                searchInput.addEventListener('click', (e) => e.stopPropagation());
                
                searchWrapper.appendChild(searchInput);
                optionsContainer.appendChild(searchWrapper);
            }

            const optionsList = document.createElement('div');
            optionsContainer.appendChild(optionsList);

            const triggerSpan = trigger.querySelector('span');

            const populateOptions = (filter = '') => {
                optionsList.innerHTML = '';
                const options = Array.from(selectElement.options);
                let matchCount = 0;

                options.forEach((option, index) => {
                    const text = option.textContent;
                    if (filter && !text.toLowerCase().includes(filter.toLowerCase())) return;

                    matchCount++;
                    const optionEl = document.createElement('div');
                    optionEl.className = 'custom-select-option';
                    optionEl.textContent = text;
                    optionEl.dataset.value = option.value;
                    if (option.selected) {
                        optionEl.classList.add('selected');
                        triggerSpan.textContent = text;
                    }
                    optionEl.addEventListener('click', () => {
                        selectElement.value = option.value;
                        triggerSpan.textContent = text;
                        wrapper.classList.remove('open');
                        if (searchInput) searchInput.value = '';
                        // Manually trigger change event for frameworks
                        const event = new Event('change', { bubbles: true });
                        selectElement.dispatchEvent(event);
                        // Re-populate to update selected state
                        populateOptions();
                    });
                    optionsList.appendChild(optionEl);
                });

                if (matchCount === 0 && filter) {
                    const noRes = document.createElement('div');
                    noRes.className = 'text-center text-xs text-[var(--text-muted)] py-2';
                    noRes.textContent = 'لا توجد نتائج';
                    optionsList.appendChild(noRes);
                }
                if (window.lucide) lucide.createIcons();
            };

            if (searchInput) {
                searchInput.addEventListener('input', (e) => {
                    populateOptions(e.target.value);
                });
            }

            trigger.addEventListener('click', (e) => {
                e.preventDefault();
                const isOpen = wrapper.classList.contains('open');
                
                document.querySelectorAll('.custom-select-wrapper.open').forEach(w => {
                    if (w !== wrapper) w.classList.remove('open');
                });

                if (!isOpen) {
                    wrapper.classList.add('open');
                    if (searchInput) {
                        searchInput.value = '';
                        populateOptions();
                        setTimeout(() => {
                            if (window.innerWidth > 768) {
                                searchInput.focus();
                            }
                        }, 50);
                    }
                } else {
                    wrapper.classList.remove('open');
                }
            });

            document.addEventListener('click', (e) => {
                if (!wrapper.contains(e.target)) {
                    wrapper.classList.remove('open');
                }
            });

            // Use a MutationObserver to detect when new options are added to the original select
            const observer = new MutationObserver((mutations) => {
                for(const mutation of mutations) {
                    if (mutation.type === 'childList') {
                        if (searchInput) searchInput.value = '';
                        populateOptions();
                        break;
                    }
                }
            });
            observer.observe(selectElement, { childList: true });

            populateOptions(); // Initial population
        }

        function setupAccordion() {
        const tabs = document.querySelectorAll('.settings-tab-btn');
        const sections = document.querySelectorAll('.settings-section');

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                if (tab.classList.contains('active')) return; // تجاهل النقرات المتكررة على نفس التبويب
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                // استخدام requestAnimationFrame مرتين لضمان استجابة الزر وتغير لونه فوراً قبل الريندر الثقيل
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        const targetId = tab.getAttribute('data-target');
                        sections.forEach(sec => {
                            if (sec.id === targetId) {
                                sec.classList.remove('hidden');
                                sec.classList.add('block');
                            } else {
                                sec.classList.add('hidden');
                                sec.classList.remove('block');
                            }
                        });
                    });
                });
            });
        });
        }
        function setupEvents() {
            setupAccordion();

            createCustomDropdown(UI.surah, true);
            // Note: Custom dropdowns update the original select, triggering 'change', so History works automatically.
            createCustomDropdown(UI.canvasSize);
            createCustomDropdown(UI.fontVersion);
            createCustomDropdown(UI.translationSelect);
            createCustomDropdown(UI.animType);
            // إنشاء أزرار اختيار صيغة التصدير ديناميكياً إذا لم تكن موجودة
            if (!document.getElementById('exportFormatContainer') && UI.startExportBtn) {
                const formatContainer = document.createElement('div');
                formatContainer.id = 'exportFormatContainer';
                formatContainer.className = 'w-full max-w-xs mx-auto my-4';
            
            const isMobileDevice = window.innerWidth < 768 || /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

            // تعيين الإعدادات الافتراضية
            state.exportFormat = state.exportFormat || 'mp4';
            if (isMobileDevice) {
                state.exportQuality = '480p';
                state.exportFPS = 24;
            } else {
                state.exportQuality = state.exportQuality || '720p';
                state.exportFPS = state.exportFPS || 30;
            }

                formatContainer.innerHTML = `
                ${!isMobileDevice ? `
                <label class="block text-sm font-medium text-zinc-400 mb-2 text-center">جودة الفيديو (Resolution)</label>
                <div class="tab-container" style="margin-bottom: 12px; flex-wrap: wrap; gap: 4px;">
                    <div id="btnExport480" class="tab-btn ${state.exportQuality === '480p' ? 'active' : ''}">480p</div>
                    <div id="btnExport720" class="tab-btn ${state.exportQuality === '720p' ? 'active' : ''}">720p</div>
                    <div id="btnExport1080" class="tab-btn ${state.exportQuality === '1080p' ? 'active' : ''}">1080p</div>
                    <div id="btnExport4K" class="tab-btn ${state.exportQuality === '4k' ? 'active' : ''}">4K</div>
                </div>
                <label class="block text-sm font-medium text-zinc-400 mb-2 text-center">معدل الإطارات (FPS)</label>
                <div class="tab-container" style="margin-bottom: 12px;">
                    <div id="btnExport24FPS" class="tab-btn ${state.exportFPS === 24 ? 'active' : ''}">24 FPS</div>
                    <div id="btnExport30FPS" class="tab-btn ${state.exportFPS === 30 ? 'active' : ''}">30 FPS</div>
                    <div id="btnExport60FPS" class="tab-btn ${state.exportFPS === 60 ? 'active' : ''}">60 FPS</div>
                </div>
                ` : ''}
                `;
                UI.startExportBtn.parentNode.insertBefore(formatContainer, UI.startExportBtn);

            const btn480 = document.getElementById('btnExport480');
            const btn720 = document.getElementById('btnExport720');
            const btn1080 = document.getElementById('btnExport1080');
            const btn4K = document.getElementById('btnExport4K');
            const btn24FPS = document.getElementById('btnExport24FPS');
            const btn30FPS = document.getElementById('btnExport30FPS');
            const btn60FPS = document.getElementById('btnExport60FPS');

            const clearQualityBtns = () => {
                if (btn480) btn480.classList.remove('active');
                if (btn720) btn720.classList.remove('active');
                if (btn1080) btn1080.classList.remove('active');
                if (btn4K) btn4K.classList.remove('active');
            };
            
            if (btn480) btn480.onclick = () => { state.exportQuality = '480p'; clearQualityBtns(); btn480.classList.add('active'); };
            if (btn720) btn720.onclick = () => { state.exportQuality = '720p'; clearQualityBtns(); btn720.classList.add('active'); };
            if (btn1080) btn1080.onclick = () => {
                state.exportQuality = '1080p';
                clearQualityBtns(); btn1080.classList.add('active');
            };
            if (btn4K) {
                btn4K.onclick = () => {
                    state.exportQuality = '4k';
                    clearQualityBtns(); btn4K.classList.add('active');
                };
            }
            
            if (btn24FPS) btn24FPS.onclick = () => {
                state.exportFPS = 24;
                btn24FPS.classList.add('active'); 
                if (btn30FPS) btn30FPS.classList.remove('active'); 
                if (btn60FPS) btn60FPS.classList.remove('active');
            };
            if (btn30FPS) btn30FPS.onclick = () => {
                state.exportFPS = 30;
                btn30FPS.classList.add('active'); 
                if (btn60FPS) btn60FPS.classList.remove('active'); 
                if (btn24FPS) btn24FPS.classList.remove('active');
            };
            if (btn60FPS) btn60FPS.onclick = () => {
                state.exportFPS = 60;
                btn60FPS.classList.add('active'); 
                if (btn30FPS) btn30FPS.classList.remove('active'); 
                if (btn24FPS) btn24FPS.classList.remove('active');
            };
            }

            document.addEventListener('keydown', (e) => {
                if (state.isExporting || UI.limitModal.style.display === 'flex' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;
                if (e.code === 'Space') {
                    e.preventDefault();
                    if (state.isSyncing) {
                        triggerSyncTap();
                    } else {
                        if (state.isPlaying) stopAudio(); else { state.isPlaying = true; playSeamless(state.currentAyahIndex); }
                    }
                }
                else if (e.code === 'ArrowRight') {
                    e.preventDefault();
                    if (state.isSyncing) return;
                    if (state.currentAyahIndex + 1 < state.ayahs.length) {
                        const startIdx = (parseInt(UI.vStart.value) || 1) - 1;
                        if (state.plan === 'free' && (state.currentAyahIndex + 1 - startIdx) >= 7) { UI.limitModal.style.display = 'flex'; if (state.isPlaying) stopAudio(); return; }
                        const wasPlaying = state.isPlaying; stopAudio(); state.currentAyahIndex++;
                        if (wasPlaying) { state.isPlaying = true; playSeamless(state.currentAyahIndex); } else { const ayah = state.ayahs[state.currentAyahIndex]; if (ayah) ensureFontLoaded(ayah.page_number, UI.fontVersion.value, state.selectedSurah); }
                    }
                } else if (e.code === 'ArrowLeft') {
                    e.preventDefault();
                    if (state.currentAyahIndex - 1 >= 0) {
                        if (state.isSyncing) return;
                        const wasPlaying = state.isPlaying; stopAudio(); state.currentAyahIndex--;
                        if (wasPlaying) { state.isPlaying = true; playSeamless(state.currentAyahIndex); } else { const ayah = state.ayahs[state.currentAyahIndex]; if (ayah) ensureFontLoaded(ayah.page_number, UI.fontVersion.value, state.selectedSurah); }
                    }
                }
            });

            UI.lpOpenProfileBtn.onclick = () => UI.profileModal.style.display = 'flex';
            UI.googleLoginBtn.onclick = signInWithGoogle;
            UI.loginBtn.onclick = () => UI.authScreen.classList.remove('hidden'); UI.closeAuthBtn.onclick = () => UI.authScreen.classList.add('hidden');
            UI.openProfileBtn.onclick = () => UI.profileModal.style.display = 'flex'; UI.closeProfileBtn.onclick = () => UI.profileModal.style.display = 'none';
            UI.logoutBtn.onclick = async () => {
                UI.logoutBtn.innerHTML = 'جاري تسجيل الخروج...';
                UI.logoutBtn.style.opacity = '0.7';
                UI.logoutBtn.style.pointerEvents = 'none';
                try {
                    if (supabaseClient) {
                        await Promise.race([supabaseClient.auth.signOut(), new Promise(r => setTimeout(r, 2000))]);
                    }
                } catch (e) { console.error(e); } finally {
                    Object.keys(localStorage).forEach(k => { if(k.startsWith('sb-')) localStorage.removeItem(k); });
                    localStorage.removeItem('device_session_id');
                    localStorage.removeItem('device_session_ver');
                    window.location.reload();
                }
            };
            UI.themeToggle.onclick = toggleTheme;

            // --- Audio Tabs Logic ---
            UI.tabOnline.onclick = () => {
                state.audioMode = 'online';
                UI.tabOnline.classList.add('active'); UI.tabLocal.classList.remove('active');
                UI.localAudioControls.classList.add('hidden');
                UI.onlineReciterSearch.classList.remove('hidden'); UI.reciters.classList.remove('hidden');
                stopAudio();
                updateExportButtonState();
                updateDurationDisplay();
            };
            UI.tabLocal.onclick = async () => {
                if (!state.permissions || !state.permissions.upload_audio) {
                    UI.proFeatureMsg.innerText = "ميزة رفع ملف صوتي خاص بك والمزامنة اليدوية متاحة فقط للمشتركين في النسخة الاحترافية.";
                    UI.proFeatureModal.style.display = 'flex';
                    if (lucide && lucide.createIcons) lucide.createIcons();
                    return;
                }
                state.audioMode = 'local';
                UI.tabLocal.classList.add('active'); UI.tabOnline.classList.remove('active');
                UI.localAudioControls.classList.remove('hidden');
                UI.onlineReciterSearch.classList.add('hidden'); UI.reciters.classList.add('hidden');
                stopAudio();
                updateExportButtonState();
                updateDurationDisplay();
            };

            UI.localAudioInput.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;

            const isMobile = window.innerWidth < 768 || /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            let finalFile = file;

            if (isMobile) {
                const duration = await new Promise((resolve) => {
                    const tempAudio = new Audio();
                    const objUrl = URL.createObjectURL(file);
                    tempAudio.onloadedmetadata = () => { resolve(tempAudio.duration); URL.revokeObjectURL(objUrl); };
                    tempAudio.onerror = () => { resolve(0); URL.revokeObjectURL(objUrl); };
                    tempAudio.src = objUrl;
                });

                if (duration > 600) { // 600 ثانية = 10 دقائق
                    alert("تنبيه: تم قص الملف الصوتي والاكتفاء بأول 10 دقائق لتتناسب مع قدرات الهاتف المحمول ومنع تشنج المتصفح , اذا كنت تريد مدة اطول او سورة كاملة برجاء المحاولة على جهاز كمبيوتر او لاب توب");
                    const cutRatio = 600 / duration;
                    const cutByte = Math.floor(file.size * cutRatio);
                    finalFile = new File([file.slice(0, cutByte)], file.name, { type: file.type });
                }
            }

                // UI Loading State
                const btnLabel = e.target.parentElement.querySelector('span');
                const originalText = "اختر ملف صوتي (MP3/WAV)";
                btnLabel.innerText = "جاري التهيئة...";
                e.target.parentElement.style.opacity = "0.6";
                e.target.parentElement.style.pointerEvents = "none";

                const resetUI = () => {
                    btnLabel.innerText = originalText;
                    e.target.parentElement.style.opacity = "1";
                    e.target.parentElement.style.pointerEvents = "auto";
                    e.target.value = "";
                    updateExportButtonState();
                };

                // دالة المعالجة المحلية (الخطة البديلة)
                const processLocally = async () => {
                    try {
                        const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
                        UI.localFileName.innerText = finalFile.name.length > 20 ? finalFile.name.substring(0, 20) + '...' : finalFile.name;

                        state.originalAudioBuffer = null;
                        state.isTrimmed = false;

                        if (isMobileDevice) {
                            btnLabel.innerText = "جاري تهيئة الملف...";
                            const localUrl = URL.createObjectURL(finalFile);
                            UI.localAudioPlayer.src = localUrl;
                            state.useAudioElement = true;
                            state.localAudioFile = finalFile;
                            UI.localAudioPlayer.onloadedmetadata = () => {
                                if (window.setupAudioDuration && !state.isTrimmed) {
                                    window.setupAudioDuration(UI.localAudioPlayer.duration);
                                }
                            };
                        } else {
                            btnLabel.innerText = "جاري المعالجة محلياً...";
                            const arrayBuffer = await finalFile.arrayBuffer();
                            const bufferToDecode = arrayBuffer.slice(0);
                            state.localAudioBuffer = await new Promise((resolve, reject) => {
                                state.audioContext.decodeAudioData(bufferToDecode, resolve, reject);
                            });
                            state.useAudioElement = false;
                            state.localAudioFile = finalFile; // تخزين الملف أيضاً للاحتياط
                            const localUrl = URL.createObjectURL(finalFile);
                            UI.localAudioPlayer.src = localUrl;
                            if (window.setupAudioDuration && !state.isTrimmed) {
                                window.setupAudioDuration(state.localAudioBuffer.duration);
                            }
                        }

                        UI.localFilePreview.classList.remove('hidden');
                        UI.syncControls.classList.remove('hidden');
                        state.hasSyncedOnce = false;
                        if (window.lucide) window.lucide.createIcons();

                        // إنشاء واجهة قص الصوت
                        let trimUI = document.getElementById('audioTrimUI');
                        if (trimUI) trimUI.remove(); // إزالة الواجهة القديمة إذا كانت موجودة لضمان عمل الأحداث بشكل سليم
                        if (!trimUI) {
                            trimUI = document.createElement('div');
                            trimUI.id = 'audioTrimUI';
                            trimUI.className = 'flex flex-col gap-2 mt-3 p-3 bg-[var(--panel-bg)] rounded-xl border border-[var(--border-color)] shadow-sm';
                            trimUI.innerHTML = `
                                <style>
                                    .trim-range { -webkit-appearance: none; appearance: none; background: transparent; outline: none; }
                                    .trim-range::-webkit-slider-thumb { pointer-events: auto; -webkit-appearance: none; width: 14px; height: 28px; background: white; border-radius: 6px; cursor: ew-resize; box-shadow: 0 1px 4px rgba(0,0,0,0.5); }
                                    .trim-range::-moz-range-thumb { pointer-events: auto; width: 14px; height: 28px; background: white; border-radius: 6px; cursor: ew-resize; border: none; box-shadow: 0 1px 4px rgba(0,0,0,0.5); }
                                </style>
                                <div class="flex justify-between items-center text-[10px] text-zinc-400 font-bold px-1 mb-1">
                                    <span id="trimStartLabel" class="bg-[#007AFF]/20 px-2 py-0.5 rounded text-[#007AFF]">0.0s</span>
                                    <span class="text-[#007AFF]"><i data-lucide="scissors" class="w-3 h-3 inline-block align-middle"></i> اقتطاع جزء من الصوت</span>
                                    <span id="trimEndLabel" class="bg-[#007AFF]/20 px-2 py-0.5 rounded text-[#007AFF]">0.0s</span>
                                </div>
                                <div class="relative w-full h-8 bg-[#007AFF]/10 border border-[#007AFF]/20 rounded-lg flex items-center" dir="ltr">
                                    <div id="trimVisualTrack" class="absolute h-full bg-[#007AFF]/50 border-y border-[#007AFF] rounded-md pointer-events-none" style="left: 0%; right: 0%;"></div>
                                    <input type="range" id="trimStart" class="trim-range absolute w-full h-full pointer-events-none z-10 m-0" min="0" value="0" step="0.1">
                                    <input type="range" id="trimEnd" class="trim-range absolute w-full h-full pointer-events-none z-20 m-0" min="0" step="0.1">
                                </div>
                                <div class="flex gap-2 mt-2 w-full">
                                    <button id="trimPreviewBtn" class="w-[35%] bg-[#007AFF] hover:bg-blue-600 text-white font-bold py-2 px-2 rounded-lg text-xs transition-all flex items-center justify-center gap-1.5"><i data-lucide="play" class="w-4 h-4"></i> تشغيل</button>
                                    <button id="trimBtn" class="w-[65%] bg-[#007AFF] hover:bg-blue-600 text-white font-bold py-2 px-2 rounded-lg text-xs transition-all flex items-center justify-center gap-1.5"><i data-lucide="check" class="w-4 h-4"></i> تطبيق القص</button>
                                </div>
                            `;
                            UI.localFilePreview.appendChild(trimUI);
                            if (window.lucide) window.lucide.createIcons();

                            const trimStart = document.getElementById('trimStart');
                            const trimEnd = document.getElementById('trimEnd');
                            const trimTrack = document.getElementById('trimVisualTrack');
                            const startLabel = document.getElementById('trimStartLabel');
                            const endLabel = document.getElementById('trimEndLabel');
                            const trimPreviewBtn = document.getElementById('trimPreviewBtn');

                            const updateTrack = () => {
                                const max = parseFloat(trimStart.max) || 1;
                                let s = parseFloat(trimStart.value) || 0;
                                let e = parseFloat(trimEnd.value);
                                if (isNaN(e)) e = max;

                                if (s > e - 0.2) {
                                    if (document.activeElement === trimStart) { trimStart.value = e - 0.2; s = e - 0.2; }
                                    else { trimEnd.value = s + 0.2; e = s + 0.2; }
                                }

                                const startPercent = (s / max) * 100;
                                const endPercent = 100 - ((e / max) * 100);

                                trimTrack.style.left = startPercent + '%';
                                trimTrack.style.right = endPercent + '%';

                                startLabel.innerText = s.toFixed(1) + 's';
                                endLabel.innerText = e.toFixed(1) + 's';
                            };

                            trimStart.addEventListener('input', updateTrack);
                            trimEnd.addEventListener('input', updateTrack);

                            window.setupAudioDuration = (dur) => {
                                if (isNaN(dur) || dur <= 0) return;
                                trimStart.max = dur;
                                trimEnd.max = dur;
                                trimEnd.value = dur;
                                updateTrack();
                            };

                            const currentDur = state.localAudioBuffer ? state.localAudioBuffer.duration : UI.localAudioPlayer.duration;
                            if (currentDur && !isNaN(currentDur) && !state.isTrimmed) {
                                window.setupAudioDuration(currentDur);
                            }
                            
                            const trimPreviewAudio = new Audio(URL.createObjectURL(finalFile));
                            let isTrimPreviewing = false;
                            const checkPreviewTime = () => {
                                if (!isTrimPreviewing) return;
                                const endVal = parseFloat(trimEnd.value);
                                if (trimPreviewAudio.currentTime >= endVal) {
                                    trimPreviewAudio.pause();
                                    isTrimPreviewing = false;
                                    trimPreviewBtn.innerHTML = `<i data-lucide="play" class="w-4 h-4"></i> تشغيل`;
                                    if (window.lucide) window.lucide.createIcons();
                                }
                            };

                            trimPreviewAudio.addEventListener('timeupdate', checkPreviewTime);
                            trimPreviewAudio.addEventListener('ended', checkPreviewTime);

                            trimPreviewBtn.onclick = () => {
                                if (isTrimPreviewing) {
                                    trimPreviewAudio.pause();
                                    isTrimPreviewing = false;
                                    trimPreviewBtn.innerHTML = `<i data-lucide="play" class="w-4 h-4"></i> تشغيل`;
                                    if (window.lucide) window.lucide.createIcons();
                                } else {
                                    const startVal = parseFloat(trimStart.value) || 0;
                                    trimPreviewAudio.currentTime = startVal;
                                    trimPreviewAudio.play();
                                    isTrimPreviewing = true;
                                    trimPreviewBtn.innerHTML = `<i data-lucide="square" class="w-4 h-4"></i> إيقاف`;
                                    if (window.lucide) window.lucide.createIcons();
                                }
                            };

                            document.getElementById('trimBtn').onclick = async () => {
                                if (isTrimPreviewing) trimPreviewBtn.click(); // إيقاف المعاينة قبل تطبيق القص
                                const startVal = parseFloat(document.getElementById('trimStart').value) || 0;
                                const endVal = parseFloat(document.getElementById('trimEnd').value);
                                const btn = document.getElementById('trimBtn');
                                
                                if (!state.originalAudioBuffer) {
                                     btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> جاري التهيئة...`;
                                     if (window.lucide) window.lucide.createIcons();
                                     try {
                                         if (state.localAudioBuffer && !state.isTrimmed) {
                                             state.originalAudioBuffer = state.localAudioBuffer;
                                         } else {
                                             const arrayBuffer = await state.localAudioFile.arrayBuffer();
                                             state.originalAudioBuffer = await new Promise((resolve, reject) => {
                                                 state.audioContext.decodeAudioData(arrayBuffer, resolve, reject);
                                             });
                                         }
                                     } catch(err) {
                                         alert("فشل تهيئة الملف للقص.");
                                         btn.innerHTML = `<i data-lucide="check" class="w-4 h-4"></i> تطبيق القص`;
                                         if (window.lucide) window.lucide.createIcons();
                                         return;
                                     }
                                }

                                if (state.originalAudioBuffer) {
                                    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> جاري القص...`;
                                    if (window.lucide) window.lucide.createIcons();
                                    await new Promise(r => setTimeout(r, 50));
                                    const duration = state.originalAudioBuffer.duration;
                                    const start = Math.max(0, startVal);
                                    const end = (endVal > 0 && endVal <= duration) ? endVal : duration;
                                    if (start >= end) {
                                        alert("وقت البداية يجب أن يكون أقل من النهاية");
                                        btn.innerHTML = `<i data-lucide="check" class="w-4 h-4"></i> تطبيق القص`;
                                        if (window.lucide) window.lucide.createIcons();
                                        return;
                                    }
                                    try {
                                        const sampleRate = state.originalAudioBuffer.sampleRate;
                                        const startSample = Math.floor(start * sampleRate);
                                        const endSample = Math.floor(end * sampleRate);
                                        const frameCount = endSample - startSample;
                                        const newBuffer = state.audioContext.createBuffer(state.originalAudioBuffer.numberOfChannels, frameCount, sampleRate);
                                        for (let i = 0; i < state.originalAudioBuffer.numberOfChannels; i++) {
                                            newBuffer.getChannelData(i).set(state.originalAudioBuffer.getChannelData(i).subarray(startSample, endSample));
                                        }
                                        state.localAudioBuffer = newBuffer;
                                        const wavBytes = audioBufferToWavBytes(newBuffer);
                                        const wavBlob = new Blob([wavBytes], { type: 'audio/wav' });
                                        
                                        state.isTrimmed = true;
                                        UI.localAudioPlayer.src = URL.createObjectURL(wavBlob);
                                        
                                        state.timings = [];
                                        state.hasSyncedOnce = false;
                                        updateExportButtonState();
                                        updateDurationDisplay();
                                        btn.innerHTML = `<i data-lucide="check-check" class="w-4 h-4"></i> تم القص بنجاح`;
                                        if (window.lucide) window.lucide.createIcons();
                                        setTimeout(() => {
                                            btn.innerHTML = `<i data-lucide="check" class="w-4 h-4"></i> تطبيق القص`;
                                            if (window.lucide) window.lucide.createIcons();
                                        }, 2000);
                                    } catch (e) {
                                        console.error("Trim error:", e);
                                        alert("حدث خطأ أثناء قص الصوت.");
                                        btn.innerHTML = `<i data-lucide="check" class="w-4 h-4"></i> تطبيق القص`;
                                        if (window.lucide) window.lucide.createIcons();
                                    }
                                }
                            };
                        }
                    } catch (err) {
                        alert("فشل قراءة الملف: " + err.message);
                        clearLocalAudioFile();
                    } finally {
                        resetUI();
                    }
                };

                try {
                    await initAudio(); // Initialize Audio Context immediately
                    // استخدام المعالجة المحلية دائماً لجميع الباقات لتسريع العملية وإلغاء الرفع
                    await processLocally();
                } catch (err) {
                    console.error("Local audio error:", err);
                    resetUI();
                }
            };

            UI.clearLocalFile.onclick = () => {
                // Only show confirmation if a sync has been performed
                if (state.hasSyncedOnce) {
                    UI.deleteAudioConfirmModal.style.display = 'flex';
                    lucide.createIcons();
                } else {
                    clearLocalAudioFile();
                }
            };

            UI.cancelDeleteAudio.onclick = () => {
                UI.deleteAudioConfirmModal.style.display = 'none';
            };
            UI.confirmDeleteAudio.onclick = () => {
                clearLocalAudioFile();
                UI.deleteAudioConfirmModal.style.display = 'none';
            };

            UI.startSyncBtn.onclick = async () => {
                if (!state.localAudioFile && !state.localAudioBuffer && !UI.localAudioPlayer.src) return;
                stopAudio();
                state.isSyncing = true;
                state.isPlaying = true;
                UI.startSyncBtn.classList.add('hidden');
                UI.tapSyncBtn.classList.remove('hidden');
                UI.stopSyncBtn.classList.remove('hidden');

                // إخفاء وضع معاينة الملف في الهاتف أثناء المزامنة لتوفير مساحة للتركيز
                if (window.innerWidth < 768) {
                    UI.localFilePreview.classList.add('hidden');
                }

                // Reset to start
                const startIdx = (parseInt(UI.vStart.value) || 1) - 1;
                state.currentAyahIndex = startIdx;

                // تشغيل الفيديو الخلفي أثناء المزامنة أيضاً
                if (state.mediaType === 'video') state.bgVideo.play();

                // Mark first verse start
                state.timings[startIdx] = 0;

                const onSyncEnded = (duration) => {
                    if (state.isSyncing) {
                        // FIX: Update the end verse to the last successfully synced verse when audio ends naturally.
                        const lastSyncedVerseNumber = state.currentAyahIndex + 1;
                        UI.vEnd.value = lastSyncedVerseNumber;
                        state.timings[lastSyncedVerseNumber] = duration;
                    }
                    state.isSyncing = false;
                    state.isPlaying = false;
                    state.hasSyncedOnce = true;
                    UI.startSyncBtn.classList.remove('hidden');
                    UI.tapSyncBtn.classList.add('hidden');
                    UI.stopSyncBtn.classList.add('hidden');
                    
                    // إعادة إظهار معاينة الملف بعد الانتهاء
                    if (window.innerWidth < 768) {
                        UI.localFilePreview.classList.remove('hidden');
                    }
                    UI.startSyncBtn.innerHTML = `<i data-lucide="check" class="w-3 h-3"></i> تم حفظ التوقيت (إعادة؟)`;
                    lucide.createIcons();
                    updateExportButtonState();
                    updateDurationDisplay();
                };

                if (state.useAudioElement) {
                    await initAudio();
                    if (!state.mediaSource) {
                        state.mediaSource = state.audioContext.createMediaElementSource(UI.localAudioPlayer);
                        state.mediaSource.connect(state.effectEntry);
                    }

                    UI.localAudioPlayer.currentTime = 0;
                    UI.localAudioPlayer.play();
                    state.startTime = 0;
                    UI.localAudioPlayer.onended = () => onSyncEnded(UI.localAudioPlayer.duration);
                } else {
                    await initAudio();
                    const source = state.audioContext.createBufferSource();
                    source.buffer = state.localAudioBuffer;
                    source.connect(state.audioContext.destination);
                    state.activeSource = source;
                    state.startTime = state.audioContext.currentTime;
                    source.start(0);
                    source.onended = () => onSyncEnded(state.localAudioBuffer.duration);
                }
            };

            const triggerSyncTap = () => {
                if (!state.isSyncing) return;
                const currentTime = state.useAudioElement ? UI.localAudioPlayer.currentTime : state.audioContext.currentTime - state.startTime;
                const nextIndex = state.currentAyahIndex + 1;

                if (nextIndex < state.ayahs.length) {
                    state.timings[nextIndex] = currentTime;
                    state.currentAyahIndex = nextIndex;

                    // Visual feedback
                    const btn = UI.tapSyncBtn;
                    btn.style.transform = "scale(0.95)";
                    setTimeout(() => btn.style.transform = "scale(1)", 100);
                } else {
                    stopAudio(); // Finish
                }
            };
            UI.tapSyncBtn.onclick = triggerSyncTap;

            UI.stopSyncBtn.onclick = () => {
                // Save the timestamp for the next verse (end of current) before stopping
                if (state.isSyncing) {
                    const currentTime = state.useAudioElement ? UI.localAudioPlayer.currentTime : state.audioContext.currentTime - state.startTime;
                    let effectiveEndIndex = state.currentAyahIndex + 1;

                    // Ensure we don't go beyond the actual verses of the current Surah
                    if (effectiveEndIndex > state.ayahs.length) {
                        effectiveEndIndex = state.ayahs.length;
                    }
                    state.timings[effectiveEndIndex] = currentTime;
                    UI.vEnd.value = effectiveEndIndex;
                }

                // Use the global stop function to ensure audio stops
                stopAudio();

                // Manually update UI as the original onended is now bypassed by stopAudio()
                state.hasSyncedOnce = true;
                UI.startSyncBtn.classList.remove('hidden');
                UI.tapSyncBtn.classList.add('hidden');
                UI.stopSyncBtn.classList.add('hidden');
                
                // إعادة إظهار معاينة الملف بعد إيقاف المزامنة
                if (window.innerWidth < 768) {
                    UI.localFilePreview.classList.remove('hidden');
                }
                UI.startSyncBtn.innerHTML = `<i data-lucide="check" class="w-3 h-3"></i> تم حفظ التوقيت (إعادة؟)`;
                lucide.createIcons();
                updateExportButtonState();
                updateDurationDisplay();
            };

            UI.canvasSize.onchange = () => {
                // دقة المعاينة (Preview) تعود لتكون خفيفة وسريعة (720p كحد أقصى)
                const size = UI.canvasSize.value; let w = 720, h = 1280;

                // --- Core Optimization for Mobile ---
                const isMobile = window.innerWidth < 768;
                
                if (isMobile) {
                    // للموبايل نخفض دقة المعاينة لتكون 480p لضمان أعلى سرعة بدون تقطيع
                    switch(size) { case '9:16': w = 480; h = 854; break; case '1:1': w = 480; h = 480; break; case '16:9': w = 854; h = 480; break; case '4:5': w = 480; h = 600; break; }
                } else {
                    switch(size) { case '9:16': w = 720; h = 1280; break; case '1:1': w = 720; h = 720; break; case '16:9': w = 1280; h = 720; break; case '4:5': w = 720; h = 900; break; }
                }

                state.worker.postMessage({ type: 'resize', width: w, height: h }); UI.mockup.style.aspectRatio = size.replace(':', '/');
            };

            UI.surah.onchange = (e) => { 
                state.selectedSurah = e.target.value; 
                updateContent(true); 
                
                // تحديث الرابط برقم السورة في المتصفح بدون إعادة تحميل الصفحة
                const newUrl = new URL(window.location.href);
                newUrl.searchParams.set('surah', state.selectedSurah);
                window.history.replaceState(null, '', newUrl);
            };

            const validateVerseInput = (input) => {
                let val = parseInt(input.value);
                const max = state.ayahs.length;
                if (isNaN(val) || val < 1) val = 1;
                if (val > max) val = max;
                input.value = val;
                updateDurationDisplay();
            };
            UI.vStart.onchange = () => validateVerseInput(UI.vStart);
            UI.vEnd.onchange = () => validateVerseInput(UI.vEnd);

            UI.translationSelect.onchange = (e) => { state.selectedTranslation = e.target.value; updateContent(); };
            UI.reciterSearch.oninput = (e) => renderReciterButtons(e.target.value);
            UI.fontSize.oninput = (e) => { state.fontSize = parseInt(e.target.value); UI.fsVal.innerText = state.fontSize; };
            UI.bgBlur.oninput = (e) => { state.blur = parseInt(e.target.value); UI.bgBlurVal.innerText = state.blur + 'px'; };
            UI.bgZoom.oninput = (e) => { state.zoom = parseInt(e.target.value); UI.bgZoomVal.innerText = state.zoom + '%'; };
            UI.opacityRange.oninput = (e) => { state.overlayOpacity = parseFloat(e.target.value); UI.opacityVal.innerText = Math.round(state.overlayOpacity * 100) + '%'; };
            UI.shadowBlur.oninput = (e) => { state.shadowBlur = parseInt(e.target.value); UI.shadowBlurVal.innerText = state.shadowBlur; };
            if (UI.textY) UI.textY.oninput = (e) => { state.textY = parseInt(e.target.value); if (UI.textYVal) UI.textYVal.innerText = state.textY + '%'; };
            UI.transShadowBlur.oninput = (e) => { UI.transShadowBlurVal.innerText = e.target.value; state.transShadowBlur = parseInt(e.target.value); };
            UI.animIntensity.oninput = (e) => { state.animIntensity = parseInt(e.target.value); UI.animIntensityVal.innerText = state.animIntensity + '%'; };
            UI.surahY.oninput = (e) => { UI.surahYVal.innerText = e.target.value + '%'; };
            UI.surahX.oninput = (e) => { UI.surahXVal.innerText = e.target.value + '%'; };
            UI.surahFontSize.oninput = (e) => { UI.surahFontSizeVal.innerText = e.target.value; };
            UI.waveformY.oninput = (e) => { UI.waveformYVal.innerText = e.target.value + '%'; };
            UI.waveformHeight.oninput = (e) => { UI.waveformHeightVal.innerText = e.target.value; };

            UI.showWaveform.addEventListener("change", async function () {
            });

            // Watermark Logic
            UI.showWatermark.onchange = async () => {
            };

            // Watermark Type Switching
            UI.wmTypeImage.onclick = () => {
                state.watermarkType = 'image';
                UI.wmTypeImage.className = "flex-1 py-1.5 text-[10px] font-bold rounded-md bg-[var(--panel-bg)] shadow-sm text-[#007AFF] transition-all";
                UI.wmTypeText.className = "flex-1 py-1.5 text-[10px] font-bold rounded-md text-zinc-500 hover:text-zinc-700 transition-all";
                UI.wmImageSection.classList.remove('hidden');
                UI.wmTextSection.classList.add('hidden');
            };

            UI.wmTypeText.onclick = () => {
                state.watermarkType = 'text';
                UI.wmTypeText.className = "flex-1 py-1.5 text-[10px] font-bold rounded-md bg-[var(--panel-bg)] shadow-sm text-[#007AFF] transition-all";
                UI.wmTypeImage.className = "flex-1 py-1.5 text-[10px] font-bold rounded-md text-zinc-500 hover:text-zinc-700 transition-all";
                UI.wmTextSection.classList.remove('hidden');
                UI.wmImageSection.classList.add('hidden');
            };

            UI.watermarkInput.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const img = new Image();
                img.src = URL.createObjectURL(file);
                img.onload = async () => {
                    const bmp = await createImageBitmap(img);
                    state.worker.postMessage({ type: 'watermarkFrame', bitmap: bmp }, [bmp]);
                };
            };

            UI.reverbToggle.onchange = updateAudioEffectParams;
            UI.reverbRange.oninput = (e) => { UI.reverbIntensityVal.innerText = Math.round(e.target.value * 100) + '%'; updateAudioEffectParams(); };
            UI.playBtn.onclick = () => { if (state.isPlaying) stopAudio(); else { state.isPlaying = true; playSeamless((parseInt(UI.vStart.value) || 1) - 1); } };

            UI.actionBtn.onclick = () => {
                if (!state.user) {
                    const uiState = {};
                    for (const key in UI) {
                        const el = UI[key];
                        if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) {
                            if (el.type === 'checkbox') uiState[key] = el.checked;
                            else if (el.type !== 'file') uiState[key] = el.value;
                        }
                    }
                    const editorState = {
                        state: {
                            selectedSurah: state.selectedSurah,
                            selectedReciter: state.selectedReciter,
                            selectedTranslation: state.selectedTranslation,
                            backgroundUrl: state.backgroundUrl,
                            mediaType: state.mediaType
                        },
                        ui: uiState
                    };
                    sessionStorage.setItem('editorState', JSON.stringify(editorState));
                    sessionStorage.setItem('pendingExport', 'true');
                    UI.authScreen.classList.remove('hidden');
                    return;
                }
                if (state.exportBlobUrl) resetExportUI(); else UI.confirmModal.style.display = 'flex';
            };
                UI.startExportBtn.onclick = async () => {
                state.exportDevice = 'apple'; // الاعتماد الدائم على المعالجة الشاملة لضمان توافق الصوت مع جميع الأنظمة
                    UI.confirmModal.style.display = 'none';
                    secureExport();
                };
                UI.confirmNo.onclick = () => { UI.confirmModal.style.display = 'none'; };
                UI.confirmLimit.onclick = () => { UI.vEnd.value = (parseInt(UI.vStart.value) || 1) + 4; UI.limitModal.style.display = 'none'; updateDurationDisplay(); };
                UI.cancelLimit.onclick = () => { UI.limitModal.style.display = 'none'; };
                UI.closeProModal.onclick = () => { UI.proFeatureModal.style.display = 'none'; };
                
                // زر عرض الأسعار من نافذة الميزات المدفوعة
                if (UI.viewPricingBtn) {
                    UI.viewPricingBtn.onclick = () => {
                        UI.proFeatureModal.style.display = 'none';
                        const lp = document.getElementById('landingPage');
                        lp.style.display = 'flex';
                        setTimeout(() => {
                            lp.style.opacity = '1';
                            lp.style.pointerEvents = 'auto';
                            document.getElementById('pricing').scrollIntoView({ behavior: 'smooth' });
                        }, 10);
                    };
                }

            // زر عرض الأسعار من نافذة تجاوز الحد المجاني
            if (UI.viewPricingBtnLimit) {
                UI.viewPricingBtnLimit.onclick = () => {
                    UI.limitModal.style.display = 'none';
                    const lp = document.getElementById('landingPage');
                    lp.style.display = 'flex';
                    setTimeout(() => {
                        lp.style.opacity = '1';
                        lp.style.pointerEvents = 'auto';
                        document.getElementById('pricing').scrollIntoView({ behavior: 'smooth' });
                    }, 10);
                };
            }

                UI.downloadFinalBtn.onclick = () => {
                    if (state.exportBlobUrl) {
                        const sObj = state.surahs.find(s => s.id == state.selectedSurah);
                        const sName = sObj ? sObj.name_arabic : 'Surah';
                        const ext = state.exportFormat || 'mp4';
                        const fName = `${sName} ${UI.vStart.value}-${UI.vEnd.value}.${ext}`;
                        const a = document.createElement('a');
                        a.href = state.exportBlobUrl; a.download = fName;
                        document.body.appendChild(a); a.click(); document.body.removeChild(a);
                    }
                };
                UI.backToEditorBtn.onclick = resetExportUI;
                UI.resetBgPos.onclick = () => { state.bgX = 0; state.bgY = 0; state.zoom = 100; UI.bgZoom.value = 100; UI.bgZoomVal.innerText = '100%'; };

                const handleFileUpload = async (file, type) => {
                    if (!file) return;
                    state.mediaType = type; state.isBgReady = false; state.bgX = 0; state.bgY = 0;
                    if (type === 'image') {
                        const reader = new FileReader();
                        reader.onload = (e) => {
                            state.backgroundUrl = e.target.result;
                            state.bgImg.src = state.backgroundUrl;
                        };
                        reader.readAsDataURL(file);
                        if (!state.bgVideo.paused) state.bgVideo.pause();
                    } else {
                        const localUrl = URL.createObjectURL(file);
                        state.backgroundUrl = null;
                        state.bgVideo.src = localUrl; state.bgVideo.load(); state.bgVideo.play().catch(e => console.warn("Video blocked"));
                    }
                };

                UI.bgInput.onchange = (e) => { handleFileUpload(e.target.files[0], 'image'); e.target.value = ''; };
                UI.videoInput.onchange = (e) => { handleFileUpload(e.target.files[0], 'video'); e.target.value = ''; };
                document.querySelectorAll('#stockImages img').forEach(img => {
                    img.setAttribute('loading', 'lazy'); // تحميل الصور تدريجياً لتخفيف العبء على المتصفح
                    img.setAttribute('decoding', 'async'); // منع تشنج الواجهة عند فتح التبويب لأول مرة
                    img.onclick = () => {
                        if(state.isExporting) return;
                        const url = img.src;
                        state.backgroundUrl = url;
                        state.mediaType = 'image'; state.isBgReady = false; state.bgImg.src = url;
                        if (!state.bgVideo.paused) state.bgVideo.pause();
                        document.querySelectorAll('.asset-thumb').forEach(t => t.classList.remove('active')); img.classList.add('active');
                    };
                });

                const handleStart = (clientX, clientY) => { if(state.isExporting) return; state.isDragging = true; state.lastMouseX = clientX; state.lastMouseY = clientY; };
                const handleMove = (clientX, clientY) => {
                    if (!state.isDragging || state.isExporting) return;
                    const dx = clientX - state.lastMouseX; const dy = clientY - state.lastMouseY;
                    const rect = UI.canvas.getBoundingClientRect();
                    state.bgX += dx * (UI.canvas.width / rect.width); state.bgY += dy * (UI.canvas.height / rect.height);
                    state.lastMouseX = clientX; state.lastMouseY = clientY;
                };

                // Mouse Events
                UI.mockup.addEventListener('mousedown', (e) => handleStart(e.clientX, e.clientY));
                window.addEventListener('mousemove', (e) => handleMove(e.clientX, e.clientY));
                window.addEventListener('mouseup', () => state.isDragging = false);

                // Touch Events
                UI.mockup.addEventListener('touchstart', (e) => { if(e.touches.length === 1) handleStart(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
                window.addEventListener('touchmove', (e) => {
                    if (state.isDragging && e.touches.length === 1) { e.preventDefault(); handleMove(e.touches[0].clientX, e.touches[0].clientY); }
                }, { passive: false });
                window.addEventListener('touchend', () => state.isDragging = false);

        document.getElementById('startNowBtn').onclick = () => { const lp = document.getElementById('landingPage'); lp.style.opacity = '0'; lp.style.pointerEvents = 'none'; setTimeout(() => { lp.style.display = 'none'; }, 700); loadHeavyScripts(); };

            if (UI.pricingStartFreeBtn) {
                UI.pricingStartFreeBtn.onclick = () => {
                    if (state.user) {
                    const lp = document.getElementById('landingPage'); lp.style.opacity = '0'; lp.style.pointerEvents = 'none'; setTimeout(() => { lp.style.display = 'none'; }, 700); loadHeavyScripts();
                    } else {
                        UI.authScreen.classList.remove('hidden');
                    }
                };
            }

            if (UI.addReviewBtn) {
                UI.addReviewBtn.onclick = () => {
                    if (!state.user) {
                        UI.authScreen.classList.remove('hidden'); // يطلب منه التسجيل أولاً
                    } else {
                        UI.reviewContent.value = '';
                        UI.reviewFeedback.classList.add('hidden');
                        UI.reviewModal.style.display = 'flex';
                    }
                };
            }
            
            if (UI.closeReviewModal) {
                UI.closeReviewModal.onclick = () => { UI.reviewModal.style.display = 'none'; };
            }
            
            if (UI.submitReviewBtn) {
                UI.submitReviewBtn.onclick = async () => {
                    const content = UI.reviewContent.value.trim();
                    if (!content) return;
                    
                    UI.submitReviewBtn.disabled = true;
                    UI.submitReviewBtn.innerHTML = 'جاري الإرسال...';
                    
                    try {
                        const userName = state.user.user_metadata?.full_name || state.user.email.split('@')[0];
                        const avatarUrl = state.user.user_metadata?.avatar_url || null;
                        
                        const { error } = await supabaseClient.from('testimonials').insert([
                            { user_id: state.user.id, name: userName, avatar_url: avatarUrl, content: content, is_approved: false }
                        ]);
                        if (error) throw error;
                        
                        UI.reviewContent.value = '';
                        UI.reviewFeedback.innerText = 'شكرًا لك! تم إرسال تقييمك بنجاح وسينشر قريباً بعد المراجعة.';
                        UI.reviewFeedback.className = 'text-xs text-green-500 text-center block font-bold mt-3';
                        setTimeout(() => { UI.reviewModal.style.display = 'none'; }, 3500);
                    } catch (e) {
                        UI.reviewFeedback.innerText = 'حدث خطأ أثناء إرسال التقييم. حاول مرة أخرى.';
                        UI.reviewFeedback.className = 'text-xs text-red-500 text-center block font-bold mt-3';
                    } finally {
                        UI.submitReviewBtn.disabled = false;
                        UI.submitReviewBtn.innerHTML = `<i data-lucide="send" class="w-4 h-4"></i><span>إرسال التقييم</span>`;
                        lucide.createIcons();
                    }
                };
            }

                UI.studioLogoBtn.onclick = () => {
                    const lp = document.getElementById('landingPage');
                    lp.style.display = 'flex';
                    setTimeout(() => {
                        lp.style.opacity = '1';
                        lp.style.pointerEvents = 'auto';
                    }, 10);
                };
        }

        window.onload = start;
