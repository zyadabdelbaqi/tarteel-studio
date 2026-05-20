// @ts-check
import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export let supabaseClient = null;

export function initSupabase() {
    if (SUPABASE_URL && SUPABASE_URL.startsWith('http')) {
        supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);
    }
}

// --- 1. مجال المصادقة والمستخدم (Auth Domain) ---
/**
 * @typedef {Object} AuthState
 * @property {Object|null} user بيانات المستخدم
 * @property {'free'|'pro'} plan نوع الباقة
 * @property {string|null} planExpiresAt تاريخ الانتهاء
 * @property {number} planLastChecked وقت آخر فحص
 * @property {Object} permissions صلاحيات الحساب
 * @property {boolean} sessionCheckFailed فشل فحص الجلسة (لتقييد الميزات)
 */
/** @type {AuthState} */
export const authState = {
    user: null, plan: 'free', planExpiresAt: null, planLastChecked: 0, permissions: {}, sessionCheckFailed: false
};

// --- 2. مجال بيانات القرآن (Quran Data Domain) ---
/**
 * @typedef {Object} QuranState
 * @property {Array<any>} surahs السور
 * @property {Array<any>} ayahs الآيات
 * @property {Array<any>} reciters القراء
 * @property {Array<any>} translations التراجم
 * @property {number|string} selectedSurah السورة المحددة
 * @property {number} selectedReciter القارئ المحدد
 * @property {number|string} selectedTranslation الترجمة المحددة
 * @property {number} currentAyahIndex مؤشر الآية الحالية
 */
/** @type {QuranState} */
export const quranState = {
    surahs: [], ayahs: [], reciters: [], translations: [],
    selectedSurah: 1, selectedReciter: 9, selectedTranslation: 20,
    currentAyahIndex: 0
};

// --- 3. مجال الصوتيات والمزامنة (Audio & Sync Domain) ---
/**
 * @typedef {Object} AudioState
 * @property {'online'|'local'} audioMode
 * @property {Record<number, AudioBuffer>} audioCache
 * @property {number[]} audioCacheOrder
 * @property {boolean} useAudioElement
 * @property {AudioBuffer|null} localAudioBuffer
 * @property {number[]} timings
 * @property {boolean} hasSyncedOnce
 * @property {boolean} isSyncing
 * @property {boolean} isPlaying
 * @property {AudioContext|null} audioContext
 * @property {GainNode|null} audioGain
 * @property {MediaStreamAudioDestinationNode|null} audioDestination
 * @property {AnalyserNode|null} analyser
 * @property {GainNode|null} dryGain
 * @property {GainNode|null} wetGain
 * @property {DelayNode|null} delayNode
 * @property {GainNode|null} feedbackGain
 * @property {BiquadFilterNode|null} filterNode
 * @property {GainNode|null} effectEntry
 * @property {GainNode|null} makeupGain
 * @property {DynamicsCompressorNode|null} limiter
 * @property {AudioBufferSourceNode|null} activeSource
 * @property {AudioBuffer|null} nextBuffer
 * @property {MediaElementAudioSourceNode|null} mediaSource
 * @property {number} audioSessionId
 */
/** @type {AudioState} */
export const audioState = {
    audioMode: 'online', audioCache: {}, audioCacheOrder: [], useAudioElement: false,
    localAudioBuffer: null, timings: [], hasSyncedOnce: false, isSyncing: false, isPlaying: false,
    audioContext: null, audioGain: null, audioDestination: null, analyser: null,
    dryGain: null, wetGain: null, delayNode: null, feedbackGain: null, filterNode: null, effectEntry: null, makeupGain: null, limiter: null,
    activeSource: null, nextBuffer: null, mediaSource: null, audioSessionId: 0
};

