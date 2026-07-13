import { state } from './store.js?v=1783959146802';
import { UI } from './ui.js?v=1783959146802';
import { updateExportButtonState } from './export.js?v=1783959146802';
import { ensureFontLoaded } from './renderer.js?v=1783959146802';
import { getCache, setCache } from './db.js?v=1783959146802';
import { getUserCapabilities, getAllowedRange, getRealVerseCount, getAyahIndexByRealNumber } from './permissions.js?v=1783959146802';
import { isExporting } from './exportQueue.js?v=1783959146802';

export function addToAudioCache(index, buffer) {
    const MAX_AUDIO_CACHE = 15;
    const key = `${state.selectedReciter}_${index}`;

    if (!state.audioCache[key]) {
        state.audioCacheOrder.push(key);
    } else {
        // 💡 LRU حقيقي: تحديث موقع الملف الصوتي ليصبح الأحدث في طابور الحذف
        const orderIdx = state.audioCacheOrder.indexOf(key);
        if (orderIdx !== -1) {
            state.audioCacheOrder.splice(orderIdx, 1);
            state.audioCacheOrder.push(key);
        }
    }
    state.audioCache[key] = buffer;

    if (state.audioCacheOrder.length > MAX_AUDIO_CACHE) {
        const oldest = state.audioCacheOrder.shift();
        delete state.audioCache[oldest];
    }
}

export function clearAudioCache() {
    state.audioCache = {};
    state.audioCacheOrder = [];
}

export function createReverbBuffer(audioCtx, duration, decay) {
    const sampleRate = audioCtx.sampleRate;
    const length = sampleRate * duration;
    const impulse = audioCtx.createBuffer(2, length, sampleRate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);
    for (let i = 0; i < length; i++) {
        const n = i;
        const val = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
        left[i] = val; right[i] = val;
    }
    return impulse;
}

export async function initAudio() {
    if (!state.audioContext) {
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        state.audioGain = state.audioContext.createGain();
        state.audioDestination = state.audioContext.createMediaStreamDestination();
        state.effectEntry = state.audioContext.createGain();
        state.dryGain = state.audioContext.createGain();
        state.wetGain = state.audioContext.createGain();

        state.convolver = state.audioContext.createConvolver();
        state.convolver.buffer = createReverbBuffer(state.audioContext, 3.0, 3.0); // قاعة كبيرة (3 ثواني)

        state.effectEntry.connect(state.dryGain); state.dryGain.connect(state.audioGain);
        state.effectEntry.connect(state.convolver); state.convolver.connect(state.wetGain);
        state.wetGain.connect(state.audioGain);

        // إضافة ضاغط صوتي (Compressor) لمنع التشويش والنويز (Clipping)
        state.compressor = state.audioContext.createDynamicsCompressor();
        state.compressor.threshold.setValueAtTime(-20, state.audioContext.currentTime);
        state.compressor.ratio.setValueAtTime(2.5, state.audioContext.currentTime);
        state.compressor.attack.setValueAtTime(0.01, state.audioContext.currentTime);
        state.compressor.release.setValueAtTime(0.4, state.audioContext.currentTime);

        // إضافة Makeup Gain لتعويض انخفاض الصوت الناتج عن الضاغط
        state.makeupGain = state.audioContext.createGain();

        // إضافة Limiter كجدار صد أخير (Brickwall) لمنع أي تشويش عند التصدير أو التشغيل
        state.limiter = state.audioContext.createDynamicsCompressor();
        state.limiter.threshold.setValueAtTime(-1, state.audioContext.currentTime);
        state.limiter.ratio.setValueAtTime(20, state.audioContext.currentTime);
        state.limiter.attack.setValueAtTime(0.001, state.audioContext.currentTime);
        state.limiter.release.setValueAtTime(0.05, state.audioContext.currentTime);

        state.audioGain.connect(state.compressor);
        state.compressor.connect(state.makeupGain);
        state.makeupGain.connect(state.limiter);
        state.limiter.connect(state.audioContext.destination); // للمستخدم (Playback)
        state.limiter.connect(state.audioDestination); // للتسجيل (Recording)

        state.analyser = state.audioContext.createAnalyser();
        state.analyser.fftSize = 128;
        state.analyser.smoothingTimeConstant = 0.85;
        state.audioGain.connect(state.analyser);
        updateAudioEffectParams();
    }
    if (state.audioContext.state === 'suspended') await state.audioContext.resume();
}

