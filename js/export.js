import { supabaseClient, state } from './store.js';
import { UI } from './ui.js';
import { enforceSingleSession, loadUserPlan } from './auth.js';
import { initAudio, stopAudio, playSeamless, fetchAudioBuffer, fetchAudioRaw, createReverbBuffer, addToAudioCache, calculateSilence } from './audio.js';
import { loadAndSendFont } from './renderer.js';
import { getUserCapabilities, getAllowedRange } from './permissions.js';
import { exportQueue, isExporting } from './exportQueue.js';

let isQueueCallbackSet = false;
function setupQueueCallback() {
    if (isQueueCallbackSet) return;
    isQueueCallbackSet = true;
    exportQueue.onProgress = (completed, total, label) => {
        updateExportStatus(`التصدير ${completed} من ${total}...`);
    };

    exportQueue.onQueueStart = () => {
        updateExportButtonState();
    };

    exportQueue.onQueueEnd = () => {
        updateExportButtonState();
    };
    
    // ربط الإلغاء الحقيقي للطابور بالعمليات الفعلية (Worker & FFmpeg)
    exportQueue.notifyCancelled = () => {
        cancelActiveFFmpeg();
        if (state.worker) state.worker.postMessage({ type: 'abortExport' });
        setTimeout(resetExportUI, 300);
    };
}

function updateExportStatus(msg) {
    if (!UI.exportCounter) return;
    UI.exportCounter.textContent = msg;
}

let ffmpegLibPromise = null;
let ffmpegInstance = null;
let ffmpegFetchFile = null;

async function ensureFFmpegReady() {
    if (ffmpegInstance && ffmpegInstance.loaded) return { ffmpeg: ffmpegInstance, fetchFile: ffmpegFetchFile };

    if (!ffmpegLibPromise) {
        ffmpegLibPromise = (async () => {
                // 1. تحميل مكتبة FFmpeg الأساسية
                if (!window.FFmpegWASM) {
                await new Promise((resolve, reject) => {
                    const s = document.createElement("script");
                    s.src = "js/lib/ffmpeg.js";
                    s.onload = resolve;
                    s.onerror = reject;
                    document.head.appendChild(s);
                });
            }

                // 2. تحميل مكتبة Util المساعدة (والتي تحتوي على fetchFile)
                if (!window.FFmpegUtil) {
                    await new Promise((resolve, reject) => {
                        const s = document.createElement("script");
                        s.src = "js/lib/ffmpeg-util.js";
                        s.onload = resolve;
                        s.onerror = reject;
                        document.head.appendChild(s);
                    });
                }

                const { FFmpeg } = window.FFmpegWASM;
                const { fetchFile, toBlobURL } = window.FFmpegUtil;

                const ffmpeg = new FFmpeg();
                
                // التحقق من دعم SharedArrayBuffer لتفعيل النسخة متعددة المسارات (Multi-threaded)
                const isSABSupported = typeof SharedArrayBuffer !== 'undefined';
                
                if (!isSABSupported) {
                    console.warn("⚠️ SharedArrayBuffer غير مفعل! FFmpeg سيعمل على نواة واحدة (Single-thread).");
                    console.warn("لتفعيل Multi-thread يجب ضبط الـ Headers: COOP و COEP في إعدادات السيرفر واستخدام HTTPS.");
                }
                const corePrefix = isSABSupported ? '/ffmpeg/ffmpeg-core-mt' : '/ffmpeg/ffmpeg-core';
                const workerPath = isSABSupported ? '/ffmpeg/ffmpeg-core-mt.worker.js' : '/ffmpeg/worker.js';

                await ffmpeg.load({
                    coreURL: await toBlobURL(`${corePrefix}.js`, 'text/javascript'),
                    wasmURL: await toBlobURL(`${corePrefix}.wasm`, 'application/wasm'),
                    workerURL: await toBlobURL(workerPath, 'text/javascript'),
                    classWorkerURL: await toBlobURL('js/lib/814.ffmpeg.js', 'text/javascript')
            });

            ffmpegInstance = ffmpeg;
            ffmpegFetchFile = fetchFile;
            state.ffmpeg = ffmpeg;
            return { ffmpeg, fetchFile };
        })().catch((err) => {
            ffmpegLibPromise = null;
            throw err;
        });
    }

    return ffmpegLibPromise;
}

function cancelActiveFFmpeg() {
    if (!state.ffmpeg) return;
    try { state.ffmpeg.terminate(); } catch (e) {}
    state.ffmpeg = null;
    ffmpegInstance = null;
    ffmpegFetchFile = null;
    ffmpegLibPromise = null;
}

// 🔴 الحل الإجباري والاحترافي للتحكم في تزامن الفريمات (Perfect Frame Sync)
async function seekFrame(video, time) {
    return new Promise(resolve => {
        let isResolved = false;
        let timeoutId;
        const finish = () => {
            if (isResolved) return;
            isResolved = true;
            clearTimeout(timeoutId);
            resolve();
        };

        const waitForRender = () => {
            if (isResolved) return;
            
            // مهلة كافية جداً للأجهزة العادية (كمبيوتر/لابتوب) لضمان فك تشفير الإطار قبل استخراجه
            const renderTimeout = setTimeout(finish, 50);

            if ('requestVideoFrameCallback' in video && !document.hidden) {
                video.requestVideoFrameCallback(() => {
                    clearTimeout(renderTimeout);
                    finish();
                });
            }
        };

        // تجاوز الفريم لو المشغل عليه نفس التوقيت بالفعل وانتهى من البحث تماماً
        if (Math.abs(video.currentTime - time) < 0.001 && !video.seeking) {
            waitForRender();
            return;
        }

        const onSeeked = () => {
            if (isResolved) return;
            video.removeEventListener('seeked', onSeeked);
            waitForRender();
        };

        video.addEventListener('seeked', onSeeked);
        video.currentTime = time;
        
        timeoutId = setTimeout(() => {
            if (!isResolved) {
                video.removeEventListener('seeked', onSeeked);
                finish();
            }
        }, 15000); // مهلة طويلة جداً (15 ثانية) لمنع التعليق، وتقليلها يسبب تقطيع الفريمات في الفيديوهات الثقيلة
    });
}

export async function audioBufferToWavBytes(audioBuffer, onProgress) {
    const numberOfChannels = 2;
    const sampleRate = audioBuffer.sampleRate;
    const frameCount = audioBuffer.length;
    const bytesPerSample = 2;
    const blockAlign = numberOfChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const buffer = new ArrayBuffer(44 + (frameCount * blockAlign));
    const view = new DataView(buffer);

    const writeString = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + (frameCount * blockAlign), true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numberOfChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, frameCount * blockAlign, true);

    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
    
    const int16View = new Int16Array(buffer, 44);
    let offset = 0;

    // تقسيم المعالجة لتجنب تجميد الواجهة (تهنيج المتصفح)
    const chunkSize = 100000;
    for (let start = 0; start < frameCount; start += chunkSize) {
        const end = Math.min(start + chunkSize, frameCount);
        for (let i = start; i < end; i++) {
            const l = Math.max(-1, Math.min(1, left[i] || 0));
            const r = Math.max(-1, Math.min(1, right[i] || 0));
            int16View[offset++] = l < 0 ? l * 0x8000 : l * 0x7FFF;
            int16View[offset++] = r < 0 ? r * 0x8000 : r * 0x7FFF;
        }
        if (onProgress) onProgress(end / frameCount);
            // استخدام setTimeout بدلاً من rAF لمنع توقف التصدير عند تصغير المتصفح أو فتح تبويب آخر
            await new Promise(res => setTimeout(res, 0));
    }

    return new Uint8Array(buffer);
}

async function cleanupFFmpegFiles(ffmpeg, files) {
    for (const file of files) {
        try { await ffmpeg.deleteFile(file); } catch (e) {}
    }
}

async function finalizeWithFFmpeg(videoBlob, wavBytes, sampleRate) {
    updateExportStatus('جاري الدمج النهائي ...');
    UI.exportProgressBar.style.width = '85%';
    UI.exportPercent.textContent = '85%';

    const { ffmpeg, fetchFile } = await ensureFFmpegReady();
    if (exportQueue.isCancelled) throw new Error('تم إلغاء التصدير.');

    const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inputVideo = `video-${uid}.mp4`;
    const inputAudio = `audio-${uid}.wav`;
    const outputVideo = `final-${uid}.mp4`;

    const onProgress = ({ progress }) => {
        const ffmpegProgress = Math.max(0, Math.min(1, Number(progress) || 0));
        const percent = 85 + Math.round(ffmpegProgress * 15);
        UI.exportProgressBar.style.width = `${percent}%`;
        UI.exportPercent.textContent = `${percent}%`;
        updateExportStatus('جاري الدمج النهائي ...');
    };

    ffmpeg.on('progress', onProgress);
    try {
        await ffmpeg.writeFile(inputVideo, await fetchFile(videoBlob));
        await ffmpeg.writeFile(inputAudio, wavBytes);

        const exitCode = await ffmpeg.exec([
            '-i', inputVideo,
            '-i', inputAudio,
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-ar', String(sampleRate),
            '-ac', '2',
            '-af', 'aresample=async=1:first_pts=0',
            '-threads', '0',
            '-movflags', '+faststart',
            outputVideo
        ]);

        if (exitCode !== 0) throw new Error('Failed to produce the final MP4 file.');

        const outData = await ffmpeg.readFile(outputVideo);
        const uint8 = outData instanceof Uint8Array ? outData : new Uint8Array(outData);
        return new Blob([uint8], { type: 'video/mp4' });
    } finally {
        ffmpeg.off('progress', onProgress);
        await cleanupFFmpegFiles(ffmpeg, [inputVideo, inputAudio, outputVideo]);
    }
}

