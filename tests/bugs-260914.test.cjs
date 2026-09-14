'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), os = require('node:os');
const { Readable } = require('node:stream');
const premium = require('../server/youtube-premium');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { createDiskTelegram } = require('../server/disk-telegram');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('Premium 视频、音乐及备用客户端解析运行成功，不依赖不存在的 task 变量', async () => {
    const server = source('server.js');
    const code = server.slice(server.indexOf('async function analyzeYoutubePremiumUrl('), server.indexOf('function moveYoutubePremiumOutput('));
    const formats = [
        { format_id: '137', ext: 'mp4', vcodec: 'avc1.64001f', acodec: 'none', width: 720, height: 1280, fps: 30 },
        { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 }
    ];
    for (const mode of ['video', 'song', 'alternate']) {
        let requests = 0;
        const context = vm.createContext({ ...premium, URL,
            parseSupportedSocialUrl: raw => ({ platform: 'youtube', parsed: new URL(raw) }), isYouTubePlaylistOnly: () => false,
            requireYoutubePremiumCookies: () => '/synthetic-cookie', sanitizeString: (value, size) => String(value).slice(0, size),
            classifySnsMedia: () => mode === 'video' ? 'video' : 'song', getYtDlpAudioFormatSelector: () => 'bestaudio', getYtDlpFormatSelector: () => 'bestvideo+bestaudio',
            runYtDlpJson: async () => { requests++; return { id: 'demo', title: 'Demo', formats: mode === 'alternate' && requests === 1 ? [formats[0]] : formats, requested_formats: formats }; },
            enrichYoutubeMusicOrdinalMetadata: async meta => meta, normalizeArtistValue: () => 'Artist',
            buildYoutubeSongMetadata: meta => ({ title: meta.title, artist: 'Artist' }), buildYoutubeReferenceInfo: () => ({}),
            recordExternalDependencyEvent() {}, sanitizeYoutubePremiumError: error => error.message
        });
        const analyze = vm.runInContext(code + ';analyzeYoutubePremiumUrl', context);
        const result = await analyze('https://www.youtube.com/watch?v=demo', { includeFormats: true, forceMusic: mode !== 'video' });
        assert.equal(result.mediaType, mode === 'video' ? 'video' : 'song');
        assert.ok(result.selection.ids.length); assert.ok(result.formats.length);
        if (mode === 'alternate') assert.equal(requests, 2);
    }
});

test('无 MIME 的歌曲仍提取内嵌封面并 PUT 独立图片，歌曲分片与封面提取同时进行', async () => {
    const requests = [], window = {}, coverBytes = Buffer.from('embedded-cover-image');
    const atom = (type, ...parts) => {
        const payload = Buffer.concat(parts), header = Buffer.alloc(8);
        header.writeUInt32BE(payload.length + 8); header.write(type, 4); return Buffer.concat([header, payload]);
    };
    const kind = Buffer.alloc(8); kind.writeUInt32BE(13);
    // M4A cover metadata may be after all media bytes, beyond the legacy 2 MiB read.
    const blob = new Blob([atom('mdat', Buffer.alloc(2 * 1024 * 1024)), atom('moov', atom('udta', atom('meta', Buffer.alloc(4), atom('ilst', atom('covr', atom('data', kind, coverBytes))))))]);
    const app = source('app.js');
    const extractCover = vm.runInNewContext(app.slice(app.indexOf('function readSynchsafeInteger('), app.indexOf('function extractAudioTextFromId3v1Bytes(')) + ';extractAudioPosterFromStoredFile', {
        Blob, TextDecoder, blobToBase64: async blob => 'data:' + blob.type + ';base64,' + Buffer.from(await blob.arrayBuffer()).toString('base64')
    });
    let finished = false, resolveCover, extractionType, reads = 0, imageSource;
    class Image {
        constructor() { this.naturalWidth = this.naturalHeight = 720; }
        set src(value) { imageSource = value; queueMicrotask(() => this.onload?.()); }
    }
    const fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (options.method === 'PUT' && !url.endsWith('/thumbnail')) resolveCover();
        if (url.endsWith('/finish')) finished = true;
        const data = url.endsWith('/uploads') ? { uploadId: 'upload', operation_id: 'operation' } :
            url.endsWith('/finish') ? { operation_id: 'operation' } :
            url.includes('/operations?') ? { operations: [{ operation_id: 'operation', status: finished ? 'completed' : 'running', result: { items: [{ id: 'song' }] } }] } : {};
        return { ok: true, json: async () => data };
    };
    vm.runInNewContext(source('client/disk-client.js'), { window, fetch, Blob, Image, URL, queueMicrotask, setTimeout, clearTimeout, setInterval() {},
        document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: callback => callback(new Blob(['cover'], { type: 'image/jpeg' })) }) }
    });
    window.DiskClient.setAudioCoverExtractor(async (input, file) => {
        assert.equal(input, blob); extractionType = file.type;
        await new Promise(resolve => { resolveCover = resolve; });
        return extractCover({ data: input, name: file.name, type: file.type });
    });
    await window.DiskClient.upload([{ name: 'song.m4a', type: '', size: blob.size }], '', async () => { reads++; return blob; });
    assert.equal(extractionType, 'audio/mp4'); assert.equal(reads, 1);
    assert.equal(imageSource, 'data:image/jpeg;base64,' + coverBytes.toString('base64'));
    const coverIndex = requests.findIndex(entry => entry.url.endsWith('/thumbnail'));
    assert.ok(coverIndex >= 0); assert.ok(coverIndex < requests.findIndex(entry => entry.url.endsWith('/finish')));
    assert.equal(requests[coverIndex].options.method, 'PUT'); assert.equal(requests[coverIndex].options.body.type, 'image/jpeg');
    assert.equal(requests[coverIndex].options.headers['X-Disk-Thumbnail-Size'], '5');
});

