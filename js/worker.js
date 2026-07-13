'use strict';

let ctx;
let canvas;
let state = {
    width: 1280, height: 720, // أبعاد المعاينة خفيفة (720p)
    mediaType: 'image',
    bgBitmap: null,
    overlayOpacity: 0.5,
    blur: 0, zoom: 100, bgX: 0, bgY: 0,
    fitMode: 'cover',
    surahName: '',
    ayahText: '',
    surahNumber: 1,
    translation: '',
    fontVersion: 'v2',
    fontName: 'Amiri',
    fontSize: 75,
    textX: 50,
    textY: 50,
    textColor: '#ffffff',
    shadowColor: '#000000',
    shadowBlur: 15,
    transTextColor: '#d4d4d8',
    transShadowColor: '#000000',
    transShadowBlur: 0,
    animType: 'fade',
    animIntensity: 30,
    animProgress: 1,
    isContinuation: false,
    showTranslation: true,
    showQariName: false,
    qariName: 'القارئ / أحمد العجمي',
    showSurahName: false,
    surahY: 95,
    surahX: 50,
    surahFontSize: 70,
    surahColor: '#ffffff',
    surahShadowColor: '#000000',
    surahShadowBlur: 15,
    showWaveform: false,
    waveformHeight: 120,
    waveformColor: '#ffffff',
    waveformY: 85,
    showWatermark: false, watermarkType: 'image', watermarkText: '', watermarkColor: '#ffffff', watermarkBitmap: null, watermarkX: 45, watermarkY: 85, watermarkSize: 10, watermarkOpacity: 0.8,
    showTarteelLogo: true,
    showBasmala: false, basmalaNumber: 6, basmalaX: 50, basmalaY: 15, basmalaSize: 90, basmalaColor: '#ffffff', basmalaShadowColor: '#000000', basmalaShadowBlur: 10,
    audioData: null,
    isFreePlan: false,
    isExporting: false,
    previewTimeStr: '',
    loadedFonts: new Set(),
    fontPromises: new Map(), // استخدام Map لحفظ الـ Promises وضمان عدم تكرار التحميل
    videoEncoder: null
};

// --- نظام تخطي الإطارات المتطابقة (Frame Deduplication) ---
let isDirty = true;
let pendingFrame = null;
let pendingTimestamp = 0;
let pendingDuration = 0;
let pendingKeyFrame = false;
let currentAudioHash = 0; // 💡 بصمة دقيقة لبيانات الصوت

// 🚀 كاش الإطارات الذكي لتجنب فك التشفير المتكرر (Frame Caching)
// تحديد حجم الكاش بناءً على ذاكرة الجهاز (الرام) المتاحة لمنع تشنج الهواتف الضعيفة
const isLowMemoryDevice = navigator.deviceMemory && navigator.deviceMemory <= 4;
const bgFrameCache = new Map();
const MAX_BG_CACHE_MB = isLowMemoryDevice ? 80 : 200; // 80MB للهواتف، 200MB للأجهزة القوية
let currentBgCacheSize = 0;

function estimateFrameSize(frame) {
    if (!frame) return 0;
    const width = frame.displayWidth || frame.width || 1280;
    const height = frame.displayHeight || frame.height || 720;
    // ضرب الحجم في 0.75 كعامل أمان (Safety Margin) لأن فريمات الفيديو غالباً تكون YUV وتستهلك مساحة أقل من RGBA
    return width * height * 4 * 0.75; // bytes
}

function addBgFrameToCache(key, frame) {
    if (!frame) return;

    // لو موجود قبل كدا → شيله من الحساب
    if (bgFrameCache.has(key)) {
        const old = bgFrameCache.get(key);
        
        // 💡 LRU حقيقي وتوفير للموارد: لو الإطار هو نفسه، نحدث ترتيبه فقط ونخرج
        if (old === frame) {
            bgFrameCache.delete(key);
            bgFrameCache.set(key, frame);
            return;
        }

        // إغلاق الفريم القديم إذا تمت الكتابة فوقه بفريم جديد (لمنع تسريب الذاكرة)
        if (old && old !== state.bgBitmap && typeof old.close === 'function') {
            try { old.close(); } catch(e) {}
        }
        currentBgCacheSize -= estimateFrameSize(old);
        bgFrameCache.delete(key);
    }

    const frameSize = estimateFrameSize(frame);
    bgFrameCache.set(key, frame);
    currentBgCacheSize += frameSize;

    // استدعاء مراقب الذاكرة بشكل تفاعلي (Reactive) مع كل إضافة لضمان استجابة سريعة
    monitorMemory();

    // 🔥 تفريغ الكاش بناءً على الحجم بدلاً من العدد (Eviction based on size)
    while (currentBgCacheSize > MAX_BG_CACHE_MB * 1024 * 1024) {
        const firstKey = bgFrameCache.keys().next().value;
        const oldFrame = bgFrameCache.get(firstKey);

        if (oldFrame && oldFrame !== state.bgBitmap && typeof oldFrame.close === 'function') {
            try { oldFrame.close(); } catch(e) {}
        }

        currentBgCacheSize -= estimateFrameSize(oldFrame);
        bgFrameCache.delete(firstKey);
    }
}