function createOfflineAudioGraph(context, audioConfig = DEFAULT_AUDIO_CONFIG) {
    const graph = {};
    graph.audioGain = context.createGain();
    graph.effectEntry = context.createGain();
    graph.dryGain = context.createGain();
    graph.wetGain = context.createGain();

    graph.convolver = context.createConvolver();
    const revConf = audioConfig.reverbType || DEFAULT_AUDIO_CONFIG.reverbType;
    graph.convolver.buffer = createReverbBuffer(context, revConf.duration, revConf.decay);

    graph.compressor = context.createDynamicsCompressor();
    graph.makeupGain = context.createGain();
    graph.limiter = context.createDynamicsCompressor();

    // Connections
    graph.effectEntry.connect(graph.dryGain);
    graph.dryGain.connect(graph.audioGain);
    graph.effectEntry.connect(graph.convolver);
    graph.convolver.connect(graph.wetGain);
    graph.wetGain.connect(graph.audioGain);
    graph.audioGain.connect(graph.compressor);
    graph.compressor.connect(graph.makeupGain);
    graph.makeupGain.connect(graph.limiter);
    graph.limiter.connect(context.destination);

    // --- Configure Parameters ---
    const currentTime = 0; // For OfflineAudioContext, time starts at 0

    // Compressor
    const compConf = audioConfig.compressor || DEFAULT_AUDIO_CONFIG.compressor;
    graph.compressor.threshold.setValueAtTime(compConf.threshold, currentTime);
    graph.compressor.ratio.setValueAtTime(compConf.ratio, currentTime);
    graph.compressor.attack.setValueAtTime(compConf.attack, currentTime);
    graph.compressor.release.setValueAtTime(compConf.release, currentTime);

    // Limiter (Brickwall)
    const limConf = audioConfig.limiter || DEFAULT_AUDIO_CONFIG.limiter;
    graph.limiter.threshold.setValueAtTime(limConf.threshold, currentTime);
    graph.limiter.ratio.setValueAtTime(limConf.ratio, currentTime);
    graph.limiter.attack.setValueAtTime(limConf.attack, currentTime);
    graph.limiter.release.setValueAtTime(limConf.release, currentTime);

    // Effects based on config
    const reverbEnabled = audioConfig.reverbEnabled;
    const intensity = audioConfig.reverbIntensity;

    const makeupConf = audioConfig.makeupGain || DEFAULT_AUDIO_CONFIG.makeupGain;
    const makeup = reverbEnabled ? makeupConf.withReverb : makeupConf.withoutReverb;

    graph.makeupGain.gain.setValueAtTime(makeup, currentTime);
    
    // استخدام منحنى غير خطي (Non-linear) لواقعية الصوت (Audio Engineering Standard)
    const wetLevel = Math.pow(intensity, 2) * 2.0;
    // تقليل الصوت الأصلي (Dry) تدريجياً مع زيادة الصدى للحفاظ على التوازن
    const dryLevel = reverbEnabled ? 1 - (intensity * 0.5) : 1;
    
    graph.dryGain.gain.setValueAtTime(dryLevel, currentTime);
    graph.wetGain.gain.setValueAtTime(reverbEnabled ? wetLevel : 0, currentTime);

    const cleanupGraph = () => {
        const nodes = [graph.effectEntry, graph.dryGain, graph.wetGain, graph.convolver, graph.audioGain, graph.compressor, graph.makeupGain, graph.limiter];
        nodes.forEach(node => {
            if (node) {
                try { node.disconnect(); } catch (e) {}
            }
        });
    };

    return { entryNode: graph.effectEntry, cleanupGraph };
}

export const DEFAULT_AUDIO_CONFIG = {
    reverbEnabled: false,
    reverbIntensity: 0.5,
    reverbType: { duration: 3.0, decay: 3.0 }, // Large Hall Preset
    compressor: { threshold: -20, ratio: 2.5, attack: 0.01, release: 0.4 },
    limiter: { threshold: -1, ratio: 20, attack: 0.001, release: 0.05 },
    makeupGain: { withReverb: 1.25, withoutReverb: 1.5 }
};

export function getAudioConfigFromUI() {
    try {
        const intensity = parseFloat(UI.reverbRange.value);
        return {
            // نرث جميع الإعدادات الافتراضية (Compressor/Limiter)
            ...DEFAULT_AUDIO_CONFIG,
            reverbEnabled: UI.reverbToggle.checked,
            reverbIntensity: isNaN(intensity) ? DEFAULT_AUDIO_CONFIG.reverbIntensity : intensity
        };
    } catch (e) {
        // Fallback آمن للبيئات التي لا تحتوي على DOM أو في حالة فقدان العنصر
        return { ...DEFAULT_AUDIO_CONFIG };
    }
}

export function getSupportedMimeType() {
    // ترتيب الأولويات: MP4 لضمان عمل الفيديو عند 99% من المستخدمين
    const types = ['video/mp4;codecs=h264,aac', 'video/mp4', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
    for (const type of types) {
        if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type)) return type;
    }
    return 'video/mp4;codecs=h264,aac'; // Fallback إجباري
}

function validateExport(caps, config) {
    if (!caps.canExport) return { type: 'limit' };

    // أمان إضافي: إذا كان الحساب مجانياً، نرفض الميزات المدفوعة فوراً 
    // حتى لو تم التلاعب بالخصائص الفردية (canUploadAudio وغيرها) في الذاكرة المحلية
    const isStrictFree = caps.isFree;

    if (config.wantsLocalAudio && (isStrictFree || !caps.canUploadAudio)) return { type: 'audio' };
    if (config.wantsWaveform && (isStrictFree || !caps.canShowWaveform)) return { type: 'waveform' };
    if (config.wantsWatermark && (isStrictFree || !caps.canShowWatermark)) return { type: 'watermark' };
    if (config.wantsNoBranding && (isStrictFree || !caps.canRemoveBranding)) return { type: 'branding' };
    
    const { end: allowedEnd } = getAllowedRange(config.startIdx, config.endIdx, caps);
    if (config.endIdx > allowedEnd) return { type: 'limit', allowedEnd };

    return null;
}

function showProModal(type, data = {}) {
    if (type === 'limit') {
        UI.limitModal.style.display = 'flex';
        return;
    }
    const messages = {
        'audio': "رفع صوتك الخاص مع التزامن التلقائي هيخلي الفيديو مميز وفريد 🔥\nدي مش مجرد ميزة… دي اللي بتفرقك عن باقي المحتوى.\nفعّل Pro وابدأ تستخدم صوتك في الفيديوهات.",
        'waveform': "الموجات الصوتية بتخلي الفيديو احترافي وجذاب زي فيديوهات كبار صناع المحتوى 🔥\nجرّبتها بنفسك وشفت الفرق…\nفعّل Pro دلوقتي وصدّر الفيديو بنفس الجودة.",
        'watermark': "إضافة شعارك الخاص (Watermark) بيحفظ حقوقك ويثبت هويتك الرقمية 🔥\nفعّل Pro دلوقتي وضيف علامتك المائية على كل فيديوهاتك.",
        'branding': "ظهور شعار Tarteel بيقلل احترافية الفيديو لو هتنشره على السوشيال\nفعّل Pro عشان تصدّر الفيديو بدون أي علامات وبشكل احترافي كامل."
    };
    UI.proFeatureMsg.textContent = messages[type];
    UI.proFeatureModal.style.display = 'flex';
    if (window.lucide) window.lucide.createIcons();
}

export async function secureExport(label = 'تصدير') {
    setupQueueCallback();

    // إرجاع نتيجة التصدير (Blob URL) أو رسالة الخطأ
    return new Promise((resolve, reject) => {
        // تمرير الوظيفة إلى الكيو للتنفيذ التتابعي
        exportQueue.add(async () => {
            try {
                if (exportQueue.isCancelled) throw new Error('Cancelled');
                const result = await _secureExportImpl();
                resolve(result);
            } catch (e) {
                reject(e);
            } finally {
                updateExportButtonState();
            }
        }, label).catch(reject);
    });
}

