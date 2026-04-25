import { state } from './store.js';
import { UI } from './ui.js';

export function initRenderer() {
    if (!UI.canvas) {
        console.error('Canvas element not found!');
        return;
    }
    
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
        }
    } else {
        console.log('OffscreenCanvas not supported in this browser');
    }

    if (!useOffscreen) {
        alert('متصفح هاتفك الحالي لا يدعم تقنية المعالجة المطلوبة (OffscreenCanvas). يرجى تحديث متصفح Chrome لأحدث إصدار أو استخدام جهاز كمبيوتر.');
        if (UI.globalLoader) {
            UI.globalLoader.style.opacity = '0';
            UI.globalLoader.style.pointerEvents = 'none';
            setTimeout(() => UI.globalLoader.classList.add('hidden'), 500);
        }
        return;
    }

    state.worker = new Worker('js/worker.js?v=' + new Date().getTime());

    // --- Core Optimization for Mobile ---
    const isMobile = window.innerWidth < 768;
    // دقة المعاينة يجب أن تكون خفيفة جداً لعدم استهلاك الرام والمعالج أثناء التعديل
    const initialWidth = isMobile ? 854 : 1280;
    const initialHeight = isMobile ? 480 : 720;

    const surahFontUrl = new URL('fonts/Elgharib-SurahName V4/Elgharib-SurahName V4.woff2', window.location.href).href;
    const notoFontUrl = new URL('fonts/Noto_Sans_Arabic/static/NotoSansArabic-Medium.ttf', window.location.href).href;
    const transfer = [offscreen];
    state.worker.postMessage({ type: 'init', canvas: offscreen, width: initialWidth, height: initialHeight, surahFontUrl: surahFontUrl, notoFontUrl: notoFontUrl }, transfer);

    document.fonts.ready.then(function () {
        console.log('الخطوط جاهزة الآن!');
        state.worker.postMessage({ type: 'START_RENDERING' });
    });

    state.bgImg.crossOrigin = "anonymous";
    state.bgImg.onload = () => {
        if(state.mediaType === 'image') {
            state.isBgReady = true;
            createImageBitmap(state.bgImg).then(bmp => state.worker.postMessage({type: 'bgFrame', bitmap: bmp}, [bmp]));
        }
    };
    state.bgVideo.crossOrigin = "anonymous";
    state.bgVideo.loop = true; state.bgVideo.muted = true; state.bgVideo.playsInline = true;
    state.bgVideo.oncanplay = () => { if(state.mediaType === 'video') state.isBgReady = true; };

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