function clearBgCache() {
    for (const frame of bgFrameCache.values()) {
        if (frame && frame !== state.bgBitmap && typeof frame.close === 'function') {
            try { frame.close(); } catch(e) {}
        }
    }
    bgFrameCache.clear();
    currentBgCacheSize = 0;
}

function monitorMemory() {
    const mb = (currentBgCacheSize / (1024 * 1024)).toFixed(1);

    if (currentBgCacheSize > MAX_BG_CACHE_MB * 0.9 * 1024 * 1024) {
        console.warn("High BG cache usage:", mb, "MB");
    }
    
    // Kill switch: تفريغ إجباري في حالة الطوارئ لمنع تشنج الجهاز
    const CRITICAL_LIMIT_MB = isLowMemoryDevice ? 120 : 300;
    if (currentBgCacheSize > CRITICAL_LIMIT_MB * 1024 * 1024) {
        console.error("Critical memory! Clearing cache...");
        clearBgCache();
    }
}

let textCacheCanvas = null;
let textCacheCtx = null;
const textBitmapCache = new Map(); // كاش متقدم لتخزين مئات الآيات كصور VRAM

const MAX_BITMAP_CACHE = 120; // الحد الأقصى للآيات المخزنة في الكاش لحماية VRAM

// دالة مخصصة لإدارة ذاكرة الـ VRAM بشكل آمن ومنع التسريب (Memory Leak)
function addBitmapToCache(key, data) {
    textBitmapCache.set(key, data);

    if (textBitmapCache.size > MAX_BITMAP_CACHE) {
        const firstKey = textBitmapCache.keys().next().value;
        const oldData = textBitmapCache.get(firstKey);
        if (oldData && oldData.bitmap) {
            oldData.bitmap.close(); // تفريغ الصورة من كرت الشاشة
        }
        textBitmapCache.delete(firstKey);
    }
}

// دالة التنظيف الشاملة: تمسح كل الصور المحفوظة في كرت الشاشة وتفرغ الكاش
function clearBitmapCache() {
    for (const data of textBitmapCache.values()) {
        if (data && data.bitmap) {
            try { data.bitmap.close(); } catch(e) {}
        }
    }
    textBitmapCache.clear();
}

let FPS = 30; // أصبحت متغيرة بناءً على اختيار المستخدم
let frameInterval = 1000 / FPS;

const textLinesCache = new Map(); // كاش لتخزين نتائج تقطيع الأسطر

// Basmala cache
const basmalaLinesCache = new Map();
const MAX_BASMALA_CACHE = 50;

const Easing = {
    outElastic: (t, intensity = 50) => {
        const p = 0.3; const strength = intensity / 50;
        return (Math.pow(2, -10 * t) * Math.sin((t - p / 4) * (2 * Math.PI) / p) * strength) + 1;
    },
    outCubic: (t) => 1 - Math.pow(1 - t, 3)
};

function calculateTextLines(ctx, text, maxWidth) {
    if (!text) return [""];

    // استخدام النص، العرض، والخط كمفتاح فريد
    const cacheKey = `${text}|${maxWidth}|${ctx.font}`;
    if (textLinesCache.has(cacheKey)) {
        const lines = textLinesCache.get(cacheKey);
        textLinesCache.delete(cacheKey);
        textLinesCache.set(cacheKey, lines); // LRU Update: Move to recent
        return lines;
    }

    const words = text.split(' ');
    let line = '', lines = [];
    for (let n = 0; n < words.length; n++) {
        let testLine = line + words[n] + ' ';
        if (ctx.measureText(testLine).width > maxWidth && n > 0) { lines.push(line.trim()); line = words[n] + ' '; }
        else line = testLine;
    }
    lines.push(line.trim());

    textLinesCache.set(cacheKey, lines);
    // تنظيف الكاش إذا تخطى 500 عنصر لحماية الذاكرة (RAM) من الامتلاء
    if (textLinesCache.size > 500) {
        textLinesCache.delete(textLinesCache.keys().next().value);
    }

    return lines;
}

function loadFontFromBuffer(fontName, buffer) {
    if (state.loadedFonts.has(fontName)) return;
    if (state.fontPromises.has(fontName)) return state.fontPromises.get(fontName);

    const promise = (async () => {
        try {
            const font = new FontFace(fontName, buffer);
            await font.load();
            self.fonts.add(font);
            state.loadedFonts.add(fontName);
                isDirty = true; // إجبار المعالج على إعادة الرسم بعد اكتمال تحميل الخط
        } catch (e) {
            console.error('Worker Font Error:', fontName, e);
        } finally {
            state.fontPromises.delete(fontName);
        }
    })();
    
    state.fontPromises.set(fontName, promise);
    return promise;
}

// دالة مساعدة لتحديث الخلفية مع ضمان عدم تسريب إطارات الفيديو (VideoFrame Memory Leak)
function updateBgBitmap(newBitmap) {
    if (state.bgBitmap === newBitmap) return;
    
    let isCached = false;
    for (const cached of bgFrameCache.values()) {
        if (cached === state.bgBitmap) { isCached = true; break; }
    }
    if (state.bgBitmap && !isCached && typeof state.bgBitmap.close === 'function') {
        state.bgBitmap.close();
    }
    state.bgBitmap = newBitmap;
}