// النسخة الداخلية التي تُنفذ داخل الـ Queue
async function _secureExportImpl() {
    const originalBtnHTML = UI.startExportBtn.innerHTML;
    
    // دالة مساعدة لإرجاع حالة الأزرار لطبيعتها
    const restoreUI = () => {
        UI.startExportBtn.disabled = false;
        UI.startExportBtn.innerHTML = originalBtnHTML;
        if (UI.confirmNo) {
            UI.confirmNo.disabled = false;
            UI.confirmNo.classList.remove('opacity-50', 'cursor-not-allowed');
        }
        const formatContainer = document.getElementById('exportFormatContainer');
        if (formatContainer) {
            formatContainer.style.pointerEvents = 'auto';
            formatContainer.style.opacity = '1';
        }
    };

    UI.startExportBtn.disabled = true;
    UI.startExportBtn.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin inline-block align-middle ml-2"></i> جاري التحقق...';
    if (UI.confirmNo) {
        UI.confirmNo.disabled = true;
        UI.confirmNo.classList.add('opacity-50', 'cursor-not-allowed');
    }
    const formatContainer = document.getElementById('exportFormatContainer');
    if (formatContainer) {
        formatContainer.style.pointerEvents = 'none';
        formatContainer.style.opacity = '0.5';
    }
    if (window.lucide) window.lucide.createIcons();

    // إعطاء فرصة للمتصفح لتحديث الواجهة وإظهار شاشة التحميل فوراً
    await new Promise(r => setTimeout(r, 10));

    stopAudio();

    // إيقاف أي مصدر صوتي فعال وتدمير AudioContext بالكامل لضمان بيئة نظيفة خالية من التداخلات أو التكرار
    if (state.activeSource) {
        try { state.activeSource.stop(); } catch(e) {}
        state.activeSource = null;
    }
    if (state.audioContext) {
        try {
            state.audioContext.close();
        } catch(e) {}
        state.audioContext = null;
    }

    // --- الحل الجذري لمشكلة التعليق ---
    // تهيئة الصوت فوراً بمجرد نقر المستخدم وقبل انتظار رد الخادم.
    // هذا يضمن أخذ "إذن" المتصفح لتشغيل الصوت قبل أن تضيع النقرة بسبب الانتظار.
    await initAudio();

    // --- Smart Caching for Verification ---
    const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
    let isCacheValid = state.planLastChecked && (Date.now() - state.planLastChecked < CACHE_DURATION);

    // فحص أمني: إذا كانت الخطة مجانية ولكن الصلاحيات تبدو معدلة، نجبر التطبيق على التحقق من السيرفر
    let caps = getUserCapabilities();
    if (caps.isFree && (caps.exportLimit > 5 || caps.canRemoveBranding || caps.canUploadAudio)) {
        isCacheValid = false;
    }

    // Only re-validate if the cache is expired
    if (!isCacheValid) {
        try {
            // وضع جميع طلبات الخادم داخل مهلة زمنية موحدة (3.5 ثواني) لتجنب التعليق
            const verifyTask = async () => {
                if (state.user) {
                    const { data: { user } } = await supabaseClient.auth.getUser();
                    if (user) {
                        const isValid = await enforceSingleSession(user);
                        if (!isValid) return false;
                    }
                }
                await loadUserPlan();
                return true;
            };

            const result = await Promise.race([
                verifyTask(),
                new Promise((resolve) => setTimeout(() => resolve('timeout'), 3500))
            ]);

            if (result === false) {
                restoreUI();
                updateExportButtonState();
                return;
            }

            // Refresh caps after potentially updating the plan from the server
            caps = getUserCapabilities();
        } catch (e) {
            console.warn("تأخر التحقق من الشبكة، سيتم الاعتماد على حالة الاشتراك المخزنة:", e);
        }
    }

    const sVal = parseInt(UI.vStart.value) || 1;
    const eVal = parseInt(UI.vEnd.value) || state.ayahs.length;
    const startIdx = sVal - 1;
    const endIdx = eVal;

    const exportConfig = {
        startIdx,
        endIdx,
        wantsLocalAudio: state.audioMode === 'local',
        wantsWaveform: UI.showWaveform.checked,
        wantsWatermark: UI.showWatermark.checked,
        wantsNoBranding: !UI.showTarteelLogo.checked
    };

    let serverVerified = false;
    
    // فلتر ذكي: إذا كان التصدير ضمن الحدود المجانية بالكامل، فلا داعي لاستهلاك السيرفر
    const isBasicFreeRequest = (exportConfig.endIdx - exportConfig.startIdx) <= 5 && 
                               !exportConfig.wantsLocalAudio && 
                               !exportConfig.wantsWaveform && 
                               !exportConfig.wantsWatermark && 
                               !exportConfig.wantsNoBranding;

    if (state.user && supabaseClient && !isBasicFreeRequest) {
        const timeoutDuration = isCacheValid ? 1500 : 4000;

        try {
            const rpcPromise = supabaseClient.rpc('verify_export_request', {
                user_id: state.user.id,
                config: exportConfig
            });
            
            const { data, error: rpcError } = await Promise.race([
                rpcPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutDuration))
            ]);

            if (rpcError) throw rpcError;

            if (data && data.allowed === false) {
                restoreUI();
                UI.confirmModal.style.display = 'none';
                updateExportButtonState();
                showProModal(data.reason || 'limit', data);
                return;
            }
            
            state.exportMode = data?.exportMode || 'free';
            serverVerified = true;
        } catch (e) {
            console.warn("Server verification failed or timed out, using local validation:", e);
        }
    }

    if (!serverVerified) {
        
        // في حالة فشل التحقق من السيرفر (مثل انقطاع الإنترنت أو خطأ في الدالة)، 
        // نعتمد على الصلاحيات المخزنة حالياً لتجنب إيقاف مميزات المشتركين.

        const error = validateExport(caps, exportConfig);
        if (error) {
            restoreUI();
            UI.confirmModal.style.display = 'none';
            updateExportButtonState();
            showProModal(error.type, error);
            return;
        }

        state.exportMode = caps.isFree ? 'free' : 'pro';
    }

    // --- All checks passed securely ---
    restoreUI();
    UI.confirmModal.style.display = 'none';
    if (exportQueue.isCancelled) throw new Error('Cancelled');

    // تفريغ الفيديو القديم من الذاكرة فقط بعد اجتياز جميع الفحوصات وقبل البدء الفعلي
    if (state.exportBlobUrl) {
        try { URL.revokeObjectURL(state.exportBlobUrl); } catch(e) {}
        state.exportBlobUrl = null;
    }

    return await realExport(caps);
}

