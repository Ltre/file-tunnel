'use strict';
// Shared validation seam, independent of the media library's database/UI/jobs.
// The downloader still owns task creation, yt-dlp, authentication and output.
const { timestamp, createMediaProcessing } = require('./media-library/processing');
function sectionDuration(value) {
    const text = String(value || '').trim(); if (!text.startsWith('*') || text.includes(',')) return undefined;
    const parts = text.slice(1).split('-'); if (parts.length !== 2 || parts[1] === 'inf') return undefined;
    try { const duration = timestamp(parts[1]) - timestamp(parts[0]); return duration > 0 ? duration : undefined; } catch (_) { return undefined; }
}
async function verifyDownloadedSection(file, section, tools, signal) {
    if (!String(section || '').trim()) return;
    const engine = createMediaProcessing(tools), probe = await engine.probe(file, signal);
    const audio = probe.streams?.some(s => s.codec_type === 'audio'), video = probe.streams?.some(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
    return engine.verify(file, { signal, audio, video, precise: true, expectedDuration: sectionDuration(section) });
}
module.exports = { sectionDuration, verifyDownloadedSection };