self.onmessage = async (e) => {
    const data = e.data;
    const type = data.type;
    if (type === 'init') {
        canvas = data.canvas;
        canvas.width = data.width;
        canvas.height = data.height;
        ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        state.width = data.width;
        state.height = data.height;

    } else if (type === 'fontData') {
        loadFontFromBuffer(data.fontName, data.buffer);
    } else if (type === 'initExport') {
        state.isFFmpegExport = false;
        state.videoEncoder = new VideoEncoder({
            output: (chunk, meta) => {
                const buffer = new ArrayBuffer(chunk.byteLength);
                chunk.copyTo(buffer);
                self.postMessage({
                    type: 'videoChunk',
                    chunkData: buffer,
                    chunkType: chunk.type,
                    timestamp: chunk.timestamp,
                    duration: chunk.duration,
                    meta: meta
                }, [buffer]);
            },
            error: (e) => {
                if (state.isRealtimeExport) {
                    console.error('VideoEncoder Error:', e);
                } else {
                    console.warn('VideoEncoder fallback triggered.');
                }
                if (pendingFrame) { pendingFrame.close(); pendingFrame = null; }
                if (state.videoEncoder) {
                    try { if (state.videoEncoder.state !== 'closed') state.videoEncoder.close(); } catch(err) {}
                    state.videoEncoder = null;
                }
                clearBgCache();
                clearBitmapCache(); // تفريغ الـ VRAM بقوة
                self.postMessage({ type: 'exportError', error: e.message });
            }
        });
        if (data.fps) FPS = data.fps; // تحديث الإطارات
        frameInterval = 1000 / FPS;
        try {
            state.videoEncoder.configure(data.config);
            self.postMessage({ type: 'encoderReady' });
        } catch (e) {
            console.warn('VideoEncoder configure failed, triggering fallback.');
            self.postMessage({ type: 'exportError', error: e.message });
        }

    } else if (type === 'initFFmpegExport') {
        state.isFFmpegExport = true;
        if (data.fps) FPS = data.fps;
        frameInterval = 1000 / FPS;
        self.postMessage({ type: 'encoderReady' });

    } else if (type === 'encodeFrame') {
        const payload = data.payload;
        
        // التحقق من تغير الإعدادات المرئية لتفريغ الكاش وحماية VRAM
        if (payload.fontName !== state.fontName ||
            payload.fontSize !== state.fontSize ||
            payload.textColor !== state.textColor ||
            payload.shadowColor !== state.shadowColor ||
            payload.shadowBlur !== state.shadowBlur ||
            payload.transTextColor !== state.transTextColor ||
            payload.transShadowColor !== state.transShadowColor ||
            payload.transShadowBlur !== state.transShadowBlur ||
            payload.showTranslation !== state.showTranslation) {
            clearBitmapCache();
        }

        let stateChanged = false;
        for (const key in payload) {
            if (state[key] !== payload[key]) {
                state[key] = payload[key];
                stateChanged = true;
            }
        }
        if (stateChanged) isDirty = true;

        if (payload.fontName && state.fontPromises.has(payload.fontName)) {
            await state.fontPromises.get(payload.fontName);
        }

        if (state.isFFmpegExport) {
            draw();
            const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
            const buffer = await blob.arrayBuffer();
            self.postMessage({ type: 'ffmpegFrame', frameNumber: data.frameNumber, buffer: buffer }, [buffer]);
            return;
        }


        // --- Frame Deduplication (Zero-Render / Zero-Encode) ---
        const frameDurationUs = Math.round(1_000_000 / FPS); // مدة الإطار الواحد بالمايكروثانية

        const isSameFrame = !data.keyFrame && !isDirty;
        
        // 🔴 الحل الإجباري والقاطع: إيقاف الـ Deduplication تماماً أثناء تصدير الفيديو لمنع أي تجميد (Freeze)
        // (مع الحفاظ على التسريع للصور والخلفيات الثابتة)
        const forceRenderVideo = state.mediaType === 'video';

        if (isSameFrame && pendingFrame && !forceRenderVideo) {
            // المشهد لم يتغير، نزيد مدة الإطار المعلق ولا نقوم بترميزه الآن (Frame Skipping + Duration)
            pendingDuration += frameDurationUs;
            
            const MAX_DURATION = 80000; // 150ms بالمايكروثانية كحد أقصى لتجنب مشاكل مشغلات الفيديو
            if (pendingDuration >= MAX_DURATION) {
                const frameToEncode = new VideoFrame(pendingFrame, { timestamp: pendingTimestamp, duration: pendingDuration });
                if (state.videoEncoder && state.videoEncoder.state === 'configured') {
                    state.videoEncoder.encode(frameToEncode, { keyFrame: false });
                }
                frameToEncode.close();
                
                pendingTimestamp += pendingDuration;
                pendingDuration = 0;
            }
        } else {
            // المشهد تغير، نقوم بترميز الإطار المعلق السابق بالمدة المجمعة أولاً
            if (pendingFrame) {
                if (pendingDuration > 0) {
                    const frameToEncode = new VideoFrame(pendingFrame, { timestamp: pendingTimestamp, duration: pendingDuration });
                    if (state.videoEncoder && state.videoEncoder.state === 'configured') {
                        state.videoEncoder.encode(frameToEncode, { keyFrame: pendingKeyFrame });
                    }
                    frameToEncode.close();
                }
                pendingFrame.close();
            }

            draw();

            // التقاط المشهد الجديد كإطار معلق
            pendingFrame = new VideoFrame(canvas, { timestamp: data.timestamp });
            pendingTimestamp = data.timestamp;
            pendingDuration = frameDurationUs;
            pendingKeyFrame = data.keyFrame;
        }

        // صمام أمان (Backpressure): يمنع إرسال إطارات جديدة حتى تنتهي المعالجة لتجنب تشنج المتصفح
        const checkQueue = () => {
            if (!state.videoEncoder || state.videoEncoder.encodeQueueSize < 10) {
                self.postMessage({ type: 'frameEncoded', frameNumber: data.frameNumber });
            } else {
                setTimeout(checkQueue, 5);
            }
        };
        checkQueue();

    } else if (type === 'finishExport') {
        state.isExporting = false;
        if (state.isFFmpegExport) {
            clearBgCache();
            clearBitmapCache();
            self.postMessage({ type: 'ffmpegFinished' });
            return;
        }

        // ترميز آخر إطار معلق قبل إنهاء التصدير
        if (pendingFrame) {
            if (pendingDuration > 0) {
                const frameToEncode = new VideoFrame(pendingFrame, { timestamp: pendingTimestamp, duration: pendingDuration });
                if (state.videoEncoder && state.videoEncoder.state === 'configured') {
                    state.videoEncoder.encode(frameToEncode, { keyFrame: pendingKeyFrame });
                }
                frameToEncode.close();
            }
            pendingFrame.close();
            pendingFrame = null;
        }
        
        if (state.videoEncoder) {
            if (state.videoEncoder.state === 'configured') {
                try { await state.videoEncoder.flush(); } catch(e) {}
            }
            if (state.videoEncoder.state !== 'closed') {
                try { state.videoEncoder.close(); } catch(e) {}
            }
            state.videoEncoder = null;
        }
        
        // تنظيف كاش الإطارات بعد التصدير لتحرير الذاكرة
        clearBgCache();
        clearBitmapCache(); // تحرير ذاكرة النصوص والصور المحفوظة

        self.postMessage({ type: 'videoFinished' });

    } else if (type === 'abortExport') {
        state.isExporting = false;
        if (pendingFrame) { pendingFrame.close(); pendingFrame = null; }
        if (state.videoEncoder) {
            try { if (state.videoEncoder.state !== 'closed') state.videoEncoder.close(); } catch(e) {}
            state.videoEncoder = null;
        }
        
        // تنظيف كاش الإطارات عند الإلغاء
        clearBgCache();
        clearBitmapCache(); // تحرير ذاكرة النصوص والصور المحفوظة
        
        self.postMessage({ type: 'exportAborted' });
    } else if (type === 'START_RENDERING') {
        scheduleNextFrame();
    } else if (type === 'batchUpdate') {
        const p = data.payload;
        
        // تفريغ الكاش الذكي مرة واحدة فقط لو كان هناك تعديل في النصوص أو الألوان
        if (p.text || p.style) {
            clearBitmapCache();
        }

        if (p.layout) {
            if (p.layout.mediaType !== undefined && p.layout.mediaType !== state.mediaType) {
                clearBgCache();
            }
            Object.assign(state, p.layout);
        }
        
        if (p.text) {
            Object.assign(state, p.text);
        }
        
        if (p.style) Object.assign(state, p.style);
        if (p.surahInfo) Object.assign(state, p.surahInfo);
        if (p.overlays) Object.assign(state, p.overlays);
        
        if (p.anim) {
            Object.assign(state, p.anim);
            if (p.anim.resetAnim) state.animProgress = 0;
        }
        isDirty = true;
    } else if (type === 'bgFrame') {
        updateBgBitmap(data.bitmap);
        
        // إضافة الفريم للكاش إذا كان مرفقاً بـ cacheKey
        if (data.cacheKey && state.mediaType !== 'video') {
            addBgFrameToCache(data.cacheKey, data.bitmap);
        }
        isDirty = true;

    } else if (type === 'useCachedBg') {
        // 💡 الحل العبقري: رسم الفريم مباشرة من الكاش بدون Decode
        if (bgFrameCache.has(data.cacheKey)) {
            const cachedFrame = bgFrameCache.get(data.cacheKey);
            addBgFrameToCache(data.cacheKey, cachedFrame);
            updateBgBitmap(cachedFrame);
            isDirty = true;
        }
    } else if (type === 'watermarkFrame') {
        if (state.watermarkBitmap) state.watermarkBitmap.close();
        state.watermarkBitmap = data.bitmap;
        isDirty = true;
    } else if (type === 'resize') {
        canvas.width = data.width;
        canvas.height = data.height;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        state.width = data.width;
        state.height = data.height;
        clearBgCache();
        clearBitmapCache(); // تفريغ الكاش القديم بالكامل لأن الأبعاد تغيرت وكل الصور القديمة لم تعد صالحة
        isDirty = true;
    } else if (type === 'startRealtimeExport') {
        state.isExporting = true;
        state.isRealtimeExport = true;
        scheduleNextFrame();
    } else if (type === 'stopRealtimeExport') {
        state.isExporting = false;
        state.isRealtimeExport = false;
        isDirty = true;
    } else if (type === 'audioData') {
        state.audioData = data.data;
        if (data.data) {
            // 💡 خوارزمية DJB2 سريعة جداً لإنشاء بصمة (Hash) من مصفوفة الصوت (Zero-Overhead)
            let hash = 5381;
            for (let i = 0; i < data.data.length; i++) {
                hash = ((hash << 5) + hash) + data.data[i]; /* hash * 33 + c */
            }
            const newHash = hash >>> 0;
            if (currentAudioHash !== newHash) {
                currentAudioHash = newHash;
                isDirty = true;
            }
        } else {
            if (currentAudioHash !== 0) {
                currentAudioHash = 0;
                isDirty = true;
            }
        }
    } else if (type === 'fontsReady') {
        clearBitmapCache(); // إجبار المعالج على إعادة رسم النصوص بالخطوط الجديدة
        isDirty = true;
    } else if (type === 'clearBgCache') {
        clearBgCache();
    } else if (type === 'updateState') {
        // 💡 تحديث حالة المتغيرات الأساسية المعزولة عن الـ Main Thread
        if (data.isExporting !== undefined && state.isExporting !== data.isExporting) {
            state.isExporting = data.isExporting;
            isDirty = true;
        }
    }
};