export function calculateSilence(buffer) {
    let startSilence = 0;
    let endSilence = 0;
    try {
        const data = buffer.getChannelData(0);
        const threshold = 0.005; // -46dB تقريبا (مستوى الضجيج)
        let startIdx = 0;
        while (startIdx < data.length && Math.abs(data[startIdx]) < threshold) {
            startIdx++;
        }
        startSilence = Math.max(0, (startIdx / buffer.sampleRate) - 0.05); // 50ms حماية لمنع قص الحروف
        
        let endIdx = data.length - 1;
        while (endIdx > startIdx && Math.abs(data[endIdx]) < threshold) {
            endIdx--;
        }
        endSilence = Math.max(0, buffer.duration - (endIdx / buffer.sampleRate) - 0.05);
    } catch(e) {}
    return { startSilence, endSilence };
}

export function updateAudioEffectParams() {
    if (!state.audioContext || !state.makeupGain) return;
    const enabled = UI.reverbToggle.checked;
    const intensity = parseFloat(UI.reverbRange.value);

    // 🧠 الحل الأذكى: تعويض صوتي ديناميكي (Dynamic Makeup Gain)
    // نقلل التعويض قليلاً عند تفعيل الصدى لمنع التشويش (Clipping) الناتج عن ذيل الصدى (Reverb Tail)
    const makeup = enabled ? 1.25 : 1.5;
    state.makeupGain.gain.setTargetAtTime(makeup, state.audioContext.currentTime, 0.1);

    // استخدام منحنى غير خطي (Non-linear) لواقعية الصوت (Audio Engineering Standard)
    const wetLevel = Math.pow(intensity, 2) * 2.0;
    // تقليل الصوت الأصلي (Dry) تدريجياً مع زيادة الصدى للحفاظ على التوازن
    const dryLevel = 1 - (intensity * 0.5);

    if (!enabled) {
        state.dryGain.gain.setTargetAtTime(1, state.audioContext.currentTime, 0.1);
        state.wetGain.gain.setTargetAtTime(0, state.audioContext.currentTime, 0.1);
    } else {
        state.dryGain.gain.setTargetAtTime(dryLevel, state.audioContext.currentTime, 0.1);
        state.wetGain.gain.setTargetAtTime(wetLevel, state.audioContext.currentTime, 0.1);
    }
}

export async function fetchAudioRaw(url, retries = 2) {
    if (!url) return null;
    
    const cacheKey = `audio_${url}`;
    let arrayBuffer = await getCache(cacheKey); // البحث في قاعدة البيانات (IndexedDB) أولاً
    
    if (!arrayBuffer) {
        for (let i = 0; i <= retries; i++) {
            try {
                const response = await fetch(url, { cache: 'force-cache' });
                if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
                arrayBuffer = await response.arrayBuffer();
                await setCache(cacheKey, arrayBuffer); // تخزين الملف خام في IndexedDB للمستقبل
                break;
            } catch (e) {
                if (i === retries) {
                    console.error("Audio Load Error after retries:", url, e);
                    return null;
                }
                await new Promise(r => setTimeout(r, 300 * (i + 1))); // الانتظار لفترة قصيرة قبل المحاولة مجدداً
            }
        }
    }
    
    return arrayBuffer;
}

export async function fetchAudioBuffer(url, retries = 2) {
    let arrayBuffer = await fetchAudioRaw(url, retries);
    
    if (!arrayBuffer) return null;
    
    let bufferCopy = null;
    try {
        // نستخدم slice(0) لإنشاء نسخة لأن decodeAudioData يقوم بتفريغ (Detach) الـ Buffer الأصلي من الذاكرة
        bufferCopy = arrayBuffer.slice(0);
        const decodedData = await new Promise((resolve, reject) => {
            state.audioContext.decodeAudioData(
                bufferCopy,
                (decoded) => {
                    bufferCopy = null;
                    resolve(decoded);
                },
                (err) => {
                    bufferCopy = null;
                    reject(err);
                }
            );
        });
        arrayBuffer = null;
        return decodedData;
    } catch (e) {
        console.error("Decode error:", e);
        bufferCopy = null;
        arrayBuffer = null;
        return null;
    }
}

