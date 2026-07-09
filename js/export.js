import { supabaseClient, state } from './store.js';
import { UI } from './ui.js';
import { enforceSingleSession, loadUserPlan, getSessionStatus } from './auth.js';
import { initAudio, stopAudio, playSeamless, fetchAudioBuffer, fetchAudioRaw, createReverbBuffer, addToAudioCache, clearAudioCache, calculateSilence } from './audio.js';
import { loadAndSendFont } from './renderer.js';
import { getUserCapabilities, getAllowedRange, getRealVerseCount, getAyahIndexByRealNumber } from './permissions.js';
import { exportQueue, isExporting, EXPORT_ERRORS } from './exportQueue.js';
import { getCache, setCache } from './db.js';

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

let displayProgress = 0;
let targetProgress = 0;
let progressRaf = null;

export function setExportProgress(percent) {
    const newTarget = Math.max(0, Math.min(100, percent));
    
    // منع تراجع المؤشر للخلف للحفاظ على تجربة مستخدم سلسة (إلا في حالة التصفير للبدء من جديد)
    if (newTarget < targetProgress && newTarget !== 0) return;
    
    targetProgress = newTarget;
    if (!progressRaf) {
        const loop = () => {
            if (exportQueue && exportQueue.isCancelled) {
                progressRaf = null;
                return;
            }
            const diff = targetProgress - displayProgress;
            if (Math.abs(diff) < 0.1) {
                displayProgress = targetProgress;
                if (UI.exportProgressBar) UI.exportProgressBar.style.width = `${displayProgress}%`;
                if (UI.exportPercent) UI.exportPercent.textContent = `${Math.round(displayProgress)}%`;
                progressRaf = null;
            } else {
                displayProgress += diff * 0.15; // حركة ناعمة ومستمرة
                if (UI.exportProgressBar) UI.exportProgressBar.style.width = `${displayProgress}%`;
                if (UI.exportPercent) UI.exportPercent.textContent = `${Math.round(displayProgress)}%`;
                progressRaf = requestAnimationFrame(loop);
            }
        };
        progressRaf = requestAnimationFrame(loop);
    }
}

export function resetExportProgress() {
    displayProgress = 0;
    targetProgress = 0;
    if (progressRaf) {
        cancelAnimationFrame(progressRaf);
        progressRaf = null;
    }
    if (UI.exportProgressBar) {
        UI.exportProgressBar.style.transition = 'none';
        UI.exportProgressBar.style.width = "0%";
    }
    if (UI.exportPercent) UI.exportPercent.textContent = "0%";
    if (UI.exportProgressBar) void UI.exportProgressBar.offsetWidth; // إجبار المتصفح على التحديث
    if (UI.exportProgressBar) UI.exportProgressBar.style.transition = '';
}

let ffmpegLibPromise = null;
let ffmpegInstance = null;
let ffmpegFetchFile = null;

const activeDownloads = new Map();

async function downloadWithProgress(url) {
    // لو الملف بيتحمل حالياً في الخلفية، اربط معاه عشان منعملش تحميلين لنفس الملف (توفير للإنترنت)
    if (activeDownloads.has(url)) return activeDownloads.get(url);

    const promise = (async () => {
        const cacheKey = `ffmpeg_lib_${url}`;
        let buffer = await getCache(cacheKey);
        if (buffer) {
            activeDownloads.delete(url);
            return buffer;
        }

        try {
            const response = await fetch(url, { cache: 'force-cache' });
            if (!response.ok) throw new Error(`Failed to fetch ${url}`);

            const contentLength = response.headers.get('content-length');
            const total = contentLength ? parseInt(contentLength, 10) : 0;
            
            if (response.body) {
                const reader = response.body.getReader();
                const chunks = [];
                let loaded = 0;
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) {
                        chunks.push(value);
                        loaded += value.byteLength;
                        
                        // تحديث الواجهة والنسبة المئوية فوراً لو المستخدم فتح شاشة التصدير
                        if (url.includes('.wasm') && UI.exportOverlay && UI.exportOverlay.style.display !== 'none') {
                            // 🔴 منع الرعشة: تحديث الواجهة فقط إذا كان التصدير الحالي يحتاج المكتبة (التصدير القياسي)
                            if (!state.fastExport) {
                                if (total > 0) {
                                    const percent = Math.round((loaded / total) * 100);
                                    updateExportStatus(`تنزيل مكتبة التصدير (${percent}%)... لأول مرة فقط`);
                                } else {
                                    const mb = (loaded / (1024 * 1024)).toFixed(1);
                                    updateExportStatus(`تنزيل مكتبة التصدير (${mb}MB)... لأول مرة فقط`);
                                }
                            }
                        }
                    }
                }
                
                const uint8Array = new Uint8Array(loaded);
                let offset = 0;
                for (const chunk of chunks) {
                    uint8Array.set(chunk, offset);
                    offset += chunk.length;
                }
                buffer = uint8Array.buffer;
            } else {
                buffer = await response.arrayBuffer();
            }

            await setCache(cacheKey, buffer);
            activeDownloads.delete(url);
            return buffer;
        } catch (e) {
            activeDownloads.delete(url);
            throw e;
        }
    })();
    
    activeDownloads.set(url, promise);
    return promise;
}

export function preloadFFmpegAssets() {
    if (typeof window === 'undefined') return;
    
    const preload = async () => {
        try {
            const isSABSupported = typeof SharedArrayBuffer !== 'undefined';
            const corePrefix = isSABSupported ? 'https://raw.githubusercontent.com/zyadabdelbaqi/tarteel-assets/main/ffmpeg/ffmpeg-core-mt' : 'https://raw.githubusercontent.com/zyadabdelbaqi/tarteel-assets/main/ffmpeg/ffmpeg-core';
            const workerPath = isSABSupported ? 'https://raw.githubusercontent.com/zyadabdelbaqi/tarteel-assets/main/ffmpeg/ffmpeg-core-mt.worker.js' : 'https://raw.githubusercontent.com/zyadabdelbaqi/tarteel-assets/main/ffmpeg/worker.js';

            const urls = [
                "js/lib/ffmpeg.js",
                "js/lib/ffmpeg-util.js",
                `${corePrefix}.js`,
                `${corePrefix}.wasm`,
                workerPath,
                "js/lib/814.ffmpeg.js"
            ];

            for (const url of urls) {
                try {
                    await downloadWithProgress(url);
                } catch (e) {} // الصمت عند الخطأ لتجنب إزعاج المستخدم
            }
        } catch (e) {}
    };

    // تأخير التحميل 3 ثوانٍ لعدم التأثير على سرعة الاستوديو عند الدخول
    setTimeout(() => {
        if (window.requestIdleCallback) window.requestIdleCallback(preload);
        else preload();
    }, 3000);
}

async function cachedToBlobURL(url, mimeType) {
    // استخدام دالة التحميل الذكية الجديدة التي تراقب التقدم
    const buffer = await downloadWithProgress(url);
    const blob = new Blob([buffer], { type: mimeType });
    return URL.createObjectURL(blob);
}

