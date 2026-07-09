import { state } from './store.js';

export function getUserCapabilities() {
    const isFree = state.plan === 'free' || !state.plan;
    const perms = state.permissions || {};
    
    // جعل الحد الأقصى للآيات غير محدود للمجاني بناء على طلب المستخدم
    const exportLimit = 9999;

    return {
        isFree,
        exportLimit,
        canExport: exportLimit > 0, // أصح وأكثر أماناً ليُطبّق الحد على الجميع (المجاني والمدفوع)
        canUploadAudio: !isFree || !!perms.upload_audio,
        canShowWaveform: !isFree || !!perms.waveform,
        canShowWatermark: !isFree || !!perms.watermark,
        canRemoveBranding: !isFree || !!perms.remove_branding,
        canSplitVerses: !isFree || !!perms.split_verses
    };
}

export function getAllowedRange(start, end, customCaps = null) {
    const caps = customCaps || getUserCapabilities();
    if (!caps.isFree) return { start, end };
    const limit = caps.exportLimit;
    
    // حساب الآيات الأصلية الفعلية (بناءً على المفتاح) بدلاً من الأجزاء المقسمة
    let uniqueAyahs = new Set();
    let allowedEndIdx = start;
    
    for (let i = start; i < end; i++) {
        const ayah = state.ayahs[i];
        if (ayah && ayah.verse_key) {
            uniqueAyahs.add(ayah.verse_key);
        } else {
            uniqueAyahs.add(`unknown_${i}`);
        }
        
        if (uniqueAyahs.size > limit) {
            break;
        }
        allowedEndIdx = i + 1;
    }

    return {
        start,
        end: allowedEndIdx
    };
}

export function getRealVerseCount() {
    if (!state.ayahs) return 0;
    let seen = new Set();
    let count = 0;
    for (let i = 0; i < state.ayahs.length; i++) {
        const ayah = state.ayahs[i];
        if (ayah && ayah.verse_key) {
            if (!seen.has(ayah.verse_key)) {
                seen.add(ayah.verse_key);
                count++;
            }
        } else {
            count++;
        }
    }
    return count;
}

export function getAyahIndexByRealNumber(realNumber, isEnd = false) {
    if (!state.ayahs || state.ayahs.length === 0) return 0;
    let foundIdx = -1;
    let currentRealNum = 0;
    let seen = new Set();
    for (let i = 0; i < state.ayahs.length; i++) {
        const ayah = state.ayahs[i];
        if (ayah && ayah.verse_key) {
            if (!seen.has(ayah.verse_key)) { seen.add(ayah.verse_key); currentRealNum++; }
        } else { currentRealNum++; }
        if (currentRealNum === realNumber) {
            if (!isEnd) return i;
            foundIdx = i;
        } else if (currentRealNum > realNumber && foundIdx !== -1) { break; }
    }
    if (isEnd) return foundIdx !== -1 ? foundIdx + 1 : state.ayahs.length;
    return foundIdx !== -1 ? foundIdx : 0;
}

export function getRealNumberByAyahIndex(index) {
    if (!state.ayahs || state.ayahs.length === 0) return 1;
    let seen = new Set();
    let currentRealNum = 0;
    for (let i = 0; i <= index && i < state.ayahs.length; i++) {
        const ayah = state.ayahs[i];
        if (ayah && ayah.verse_key) {
            if (!seen.has(ayah.verse_key)) { seen.add(ayah.verse_key); currentRealNum++; }
        } else { currentRealNum++; }
    }
    return currentRealNum || 1;
}