export async function realExport(validatedCaps) {
    const caps = validatedCaps || getUserCapabilities();
    window.onbeforeunload = null; // إزالة الرسالة التحذيرية المزعجة للمتصفح

    // إضافة زر إنهاء التصدير ديناميكياً لتجنب تعديل الـ HTML
    let cancelBtn = document.getElementById('cancelExportBtnDynamic');
    if (!cancelBtn) {
        cancelBtn = document.createElement('button');
        cancelBtn.id = 'cancelExportBtnDynamic';
        cancelBtn.className = 'mt-6 px-6 py-2 border border-red-500/30 text-red-500 hover:bg-red-500/10 rounded-xl font-bold transition-all text-sm mx-auto block';
        cancelBtn.textContent = 'إلغاء التصدير';
        cancelBtn.onclick = () => {
            if (!isExporting()) return;
            cancelBtn.textContent = 'جاري الإيقاف...';
            cancelBtn.disabled = true;
            exportQueue.cancelAll(); // يفرغ الطابور ويوقف المهمة الحالية من جذورها
        };
        UI.exportProcessingUI.appendChild(cancelBtn);
    } else {
        cancelBtn.textContent = 'إلغاء التصدير';
        cancelBtn.disabled = false;
        cancelBtn.style.display = 'block';
    }
    
    if (exportQueue.isCancelled) return; // التوقف إذا تم الإلغاء أثناء التحميل

    // تصفير شريط التقدم فوراً قبل إظهار الواجهة وقبل أي أوامر (await) لمنع الحركة العكسية
    UI.exportProgressBar.style.transition = 'none';
    UI.exportProgressBar.style.width = "0%";
    UI.exportPercent.textContent = "0%";
    updateExportStatus("جاري تجهيز الصوت والخطوط...");

    UI.sidebar.classList.add('sidebar-disabled'); UI.playBtn.disabled = true; UI.playBtn.style.opacity = "0";
    UI.exportOverlay.style.display = "flex"; UI.exportProcessingUI.classList.remove('hidden'); UI.exportFinishedUI.classList.add('hidden');

    // إجبار المتصفح على التحديث فوراً ثم إرجاع تأثير الحركة السلسة لباقي التصدير
    void UI.exportProgressBar.offsetWidth; 
    UI.exportProgressBar.style.transition = '';

    // إيقاف تشغيل الفيديو التلقائي للتحكم اليدوي الدقيق في الوقت والإطارات (Manual Frame Extraction)
    if (state.mediaType === 'video' && state.bgVideo) {
        if (!state.bgVideo.paused) state.bgVideo.pause();
        
        // 🔴 الحل السحري لمشكلة تجميد الفيديو على جوجل كروم للأجهزة العادية:
        // كروم يقوم بتجميد الفيديوهات الشفافة جداً أو متناهية الصغر لتوفير الموارد.
        // لنجبره على معالجة الإطارات بدقة، نرفع الشفافية والحجم أثناء التصدير.
        state.bgVideo.style.opacity = '1';
        state.bgVideo.style.width = '320px';
        state.bgVideo.style.height = '240px';
    }

    let FPS = state.exportFPS || 30; // جلب معدل الإطارات المختار
    const rawStartIdx = (parseInt(UI.vStart.value) || 1) - 1;
    const rawEndIdx = parseInt(UI.vEnd.value) || state.ayahs.length;
    const { start: startIdx, end: endIdx } = getAllowedRange(rawStartIdx, rawEndIdx, caps);

    // حساب وتطبيق أبعاد التصدير بناءً على الجودة المختارة
    const size = UI.canvasSize.value;

    // --- Step 1: Configuration & Resolution ---
    const { exportW, exportH, FPS: adjustedFPS, dynamicBitrate, finalVideoCodecConfig } = await getExportVideoConfig(size, state.exportQuality, FPS);
    FPS = adjustedFPS;

    // إخبار المعالج بتغيير الأبعاد لتتناسب مع دقة التصدير المختارة
    state.worker.postMessage({ type: 'resize', width: exportW, height: exportH });

    // --- Step 2: Preload Fonts ---
    await preloadExportFonts(startIdx, endIdx);

    // فك التشفير هنا فقط عند التصدير للملفات المحلية لمنع استهلاك الرام في المحرر
    if (state.audioMode === 'local' && state.localAudioFile && !state.localAudioBuffer) {
        UI.exportCounter.textContent = "جاري تهيئة الصوت للتصدير...";
        // سيتم فك التشفير تدريجياً (Streaming) في مرحلة التجهيز لمنع انهيار الرام
    }

    // --- Step 3: Calculate Audio Timings ---
    const { offlineDuration, onlineVerseTimings } = await calculateExportAudioTimings(startIdx, endIdx);

    // إذا قام المستخدم بإلغاء التصدير أثناء مرحلة حساب التوقيت، نخرج بصمت دون إظهار رسالة خطأ
    if (exportQueue.isCancelled) return;

    if (offlineDuration <= 0) {
        alert("لا يمكن حساب مدة الفيديو. يرجى التأكد من التوقيتات الصوتية.");
        resetExportUI();
        return;
    }

    // --- MediaRecorder Fallback (للمتصفحات التي لا تدعم WebCodecs مثل Firefox) ---
    if (typeof window.VideoEncoder === 'undefined') {
        return await executeMediaRecorderFallback(exportW, exportH, FPS, dynamicBitrate, offlineDuration, startIdx);
    }
    // --- End MediaRecorder Fallback ---

    // --- Step 4: Render Offline Audio (WAV Generation) ---
    const sampleRate = 44100;
    const audioConfig = getAudioConfigFromUI();
    const audioResult = await processOfflineAudio(offlineDuration, onlineVerseTimings, startIdx, endIdx, sampleRate, audioConfig);
    
    if (!audioResult) return;
    const { wavBuffer, totalSamples } = audioResult;
    
    if (exportQueue.isCancelled) return;
    const totalFrames = Math.floor(offlineDuration * FPS);
    
    const precomputedWaveData = UI.showWaveform.checked 
        ? precomputeAllWaveData(wavBuffer, totalFrames, FPS, sampleRate, totalSamples)
        : null;

    const useFFmpegEncoder = true; // الاعتماد على WebCodecs و mp4-muxer لتسريع التصدير
    let useNativeAudio = false;

    try {
        // --- Step 2: Initialize video-only MP4 muxer ---
        let Muxer, ArrayBufferTarget, muxerTarget, muxer, videoCodecConfig;

        if (!useFFmpegEncoder) {
        videoCodecConfig = finalVideoCodecConfig;

        const MP4Muxer = await import('./lib/mp4-muxer.js');
        if (exportQueue.isCancelled) return;
        Muxer = MP4Muxer.Muxer;
        ArrayBufferTarget = MP4Muxer.ArrayBufferTarget;
        muxerTarget = new ArrayBufferTarget();

        if (state.exportDevice === 'android') {
            if (window.AudioEncoder) {
                const support = await AudioEncoder.isConfigSupported({
                    codec: 'opus',
                    sampleRate: sampleRate,
                    numberOfChannels: 2
                });
                if (support.supported) {
                    useNativeAudio = true;
                } else {
                    console.warn("Opus encoding not supported natively, falling back to alternative encoder.");
                    state.exportDevice = 'apple';
                }
            } else {
                console.warn("AudioEncoder not supported natively, falling back to alternative encoder.");
                state.exportDevice = 'apple';
            }
        }

        muxer = new Muxer({
            target: muxerTarget,
            video: { codec: 'avc', width: exportW, height: exportH },
            audio: useNativeAudio ? { codec: 'opus', numberOfChannels: 2, sampleRate: sampleRate } : undefined,
            fastStart: 'in-memory'
        });

        if (useNativeAudio) {
            updateExportStatus("جاري ترميز الصوت...");
            const audioEncoder = new AudioEncoder({
                output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
                error: e => console.error("Audio encode error:", e)
            });
            audioEncoder.configure({
                codec: 'opus',
                sampleRate: sampleRate,
                numberOfChannels: 2,
                bitrate: 128000
            });

            const int16View = new Int16Array(wavBuffer);
            const headerOffsetInt16 = 22;

            const chunkSize = sampleRate; // 1 second chunks
            const length = totalSamples;
            for (let start = 0; start < length; start += chunkSize) {
                if (exportQueue.isCancelled) break;
                const end = Math.min(start + chunkSize, length);
                const frameCount = end - start;
                const planarData = new Float32Array(frameCount * 2);
                
                let offset = headerOffsetInt16 + (start * 2);
                for (let i = 0; i < frameCount; i++) {
                    planarData[i] = int16View[offset] / 32768.0;
                    planarData[frameCount + i] = int16View[offset + 1] / 32768.0;
                    offset += 2;
                }

                const audioData = new AudioData({
                    format: 'f32-planar',
                    sampleRate: sampleRate,
                    numberOfFrames: frameCount,
                    numberOfChannels: 2,
                    timestamp: Math.round((start / sampleRate) * 1_000_000),
                    data: planarData
                });

                audioEncoder.encode(audioData);
                audioData.close();
                
                // تحديث المؤشر أثناء الترميز لمنع تجميد الواجهة
                const encProgress = 25 + Math.round((start / length) * 5);
                UI.exportProgressBar.style.width = `${encProgress}%`;
                UI.exportPercent.textContent = `${encProgress}%`;

                if (start % (sampleRate * 5) === 0) await new Promise(r => setTimeout(r, 0));
            }
            if (!exportQueue.isCancelled) {
                await audioEncoder.flush();
                UI.exportProgressBar.style.width = "30%";
                UI.exportPercent.textContent = "30%";
            }
            if (audioEncoder.state !== 'closed') {
                try { audioEncoder.close(); } catch(e) {}
            }
        }

        // --- Step 3: Initialize VideoEncoder (in worker) ---
        state.worker.postMessage({
            type: 'initExport',
            config: videoCodecConfig,
            fps: FPS
        });
        } else {
            updateExportStatus("جاري تهيئة بيئة التصدير...");
            await ensureFFmpegReady();
            state.worker.postMessage({
                type: 'initFFmpegExport',
                fps: FPS
            });
        }

        const bgFrameCacheKeys = new Set();
        const MAX_BG_CACHE = 60; // التزامن مع حجم الكاش في الـ Worker

        // --- Step 5: The Render Loop Conductor ---
        let currentFrame = 0;
        let lastAyahForKeyframe = -1;
        let fallbackCanvas = null;
        let fallbackCtx = null;
        const renderNextFrame = async () => {
            // التحقق مما إذا كان المستخدم قد ضغط على إلغاء التصدير
            if (exportQueue.isCancelled) {
                return;
            }


            if (currentFrame >= totalFrames) {
                state.worker.postMessage({ type: 'finishExport' });
                return;
            }

            const timestampSec = currentFrame / FPS;
            const timestampUs = Math.round(timestampSec * 1_000_000);

            // --- تحديث إطار الفيديو الخلفي لمزامنته مع التصدير ---
            if (state.mediaType === 'video' && state.bgVideo && state.bgVideo.readyState >= 2) {
                const vidDuration = (isNaN(state.bgVideo.duration) || state.bgVideo.duration === 0) ? 1 : state.bgVideo.duration;
                const targetTime = timestampSec % vidDuration;
                
                // 💡 إنشاء مفتاح فريد للفريم بناءً على الوقت بأقصى دقة (ملي ثانية) لمنع تداخل الفريمات
                const cacheKey = `frame_${Math.round(targetTime * 1000)}`;
                
                if (bgFrameCacheKeys.has(cacheKey)) {
                    // ✅ الفريم موجود! متعيدش Decode، ارسم مباشرة
                    state.worker.postMessage({ type: 'useCachedBg', cacheKey: cacheKey, timestamp: timestampUs });
                } else {
                // 🔴 استخدام الدالة المخصصة لانتظار الـ Decoding 
                await seekFrame(state.bgVideo, targetTime);
                if (exportQueue.isCancelled) return; // 🛑 الخروج فوراً لتجنب إكمال معالجة الإطار بعد الإلغاء
                try {
                    let frameSent = false;
                    
                    // 🔴 الحل القاطع لمشكلة تجميد الفيديو كصورة على الموبايل (سفاري/أندرويد)
                    // هو إجبار المتصفح على رسم الإطار على Canvas بدلاً من أخذه من المشغل مباشرة،
                    // لأن بعض المتصفحات تحتفظ بأول فريم فقط إذا كان الفيديو متوقفاً (Paused)
                    if (!fallbackCanvas) {
                        fallbackCanvas = document.createElement('canvas');
                        fallbackCtx = fallbackCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
                    }
                    fallbackCanvas.width = state.bgVideo.videoWidth || exportW;
                    fallbackCanvas.height = state.bgVideo.videoHeight || exportH;
                    fallbackCtx.drawImage(state.bgVideo, 0, 0, fallbackCanvas.width, fallbackCanvas.height);

                    if (window.VideoFrame) {
                        try {
                            const frame = new VideoFrame(fallbackCanvas, { timestamp: timestampUs });
                            state.worker.postMessage({ type: 'bgFrame', bitmap: frame, timestamp: timestampUs, cacheKey: cacheKey }, [frame]);
                            frameSent = true;
                        } catch (err) {
                            console.warn("VideoFrame extraction failed, falling back to ImageBitmap");
                        }
                    }
                    if (!frameSent) {
                        let bmp = await createImageBitmap(fallbackCanvas);
                        if (bmp) {
                            state.worker.postMessage({ type: 'bgFrame', bitmap: bmp, timestamp: timestampUs, cacheKey: cacheKey }, [bmp]);
                            frameSent = true;
                        }
                    }
                    if (frameSent) {
                        bgFrameCacheKeys.add(cacheKey);
                        if (bgFrameCacheKeys.size > MAX_BG_CACHE) {
                            bgFrameCacheKeys.delete(bgFrameCacheKeys.keys().next().value); // تفريغ أقدم مفتاح
                        }
                    }
                } catch (e) {
                    console.warn("Background frame extraction error:", e);
                }
              }
            }
            // ----------------------------------------------------

            // --- Calculate exact state for this frame (Moved up for UI Sync) ---
            let currentAyahGlobalIndex = startIdx, timeIntoAyah = timestampSec;
            if (state.audioMode === 'local') {
                const relativeTimings = state.timings.slice(startIdx, endIdx + 1).map(t => t - (state.timings[startIdx] || 0));
                let found = false;
                for (let i = 0; i < relativeTimings.length - 1; i++) {
                    if (timestampSec >= relativeTimings[i] && (relativeTimings[i+1] === undefined || timestampSec < relativeTimings[i+1])) {
                        currentAyahGlobalIndex = startIdx + i; timeIntoAyah = timestampSec - relativeTimings[i]; 
                        found = true;
                        break;
                    }
                }
                if (!found && relativeTimings.length > 1) {
                    const lastIdx = relativeTimings.length - 2;
                    currentAyahGlobalIndex = startIdx + lastIdx;
                    timeIntoAyah = timestampSec - relativeTimings[lastIdx];
                }
            } else {
                let found = false;
                for(let j = 0; j < onlineVerseTimings.length - 1; j++) {
                    if (timestampSec >= onlineVerseTimings[j].start && timestampSec < onlineVerseTimings[j+1].start) {
                        currentAyahGlobalIndex = onlineVerseTimings[j].index;
                        timeIntoAyah = timestampSec - onlineVerseTimings[j].start;
                        found = true;
                        break;
                    }
                }
                if (!found && onlineVerseTimings.length > 1) {
                    const lastIdx = onlineVerseTimings.length - 2;
                    currentAyahGlobalIndex = onlineVerseTimings[lastIdx].index;
                    timeIntoAyah = timestampSec - onlineVerseTimings[lastIdx].start;
                }
            }

            // تقسيم شريط التقدم بمرونة بناءً على استخدام الترميز الصوتي أو عدمه
            const baseProgress = useNativeAudio ? 30 : 25;
            const progressRange = 85 - baseProgress;
            const progress = baseProgress + Math.round((currentFrame / totalFrames) * progressRange);
            
            // تحسين: تحديث شريط التقدم كل 3 إطارات ليتزامن مع دورة إرسال البيانات (Batch)
            if (currentFrame % 3 === 0 || currentFrame === totalFrames - 1) {
                const totalVerses = endIdx - startIdx;
                const currentVerse = Math.min(totalVerses, currentAyahGlobalIndex - startIdx + 1);
                UI.exportProgressBar.style.width = `${progress}%`; UI.exportPercent.textContent = `${progress}%`; updateExportStatus(`الآية ${currentVerse} من ${totalVerses}`);
            }

            // استخراج بيانات الترددات الحقيقية للموجة (محاكاة دقيقة لـ AnalyserNode)
            if (precomputedWaveData && precomputedWaveData[currentFrame]) {
                state.worker.postMessage({ type: 'audioData', data: precomputedWaveData[currentFrame] });
            } else {
                if (currentFrame === 0) state.worker.postMessage({ type: 'audioData', data: null });
            }

            const animProgress = Math.min(timeIntoAyah / 0.5, 1.0); // 0.5s fade-in
            const ayah = state.ayahs[currentAyahGlobalIndex];
            const s = state.surahs.find(x => x.id == state.selectedSurah);
            let v = UI.fontVersion.value;
            const pageNum = ayah ? ayah.page_number : 1;

            if (v === 'v2' && s && [80, 83, 84, 87, 88, 89, 90, 92, 94, 96, 98, 100].includes(parseInt(s.id))) {
                v = 'v1';
            }

            let fontName, fontUrl, rawText;
            if (v === 'mushaf') { fontName = 'AlMushaf'; fontUrl = new URL('fonts/AlMushaf/AlMushaf.woff2', window.location.href).href; rawText = ayah ? ayah.text_uthmani : ''; }
            else { fontName = `QuranPage${v.toUpperCase()}_${pageNum}`; fontUrl = new URL(`fonts/${v}/p${pageNum}.woff2`, window.location.href).href; rawText = ayah ? ((v === 'v2') ? ayah.code_v2 : ayah.code_v1) : ''; }

            const payload = {
                mediaType: state.mediaType,
                bgX: state.bgX, bgY: state.bgY, zoom: state.zoom, blur: state.blur, overlayOpacity: state.overlayOpacity, fitMode: 'cover',
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
            showBasmala: UI.showBasmala.checked, basmalaNumber: parseInt(UI.basmalaNumber.value) || 1, basmalaX: parseInt(UI.basmalaX.value), basmalaY: parseInt(UI.basmalaY.value), basmalaSize: parseInt(UI.basmalaSize.value), basmalaColor: UI.basmalaColor.value, basmalaShadowColor: UI.basmalaShadowColor.value, basmalaShadowBlur: parseInt(UI.basmalaShadowBlur.value),
                isFreePlan: !caps.canRemoveBranding, isExporting: true,
                animProgress: animProgress, resetAnim: false
            };

            // ⚠️ ملاحظة معمارية (Architecture Note): لا تقم باستخدام Object.freeze(payload) هنا أبداً!
            // هذه الحلقة (Export Loop) تعمل لآلاف الإطارات، وتجميد الكائن هنا سيشكل عبئاً هائلاً (Overhead) 
            // على الـ Garbage Collector بدون أي فائدة حقيقية لأن البيئة هنا (Controlled Pipeline).

            // إجبار المتصفح على أخذ "إطار كامل" (Keyframe) عند تغير الآية لمنع التشويش (Compression Glitches)
            let isKeyFrame = (currentFrame % 300 === 0);
            if (currentAyahGlobalIndex !== lastAyahForKeyframe) {
                isKeyFrame = true;
                lastAyahForKeyframe = currentAyahGlobalIndex;
            }

            state.worker.postMessage({ type: 'encodeFrame', frameNumber: currentFrame, timestamp: timestampUs, keyFrame: isKeyFrame, payload: payload });
            currentFrame++;
        };

        // --- Step 6: Listen for worker messages and drive the loop ---
        return new Promise((resolveExport, rejectExport) => {
            const onWorkerMessage = async (e) => {
            const { type, ...data } = e.data;
            switch (type) {
                case 'encoderReady': renderNextFrame(); break;
                case 'frameEncoded': renderNextFrame(); break;
                case 'ffmpegFrame':
                    if (exportQueue.isCancelled) return;
                    ensureFFmpegReady().then(({ ffmpeg }) => {
                        ffmpeg.writeFile(`frame_${data.frameNumber}.jpg`, new Uint8Array(data.buffer)).then(() => {
                            renderNextFrame();
                        });
                    });
                    break;
                case 'ffmpegFinished':
                    (async () => {
                        try {
                            if (exportQueue.isCancelled) throw new Error('Cancelled');
                            UI.loader.classList.remove('hidden');
                            UI.loaderText.textContent = "جاري تجميع الفيديو...";
                            updateExportStatus("جاري الدمج النهائي...");

                            const { ffmpeg } = await ensureFFmpegReady();
                            await ffmpeg.writeFile('audio.wav', new Uint8Array(wavBuffer));

                            const onFFmpegProgress = ({ progress }) => {
                                const p = Math.max(0, Math.min(1, Number(progress) || 0));
                                const percent = 85 + Math.round(p * 15);
                                UI.exportProgressBar.style.width = `${percent}%`;
                                UI.exportPercent.textContent = `${percent}%`;
                            };
                            ffmpeg.on('progress', onFFmpegProgress);

                            const exitCode = await ffmpeg.exec([
                                '-framerate', String(FPS),
                                '-i', 'frame_%d.jpg',
                                '-i', 'audio.wav',
                                '-c:v', 'libx264',
                                '-preset', 'ultrafast',
                                '-pix_fmt', 'yuv420p',
                                '-c:a', 'aac',
                                '-threads', '0',
                                '-b:a', '192k',
                                '-shortest',
                                'final_output.mp4'
                            ]);

                            ffmpeg.off('progress', onFFmpegProgress);

                            if (exitCode !== 0) throw new Error('Failed to produce the final MP4 file.');

                            const outData = await ffmpeg.readFile('final_output.mp4');
                            const finalBlob = new Blob([outData], { type: 'video/mp4' });

                            for(let i=0; i<totalFrames; i++) ffmpeg.deleteFile(`frame_${i}.jpg`).catch(()=>{});
                            try { await ffmpeg.deleteFile('audio.wav'); } catch(e){}
                            try { await ffmpeg.deleteFile('final_output.mp4'); } catch(e){}

                            state.exportBlobUrl = URL.createObjectURL(finalBlob);
                            state.exportFormat = 'mp4';
                            updateExportButtonState();
                            resolveExport(state.exportBlobUrl);

                        } catch (err) {
                            if (err.message === 'Cancelled' || err.message === 'تم إلغاء التصدير.') return resolveExport(null);
                            console.error("Encode Error:", err);
                            if (!exportQueue.isCancelled) alert(`حدث خطأ أثناء إخراج الفيديو: ${err.message || err}`);
                            rejectExport(err);
                        } finally {
                            UI.loader.classList.add('hidden');
                            if (state.exportBlobUrl) { UI.exportProcessingUI.classList.add('hidden'); UI.exportFinishedUI.classList.remove('hidden'); if (window.lucide) window.lucide.createIcons(); }
                            state.worker.removeEventListener('message', onWorkerMessage);
                            window.onbeforeunload = null;
                        }
                    })();
                    break;
                case 'videoChunk': 
                    const encodedChunk = new EncodedVideoChunk({
                        type: data.chunkType,
                        timestamp: data.timestamp,
                        duration: data.duration,
                        data: data.chunkData
                    });
                    muxer.addVideoChunk(encodedChunk, data.meta); 
                    break;
                case 'videoFinished':
                    try {
                        if (exportQueue.isCancelled) throw new Error('Cancelled');
                        
                        UI.loader.classList.remove('hidden');
                        UI.loaderText.textContent = "جاري التحميل";
                        
                        muxer.finalize();
                        const { buffer } = muxerTarget;
                        const tempVideoBlob = new Blob([buffer], { type: 'video/mp4' });

                        let finalBlob = tempVideoBlob;
                        if (state.exportDevice === 'apple') {
                            if (exportQueue.isCancelled) throw new Error('Cancelled');
                            finalBlob = await finalizeWithFFmpeg(tempVideoBlob, new Uint8Array(wavBuffer), sampleRate);
                        }

                        if (exportQueue.isCancelled) throw new Error('Cancelled');

                        state.exportBlobUrl = URL.createObjectURL(finalBlob);
                        state.exportFormat = 'mp4';
                        updateExportButtonState();
                        resolveExport(state.exportBlobUrl);
                    } catch (err) {
                        if (err.message === 'Cancelled' || err.message === 'تم إلغاء التصدير.') {
                            resolveExport(null);
                            return;
                        }
                        console.error("Muxing Error:", err);
                        if (!exportQueue.isCancelled) alert(`حدث خطأ أثناء إخراج الفيديو: ${err.message || err}`);
                        rejectExport(err);
                    } finally {
                        UI.loader.classList.add('hidden');
                        // لا تظهر شاشة النجاح أبداً إذا تم الإلغاء
                        if (state.exportBlobUrl) {
                            UI.exportProcessingUI.classList.add('hidden');
                            UI.exportFinishedUI.classList.remove('hidden');
                            if (window.lucide) window.lucide.createIcons();
                        }

                        state.worker.removeEventListener('message', onWorkerMessage);
                        window.onbeforeunload = null;
                    }
                    break;
                case 'exportError':
                    alert(`حدث خطأ أثناء التصدير: ${data.error}`);
                    state.worker.removeEventListener('message', onWorkerMessage);
                    resetExportUI();
                    rejectExport(new Error(data.error));
                    break;
                case 'exportAborted':
                    // تنظيف الذاكرة بعد الإلغاء
                    state.worker.removeEventListener('message', onWorkerMessage);
                    if (useFFmpegEncoder) {
                        ensureFFmpegReady().then(({ ffmpeg }) => {
                            for(let i=0; i<=currentFrame; i++) ffmpeg.deleteFile(`frame_${i}.jpg`).catch(()=>{});
                        });
                    }
                    resetExportUI();
                    resolveExport(null);
                    break;
            }
            };
            state.worker.addEventListener('message', onWorkerMessage);
        });

    } catch (error) {
        alert(`فشل تهيئة التصدير: ${error.message}`);
        console.error("Export init failed:", error);
        resetExportUI();
        throw error;
    }
}