// --- 4. مجال المحرر والواجهة (Editor & UI Domain) ---
/**
 * @typedef {Object} EditorState
 * @property {boolean} isLightMode
 * @property {boolean} isBgReady
 * @property {number} lastRenderedAyah
 * @property {HTMLImageElement} bgImg
 * @property {HTMLVideoElement} bgVideo
 * @property {'image'|'video'} mediaType
 * @property {number} bgX
 * @property {number} bgY
 * @property {number} zoom
 * @property {number} blur
 * @property {number} overlayOpacity
 * @property {number} fontSize
 * @property {number} textY
 * @property {number} shadowBlur
 * @property {number} transShadowBlur
 * @property {number} animIntensity
 * @property {boolean} isDragging
 * @property {number} lastMouseX
 * @property {number} lastMouseY
 * @property {string|null} backgroundUrl
 * @property {'image'|'text'} watermarkType
 * @property {boolean} showBasmala
 * @property {number} basmalaNumber
 * @property {number} basmalaX
 * @property {number} basmalaY
 * @property {number} basmalaSize
 * @property {string} basmalaColor
 * @property {string} basmalaShadowColor
 * @property {number} basmalaShadowBlur
 */
/** @type {EditorState} */
export const editorState = {
    isLightMode: true, isBgReady: false, lastRenderedAyah: -1,
    bgImg: new Image(), bgVideo: document.createElement('video'), mediaType: 'image',
    bgX: 0, bgY: 0, zoom: 100, blur: 0, overlayOpacity: 0.5,
    fontSize: 75, textY: 50, shadowBlur: 15, transShadowBlur: 0, animIntensity: 30,
    isDragging: false, lastMouseX: 0, lastMouseY: 0, backgroundUrl: null, watermarkType: 'image',
    showBasmala: false, basmalaNumber: 6, basmalaX: 50, basmalaY: 15, basmalaSize: 90, basmalaColor: '#ffffff', basmalaShadowColor: '#000000', basmalaShadowBlur: 10
};

// --- 5. مجال التصدير والمعالجة (Export & Worker Domain) ---
/**
 * @typedef {Object} ExportState
 * @property {string|null} exportBlobUrl
 * @property {string} exportFormat
 * @property {string} exportQuality
 * @property {number} exportFPS
 * @property {'free'|'pro'} exportMode
 * @property {Worker|null} worker
 * @property {number|null} mainSyncLoopId
 * @property {string|null} thumbnailUrl
 * @property {Blob|null} thumbnailBlob
 */
/** @type {ExportState} */
export const exportState = {
    exportBlobUrl: null, exportFormat: 'mp4', exportQuality: '720p', exportFPS: 30, exportMode: 'free',
    fastExport: false,
    webCodecsFallbackLevel: 0,
    worker: null, mainSyncLoopId: null,
    thumbnailUrl: null,
    thumbnailBlob: null
};

// 🧠 وكيل ذكي (Smart Proxy) للحفاظ على التوافقية مع الكود القديم (Backward Compatibility)
// يسمح بانتقال فريق العمل تدريجياً لاستخدام المجالات المنفصلة دون كسر التطبيق الحالي.
const stateDomains = [authState, quranState, audioState, editorState, exportState];

/** @type {any & AuthState & QuranState & AudioState & EditorState & ExportState} */
export const state = new Proxy({}, {
    get(target, prop) {
        for (const domain of stateDomains) {
            if (prop in domain) return domain[prop];
        }
        return target[prop]; // للحقول المضافة ديناميكياً
    },
    set(target, prop, value) {
        for (const domain of stateDomains) {
            if (prop in domain) {
                domain[prop] = value;
                return true;
            }
        }
        target[prop] = value; // إضافة الخاصية الجديدة للكائن الرئيسي إن لم تنتمي لأي مجال
        return true;
    },
    // ضمان عمل الوظائف المبنية على كائنات مثل (...state) و Object.keys(state)
    ownKeys(target) {
        const keys = new Set(Reflect.ownKeys(target));
        for (const domain of stateDomains) {
            Reflect.ownKeys(domain).forEach(k => keys.add(k));
        }
        return Array.from(keys);
    },
    getOwnPropertyDescriptor(target, prop) {
        for (const domain of stateDomains) {
            if (prop in domain) {
                return Reflect.getOwnPropertyDescriptor(domain, prop);
            }
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
    }
});