export async function playLocalAudio() {
    // تشغيل الفيديو الخلفي إذا كان موجوداً
    if (state.mediaType === 'video') state.bgVideo.play();

        // 💡 بدء التشغيل من الآية المعروضة في المعاينة بدلاً من البداية دائماً
        const startIdx = state.currentAyahIndex !== undefined && state.currentAyahIndex >= 0 ? state.currentAyahIndex : getAyahIndexByRealNumber(parseInt(UI.vStart.value) || 1, false);
    let offset = state.timings[startIdx];
    if (offset === undefined || offset === Infinity) offset = 0;


    // Calculate duration based on the next verse's start time (if available)
    const endIdx = getAyahIndexByRealNumber(parseInt(UI.vEnd.value) || getRealVerseCount(), true);
    let duration;
    if (state.timings[endIdx] && state.timings[endIdx] !== Infinity && state.timings[endIdx] > offset) {
        duration = state.timings[endIdx] - offset;
    }

    if (state.useAudioElement) {
        if (!UI.localAudioPlayer.src) return;
        
        await initAudio();
        if (!state.mediaSource) {
            state.mediaSource = state.audioContext.createMediaElementSource(UI.localAudioPlayer);
            state.mediaSource.connect(state.effectEntry);
        }

        UI.localAudioPlayer.currentTime = offset;
        UI.localAudioPlayer.play();
        updatePlayUI();

        if (duration !== undefined) {
            if (state.playbackTimer) clearTimeout(state.playbackTimer);
            state.playbackTimer = setTimeout(() => {
                stopAudio();
            }, duration * 1000);
        }

        UI.localAudioPlayer.onended = () => {
            if(!state.isSyncing) stopAudio();
        };
    } else {
        if (!state.localAudioBuffer) return;
        await initAudio();

        const source = state.audioContext.createBufferSource();
        source.buffer = state.localAudioBuffer;

        const sourceGain = state.audioContext.createGain();
        source.connect(sourceGain); sourceGain.connect(state.effectEntry);

        state.activeSource = source;
        state.startTime = state.audioContext.currentTime - offset;

        if (duration !== undefined) source.start(0, offset, duration);
        else source.start(0, offset);
        updatePlayUI();

        source.onended = () => {
            try { source.disconnect(); } catch(e) {}
            if(!state.isSyncing) stopAudio();
        };
    }
}

