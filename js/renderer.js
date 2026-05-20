import { state } from './store.js';
import { UI } from './ui.js';
import { getCache, setCache } from './db.js';
import { getUserCapabilities } from './permissions.js';
import { isExporting } from './exportQueue.js';
import StudioWorker from './worker.js?worker';

export const sentFonts = new Set();

export async function loadAndSendFont(fontName, fontUrl) {
    if (!state.worker) return;
    if (sentFonts.has(fontName)) return;
    sentFonts.add(fontName);

    const fontKey = 'font_' + fontName;
    let buffer = await getCache(fontKey);
    if (!buffer) {
        try {
            const response = await fetch(fontUrl);
            buffer = await response.arrayBuffer();
            await setCache(fontKey, buffer);
        } catch (e) {
            console.error("Failed to load font:", fontName, e);
            sentFonts.delete(fontName);
            return;
        }
    }
    
    if (!state.worker) return;
    const bufferCopy = buffer.slice(0);
    state.worker.postMessage({
        type: 'fontData',
        fontName: fontName,
        buffer: bufferCopy
    }, [bufferCopy]);
}

export function initRenderer() {
    if (!UI.canvas) {
        console.error('Canvas element not found!');
        return;
    }
    
    state.worker = new StudioWorker();
    
    let offscreen;
    let useOffscreen = false;
    // Check if OffscreenCanvas is supported in this browser (not just the method exists)
    const offscreenSupported = typeof OffscreenCanvas !== 'undefined' && typeof UI.canvas.transferControlToOffscreen === 'function';
    if (offscreenSupported) {
        try {
            offscreen = UI.canvas.transferControlToOffscreen();
            useOffscreen = true;
        } catch (e) {
            console.warn('OffscreenCanvas transfer failed:', e);
            offscreen = UI.canvas;
        }
    } else {
        console.log('OffscreenCanvas not supported in this browser');
        offscreen = UI.canvas;
    }

    // --- Core Optimization for Mobile ---
    const isMobile = window.innerWidth < 768;
    // دقة المعاينة يجب أن تكون خفيفة جداً لعدم استهلاك الرام والمعالج أثناء التعديل
    const initialWidth = isMobile ? 854 : 1280;
    const initialHeight = isMobile ? 480 : 720;

    const surahFontUrl = new URL('fonts/Elgharib-SurahName V4/Elgharib-SurahName V4.woff2', window.location.href).href;
    const notoFontUrl = new URL('fonts/Noto_Sans_Arabic/static/NotoSansArabic-Medium.ttf', window.location.href).href;
    const basmalaFontUrl = new URL('fonts/basmala/QCFBSML.woff2', window.location.href).href;
    // Only use transfer list when using actual OffscreenCanvas
    const transfer = useOffscreen ? [offscreen] : [];
    state.worker.postMessage({ type: 'init', canvas: offscreen, width: initialWidth, height: initialHeight }, transfer);

    loadAndSendFont('surah_names', surahFontUrl);
    loadAndSendFont('Noto Sans Arabic', notoFontUrl);
    loadAndSendFont('basmala', basmalaFontUrl);

    document.fonts.ready.then(function () {
        console.log('الخطوط جاهزة الآن!');
        state.worker.postMessage({ type: 'START_RENDERING' });
    });

    state.bgImg.crossOrigin = "anonymous";
    state.bgImg.onload = () => {
        if (state.mediaType === 'image') {
            // تفريغ الكاش عند تغيير الصورة لضمان عدم تسريب إطارات الفيديو القديم
            if (state.worker) state.worker.postMessage({ type: 'clearBgCache' });
            state.isBgReady = true;
            createImageBitmap(state.bgImg).then(bmp => state.worker.postMessage({type: 'bgFrame', bitmap: bmp}, [bmp]));
        }
    };
    state.bgVideo.crossOrigin = "anonymous";
    state.bgVideo.loop = true; state.bgVideo.muted = true; state.bgVideo.playsInline = true;
    state.bgVideo.oncanplay = () => { if(state.mediaType === 'video') state.isBgReady = true; };
    // تفريغ الكاش عند بدء تحميل فيديو جديد
    state.bgVideo.addEventListener('loadstart', () => {
        if (state.mediaType === 'video' && state.worker) {
            state.worker.postMessage({ type: 'clearBgCache' });
        }
    });

    // خدعة لتسريع التصدير: إدراج الفيديو في الواجهة مخفياً لمنع المتصفح من إبطاء وتجميد إطاراته (Throttling)
    state.bgVideo.style.position = 'fixed';
    state.bgVideo.style.top = '0';
    state.bgVideo.style.left = '0';
    // يجب ألا تكون الشفافية 0 تماماً وإلا سيتوقف المتصفح عن معالجة الإطارات مما يسبب التقطيع
    state.bgVideo.style.opacity = '0.01';
    state.bgVideo.style.width = '10px'; state.bgVideo.style.height = '10px';
    state.bgVideo.style.pointerEvents = 'none';
    state.bgVideo.style.zIndex = '-9999';
    document.body.appendChild(state.bgVideo);
}

