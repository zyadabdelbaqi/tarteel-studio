import { supabaseClient, state, initSupabase } from './store.js';
import { UI } from './ui.js';
import { enforceSingleSession, checkAuth, loadUserPlan, updateProfileUI, signInWithGoogle, loadTestimonials } from './auth.js';
import { updateExportButtonState, resetExportUI, secureExport, audioBufferToWavBytes, preloadFFmpegAssets } from './export.js';
import { initRenderer, startMainSyncLoop, ensureFontLoaded } from './renderer.js';
import { initAudio, stopAudio, playSeamless, clearLocalAudioFile, updateAudioEffectParams, fetchAudioBuffer, addToAudioCache, clearAudioCache, calculateSilence } from './audio.js';
import { templates } from './templates.js'; // استيراد القوالب الجديدة
import { getCache, setCache } from './db.js';
import { getUserCapabilities, getAllowedRange, getRealVerseCount, getAyahIndexByRealNumber, getRealNumberByAyahIndex } from './permissions.js';
import { isExporting } from './exportQueue.js';

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

// 🚀 تهيئة Supabase بشكل صريح وآمن (Explicit Initialization)
initSupabase();

// Helper Function: تحديث محتوى الأزرار (أيقونة + نص) بطريقة آمنة
function setBtnContent(btn, iconName, text, spin = false, iconClass = "w-4 h-4") {
    if (!btn) return;
    btn.textContent = '';
    if (iconName) {
        const i = document.createElement('i');
        i.setAttribute('data-lucide', iconName);
        i.className = iconClass + (spin ? " animate-spin" : "");
        btn.appendChild(i);
    }
    if (text) {
        btn.appendChild(document.createTextNode(iconName ? ' ' + text : text));
    }
    if (window.lucide) window.lucide.createIcons();
}

// إنشاء نسخة واحدة (Singleton) لتقليل الضغط على الذاكرة والمعالج أثناء الحلقات التكرارية (Loops)
const htmlDecoderParser = new DOMParser();