function draw() {
    if (!ctx) return;

    // تخطي الإطار لو مفيش تغيير لتوفير الـ CPU/GPU (Dirty flag check)
    if (!isDirty && state.mediaType !== 'video' && state.animProgress >= 1 && !state.audioData) return;
    isDirty = false;

    // جعل سرعة التحريك (Animation) مستقلة عن الفريمات (Frame-rate independent)
    // تسريع الحركة للأجزاء المقسمة لضمان التزامن الفوري
    const speedMultiplier = state.isContinuation ? 2.5 : 1;
    const animStep = (30 / FPS) * 0.06 * speedMultiplier;
    if (state.animProgress < 1) state.animProgress += animStep;

    const { width, height } = state;
    // الاعتماد على البعد الأصغر لضمان ثبات وضوح العناصر في كل الأبعاد (طولي/مربع/عرضي)
    const scaleFactor = Math.min(width, height) / 1080; 
    // Force black background to prevent alpha transparency glitches in video export
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    // Draw Background
    if (state.bgBitmap) {
        ctx.save();
        const scale = state.zoom / 100;
        const bmp = state.bgBitmap;
        const mWidth = bmp.displayWidth || bmp.width;
        const mHeight = bmp.displayHeight || bmp.height;
        const mediaRatio = mWidth / mHeight;
        const canvasRatio = width / height;
        let dWidth, dHeight;

        if (state.fitMode === 'contain') {
            if (mediaRatio > canvasRatio) { dWidth = width; dHeight = width / mediaRatio; }
            else { dHeight = height; dWidth = height * mediaRatio; }
        } else {
            if (mediaRatio > canvasRatio) { dHeight = height; dWidth = height * mediaRatio; }
            else { dWidth = width; dHeight = width / mediaRatio; }
        }

        if (state.blur > 0) ctx.filter = 'blur(' + state.blur + 'px)';
        ctx.translate(width/2 + state.bgX, height/2 + state.bgY);
        ctx.scale(scale, scale);
        ctx.drawImage(bmp, -dWidth/2, -dHeight/2, dWidth, dHeight);
        ctx.restore();
        ctx.filter = 'none';
    }

    // Overlay
    ctx.fillStyle = 'rgba(0,0,0,' + state.overlayOpacity + ')';
    ctx.fillRect(0, 0, width, height);

    // Surah Name
    if (state.showSurahName) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.fillStyle = state.surahColor || '#ffffff';
        
        if (state.surahShadowBlur > 0) {
            ctx.shadowColor = state.surahShadowColor || '#000000';
            ctx.shadowBlur = state.surahShadowBlur * scaleFactor;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
        } else {
            ctx.shadowBlur = 0;
        }

        const yPos = height * (state.surahY / 100);
        const xPos = width * (state.surahX / 100);

        if (state.loadedFonts.has('surah_names')) {
            ctx.font = 'normal ' + (state.surahFontSize * scaleFactor) + 'px "surah_names"';
            ctx.direction = 'rtl'; // ضروري جداً لتعرف المتصفح على ترابط الحروف العربية
            const glyph = state.surahName; // تمرير الاسم العربي مباشرة (مثال: الفاتحة)
            ctx.fillText(glyph, xPos, yPos);
        } else {
            ctx.font = '400 ' + (state.surahFontSize * 0.6 * scaleFactor) + 'px Amiri, serif';
            ctx.direction = 'rtl';
            ctx.fillText(state.surahName, xPos, yPos);
        }
        ctx.restore();
    }

    // Basmala Rendering
    if (state.showBasmala && state.loadedFonts.has('basmala')) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.fillStyle = state.basmalaColor;
        ctx.shadowColor = state.basmalaShadowColor;
        ctx.shadowBlur = state.basmalaShadowBlur * scaleFactor;
        
        const basmalaY = height * (state.basmalaY / 100);
        const basmalaX = width * (state.basmalaX / 100);
        const basmalaFontSize = state.basmalaSize * scaleFactor;
        
        ctx.font = basmalaFontSize + 'px "basmala"';
        ctx.direction = 'ltr'; // تغيير الاتجاه إلى ltr لأن الخط يستخدم أرقاماً إنجليزية
        ctx.fillText(state.basmalaNumber.toString(), basmalaX, basmalaY);
        ctx.restore();
    }

    // Qari Name Rendering
    if (state.showQariName && state.qariName) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.fillStyle = state.qariColor || '#ffffff';
        ctx.shadowColor = state.qariShadowColor || '#000000';
        ctx.shadowBlur = (state.qariShadowBlur !== undefined ? state.qariShadowBlur : 10) * scaleFactor;
        
        // Dynamic position from UI sliders
        const qariY = height * ((state.qariY || 85) / 100);
        const qariX = width * ((state.qariX || 50) / 100);
        const qariFontSize = (state.qariFontSize || 80) * scaleFactor;
        
        if (state.loadedFonts.has('qari_font')) {
            ctx.font = 'normal ' + qariFontSize + 'px "qari_font"';
        } else {
            ctx.font = 'bold ' + qariFontSize + 'px "Noto Sans Arabic", sans-serif';
        }
        
        ctx.direction = 'rtl';
        ctx.fillText(state.qariName, qariX, qariY);
        ctx.restore();
    }

    // Text Rendering
    let contentBottom = (height / 2) + (150 * scaleFactor);
    const fontName = state.fontName || 'Amiri';
    // منع ظهور النص إذا لم يتم تحميل الخط الخاص به بعد لتجنب ظهور رموز غريبة
    if (state.ayahText && ((fontName !== 'AlMushaf' && fontName !== 'PT Bold Heading' && !fontName.startsWith('QuranPage')) || state.loadedFonts.has(fontName))) {
        const scaledFontSize = state.fontSize * scaleFactor;
        const activeFont = fontName;
        const padding = Math.max(state.shadowBlur, state.transShadowBlur) * scaleFactor + 40; // مساحة كافية للظل لمنع القص
        const textCacheKey = `${state.ayahText}|${state.translation}|${width}|${height}|${state.fontSize}|${state.fontName}|${state.textColor}|${state.shadowColor}|${state.shadowBlur}|${state.transTextColor}|${state.transShadowColor}|${state.transShadowBlur}|${state.showTranslation}`;

        let cachedTextData = textBitmapCache.get(textCacheKey);

        if (!cachedTextData) {
            ctx.font = scaledFontSize + 'px ' + activeFont + ', Noto Sans Arabic, Amiri, serif';
            const lines = calculateTextLines(ctx, state.ayahText, width * 0.85);
            const arabicLineHeight = scaledFontSize * 1.5;
            const totalArabicHeight = lines.length * arabicLineHeight;

            let tLines = [];
            const transFS = scaledFontSize * 0.45;
            const transLineHeight = transFS * 1.4;
            let totalTransHeight = 0;
            const gap = scaledFontSize * 0.4;

            if (state.showTranslation && state.translation) {
                ctx.font = '500 ' + transFS + 'px Noto Sans Arabic';
                tLines = calculateTextLines(ctx, state.translation, width * 0.82);
                totalTransHeight = tLines.length * transLineHeight;
            }

            const totalStackHeight = totalArabicHeight + (tLines.length > 0 ? totalTransHeight + gap : 0);
            const startY = (height / 2) - (totalStackHeight / 2);

            const cacheHeight = totalStackHeight + (padding * 2);
            if (!textCacheCanvas) {
                textCacheCanvas = new OffscreenCanvas(width, cacheHeight);
                textCacheCtx = textCacheCanvas.getContext('2d');
            } else {
                textCacheCanvas.width = width;
                textCacheCanvas.height = cacheHeight;
            }

            textCacheCtx.clearRect(0, 0, width, cacheHeight);
            textCacheCtx.translate(width / 2, padding);
            textCacheCtx.textAlign = 'right';
            textCacheCtx.fillStyle = state.textColor;
            textCacheCtx.shadowBlur = state.shadowBlur * scaleFactor;
            textCacheCtx.shadowColor = state.shadowColor;
            textCacheCtx.direction = 'rtl';
            
            lines.forEach((l, i) => { 
                const y = (i + 0.7) * arabicLineHeight;
                if (l.includes('﴿') && l.includes('﴾')) {
                    const parts = l.split(/(﴿|﴾)/);
                    let totalW = 0;
                    const widths = [];
                    let isNum = false;
                    
                    parts.forEach(part => {
                        if (part === '﴿') isNum = true;
                        
                        if (part === '﴿') {
                            textCacheCtx.font = scaledFontSize + 'px "KFGQPC Uthmanic Script HAFS", "UthmanicHafs", "me_quran", Amiri, sans-serif';
                            const w = textCacheCtx.measureText('۝').width;
                            const margin = scaledFontSize * 0.15; // مسافة بسيطة لإبعاد الزخرفة عن الكلمة
                            widths.push(w + margin);
                            totalW += w + margin;
                        } else if (part === '﴾') {
                            widths.push(0);
                        } else if (isNum && part !== '') {
                            widths.push(0); // العرض 0 لأن الرقم سيُرسم داخل الدائرة ولن يأخذ مساحة إضافية
                        } else {
                            textCacheCtx.font = scaledFontSize + 'px ' + activeFont + ', Noto Sans Arabic, Amiri, serif';
                            const w = textCacheCtx.measureText(part).width;
                            widths.push(w);
                            totalW += w;
                        }
                        
                        if (part === '﴾') isNum = false;
                    });
                    
                    let currentX = totalW / 2;
                    isNum = false;
                    let circleX = 0; // لحفظ الإحداثي السيني لمركز الدائرة
                    
                    parts.forEach((part, index) => {
                        const w = widths[index];
                        if (part === '﴿') isNum = true;
                        
                        if (part === '﴿') {
                            textCacheCtx.font = scaledFontSize + 'px "KFGQPC Uthmanic Script HAFS", "UthmanicHafs", "me_quran", Amiri, sans-serif';
                            const margin = scaledFontSize * 0.15;
                            const symbolW = w - margin; // استخراج العرض الحقيقي للدائرة
                            
                            currentX -= margin; // تحريك نقطة الرسم لليسار لعمل مسافة فاصلة
                            circleX = currentX - (symbolW / 2); // تحديد مركز الدائرة بالضبط
                            // رفع الدائرة قليلاً لتتطابق مع خط الأساس للآية
                            textCacheCtx.fillText('۝', currentX, y - (scaledFontSize * 0.15));
                            currentX -= symbolW;
                        } else if (part === '﴾') {
                            // لا شيء للرسم هنا (تجاهل القوس المغلق)
                        } else if (isNum && part !== '') {
                            const numFontSize = Math.round(scaledFontSize * 0.40);
                            textCacheCtx.font = numFontSize + 'px "KFGQPC Uthmanic Script HAFS", "UthmanicHafs", "me_quran", Amiri, sans-serif';
                            const numW = textCacheCtx.measureText(part).width;
                            // رفع الرقم بنفس النسبة تقريباً ليبقى متمركزاً بدقة داخل الدائرة المرفوعة
                            textCacheCtx.fillText(part, circleX + (numW / 2), y - (scaledFontSize * 0.26));
                        } else {
                            textCacheCtx.font = scaledFontSize + 'px ' + activeFont + ', Noto Sans Arabic, Amiri, serif';
                            textCacheCtx.fillText(part, currentX, y);
                            currentX -= w;
                        }
                        
                        if (part === '﴾') isNum = false;
                    });
                } else {
                    textCacheCtx.font = scaledFontSize + 'px ' + activeFont + ', Noto Sans Arabic, Amiri, serif';
                    const w = textCacheCtx.measureText(l).width;
                    textCacheCtx.fillText(l, w / 2, y);
                }
            });

            if (tLines.length > 0) {
                const transStartY = totalArabicHeight + gap;
                textCacheCtx.font = '500 ' + transFS + 'px Noto Sans Arabic';
                textCacheCtx.direction = 'ltr';
                textCacheCtx.textAlign = 'center';
                textCacheCtx.fillStyle = state.transTextColor;
                textCacheCtx.shadowBlur = state.transShadowBlur * scaleFactor;
                textCacheCtx.shadowColor = state.transShadowColor;
                tLines.forEach((l, i) => { textCacheCtx.fillText(l, 0, transStartY + (i + 0.7) * transLineHeight); });
            }
            
            const bitmap = textCacheCanvas.transferToImageBitmap();
            cachedTextData = {
                bitmap: bitmap,
                startY: startY,
                stackHeight: totalStackHeight
            };
            
            addBitmapToCache(textCacheKey, cachedTextData);
        }

        // حساب الموضع الديناميكي بناءً على اختيار المستخدم (50% هو المنتصف)
        const dynamicStartY = (height * (state.textY / 100)) - (cachedTextData.stackHeight / 2);
        const dynamicStartX = (width * (state.textX / 100));
        contentBottom = dynamicStartY + cachedTextData.stackHeight;

        ctx.save();
        let alpha = 1, animTranslateY = 0, scale = 1;
        let isBlurActive = false;

        // تخطي حسابات الحركة المعقدة إذا اكتملت الحركة (يوفر طاقة المعالج في 95% من الإطارات)
        if (state.animProgress < 1) {
            const p = Easing.outCubic(state.animProgress);
            const type = state.animType;
            
            if (type === 'fade') alpha = p;
            else if (type === 'slide') { alpha = p; animTranslateY = (1 - p) * (state.animIntensity * 2 + 20); }
            else if (type === 'slide_down') { alpha = p; animTranslateY = -(1 - p) * (state.animIntensity * 2 + 20); }
            else if (type === 'zoom') { alpha = p; const delta = state.animIntensity / 200; scale = (1 - delta) + (p * delta); }
            else if (type === 'zoom_out') { alpha = p; const delta = state.animIntensity / 200; scale = (1 + delta) - (p * delta); }
            else if (type === 'blur') {
                alpha = p;
                const blurAmount = (1-p) * (state.animIntensity/4);
                if (blurAmount > 0.1) {
                    ctx.filter = 'blur(' + blurAmount + 'px)';
                    isBlurActive = true;
                }
            }
            else if (type === 'bounce') { alpha = Math.min(1, p*2); scale = Easing.outElastic(state.animProgress, state.animIntensity); }
        }

        ctx.globalAlpha = alpha;
        ctx.translate(dynamicStartX, dynamicStartY + animTranslateY);
        if (scale !== 1) ctx.scale(scale, scale); // تجنب عمليات المصفوفات (Matrix Operations) إذا لم تكن هناك حاجة للتحجيم

        // رسم النص من VRAM كـ ImageBitmap جاهزة بدلاً من معالجة الكانفاس في كل إطار
        if (cachedTextData && cachedTextData.bitmap) {
            ctx.drawImage(cachedTextData.bitmap, -width/2, -padding);
        }
        ctx.restore();
        ctx.filter = 'none';
    }

    // Waveform Visualization
    if (state.showWaveform && state.audioData) {
        ctx.save();
        const cx = width / 2;
        const cy = height * (state.waveformY / 100);
        const barCount = 30; // الحفاظ على عدد ثابت للموجات لمنع تمددها وتغير شكلها في الجودات العالية
        const step = Math.max(1, Math.floor(state.audioData.length / barCount));
        const spacing = 12 * scaleFactor;
        const maxH = state.waveformHeight * scaleFactor;

        ctx.fillStyle = state.waveformColor || '#ffffff';
        // إلغاء الظل تماماً للموجات أثناء التصدير لإنقاذ الأداء (تُرسم عشرات المرات كل إطار)
        ctx.shadowBlur = state.isExporting ? 0 : (5 * scaleFactor);
        ctx.shadowColor = state.waveformColor || '#ffffff';

        for (let i = 0; i < barCount; i++) {
            const val = state.audioData[i * step] || 0;
            const h = Math.max(4 * scaleFactor, (val / 255) * maxH);
            const barWidth = 6 * scaleFactor;
            ctx.fillRect(cx + (i * spacing), cy - h/2, barWidth, h);
            if (i > 0) ctx.fillRect(cx - (i * spacing), cy - h/2, barWidth, h);
        }
        ctx.restore();
    }

    // Watermark Rendering
    if (state.showWatermark) {
        ctx.save();
        ctx.globalAlpha = state.watermarkOpacity;

        // Calculate position based on percentages
        const x = width * (state.watermarkX / 100);
        const y = height * (state.watermarkY / 100);

        if (state.watermarkType === 'text' && state.watermarkText) {
            const fontSize = width * (state.watermarkSize / 100);
            ctx.font = 'bold ' + fontSize + 'px "Noto Sans Arabic", sans-serif';
            ctx.fillStyle = state.watermarkColor;
            ctx.textBaseline = 'top';
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 4 * scaleFactor;
            ctx.fillText(state.watermarkText, x, y);
        } else if (state.watermarkType === 'image' && state.watermarkBitmap) {
            const bmp = state.watermarkBitmap;
            const w = width * (state.watermarkSize / 100);
            const ratio = bmp.width / bmp.height;
            const h = w / ratio;
            ctx.drawImage(bmp, x, y, w, h);
        }
        ctx.restore();
    }

    // For free users, allow hiding the logo in preview, but force it during export.
    const forceShowLogo = state.isExporting && state.isFreePlan;
    if (forceShowLogo || state.showTarteelLogo) {
        ctx.save();
        ctx.font = 'bold ' + (36 * scaleFactor) + 'px sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 6 * scaleFactor;
        ctx.textAlign = 'center';
        ctx.fillText('Created with Tarteel Studio', width / 2, contentBottom + (90 * scaleFactor));
        ctx.restore();
    }

    // Time Indicator Overlay (Live Duration Preview)
    // لا يظهر أثناء التصدير لضمان نظافة الفيديو النهائي
    if (!state.isExporting && state.previewTimeStr) {
        ctx.save();
        const padding = 15 * scaleFactor;
        const timeFontSize = 24 * scaleFactor;
        ctx.font = 'bold ' + timeFontSize + 'px "Noto Sans Arabic", sans-serif';
        
        // تجهيز النص والأبعاد
        const timeText = state.previewTimeStr;
        const textWidth = ctx.measureText(timeText).width;
        const pillWidth = textWidth + (padding * 3);
        const pillHeight = timeFontSize + (padding * 1.5);
        const yPos = height - pillHeight - padding; // حساب الموضع ليكون أسفل الشاشة
        
        // رسم الخلفية (Pill) أسفل يمين الشاشة بلون الموقع الأزرق مع شفافية خفيفة
        ctx.fillStyle = 'rgba(0, 122, 255, 0.6)';
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(width - pillWidth - padding, yPos, pillWidth, pillHeight, pillHeight / 2);
        } else {
            const r = pillHeight / 2;
            const x = width - pillWidth - padding;
            const y = yPos;
            ctx.moveTo(x + r, y);
            ctx.arcTo(x + pillWidth, y, x + pillWidth, y + pillHeight, r);
            ctx.arcTo(x + pillWidth, y + pillHeight, x, y + pillHeight, r);
            ctx.arcTo(x, y + pillHeight, x, y, r);
            ctx.arcTo(x, y, x + pillWidth, y, r);
        }
        ctx.fill();
        
        // رسم النص الزمني بلون أبيض عادي
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(timeText, width - (pillWidth / 2) - padding, yPos + (pillHeight / 2));
        ctx.restore();
    }
}

// Smart Scheduling: Bypass background tab throttling during export!
function scheduleNextFrame() {
    if (state.isExporting && !state.isRealtimeExport) {
        // وضع السبات: إيقاف المعاينة الحية تماماً لتوفير 100% من طاقة المعالج للتصدير
        setTimeout(scheduleNextFrame, 250);
    } else {
        draw();
        // Using requestAnimationFrame saves battery when previewing normally
        requestAnimationFrame(scheduleNextFrame);
    }
}