// =========================================================================
// 🔧 دوال التصدير المساعدة (Helpers) للحفاظ على كود نظيف وسهل القراءة 🔧
// =========================================================================

async function getExportVideoConfig(size, quality, initialFPS) {
    let FPS = initialFPS;
    let exportW = 1080, exportH = 1920;
    const isMobileDevice = window.innerWidth < 768;
    const effectiveQuality = (isMobileDevice && quality === '4k') ? '720p' : quality;

    if (effectiveQuality === '4k') {
        switch(size) { case '9:16': exportW = 2160; exportH = 3840; break; case '1:1': exportW = 2160; exportH = 2160; break; case '16:9': exportW = 3840; exportH = 2160; break; case '4:5': exportW = 2160; exportH = 2700; break; }
    } else if (effectiveQuality === '720p') {
        switch(size) { case '9:16': exportW = 720; exportH = 1280; break; case '1:1': exportW = 720; exportH = 720; break; case '16:9': exportW = 1280; exportH = 720; break; case '4:5': exportW = 720; exportH = 900; break; }
    } else if (effectiveQuality === '480p') {
        switch(size) { case '9:16': exportW = 480; exportH = 854; break; case '1:1': exportW = 480; exportH = 480; break; case '16:9': exportW = 854; exportH = 480; break; case '4:5': exportW = 480; exportH = 600; break; }
    } else {
        switch(size) { case '9:16': exportW = 1080; exportH = 1920; break; case '1:1': exportW = 1080; exportH = 1080; break; case '16:9': exportW = 1920; exportH = 1080; break; case '4:5': exportW = 1080; exportH = 1350; break; }
    }

    const format = state.exportFormat || 'mp4';
    let dynamicBitrate = Math.round((exportW * exportH * FPS) * 0.035);
    let finalVideoCodecConfig;
    
    try {
        let vp9Codec = (exportW > 1920 && FPS > 30) ? 'vp09.00.51.08' : 'vp09.00.50.08';
        let h264Codec = (exportW > 1920 && FPS > 30) ? 'avc1.4d0034' : 'avc1.4d0033';
        
        finalVideoCodecConfig = format === 'webm' ? 
            { codec: vp9Codec, width: exportW, height: exportH, framerate: FPS, bitrate: dynamicBitrate, bitrateMode: "variable" } : 
            { codec: h264Codec, width: exportW, height: exportH, framerate: FPS, bitrate: dynamicBitrate, bitrateMode: "variable", avc: { format: 'avc' } };

        if (window.VideoEncoder) {
            let support = await window.VideoEncoder.isConfigSupported(finalVideoCodecConfig);
            if (!support.supported && FPS > 30) {
                console.warn("60fps غير مدعوم على هذا الجهاز مع الأبعاد الحالية، سيتم التخفيض إلى 30fps");
                FPS = 30;
                dynamicBitrate = Math.round((exportW * exportH * FPS) * 0.035);
                finalVideoCodecConfig.framerate = FPS;
                finalVideoCodecConfig.bitrate = dynamicBitrate;
                finalVideoCodecConfig.codec = format === 'webm' ? 'vp09.00.50.08' : 'avc1.4d0033';
                support = await window.VideoEncoder.isConfigSupported(finalVideoCodecConfig);
            }
            
            if (!support.supported && effectiveQuality === '4k') {
                console.warn("دقة 4K غير مدعومة للترميز، سيتم التخفيض إلى 1080p");
                exportW = Math.round(exportW / 2);
                exportH = Math.round(exportH / 2);
                dynamicBitrate = Math.round((exportW * exportH * FPS) * 0.035);
                finalVideoCodecConfig.width = exportW;
                finalVideoCodecConfig.height = exportH;
                finalVideoCodecConfig.bitrate = dynamicBitrate;
            }
        }
    } catch(e) { console.warn("تحذير دعم الهاردوير:", e); }

    return { exportW, exportH, FPS, dynamicBitrate, finalVideoCodecConfig };
}

