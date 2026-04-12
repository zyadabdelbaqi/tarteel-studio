export const SUPABASE_URL = "https://trzydxnjtzfbknxzdnkv.supabase.co";
export const SUPABASE_KEY = "sb_publishable_OhfVeWJg6Itn_yUsHlMJTQ_cBgWYgQ-";
export const supabaseClient = (window.supabase && SUPABASE_URL.startsWith('http')) ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

export const state = {
    user: null, plan: 'free', isLightMode: true,
    surahs: [], ayahs: [], reciters: [], translations: [],
    planExpiresAt: null,
    planLastChecked: 0,
    permissions: {},
    selectedSurah: 1, selectedReciter: 7, selectedTranslation: 20,
    currentAyahIndex: 0,
    audioMode: 'online',
    watermarkType: 'image', audioCache: {}, useAudioElement: false,
    localAudioBuffer: null,
    timings: [],
    hasSyncedOnce: false,
    isSyncing: false,
    isPlaying: false, isExporting: false,
    bgImg: new Image(), bgVideo: document.createElement('video'),
    mediaType: 'image',
    audioContext: null, audioGain: null, audioDestination: null, analyser: null,
    dryGain: null, wetGain: null, delayNode: null, feedbackGain: null, filterNode: null, effectEntry: null,
    activeSource: null, nextBuffer: null, mediaSource: null,
    isBgReady: false, lastRenderedAyah: -1,
    bgX: 0, bgY: 0, zoom: 100, blur: 0, overlayOpacity: 0.5,
    fontSize: 85, shadowBlur: 10, transShadowBlur: 0, animIntensity: 30,
    isDragging: false, lastMouseX: 0, lastMouseY: 0,
    backgroundUrl: null, exportBlobUrl: null, exportFormat: 'mp4', exportQuality: '720p', exportFPS: 30,
    worker: null, audioSessionId: 0, mainSyncLoopId: null
};