// --- Core Fix for Tab Throttling ---
export function startMainSyncLoop() {
    let frameCounter = 0;
    let lastAudioDataSent = false;
    const syncData = () => {
        frameCounter++;
        
        const shouldSendFrame = state.isExporting ? true : (frameCounter % 3 === 0);
        // Throttle video background frames to every 3 frames (~20fps) to reduce RAM/CPU pressure
        if (state.mediaType === 'video' && !state.bgVideo.paused && state.bgVideo.readyState >= 2 && state.worker && shouldSendFrame) {
            if (window.VideoFrame) {
                try {
                    const frame = new VideoFrame(state.bgVideo);
                    state.worker.postMessage({type: 'bgFrame', bitmap: frame}, [frame]);
                } catch (e) {
                    createImageBitmap(state.bgVideo).then(bmp => state.worker.postMessage({type: 'bgFrame', bitmap: bmp}, [bmp])).catch(()=>{});
                }
            } else {
                createImageBitmap(state.bgVideo).then(bmp => state.worker.postMessage({type: 'bgFrame', bitmap: bmp}, [bmp])).catch(()=>{});
            }
        }

        // Local Audio Sync Logic during playback
        if (state.audioMode === 'local' && (state.isPlaying || state.isExporting) && !state.isSyncing && state.timings.length > 0) {
            const currentTime = (state.isExporting && state.audioContext) 
                ? (state.audioContext.currentTime - state.startTime) 
                : (state.useAudioElement ? UI.localAudioPlayer.currentTime : (state.audioContext ? state.audioContext.currentTime - state.startTime : 0));
            // Find the current verse based on timings
            let activeIndex = 0;
            for (let i = 0; i < state.timings.length; i++) {
                if (currentTime >= state.timings[i]) activeIndex = i;
            }
            // Only update if within range
            if (activeIndex >= (parseInt(UI.vStart.value)-1) && activeIndex < parseInt(UI.vEnd.value)) {
                if (!state.isExporting) state.currentAyahIndex = activeIndex;
            }
        }

        if (state.worker && state.analyser && (state.isPlaying || state.isExporting)) {
            if (shouldSendFrame) {
                const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
                state.analyser.getByteFrequencyData(dataArray);
                // نقل الـ Buffer مباشرة (Transferable Object) لتخفيف الضغط على الذاكرة
                state.worker.postMessage({ type: 'audioData', data: dataArray }, [dataArray.buffer]);
                lastAudioDataSent = true;
            }
        } else if (state.worker && !state.isPlaying && !state.isExporting) {
            if (lastAudioDataSent) { // إرسال null مرة واحدة فقط عند التوقف بدلاً من إرسالها 60 مرة في الثانية!
                state.worker.postMessage({ type: 'audioData', data: null });
                lastAudioDataSent = false;
            }
        }
        // إيقاف تزامن الواجهة مع الـ Worker أثناء التصدير لمنع التضارب
        // تحديث إعدادات الواجهة بمعدل 60 إطار في الثانية لضمان سلاسة السحب (Dragging) والتحكم
        if (state.worker && !state.isExporting) {
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
                rawText = ayah ? ayah.text_uthmani : '';
            } else {
                fontName = `QuranPage${v.toUpperCase()}_${pageNum}`;
                fontUrl = new URL(`fonts/${v}/p${pageNum}.woff2`, window.location.href).href;
                rawText = ayah ? ((v === 'v2') ? ayah.code_v2 : ayah.code_v1) : '';
            }

            const resetAnim = state.lastRenderedAyah !== state.currentAyahIndex;
            if (resetAnim) state.lastRenderedAyah = state.currentAyahIndex;

            const newPayload = {
                mediaType: state.mediaType,
                bgX: state.bgX, bgY: state.bgY, zoom: state.zoom, blur: state.blur,
                overlayOpacity: state.overlayOpacity, fitMode: 'cover',
                surahName: s ? s.name_arabic : '', surahNumber: s ? s.id : 1,
                ayahText: (rawText || "").replace(/\s+/g, ' ').trim(), translation: ayah ? ayah.translation : '',
                fontVersion: v, fontName: fontName, fontUrl: fontUrl, fontSize: state.fontSize, textY: state.textY,
                textColor: UI.textColor.value, shadowColor: UI.shadowColor.value, shadowBlur: state.shadowBlur,
                transTextColor: UI.transTextColor.value, transShadowColor: UI.transShadowColor.value, transShadowBlur: state.transShadowBlur,
                animType: UI.animType.value, animIntensity: state.animIntensity,
                showTranslation: UI.showTranslation.checked, showSurahName: UI.showSurahName.checked, surahY: parseInt(UI.surahY.value), surahX: parseInt(UI.surahX.value), surahFontSize: parseInt(UI.surahFontSize.value),
                showWaveform: UI.showWaveform.checked, waveformY: parseInt(UI.waveformY.value), waveformHeight: parseInt(UI.waveformHeight.value), waveformColor: UI.waveformColor.value,
                showWatermark: UI.showWatermark.checked, watermarkType: state.watermarkType, watermarkText: UI.watermarkText.value, watermarkColor: UI.watermarkColor.value, watermarkX: parseInt(UI.watermarkX.value), watermarkY: parseInt(UI.watermarkY.value), watermarkSize: parseInt(UI.watermarkSize.value), watermarkOpacity: parseFloat(UI.watermarkOpacity.value),
                showTarteelLogo: UI.showTarteelLogo.checked,
                isFreePlan: state.isExporting ? (state.exportMode === 'free') : (state.plan === 'free'), resetAnim: resetAnim, isExporting: state.isExporting,
                previewTimeStr: state.previewTimeStr || ""
            };

            // مقارنة الكائن لتجنب إرسال بيانات مكررة وخنق الـ Worker
            const payloadStr = JSON.stringify(newPayload);
            if (state.lastPayloadStr !== payloadStr) {
                state.worker.postMessage({ type: 'updateState', payload: newPayload });
                state.lastPayloadStr = payloadStr;
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
        if (state.isExporting) {
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
    if (version === 'v2' && [80, 83, 84, 87, 88, 89, 90, 92, 94, 96, 98, 100].includes(parseInt(surahId))) {
        version = 'v1';
    }
    if (version === 'mushaf') {
        state.worker.postMessage({ type: 'preloadFont', fontName: 'AlMushaf', fontUrl: new URL('fonts/AlMushaf/AlMushaf.woff2', window.location.href).href });
        return;
    }
    const fontName = `QuranPage${version.toUpperCase()}_${pageNum}`;
    const fontUrl = new URL(`fonts/${version}/p${pageNum}.woff2`, window.location.href).href;
    state.worker.postMessage({ type: 'preloadFont', fontName: fontName, fontUrl: fontUrl });
}