async function ensureFFmpegReady() {
    if (ffmpegInstance && ffmpegInstance.loaded) return { ffmpeg: ffmpegInstance, fetchFile: ffmpegFetchFile };

    if (!ffmpegLibPromise) {
        ffmpegLibPromise = (async () => {
            // 1. تحميل مكتبة FFmpeg الأساسية
            if (!window.FFmpegWASM) {
                await new Promise(async (resolve, reject) => {
                    try {
                        const blobUrl = await cachedToBlobURL("js/lib/ffmpeg.js", "application/javascript");
                        const s = document.createElement("script");
                        s.src = blobUrl;
                        s.onload = resolve;
                        s.onerror = reject;
                        document.head.appendChild(s);
                    } catch(e) { reject(e); }
                });
            }

            // 2. تحميل مكتبة Util المساعدة (والتي تحتوي على fetchFile)
            if (!window.FFmpegUtil) {
                await new Promise(async (resolve, reject) => {
                    try {
                        const blobUrl = await cachedToBlobURL("js/lib/ffmpeg-util.js", "application/javascript");
                        const s = document.createElement("script");
                        s.src = blobUrl;
                        s.onload = resolve;
                        s.onerror = reject;
                        document.head.appendChild(s);
                    } catch(e) { reject(e); }
                });
            }

            const { FFmpeg } = window.FFmpegWASM;
            const { fetchFile } = window.FFmpegUtil;

            const ffmpeg = new FFmpeg();
            
            // التحقق من دعم SharedArrayBuffer لتفعيل النسخة متعددة المسارات (Multi-threaded)
            const isSABSupported = typeof SharedArrayBuffer !== 'undefined';
            const corePrefix = isSABSupported ? 'https://raw.githubusercontent.com/zyadabdelbaqi/tarteel-assets/main/ffmpeg/ffmpeg-core-mt' : 'https://raw.githubusercontent.com/zyadabdelbaqi/tarteel-assets/main/ffmpeg/ffmpeg-core';
            const workerPath = isSABSupported ? 'https://raw.githubusercontent.com/zyadabdelbaqi/tarteel-assets/main/ffmpeg/ffmpeg-core-mt.worker.js' : 'https://raw.githubusercontent.com/zyadabdelbaqi/tarteel-assets/main/ffmpeg/worker.js';

            await ffmpeg.load({
                coreURL: await cachedToBlobURL(`${corePrefix}.js`, 'text/javascript'),
                wasmURL: await cachedToBlobURL(`${corePrefix}.wasm`, 'application/wasm'),
                workerURL: await cachedToBlobURL(workerPath, 'text/javascript'),
                classWorkerURL: await cachedToBlobURL('js/lib/814.ffmpeg.js', 'text/javascript')
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

    return await ffmpegLibPromise;
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
            
            // مهلة قصيرة جداً (10ms) لتقليل الـ Bottleneck في حال عدم دعم requestVideoFrameCallback
            const renderTimeout = setTimeout(finish, 10);

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
        }, 5000); // 5 ثوانٍ كافية جداً لمنع التعليق
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
    setExportProgress(85);

    const { ffmpeg, fetchFile } = await ensureFFmpegReady();
    if (exportQueue.isCancelled) throw new Error(EXPORT_ERRORS.CANCELLED);

    const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inputVideo = `video-${uid}.mp4`;
    const inputAudio = `audio-${uid}.wav`;
    const outputVideo = `final-${uid}.mp4`;

    const onProgress = ({ progress }) => {
        const ffmpegProgress = Math.max(0, Math.min(1, Number(progress) || 0));
        const percent = 85 + (ffmpegProgress * 15);
        setExportProgress(percent);
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
            '-b:a', '128k',
            '-shortest',
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
    if (config.hasSplitVerses && (isStrictFree || !caps.canSplitVerses)) return { type: 'split' };
    
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
        'audio': "استخدم صوتك الخاص بالمزامنة مع الآيات بالترقية للنسخة الاحترافية.",
        'waveform': "أضف موجات صوتية احترافية للفيديو بالترقية للنسخة الاحترافية.",
        'watermark': "ضيف شعارك الخاص على الفيديوهات بالترقية للنسخة الاحترافية.",
        'branding': "صدّر الفيديو بدون شعار Tarteel Studio بالترقية للنسخة الاحترافية.",
        'split': "ميزة تقسيم الآيات الطويلة متاحة فقط في النسخة الاحترافية."
    };
    UI.proFeatureMsg.textContent = messages[type];
    UI.proFeatureModal.style.display = 'flex';
    if (window.lucide) window.lucide.createIcons();
}

export async function secureExport(label = 'تصدير') {
    setupQueueCallback();

    // إرجاع نتيجة التصدير (Blob URL) أو رسالة الخطأ
    try {
        const result = await exportQueue.add(async () => {
            if (exportQueue.isCancelled) throw new Error(EXPORT_ERRORS.CANCELLED);
            try {
                return await _secureExportImpl();
            } finally {
                updateExportButtonState();
            }
        }, label);
        return result;
    } catch (e) {
        if (e.message !== EXPORT_ERRORS.CANCELLED) {
            resetExportUI();
        }
        throw e;
    }
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

    const session = getSessionStatus();
    if (session.status !== 'healthy') {
        console.warn(`Export blocked: ${session.reason}`);
        alert("الاتصال بالسيرفر غير مستقر أو مفقود. التصدير والميزات المتقدمة متوقفة مؤقتاً لحين استعادة الاتصال والتحقق من الحساب.");
        restoreUI();
        throw new Error(EXPORT_ERRORS.CANCELLED);
    }

    // إعطاء فرصة للمتصفح لتحديث الواجهة وإظهار شاشة التحميل فوراً
    await new Promise(r => setTimeout(r, 10));

    stopAudio();

    // إيقاف أي مصدر صوتي فعال وتدمير AudioContext بالكامل لضمان بيئة نظيفة خالية من التداخلات أو التكرار
    if (state.activeSource) {
        try { state.activeSource.stop(); } catch(e) {}
        state.activeSource = null;
    }

    // تفريغ الكاش الصوتي تماماً قبل التصدير لضمان عدم استخدام أي بقايا صوتية
    clearAudioCache();
    
    // 💡 إنهاء أي جلسة صوتية معلقة فوراً لمنع التداخل مع التصدير
    state.audioSessionId = Date.now() + Math.random();

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
    if (caps.isFree && (caps.canRemoveBranding || caps.canUploadAudio)) {
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
                new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))
            ]);

            if (result === false) {
                restoreUI();
                throw new Error(EXPORT_ERRORS.CANCELLED);
            }

            // Refresh caps after potentially updating the plan from the server
            caps = getUserCapabilities();
        } catch (e) {
            if (e.message === EXPORT_ERRORS.CANCELLED) throw e;
            console.warn("تأخر التحقق من الشبكة، سيتم الاعتماد على حالة الاشتراك المخزنة:", e);
        }
    }

    const sVal = parseInt(UI.vStart.value) || 1;
    const eVal = parseInt(UI.vEnd.value) || getRealVerseCount();
    const startIdx = getAyahIndexByRealNumber(sVal, false);
    const endIdx = getAyahIndexByRealNumber(eVal, true);

    // حساب عدد الآيات الفعلية بدون تكرار للأجزاء المقصوصة
    let uniqueVersesCount = new Set();
    let hasSplitVerses = false;
    for (let i = startIdx; i < endIdx; i++) {
        const ayah = state.ayahs[i];
        if (ayah && ayah.verse_key) uniqueVersesCount.add(ayah.verse_key);
        else uniqueVersesCount.add(`unknown_${i}`);
        
        if (ayah && ayah.isSplit) hasSplitVerses = true;
    }
    const realVerseCount = uniqueVersesCount.size;

    const exportConfig = {
        startIdx,
        endIdx,
        uniqueVersesCount: realVerseCount,
        wantsLocalAudio: state.audioMode === 'local',
        wantsWaveform: UI.showWaveform.checked,
        wantsWatermark: UI.showWatermark.checked,
        wantsNoBranding: !UI.showTarteelLogo.checked,
        hasSplitVerses: hasSplitVerses
    };

    let serverVerified = false;
    
    // فلتر ذكي: إذا كان التصدير ضمن الحدود المجانية بالكامل، فلا داعي لاستهلاك السيرفر
    const isBasicFreeRequest = !exportConfig.wantsLocalAudio && 
                               !exportConfig.wantsWaveform && 
                               !exportConfig.wantsWatermark && 
                               !exportConfig.wantsNoBranding &&
                               !exportConfig.hasSplitVerses;

    if (state.user && supabaseClient && !isBasicFreeRequest) {
        // ⏳ زيادة المهلة لمنع الـ Timeout مع الشبكات البطيئة (الـ Cold Start يأخذ وقتاً)
        const timeoutDuration = isCacheValid ? 4000 : 8000;

        try {
            const rpcPromise = supabaseClient.rpc('verify_export_request', {
                user_id: state.user.id,
                config: { ...exportConfig, uniqueVersesCount: 1 } // تخطي فحص السيرفر لعدد الآيات
            });
            
            const { data, error: rpcError } = await Promise.race([
                rpcPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutDuration))
            ]);

            if (rpcError) throw rpcError;

            if (data && data.allowed === false) {
                restoreUI();
                UI.confirmModal.style.display = 'none';
                showProModal(data.reason || 'limit', data);
                throw new Error(EXPORT_ERRORS.CANCELLED);
            }
            
            state.exportMode = data?.exportMode || 'free';
            serverVerified = true;
        } catch (e) {
            if (e.message === EXPORT_ERRORS.CANCELLED) throw e;
            console.warn("Server verification failed or timed out, using local validation:", e);
        }
    }

    if (!serverVerified) {
        
        // للحسابات الاحترافية (Pro) أو الميزات المجانية، نعتمد على الفحص المحلي (Fallback) في حال فشل السيرفر

        const error = validateExport(caps, exportConfig);
        if (error) {
            restoreUI();
            UI.confirmModal.style.display = 'none';
            showProModal(error.type, error);
            throw new Error(EXPORT_ERRORS.CANCELLED);
        }

        state.exportMode = caps.isFree ? 'free' : 'pro';
    }

    // --- All checks passed securely ---
    restoreUI();
    UI.confirmModal.style.display = 'none';
    if (exportQueue.isCancelled) throw new Error(EXPORT_ERRORS.CANCELLED);

    // تفريغ الفيديو القديم من الذاكرة فقط بعد اجتياز جميع الفحوصات وقبل البدء الفعلي
    if (state.exportBlobUrl) {
        try { URL.revokeObjectURL(state.exportBlobUrl); } catch(e) {}
        state.exportBlobUrl = null;
    }

    let maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await realExport(caps);
        } catch (err) {
            if (err.message.startsWith("WebCodecs Encoder fallback") && attempt < maxAttempts) {
                console.info(`Retrying export seamlessly... (${err.message})`);
                continue;
            }
            throw err;
        }
    }
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

    resetExportProgress();
    updateExportStatus("جاري تجهيز الصوت والخطوط...");

    UI.sidebar.classList.add('sidebar-disabled'); UI.playBtn.disabled = true; UI.playBtn.style.opacity = "0";
    UI.exportOverlay.style.display = "flex"; UI.exportProcessingUI.classList.remove('hidden'); UI.exportFinishedUI.classList.add('hidden');

    // إيقاف تشغيل الفيديو التلقائي للتحكم اليدوي الدقيق في الوقت والإطارات (Manual Frame Extraction)
    if (state.mediaType === 'video' && state.bgVideo) {
        if (!state.bgVideo.paused) state.bgVideo.pause();
        
        // 🔴 الحل السحري لمشكلة تجميد الفيديو على جوجل كروم للأجهزة العادية:
        // كروم يقوم بتجميد الفيديوهات الشفافة جداً أو متناهية الصغر لتوفير الموارد.
        // لنجبره على معالجة الإطارات بدقة، نرفع الشفافية والحجم أثناء التصدير.
        state.bgVideo.style.opacity = '1';
        state.bgVideo.style.width = '320px';
        state.bgVideo.style.height = '240px';

        // 💡 معالجة مشكلة (Infinity Duration) الشهيرة في متصفح كروم للتمكن من عمل Loop سليم
        if (!isFinite(state.bgVideo.duration) || isNaN(state.bgVideo.duration)) {
            state.bgVideo.currentTime = 1e101;
            await new Promise(r => {
                const onTimeUpdate = () => {
                    state.bgVideo.removeEventListener('timeupdate', onTimeUpdate);
                    state.bgVideo.currentTime = 0;
                    r();
                };
                state.bgVideo.addEventListener('timeupdate', onTimeUpdate);
                // مهلة آمنة لو فشل التحديث
                setTimeout(() => { state.bgVideo.removeEventListener('timeupdate', onTimeUpdate); r(); }, 1500);
            });
        }
    }

    let FPS = state.exportFPS || 30; // جلب معدل الإطارات المختار
    const rawStartIdx = getAyahIndexByRealNumber(parseInt(UI.vStart.value) || 1, false);
    const rawEndIdx = getAyahIndexByRealNumber(parseInt(UI.vEnd.value) || getRealVerseCount(), true);
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
    if (typeof window.VideoEncoder === 'undefined' && state.fastExport) {
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

    const useFFmpegEncoder = state.fastExport ? false : true;
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

        let audioCodecName = 'mp4a.40.2';
        let muxerAudioCodec = 'aac';

        if (window.AudioEncoder) {
            useNativeAudio = true;
            try {
                const supportAAC = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: sampleRate, numberOfChannels: 2, bitrate: 128000 });
                if (!supportAAC.supported) {
                    const supportOpus = await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: sampleRate, numberOfChannels: 2, bitrate: 128000 });
                    if (supportOpus.supported) {
                        audioCodecName = 'opus';
                        muxerAudioCodec = 'opus';
                    }
                }
            } catch (e) {
                console.warn("Audio check fallback.", e);
            }
        } else {
            console.warn("AudioEncoder not supported natively, falling back to alternative encoder.");
        }

        muxer = new Muxer({
            target: muxerTarget,
            video: { codec: 'avc', width: exportW, height: exportH },
            audio: useNativeAudio ? { codec: muxerAudioCodec, numberOfChannels: 2, sampleRate: sampleRate } : undefined,
            fastStart: 'in-memory'
        });

        if (useNativeAudio) {
            updateExportStatus("جاري ترميز الصوت...");
            const audioEncoder = new AudioEncoder({
                output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
                error: e => console.error("Audio encode error:", e)
            });
            audioEncoder.configure({
                codec: audioCodecName,
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
                const encProgress = 25 + ((start / length) * 5);
                setExportProgress(encProgress);

                if (start % (sampleRate * 5) === 0) await new Promise(r => setTimeout(r, 0));
            }
            if (!exportQueue.isCancelled) {
                await audioEncoder.flush();
                setExportProgress(30);
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

        // 💡 التزامن الذكي بالـ MB مع الـ Worker لمنع عدم تطابق الكاش (Cache Mismatch)
        const bgFrameCacheKeys = new Map();
        const isLowMemoryDevice = navigator.deviceMemory && navigator.deviceMemory <= 4;
        const MAX_BG_CACHE_MB = isLowMemoryDevice ? 80 : 200;
        let currentBgCacheSize = 0;

        const addBgFrameToCacheKeys = (key, w, h) => {
            const size = w * h * 4 * 0.75;
            if (bgFrameCacheKeys.has(key)) {
                currentBgCacheSize -= bgFrameCacheKeys.get(key);
                bgFrameCacheKeys.delete(key);
            }
            bgFrameCacheKeys.set(key, size);
            currentBgCacheSize += size;
            
            while (currentBgCacheSize > MAX_BG_CACHE_MB * 1024 * 1024) {
                const firstKey = bgFrameCacheKeys.keys().next().value;
                currentBgCacheSize -= bgFrameCacheKeys.get(firstKey);
                bgFrameCacheKeys.delete(firstKey);
            }
        };

        // تجهيز خريطة لأرقام الآيات الحقيقية لتجنب عد الأجزاء كآيات جديدة في شريط التقدم
        const realVerseCountMap = [];
        let currentUniqueCount = 0;
        let seenKeys = new Set();
        for (let i = startIdx; i < endIdx; i++) {
            const key = state.ayahs[i] ? state.ayahs[i].verse_key : i;
            if (!seenKeys.has(key)) {
                seenKeys.add(key);
                currentUniqueCount++;
            }
            realVerseCountMap[i] = currentUniqueCount;
        }
        const totalRealVerses = currentUniqueCount;

        // --- Step 5: The Render Loop Conductor (Pipelined) ---
        let currentFrame = 0;
        let pendingFrames = 0;
        const MAX_PENDING_FRAMES = 3; // Double/Triple Buffering (معالجة إطارات بالتوازي)
        let isExportFinished = false;

        let lastAyahForKeyframe = -1;
        let fallbackCanvas = null;
        let fallbackCtx = null;
        let pendingFramesResolver = null;

        const checkFinish = () => {
            if (isExportFinished && pendingFrames === 0 && !exportQueue.isCancelled) {
                state.worker.postMessage({ type: 'finishExport' });
            }
        };

        const processFrame = async (frameIdx) => {
            if (exportQueue.isCancelled) return;

            const timestampSec = frameIdx / FPS;
            const timestampUs = Math.round(timestampSec * 1_000_000);

            // --- تحديث إطار الفيديو الخلفي لمزامنته مع التصدير ---
            if (state.mediaType === 'video' && state.bgVideo && state.bgVideo.readyState >= 2) {
                let vidDuration = state.bgVideo.duration;
                if (!isFinite(vidDuration) || isNaN(vidDuration) || vidDuration === 0) vidDuration = 10;
                
                // 💡 التكرار السليم (Loop) مع تجنب آخر 0.1 ثانية لمنع تجميد الفريم الأخير الذي يسبب المشكلة
                const safeDuration = Math.max(0.1, vidDuration - 0.1);
                const targetTime = timestampSec % safeDuration;
                
                // 💡 الحل الاحترافي: مفتاح دقيق وثابت برمجياً لمنع التكرار الناتج عن التقريب العشري
                const cacheKey = `bg_frame_${frameIdx}`;
                
                if (state.mediaType !== 'video' && bgFrameCacheKeys.has(cacheKey)) {
                    // ✅ الفريم موجود! متعيدش Decode، ارسم مباشرة
                    const size = bgFrameCacheKeys.get(cacheKey);
                    bgFrameCacheKeys.delete(cacheKey); // LRU: إزالة القديم
                    bgFrameCacheKeys.set(cacheKey, size); // إضافته في النهاية ليكون الأحدث
                    state.worker.postMessage({ type: 'useCachedBg', cacheKey: cacheKey, timestamp: timestampUs });
                } else {
                // 🔴 استخدام الدالة المخصصة لانتظار الـ Decoding 
                await seekFrame(state.bgVideo, targetTime);
                
                // إجبار المتصفح يرسم الفريم الحقيقي قبل السحب
                await new Promise(r => requestAnimationFrame(r));
                await new Promise(r => requestAnimationFrame(r));
                await new Promise(r => setTimeout(r, 0));

                if (Math.abs(state.bgVideo.currentTime - targetTime) > 0.05) {
                    await seekFrame(state.bgVideo, targetTime);
                    await new Promise(r => requestAnimationFrame(r));
                }

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
                    if (frameSent && state.mediaType !== 'video') {
                        addBgFrameToCacheKeys(cacheKey, fallbackCanvas.width, fallbackCanvas.height);
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
            const progressRange = useNativeAudio ? (100 - baseProgress) : (85 - baseProgress);
            const progress = baseProgress + ((frameIdx / totalFrames) * progressRange);
            
            // تحسين: تحديث شريط التقدم كل 3 إطارات ليتزامن مع دورة إرسال البيانات (Batch)
            if (frameIdx % 3 === 0 || frameIdx === totalFrames - 1) {
                const currentRealVerse = realVerseCountMap[currentAyahGlobalIndex] || 1;
                setExportProgress(progress); updateExportStatus(`الآية ${currentRealVerse} من ${totalRealVerses}`);
            }

            // استخراج بيانات الترددات الحقيقية للموجة (محاكاة دقيقة لـ AnalyserNode)
            if (precomputedWaveData && precomputedWaveData[frameIdx]) {
                state.worker.postMessage({ type: 'audioData', data: precomputedWaveData[frameIdx] });
            } else {
                if (frameIdx === 0) state.worker.postMessage({ type: 'audioData', data: null });
            }

            // 💡 تفعيل تأثير الحركة (Animation) على الأجزاء المقسمة بناءً على طلبك
            let isTextContinuation = false;
            if (currentAyahGlobalIndex > 0) {
                const prevAyah = state.ayahs[currentAyahGlobalIndex - 1];
                const currAyah = state.ayahs[currentAyahGlobalIndex];
                if (prevAyah && currAyah && prevAyah.isSplit && currAyah.isSplit && prevAyah.audioUrl === currAyah.audioUrl) {
                    isTextContinuation = true;
                }
            }
            const fadeDuration = isTextContinuation ? 0.2 : 0.5; // تسريع الحركة لضمان التزامن
            const animProgress = Math.min(timeIntoAyah / fadeDuration, 1.0);
            const ayah = state.ayahs[currentAyahGlobalIndex];
            const s = state.surahs.find(x => x.id == state.selectedSurah);
            let v = UI.fontVersion.value;
            const pageNum = ayah ? ayah.page_number : 1;

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
                } else { rawText = ''; }
            } else if (v === 'pt_bold') {
                fontName = 'PT Bold Heading';
                fontUrl = new URL('fonts/PT%20Bold%20Heading/PT%20Bold%20Heading.woff2', window.location.href).href;
                if (ayah) {
                    rawText = `${ayah.text_uthmani}`;
                } else { rawText = ''; }
            } else { fontName = `QuranPage${v.toUpperCase()}_${pageNum}`; fontUrl = new URL(`fonts/${v}/p${pageNum}.woff2`, window.location.href).href; rawText = ayah ? ((v === 'v2') ? ayah.code_v2 : ayah.code_v1) : ''; }

            const payload = {
                mediaType: state.mediaType,
                bgX: state.bgX, bgY: state.bgY, zoom: state.zoom, blur: state.blur, overlayOpacity: state.overlayOpacity, fitMode: 'cover',
                surahName: s ? s.name_arabic : '',
                ayahText: (rawText || "").replace(/\s+/g, ' ').trim(), translation: ayah ? ayah.translation : '',
                fontName: fontName, fontUrl: fontUrl, fontSize: state.fontSize, textY: state.textY,
                textColor: UI.textColor.value, shadowColor: UI.shadowColor.value, shadowBlur: state.shadowBlur,
                transTextColor: UI.transTextColor.value, transShadowColor: UI.transShadowColor.value, transShadowBlur: state.transShadowBlur,
                animType: UI.animType.value, animIntensity: state.animIntensity,
                isContinuation: isTextContinuation,
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
            let isKeyFrame = (frameIdx % 300 === 0);
            if (currentAyahGlobalIndex !== lastAyahForKeyframe) {
                isKeyFrame = true;
                lastAyahForKeyframe = currentAyahGlobalIndex;
            }

            state.worker.postMessage({ type: 'encodeFrame', frameNumber: frameIdx, timestamp: timestampUs, keyFrame: isKeyFrame, payload: payload });
        };

        const pumpFrames = async () => {
            while (currentFrame < totalFrames && !exportQueue.isCancelled) {
                if (pendingFrames >= MAX_PENDING_FRAMES) {
                    // انتظار انتهاء إطار واحد على الأقل قبل إرسال إطار جديد (Backpressure)
                    await new Promise(resolve => {
                        pendingFramesResolver = resolve;
                    });
                }
                if (exportQueue.isCancelled) break;

                const frameIdx = currentFrame++;
                pendingFrames++;
                
                // إرسال الإطار للتحضير (وهو دالة غير متزامنة لكننا ننتظر استخراج صورة الفيديو فقط)
                await processFrame(frameIdx);
            }
            isExportFinished = true;
            checkFinish();
        };

        // --- Step 6: Listen for worker messages and drive the loop ---
        return new Promise((resolveExport, rejectExport) => {
            const onWorkerMessage = async (e) => {
            const { type, ...data } = e.data;
            switch (type) {
                case 'encoderReady': pumpFrames(); break;
                case 'frameEncoded': 
                    pendingFrames--; 
                    if (pendingFramesResolver) { pendingFramesResolver(); pendingFramesResolver = null; }
                    checkFinish(); 
                    break;
                case 'ffmpegFrame':
                    if (exportQueue.isCancelled) return;
                    ensureFFmpegReady().then(({ ffmpeg }) => {
                        ffmpeg.writeFile(`frame_${data.frameNumber}.jpg`, new Uint8Array(data.buffer)).then(() => {
                            pendingFrames--; 
                            if (pendingFramesResolver) { pendingFramesResolver(); pendingFramesResolver = null; }
                            checkFinish();
                        });
                    });
                    break;
                case 'ffmpegFinished':
                    (async () => {
                        try {
                            if (exportQueue.isCancelled) throw new Error(EXPORT_ERRORS.CANCELLED);
                            UI.loader.classList.remove('hidden');
                            UI.loaderText.textContent = "جاري تجميع الفيديو...";
                            updateExportStatus("جاري الدمج النهائي...");

                            const { ffmpeg } = await ensureFFmpegReady();
                            await ffmpeg.writeFile('audio.wav', new Uint8Array(wavBuffer));

                            const onFFmpegProgress = ({ progress }) => {
                                const p = Math.max(0, Math.min(1, Number(progress) || 0));
                                const percent = 85 + (p * 15);
                                setExportProgress(percent);
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
                                '-b:a', '192k',
                                '-shortest',
                                '-threads', '0',
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

                            // ================================
                            // Smart Thumbnail Generator
                            // ================================
                            try {
                                const thumbCanvas = document.createElement('canvas');

                                thumbCanvas.width = 1280;
                                thumbCanvas.height = 720;

                                const ctx = thumbCanvas.getContext('2d');

                                ctx.drawImage(
                                    UI.canvas || document.getElementById('previewCanvas'),
                                    0,
                                    0,
                                    thumbCanvas.width,
                                    thumbCanvas.height
                                );

                                const thumbBlob = await new Promise(resolve => {
                                    thumbCanvas.toBlob(
                                        resolve,
                                        'image/jpeg',
                                        0.95
                                    );
                                });

                                if (state.thumbnailUrl) {
                                    URL.revokeObjectURL(state.thumbnailUrl);
                                }

                                state.thumbnailBlob = thumbBlob;
                                state.thumbnailUrl = URL.createObjectURL(thumbBlob);

                            } catch (e) {
                                console.warn(e);
                            }

                            updateExportButtonState();
                            resolveExport(state.exportBlobUrl);

                        } catch (err) {
                            if (err.message === EXPORT_ERRORS.CANCELLED) return resolveExport(null);
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
                        if (exportQueue.isCancelled) throw new Error(EXPORT_ERRORS.CANCELLED);
                        
                        UI.loader.classList.remove('hidden');
                        UI.loaderText.textContent = "جاري التحميل";
                        
                        muxer.finalize();
                        const { buffer } = muxerTarget;
                        const tempVideoBlob = new Blob([buffer], { type: 'video/mp4' });

                        let finalBlob = tempVideoBlob;
                        if (!useNativeAudio) {
                            if (exportQueue.isCancelled) throw new Error(EXPORT_ERRORS.CANCELLED);
                            finalBlob = await finalizeWithFFmpeg(tempVideoBlob, new Uint8Array(wavBuffer), sampleRate);
                        } else {
                            setExportProgress(100);
                        }

                        if (exportQueue.isCancelled) throw new Error(EXPORT_ERRORS.CANCELLED);

                        state.exportBlobUrl = URL.createObjectURL(finalBlob);
                        state.exportFormat = 'mp4';

                        // ================================
                        // Smart Thumbnail Generator
                        // ================================
                        try {
                            const thumbCanvas = document.createElement('canvas');

                            thumbCanvas.width = 1280;
                            thumbCanvas.height = 720;

                            const ctx = thumbCanvas.getContext('2d');

                            ctx.drawImage(
                                UI.canvas || document.getElementById('previewCanvas'),
                                0,
                                0,
                                thumbCanvas.width,
                                thumbCanvas.height
                            );

                            const thumbBlob = await new Promise(resolve => {
                                thumbCanvas.toBlob(
                                    resolve,
                                    'image/jpeg',
                                    0.95
                                );
                            });

                            if (state.thumbnailUrl) {
                                URL.revokeObjectURL(state.thumbnailUrl);
                            }

                            state.thumbnailBlob = thumbBlob;
                            state.thumbnailUrl = URL.createObjectURL(thumbBlob);

                        } catch (e) {
                            console.warn(e);
                        }

                        updateExportButtonState();
                        resolveExport(state.exportBlobUrl);
                    } catch (err) {
                        if (err.message === EXPORT_ERRORS.CANCELLED) {
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
                    state.worker.removeEventListener('message', onWorkerMessage);
                    if (pendingFramesResolver) { pendingFramesResolver(); pendingFramesResolver = null; }
                    
                    // التحويل التدريجي (WebCodecs Software -> ثم FFmpeg)
                    if (data.error && state.fastExport) {
                        if (state.webCodecsFallbackLevel === 0) {
                            console.warn("Hardware WebCodecs encoder failed. Retrying with Software WebCodecs...", data.error);
                            state.webCodecsFallbackLevel = 1;
                            rejectExport(new Error("WebCodecs Encoder fallback software"));
                        } else {
                            console.warn("Software WebCodecs encoder failed. Falling back to FFmpeg...", data.error);
                            state.fastExport = false;
                            state.webCodecsFallbackLevel = 0;
                            if (document.getElementById('btnExportFast')) document.getElementById('btnExportFast').classList.remove('active');
                            if (document.getElementById('btnExportFfmpeg')) document.getElementById('btnExportFfmpeg').classList.add('active');
                            rejectExport(new Error("WebCodecs Encoder fallback ffmpeg"));
                        }
                    } else {
                        resetExportUI();
                        alert(`حدث خطأ أثناء التصدير: ${data.error}`);
                        rejectExport(new Error(data.error));
                    }
                    break;
                case 'exportAborted':
                    // تنظيف الذاكرة بعد الإلغاء
                    state.worker.removeEventListener('message', onWorkerMessage);
                    if (useFFmpegEncoder) {
                        ensureFFmpegReady().then(({ ffmpeg }) => {
                            for(let i=0; i<=currentFrame; i++) ffmpeg.deleteFile(`frame_${i}.jpg`).catch(()=>{});
                        });
                    }
                        if (pendingFramesResolver) { pendingFramesResolver(); pendingFramesResolver = null; }
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
        let h264Main = 'avc1.4d0034';
        let h264Baseline = 'avc1.42E01F';
        
        let h264Codec = state.webCodecsFallbackLevel === 1 ? h264Baseline : h264Main;
        let hwAccel = state.webCodecsFallbackLevel === 1 ? "prefer-software" : "prefer-hardware";
        
        finalVideoCodecConfig = format === 'webm' ? 
            { codec: vp9Codec, width: exportW, height: exportH, framerate: FPS, bitrate: dynamicBitrate, bitrateMode: "variable", hardwareAcceleration: hwAccel } : 
            { codec: h264Codec, width: exportW, height: exportH, framerate: FPS, bitrate: dynamicBitrate, bitrateMode: "variable", avc: { format: 'avc' }, hardwareAcceleration: hwAccel };

        if (window.VideoEncoder) {
            let support = await window.VideoEncoder.isConfigSupported(finalVideoCodecConfig);
            
            if (!support.supported && format !== 'webm') {
                finalVideoCodecConfig.codec = h264Baseline;
                finalVideoCodecConfig.hardwareAcceleration = "prefer-software";
                support = await window.VideoEncoder.isConfigSupported(finalVideoCodecConfig);
            }

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
            fontUrl = 'https://cdn.jsdelivr.net/gh/zyadabdelbaqi/tarteel-assets@main/fonts/AlMushaf/AlMushaf.woff2';
        } else if (v === 'pt_bold') {
            fontName = 'PT Bold Heading';
            fontUrl = 'https://cdn.jsdelivr.net/gh/zyadabdelbaqi/tarteel-assets@main/fonts/PT%20Bold%20Heading/PT%20Bold%20Heading.woff2';
        } else {
            const pageNum = ayah.page_number || 1;
            fontName = `QuranPage${v.toUpperCase()}_${pageNum}`;
            fontUrl = `https://cdn.jsdelivr.net/gh/zyadabdelbaqi/tarteel-assets@main/fonts/${v}/p${pageNum}.woff2`;
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
                const key = `${state.selectedReciter}_${j}`;
                if (state.audioCache[key]) {
                    const { startSilence, endSilence } = calculateSilence(state.audioCache[key]);
                    const fullPlayDuration = Math.max(0.1, state.audioCache[key].duration - startSilence - endSilence);
                    const durationRatio = state.ayahs[j].splitDurationRatio || 1;
                    state.ayahs[j].exactDuration = fullPlayDuration * durationRatio;
                } else if (state.ayahs[j]?.audioUrl) {
                    totalToLoad++;
                    promises.push(
                        fetchAudioBuffer(state.ayahs[j].audioUrl).then(buf => {
                            if (buf) {
                                addToAudioCache(j, buf);
                                const { startSilence, endSilence } = calculateSilence(buf);
                                const fullPlayDuration = Math.max(0.1, buf.duration - startSilence - endSilence);
                                const durationRatio = state.ayahs[j].splitDurationRatio || 1;
                                state.ayahs[j].exactDuration = fullPlayDuration * durationRatio;
                            }
                            loadedCount++;
                            const progress = (loadedCount / totalToLoad) * 10;
                            setExportProgress(progress);
                        })
                    );
                }
            }
            if (totalToLoad === 0) { setExportProgress(10); }
            await Promise.all(promises);

            updateExportStatus("جاري حساب التوقيتات...");

            for (let j = startIdx; j < endIdx; j++) {
                if (exportQueue.isCancelled) break;
                onlineVerseTimings.push({ index: j, start: Math.max(0, elapsed) });
                
                const isNextContinuation = j + 1 < endIdx && state.ayahs[j+1] && state.ayahs[j+1].audioUrl === state.ayahs[j].audioUrl && state.ayahs[j+1].isSplit;

                if (state.ayahs[j].exactDuration) {
                    const dur = state.ayahs[j].exactDuration;
                    let overlap = 0;
                    if (!isNextContinuation) {
                        overlap = Math.min(0.22, Math.max(0.04, dur * 0.065));
                        overlap = Math.min(overlap, dur * 0.5);
                    }
                    elapsed += dur - overlap;
                } else { elapsed += state.ayahs[j].apiDuration || 5; }
                
                const progress = 10 + (((j - startIdx + 1) / (endIdx - startIdx)) * 5);
                setExportProgress(progress);
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
                const key = `${state.selectedReciter}_${i}`;
                if (state.audioCache[key]) {
                    const { startSilence, endSilence } = calculateSilence(state.audioCache[key]);
                    const fullPlayDuration = Math.max(0.1, state.audioCache[key].duration - startSilence - endSilence);
                    const durationRatio = state.ayahs[i].splitDurationRatio || 1;
                    state.ayahs[i].exactDuration = fullPlayDuration * durationRatio;
                } else if (state.ayahs[i] && state.ayahs[i].audioUrl) {
                    totalPreload++;
                    initialFetchPromises.push(fetchAudioBuffer(state.ayahs[i].audioUrl).then(buf => {
                        if (buf) {
                            addToAudioCache(i, buf);
                            const { startSilence, endSilence } = calculateSilence(buf);
                            const fullPlayDuration = Math.max(0.1, buf.duration - startSilence - endSilence);
                            const durationRatio = state.ayahs[i].splitDurationRatio || 1;
                            state.ayahs[i].exactDuration = fullPlayDuration * durationRatio;
                        }
                        preloadCount++;
                        const p = (preloadCount / totalPreload) * 5;
                        setExportProgress(p);
                    }));
                }
            }
            if (totalPreload === 0) { setExportProgress(5); }
            if (initialFetchPromises.length > 0) await Promise.all(initialFetchPromises);

            const BATCH_SIZE = 10;
            for (let i = startIdx; i < endIdx; i += BATCH_SIZE) {
                if (exportQueue.isCancelled) break;
                const batchEnd = Math.min(i + BATCH_SIZE, endIdx);
                
                const fetchPromises = [];
                for (let j = i; j < batchEnd; j++) {
                    const key = `${state.selectedReciter}_${j}`;
                    if (!state.audioCache[key] && state.ayahs[j] && state.ayahs[j].audioUrl) {
                        fetchPromises.push(fetchAudioRaw(state.ayahs[j].audioUrl));
                    }
                }
                if (fetchPromises.length > 0) await Promise.all(fetchPromises);

                for (let j = i; j < batchEnd; j++) {
                    if (exportQueue.isCancelled) break;
                    onlineVerseTimings.push({ index: j, start: Math.max(0, elapsed) });
                    const isNextContinuation = j + 1 < endIdx && state.ayahs[j+1] && state.ayahs[j+1].audioUrl === state.ayahs[j].audioUrl && state.ayahs[j+1].isSplit;
                    
                    const key = `${state.selectedReciter}_${j}`;
                    let buf = state.audioCache[key];
                    if (!buf && state.ayahs[j] && !state.ayahs[j].exactDuration) {
                        buf = await fetchAudioBuffer(state.ayahs[j].audioUrl);
                        if (buf) addToAudioCache(j, buf);
                    }

                    if (buf) {
                        const { startSilence, endSilence } = calculateSilence(buf);
                        const fullPlayDuration = Math.max(0.1, buf.duration - startSilence - endSilence);
                        const durationRatio = state.ayahs[j].splitDurationRatio || 1;
                        const playDuration = fullPlayDuration * durationRatio;
                        let overlap = 0;
                        if (!isNextContinuation) {
                        overlap = Math.min(0.22, Math.max(0.04, fullPlayDuration * 0.065));
                        overlap = Math.min(overlap, playDuration * 0.5);
                        }
                        elapsed += playDuration - overlap;
                        state.ayahs[j].exactDuration = playDuration;
                    } else if (state.ayahs[j].exactDuration) {
                        const dur = state.ayahs[j].exactDuration;
                        let overlap = 0;
                        if (!isNextContinuation) {
                            overlap = Math.min(0.22, Math.max(0.04, dur * 0.065));
                            overlap = Math.min(overlap, dur * 0.5);
                        }
                        elapsed += dur - overlap;
                    } else { elapsed += state.ayahs[j].apiDuration || 5; }

                    const oldIndex = j - 5;
                    const oldKey = `${state.selectedReciter}_${oldIndex}`;
                    if (state.audioCache[oldKey]) {
                        delete state.audioCache[oldKey];
                        if (state.audioCacheOrder) {
                            const orderIdx = state.audioCacheOrder.indexOf(oldKey);
                            if (orderIdx !== -1) state.audioCacheOrder.splice(orderIdx, 1);
                        }
                    }
                }

                const globalPercent = 5 + (((batchEnd - startIdx) / (endIdx - startIdx)) * 10);
                setExportProgress(globalPercent);
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

    // --- Trigonometric Lookup Tables (Ultra Optimized) ---
    // بما أن N = 128 (مضاعف 2)، فإن الزوايا تتكرر تماماً!
    // نحتاج إلى 128 عنصراً فقط بدلاً من 8,192
    const cosTable = new Float32Array(N);
    const sinTable = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        const angle = i * pi2_N;
        cosTable[i] = Math.cos(angle);
        sinTable[i] = Math.sin(angle);
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
            // دمج عامل النافذة (Window) هنا لتقليل العمليات الحسابية داخل الحلقات العميقة
            channelData[n] = (int16View[offset] / 32768.0) * windowMultipliers[n];
            offset += 2; // تخطي القناة اليمنى وأخذ اليسرى فقط
        }
        
        const waveData = new Uint8Array(bins);
        
        for (let k = 0; k < bins; k++) {
            let sumR = 0, sumI = 0;
            // المرور فقط على العينات الحقيقية (تخطي الأصفار) للسرعة
            for (let n = 0; n < actualN; n++) {
                const val = channelData[n];
                // استخدام Bitwise AND كبديل فائق السرعة لـ Modulo (%) 
                // لأن 127 = 128 - 1 (تعمل فقط مع مضاعفات 2)
                const idx = (k * n) & 127; 
                sumR += val * cosTable[idx];
                sumI -= val * sinTable[idx];
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
                reject(new Error(EXPORT_ERRORS.CANCELLED)); return;
            }
            if (!state.isPlaying) { clearInterval(checkInterval); recorder.stop(); return; }
            const elapsed = state.audioContext.currentTime - startTime;
            const p = Math.min(99, (elapsed / offlineDuration) * 100);
            setExportProgress(p);
            updateExportStatus(`تسجيل حي (${Math.round(p)}%)... يرجى عدم إغلاق النافذة`);
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
                    const key = `${state.selectedReciter}_${index}`;
                    let buf = state.audioCache[key];
                    if (!buf) { buf = await fetchAudioBuffer(state.ayahs[index].audioUrl); if (buf) addToAudioCache(index, buf); }
                    if (exportQueue.isCancelled) { cleanupChunkCtx(); return null; }
                    if (buf) {
                        const isContinuation = j > 0 && state.ayahs[index].audioUrl === state.ayahs[onlineVerseTimings[j-1].index]?.audioUrl && state.ayahs[index].isSplit;
                        
                        if (!isContinuation) {
                            const { startSilence, endSilence } = calculateSilence(buf);
                            const fullPlayDuration = Math.max(0.1, buf.duration - startSilence - endSilence);
                            const offsetRatio = state.ayahs[index].splitStartRatio || 0;
                            const actualStartSilence = startSilence + (fullPlayDuration * offsetRatio);
                            
                            const audioDurationToPlay = fullPlayDuration * (1 - offsetRatio);
                            const verseEnd = verseStart + audioDurationToPlay;
                            
                            if (verseStart < chunkStart + renderDuration && verseEnd > chunkStart) {
                                const source = chunkCtx.createBufferSource();
                                const fadeGain = chunkCtx.createGain();
                                source.buffer = buf; 
                                source.connect(fadeGain);
                                fadeGain.connect(entryNode);
                                
                                const playStartGlobal = Math.max(verseStart, chunkStart);
                                const playEndGlobal = Math.min(verseEnd, chunkStart + renderDuration);
                                
                                if (playStartGlobal < playEndGlobal) {
                                    const playTimeInChunk = playStartGlobal - chunkStart;
                                    const offsetInBuffer = (playStartGlobal - verseStart) + actualStartSilence;
                                    const playDurationInChunk = playEndGlobal - playStartGlobal;

                                const fadeDur = Math.min(0.03, playDurationInChunk / 2);
                                fadeGain.gain.setValueAtTime(0, playTimeInChunk);
                                fadeGain.gain.linearRampToValueAtTime(1, playTimeInChunk + fadeDur);
                                fadeGain.gain.setValueAtTime(1, Math.max(playTimeInChunk + fadeDur, playTimeInChunk + playDurationInChunk - fadeDur));
                                fadeGain.gain.linearRampToValueAtTime(0, playTimeInChunk + playDurationInChunk);

                                source.start(playTimeInChunk, offsetInBuffer, playDurationInChunk);
                            }
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
                        const key = `${state.selectedReciter}_${idx}`;
                        if (state.audioCache[key]) delete state.audioCache[key];
                    }
                }
            }
            
            const progress = 15 + (((chunkIndex + 1) / totalChunks) * 10);
            setExportProgress(progress);
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
                setExportProgress(mergeProgress);
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
                const key = `${state.selectedReciter}_${index}`;
                let buf = state.audioCache[key];
                if (!buf) { buf = await fetchAudioBuffer(state.ayahs[index].audioUrl); if (buf) addToAudioCache(index, buf); }
                if (exportQueue.isCancelled) { cleanupOfflineCtx(); return null; }
                
                const isContinuation = j > 0 && state.ayahs[index].audioUrl === state.ayahs[onlineVerseTimings[j-1].index]?.audioUrl && state.ayahs[index].isSplit;
                const isNextContinuation = j + 1 < onlineVerseTimings.length - 1 && state.ayahs[onlineVerseTimings[j+1].index].audioUrl === state.ayahs[index].audioUrl && state.ayahs[onlineVerseTimings[j+1].index].isSplit;

                if (buf) {
                    onlineVerseTimings[j].start = currentTime;
                    const { startSilence, endSilence } = calculateSilence(buf);
                    const fullPlayDuration = Math.max(0.1, buf.duration - startSilence - endSilence);
                    const offsetRatio = state.ayahs[index].splitStartRatio || 0;
                    const durationRatio = state.ayahs[index].splitDurationRatio || 1;
                    const actualStartSilence = startSilence + (fullPlayDuration * offsetRatio);
                    const playDuration = fullPlayDuration * durationRatio;
                    
                    if (!isContinuation) {
                        const source = offlineCtx.createBufferSource();
                        const fadeGain = offlineCtx.createGain();
                        source.buffer = buf;
                        const audioDurationToPlay = fullPlayDuration * (1 - offsetRatio);
                        const fadeDur = Math.min(0.03, audioDurationToPlay / 2);
                        fadeGain.gain.setValueAtTime(0, currentTime);
                        fadeGain.gain.linearRampToValueAtTime(1, currentTime + fadeDur);
                        fadeGain.gain.setValueAtTime(1, currentTime + audioDurationToPlay - fadeDur);
                        fadeGain.gain.linearRampToValueAtTime(0, currentTime + audioDurationToPlay);
                        source.connect(fadeGain); fadeGain.connect(entryNode); 
                        source.start(currentTime, actualStartSilence, audioDurationToPlay);
                    }

                    let overlap = 0;
                    if (!isNextContinuation) {
                    overlap = Math.min(0.22, Math.max(0.04, fullPlayDuration * 0.065));
                    overlap = Math.min(overlap, playDuration * 0.5);
                    }
                    currentTime += playDuration - overlap;
                } else {
                    onlineVerseTimings[j].start = currentTime;
                    if (state.ayahs[index].exactDuration) {
                        const dur = state.ayahs[index].exactDuration;
                        let overlap = 0;
                        if (!isNextContinuation) {
                            overlap = Math.min(0.22, Math.max(0.04, dur * 0.065));
                            overlap = Math.min(overlap, dur * 0.5);
                        }
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
            setExportProgress(progress);
        });
        wavBuffer = finalWavBytes.buffer;

        setExportProgress(25);
        updateExportStatus("تمت معالجة الصوت.");
        cleanupOfflineCtx(); await new Promise(r => setTimeout(r, 50));
    }

    if (state.audioMode === 'local' && state.useAudioElement) { state.localAudioBuffer = null; }
    return { wavBuffer, totalSamples };
}

export function resetExportUI() {
    window.onbeforeunload = null;
    state.isRealtimeExport = false;
    state.webCodecsFallbackLevel = 0;
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
    // 💡 ضمان التزامن المطلق: إرسال حالة التصدير الحقيقية للـ Worker المعزول
    if (state.worker) state.worker.postMessage({ type: 'updateState', isExporting: isExporting() });

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