// --- Advanced Delta Messaging System ---
// تصنيف المتغيرات لتمرير الحد الأدنى من البيانات فقط للمعالج (Worker)
function getPayloadChanges(prev, next) {
    if (!prev) return { layout: true, text: true, style: true, surahInfo: true, anim: true, overlays: true, any: true };
    
    // 1. Layout & Background (الخلفية والأبعاد)
    const layoutChanged =
        prev.mediaType !== next.mediaType ||
        prev.bgX !== next.bgX ||
        prev.bgY !== next.bgY ||
        prev.zoom !== next.zoom ||
        prev.blur !== next.blur ||
        prev.overlayOpacity !== next.overlayOpacity ||
        prev.fitMode !== next.fitMode;

    // 2. Core Text & Translation (النص الأساسي والترجمة)
    const textChanged =
        prev.ayahText !== next.ayahText ||
        prev.translation !== next.translation ||
        prev.fontName !== next.fontName ||
        prev.fontSize !== next.fontSize ||
        prev.textY !== next.textY ||
        prev.showTranslation !== next.showTranslation;

    // 3. Text Styling (الألوان والظلال)
    const styleChanged =
        prev.textColor !== next.textColor ||
        prev.shadowColor !== next.shadowColor ||
        prev.shadowBlur !== next.shadowBlur ||
        prev.transTextColor !== next.transTextColor ||
        prev.transShadowColor !== next.transShadowColor ||
        prev.transShadowBlur !== next.transShadowBlur;

    // 4. Surah Info (اسم السورة وموقعها)
    const surahInfoChanged =
        prev.surahName !== next.surahName ||
        prev.showSurahName !== next.showSurahName ||
        prev.surahY !== next.surahY ||
        prev.surahX !== next.surahX ||
        prev.surahFontSize !== next.surahFontSize;

    // 5. Animations (الحركة)
    const animChanged =
        prev.animType !== next.animType ||
        prev.animIntensity !== next.animIntensity ||
        prev.resetAnim !== next.resetAnim;

    // 6. Visual Overlays (الموجات، العلامة المائية، اللوجو، البسملة)
    const overlaysChanged =
        prev.showWaveform !== next.showWaveform ||
        prev.waveformY !== next.waveformY ||
        prev.waveformHeight !== next.waveformHeight ||
        prev.waveformColor !== next.waveformColor ||
        prev.showWatermark !== next.showWatermark ||
        prev.watermarkType !== next.watermarkType ||
        prev.watermarkText !== next.watermarkText ||
        prev.watermarkColor !== next.watermarkColor ||
        prev.watermarkX !== next.watermarkX ||
        prev.watermarkY !== next.watermarkY ||
        prev.watermarkSize !== next.watermarkSize ||
        prev.watermarkOpacity !== next.watermarkOpacity ||
        prev.showTarteelLogo !== next.showTarteelLogo ||
        prev.showBasmala !== next.showBasmala ||
        prev.basmalaNumber !== next.basmalaNumber ||
        prev.basmalaX !== next.basmalaX ||
        prev.basmalaY !== next.basmalaY ||
        prev.basmalaSize !== next.basmalaSize ||
        prev.basmalaColor !== next.basmalaColor ||
        prev.basmalaShadowColor !== next.basmalaShadowColor ||
        prev.basmalaShadowBlur !== next.basmalaShadowBlur ||
        prev.isFreePlan !== next.isFreePlan ||
        prev.isExporting !== next.isExporting ||
        prev.previewTimeStr !== next.previewTimeStr;

    return {
        layout: layoutChanged,
        text: textChanged,
        style: styleChanged,
        surahInfo: surahInfoChanged,
        anim: animChanged,
        overlays: overlaysChanged,
        any: layoutChanged || textChanged || styleChanged || surahInfoChanged || animChanged || overlaysChanged
    };
}

