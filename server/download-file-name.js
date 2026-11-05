'use strict';

const path = require('node:path');
const { timestamp } = require('./media-library/processing');

const platforms = { bilibili: 'Bili', netease: 'NEMusic', youtube: 'YT', twitter: 'X', x: 'X',
    facebook: 'FB', line: 'LINE', threads: 'Thr', instagram: 'Ins', tiktok: 'Tk' };
const replacements = { '\\': '＼', '/': '／', ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜' };
const clean = value => String(value || '').replace(/[\\/:*?"<>|]/g, char => replacements[char])
    .replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/[. ]+$/g, '');

function sourceUrl(value, base) {
    try { return new URL(value, base); } catch (_) { return null; }
}

function startTime(value) {
    const start = String(value || '').trim().replace(/^\*/, '').split('-')[0];
    if (!String(value || '').includes('-')) return '';
    let seconds;
    try { seconds = timestamp(start); }
    catch (_) {
        const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/.exec(start);
        if (!match || !match.slice(1).some(Boolean)) return '';
        seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
    }
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
    const remainder = Number((seconds % 60).toFixed(3));
    return (hours ? `${hours}h${minutes}m` : minutes ? `${minutes}m` : '') + remainder + (hours || minutes ? '' : 's');
}

function downloadFileName(task, platform = task.platform) {
    const storedName = task.outputFileName || task.outputPath || '';
    if (!storedName) return '';
    const reference = task.referenceInfo || {};
    const url = sourceUrl(reference.webpageUrl || reference.sourceUrl || task.url);
    const parts = url?.pathname.split('/').filter(Boolean) || [];
    const profile = sourceUrl(reference.uploaderUrl || reference.authorUrl);
    const profileParts = profile?.pathname.split('/').filter(Boolean) || [];
    let uploader = reference.authorHandle || reference.uploaderId || reference.channelId || '';
    let id = reference.videoId || reference.id || '';
    switch (platform) {
        case 'youtube':
            id ||= url?.searchParams.get('v') || (url?.hostname === 'youtu.be' ? parts[0] : ['shorts', 'live', 'embed'].includes(parts[0]) ? parts[1] : '');
            uploader ||= profileParts.at(-1) || '';
            break;
        case 'twitter': case 'x':
            if (parts[1] === 'status') {
                id ||= parts[2];
                if (parts[0] !== 'i') uploader ||= parts[0];
            }
            break;
        case 'tiktok': case 'threads':
            uploader ||= parts[0]?.startsWith('@') ? parts[0] : '';
            id ||= parts.at(-1);
            break;
        case 'instagram':
            id ||= ['p', 'reel', 'tv'].includes(parts[0]) ? parts[1] : '';
            break;
        case 'bilibili':
            id ||= parts.find(part => /^(?:BV[\w]+|av\d+)$/.test(part));
            break;
        case 'netease': {
            const resource = url?.hash ? sourceUrl(url.hash.slice(1), url.origin) : url;
            id ||= resource?.searchParams.get('id') || url?.searchParams.get('id');
            break;
        }
        default:
            id ||= url?.searchParams.get('story_fbid') || url?.searchParams.get('v') || url?.searchParams.get('id') || parts.at(-1);
    }
    uploader ||= profile?.searchParams.get('id') || (profileParts.at(-1)?.includes('.') ? '' : profileParts.at(-1)) || '';
    uploader = clean(uploader).replace(/^[@＠]+/, '').slice(0, 64);
    id = clean(id).slice(0, 80);
    const clip = startTime(task.downloadSections);
    const extension = path.extname(storedName);
    const suffix = (clip ? ` [${clip}]` : '') + (uploader ? `[＠${uploader}]` : '') +
        (platforms[platform] ? `[${platforms[platform]}]` : '') + (id ? `[${id}]` : '');
    const title = clean(reference.title || task.title || path.basename(storedName, extension)) || 'media';
    const limit = Math.max(1, 240 - suffix.length - extension.length);
    return title.slice(0, limit).replace(/[\ud800-\udbff]$/, '') + suffix + extension;
}

module.exports = { downloadFileName };