async function preloadExportFonts(startIdx, endIdx) {
    const requiredFonts = new Set();
    const fontPromises = [];
    const vConfig = UI.fontVersion.value;
    const sConfig = state.surahs.find(x => x.id == state.selectedSurah);
    
    for (let i = startIdx; i < endIdx; i++) {
        const ayah = state.ayahs[i];
        if (!ayah) continue;
        let v = vConfig;
        if (v === 'v2' && sConfig && [80, 83, 84, 87, 88, 89, 90, 92, 94, 96, 98, 100].includes(parseInt(sConfig.id))) {
            v = 'v1';
        }
        let fontName, fontUrl;
        if (v === 'mushaf') {
            fontName = 'AlMushaf';
            fontUrl = new URL('fonts/AlMushaf/AlMushaf.woff2', window.location.href).href;
        } else {
            const pageNum = ayah.page_number || 1;
            fontName = `QuranPage${v.toUpperCase()}_${pageNum}`;
            fontUrl = new URL(`fonts/${v}/p${pageNum}.woff2`, window.location.href).href;
        }
        const fontKey = fontName + '|' + fontUrl;
        if (!requiredFonts.has(fontKey)) {
            requiredFonts.add(fontKey);
            fontPromises.push(loadAndSendFont(fontName, fontUrl));
        }
    }
    await Promise.all(fontPromises);
}

async function calculateExportAudioTimings(startIdx, endIdx) {
    let offlineDuration = 0;
    const onlineVerseTimings = [];

    if (state.audioMode === 'local') {
        let offset = state.timings[startIdx] || 0;
        let fileDur = state.localAudioBuffer ? state.localAudioBuffer.duration : (UI.localAudioPlayer && UI.localAudioPlayer.duration ? UI.localAudioPlayer.duration : 3);
        if (isNaN(fileDur)) fileDur = 3;
        let dur = fileDur - offset;
        if (state.timings[endIdx] && state.timings[endIdx] > offset) dur = state.timings[endIdx] - offset;
        offlineDuration = dur;
    } else {
        let elapsed = 0;
        updateExportStatus("جاري التجهيز....");
        
        let estimatedDuration = 15; // إضافة Safety Buffer
        for (let j = startIdx; j < endIdx; j++) estimatedDuration += state.ayahs[j]?.apiDuration || 15;
        
        const isSmallCase = estimatedDuration <= 1800; // مسار التصدير العادي

        if (isSmallCase) {
            updateExportStatus("جاري تحميل الصوتيات...");
            const promises = [];
            let loadedCount = 0;
            let totalToLoad = 0;

            for (let j = startIdx; j < endIdx; j++) {
                if (state.audioCache[j]) {
                    const { startSilence, endSilence } = calculateSilence(state.audioCache[j]);
                    state.ayahs[j].exactDuration = Math.max(0.1, state.audioCache[j].duration - startSilence - endSilence);
                } else if (state.ayahs[j]?.audioUrl) {
                    totalToLoad++;
                    promises.push(
                        fetchAudioBuffer(state.ayahs[j].audioUrl).then(buf => {
                            if (buf) {
                                addToAudioCache(j, buf);
                                const { startSilence, endSilence } = calculateSilence(buf);
                                state.ayahs[j].exactDuration = Math.max(0.1, buf.duration - startSilence - endSilence);
                            }
                            loadedCount++;
                            const progress = Math.round((loadedCount / totalToLoad) * 10);
                            UI.exportProgressBar.style.width = `${progress}%`;
                            UI.exportPercent.textContent = `${progress}%`;
                        })
                    );
                }
            }
            if (totalToLoad === 0) { UI.exportProgressBar.style.width = "10%"; UI.exportPercent.textContent = "10%"; }
            await Promise.all(promises);

            updateExportStatus("جاري حساب التوقيتات...");

            for (let j = startIdx; j < endIdx; j++) {
                if (exportQueue.isCancelled) break;
                onlineVerseTimings.push({ index: j, start: Math.max(0, elapsed) });
                
                if (state.ayahs[j].exactDuration) {
                    const dur = state.ayahs[j].exactDuration;
                    const overlap = Math.min(0.22, Math.max(0.04, dur * 0.065));
                    elapsed += dur - overlap;
                } else { elapsed += state.ayahs[j].apiDuration || 5; }
                
                const progress = 10 + Math.round(((j - startIdx + 1) / (endIdx - startIdx)) * 5);
                UI.exportProgressBar.style.width = `${progress}%`; UI.exportPercent.textContent = `${progress}%`;
                await new Promise(r => setTimeout(r, 20));
            }
        } else {
            // Streaming مسار 
            const MAX_PRELOAD = 20;
            const initialEndIdx = Math.min(endIdx, startIdx + MAX_PRELOAD);

            updateExportStatus("جاري تحميل الصوتيات...");
            const initialFetchPromises = [];
            let preloadCount = 0; let totalPreload = 0;
            for (let i = startIdx; i < initialEndIdx; i++) {
                if (state.audioCache[i]) {
                    const { startSilence, endSilence } = calculateSilence(state.audioCache[i]);
                    state.ayahs[i].exactDuration = Math.max(0.1, state.audioCache[i].duration - startSilence - endSilence);
                } else if (state.ayahs[i] && state.ayahs[i].audioUrl) {
                    totalPreload++;
                    initialFetchPromises.push(fetchAudioBuffer(state.ayahs[i].audioUrl).then(buf => {
                        if (buf) {
                            addToAudioCache(i, buf);
                            const { startSilence, endSilence } = calculateSilence(buf);
                            state.ayahs[i].exactDuration = Math.max(0.1, buf.duration - startSilence - endSilence);
                        }
                        preloadCount++;
                        const p = Math.round((preloadCount / totalPreload) * 5);
                        UI.exportProgressBar.style.width = `${p}%`; UI.exportPercent.textContent = `${p}%`;
                    }));
                }
            }
            if (totalPreload === 0) { UI.exportProgressBar.style.width = "5%"; UI.exportPercent.textContent = "5%"; }
            if (initialFetchPromises.length > 0) await Promise.all(initialFetchPromises);

            const BATCH_SIZE = 10;
            for (let i = startIdx; i < endIdx; i += BATCH_SIZE) {
                if (exportQueue.isCancelled) break;
                const batchEnd = Math.min(i + BATCH_SIZE, endIdx);
                
                const fetchPromises = [];
                for (let j = i; j < batchEnd; j++) {
                    if (!state.audioCache[j] && state.ayahs[j] && state.ayahs[j].audioUrl) {
                        fetchPromises.push(fetchAudioRaw(state.ayahs[j].audioUrl));
                    }
                }
                if (fetchPromises.length > 0) await Promise.all(fetchPromises);

                for (let j = i; j < batchEnd; j++) {
                    if (exportQueue.isCancelled) break;
                    onlineVerseTimings.push({ index: j, start: Math.max(0, elapsed) });
                    
                    let buf = state.audioCache[j];
                    if (!buf && state.ayahs[j] && !state.ayahs[j].exactDuration) {
                        buf = await fetchAudioBuffer(state.ayahs[j].audioUrl);
                        if (buf) addToAudioCache(j, buf);
                    }

                    if (buf) {
                        const { startSilence, endSilence } = calculateSilence(buf);
                        const playDuration = Math.max(0.1, buf.duration - startSilence - endSilence);
                        const overlap = Math.min(0.22, Math.max(0.04, playDuration * 0.065));
                        elapsed += playDuration - overlap;
                        state.ayahs[j].exactDuration = playDuration;
                    } else if (state.ayahs[j].exactDuration) {
                        const dur = state.ayahs[j].exactDuration;
                        const overlap = Math.min(0.22, Math.max(0.04, dur * 0.065));
                        elapsed += dur - overlap;
                    } else { elapsed += state.ayahs[j].apiDuration || 5; }

                    const oldIndex = j - 5;
                    if (state.audioCache[oldIndex]) {
                        delete state.audioCache[oldIndex];
                        if (state.audioCacheOrder) {
                            const orderIdx = state.audioCacheOrder.indexOf(oldIndex);
                            if (orderIdx !== -1) state.audioCacheOrder.splice(orderIdx, 1);
                        }
                    }
                }

                const globalPercent = 5 + Math.round(((batchEnd - startIdx) / (endIdx - startIdx)) * 10);
                UI.exportProgressBar.style.width = `${globalPercent}%`; UI.exportPercent.textContent = `${globalPercent}%`;
                updateExportStatus(`تجهيز الصوتيات (${batchEnd - startIdx}/${endIdx - startIdx})...`);
                
                if (estimatedDuration > 1800) await new Promise(r => setTimeout(r, 30));
            }
        }
        onlineVerseTimings.push({ index: endIdx, start: elapsed });
        offlineDuration = elapsed;
    }
    return { offlineDuration, onlineVerseTimings };
}