export async function playSeamless(startIndex) {
    // 💡 تحديث معرّف الجلسة فوراً لضمان إلغاء أي عمليات معلقة من التشغيل السابق
    state.audioSessionId = Date.now() + Math.random();
    const currentSession = state.audioSessionId;
    const startIdx = getAyahIndexByRealNumber(parseInt(UI.vStart.value) || 1, false);
    const endIdx = getAyahIndexByRealNumber(parseInt(UI.vEnd.value) || getRealVerseCount(), true);

    const { end: maxEnd } = getAllowedRange(startIdx, endIdx);
    const caps = getUserCapabilities();

    if (startIndex >= maxEnd) {
        stopAudio();
        if (caps.isFree && maxEnd < endIdx) {
            UI.limitModal.style.display = 'flex';
        }
        return;
    }

    await initAudio();
    if (state.audioSessionId !== currentSession) return;
    if (!state.isPlaying && !isExporting()) return;

    if (state.audioMode === 'local') {
        if (state.currentAyahIndex !== startIndex) {
            state.currentAyahIndex = startIndex;
        }
        playLocalAudio();
        return;
    }

    updatePlayUI();
    if (state.mediaType === 'video' && state.bgVideo.paused) state.bgVideo.play();

    state.activeSources = state.activeSources || [];
    let scheduleTime = state.audioContext.currentTime;

    // 💣 الحل الاحترافي: Queue (طابور) للصوت لتشغيل سلس (Seamless 100%)
    for (let i = startIndex; i < maxEnd; i++) {
        if (state.audioSessionId !== currentSession) break;
        if (!state.isPlaying && !isExporting()) break;

        // التحقق من الكاش أولاً
        const key = `${state.selectedReciter}_${i}`;
        let buffer = state.audioCache[key];
        if (!buffer) {
            buffer = await fetchAudioBuffer(state.ayahs[i].audioUrl);
            if (buffer && state.audioSessionId === currentSession) addToAudioCache(i, buffer);
        }

        if (state.audioSessionId !== currentSession) break;
        if (!buffer) continue;

        // تحديث وقت الجدولة لو حصل تأخير في التحميل عن الوقت المتوقع
        const now = state.audioContext.currentTime;
        scheduleTime = Math.max(scheduleTime, now + 0.02);

        // مزامنة التحديثات على الشاشة (UI) مع وقت بدء الصوت الفعلي
        const delayToStart = Math.max(0, scheduleTime - state.audioContext.currentTime);
        setTimeout(() => {
            if (state.audioSessionId !== currentSession) return;
            if (state.currentAyahIndex !== i) {
                state.currentAyahIndex = i;
            }

            if (isExporting() && !document.hidden) {
                const totalToExport = maxEnd - startIdx; 
                const currentExported = i - startIdx + 1;
                const progress = Math.round((currentExported / totalToExport) * 100);
                UI.exportProgressBar.style.width = `${progress}%`; 
                UI.exportPercent.innerText = `${progress}%`; 
                UI.exportCounter.innerText = `${currentExported} / ${totalToExport}`;
            }
        }, delayToStart * 1000);

        const { startSilence, endSilence } = calculateSilence(buffer);
        const fullPlayDuration = Math.max(0.1, buffer.duration - startSilence - endSilence);
        
        const offsetRatio = state.ayahs[i].splitStartRatio || 0;
        const durationRatio = state.ayahs[i].splitDurationRatio || 1;
        
        const actualStartSilence = startSilence + (fullPlayDuration * offsetRatio);
        const playDuration = fullPlayDuration * durationRatio;

        // اكتشاف إذا كانت الآية الحالية جزءاً متصلاً بآية قبلها
        const isContinuation = i > startIndex && state.ayahs[i].audioUrl === state.ayahs[i-1].audioUrl && state.ayahs[i].isSplit;
        const isNextContinuation = i + 1 < maxEnd && state.ayahs[i+1] && state.ayahs[i+1].audioUrl === state.ayahs[i].audioUrl && state.ayahs[i+1].isSplit;

        // إذا لم تكن تكملة، نبدأ تشغيل مقطع جديد يمتد لنهاية الأجزاء المقسمة (أو لنهاية الآية)
        if (!isContinuation) {
            const source = state.audioContext.createBufferSource();
            const fadeGain = state.audioContext.createGain();
            source.buffer = buffer;

            source.connect(fadeGain);
            fadeGain.connect(state.effectEntry);

            state.activeSource = source;
            state.activeSources.push(source);
            
            // حساب المدة المتبقية من الملف الصوتي من نقطة البداية وحتى نهايته
            const audioDurationToPlay = fullPlayDuration * (1 - offsetRatio);

            const fadeDur = Math.min(0.03, audioDurationToPlay / 2);
            fadeGain.gain.setValueAtTime(0, scheduleTime);
            fadeGain.gain.linearRampToValueAtTime(1, scheduleTime + fadeDur);
            fadeGain.gain.setValueAtTime(1, Math.max(scheduleTime + fadeDur, scheduleTime + audioDurationToPlay - fadeDur));
            fadeGain.gain.linearRampToValueAtTime(0, scheduleTime + audioDurationToPlay);

            source.start(scheduleTime, actualStartSilence, audioDurationToPlay);

            source.onended = () => {
                const idx = state.activeSources.indexOf(source);
                if (idx > -1) state.activeSources.splice(idx, 1);
                try { source.disconnect(); } catch(e) {}
                if (state.activeSources.length === 0 && state.currentAyahIndex >= maxEnd - 1 && state.audioSessionId === currentSession) {
                    stopAudio();
                    if (caps.isFree && maxEnd < endIdx) {
                        UI.limitModal.style.display = 'flex';
                    }
                }
            };
        }

        // تحميل 3 آيات قادمة في الخلفية لضمان عدم حدوث أي تقطيع بسبب بطء الإنترنت
        for (let next = 1; next <= 3; next++) {
            const nextKey = `${state.selectedReciter}_${i + next}`;
            if (i + next < maxEnd && !state.audioCache[nextKey]) {
                fetchAudioBuffer(state.ayahs[i + next].audioUrl).then(b => {
                    if (b && state.audioSessionId === currentSession) addToAudioCache(i + next, b);
                });
            }
        }

        const v = UI.fontVersion.value;
        for (let j = 1; j <= 3; j++) { if (i + j < maxEnd && state.ayahs[i + j]) ensureFontLoaded(state.ayahs[i + j].page_number, v, state.selectedSurah); }

        // إلغاء التداخل (Overlap) بين الأجزاء المقسمة لأن الصوت متصل بطبيعته!
        let overlap = 0;
        if (!isNextContinuation) {
            overlap = Math.min(0.22, Math.max(0.04, fullPlayDuration * 0.065));
            // 💡 حماية الأجزاء المقصوصة القصيرة جداً لكي لا يرجع الزمن للخلف وتتخطى الآية
            overlap = Math.min(overlap, playDuration * 0.5);
        }
        
        scheduleTime += playDuration - overlap;

        // تفريغ الحمل عن المعالج أثناء جلب البيانات وترك فرصة للواجهة لتتحدث
        const timeAhead = scheduleTime - state.audioContext.currentTime;
        if (timeAhead > 2.0) {
            await new Promise(r => setTimeout(r, (timeAhead - 1.0) * 1000));
        }
    }
}