// --- Core Fix for Tab Throttling ---
export function startMainSyncLoop() {
    let frameCounter = 0;
    let lastAudioDataSent = false;
    const syncData = () => {
        frameCounter++;
        
        // 💡 الحل الرابع: إيقاف الـ Throttling تماماً أثناء التصدير الفعلي (MediaRecorder) لضمان إرسال كل إطار
        const isExport = isExporting();
        const shouldSendFrame = isExport ? true : (frameCounter % 3 === 0);
        // السماح بالعمل أثناء التصدير حتى لو كان الفيديو متوقفاً (Paused) لضمان سحب الإطارات
        if (state.mediaType === 'video' && (!state.bgVideo.paused || isExport) && state.bgVideo.readyState >= 2 && state.worker && shouldSendFrame) {
            const currentTime = state.bgVideo.currentTime;
            // التأكد من أن الإطار جديد فعلياً لمنع إرسال إطارات متكررة وتمرير التوقيت الدقيق
            if (currentTime !== state.lastVideoTime || isExport) {
                state.lastVideoTime = currentTime;
                if (window.VideoFrame) {
                    try {
                        const frame = new VideoFrame(state.bgVideo);
                        state.worker.postMessage({type: 'bgFrame', bitmap: frame, currentTime: currentTime}, [frame]);
                    } catch (e) {
                        createImageBitmap(state.bgVideo).then(bmp => state.worker.postMessage({type: 'bgFrame', bitmap: bmp, currentTime: currentTime}, [bmp])).catch(()=>{});
                    }
                } else {
                    createImageBitmap(state.bgVideo).then(bmp => state.worker.postMessage({type: 'bgFrame', bitmap: bmp, currentTime: currentTime}, [bmp])).catch(()=>{});
                }
            }
        }

        // Local Audio Sync Logic during playback
        if (state.audioMode === 'local' && (state.isPlaying || isExporting()) && !state.isSyncing && state.timings.length > 0) {
            const currentTime = (isExporting() && state.audioContext) 
                ? (state.audioContext.currentTime - state.startTime) 
                : (state.useAudioElement ? UI.localAudioPlayer.currentTime : (state.audioContext ? state.audioContext.currentTime - state.startTime : 0));
            // Find the current verse based on timings
            let activeIndex = 0;
            for (let i = 0; i < state.timings.length; i++) {
                if (currentTime >= state.timings[i]) activeIndex = i;
            }
            // Only update if within range
            if (activeIndex >= (parseInt(UI.vStart.value)-1) && activeIndex < parseInt(UI.vEnd.value)) {
                if (!isExporting() && state.currentAyahIndex !== activeIndex) {
                    state.currentAyahIndex = activeIndex;
                }
            }
        }

        if (state.worker && state.analyser && (state.isPlaying || isExporting())) {
            if (shouldSendFrame) {
                const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
                state.analyser.getByteFrequencyData(dataArray);
                // نقل الـ Buffer مباشرة (Transferable Object) لتخفيف الضغط على الذاكرة
                state.worker.postMessage({ type: 'audioData', data: dataArray }, [dataArray.buffer]);
                lastAudioDataSent = true;
            }
        } else if (state.worker && !state.isPlaying && !isExporting()) {
            if (lastAudioDataSent) { // إرسال null مرة واحدة فقط عند التوقف بدلاً من إرسالها 60 مرة في الثانية!
                state.worker.postMessage({ type: 'audioData', data: null });
                lastAudioDataSent = false;
            }
        }
        // إيقاف تزامن الواجهة مع الـ Worker أثناء التصدير لمنع التضارب
        // تحديث إعدادات الواجهة بمعدل 60 إطار في الثانية لضمان سلاسة السحب (Dragging) والتحكم
        if (state.worker && (!isExporting() || state.isRealtimeExport)) {
            const ayah = state.ayahs[state.currentAyahIndex];
            const s = state.surahs.find(x => x.id == state.selectedSurah);
            let v = UI.fontVersion.value;
            const pageNum = ayah ? ayah.page_number : 1;

            // التحويل التلقائي لخط v1 للسور المحددة فقط التي يوجد بها مشكلة في خط v2
            if (v === 'v2' && s && [80, 83, 84, 87, 88, 89, 90, 92, 94, 96, 98, 100].includes(parseInt(s.id))) {
                v = 'v1';
            }

            let fontName, fontUrl, rawText;
            if (v === 'mushaf') {
                fontName = 'AlMushaf';
                fontUrl = new URL('fonts/AlMushaf/AlMushaf.woff2', window.location.href).href;
                if (ayah) {
                    const ayahNum = ayah.verse_key ? ayah.verse_key.split(':')[1] : '';
                    const arabicNumbers = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
                    const ayahNumAr = ayahNum.split('').map(d => arabicNumbers[parseInt(d)]).join('');
                    rawText = `${ayah.text_uthmani} ﴿${ayahNumAr}﴾`;
                } else {
                    rawText = '';
                }
            } else {
                fontName = `QuranPage${v.toUpperCase()}_${pageNum}`;
                fontUrl = new URL(`fonts/${v}/p${pageNum}.woff2`, window.location.href).href;
                rawText = ayah ? ((v === 'v2') ? ayah.code_v2 : ayah.code_v1) : '';
            }

            const resetAnim = state.lastRenderedAyah !== state.currentAyahIndex;
            if (resetAnim) state.lastRenderedAyah = state.currentAyahIndex;

            const renderPayload = {
                mediaType: state.mediaType,
                bgX: state.bgX, bgY: state.bgY, zoom: state.zoom, blur: state.blur,
                overlayOpacity: state.overlayOpacity, fitMode: 'cover',
                surahName: s ? s.name_arabic : '',
                ayahText: (rawText || "").replace(/\s+/g, ' ').trim(), translation: ayah ? ayah.translation : '',
                fontName: fontName, fontUrl: fontUrl, fontSize: state.fontSize, textY: state.textY,
                textColor: UI.textColor.value, shadowColor: UI.shadowColor.value, shadowBlur: state.shadowBlur,
                transTextColor: UI.transTextColor.value, transShadowColor: UI.transShadowColor.value, transShadowBlur: state.transShadowBlur,
                animType: UI.animType.value, animIntensity: state.animIntensity,
                showTranslation: UI.showTranslation.checked, showSurahName: UI.showSurahName.checked, surahY: parseInt(UI.surahY.value), surahX: parseInt(UI.surahX.value), surahFontSize: parseInt(UI.surahFontSize.value),
                showWaveform: UI.showWaveform.checked, waveformY: parseInt(UI.waveformY.value), waveformHeight: parseInt(UI.waveformHeight.value), waveformColor: UI.waveformColor.value,
                showWatermark: UI.showWatermark.checked, watermarkType: state.watermarkType, watermarkText: UI.watermarkText.value, watermarkColor: UI.watermarkColor.value, watermarkX: parseInt(UI.watermarkX.value), watermarkY: parseInt(UI.watermarkY.value), watermarkSize: parseInt(UI.watermarkSize.value), watermarkOpacity: parseFloat(UI.watermarkOpacity.value),
                showTarteelLogo: UI.showTarteelLogo.checked,
                showBasmala: UI.showBasmala.checked, basmalaNumber: parseInt(UI.basmalaNumber.value), basmalaX: parseInt(UI.basmalaX.value), basmalaY: parseInt(UI.basmalaY.value), basmalaSize: parseInt(UI.basmalaSize.value), basmalaColor: UI.basmalaColor.value, basmalaShadowColor: UI.basmalaShadowColor.value, basmalaShadowBlur: parseInt(UI.basmalaShadowBlur.value),
                isFreePlan: isExporting() ? (state.exportMode === 'free') : getUserCapabilities().isFree, resetAnim: resetAnim, isExporting: isExporting(),
                previewTimeStr: state.previewTimeStr
            };

            // إرسال البيانات المحددة التي تغيرت فقط (Delta Updates) لتخفيف الـ Worker
            const changes = getPayloadChanges(state.lastRenderPayload, renderPayload);
            
            if (changes.any) {
                const batch = {};
                
                if (changes.layout) {
                    batch.layout = { mediaType: renderPayload.mediaType, bgX: renderPayload.bgX, bgY: renderPayload.bgY, zoom: renderPayload.zoom, blur: renderPayload.blur, overlayOpacity: renderPayload.overlayOpacity, fitMode: renderPayload.fitMode };
                }
                if (changes.text) {
                    batch.text = { ayahText: renderPayload.ayahText, translation: renderPayload.translation, fontName: renderPayload.fontName, fontUrl: renderPayload.fontUrl, fontSize: renderPayload.fontSize, textY: renderPayload.textY, showTranslation: renderPayload.showTranslation };
                    
                    if (renderPayload.fontName && renderPayload.fontUrl) {
                        loadAndSendFont(renderPayload.fontName, renderPayload.fontUrl);
                    }
                }
                if (changes.style) {
                    batch.style = { textColor: renderPayload.textColor, shadowColor: renderPayload.shadowColor, shadowBlur: renderPayload.shadowBlur, transTextColor: renderPayload.transTextColor, transShadowColor: renderPayload.transShadowColor, transShadowBlur: renderPayload.transShadowBlur };
                }
                if (changes.surahInfo) {
                    batch.surahInfo = { surahName: renderPayload.surahName, showSurahName: renderPayload.showSurahName, surahY: renderPayload.surahY, surahX: renderPayload.surahX, surahFontSize: renderPayload.surahFontSize };
                }
                if (changes.anim) {
                    batch.anim = { animType: renderPayload.animType, animIntensity: renderPayload.animIntensity, resetAnim: renderPayload.resetAnim };
                }
                if (changes.overlays) {
                    batch.overlays = { showWaveform: renderPayload.showWaveform, waveformY: renderPayload.waveformY, waveformHeight: renderPayload.waveformHeight, waveformColor: renderPayload.waveformColor, showWatermark: renderPayload.showWatermark, watermarkType: renderPayload.watermarkType, watermarkText: renderPayload.watermarkText, watermarkColor: renderPayload.watermarkColor, watermarkX: renderPayload.watermarkX, watermarkY: renderPayload.watermarkY, watermarkSize: renderPayload.watermarkSize, watermarkOpacity: renderPayload.watermarkOpacity, showTarteelLogo: renderPayload.showTarteelLogo, showBasmala: renderPayload.showBasmala, basmalaNumber: renderPayload.basmalaNumber, basmalaX: renderPayload.basmalaX, basmalaY: renderPayload.basmalaY, basmalaSize: renderPayload.basmalaSize, basmalaColor: renderPayload.basmalaColor, basmalaShadowColor: renderPayload.basmalaShadowColor, basmalaShadowBlur: renderPayload.basmalaShadowBlur, isFreePlan: renderPayload.isFreePlan, isExporting: renderPayload.isExporting, previewTimeStr: renderPayload.previewTimeStr };
                }
                
                // لا حاجة للتحقق من وجود حقول، لأن شرط changes.any يضمن وجود حقل واحد على الأقل! (Zero Overhead)
                state.worker.postMessage({ type: 'batchUpdate', payload: batch });

                // حفظ النسخة الحالية لمقارنتها في الإطار القادم بدون الحاجة لتجميدها
                state.lastRenderPayload = renderPayload;
            }
        }

        // Handle sync overlay visibility
        if (!document.hidden) {
            if (state.audioMode === 'local' && (state.localAudioBuffer || state.localAudioFile) && !state.hasSyncedOnce && !state.isSyncing) {
                if (UI.syncOverlay.classList.contains('hidden')) {
                    UI.syncOverlay.classList.remove('hidden');
                    if (window.lucide) window.lucide.createIcons();
                }
            } else {
                if (!UI.syncOverlay.classList.contains('hidden')) {
                    UI.syncOverlay.classList.add('hidden');
                }
            }
        }
    };

    const loop = () => {
        if (isExporting() && !state.isRealtimeExport) {
            // وضع السبات: إيقاف مزامنة الواجهة أثناء التصدير لتوفير طاقة المعالج
            setTimeout(loop, 250);
        } else {
            syncData();
            // Use standard rAF when just previewing
            requestAnimationFrame(loop);
        }
    };
    loop();
}

export function ensureFontLoaded(pageNum, version = 'v1', surahId = 1) {
    if (!state.worker) return;
    const page = pageNum || 1; // تأمين المتغير بقيمة افتراضية لتجنب undefined
    if (version === 'v2' && [80, 83, 84, 87, 88, 89, 90, 92, 94, 96, 98, 100].includes(parseInt(surahId))) {
        version = 'v1';
    }
    if (version === 'mushaf') {
        loadAndSendFont('AlMushaf', new URL('fonts/AlMushaf/AlMushaf.woff2', window.location.href).href);
        return;
    }
    const fontName = `QuranPage${version.toUpperCase()}_${page}`;
    const fontUrl = new URL(`fonts/${version}/p${page}.woff2`, window.location.href).href;
    loadAndSendFont(fontName, fontUrl);
}