function precomputeAllWaveData(wavBuffer, totalFrames, FPS, sampleRate, totalSamples) {
    const int16View = new Int16Array(wavBuffer);
    const headerOffsetInt16 = 22;
    const N = 128; // حجم الـ FFT
    const bins = N / 2; // 64 نطاق ترددي
    const pi2_N = (Math.PI * 2) / N;
    const minDb = -100;
    const maxDb = -30;
    const rangeScale = 255 / (maxDb - minDb);
    const alpha = 0.16;
    const a0 = 0.5 * (1 - alpha), a1 = 0.5, a2 = 0.5 * alpha;
    
    const windowMultipliers = new Float32Array(N);
    for (let n = 0; n < N; n++) {
        windowMultipliers[n] = a0 - a1 * Math.cos((2 * Math.PI * n) / (N - 1)) + a2 * Math.cos((4 * Math.PI * n) / (N - 1));
    }

    const allWaveData = new Array(totalFrames);
    let smoothedWaveData = new Float32Array(bins);

    for (let frame = 0; frame < totalFrames; frame++) {
        const timestampSec = frame / FPS;
        const frameSampleIndex = Math.floor(timestampSec * sampleRate);
        const startSample = Math.max(0, frameSampleIndex - Math.floor(N/2));
        const endSample = Math.min(totalSamples, startSample + N);
        const actualN = endSample - startSample;
        
        const channelData = new Float32Array(N);
        let offset = headerOffsetInt16 + (startSample * 2);
        for (let n = 0; n < actualN; n++) {
            channelData[n] = int16View[offset] / 32768.0;
            offset += 2; // تخطي القناة اليمنى وأخذ اليسرى فقط
        }
        
        const waveData = new Uint8Array(bins);
        
        for (let k = 0; k < bins; k++) {
            let sumR = 0, sumI = 0;
            for (let n = 0; n < channelData.length; n++) {
                const val = channelData[n] * windowMultipliers[n];
                const angle = k * n * pi2_N;
                sumR += val * Math.cos(angle);
                sumI -= val * Math.sin(angle);
            }
            
            const magnitude = Math.sqrt(sumR * sumR + sumI * sumI) / (N / 2);
            const smoothedMag = (smoothedWaveData[k] * 0.85) + (magnitude * 0.15);
            smoothedWaveData[k] = smoothedMag;
            
            let db = 20 * Math.log10(smoothedMag || 1e-10);
            let byteVal = (db - minDb) * rangeScale;
            waveData[k] = Math.max(0, Math.min(255, byteVal));
        }
        allWaveData[frame] = waveData;
    }
    return allWaveData;
}

function executeMediaRecorderFallback(exportW, exportH, FPS, dynamicBitrate, offlineDuration, startIdx) {
    return new Promise(async (resolve, reject) => {
        updateExportStatus("جاري تهيئة التسجيل الفعلي...");
        state.isRealtimeExport = true;
        state.worker.postMessage({ type: 'resize', width: exportW, height: exportH });
        state.worker.postMessage({ type: 'startRealtimeExport' });
        
        await new Promise(r => setTimeout(r, 500));
        if (exportQueue.isCancelled) { resolve(null); return; }
        
        let canvasStream;
        try {
            canvasStream = UI.canvas.captureStream(FPS);
            if (canvasStream.getVideoTracks().length === 0) throw new Error('No tracks');
        } catch(e) {
            state.isRealtimeExport = false;
            state.worker.postMessage({ type: 'stopRealtimeExport' });
            reject(new Error("متصفحك لا يدعم التقاط الفيديو من الشاشة. يرجى استخدام متصفح حديث (Chrome/Edge)."));
            return;
        }
        
        const audioStream = state.audioDestination.stream;
        const combinedStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioStream.getAudioTracks()]);
        
        const mimeType = getSupportedMimeType();
        const recorder = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: dynamicBitrate || 2500000 });
        
        const chunks = [];
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        
        const finish = (result) => {
            state.isRealtimeExport = false;
            state.worker.postMessage({ type: 'stopRealtimeExport' });
            resolve(result);
        };

        recorder.onstop = () => {
            if (exportQueue.isCancelled) { finish(null); return; }
            const blob = new Blob(chunks, { type: mimeType });
            state.exportBlobUrl = URL.createObjectURL(blob);
            state.exportFormat = mimeType.includes('mp4') ? 'mp4' : 'webm';
            updateExportButtonState();
            
            UI.loader.classList.add('hidden');
            UI.exportProcessingUI.classList.add('hidden');
            UI.exportFinishedUI.classList.remove('hidden');
            if (window.lucide) window.lucide.createIcons();
            finish(state.exportBlobUrl);
        };
        
        recorder.onerror = (e) => {
            state.isRealtimeExport = false;
            state.worker.postMessage({ type: 'stopRealtimeExport' });
            reject(new Error("فشل التصدير الفعلي: " + e.message));
        };
        
        recorder.start(1000);
        state.isPlaying = true; playSeamless(startIdx);
        
        const startTime = state.audioContext.currentTime;
        const checkInterval = setInterval(() => {
            if (exportQueue.isCancelled) {
                clearInterval(checkInterval); recorder.stop(); stopAudio();
                reject(new Error('Cancelled')); return;
            }
            if (!state.isPlaying) { clearInterval(checkInterval); recorder.stop(); return; }
            const elapsed = state.audioContext.currentTime - startTime;
            const p = Math.min(99, Math.round((elapsed / offlineDuration) * 100));
            UI.exportProgressBar.style.width = `${p}%`; UI.exportPercent.textContent = `${p}%`;
            updateExportStatus(`تسجيل حي (${p}%)... يرجى عدم إغلاق النافذة`);
        }, 500);
    });
}

