'use strict';

// Only the optional reference lookup uses this mapping. Do not change extractor,
// track metadata, cookie fallback or format selection language handling.
function referenceLanguages(meta, guessed) {
    if (guessed !== 'zh') return guessed ? [guessed] : [];
    const raw = String(meta.language || meta.audio_language || meta.original_language || '').replace(/_/g, '-');
    const regional = /(?:^|-)hk(?:-|$)/i.test(raw) ? 'zh-HK'
        : /(?:^|-)tw(?:-|$)|hant/i.test(raw) ? 'zh-TW' : 'zh-CN';
    return [regional, 'zh'];
}
module.exports = { referenceLanguages };
