import { state } from './store.js';

export function getUserCapabilities() {
    const isFree = state.plan === 'free' || !state.plan;
    const perms = state.permissions || {};
    
    // حماية إضافية: ضمان ألا يقل الحد لمستخدمي Pro عن 9999 حتى لو أرسل السيرفر 0 بالخطأ
    const exportLimit = perms.export_limit !== undefined 
        ? (isFree ? perms.export_limit : Math.max(perms.export_limit, 9999)) 
        : (isFree ? 5 : 9999);

    return {
        isFree,
        exportLimit,
        canExport: exportLimit > 0, // أصح وأكثر أماناً ليُطبّق الحد على الجميع (المجاني والمدفوع)
        canUploadAudio: !isFree || !!perms.upload_audio,
        canShowWaveform: !isFree || !!perms.waveform,
        canShowWatermark: !isFree || !!perms.watermark,
        canRemoveBranding: !isFree || !!perms.remove_branding
    };
}

export function getAllowedRange(start, end, customCaps = null) {
    const caps = customCaps || getUserCapabilities();
    if (!caps.isFree) return { start, end };
    const limit = caps.exportLimit;
    return {
        start,
        end: Math.min(start + limit, end)
    };
}