test('音乐播放器及列表优先使用独立封面，显示前不读取任何歌曲分片或完整缓存', async () => {
    const ui = source('client/disk-ui.js'), fetched = [];
    const context = vm.createContext({
        getDiskPreviewType: () => 'audio/mp4', encodeURIComponent,
        imageFromSource: async url => { fetched.push(url); return { url }; }, canvasThumbnail: async image => image,
        window: { TelegramDriveCache: { get() { throw Error('must not read song cache'); }, getThumbnail() { throw Error('must not read song cache'); } } }
    });
    vm.runInContext(ui.slice(ui.indexOf('async function generateTelegramDriveThumbnail('), ui.indexOf('function applyTelegramDriveThumbnail(')) +
        ui.slice(ui.indexOf('async function loadDiskAudioPlayerCover('), ui.indexOf('function createDiskMediaPlayer(')) +
        ';this.generate=generateTelegramDriveThumbnail;this.load=loadDiskAudioPlayerCover;', context);
    const item = { id: 'song', name: 'song.m4a', thumbnailAvailable: true, size: 1e8, updatedAt: 7 };
    let displayed;
    await context.load(item, { isConnected: true, replaceChildren(image) { displayed = image; } }, null);
    await context.generate(item);
    assert.equal(displayed.url, '/api/telegram/drive/files/song/thumbnail?v=7');
    assert.deepEqual(fetched, [displayed.url, displayed.url]);
});

test('播放器封面请求结束时若已关闭，不写入旧播放器', async () => {
    const ui = source('client/disk-ui.js'); let finish;
    const context = vm.createContext({ encodeURIComponent, imageFromSource: () => new Promise(resolve => { finish = resolve; }) });
    const load = vm.runInContext(ui.slice(ui.indexOf('async function loadDiskAudioPlayerCover('), ui.indexOf('function createDiskMediaPlayer(')) + ';loadDiskAudioPlayerCover', context);
    const cover = { isConnected: true, replaceChildren() { throw Error('old player updated'); } };
    const request = load({ thumbnailAvailable: true, id: 'song' }, cover, null);
    cover.isConnected = false; finish({}); await request;
});

test('歌曲封面单独发送 Telegram 消息并持久化 file_id、message_id，不计入音频分片', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-cover-upload-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = createTelegramDriveStore({ dataDir: directory }), owner = { id: 'user' };
    const job = store.begin({ owner, files: [{ name: 'song.m4a', type: 'audio/mp4', size: 3 }], maxDepth: 20 });
    await store.receivePart(job.id, 0, Readable.from(['abc']), 'bytes 0-2/3');
    await store.receiveThumbnail(job.id, 0, Readable.from(['jpg']), 3, 'image/jpeg');
    const calls = [];
    const telegram = createDiskTelegram({ dataDir: directory, fetchImpl: async (url, options) => {
        calls.push(url);
        if (options.body) for await (const part of options.body) { /* consume local multipart */ }
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 32, document: { file_id: 'song-cover-file', file_unique_id: 'song-cover-unique' } } }) };
    } });
    const thumbnail = store.markThumbnailUploading(job.id, 0);
    const remote = await telegram.uploadThumbnail({ token: '123:test', channelId: '-100', baseUrl: 'https://api.telegram.org' }, job.files[0], thumbnail);
    store.markThumbnailUploaded(job.id, 0, remote);
    store.markPartUploading(job.id, 0, 1);
    store.markPartUploaded(job.id, 0, 1, { fileId: 'song-file', messageId: 31, size: 3, offset: 0, partIndex: 1, partCount: 1 });
    const [item] = store.commit(job.id, '-100', store.uploadResults(job.id));
    assert.equal(calls.length, 1); assert.ok(calls[0].endsWith('/sendDocument'));
    assert.equal(item.partCount, 1); assert.equal(item.thumbnail.fileId, 'song-cover-file'); assert.equal(item.thumbnail.messageId, 32);
    const restored = createTelegramDriveStore({ dataDir: directory }).get(owner.id, item.id);
    assert.equal(restored.thumbnail.fileUniqueId, 'song-cover-unique');
});