export function stopAudio() {
    if (UI.localAudioPlayer) UI.localAudioPlayer.pause();
    state.isPlaying = false; state.isSyncing = false; state.audioSessionId = Date.now() + Math.random();
    if (state.playbackTimer) clearTimeout(state.playbackTimer);
    if (state.mediaType === 'video') state.bgVideo.pause();
    if (state.activeSource) { 
        state.activeSource.onended = null; 
        try { state.activeSource.stop(); } catch(e) {} 
        try { state.activeSource.disconnect(); } catch(e) {} 
        state.activeSource = null; 
    }
    if (state.activeSources) {
        state.activeSources.forEach(s => {
            s.onended = null;
            try { s.stop(); } catch(e) {}
            try { s.disconnect(); } catch(e) {}
        });
        state.activeSources = [];
    }
    state.nextBuffer = null; updatePlayUI();
}

export function updatePlayUI() { 
    const icon = UI.playBtn ? UI.playBtn.querySelector('[data-lucide]') : null;
    if (icon) {
        const newIcon = document.createElement('i');
        newIcon.id = 'playIcon';
        newIcon.setAttribute('data-lucide', state.isPlaying ? 'pause' : 'play');
        newIcon.className = (icon.getAttribute('class') || '').replace(/lucide-\w+|lucide/g, '').trim();
        icon.replaceWith(newIcon);
    } else if (UI.playIcon) {
        UI.playIcon.setAttribute('data-lucide', state.isPlaying ? 'pause' : 'play'); 
    }
    if (window.lucide) window.lucide.createIcons(); 
}

export function clearLocalAudioFile() {
    UI.localAudioInput.value = '';
    UI.localAudioPlayer.pause();
    UI.localAudioPlayer.src = '';
    UI.localFilePreview.classList.add('hidden');
    UI.syncControls.classList.add('hidden');
    
    const trimUI = document.getElementById('audioTrimUI');
    if (trimUI) trimUI.remove();
    
    state.localAudioBuffer = null;
    state.originalAudioBuffer = null;
    state.isTrimmed = false;
    state.localAudioFile = null;
    state.timings = [];
    state.hasSyncedOnce = false;
    if (!UI.syncOverlay.classList.contains('hidden')) UI.syncOverlay.classList.add('hidden');
    updateExportButtonState();
}