// Helper Function: فك تشفير وتطهير النصوص (XSS Protection & HTML Entities Decoding)
function decodeHTMLEntities(text) {
    if (!text) return '';
    const doc = htmlDecoderParser.parseFromString(text, 'text/html');
    return doc.documentElement.textContent || '';
}

    async function checkAppUpdates() {
        try {
            const { data, error } = await supabaseClient
                .from('app_updates')
                .select('*')
                .eq('is_active', true)
                .limit(1)
                .maybeSingle();

            if (error || !data) return;

            const lastSeenUpdateId = localStorage.getItem('last_seen_update');

            if (data.id !== lastSeenUpdateId) {
                if (UI.updateTitle) UI.updateTitle.textContent = data.title;
                if (UI.updateContent) {
                    UI.updateContent.textContent = '';
                    data.content.split(/(?:\r\n|\r|\n)/g).forEach((line, i, arr) => {
                        UI.updateContent.appendChild(document.createTextNode(line));
                        if (i < arr.length - 1) UI.updateContent.appendChild(document.createElement('br'));
                    });
                }
                UI.updatesModal?.style.setProperty('display', 'flex');
                if (window.lucide) window.lucide.createIcons();

                if (UI.closeUpdateBtn) {
                    UI.closeUpdateBtn.onclick = () => {
                        localStorage.setItem('last_seen_update', data.id);
                        UI.updatesModal?.style.setProperty('display', 'none');
                    };
                }
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
            
            // بدء التحميل المسبق لملفات التصدير في الخلفية بمجرد الدخول للاستوديو
            if (typeof preloadFFmpegAssets === 'function') preloadFFmpegAssets();
        }
    }

    async function start() {
        if (window.lucide) window.lucide.createIcons();
        try {
        const urlHasAuthParams = window.location.hash.includes('access_token=') || window.location.hash.includes('refresh_token=') || window.location.search.includes('code=');
        
        // تحديث الشرط ليدعم أنظمة التسجيل الحديثة (PKCE) التي تعتمد على code في الرابط
        if (urlHasAuthParams) {
            try {
                localStorage.removeItem('device_session_id');
                localStorage.removeItem('device_session_ver');
            } catch (e) {}
        }

        let session = null;
        try {
            const result = await supabaseClient.auth.getSession();
            session = result?.data?.session || null;
        } catch (e) {
            console.warn('Session init error:', e);
        }

        state.user = session?.user || null;
        if (state.user) {
            try {
            const isValid = await enforceSingleSession(state.user);
            if (isValid) {
                await loadUserPlan().catch(e => console.warn("Initial load plan error:", e));
            }
            } catch (e) {
                console.warn("Session enforcement error:", e);
            }
        }

        supabaseClient.auth.onAuthStateChange(async (_event, session) => {
            if (_event === 'INITIAL_SESSION') return;
            const isNewLogin = _event === 'SIGNED_IN' && !state.user && session?.user;
            state.user = session?.user || null;
            
            // إظهار شاشة التحميل إذا كان هذا تسجيل دخول جديد
            if (isNewLogin) {
                if (UI.globalLoader) {
                    if (UI.globalLoaderText) UI.globalLoaderText.textContent = "جاري إعداد بيانات حسابك...";
                    UI.globalLoader.classList.remove('hidden');
                    setTimeout(() => {
                        UI.globalLoader.style.opacity = '1';
                        UI.globalLoader.style.pointerEvents = 'auto';
                    }, 10);
                }
            }

            try {
                if (state.user) {
                    const isValid = await enforceSingleSession(state.user, isNewLogin);
                    if (!isValid) return;
                    await loadUserPlan().catch(e => console.warn("Auth change plan error:", e));
                }
                checkAuth();
            } catch (err) {
                console.error("Auth processing error:", err);
            } finally {
                // ضمان إخفاء شاشة التحميل مهما كانت النتيجة لمنع تعليق الموقع
                if (isNewLogin) {
                    if (UI.globalLoader) {
                        UI.globalLoader.style.opacity = '0';
                        UI.globalLoader.style.pointerEvents = 'none';
                        setTimeout(() => UI.globalLoader.classList.add('hidden'), 500);
                    }
                    
                    // مسح رموز تسجيل الدخول من الرابط بعد التأكد من إتمام العملية بدلاً من التخمين بـ 3 ثوانٍ
                    if (window.location.search.includes('code=') || window.location.hash.includes('access_token=')) {
                        const cleanUrl = window.location.href.split('#')[0].split('?')[0];
                        window.history.replaceState(null, '', cleanUrl);
                    }
                }
            }

            if (state.user && sessionStorage.getItem('pendingExport') === 'true') {
                const lp = document.getElementById('landingPage');
                if (lp) {
                    lp.style.display = 'none';
                    const video = lp.querySelector('video');
                    if (video) video.pause();
                }
                sessionStorage.removeItem('pendingExport');
                UI.authScreen.classList.add('hidden');
                loadHeavyScripts();
                UI.confirmModal.style.display = 'flex';
            }
        });

        checkAuth();
        updateExportButtonState();

        // إضافة فحص دوري للجلسة لمنع استخدام الحساب على أكثر من جهاز في نفس الوقت
        let isCheckingSession = false;
        
        const checkCurrentSession = async () => {
            // التحقق من أن التبويب نشط (visible) لعدم استهلاك الشبكة في الخلفية
            if (!state.user || isExporting() || isCheckingSession || document.hidden) return;
            
            isCheckingSession = true;
            try {
                const { data: { user }, error } = await supabaseClient.auth.getUser();
                if (user && !error) {
                    await enforceSingleSession(user); // يجب استخدام await لضمان التسلسل
                }
            } catch (e) {} finally {
                isCheckingSession = false;
            }
        };

        // الفحص الدوري كل 5 دقائق لتخفيف الضغط على الخادم
        setInterval(checkCurrentSession, 5 * 60 * 1000);

        // الفحص الفوري عند العودة للتبويب (الحل الاحترافي للـ Background Throttling)
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) checkCurrentSession();
        });

        await Promise.all([loadReciters(), loadSurahs(), loadTranslations()]);
        await loadTestimonials(); // جلب التقييمات الحقيقية
        checkAppUpdates(); // فحص التحديثات وعرضها إذا لزم الأمر

        // مزامنة القائمة المنسدلة مع الحالة الافتراضية للسورة قبل معالجة الرابط
        if (UI.surah) UI.surah.value = state.selectedSurah;

        // قراءة السورة المطلوبة من الرابط لصفحات الـ SEO التلقائية
        const urlParams = new URLSearchParams(window.location.search);
        let targetSurah = urlParams.get('surah');
        const pathMatch = window.location.pathname.match(/surah-([a-z0-9-]+)-video/i);
        if (pathMatch) {
            const slugIndex = surahSlugs.indexOf(pathMatch[1]);
            if (slugIndex !== -1) targetSurah = slugIndex + 1;
        }

        let shouldOpenStudio = urlParams.get('app') === 'true' || !!state.user;
        
        if (window.location.hash === '#pricing' || window.location.hash === '#features' || window.location.hash === '#faq' || window.location.hash === '#testimonials') {
            shouldOpenStudio = false;
        }

        if (sessionStorage.getItem('authRedirect') === '#pricing') {
            shouldOpenStudio = false;
            sessionStorage.removeItem('authRedirect');
            setTimeout(() => {
                const lp = document.getElementById('landingPage');
                if (lp) {
                    lp.style.display = 'flex';
                    lp.style.opacity = '1';
                    lp.style.pointerEvents = 'auto';
                }
                document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' });
            }, 500);
        }

        if (targetSurah && !isNaN(targetSurah) && targetSurah >= 1 && targetSurah <= 114) {
            state.selectedSurah = parseInt(targetSurah);
            if (UI.surah) UI.surah.value = state.selectedSurah;
            shouldOpenStudio = true;
        }

        if (shouldOpenStudio) {
            // الدخول للاستوديو وتخطي الصفحة الرئيسية مباشرة
            const lp = document.getElementById('landingPage');
            if (lp) {
                lp.style.display = 'none';
                lp.style.opacity = '0';
                lp.style.pointerEvents = 'none';
                const video = lp.querySelector('video');
                if (video) video.pause();
            }
            loadHeavyScripts();
        }

        initRenderer();

        setupEvents();

        const previewVideo = document.querySelector('#preview video');

        if (previewVideo) {
            // إعدادات أساسية لضمان عمل الفيديو كخلفية بسلاسة
            previewVideo.muted = true;
            previewVideo.loop = true;
            previewVideo.playsInline = true;
            previewVideo.preload = "auto";

            // سحب رابط الفيديو مبكراً جداً في الخلفية لتهيئة مشغل المتصفح (Video Decoder)
            // حتى لا يتفاجأ به المتصفح عند السكرول ويسبب "تجميد" أو تقطيع
            setTimeout(() => {
                if (!previewVideo.getAttribute('src') && previewVideo.getAttribute('data-src')) {
                    previewVideo.setAttribute('src', previewVideo.getAttribute('data-src'));
                }
            }, 100);

            let pauseTimeout;

            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        clearTimeout(pauseTimeout);
                        
                        if (!previewVideo.getAttribute('src') && previewVideo.getAttribute('data-src')) {
                            previewVideo.setAttribute('src', previewVideo.getAttribute('data-src'));
                        }
                        
                        if (previewVideo.paused) {
                            // فصل أمر التشغيل عن دورة الرسم (Paint Cycle) الخاصة بالمتصفح لمنع ثقل السكرول تماماً
                            requestAnimationFrame(() => {
                                setTimeout(() => previewVideo.play().catch(() => {}), 0);
                            });
                        }
                    } else {
                        pauseTimeout = setTimeout(() => {
                            if (!previewVideo.paused) {
                                previewVideo.pause();
                            }
                        }, 250);
                    }
                });
            }, { rootMargin: "800px", threshold: 0 }); // توسيع هامش الرؤية ليبدأ التشغيل قبل الوصول إليه بكثير

            observer.observe(previewVideo);
        }

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
            
            // تحديث قيم الواجهة الافتراضية
            if (UI.shadowBlur) {
                UI.shadowBlur.value = 15;
                if (UI.shadowBlurVal) UI.shadowBlurVal.textContent = 15;
            }
            if (UI.transTextColor) {
                // 💡 ضمان أن يكون لون الترجمة الافتراضي أبيضاً عند أول تشغيل
                UI.transTextColor.value = '#ffffff';
            }
        }

        if (state.user && sessionStorage.getItem('pendingExport') === 'true') {
            const lp = document.getElementById('landingPage');
            if (lp) {
                lp.style.display = 'none';
                const video = lp.querySelector('video');
                if (video) video.pause();
            }
            sessionStorage.removeItem('pendingExport');
            UI.authScreen.classList.add('hidden');
            loadHeavyScripts();
            UI.confirmModal.style.display = 'flex';
        }

        startMainSyncLoop(); // Start data syncing loop

        } catch (globalError) {
            console.error("Critical error during app startup:", globalError);
        } finally {
        // إخفاء شاشة التحميل العامة بعد انتهاء تجهيز الموقع
        if (UI.globalLoader) {
            UI.globalLoader.style.opacity = '0';
            UI.globalLoader.style.pointerEvents = 'none';
            setTimeout(() => UI.globalLoader.classList.add('hidden'), 500);
        }
        }
    }

        async function loadReciters() {
            try {
                let data = await getCache('reciters');
                if (!data) {
                    const res = await fetch('https://api.quran.com/api/v4/resources/recitations?language=ar', { cache: 'force-cache' });
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

                const priorityIds = [9, 7, 104, 4, 101, 102, 117, 105, 2, 103, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 93, 156, 86, 5, 11, 3, 10];
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
                UI.translationSelect.textContent = '';
                state.translations.forEach(t => {
                    const opt = document.createElement('option');
                    opt.value = t.id; opt.selected = (t.id === 'english');
                    opt.textContent = `[${t.language_name.toUpperCase()}] ${t.name}`;
                    UI.translationSelect.appendChild(opt);
                });
            } catch (e) { console.error("Translations Load Error:", e); }
        }

        function getArabicStyle(style) {
            if (!style) return "مرتل";
            const s = style.toLowerCase();
            if (s.includes("mujawwad") || s.includes("مجود")) return "مجود";
            if (s.includes("muallim") || s.includes("معلم")) return "معلم";
            return "مرتل";
        }

        function renderReciterButtons(filter) {
            UI.reciters.textContent = "";
            const filtered = state.reciters.filter(r => (r.translated_name?.name || "").includes(filter) || (r.reciter_name || "").toLowerCase().includes(filter.toLowerCase()));
            filtered.forEach(r => {
                const btn = document.createElement('button');
                btn.className = `reciter-btn ${state.selectedReciter === r.id ? 'active' : ''}`;
                const arabicStyle = getArabicStyle(r.style);
                const nameSpan = document.createElement('span');
                nameSpan.textContent = decodeHTMLEntities(r.translated_name?.name || r.reciter_name);
                const styleSpan = document.createElement('span');
                styleSpan.className = "style-badge";
                styleSpan.textContent = arabicStyle;
                btn.appendChild(nameSpan); btn.appendChild(styleSpan);
                
                btn.onclick = () => { if(state.isExporting) return; state.selectedReciter = r.id; renderReciterButtons(filter); updateContent(); };
                UI.reciters.appendChild(btn);
            });
        }

        async function loadSurahs() {
            try {
                let data = await getCache('surahs');
                if (!data) {
                    const res = await fetch('data/surahs.json', { cache: 'force-cache' });
                    data = await res.json();
                    await setCache('surahs', data);
                }
                state.surahs = data.chapters || [];
                UI.surah.textContent = '';
                state.surahs.forEach(s => {
                    if (s.name_arabic) s.name_arabic = decodeHTMLEntities(s.name_arabic);
                    const opt = document.createElement('option');
                    opt.value = s.id.toString(); opt.textContent = `${s.id}. ${s.name_arabic}`;
                    UI.surah.appendChild(opt);
                });
            } catch (e) { console.error("Surahs Load Error:", e); }
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

            seoSection.textContent = '';
            const wrap = document.createElement('div');
            wrap.className = "p-4 bg-[var(--input-bg)] rounded-xl border border-[var(--border-color)] shadow-sm text-zinc-400 text-right";
            wrap.dir = "rtl";
            const h2 = document.createElement('h2');
            h2.className = "text-sm font-bold mb-2 text-[var(--text-main)]";
            h2.textContent = `صانع فيديوهات قرآنية: تصميم فيديو سورة ${arabicName} احترافي`;
            const p1 = document.createElement('p');
            p1.className = "text-[10px] mb-3 leading-relaxed";
            p1.textContent = `صمم فيديو تلاوة سورة ${arabicName} بصوت عذب مع مزامنة دقيقة للنص العثماني. أداة Tarteel Studio تتيح لك صناعة فيديوهات قرآنية مذهلة ومشاركتها كـ ريلز (Reels) أو تيك توك أو يوتيوب شورتس بسهولة وخلال ثوانٍ.`;
            const h3 = document.createElement('h3');
            h3.className = "text-xs font-bold mb-2 text-[var(--text-main)]";
            h3.textContent = `معلومات ونبذة عن سورة ${arabicName}`;
            const p2 = document.createElement('p');
            p2.className = "text-[10px] leading-relaxed";
            p2.textContent = `سورة ${arabicName} هي السورة رقم ${currentIdx} في الترتيب القرآني${revelationText}. صمم الآن مقطع فيديو مميز لتلاوة سورة ${arabicName} بخطوط عربية أصيلة مثل خط المصحف، وشارك الأجر مع متابعيك.`;
            wrap.appendChild(h2); wrap.appendChild(p1); wrap.appendChild(h3); wrap.appendChild(p2);
            seoSection.appendChild(wrap);
            // seoSection.classList.remove('hidden');
        }

        let fetchingDurations = false;
        let currentFetchId = 0;
        async function fetchDurationsForRange(startIdx, endIdx) {
            if (state.audioMode !== 'online') return;
            
            let missingIdxs = [];
            for (let i = startIdx; i < endIdx; i++) {
                const key = `${state.selectedReciter}_${i}`;
                if (!state.audioCache[key] && state.ayahs[i] && state.ayahs[i].audioUrl && !state.ayahs[i].apiDuration) {
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
                            if (buf && currentFetchId === fetchId) { addToAudioCache(idx, buf); return true; }
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
            const startIdx = getAyahIndexByRealNumber(parseInt(UI.vStart.value) || 1, false);
            const endIdx = getAyahIndexByRealNumber(parseInt(UI.vEnd.value) || getRealVerseCount(), true);
            const versesCount = parseInt(UI.vEnd.value) - parseInt(UI.vStart.value) + 1;
            
            if (versesCount <= 0 || startIdx < 0 || endIdx > state.ayahs.length || isNaN(versesCount)) {
                 state.previewTimeStr = "";
                 if (UI.rangeHint) {
                     UI.rangeHint.textContent = '';
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
                    const key = `${state.selectedReciter}_${i}`;
                    if (state.audioCache && state.audioCache[key]) {
                        exactDuration += state.audioCache[key].duration;
                    } else if (state.ayahs[i] && state.ayahs[i].apiDuration > 0) {
                        exactDuration += state.ayahs[i].apiDuration;
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
                    UI.rangeHint.textContent = '';
                    const wrap = document.createElement('div');
                    wrap.className = "flex items-center justify-center gap-1.5 mt-3 text-xs font-medium text-zinc-300 bg-[var(--panel-bg)] py-2 px-3 rounded-xl border border-[var(--border-color)] shadow-sm";
                    const icon = document.createElement('i');
                    icon.setAttribute('data-lucide', 'loader-2'); icon.className = "w-4 h-4 text-[#007AFF] animate-spin";
                    const span = document.createElement('span');
                    span.className = "text-[#007AFF] font-bold mx-1"; span.dir = "rtl"; span.textContent = "جاري الحساب...";
                    wrap.appendChild(icon); wrap.appendChild(span);
                    UI.rangeHint.appendChild(wrap);
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
                    UI.rangeHint.textContent = '';
                    const wrap = document.createElement('div');
                    wrap.className = "flex items-center justify-center gap-1.5 mt-3 text-xs font-medium text-zinc-300 bg-[var(--panel-bg)] py-2 px-3 rounded-xl border border-[var(--border-color)] shadow-sm";
                    const icon = document.createElement('i'); icon.setAttribute('data-lucide', 'clock'); icon.className = "w-4 h-4 text-[#007AFF]";
                    const s1 = document.createElement('span'); s1.textContent = "المدة المتوقعة:";
                    const s2 = document.createElement('span'); s2.className = "text-[#007AFF] font-bold mx-1"; s2.dir = "ltr"; s2.textContent = countStr;
                    wrap.appendChild(icon); wrap.appendChild(s1); wrap.appendChild(s2);
                    if (!isExact) {
                        const s3 = document.createElement('span');
                        s3.className = "text-[10px] text-zinc-500"; s3.textContent = "(تقريبية)";
                        wrap.appendChild(s3);
                    }
                    UI.rangeHint.appendChild(wrap);
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

        function createSplitModal() {
            if (document.getElementById('splitAyahModal')) return;
            
            const modal = document.createElement('div');
            modal.id = 'splitAyahModal';
            modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm z-[9999] hidden flex items-center justify-center p-4 opacity-0 transition-all duration-300';
            
            modal.innerHTML = `
                <div class="bg-[var(--panel-bg)] border border-[var(--border-color)] rounded-2xl w-full max-w-xl flex flex-col overflow-hidden shadow-2xl transform scale-95 transition-all duration-300" id="splitAyahCard">
                    <div class="flex items-center justify-between p-4 border-b border-[var(--border-color)]">
                        <h3 class="text-lg font-bold text-[#007AFF] flex items-center gap-2">
                            <i data-lucide="scissors" class="w-5 h-5 text-[#007AFF]"></i> تقسيم الآيات
                        </h3>
                        <button id="closeSplitModal" class="text-zinc-400 hover:text-red-500 transition-colors">
                            <i data-lucide="x" class="w-6 h-6"></i>
                        </button>
                    </div>
                    <div class="p-5 flex-1 overflow-y-auto max-h-[70vh] custom-scroll">
                        <div class="mb-6">
                            <div class="flex justify-between items-center mb-2">
                                <label class="block text-sm font-bold text-zinc-500 flex items-center gap-2"><i data-lucide="list-ordered" class="w-4 h-4 text-[#007AFF]"></i> 1. اختر الآية المراد تقسيمها:</label>
                                <button id="undoSplitBtn" class="hidden text-xs font-bold text-red-500 bg-red-500/10 hover:bg-red-500/20 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1"><i data-lucide="rotate-ccw" class="w-3 h-3"></i> تراجع عن التقسيم</button>
                            </div>
                            <select id="splitAyahSelect" class="w-full" dir="rtl"></select>
                        </div>
                        
                        <div id="splitAudioContainer" class="mb-6 p-4 bg-[#007AFF]/5 rounded-xl border border-[#007AFF]/20 hidden relative overflow-hidden">
                            <div class="absolute top-0 right-0 w-1 h-full bg-[#007AFF]"></div>
                            <label class="block text-sm font-bold text-[#007AFF] mb-2 flex items-center gap-2"><i data-lucide="headphones" class="w-4 h-4"></i> 2. اضبط توقيت الكلمة (اختياري):</label>
                            <p class="text-xs text-zinc-400 mb-3 leading-relaxed">شغل الصوت وأوقفه (Pause) فور نطق القارئ للكلمة التي تريد القص عندها لضمان مزامنة احترافية.</p>
                            <audio id="splitAudioPlayer" controls class="w-full h-10 rounded-lg outline-none" controlsList="nodownload noplaybackrate"></audio>
                            <div id="splitAudioLoading" class="absolute inset-0 bg-[var(--panel-bg)]/80 backdrop-blur-sm flex items-center justify-center text-[#007AFF] text-sm font-bold gap-2 z-10 hidden">
                                <i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i> جاري استخراج المقطع الصوتي...
                            </div>
                        </div>

                        <div class="mb-2">
                            <label class="block text-sm font-bold text-zinc-500 mb-2 flex items-center gap-2"><i data-lucide="split-square-horizontal" class="w-4 h-4 text-[#007AFF]"></i> 3. انقر على الكلمة لفصل الآية:</label>
                        </div>
                        <div id="splitWordsContainer" class="flex flex-wrap gap-2 justify-center p-6 bg-[var(--input-bg)] rounded-xl border border-[var(--border-color)] dir-rtl text-[var(--text-main)] text-3xl leading-loose shadow-inner min-h-[100px]">
                        </div>
                        <p class="text-xs text-zinc-500 text-center mt-4 hidden" id="splitHelpText">ستنقسم الآية إلى جزئين، وسينتهي الجزء الأول عند الكلمة المحددة.</p>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            
            document.getElementById('closeSplitModal').onclick = () => {
                const player = document.getElementById('splitAudioPlayer');
                if (player) {
                    player.pause();
                    if (player.dataset.blobUrl) {
                        URL.revokeObjectURL(player.dataset.blobUrl);
                        player.dataset.blobUrl = '';
                        player.src = '';
                    }
                }
                modal.style.opacity = '0';
                const card = document.getElementById('splitAyahCard');
                if (card) card.style.transform = 'scale(0.95)';
                setTimeout(() => modal.classList.add('hidden'), 300);
            };
            const splitSelect = document.getElementById('splitAyahSelect');
            splitSelect.onchange = (e) => {
                const idx = parseInt(e.target.value);
                renderSplitWords(idx);
                const ayah = state.ayahs[idx];
                const undoBtn = document.getElementById('undoSplitBtn');
                if (undoBtn) {
                    if (ayah && ayah.isSplit) undoBtn.classList.remove('hidden');
                    else undoBtn.classList.add('hidden');
                }
            };
            
            document.getElementById('undoSplitBtn').onclick = () => {
                const idx = parseInt(splitSelect.value);
                const ayah = state.ayahs[idx];
                if (!ayah || !ayah.isSplit) return;
                
                const verseKey = ayah.verse_key;
                const indices = [];
                let originalAyah = null;
                for (let i = 0; i < state.ayahs.length; i++) {
                    if (state.ayahs[i].verse_key === verseKey) {
                        indices.push(i);
                        if (!originalAyah && state.ayahs[i].originalAyah) {
                            originalAyah = state.ayahs[i].originalAyah;
                        }
                    }
                }
                
                if (indices.length > 1 && originalAyah) {
                    const firstIdx = indices[0];
                    const count = indices.length;
                    state.ayahs.splice(firstIdx, count, originalAyah);
                    if (state.timings && state.timings.length > 0) {
                        state.timings.splice(firstIdx + 1, count - 1);
                    }
                    clearAudioCache();
                    state.splitBlobCache = {};
                    state.uiDirty = true;
                    UI.vEnd.dispatchEvent(new Event('change'));
                    updateDurationDisplay();
                    populateSplitModalSelect(firstIdx);
                }
            };
            createCustomDropdown(splitSelect);
        }

        function renderSplitWords(ayahIndex) {
            const container = document.getElementById('splitWordsContainer');
            const helpText = document.getElementById('splitHelpText');
            const audioContainer = document.getElementById('splitAudioContainer');
            const audioPlayer = document.getElementById('splitAudioPlayer');
            const loadingOverlay = document.getElementById('splitAudioLoading');
            container.innerHTML = '';
            const ayah = state.ayahs[ayahIndex];
            if (!ayah) return;
            
            audioPlayer.pause();
            audioPlayer.src = '';
            audioContainer.classList.remove('hidden');
            if (loadingOverlay) loadingOverlay.classList.remove('hidden');
            
            // تنظيف الرابط السابق لمنع تسريب الذاكرة
            if (audioPlayer.dataset.blobUrl) {
                URL.revokeObjectURL(audioPlayer.dataset.blobUrl);
                audioPlayer.dataset.blobUrl = '';
            }
            
            const currentRenderId = (parseInt(audioPlayer.dataset.renderId) || 0) + 1;
            audioPlayer.dataset.renderId = currentRenderId;

            const prepareSegment = async () => {
                await initAudio();
                let buffer = null;
                let startT = 0;
                let endT = 0;

                if (state.audioMode === 'local') {
                    if (!state.localAudioBuffer && state.localAudioFile) {
                        const arrayBuffer = await state.localAudioFile.arrayBuffer();
                        state.localAudioBuffer = await new Promise((resolve, reject) => {
                            state.audioContext.decodeAudioData(arrayBuffer, resolve, reject);
                        });
                    }
                    buffer = state.localAudioBuffer;
                    if (buffer) {
                        startT = state.timings[ayahIndex] || 0;
                        endT = state.timings[ayahIndex + 1];
                        if (endT === undefined) endT = buffer.duration;
                    }
                } else if (state.audioMode === 'online' && ayah.audioUrl) {
                    const key = `${state.selectedReciter}_${ayahIndex}`;
                    buffer = state.audioCache[key];
                    if (!buffer) {
                        buffer = await fetchAudioBuffer(ayah.audioUrl);
                        if (buffer) addToAudioCache(ayahIndex, buffer);
                    }
                    if (buffer) {
                        const offsetRatio = ayah.splitStartRatio || 0;
                        const durationRatio = ayah.splitDurationRatio || 1;
                        startT = buffer.duration * offsetRatio;
                        endT = startT + (buffer.duration * durationRatio);
                    }
                }

                if (currentRenderId != audioPlayer.dataset.renderId) return;

                if (buffer && endT > startT) {
                    // إنشاء مفتاح فريد للكاش يعتمد على القارئ ورقم الآية والتوقيت لضمان الدقة
                    state.splitBlobCache = state.splitBlobCache || {};
                    const cacheKey = `${state.audioMode}_${state.selectedReciter || 'local'}_${ayahIndex}_${startT.toFixed(3)}_${endT.toFixed(3)}`;
                    
                    // استخدام المقطع الجاهز فوراً من الذاكرة إذا تم استخراجه مسبقاً
                    if (state.splitBlobCache[cacheKey]) {
                        const blobUrl = URL.createObjectURL(state.splitBlobCache[cacheKey]);
                        if (currentRenderId != audioPlayer.dataset.renderId) {
                            URL.revokeObjectURL(blobUrl);
                            return;
                        }
                        audioPlayer.src = blobUrl;
                        audioPlayer.dataset.blobUrl = blobUrl;
                        if (loadingOverlay) loadingOverlay.classList.add('hidden');
                        return;
                    }

                    const sampleRate = buffer.sampleRate;
                    const startSample = Math.max(0, Math.floor(startT * sampleRate));
                    const endSample = Math.min(buffer.length, Math.floor(endT * sampleRate));
                    const frameCount = Math.max(1, endSample - startSample);
                    
                    const segmentBuffer = state.audioContext.createBuffer(buffer.numberOfChannels, frameCount, sampleRate);
                    for (let c = 0; c < buffer.numberOfChannels; c++) {
                        segmentBuffer.getChannelData(c).set(buffer.getChannelData(c).subarray(startSample, endSample));
                    }
                    
                    const wavBytes = await audioBufferToWavBytes(segmentBuffer);
                    const blob = new Blob([wavBytes], { type: 'audio/wav' });
                    state.splitBlobCache[cacheKey] = blob; // حفظ الملف في الكاش للمرات القادمة
                    const blobUrl = URL.createObjectURL(blob);
                    
                    if (currentRenderId != audioPlayer.dataset.renderId) {
                        URL.revokeObjectURL(blobUrl);
                        return;
                    }
                    
                    audioPlayer.src = blobUrl;
                    audioPlayer.dataset.blobUrl = blobUrl;
                    if (loadingOverlay) loadingOverlay.classList.add('hidden');
                } else {
                    audioContainer.classList.add('hidden');
                }
            };
            
            prepareSegment().catch((err) => {
                console.error(err);
                if (currentRenderId == audioPlayer.dataset.renderId) audioContainer.classList.add('hidden');
            });

            let v = UI.fontVersion.value;
            const s = state.surahs.find(x => x.id == state.selectedSurah);
            if (v === 'v2' && s && [79, 80, 83, 84, 87, 88, 89, 90, 92, 94, 96, 98, 100].includes(parseInt(s.id))) {
                v = 'v1';
            }

            let fontName = 'Amiri';
            let fontUrl = '';
            let displayWords = [];
            const uthmaniWords = ayah.text_uthmani.split(' ');

            if (v === 'mushaf') {
                fontName = 'AlMushaf';
                fontUrl = 'https://cdn.jsdelivr.net/gh/zyadabdelbaqi/tarteel-assets@main/fonts/AlMushaf/AlMushaf.woff2';
                displayWords = uthmaniWords;
            } else if (v === 'pt_bold') {
                fontName = 'PT Bold Heading';
                fontUrl = 'https://cdn.jsdelivr.net/gh/zyadabdelbaqi/tarteel-assets@main/fonts/PT%20Bold%20Heading/PT%20Bold%20Heading.woff2';
                displayWords = uthmaniWords;
            } else if (v === 'v1' || v === 'v2') {
                const pageNum = ayah.page_number || 1;
                fontName = `QuranPage${v.toUpperCase()}_${pageNum}`;
                fontUrl = `https://cdn.jsdelivr.net/gh/zyadabdelbaqi/tarteel-assets@main/fonts/${v}/p${pageNum}.woff2`;
                
                const codeWords = v === 'v2' ? (ayah.code_v2 ? ayah.code_v2.split(' ') : []) : (ayah.code_v1 ? ayah.code_v1.split(' ') : []);
                if (codeWords.length > 0) {
                    displayWords = codeWords;
                } else {
                    displayWords = uthmaniWords;
                }
            } else {
                displayWords = uthmaniWords;
            }

            if (uthmaniWords.length <= 1) {
                container.innerHTML = '<span class="text-red-400 text-sm">هذه الآية قصيرة جداً ولا يمكن تقسيمها</span>';
                helpText.classList.add('hidden');
                audioContainer.classList.add('hidden');
                return;
            }
            
            if (fontName !== 'Amiri') {
                const styleId = `font-style-${fontName}`;
                if (!document.getElementById(styleId)) {
                    const style = document.createElement('style');
                    style.id = styleId;
                    style.textContent = `@font-face { font-family: '${fontName}'; src: url('${fontUrl}') format('woff2'); font-display: swap; }`;
                    document.head.appendChild(style);
                }
            }
            container.style.fontFamily = `"${fontName}", "AlMushaf", "Amiri", sans-serif`;

            helpText.classList.remove('hidden');
            displayWords.forEach((word, idx) => {
                // منع ظهور الكلمة الأخيرة من النص الأصلي طالما أنه لا يمكن القص عندها
                if (idx >= uthmaniWords.length - 1) return;

                const btn = document.createElement('button');
                btn.className = 'px-3 py-1 hover:bg-[#007AFF] hover:text-white rounded-lg transition-all cursor-pointer border border-transparent hover:border-[#007AFF] hover:shadow-md';
                btn.style.fontFamily = 'inherit';
                btn.textContent = word;
                
                btn.onclick = () => { 
                    showSplitConfirmModal(word, container.style.fontFamily, () => {
                        audioPlayer.pause();
                        performSplit(ayahIndex, idx, audioPlayer.currentTime, audioPlayer.duration);
                    });
                };
                container.appendChild(btn);
            });
        }

        function showSplitConfirmModal(word, fontFamily, onConfirm) {
            let modal = document.getElementById('splitConfirmModal');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'splitConfirmModal';
                modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm z-[10000] hidden flex items-center justify-center p-4 opacity-0 transition-all duration-300';
                modal.innerHTML = `
                    <div class="bg-[var(--panel-bg)] border border-[var(--border-color)] rounded-2xl w-full max-w-sm flex flex-col overflow-hidden shadow-2xl transform scale-95 transition-all duration-300" id="splitConfirmCard">
                        <div class="p-6 text-center">
                            <div class="w-16 h-16 bg-[#007AFF]/10 rounded-full flex items-center justify-center mx-auto mb-4">
                                <i data-lucide="scissors" class="w-8 h-8 text-[#007AFF]"></i>
                            </div>
                            <h3 class="text-lg font-bold text-[var(--text-main)] mb-2">تأكيد التقسيم</h3>
                            <p class="text-sm text-zinc-400 leading-relaxed">هل أنت متأكد من تقسيم الآية عند كلمة:<br><span id="splitConfirmWord" class="text-4xl font-normal text-[#007AFF] mt-4 mb-2 block leading-relaxed"></span></p>
                        </div>
                        <div class="flex border-t border-[var(--border-color)]">
                            <button id="splitConfirmCancel" class="flex-1 py-4 text-sm font-bold text-zinc-400 hover:text-[var(--text-main)] hover:bg-white/5 transition-colors border-l border-[var(--border-color)]">إلغاء</button>
                            <button id="splitConfirmOk" class="flex-1 py-4 text-sm font-bold text-[#007AFF] hover:bg-[#007AFF]/10 transition-colors">تقسيم</button>
                        </div>
                    </div>
                `;
                document.body.appendChild(modal);
            }
            
            document.getElementById('splitConfirmWord').textContent = word;
            document.getElementById('splitConfirmWord').style.fontFamily = fontFamily;
            
            const card = document.getElementById('splitConfirmCard');
            
            const close = () => {
                modal.style.opacity = '0';
                card.style.transform = 'scale(0.95)';
                setTimeout(() => modal.classList.add('hidden'), 300);
            };

            document.getElementById('splitConfirmCancel').onclick = close;
            document.getElementById('splitConfirmOk').onclick = () => {
                close();
                onConfirm();
            };

            modal.classList.remove('hidden');
            // إجبار المتصفح على رسم العنصر قبل تفعيل تأثير الظهور
            void modal.offsetWidth;
            modal.style.opacity = '1';
            card.style.transform = 'scale(1)';
            if (window.lucide) window.lucide.createIcons();
        }

        function populateSplitModalSelect(selectedIdx = -1) {
            const select = document.getElementById('splitAyahSelect');
            if (!select) return;
            select.innerHTML = '';
            const startIdx = getAyahIndexByRealNumber(parseInt(UI.vStart.value) || 1, false);
            const endIdx = getAyahIndexByRealNumber(parseInt(UI.vEnd.value) || getRealVerseCount(), true);
            const currentPartMap = {};
            let idxToSelect = selectedIdx !== -1 ? selectedIdx : state.currentAyahIndex;
            let hasSelected = false;
            
            const fragment = document.createDocumentFragment();
            for (let i = startIdx; i < endIdx; i++) {
                if (state.ayahs[i]) {
                    const vk = state.ayahs[i].verse_key;
                    const ayahNum = vk ? vk.split(':')[1] : (i + 1);
                    let partStr = '';
                    if (state.ayahs[i].isSplit) {
                        currentPartMap[vk] = (currentPartMap[vk] || 0) + 1;
                        partStr = ` (جزء ${currentPartMap[vk]})`;
                    }
                    const opt = document.createElement('option');
                    opt.value = i; opt.textContent = `الآية ${ayahNum}${partStr}: ${state.ayahs[i].text_uthmani.substring(0, 30)}...`;
                    if (i === idxToSelect) { opt.selected = true; hasSelected = true; }
                    fragment.appendChild(opt);
                }
            }
            select.appendChild(fragment);
            if (!hasSelected && select.options.length > 0) select.options[0].selected = true;
            
            if (select.options.length > 0) {
                const idx = parseInt(select.value);
                renderSplitWords(idx);
                const ayah = state.ayahs[idx];
                const undoBtn = document.getElementById('undoSplitBtn');
                if (undoBtn) { if (ayah && ayah.isSplit) undoBtn.classList.remove('hidden'); else undoBtn.classList.add('hidden'); }
            } else {
                document.getElementById('splitWordsContainer').innerHTML = '<span class="text-zinc-500">لا يوجد آيات في النطاق المحدد</span>';
                const undoBtn = document.getElementById('undoSplitBtn');
                if (undoBtn) undoBtn.classList.add('hidden');
                document.getElementById('splitAudioContainer').classList.add('hidden');
            }
        }

        async function performSplit(ayahIndex, wordIndex, customCurrentTime = 0, customDuration = 0) {
            UI.loader.classList.remove('hidden');
            const ayah = state.ayahs[ayahIndex];
            const words = ayah.text_uthmani.split(' ');
            if (wordIndex >= words.length - 1) { UI.loader.classList.add('hidden'); return; }
            
            const part1Text = words.slice(0, wordIndex + 1).join(' ');
            const part2Text = words.slice(wordIndex + 1).join(' ');
            const codeV1Words = ayah.code_v1 ? ayah.code_v1.split(' ') : [];
            const codeV2Words = ayah.code_v2 ? ayah.code_v2.split(' ') : [];
            
            let baseOffset = ayah.splitStartRatio || 0;
            let baseDur = ayah.splitDurationRatio || 1;
            let textRatio = part1Text.length / ayah.text_uthmani.length;
            
            // 💡 قص الترجمة بذكاء بناءً على نسبة النص المقطوع
            const transWords = ayah.translation ? ayah.translation.split(' ') : [];
            const transSplitIndex = Math.round(transWords.length * textRatio);
            const part1Trans = transWords.slice(0, transSplitIndex).join(' ').trim();
            const part2Trans = transWords.slice(transSplitIndex).join(' ').trim();

            // 💡 التوزيع النسبي الذكي: نؤخر نقطة الانتقال حسابياً لأن الكلمات بالبداية أطول بالتلاوة
            let splitRatio = Math.pow(textRatio, 0.85);
            
            let p1Dur = baseDur * splitRatio;
            let p2Dur = baseDur * (1 - splitRatio);
            let p2Off = baseOffset + p1Dur;

            // 💡 المزامنة الدقيقة باستخدام توقيت المشغل الصوتي الذي اختاره المستخدم
            if (customCurrentTime > 0 && customDuration > 0 && customCurrentTime < customDuration) {
                // إضافة 150 ملي ثانية لتعويض وقت السكوت ورد فعل المستخدم (إلا إذا تجاوزت النهاية)
                const adjustedTime = Math.min(customCurrentTime + 0.15, customDuration - 0.05);
                const globalRatio = adjustedTime / customDuration;

                // حماية لضمان عدم جعل مدة أي جزء قصيرة جداً (هامش 2%)
                if (globalRatio > 0.02 && globalRatio < 0.98) {
                    splitRatio = globalRatio;
                    p1Dur = baseDur * splitRatio;
                    p2Dur = baseDur * (1 - splitRatio);
                    p2Off = baseOffset + p1Dur;
                }
            }

            const part1 = { ...ayah, id: ayah.id + '_p1', text_uthmani: part1Text, code_v1: codeV1Words.slice(0, wordIndex + 1).join(' '), code_v2: codeV2Words.slice(0, wordIndex + 1).join(' '), translation: part1Trans, splitStartRatio: baseOffset, splitDurationRatio: p1Dur, isSplit: true, originalAyah: ayah.originalAyah || { ...ayah } };
            const part2 = { ...ayah, id: ayah.id + '_p2', text_uthmani: part2Text, code_v1: codeV1Words.slice(wordIndex + 1).join(' '), code_v2: codeV2Words.slice(wordIndex + 1).join(' '), translation: part2Trans, splitStartRatio: p2Off, splitDurationRatio: p2Dur, isSplit: true, originalAyah: ayah.originalAyah || { ...ayah } };
            
            state.ayahs.splice(ayahIndex, 1, part1, part2);
            
            if (state.timings && state.timings.length > 0) {
                const t1 = state.timings[ayahIndex] || 0;
                let t2 = state.timings[ayahIndex + 1];
                if (t2 === undefined) t2 = t1 + (ayah.apiDuration || 5);
                state.timings.splice(ayahIndex + 1, 0, t1 + ((t2 - t1) * splitRatio));
            }
            
            UI.vEnd.max = getRealVerseCount() || 1;
            UI.vStart.max = getRealVerseCount() || 1;
            
            clearAudioCache();
            state.splitBlobCache = {};
            state.uiDirty = true;
            const player = document.getElementById('splitAudioPlayer');
            if (player && player.dataset.blobUrl) {
                URL.revokeObjectURL(player.dataset.blobUrl);
                player.dataset.blobUrl = '';
                player.src = '';
            }
            const modal = document.getElementById('splitAyahModal');
            if (modal) {
                modal.style.opacity = '0';
                const card = document.getElementById('splitAyahCard');
                if (card) card.style.transform = 'scale(0.95)';
                setTimeout(() => modal.classList.add('hidden'), 300);
            }
            UI.vEnd.dispatchEvent(new Event('change'));
            updateDurationDisplay();
            
            // 💡 الانتقال فوراً في المعاينة إلى الجزء المقصوص (الثاني) بدلاً من البقاء في البداية
            if (state.currentAyahIndex === ayahIndex) {
                state.currentAyahIndex = ayahIndex + 1;
                state.lastRenderPayload = null;
            }
            UI.loader.classList.add('hidden');
        }

        let currentUpdateContentId = 0;
        async function updateContent(resetVerseRange = false) {
            currentUpdateContentId++;
            const updateId = currentUpdateContentId;
            UI.loader.classList.remove('hidden');
            stopAudio();
            if (resetVerseRange) UI.vStart.value = 1;
            clearAudioCache(); // تفريغ الكاش الصوتي تماماً لمنع تسريب الذاكرة وتداخل الأصوات
            state.splitBlobCache = {}; // تفريغ كاش المقاطع المقصوصة عند تغيير السورة أو القارئ
            try {
                if (!state.selectedTranslation || !isNaN(state.selectedTranslation)) {
                    state.selectedTranslation = 'english';
                }

                const textKey = `text_ar_${state.selectedSurah}`;
                let textData = await getCache(textKey);
                if (!textData) {
                    const textRes = await fetch(`https://api.quran.com/api/v4/verses/by_chapter/${state.selectedSurah}?language=ar&fields=text_uthmani,page_number,code_v1,code_v2&per_page=300`, { cache: 'force-cache' });
                    textData = await textRes.json();
                    await setCache(textKey, textData);
                }
                if (updateId !== currentUpdateContentId) return; // التوقف إذا كان هناك استدعاء أحدث

                const transKey = `trans_file_${state.selectedTranslation}`;
                let transData = await getCache(transKey);
                if (!transData) {
                    try {
                        const transRes = await fetch(`data/translation/${state.selectedTranslation}.json`, { cache: 'force-cache' });
                        transData = await transRes.json();
                        await setCache(transKey, transData);
                    } catch(e) {
                        console.error("Failed to load local translation file", e);
                        transData = [];
                    }
                }
                if (updateId !== currentUpdateContentId) return; // التوقف إذا كان هناك استدعاء أحدث

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
                                                                            else if (state.selectedReciter === 117) baseUrl = "https://everyayah.com/data/Fares_Abbad_64kbps/";

                                    audioFiles = textData.verses.map(v => {
                                        const [s, a] = v.verse_key.split(':');
                                        return { verse_key: v.verse_key, url: `${baseUrl}${s.padStart(3, '0')}${a.padStart(3, '0')}.mp3` };
                                    });
                } else {
                    const audioKey = `audio_${state.selectedReciter}_${state.selectedSurah}`;
                    let audioData = await getCache(audioKey);
                    if (!audioData) {
                        const audioRes = await fetch(`https://api.quran.com/api/v4/recitations/${state.selectedReciter}/by_chapter/${state.selectedSurah}?per_page=300`, { cache: 'force-cache' });
                        audioData = await audioRes.json();
                        await setCache(audioKey, audioData);
                    }
                    if (updateId !== currentUpdateContentId) return; // التوقف إذا كان هناك استدعاء أحدث
                    audioFiles = audioData.audio_files;
                }

                const preconnectedOrigins = new Set();
                state.ayahs = textData.verses.map((v, index) => {
                    const af = audioFiles.find(f => f.verse_key === v.verse_key);
                    let finalUrl = null;
                    let apiDur = 0;
                    if (af && af.url) {
                        if (af.url.startsWith('http')) finalUrl = af.url;
                        else if (af.url.startsWith('//')) finalUrl = `https:${af.url}`;
                            else { const cleanPath = af.url.startsWith('/') ? af.url.slice(1) : af.url; finalUrl = `https://verses.quran.com/${cleanPath}`; }
                        if (af.duration) apiDur = parseFloat(af.duration);
                        
                        // إضافة Preconnect لتسريع جلب الملفات الصوتية (Network Latency Optimization)
                        try {
                            const origin = new URL(finalUrl).origin;
                            if (!preconnectedOrigins.has(origin)) {
                                preconnectedOrigins.add(origin);
                                if (!document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) {
                                    const link = document.createElement('link');
                                    link.rel = 'preconnect'; link.href = origin; link.crossOrigin = 'anonymous';
                                    document.head.appendChild(link);
                                    
                                    const dns = document.createElement('link');
                                    dns.rel = 'dns-prefetch'; dns.href = origin;
                                    document.head.appendChild(dns);
                                }
                            }
                        } catch(e) {}
                    }
                    
                    let transText = "";
                    const ayahId = index + 1;
                    const transItem = surahTranslations.find(t => t.id == ayahId) || surahTranslations[index];
                    if (transItem && transItem.translation) {
                        transText = transItem.translation;
                    } else if (typeof transItem === 'string') {
                        transText = transItem;
                    }
                    
                    const cleanTranslation = decodeHTMLEntities(transText.replace(/<[^>]*>?/gm, '').trim());
                    const cleanTextUthmani = decodeHTMLEntities(v.text_uthmani);

                    return { ...v, text_uthmani: cleanTextUthmani, audioUrl: finalUrl, apiDuration: apiDur, translation: cleanTranslation };
                });

                const totalReal = getRealVerseCount() || 1;
                const currentEnd = parseInt(UI.vEnd.value);
                // ضبط نهاية النطاق إذا كان غير صالح أو عند طلب إعادة التعيين
                if (resetVerseRange || isNaN(currentEnd) || currentEnd > totalReal) UI.vEnd.value = totalReal;

                UI.vStart.max = totalReal;
                UI.vStart.min = 1;
                UI.vEnd.max = totalReal;
                UI.vEnd.min = 1;

                // تصحيح البداية إذا كانت خارج حدود السورة الحالية (يمنع اختفاء النص عند التحديث)
                const currentStart = parseInt(UI.vStart.value);
                if (isNaN(currentStart) || currentStart > totalReal) UI.vStart.value = 1;

                state.currentAyahIndex = getAyahIndexByRealNumber(parseInt(UI.vStart.value) || 1, false);
                if (window.location.search.includes("surah")) {
                    updateSurahNavigation();
                }
                updateDurationDisplay();
                
                // إجبار المعاينة على التحديث فوراً لتظهر الآية الأولى بمجرد تغيير السورة
                state.lastRenderedAyah = -1; // لإعادة تشغيل تأثير الظهور بنعومة
                state.lastRenderPayload = null;
                state.uiDirty = true;
            } catch (e) { console.error("API Error:", e); } finally { 
                if (updateId === currentUpdateContentId) {
                    UI.loader.classList.add('hidden'); 
                }
            }
        }

        function toggleTheme() {
            state.isLightMode = !state.isLightMode;
            document.body.classList.toggle('dark-mode', !state.isLightMode);
            
            const iconName = state.isLightMode ? 'moon' : 'sun';
            
            if (UI.themeToggle) {
                UI.themeToggle.textContent = '';
                const icon = document.createElement('i');
                icon.setAttribute('data-lucide', iconName);
                icon.className = "w-5 h-5 block";
                UI.themeToggle.appendChild(icon);
            }
            
            const lpThemeToggle = document.getElementById('lpThemeToggle');
            if (lpThemeToggle) {
                lpThemeToggle.textContent = '';
                const icon2 = document.createElement('i');
                icon2.setAttribute('data-lucide', iconName);
                icon2.className = "w-5 h-5 block";
                lpThemeToggle.appendChild(icon2);
            }
            
            if (window.lucide) window.lucide.createIcons();
        }

        let isGlobalDropdownListenerAttached = false;

        function attachGlobalDropdownListener() {
            if (isGlobalDropdownListenerAttached) return;
            document.addEventListener('click', (e) => {
                const wrapper = e.target.closest('.custom-select-wrapper');
                if (!wrapper) {
                    document.querySelectorAll('.custom-select-wrapper.open').forEach(w => w.classList.remove('open'));
                } else {
                    document.querySelectorAll('.custom-select-wrapper.open').forEach(w => {
                        if (w !== wrapper) w.classList.remove('open');
                    });
                }
            });
            isGlobalDropdownListenerAttached = true;
        }

        function createCustomDropdown(selectElement) {
            if (!selectElement) return;

            attachGlobalDropdownListener();

            const wrapper = document.createElement('div');
            wrapper.className = 'custom-select-wrapper';
            selectElement.parentNode.insertBefore(wrapper, selectElement);
            wrapper.appendChild(selectElement);
            selectElement.style.display = 'none';

            const trigger = document.createElement('button');
            trigger.className = 'custom-select-trigger';
            trigger.textContent = '';
            const ts = document.createElement('span');
            const ti = document.createElement('i');
            ti.setAttribute('data-lucide', 'chevron-down'); ti.className = "w-4 h-4 transition-transform duration-300";
            trigger.appendChild(ts); trigger.appendChild(ti);
            wrapper.appendChild(trigger);

            const optionsContainer = document.createElement('div');
            optionsContainer.className = 'custom-select-options custom-scroll';
            wrapper.appendChild(optionsContainer);

            const triggerSpan = trigger.querySelector('span');

            const populateOptions = () => {
                optionsContainer.textContent = '';
                const options = Array.from(selectElement.options);
                const frag = document.createDocumentFragment();
                options.forEach((option, index) => {
                    const optionEl = document.createElement('div');
                    optionEl.className = 'custom-select-option';
                    
                    let isFontDropdown = selectElement.id === 'fontVersion';
                    let displayText = option.textContent;
                    
                    if (isFontDropdown) {
                        if (option.value === 'v1') {
                            displayText = 'العثماني الكلاسيكي';
                        } else if (option.value === 'v2') {
                            displayText = 'العثماني الحديث';
                        } else {
                            displayText = 'وَرَتِّلِ الْقُرْآنَ تَرْتِيلًا';
                            optionEl.style.fontSize = '20px';
                        }
                        optionEl.dir = 'rtl';
                        
                        let fontName = '';
                        let fontUrl = '';
                        if (option.value === 'mushaf') {
                            fontName = 'AlMushaf';
                            fontUrl = 'https://cdn.jsdelivr.net/gh/zyadabdelbaqi/tarteel-assets@main/fonts/AlMushaf/AlMushaf.woff2';
                        } else if (option.value === 'pt_bold') {
                            fontName = 'PT Bold Heading';
                            fontUrl = 'https://cdn.jsdelivr.net/gh/zyadabdelbaqi/tarteel-assets@main/fonts/PT%20Bold%20Heading/PT%20Bold%20Heading.woff2';
                        }
                        
                        if (fontName) {
                            optionEl.style.fontFamily = `"${fontName}", "AlMushaf", "Amiri", sans-serif`;
                            const styleId = `font-style-${fontName.replace(/\s/g, '')}`;
                            if (!document.getElementById(styleId)) {
                                const style = document.createElement('style');
                                style.id = styleId;
                                style.textContent = `@font-face { font-family: '${fontName}'; src: url('${fontUrl}') format('woff2'); font-display: swap; }`;
                                document.head.appendChild(style);
                            }
                        }
                    }
                    
                    optionEl.textContent = displayText;
                    optionEl.dataset.value = option.value;
                    if (option.selected) {
                        optionEl.classList.add('selected');
                        triggerSpan.textContent = displayText;
                        if (isFontDropdown) {
                            triggerSpan.style.fontFamily = optionEl.style.fontFamily;
                            triggerSpan.style.fontSize = optionEl.style.fontSize;
                            triggerSpan.dir = 'rtl';
                        } else {
                            triggerSpan.style.fontFamily = '';
                            triggerSpan.style.fontSize = '';
                            triggerSpan.dir = '';
                        }
                    }
                    optionEl.addEventListener('click', () => {
                        selectElement.value = option.value;
                        triggerSpan.textContent = displayText;
                        if (isFontDropdown) {
                            triggerSpan.style.fontFamily = optionEl.style.fontFamily;
                            triggerSpan.style.fontSize = optionEl.style.fontSize;
                            triggerSpan.dir = 'rtl';
                        } else {
                            triggerSpan.style.fontFamily = '';
                            triggerSpan.style.fontSize = '';
                            triggerSpan.dir = '';
                        }
                        wrapper.classList.remove('open');
                        // Manually trigger change event for frameworks
                        const event = new Event('change', { bubbles: true });
                        selectElement.dispatchEvent(event);
                        // Re-populate to update selected state
                        populateOptions();
                    });
                    frag.appendChild(optionEl);
                });
                optionsContainer.appendChild(frag);
                // تم إزالة lucide.createIcons() من هنا لتجنب التجميد (O(N) DOM freeze) عند التحديث
            };

            trigger.addEventListener('click', (e) => {
                e.preventDefault();
                wrapper.classList.toggle('open');
            });

            // Use a MutationObserver to detect when new options are added to the original select
            const observer = new MutationObserver((mutations) => {
                for(const mutation of mutations) {
                    if (mutation.type === 'childList') {
                        populateOptions();
                        break;
                    }
                }
            });
            observer.observe(selectElement, { childList: true });

            // 🧠 إضافة Lifecycle Method لتنظيف الذاكرة (Destroy)
            selectElement.destroyCustomDropdown = () => {
                observer.disconnect(); // إيقاف الـ Observer لمنع تسريب الذاكرة
                if (wrapper.parentNode) {
                    wrapper.parentNode.insertBefore(selectElement, wrapper);
                    wrapper.remove(); // إزالة العناصر الوهمية
                }
                selectElement.style.display = ''; // إرجاع العنصر الأصلي لحالته
                delete selectElement.destroyCustomDropdown; // تنظيف الدالة نفسها
            };

            populateOptions(); // Initial population
            if (window.lucide) {
                window.lucide.createIcons({ root: wrapper });
            }
        }

        function setupSteps() {
            const buttons = document.querySelectorAll('[data-step]');
            const steps = document.querySelectorAll('.step');

            buttons.forEach(btn => {
                btn.addEventListener('click', () => {
                    const target = btn.dataset.step;

                    // active button
                    buttons.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');

                    // show step
                    steps.forEach(step => {
                        if (step.id === 'step-' + target) {
                            step.classList.add('active');
                        } else {
                            step.classList.remove('active');
                        }
                    });

                    // save last step
                    localStorage.setItem('lastStep', target);
                });
            });

            // restore
            const last = localStorage.getItem('lastStep');
            if (last) {
                const lastBtn = document.querySelector(`[data-step="${last}"]`);
                if (lastBtn) lastBtn.click();
            }
        }

        function setupEvents() {
            // استقبال حدث تعطل الكاش وتنبيه المستخدم
            window.addEventListener('cache:unavailable', () => {
                const toast = document.createElement('div');
                toast.className = 'fixed bottom-4 left-1/2 transform -translate-x-1/2 bg-amber-500 text-white px-4 py-2 rounded-xl shadow-xl text-sm z-[9999] flex items-center gap-2 font-medium';
                toast.dir = 'rtl';
                toast.innerHTML = '<i data-lucide="alert-triangle" class="w-4 h-4"></i> <span>وضع التصفح الخفي: قد يكون الأداء أبطأ ولن تُحفظ الملفات بعد التحديث.</span>';
                document.body.appendChild(toast);
                if (window.lucide) window.lucide.createIcons();
                setTimeout(() => {
                    toast.style.transition = 'opacity 0.5s ease';
                    toast.style.opacity = '0';
                    setTimeout(() => toast.remove(), 500);
                }, 6000);
            }, { once: true });

            setupSteps();
            
            // وضع الزر مباشرة أسفل صف تحديد الآيات ليكون مكانه ثابتاً ومنطقياً
            let verseRow = UI.vEnd ? UI.vEnd.parentElement.parentElement : null;
            
            if (verseRow && !document.getElementById('openSplitModalBtn')) {
                const splitBtn = document.createElement('button');
                splitBtn.id = 'openSplitModalBtn';
                // تصميم يتماشى مع باقي أزرار وحقول الموقع وتوحيد نوع الخط
                splitBtn.className = 'w-full mt-3 bg-[var(--input-bg)] hover:bg-[#007AFF]/5 text-[var(--text-muted)] hover:text-[#007AFF] font-normal py-2.5 px-4 rounded-xl transition-all flex items-center justify-center gap-2 text-sm border border-[var(--border-color)] hover:border-[#007AFF]/50 cursor-pointer shadow-sm';
                splitBtn.style.fontFamily = '"Noto Sans Arabic", sans-serif';
                const isPro = !getUserCapabilities().isFree;
                splitBtn.innerHTML = `<i data-lucide="scissors" class="w-4 h-4"></i> <span>تقسيم آية طـويلة</span> <span class="pro-badge px-1.5 py-0.5 bg-gradient-to-r from-orange-500 to-pink-500 text-white text-[9px] font-bold rounded-md shadow-sm ${isPro ? 'hidden' : ''}">PRO</span>`;
                
                verseRow.parentNode.insertBefore(splitBtn, verseRow.nextSibling);
                
                splitBtn.onclick = () => {
                    const caps = getUserCapabilities();
                    if (!caps.canSplitVerses) {
                        UI.proFeatureMsg.innerText = "ميزة تقسيم الآيات الطويلة متاحة فقط في النسخة الاحترافية.";
                        UI.proFeatureModal.style.display = 'flex';
                        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
                        return;
                    }

                    createSplitModal();
                    populateSplitModalSelect();
                    const modal = document.getElementById('splitAyahModal');
                    const card = document.getElementById('splitAyahCard');
                    modal.classList.remove('hidden');
                    void modal.offsetWidth;
                    modal.style.opacity = '1';
                    if (card) card.style.transform = 'scale(1)';
                    if (window.lucide) window.lucide.createIcons();
                };
            }

        // تفعيل التحديث التلقائي للواجهة (Dirty Flag) لمنع بناء البيانات المعقدة إلا عند الحاجة
        document.addEventListener('input', () => { state.uiDirty = true; }, true);
        document.addEventListener('change', () => { state.uiDirty = true; }, true);
        document.addEventListener('click', () => { state.uiDirty = true; }, true);

        // ربط الروابط العلوية بالأقسام أثناء التمرير (Active Link)
        const lp = document.getElementById('landingPage');
        if (lp) {
            const sections = lp.querySelectorAll('section[id]');
            const navLinks = document.querySelectorAll('header nav a[href^="#"]');
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const id = entry.target.getAttribute('id');
                        navLinks.forEach(link => {
                            link.classList.remove('active-link');
                            if (link.getAttribute('href') === `#${id}`) {
                                link.classList.add('active-link');
                            }
                        });
                    }
                });
            }, { root: lp, threshold: 0.3 });
            sections.forEach(sec => observer.observe(sec));
        }

            createCustomDropdown(UI.surah);
            // Note: Custom dropdowns update the original select, triggering 'change', so History works automatically.
            createCustomDropdown(UI.canvasSize);
            
            if (!Array.from(UI.fontVersion.options).some(opt => opt.value === 'pt_bold')) {
                const opt = document.createElement('option');
                opt.value = 'pt_bold';
                opt.textContent = 'PT Bold Heading';
                UI.fontVersion.appendChild(opt);
            }
            
            createCustomDropdown(UI.fontVersion);
            createCustomDropdown(UI.translationSelect);
            createCustomDropdown(UI.animType);
            createTemplateSelector(); // إضافة محدد القوالب
            // إنشاء أزرار اختيار صيغة التصدير ديناميكياً إذا لم تكن موجودة
            if (!document.getElementById('exportFormatContainer') && UI.startExportBtn) {
                const formatContainer = document.createElement('div');
                formatContainer.id = 'exportFormatContainer';
                formatContainer.className = 'w-full max-w-xs mx-auto my-4';
            
            const isMobileDevice = window.innerWidth < 768; // تعديل لإظهار الخيارات على التابلت

            // تعيين الإعدادات الافتراضية
            state.exportFormat = state.exportFormat || 'mp4';
            state.exportQuality = state.exportQuality || '720p';
            state.exportFPS = state.exportFPS || 30;

            const resLabel = document.createElement('label');
            resLabel.className = 'block text-sm font-medium text-zinc-400 mb-2 text-center';
            resLabel.textContent = 'جودة الفيديو (Resolution)';
            formatContainer.appendChild(resLabel);

            const resDiv = document.createElement('div');
            resDiv.className = 'tab-container'; resDiv.style.marginBottom = '12px'; resDiv.style.flexWrap = 'wrap'; resDiv.style.gap = '4px';
            ['480p', '720p', '1080p', '4K'].forEach(q => {
                const btn = document.createElement('div');
                btn.id = 'btnExport' + (q === '4K' ? '4K' : q.replace('p',''));
                btn.className = 'tab-btn' + (state.exportQuality === q.toLowerCase() ? ' active' : '');
                btn.textContent = q; resDiv.appendChild(btn);
            });
            formatContainer.appendChild(resDiv);

            const fpsLabel = document.createElement('label');
            fpsLabel.className = 'block text-sm font-medium text-zinc-400 mb-2 text-center';
            fpsLabel.textContent = 'معدل الإطارات (FPS)';
            formatContainer.appendChild(fpsLabel);

            const fpsDiv = document.createElement('div');
            fpsDiv.className = 'tab-container'; fpsDiv.style.marginBottom = '12px';
            [24, 30, 60].forEach(f => {
                const btn = document.createElement('div');
                btn.id = 'btnExport' + f + 'FPS'; btn.className = 'tab-btn' + (state.exportFPS === f ? ' active' : '');
                btn.textContent = f + ' FPS'; fpsDiv.appendChild(btn);
            });
            formatContainer.appendChild(fpsDiv);

            const engineLabel = document.createElement('label');
            engineLabel.className = 'block text-sm font-medium text-zinc-400 mb-2 text-center mt-2';
            engineLabel.textContent = 'نوع التصدير';
            formatContainer.appendChild(engineLabel);

            const engineDiv = document.createElement('div');
            engineDiv.className = 'tab-container'; engineDiv.style.marginBottom = '12px';
            
            const btnFfmpeg = document.createElement('div');
            btnFfmpeg.id = 'btnExportFfmpeg';
            btnFfmpeg.className = 'tab-btn' + (!state.fastExport ? ' active' : '');
            btnFfmpeg.textContent = 'قياسي';
            
            const btnFast = document.createElement('div');
            btnFast.id = 'btnExportFast';
            btnFast.className = 'tab-btn' + (state.fastExport ? ' active' : '');
            btnFast.textContent = 'سريع';

            engineDiv.appendChild(btnFfmpeg);
            engineDiv.appendChild(btnFast);
            formatContainer.appendChild(engineDiv);

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
            
            if (btnFfmpeg) btnFfmpeg.onclick = () => {
                state.fastExport = false;
                state.webCodecsFallbackLevel = 0;
                btnFfmpeg.classList.add('active');
                if (btnFast) btnFast.classList.remove('active');
            };
            
            if (btnFast) btnFast.onclick = () => {
                state.fastExport = true;
                state.webCodecsFallbackLevel = 0;
                btnFast.classList.add('active');
                if (btnFfmpeg) btnFfmpeg.classList.remove('active');
            };
            }

            document.addEventListener('keydown', (e) => {
        if (isExporting() || UI.limitModal.style.display === 'flex' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;
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
                        const startIdx = getAyahIndexByRealNumber(parseInt(UI.vStart.value) || 1, false);
                        const caps = getUserCapabilities();
                        
                        let uniqueCount = new Set();
                        for(let i = startIdx; i <= state.currentAyahIndex + 1; i++) {
                            if (state.ayahs[i] && state.ayahs[i].verse_key) uniqueCount.add(state.ayahs[i].verse_key);
                            else uniqueCount.add(i);
                        }
                        
                        if (caps.isFree && uniqueCount.size > caps.exportLimit) { UI.limitModal.style.display = 'flex'; if (state.isPlaying) stopAudio(); return; }
                        const wasPlaying = state.isPlaying; stopAudio(); state.currentAyahIndex++;
                        if (wasPlaying) { state.isPlaying = true; playSeamless(state.currentAyahIndex); } else { const ayah = state.ayahs[state.currentAyahIndex]; if (ayah) ensureFontLoaded(ayah.page_number, UI.fontVersion.value, state.selectedSurah); }
                    }
                } else if (e.code === 'ArrowLeft') {
                    e.preventDefault();
                    if (state.isSyncing) {
                        const undoBtn = UI.undoSyncBtn;
                        if (undoBtn && !undoBtn.classList.contains('hidden')) undoBtn.click();
                        return;
                    }
                    if (state.currentAyahIndex - 1 >= 0) {
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
                UI.logoutBtn.textContent = 'جاري تسجيل الخروج...';
                UI.logoutBtn.style.opacity = '0.7';
                UI.logoutBtn.style.pointerEvents = 'none';
                try {
                await Promise.race([supabaseClient.auth.signOut(), new Promise(r => setTimeout(r, 2000))]);
                } catch (e) { console.error(e); } finally {
                    Object.keys(localStorage).forEach(k => { if(k.startsWith('sb-')) localStorage.removeItem(k); });
                    localStorage.removeItem('device_session_id');
                    localStorage.removeItem('device_session_ver');
                    window.location.reload();
                }
            };
            UI.themeToggle.onclick = toggleTheme;
        const lpThemeToggle = document.getElementById('lpThemeToggle');
        if (lpThemeToggle) lpThemeToggle.onclick = toggleTheme;

        // التحكم في زر الدفع الخاص بـ PayPal لمنع الدفع لغير المسجلين
        const paypalForms = document.querySelectorAll('.paypal-form');
        paypalForms.forEach(form => {
            form.addEventListener('submit', (e) => {
                if (!state.user) {
                    e.preventDefault(); // إيقاف التحويل لصفحة الدفع
                    if (UI.authScreen) UI.authScreen.classList.remove('hidden');
                }
            });
        });

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
            UI.tabLocal.onclick = async (e) => {
                const caps = getUserCapabilities();
                if (!caps.canUploadAudio) {
                    if (e) e.preventDefault();
                    UI.proFeatureMsg.innerText = "استخدم صوتك الخاص مع الآيات بالترقية للنسخة الاحترافية.";
                    UI.proFeatureModal.style.display = 'flex';
                    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
                    
                    // إعادة الواجهة صراحة إلى وضع الأونلاين لمنع اختفاء الأزرار وتحديث الحالة
                    UI.tabOnline.classList.add('active'); 
                    UI.tabLocal.classList.remove('active');
                    UI.localAudioControls.classList.add('hidden');
                    UI.onlineReciterSearch.classList.remove('hidden'); 
                    UI.reciters.classList.remove('hidden');
                    state.audioMode = 'online';
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
            const finalFile = file;

                // UI Loading State
                const btnLabel = e.target.parentElement.querySelector('span');
                const originalText = "اختر ملف صوتي (MP3/WAV)";
                btnLabel.textContent = "جاري التهيئة...";
                e.target.parentElement.style.opacity = "0.6";
                e.target.parentElement.style.pointerEvents = "none";

                const resetUI = () => {
                    btnLabel.textContent = originalText;
                    e.target.parentElement.style.opacity = "1";
                    e.target.parentElement.style.pointerEvents = "auto";
                    e.target.value = "";
                    updateExportButtonState();
                };

                // دالة المعالجة المحلية (الخطة البديلة)
                const processLocally = async () => {
                    try {
                        UI.localFileName.textContent = finalFile.name.length > 20 ? finalFile.name.substring(0, 20) + '...' : finalFile.name;

                        state.originalAudioBuffer = null;
                        state.isTrimmed = false;

                            btnLabel.textContent = "جاري المعالجة محلياً...";
                            try {
                                const arrayBuffer = await finalFile.arrayBuffer();
                                state.localAudioBuffer = await new Promise((resolve, reject) => {
                                    state.audioContext.decodeAudioData(arrayBuffer, resolve, reject);
                                });
                                state.useAudioElement = false;
                            } catch (e) {
                                console.warn("Failed to decode audio, using fallback", e);
                                state.localAudioBuffer = null;
                                state.useAudioElement = true;
                            }
                            state.localAudioFile = finalFile; // تخزين الملف أيضاً للاحتياط
                            const localUrl = URL.createObjectURL(finalFile);
                            UI.localAudioPlayer.src = localUrl;
                            
                            UI.localAudioPlayer.onloadedmetadata = () => {
                                if (window.setupAudioDuration && !state.isTrimmed) {
                                    window.setupAudioDuration(state.localAudioBuffer ? state.localAudioBuffer.duration : UI.localAudioPlayer.duration);
                                }
                            };
                            
                            if (state.localAudioBuffer && window.setupAudioDuration && !state.isTrimmed) {
                                window.setupAudioDuration(state.localAudioBuffer.duration);
                            }

                        UI.localFilePreview.classList.remove('hidden');
                        UI.syncControls.classList.remove('hidden');
                        state.hasSyncedOnce = false;
                        if (window.lucide) window.lucide.createIcons();

                        // إنشاء واجهة قص الصوت
                        let trimUI = document.getElementById('audioTrimUI');
                        if (trimUI) trimUI.remove(); // إزالة الواجهة القديمة إذا كانت موجودة لضمان عمل الأحداث بشكل سليم
                        trimUI = document.createElement('div');
                        trimUI.id = 'audioTrimUI';
                        trimUI.className = 'flex flex-col gap-2 mt-3 p-3 bg-[var(--panel-bg)] rounded-xl border border-[var(--border-color)] shadow-sm';
                        
                        const style = document.createElement('style');
                        style.textContent = `.trim-range { -webkit-appearance: none; appearance: none; background: transparent; outline: none; } .trim-range::-webkit-slider-thumb { pointer-events: auto; -webkit-appearance: none; width: 14px; height: 28px; background: white; border-radius: 6px; cursor: ew-resize; box-shadow: 0 1px 4px rgba(0,0,0,0.5); } .trim-range::-moz-range-thumb { pointer-events: auto; width: 14px; height: 28px; background: white; border-radius: 6px; cursor: ew-resize; border: none; box-shadow: 0 1px 4px rgba(0,0,0,0.5); }`;
                        trimUI.appendChild(style);

                        const labelsDiv = document.createElement('div'); labelsDiv.className = 'flex justify-between items-center text-[10px] text-zinc-400 font-bold px-1 mb-1';
                        const startLabel = document.createElement('span'); startLabel.id = 'trimStartLabel'; startLabel.className = 'bg-[#007AFF]/20 px-2 py-0.5 rounded text-[#007AFF]'; startLabel.textContent = '0.0s';
                        const centerSpan = document.createElement('span'); centerSpan.className = 'text-[#007AFF]';
                        const scIcon = document.createElement('i'); scIcon.setAttribute('data-lucide', 'scissors'); scIcon.className = 'w-3 h-3 inline-block align-middle';
                        centerSpan.appendChild(scIcon); centerSpan.appendChild(document.createTextNode(' اقتطاع جزء من الصوت'));
                        const endLabel = document.createElement('span'); endLabel.id = 'trimEndLabel'; endLabel.className = 'bg-[#007AFF]/20 px-2 py-0.5 rounded text-[#007AFF]'; endLabel.textContent = '0.0s';
                        labelsDiv.appendChild(startLabel); labelsDiv.appendChild(centerSpan); labelsDiv.appendChild(endLabel); trimUI.appendChild(labelsDiv);

                        const trackDiv = document.createElement('div'); trackDiv.className = 'relative w-full h-8 bg-[#007AFF]/10 border border-[#007AFF]/20 rounded-lg flex items-center'; trackDiv.dir = 'ltr';
                        const trimVisualTrack = document.createElement('div'); trimVisualTrack.id = 'trimVisualTrack'; trimVisualTrack.className = 'absolute h-full bg-[#007AFF]/50 border-y border-[#007AFF] rounded-md pointer-events-none'; trimVisualTrack.style.left = '0%'; trimVisualTrack.style.right = '0%';
                        const trimStart = document.createElement('input'); trimStart.type = 'range'; trimStart.id = 'trimStart'; trimStart.className = 'trim-range absolute w-full h-full pointer-events-none z-10 m-0'; trimStart.min = '0'; trimStart.value = '0'; trimStart.step = '0.1';
                        const trimEnd = document.createElement('input'); trimEnd.type = 'range'; trimEnd.id = 'trimEnd'; trimEnd.className = 'trim-range absolute w-full h-full pointer-events-none z-20 m-0'; trimEnd.min = '0'; trimEnd.step = '0.1';
                        trackDiv.appendChild(trimVisualTrack); trackDiv.appendChild(trimStart); trackDiv.appendChild(trimEnd); trimUI.appendChild(trackDiv);

                        const btnsDiv = document.createElement('div'); btnsDiv.className = 'flex gap-2 mt-2 w-full';
                        const trimPreviewBtn = document.createElement('button'); trimPreviewBtn.id = 'trimPreviewBtn'; trimPreviewBtn.className = 'w-[35%] bg-[#007AFF] hover:bg-blue-600 text-white font-bold py-2 px-2 rounded-lg text-xs transition-all flex items-center justify-center gap-1.5';
                        setBtnContent(trimPreviewBtn, 'play', 'تشغيل');
                        const trimBtn = document.createElement('button'); trimBtn.id = 'trimBtn'; trimBtn.className = 'w-[65%] bg-[#007AFF] hover:bg-blue-600 text-white font-bold py-2 px-2 rounded-lg text-xs transition-all flex items-center justify-center gap-1.5';
                        setBtnContent(trimBtn, 'check', 'تطبيق القص');
                        btnsDiv.appendChild(trimPreviewBtn); btnsDiv.appendChild(trimBtn); trimUI.appendChild(btnsDiv);
                        
                        UI.localFilePreview.appendChild(trimUI);

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

                            trimVisualTrack.style.left = startPercent + '%';
                            trimVisualTrack.style.right = endPercent + '%';

                            startLabel.textContent = s.toFixed(1) + 's';
                            endLabel.textContent = e.toFixed(1) + 's';
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
                                setBtnContent(trimPreviewBtn, 'play', 'تشغيل');
                            }
                        };

                        trimPreviewAudio.addEventListener('timeupdate', checkPreviewTime);
                        trimPreviewAudio.addEventListener('ended', checkPreviewTime);

                        trimPreviewBtn.onclick = () => {
                            if (isTrimPreviewing) {
                                trimPreviewAudio.pause();
                                isTrimPreviewing = false;
                                setBtnContent(trimPreviewBtn, 'play', 'تشغيل');
                            } else {
                                const startVal = parseFloat(trimStart.value) || 0;
                                trimPreviewAudio.currentTime = startVal;
                                trimPreviewAudio.play();
                                isTrimPreviewing = true;
                                setBtnContent(trimPreviewBtn, 'square', 'إيقاف');
                            }
                        };

                        trimBtn.onclick = async () => {
                            if (isTrimPreviewing) trimPreviewBtn.click(); // إيقاف المعاينة قبل تطبيق القص
                            const startVal = parseFloat(trimStart.value) || 0;
                            const endVal = parseFloat(trimEnd.value);
                            
                            if (!state.originalAudioBuffer) {
                                 setBtnContent(trimBtn, 'loader-2', 'جاري التهيئة...', true);
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
                                     setBtnContent(trimBtn, 'check', 'تطبيق القص');
                                     return;
                                 }
                            }

                            if (state.originalAudioBuffer) {
                                setBtnContent(trimBtn, 'loader-2', 'جاري القص...', true);
                                await new Promise(r => setTimeout(r, 50));
                                const duration = state.originalAudioBuffer.duration;
                                const start = Math.max(0, startVal);
                                const end = (endVal > 0 && endVal <= duration) ? endVal : duration;
                                if (start >= end) {
                                    alert("وقت البداية يجب أن يكون أقل من النهاية");
                                    setBtnContent(trimBtn, 'check', 'تطبيق القص');
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
                                    const wavBytes = await audioBufferToWavBytes(newBuffer);
                                    const wavBlob = new Blob([wavBytes], { type: 'audio/wav' });
                                    
                                    state.isTrimmed = true;
                                    UI.localAudioPlayer.src = URL.createObjectURL(wavBlob);
                                    
                                    state.timings = [];
                                    state.hasSyncedOnce = false;
                                    updateExportButtonState();
                                    updateDurationDisplay();
                                    setBtnContent(trimBtn, 'check-check', 'تم القص بنجاح');
                                    setTimeout(() => setBtnContent(trimBtn, 'check', 'تطبيق القص'), 2000);
                                } catch (e) {
                                    console.error("Trim error:", e);
                                    alert("حدث خطأ أثناء قص الصوت.");
                                    setBtnContent(trimBtn, 'check', 'تطبيق القص');
                                }
                            }
                        };
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
                    if (window.lucide) window.lucide.createIcons();
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
                UI.playBtn.disabled = true;
                UI.playBtn.style.opacity = "0.5";

                let undoBtn = UI.undoSyncBtn;
                if (!undoBtn) {
                    undoBtn = document.createElement('button');
                    undoBtn.id = 'undoSyncBtn';
                    undoBtn.className = 'w-full bg-[#007AFF] hover:bg-blue-600 text-white font-bold py-3 px-4 rounded-xl shadow-lg transition-all flex items-center justify-center gap-2 mt-2';
                    setBtnContent(undoBtn, 'undo-2', 'تراجع');
                    UI.syncControls.appendChild(undoBtn);
                }
                undoBtn.classList.remove('hidden');

                // Reset to start
                const startIdx = getAyahIndexByRealNumber(parseInt(UI.vStart.value) || 1, false);
                state.currentAyahIndex = startIdx;

                // تشغيل الفيديو الخلفي أثناء المزامنة أيضاً
                if (state.mediaType === 'video') state.bgVideo.play();

                // Mark first verse start
                state.timings[startIdx] = 0;

                const onSyncEnded = (duration) => {
                    if (state.isSyncing) {
                        const lastSyncedVerseNumber = state.currentAyahIndex + 1;
                        UI.vEnd.value = getRealNumberByAyahIndex(lastSyncedVerseNumber - 1);
                        state.timings[lastSyncedVerseNumber] = duration;
                    }
                    state.isSyncing = false;
                    state.isPlaying = false;
                    state.hasSyncedOnce = true;
                    UI.startSyncBtn.classList.remove('hidden');
                    UI.tapSyncBtn.classList.add('hidden');
                    UI.stopSyncBtn.classList.add('hidden');
                    if (UI.undoSyncBtn) UI.undoSyncBtn.classList.add('hidden');
                    UI.playBtn.disabled = false;
                    UI.playBtn.style.opacity = "1";
                    setBtnContent(UI.startSyncBtn, 'check', 'تم حفظ التوقيت (إعادة؟)', false, 'w-3 h-3');
                    updateExportButtonState();
                    updateDurationDisplay();
                };

                undoBtn.onclick = () => {
                    if (!state.isSyncing) return;
                    if (state.currentAyahIndex > startIdx) {
                        state.currentAyahIndex--;
                        const prevTime = state.timings[state.currentAyahIndex] || 0;
                        
                        if (state.useAudioElement) {
                            UI.localAudioPlayer.currentTime = prevTime;
                        } else {
                            if (state.activeSource) {
                                state.activeSource.onended = null;
                                try { state.activeSource.stop(); } catch(e) {}
                                try { state.activeSource.disconnect(); } catch(e) {}
                            }
                            const source = state.audioContext.createBufferSource();
                            source.buffer = state.localAudioBuffer;
                            source.connect(state.effectEntry);
                            state.activeSource = source;
                            state.startTime = state.audioContext.currentTime - prevTime;
                            source.start(0, prevTime);
                            source.onended = () => onSyncEnded(state.localAudioBuffer.duration);
                        }
                        
                        // Visual feedback
                        undoBtn.style.transform = "scale(0.95)";
                        setTimeout(() => undoBtn.style.transform = "scale(1)", 100);
                    }
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
                    source.connect(state.effectEntry);
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
                    UI.vEnd.value = getRealNumberByAyahIndex(effectiveEndIndex - 1);
                }

                // Use the global stop function to ensure audio stops
                stopAudio();

                // Manually update UI as the original onended is now bypassed by stopAudio()
                state.hasSyncedOnce = true;
                UI.startSyncBtn.classList.remove('hidden');
                UI.tapSyncBtn.classList.add('hidden');
                UI.stopSyncBtn.classList.add('hidden');
                if (UI.undoSyncBtn) UI.undoSyncBtn.classList.add('hidden');
                UI.playBtn.disabled = false;
                UI.playBtn.style.opacity = "1";
                setBtnContent(UI.startSyncBtn, 'check', 'تم حفظ التوقيت (إعادة؟)', false, 'w-3 h-3');
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
                const max = getRealVerseCount() || 1;
                if (isNaN(val) || val < 1) val = 1;
                if (val > max) val = max;
                input.value = val;
                updateDurationDisplay();
            };
            UI.vStart.onchange = () => { 
                validateVerseInput(UI.vStart); 
                state.currentAyahIndex = getAyahIndexByRealNumber(parseInt(UI.vStart.value) || 1, false); 
                state.lastRenderPayload = null; 
                state.uiDirty = true; 
            };
            UI.vEnd.onchange = () => validateVerseInput(UI.vEnd);

            UI.translationSelect.onchange = (e) => { state.selectedTranslation = e.target.value; updateContent(); };
            UI.reciterSearch.oninput = (e) => renderReciterButtons(e.target.value);
            UI.fontSize.oninput = (e) => { state.fontSize = parseInt(e.target.value); UI.fsVal.textContent = state.fontSize; };
            UI.bgBlur.oninput = (e) => { state.blur = parseInt(e.target.value); UI.bgBlurVal.textContent = state.blur + 'px'; };
            UI.bgZoom.oninput = (e) => { state.zoom = parseInt(e.target.value); UI.bgZoomVal.textContent = state.zoom + '%'; };
            UI.opacityRange.oninput = (e) => { state.overlayOpacity = parseFloat(e.target.value); UI.opacityVal.textContent = Math.round(state.overlayOpacity * 100) + '%'; };
            UI.shadowBlur.oninput = (e) => { state.shadowBlur = parseInt(e.target.value); UI.shadowBlurVal.textContent = state.shadowBlur; };
            if (UI.textY) UI.textY.oninput = (e) => { state.textY = parseInt(e.target.value); if (UI.textYVal) UI.textYVal.textContent = state.textY + '%'; };
            if (UI.textX) UI.textX.oninput = (e) => { state.textX = parseInt(e.target.value); if (UI.textXVal) UI.textXVal.textContent = state.textX + '%'; };
            UI.transShadowBlur.oninput = (e) => { UI.transShadowBlurVal.textContent = e.target.value; state.transShadowBlur = parseInt(e.target.value); };
            UI.animIntensity.oninput = (e) => { state.animIntensity = parseInt(e.target.value); UI.animIntensityVal.textContent = state.animIntensity + '%'; };
            UI.surahY.oninput = (e) => { UI.surahYVal.textContent = e.target.value + '%'; };
            UI.surahX.oninput = (e) => { UI.surahXVal.textContent = e.target.value + '%'; };
            UI.surahFontSize.oninput = (e) => { UI.surahFontSizeVal.textContent = e.target.value; };
            
            // Basmala Controls
            UI.showBasmala.onchange = (e) => { state.showBasmala = e.target.checked; };
            UI.basmalaNumber.oninput = (e) => { state.basmalaNumber = parseInt(e.target.value); UI.basmalaNumberVal.textContent = state.basmalaNumber; };
            UI.basmalaY.oninput = (e) => { state.basmalaY = parseInt(e.target.value); UI.basmalaYVal.textContent = state.basmalaY + '%'; };
            UI.basmalaX.oninput = (e) => { state.basmalaX = parseInt(e.target.value); UI.basmalaXVal.textContent = state.basmalaX + '%'; };
            UI.basmalaSize.oninput = (e) => { state.basmalaSize = parseInt(e.target.value); UI.basmalaSizeVal.textContent = state.basmalaSize; };
            UI.basmalaColor.oninput = (e) => { state.basmalaColor = e.target.value; };
            UI.basmalaShadowBlur.oninput = (e) => { state.basmalaShadowBlur = parseInt(e.target.value); UI.basmalaShadowBlurVal.textContent = state.basmalaShadowBlur; };
            UI.basmalaShadowColor.oninput = (e) => { state.basmalaShadowColor = e.target.value; };
            
            UI.waveformY.oninput = (e) => { UI.waveformYVal.textContent = e.target.value + '%'; };
            UI.waveformHeight.oninput = (e) => { UI.waveformHeightVal.textContent = e.target.value; };

            UI.showWaveform.addEventListener("change", async function (e) {
                const caps = getUserCapabilities();
                if (!caps.canShowWaveform && UI.showWaveform.checked) {
                    UI.showWaveform.checked = false;
                    const msg = document.getElementById('proFeatureMsg');
                    if (msg) msg.textContent = 'إضافة الموجات الصوتية متاحة فقط في النسخة الاحترافية. قم بالترقية للتمتع بهذه الميزة.';
                    if (UI.proFeatureModal) UI.proFeatureModal.style.display = 'flex';
                }
            });

            // Watermark Logic
            UI.showWatermark.onchange = async (e) => {
                const caps = getUserCapabilities();
                if (!caps.canShowWatermark && UI.showWatermark.checked) {
                    UI.showWatermark.checked = false;
                    const msg = document.getElementById('proFeatureMsg');
                    if (msg) msg.textContent = 'إضافة شعار مخصص متاحة فقط في النسخة الاحترافية. قم بالترقية للتمتع بهذه الميزة.';
                    if (UI.proFeatureModal) UI.proFeatureModal.style.display = 'flex';
                }
            };

            // Tarteel Logo Logic
            UI.showTarteelLogo.addEventListener('change', (e) => {
                const caps = getUserCapabilities();
                if (!caps.canRemoveBranding && !UI.showTarteelLogo.checked) {
                    UI.showTarteelLogo.checked = true;
                    const msg = document.getElementById('proFeatureMsg');
                    if (msg) msg.textContent = 'إزالة شعار Tarteel Studio متاحة فقط في النسخة الاحترافية. قم بالترقية للتمتع بهذه الميزة.';
                    if (UI.proFeatureModal) UI.proFeatureModal.style.display = 'flex';
                }
            });

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
            UI.reverbRange.oninput = (e) => { UI.reverbIntensityVal.textContent = Math.round(e.target.value * 100) + '%'; updateAudioEffectParams(); };
            
            UI.playBtn.onclick = () => { 
                if (state.isSyncing) return; 
                if (state.isPlaying) stopAudio(); 
                else { 
                    // 💡 الرجوع للآية الأولى تلقائياً إذا كانت المعاينة قد انتهت
                    const endIdx = getAyahIndexByRealNumber(parseInt(UI.vEnd.value) || getRealVerseCount(), true);
                    if (state.currentAyahIndex >= endIdx - 1) {
                        state.currentAyahIndex = getAyahIndexByRealNumber(parseInt(UI.vStart.value) || 1, false);
                        state.lastRenderPayload = null;
                        state.uiDirty = true;
                    }
                    state.isPlaying = true; 
                    playSeamless(state.currentAyahIndex); 
                } 
            };

            // 💡 تجميع أزرار التحكم (التشغيل والإعادة والتالي) في حاوية سفلية صغيرة ومرتبة
            if (!document.getElementById('previewControlsWrapper') && UI.playBtn) {
                const wrapper = document.createElement('div');
                wrapper.id = 'previewControlsWrapper';
                
                // 💡 جعل الحاوية مخفية افتراضياً مع تأثير انتقال ناعم
                wrapper.style.cssText = 'position: absolute !important; bottom: 24px !important; left: 0 !important; right: 0 !important; display: flex !important; justify-content: center !important; align-items: center !important; gap: 16px !important; z-index: 999 !important; pointer-events: none !important; width: 100% !important; margin: 0 !important; padding: 0 !important; opacity: 0 !important; transition: opacity 0.3s ease !important; transform: translateZ(0) !important; will-change: opacity !important;';
                
                // إجبار الحاوية الأصلية على احتواء الأزرار بداخلها وإظهارها عند تمرير الماوس
                const parent = UI.canvas.parentNode || UI.mockup;
                parent.style.position = 'relative';
                parent.style.overflow = 'hidden';
                
                // إظهار وإخفاء الأزرار عند مرور الماوس أو اللمس
                parent.addEventListener('mouseenter', () => { wrapper.style.setProperty('opacity', '1', 'important'); });
                parent.addEventListener('mouseleave', () => { wrapper.style.setProperty('opacity', '0', 'important'); });
                parent.addEventListener('touchstart', () => { wrapper.style.setProperty('opacity', '1', 'important'); setTimeout(() => wrapper.style.setProperty('opacity', '0', 'important'), 3000); }, { passive: true });
                
                // بلور زجاجي خفيف جداً وأنيق (Frosted Glass)
                const btnCss = 'display: flex !important; align-items: center !important; justify-content: center !important; border-radius: 50% !important; color: #ffffff !important; background-color: rgba(255, 255, 255, 0.08) !important; border: 1px solid rgba(255, 255, 255, 0.12) !important; backdrop-filter: blur(12px) !important; -webkit-backdrop-filter: blur(12px) !important; cursor: pointer !important; pointer-events: auto !important; box-shadow: 0 4px 15px rgba(0,0,0,0.15) !important; margin: 0 !important; padding: 0 !important; flex-shrink: 0 !important; transition: background-color 0.2s ease, transform 0.2s ease !important; transform: translateZ(0) !important;';
                
                UI.playBtn.className = ''; // مسح أي كلاسات قديمة
                UI.playBtn.style.cssText = btnCss + ' width: 48px !important; height: 48px !important;';
                
                // تأثير Hover زجاجي ناعم
                const addHover = (btn) => {
                    btn.addEventListener('mouseenter', () => btn.style.setProperty('background-color', 'rgba(255, 255, 255, 0.15)', 'important'));
                    btn.addEventListener('mouseleave', () => btn.style.setProperty('background-color', 'rgba(255, 255, 255, 0.08)', 'important'));
                };
                addHover(UI.playBtn);
                
                parent.appendChild(wrapper);
                wrapper.appendChild(UI.playBtn);

                const restartBtn = document.createElement('button');
                restartBtn.id = 'restartPreviewBtn';
                restartBtn.type = 'button';
                restartBtn.title = 'البدء من أول آية محددة';
                restartBtn.style.cssText = btnCss + ' width: 40px !important; height: 40px !important;';
                restartBtn.innerHTML = '<i data-lucide="skip-back" style="width: 20px; height: 20px;"></i>';
                restartBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); stopAudio(); state.currentAyahIndex = getAyahIndexByRealNumber(parseInt(UI.vStart.value) || 1, false); state.lastRenderPayload = null; state.uiDirty = true; };
                addHover(restartBtn);
                wrapper.insertBefore(restartBtn, UI.playBtn);

                const nextBtn = document.createElement('button');
                nextBtn.id = 'nextPreviewBtn';
                nextBtn.type = 'button';
                nextBtn.title = 'الآية التالية';
                nextBtn.style.cssText = btnCss + ' width: 40px !important; height: 40px !important;';
                nextBtn.innerHTML = '<i data-lucide="skip-forward" style="width: 20px; height: 20px;"></i>';
                nextBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (state.currentAyahIndex + 1 < state.ayahs.length) { const wasPlaying = state.isPlaying; stopAudio(); state.currentAyahIndex++; if (wasPlaying) { state.isPlaying = true; playSeamless(state.currentAyahIndex); } else { const ayah = state.ayahs[state.currentAyahIndex]; if (ayah) ensureFontLoaded(ayah.page_number, UI.fontVersion.value, state.selectedSurah); state.lastRenderPayload = null; state.uiDirty = true; } } };
                addHover(nextBtn);
                wrapper.appendChild(nextBtn);

                if (window.lucide) window.lucide.createIcons();
            }

            UI.actionBtn.onclick = () => {
                if (!state.user) {
                    const uiState = {};
                    for (const key in UI) {
                        try {
                            const el = UI[key];
                            if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) {
                                if (el.type === 'checkbox') uiState[key] = el.checked;
                                else if (el.type !== 'file') uiState[key] = el.value;
                            }
                        } catch (e) {
                            // تجاهل العناصر غير الموجودة برمجياً لتفادي توقف الكود
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
                UI.confirmModal.style.display = 'flex';
            };
            UI.startExportBtn.onclick = async () => {
            try {
                await secureExport();
            } catch (e) {
                if (e.message !== 'EXPORT_CANCELLED') console.error(e);
            }
        };
        UI.confirmNo.onclick = () => { UI.confirmModal.style.display = 'none'; };
        UI.confirmLimit.onclick = () => { 
            const startIdx = getAyahIndexByRealNumber(parseInt(UI.vStart.value) || 1, false);
            const caps = getUserCapabilities();
            const { end: allowedEnd } = getAllowedRange(startIdx, state.ayahs.length, caps);
            UI.vEnd.value = getRealNumberByAyahIndex(allowedEnd - 1); 
            UI.limitModal.style.display = 'none'; 
            updateDurationDisplay(); 
        };
                UI.cancelLimit.onclick = () => { UI.limitModal.style.display = 'none'; };
                UI.closeProModal.onclick = () => { UI.proFeatureModal.style.display = 'none'; };
                
                // زر عرض الأسعار من نافذة الميزات المدفوعة
                if (UI.viewPricingBtn) {
                    UI.viewPricingBtn.onclick = () => {
                        UI.proFeatureModal.style.display = 'none';
                        const lp = document.getElementById('landingPage');
                        lp.style.display = 'flex';
                        const video = lp.querySelector('video');
                        if (video) {
                            if (!video.getAttribute('src') && video.getAttribute('data-src')) {
                                video.setAttribute('src', video.getAttribute('data-src'));
                            }
                            video.play().catch(e => console.warn(e));
                        }
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
                    const video = lp.querySelector('video');
                    if (video) {
                        if (!video.getAttribute('src') && video.getAttribute('data-src')) {
                            video.setAttribute('src', video.getAttribute('data-src'));
                        }
                        video.play().catch(e => console.warn(e));
                    }
                    setTimeout(() => {
                        lp.style.opacity = '1';
                        lp.style.pointerEvents = 'auto';
                        document.getElementById('pricing').scrollIntoView({ behavior: 'smooth' });
                    }, 10);
                };
            }

            // نوافذ الدفع والتطوير
            const openPaymentModal = () => {
                if(UI.profileModal) UI.profileModal.style.display = 'none';
                if(UI.limitModal) UI.limitModal.style.display = 'none';
                if(UI.proFeatureModal) UI.proFeatureModal.style.display = 'none';
                if(UI.paymentOptionsModal) UI.paymentOptionsModal.style.display = 'flex';
            };

            if (UI.upgradeBtn) UI.upgradeBtn.onclick = openPaymentModal;
            if (UI.limitUpgradeBtn) UI.limitUpgradeBtn.onclick = openPaymentModal;
            if (UI.proFeatureUpgradeBtn) UI.proFeatureUpgradeBtn.onclick = openPaymentModal;
            
            if (UI.closePaymentOptionsBtn) {
                UI.closePaymentOptionsBtn.onclick = () => {
                    UI.paymentOptionsModal.style.display = 'none';
                };
            }
            
            if (UI.payInternationalBtn) {
                UI.payInternationalBtn.onclick = () => {
                    UI.paymentOptionsModal.style.display = 'none';
                    const lp = document.getElementById('landingPage');
                    lp.style.display = 'flex';
                    const video = lp.querySelector('video');
                    if (video) {
                        if (!video.getAttribute('src') && video.getAttribute('data-src')) {
                            video.setAttribute('src', video.getAttribute('data-src'));
                        }
                        video.play().catch(e => console.warn(e));
                    }
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

                UI.downloadThumbBtn.onclick = () => {

                    if (!state.thumbnailUrl) return;

                    const sObj = state.surahs.find(
                        s => s.id == state.selectedSurah
                    );

                    const sName = sObj
                        ? sObj.name_arabic
                        : 'Surah';

                    const a = document.createElement('a');

                    a.href = state.thumbnailUrl;
                    a.download = `${sName} ${UI.vStart.value}-${UI.vEnd.value}.jpg`;

                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
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
                if(isExporting()) return;
                        const url = img.src;
                        state.backgroundUrl = url;
                        state.mediaType = 'image'; state.isBgReady = false; state.bgImg.src = url;
                        if (!state.bgVideo.paused) state.bgVideo.pause();
                        document.querySelectorAll('.asset-thumb').forEach(t => t.classList.remove('active')); img.classList.add('active');
                    };
                });

        const handleStart = (clientX, clientY) => { if(isExporting() || state.isSyncing) return; state.isDragging = true; state.lastMouseX = clientX; state.lastMouseY = clientY; };
                const handleMove = (clientX, clientY) => {
            if (!state.isDragging || isExporting() || state.isSyncing) return;
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

        document.getElementById('startNowBtn').onclick = () => { const lp = document.getElementById('landingPage'); lp.style.opacity = '0'; lp.style.pointerEvents = 'none'; const video = lp.querySelector('video'); if (video) video.pause(); setTimeout(() => { lp.style.display = 'none'; }, 700); loadHeavyScripts(); };

            if (UI.pricingStartFreeBtn) {
                UI.pricingStartFreeBtn.onclick = () => {
                    if (state.user) {
                    const lp = document.getElementById('landingPage'); lp.style.opacity = '0'; lp.style.pointerEvents = 'none'; const video = lp.querySelector('video'); if (video) video.pause(); setTimeout(() => { lp.style.display = 'none'; }, 700); loadHeavyScripts();
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
                    setBtnContent(UI.submitReviewBtn, 'loader-2', 'جاري الإرسال...', true);
                    
                    try {
                        const userName = state.user.user_metadata?.full_name || state.user.email.split('@')[0];
                        const avatarUrl = state.user.user_metadata?.avatar_url || null;
                        
                        const { error } = await supabaseClient.from('testimonials').insert([
                            { user_id: state.user.id, name: userName, avatar_url: avatarUrl, content: content, is_approved: false }
                        ]);
                        if (error) throw error;
                        
                        UI.reviewContent.value = '';
                        UI.reviewFeedback.textContent = 'شكرًا لك! تم إرسال تقييمك بنجاح وسينشر قريباً بعد المراجعة.';
                        UI.reviewFeedback.className = 'text-xs text-green-500 text-center block font-bold mt-3';
                        setTimeout(() => { UI.reviewModal.style.display = 'none'; }, 3500);
                    } catch (e) {
                        UI.reviewFeedback.textContent = 'حدث خطأ أثناء إرسال التقييم. حاول مرة أخرى.';
                        UI.reviewFeedback.className = 'text-xs text-red-500 text-center block font-bold mt-3';
                    } finally {
                        UI.submitReviewBtn.disabled = false;
                        setBtnContent(UI.submitReviewBtn, 'send', 'إرسال التقييم');
                    }
                };
            }

                UI.studioLogoBtn.onclick = () => {
                    const lp = document.getElementById('landingPage');
                    lp.style.display = 'flex';
                    const video = lp.querySelector('video');
                    if (video) {
                        if (!video.getAttribute('src') && video.getAttribute('data-src')) {
                            video.setAttribute('src', video.getAttribute('data-src'));
                        }
                        video.play().catch(e => console.warn(e));
                    }
                    setTimeout(() => {
                        lp.style.opacity = '1';
                        lp.style.pointerEvents = 'auto';
                    }, 10);
                };
        }

        // دالة جديدة لإنشاء محدد القوالب في الواجهة
        function createTemplateSelector() {
            const templateSection = document.getElementById('templateSection');
            if (!templateSection || !templates || templates.length === 0) return;

            templateSection.innerHTML = `
                <label class="block text-sm font-bold text-zinc-500 mb-2 flex items-center gap-2">
                    <i data-lucide="layout-template" class="w-4 h-4 text-[#007AFF]"></i> قوالب جاهزة
                </label>
                <div id="templateGrid" class="template-grid"></div>
            `;

            const grid = document.getElementById('templateGrid');
            if (!grid) return;

            templates.forEach(async (template) => {
                const thumb = document.createElement('button');
                thumb.className = 'template-thumb';
                thumb.title = template.name;

                const canvas = document.createElement('canvas');
                canvas.width = 200;
                canvas.height = 200;
                const ctx = canvas.getContext('2d');

                // دالة لرسم النص على الكانفاس
                const drawText = () => {
                    if (!ctx) return;
                    const state = template.state;
                    const ui = template.ui;
                    const text = "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ";

                    let fontName = 'Amiri';
                    if (ui.fontVersion === 'mushaf') fontName = 'AlMushaf';
                    else if (ui.fontVersion === 'pt_bold') fontName = 'PT Bold Heading';
                    else if (ui.fontVersion === 'v1' || ui.fontVersion === 'v2') {
                        // For page-based fonts, we can't easily load them here, so we fallback.
                        // Or use a sample page if available. For now, Amiri is a safe bet.
                        fontName = 'Amiri';
                    }

                    ctx.font = `bold ${state.fontSize / 3.5}px "${fontName}", Amiri, sans-serif`;
                    ctx.fillStyle = ui.textColor || '#ffffff';
                    ctx.shadowColor = ui.shadowColor || '#000000';
                    ctx.shadowBlur = (state.shadowBlur || 15) / 2;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.direction = 'rtl';

                    ctx.fillText(text, canvas.width / 2, canvas.height * (state.textY / 100));
                };

                // تحميل صورة الخلفية
                const bgImg = new Image();
                bgImg.crossOrigin = "anonymous";
                bgImg.src = template.state.thumbnail || 'img/placeholder.png';

                bgImg.onload = () => {
                    if (!ctx) return;
                    // رسم الخلفية
                    ctx.drawImage(bgImg, 0, 0, canvas.width, canvas.height);

                    // إضافة طبقة التعتيم
                    ctx.fillStyle = `rgba(0,0,0,${state.overlayOpacity || 0.5})`;
                    ctx.fillRect(0, 0, canvas.width, canvas.height);

                    // التأكد من أن الخطوط المطلوبة جاهزة قبل الرسم
                    document.fonts.ready.then(() => {
                        drawText();
                    }).catch(() => {
                        // حتى لو فشل تحميل الخطوط، نرسم النص بالخط المتاح
                        drawText();
                    });
                };

                bgImg.onerror = () => {
                    if (!ctx) return;
                    ctx.fillStyle = '#18181b';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    drawText();
                };

                const name = document.createElement('span');
                name.className = 'template-name';
                name.textContent = template.name;

                thumb.appendChild(canvas);
                thumb.appendChild(name);

                thumb.onclick = () => {
                    applyTemplate(template);
                }
                grid.appendChild(thumb);
            });
        }

        // دالة لتطبيق القالب المحدد
        async function applyTemplate(template) {
            // تطبيق إعدادات الـ state
            Object.assign(state, template.state);

            // تطبيق إعدادات الـ UI
            for (const key in template.ui) {
                if (UI[key]) {
                    if (UI[key].type === 'checkbox') UI[key].checked = template.ui[key];
                    else if (UI[key].type === 'color') UI[key].value = template.ui[key]; // For color inputs
                    else UI[key].value = template.ui[key];
                }
            }
            
            // تحديث الخلفية إذا كانت صورة
            if (template.state.mediaType === 'image' && template.state.backgroundUrl) {
                state.bgImg.src = template.state.backgroundUrl;
                state.mediaType = 'image'; // تأكيد نوع الميديا
                if (!state.bgVideo.paused) state.bgVideo.pause(); // إيقاف الفيديو إذا كان يعمل
            } else if (template.state.mediaType === 'video' && template.state.backgroundUrl) {
                state.bgVideo.src = template.state.backgroundUrl;
                state.bgVideo.load();
                state.bgVideo.play().catch(e => console.warn("Video blocked:", e));
                state.mediaType = 'video';
            }

            // إعادة تحميل الخطوط إذا تغيرت
            if (template.state.fontVersion) {
                ensureFontLoaded(state.ayahs[state.currentAyahIndex]?.page_number || 1, template.state.fontVersion, state.selectedSurah);
            }
            if (template.state.fontName) { // For specific font names like Amiri, PT Bold, AlMushaf
                const fontUrlMap = {
                    "Amiri": "https://cdn.jsdelivr.net/gh/zyadabdelbaqi/tarteel-assets@main/fonts/Amiri/Amiri-Regular.ttf", // Assuming a default Amiri URL
                    "AlMushaf": "https://cdn.jsdelivr.net/gh/zyadabdelbaqi/tarteel-assets@main/fonts/AlMushaf/AlMushaf.woff2",
                    "PT Bold Heading": "https://cdn.jsdelivr.net/gh/zyadabdelbaqi/tarteel-assets@main/fonts/PT%20Bold%20Heading/PT%20Bold%20Heading.woff2"
                };
                if (fontUrlMap[template.state.fontName]) {
                    ensureFontLoaded(null, null, null, template.state.fontName, fontUrlMap[template.state.fontName]);
                }
            }

            // تحديث الواجهة بعد تطبيق الإعدادات
            await updateContent(true); // إعادة تعيين نطاق الآيات وتحديث المحتوى
            updateDurationDisplay();
            updateAudioEffectParams(); // لتطبيق إعدادات الريفيرب الجديدة
            if (window.lucide) window.lucide.createIcons(); // إعادة رسم أيقونات Lucide
        }

        window.onload = start;

function initPaypalButtons() {
    if (!window.paypal) {
        setTimeout(initPaypalButtons, 200);
        return;
    }

    const containerMonthly = document.getElementById('paypal-button-container-P-2YV16388BD324051NNI4Z2NA');
    if (containerMonthly && !containerMonthly.hasChildNodes()) {
        paypal.Buttons({
            style: { shape: 'rect', color: 'blue', layout: 'vertical', label: 'subscribe' },
            onClick: async function(data, actions) {
                const { data: { session } } = await supabaseClient.auth.getSession();
                if (!session) {
                    sessionStorage.setItem('authRedirect', '#pricing');
                    document.getElementById('lpLoginBtn')?.click();
                    return actions.reject();
                }
                return actions.resolve();
            },
            createSubscription: async function(data, actions) {
                const { data: { session } } = await supabaseClient.auth.getSession();
                return actions.subscription.create({
                    plan_id: 'P-2YV16388BD324051NNI4Z2NA',
                    custom_id: session.user.id
                });
            },
            onApprove: function(data, actions) {
                alert('تمت عملية الاشتراك بنجاح! جاري تفعيل الحساب...');
                window.location.reload();
            }
        }).render('#paypal-button-container-P-2YV16388BD324051NNI4Z2NA').catch(e => console.error(e));
    }

    const containerYearly = document.getElementById('paypal-button-container-P-0349011609406193YNI4Z3QI');
    if (containerYearly && !containerYearly.hasChildNodes()) {
        paypal.Buttons({
            style: { shape: 'rect', color: 'gold', layout: 'vertical', label: 'subscribe' },
            onClick: async function(data, actions) {
                const { data: { session } } = await supabaseClient.auth.getSession();
                if (!session) {
                    sessionStorage.setItem('authRedirect', '#pricing');
                    document.getElementById('lpLoginBtn')?.click();
                    return actions.reject();
                }
                return actions.resolve();
            },
            createSubscription: async function(data, actions) {
                const { data: { session } } = await supabaseClient.auth.getSession();
                return actions.subscription.create({
                    plan_id: 'P-0349011609406193YNI4Z3QI',
                    custom_id: session.user.id
                });
            },
            onApprove: function(data, actions) {
                alert('تمت عملية الاشتراك بنجاح! جاري تفعيل الحساب...');
                window.location.reload();
            }
        }).render('#paypal-button-container-P-0349011609406193YNI4Z3QI').catch(e => console.error(e));
    }
}

initPaypalButtons();