async function processOfflineAudio(offlineDuration, onlineVerseTimings, startIdx, endIdx, sampleRate, audioConfig) {
    let wavBuffer;
    const totalSamples = Math.ceil(offlineDuration * sampleRate) || 1;
    const USE_CHUNKED_RENDERING = offlineDuration > 1800; // استخدام النظام الآمن للملفات الأطول من 30 دقيقة

    if (USE_CHUNKED_RENDERING) {
        updateExportStatus("جاري معالجة الصوت...");
        const numberOfChannels = 2; const bytesPerSample = 2;
        const blockAlign = numberOfChannels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        
        const localWavBuffer = new ArrayBuffer(44 + (totalSamples * blockAlign));
        const wavView = new DataView(localWavBuffer);
        
        const writeString = (offset, text) => { for (let i = 0; i < text.length; i++) wavView.setUint8(offset + i, text.charCodeAt(i)); };
        
        writeString(0, 'RIFF'); wavView.setUint32(4, 36 + (totalSamples * blockAlign), true); writeString(8, 'WAVE'); writeString(12, 'fmt ');
        wavView.setUint32(16, 16, true); wavView.setUint16(20, 1, true); wavView.setUint16(22, numberOfChannels, true);
        wavView.setUint32(24, sampleRate, true); wavView.setUint32(28, byteRate, true); wavView.setUint16(32, blockAlign, true);
        wavView.setUint16(34, 16, true); writeString(36, 'data'); wavView.setUint32(40, totalSamples * blockAlign, true);

        await new Promise(r => setTimeout(r, 50));
        if (exportQueue.isCancelled) return null;

        const CHUNK_DURATION = 15;
        const totalChunks = Math.ceil(offlineDuration / CHUNK_DURATION);

        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            if (exportQueue.isCancelled) return null;
            
            const chunkStart = chunkIndex * CHUNK_DURATION;
            const chunkEnd = Math.min((chunkIndex + 1) * CHUNK_DURATION, offlineDuration);
            const renderDuration = chunkEnd - chunkStart; 
            const chunkSamples = Math.ceil(renderDuration * sampleRate);
            
            const chunkCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, chunkSamples, sampleRate);
            const { entryNode, cleanupGraph } = createOfflineAudioGraph(chunkCtx, audioConfig);
            const cleanupChunkCtx = () => { 
                if (cleanupGraph) cleanupGraph();
                if (chunkCtx && typeof chunkCtx.close === 'function' && chunkCtx.state !== 'closed') { try { chunkCtx.close(); } catch (e) {} } 
            };

            if (state.audioMode === 'local') {
                const offset = state.timings[startIdx] || 0;
                let localBuf = state.localAudioBuffer;
                
                if (!localBuf && state.localAudioFile) {
                    const decodeCtx = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
                    const arrayBuffer = await state.localAudioFile.arrayBuffer();
                    localBuf = await decodeCtx.decodeAudioData(arrayBuffer);
                    state.localAudioBuffer = localBuf;
                    if (!state.audioContext && decodeCtx && typeof decodeCtx.close === 'function') { try { decodeCtx.close(); } catch(e) {} }
                    if (exportQueue.isCancelled) { cleanupChunkCtx(); return null; }
                }
                
                if (localBuf) {
                    const source = chunkCtx.createBufferSource();
                    source.buffer = localBuf; source.connect(entryNode);
                    source.start(0, offset + chunkStart, renderDuration);
                }
            } else {
                for (let j = 0; j < onlineVerseTimings.length - 1; j++) {
                    const verseStart = onlineVerseTimings[j].start;
                    const index = onlineVerseTimings[j].index;
                    let buf = state.audioCache[index];
                    if (!buf) { buf = await fetchAudioBuffer(state.ayahs[index].audioUrl); if (buf) addToAudioCache(index, buf); }
                    if (exportQueue.isCancelled) { cleanupChunkCtx(); return null; }
                    if (buf) {
                        const { startSilence, endSilence } = calculateSilence(buf);
                        const playDuration = Math.max(0.1, buf.duration - startSilence - endSilence);
                        const verseEnd = verseStart + playDuration;
                        
                        if (verseStart < chunkStart + renderDuration && verseEnd > chunkStart) {
                            const source = chunkCtx.createBufferSource();
                            source.buffer = buf; source.connect(entryNode);
                            
                            const playStartGlobal = Math.max(verseStart, chunkStart);
                            const playEndGlobal = Math.min(verseEnd, chunkStart + renderDuration);
                            
                            if (playStartGlobal < playEndGlobal) {
                                const playTimeInChunk = playStartGlobal - chunkStart;
                                const offsetInBuffer = (playStartGlobal - verseStart) + startSilence;
                                const playDurationInChunk = playEndGlobal - playStartGlobal;
                                source.start(playTimeInChunk, offsetInBuffer, playDurationInChunk);
                            }
                        }
                    }
                }
            }
            
            const chunkBuffer = await chunkCtx.startRendering();
            if (exportQueue.isCancelled) { cleanupChunkCtx(); return null; }
            
            const left = chunkBuffer.getChannelData(0);
            const right = chunkBuffer.numberOfChannels > 1 ? chunkBuffer.getChannelData(1) : left;
            const int16View = new Int16Array(localWavBuffer);
            const startSampleGlobal = Math.floor(chunkStart * sampleRate);

            for (let i = 0; i < chunkSamples; i++) {
                const globalSampleIdx = startSampleGlobal + i;
                if (globalSampleIdx >= totalSamples) break;
                const offset = 22 + (globalSampleIdx * 2);
                
                const mixedL = (left[i] || 0) + (int16View[offset] / 32768.0);
                const mixedR = (right[i] || 0) + (int16View[offset + 1] / 32768.0);
                
                int16View[offset] = mixedL < 0 ? Math.max(-1, mixedL) * 0x8000 : Math.min(1, mixedL) * 0x7FFF;
                int16View[offset + 1] = mixedR < 0 ? Math.max(-1, mixedR) * 0x8000 : Math.min(1, mixedR) * 0x7FFF;
            }
            
            if (state.audioMode === 'online') {
                for (let j = 0; j < onlineVerseTimings.length - 1; j++) {
                    if (onlineVerseTimings[j+1].start < chunkStart - 5) {
                        const idx = onlineVerseTimings[j].index;
                        if (state.audioCache[idx]) delete state.audioCache[idx];
                    }
                }
            }
            
            const progress = 15 + Math.round(((chunkIndex + 1) / totalChunks) * 10);
            UI.exportProgressBar.style.width = `${progress}%`; UI.exportPercent.textContent = `${progress}%`;
            updateExportStatus(`جاري معالجة الصوت (${chunkIndex + 1}/${totalChunks})...`);
            cleanupChunkCtx(); await new Promise(r => setTimeout(r, 0));
        }
        wavBuffer = localWavBuffer;
    } else {
        updateExportStatus("جاري دمج الصوتيات...");
        let mergeProgress = 15;
        const mergeInterval = setInterval(() => {
            if (exportQueue.isCancelled) { clearInterval(mergeInterval); return; }
            if (mergeProgress < 24.9) {
                mergeProgress += (25 - mergeProgress) * 0.015;
                UI.exportProgressBar.style.width = `${mergeProgress}%`; UI.exportPercent.textContent = `${Math.floor(mergeProgress)}%`;
            }
        }, 100);

        await new Promise(r => setTimeout(r, 50));
        if (exportQueue.isCancelled) { clearInterval(mergeInterval); return null; }

        const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, totalSamples, sampleRate);
        const { entryNode, cleanupGraph } = createOfflineAudioGraph(offlineCtx, audioConfig);
        const cleanupOfflineCtx = () => { 
            if (cleanupGraph) cleanupGraph();
            if (offlineCtx && typeof offlineCtx.close === 'function' && offlineCtx.state !== 'closed') { try { offlineCtx.close(); } catch (e) {} } 
        };

        if (state.audioMode === 'local') {
            const offset = state.timings[startIdx] || 0;
            let localBuf = state.localAudioBuffer;
            if (!localBuf && state.localAudioFile) {
                const arrayBuffer = await state.localAudioFile.arrayBuffer();
                localBuf = await offlineCtx.decodeAudioData(arrayBuffer);
            }
            if (exportQueue.isCancelled) { cleanupOfflineCtx(); return null; }
            if (localBuf) {
                const source = offlineCtx.createBufferSource();
                source.buffer = localBuf; source.connect(entryNode);
                source.start(0, offset, offlineDuration);
            }
        } else {
            let currentTime = 0;
            for (let j = 0; j < onlineVerseTimings.length - 1; j++) {
                if (exportQueue.isCancelled) { cleanupOfflineCtx(); return null; }
                const index = onlineVerseTimings[j].index;
                let buf = state.audioCache[index];
                if (!buf) { buf = await fetchAudioBuffer(state.ayahs[index].audioUrl); if (buf) addToAudioCache(index, buf); }
                if (exportQueue.isCancelled) { cleanupOfflineCtx(); return null; }
                if (buf) {
                    const source = offlineCtx.createBufferSource();
                    source.buffer = buf;
                    onlineVerseTimings[j].start = currentTime;
                    const { startSilence, endSilence } = calculateSilence(buf);
                    const playDuration = Math.max(0.1, buf.duration - startSilence - endSilence);
                    const overlap = Math.min(0.22, Math.max(0.04, playDuration * 0.065));
                    source.connect(entryNode); source.start(currentTime, startSilence, playDuration);
                    currentTime += playDuration - overlap;
                } else {
                    onlineVerseTimings[j].start = currentTime;
                    if (state.ayahs[index].exactDuration) {
                        const dur = state.ayahs[index].exactDuration;
                        const overlap = Math.min(0.22, Math.max(0.04, dur * 0.065));
                        currentTime += dur - overlap;
                    } else { currentTime += state.ayahs[index].apiDuration || 5; }
                }
            }
            onlineVerseTimings[onlineVerseTimings.length - 1].start = currentTime;
        }

        const renderedBuffer = await offlineCtx.startRendering();
        clearInterval(mergeInterval);
        if (exportQueue.isCancelled) { cleanupOfflineCtx(); return null; }

        updateExportStatus("جاري تهيئة الصوت...");
        const finalWavBytes = await audioBufferToWavBytes(renderedBuffer, (p) => {
            const progress = mergeProgress + (p * (25 - mergeProgress));
            UI.exportProgressBar.style.width = `${progress}%`; UI.exportPercent.textContent = `${Math.round(progress)}%`;
        });
        wavBuffer = finalWavBytes.buffer;

        UI.exportProgressBar.style.width = "25%"; UI.exportPercent.textContent = "25%";
        updateExportStatus("تمت معالجة الصوت.");
        cleanupOfflineCtx(); await new Promise(r => setTimeout(r, 50));
    }

    if (state.audioMode === 'local' && state.useAudioElement) { state.localAudioBuffer = null; }
    return { wavBuffer, totalSamples };
}

export function resetExportUI() {
    window.onbeforeunload = null;
    state.isRealtimeExport = false;
    if (state.worker) state.worker.postMessage({ type: 'stopRealtimeExport' });
    cancelActiveFFmpeg();
    state.lastRenderPayload = null; // إجبار التطبيق على إرسال تحديث شامل لإخراج المعالج من وضع السبات السريع
    // لا نعيد تفريغ exportBlobUrl هنا لأننا نريد إرجاعه كنتيجة
    
    // تفريغ الرام بعد التصدير للموبايل لإبقاء المتصفح سريعاً (أما الديسكتوب فنحتفظ بالملف للتشغيل)
    if (state.audioMode === 'local' && state.useAudioElement) { state.localAudioBuffer = null; }

    const cancelBtn = document.getElementById('cancelExportBtnDynamic');
    if (cancelBtn) cancelBtn.style.display = 'none'; // إخفاء زر الإلغاء بعد الانتهاء
    
    UI.sidebar.classList.remove('sidebar-disabled'); UI.playBtn.disabled = false; UI.playBtn.style.opacity = "1"; UI.exportOverlay.style.display = "none";
    
    // إعادة ضبط أبعاد المعاينة بعد انتهاء أو إلغاء التصدير
    if (UI.canvasSize) UI.canvasSize.dispatchEvent(new Event('change'));

    // إعادة تشغيل الفيديو إذا كان هو الخلفية المستخدمة لتجنب تجمده بعد التصدير
    if (state.mediaType === 'video' && state.bgVideo) {
        // إرجاع إعدادات إخفاء الفيديو كما كانت
        state.bgVideo.style.opacity = '0.01';
        state.bgVideo.style.width = '10px';
        state.bgVideo.style.height = '10px';
        if (state.bgVideo.paused) state.bgVideo.play().catch(e => console.warn(e));
    }
    updateExportButtonState();
}

// وظيفة لتصدير مجموعة آيات بالتتابع
export async function exportMultipleAyahs(ayahList) {
    for (const ayahIndex of ayahList) {
        state.currentAyahIndex = ayahIndex;
        // إعادة تحميل المحتوى للآية
        // await updateContent(); // قد تحتاج لتعديل حسب موقع updateContent
        const surahName = state.surahs.find(s => s.id == state.selectedSurah)?.name_arabic || '';
        await secureExport(`سورة ${surahName} - آية ${ayahIndex + 1}`);
        // انتظار قليل بين كل تصدير
        await new Promise(r => setTimeout(r, 500));
    }
}

// تصدير الـ Queue للاستخدام في أماكن أخرى
export { exportQueue };

export function updateExportButtonState() {
    if (isExporting()) {
        UI.actionBtn.disabled = true;
        UI.actionText.textContent = "جاري التصوير...";
        return;
    }

    const baseText = state.exportBlobUrl ? "تصدير جديد" : "تصدير المقطع";

    if (state.audioMode === 'local') {
        if ((!state.localAudioBuffer && !state.localAudioFile) || !state.hasSyncedOnce) {
            UI.actionBtn.disabled = true;
            UI.actionText.textContent = (!state.localAudioBuffer && !state.localAudioFile) ? "ارفع ملفاً صوتياً أولاً" : "قم بمزامنة الصوت أولاً";
        } else {
            UI.actionBtn.disabled = false;
            UI.actionText.textContent = baseText;
        }
    } else { // online mode
        UI.actionBtn.disabled = false;
        UI.actionText.textContent = baseText;
    }
}
