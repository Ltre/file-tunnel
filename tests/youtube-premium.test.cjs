const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const {
    createYoutubePremiumService,
    extractYoutubeMetadataYear,
    getPreferredMusicAudioFormat,
    getPreferredPremiumVideoFormat,
    getSelectedFormatIds,
    normalizeYtDlpFormats,
    resolveYoutubePremiumMediaType,
    validateFormatSelection
} = require('../server/youtube-premium');

const ROOT = path.resolve(__dirname, '..');

function waitFor(check, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const poll = () => {
            const value = check();
            if (value) return resolve(value);
            if (Date.now() >= deadline) return reject(new Error('wait-for-timeout'));
            setTimeout(poll, 10);
        };
        poll();
    });
}

function sampleFormats() {
    return normalizeYtDlpFormats([
        { format_id: '137', ext: 'mp4', width: 1920, height: 1080, fps: 30, vcodec: 'avc1.640028', acodec: 'none', vbr: 4200 },
        { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129.4, asr: 44100 },
        { format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 152 },
        { format_id: '248', ext: 'webm', height: 1080, vcodec: 'vp9', acodec: 'none' },
        { format_id: '18', ext: 'mp4', height: 360, vcodec: 'avc1.42001E', acodec: 'mp4a.40.2' },
        { format_id: '', ext: 'jpg', vcodec: 'none', acodec: 'none' }
    ]);
}

function loadExtensionSyncServer(fetchImpl) {
    const source = fs.readFileSync(path.join(ROOT, 'tools', 'auto-sync-sns-cookies', 'chrome', 'background.js'), 'utf8');
    const implementation = source.match(/async function syncServer\(server, files\) \{[\s\S]*?\n\}(?=\n\nasync function syncSnsCookies)/)?.[0];
    assert.ok(implementation, 'syncServer implementation not found');
    return new Function('fetch', 'normalizeServerUrl', 'normalizeSyncToken', `${implementation}; return syncServer;`)(
        fetchImpl,
        value => value,
        value => value
    );
}

function loadPremiumForwardReceiver(assetDir) {
    const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const implementation = source.match(/async function receiveYoutubePremiumForwardUpload\(req, task\) \{[\s\S]*?\n\}(?=\n\nasync function forwardYoutubePremiumTaskToTunnel)/)?.[0];
    assert.ok(implementation, 'Premium forward upload receiver not found');
    return new Function('pipeline', 'fs', 'path', 'crypto', 'TELEGRAM_ASSET_DIR',
        `${implementation}; return receiveYoutubePremiumForwardUpload;`
    )(pipeline, fs, path, crypto, assetDir);
}

test('yt-dlp formats are normalized and default requested IDs are recovered', () => {
    const formats = sampleFormats();
    assert.equal(formats.length, 5);
    assert.deepEqual(formats.map(item => item.kind), ['video', 'audio', 'audio', 'video', 'video_audio']);
    assert.deepEqual(getSelectedFormatIds({
        requested_downloads: [{ requested_formats: [{ format_id: '137' }, { format_id: '140' }] }]
    }), ['137', '140']);
    assert.deepEqual(getSelectedFormatIds({ format_id: '137+140' }), ['137', '140']);
    assert.equal(getPreferredMusicAudioFormat(formats).id, '251');
    assert.equal(getPreferredMusicAudioFormat(normalizeYtDlpFormats([
        { format_id: '141', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 255, asr: 44100 },
        { format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 160, asr: 48000 }
    ])).id, '141');
    assert.equal(getPreferredMusicAudioFormat(normalizeYtDlpFormats([
        { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 136, asr: 44100 }
    ])).id, '140');
});

test('Premium video default descends by short-edge tier with AV1, VP9, AVC codec priority', () => {
    const formats = normalizeYtDlpFormats([
        { format_id: '401', ext: 'mp4', width: 3840, height: 2160, vcodec: 'av01.0.12M.08', acodec: 'none', vbr: 18000 },
        { format_id: '264', ext: 'mp4', width: 2560, height: 1440, vcodec: 'avc1.640032', acodec: 'none', vbr: 12000 },
        { format_id: '400', ext: 'mp4', width: 2560, height: 1440, vcodec: 'av01.0.12M.08', acodec: 'none', vbr: 6200 },
        { format_id: '701', ext: 'webm', width: 1440, height: 2560, vcodec: 'vp09.00.50.08', acodec: 'none', vbr: 7000 },
        { format_id: '248', ext: 'webm', width: 1920, height: 1080, vcodec: 'vp9', acodec: 'none', vbr: 4200 },
        { format_id: '137', ext: 'mp4', width: 1920, height: 1080, vcodec: 'avc1.640028', acodec: 'none', vbr: 4800 },
        { format_id: '247', ext: 'webm', width: 1280, height: 720, vcodec: 'vp9', acodec: 'none', vbr: 2500 },
        { format_id: '136', ext: 'mp4', width: 1280, height: 720, vcodec: 'avc1.4d401f', acodec: 'none', vbr: 2800 }
    ]);
    const without = (...ids) => formats.filter(format => !ids.includes(format.id));
    assert.equal(getPreferredPremiumVideoFormat(formats).id, '400');
    assert.equal(getPreferredPremiumVideoFormat(without('400')).id, '701');
    assert.equal(getPreferredPremiumVideoFormat(without('400', '701')).id, '264');
    assert.equal(getPreferredPremiumVideoFormat(without('400', '701', '264')).id, '248');
    assert.equal(getPreferredPremiumVideoFormat(without('400', '701', '264', '248')).id, '137');
    assert.equal(getPreferredPremiumVideoFormat(without('400', '701', '264', '248', '137')).id, '247');
    assert.equal(getPreferredPremiumVideoFormat(without('400', '701', '264', '248', '137', '247')).id, '136');
    assert.equal(getPreferredPremiumVideoFormat(formats.filter(format => format.id === '401')), null);
    assert.equal(validateFormatSelection(formats, ['401'], 'video').formats[0].id, '401');
});

test('YouTube compact upload dates expose their four-digit year', () => {
    assert.equal(extractYoutubeMetadataYear('20250816'), '2025');
    assert.equal(extractYoutubeMetadataYear('2025-08-16'), '2025');
    assert.equal(extractYoutubeMetadataYear(2025), '2025');
    assert.equal(extractYoutubeMetadataYear('1760000000'), '');
});

test('custom video tracks override a detected music source unless music mode is forced', () => {
    const formats = normalizeYtDlpFormats([
        { format_id: '160', ext: 'mp4', width: 144, height: 144, vcodec: 'avc1.4d400b', acodec: 'none' },
        { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129 }
    ]);
    const videoOnly = validateFormatSelection(formats, ['160'], 'song');
    const videoAndAudio = validateFormatSelection(formats, ['160', '140'], 'song');
    const audioOnly = validateFormatSelection(formats, ['140'], 'song');
    assert.equal(resolveYoutubePremiumMediaType('song', videoOnly, false), 'video');
    assert.equal(resolveYoutubePremiumMediaType('song', videoAndAudio, false), 'video');
    assert.equal(resolveYoutubePremiumMediaType('song', audioOnly, false), 'song');
    assert.equal(resolveYoutubePremiumMediaType('video', audioOnly, true), 'song');
});

test('custom format validation accepts only useful music and video combinations', () => {
    const formats = sampleFormats();
    const song = validateFormatSelection(formats, ['140'], 'song');
    assert.equal(song.formatSelector, '140');
    assert.equal(song.outputContainer, 'm4a');

    const splitVideo = validateFormatSelection(formats, ['140', '137'], 'video');
    assert.deepEqual(splitVideo.ids, ['137', '140']);
    assert.equal(splitVideo.outputContainer, 'mp4');
    assert.equal(splitVideo.summary.video, '1080p / avc1.640028');

    const webmVideo = validateFormatSelection(formats, ['248', '251'], 'video');
    assert.equal(webmVideo.outputContainer, 'mkv');
    assert.equal(validateFormatSelection(formats, ['18'], 'video').outputContainer, 'mp4');
    assert.equal(validateFormatSelection(formats, ['137'], 'video').formats[0].kind, 'video');
    assert.equal(validateFormatSelection(formats, ['140'], 'video').formats[0].kind, 'audio');
    assert.equal(validateFormatSelection(formats, ['140'], 'video', true).formats[0].kind, 'audio');
    assert.throws(() => validateFormatSelection(formats, ['18'], 'video', true), /custom-music-format-invalid/);

    assert.throws(() => validateFormatSelection(formats, ['137', '248'], 'video'), /custom-video-format-conflict/);
    assert.throws(() => validateFormatSelection(formats, ['137'], 'video', true), /custom-music-format-invalid/);
    assert.throws(() => validateFormatSelection(formats, ['137', '140'], 'video', true), /custom-music-format-invalid/);
    assert.equal(validateFormatSelection(formats, ['137'], 'song').outputContainer, 'mp4');
    assert.throws(() => validateFormatSelection(formats, ['missing'], 'video'), /custom-format-not-found/);
});

test('private task service persists history, paginates and hides server paths', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop2tunnel-premium-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const formats = sampleFormats();
    let analyzeOptions = null;
    const analyze = async (url, options) => {
        analyzeOptions = options;
        return {
            url,
            title: 'Private test',
            cover: 'https://i.example/cover.jpg',
            mediaType: 'video',
            selection: validateFormatSelection(formats, ['137', '140'], 'video')
        };
    };
    const download = async ({ taskDir, onProgress }) => {
        fs.mkdirSync(taskDir, { recursive: true });
        const outputPath = path.join(taskDir, 'private-test.mp4');
        fs.writeFileSync(outputPath, 'private-output');
        onProgress({ percent: 42, speedText: '1MiB/s' });
        return { outputPath, outputFileName: 'private-test.mp4', outputFileSize: fs.statSync(outputPath).size };
    };
    const service = createYoutubePremiumService({ dataDir, analyze, download });
    const created = service.create({ url: 'https://www.youtube.com/watch?v=test', mode: 'default', asMusic: true });
    const completed = await waitFor(() => service.get(created.id).status === 'completed' && service.get(created.id));

    assert.equal(completed.hasFile, true);
    assert.equal(completed.asMusic, true);
    assert.equal(analyzeOptions.forceMusic, true);
    assert.match(completed.downloadUrl, new RegExp(created.id));
    assert.match(completed.previewUrl, /inline=1/);
    assert.equal('outputPath' in completed, false);
    assert.equal('coverPath' in completed, false);
    assert.equal(JSON.stringify(completed).includes(dataDir), false);
    assert.equal(service.getFile(created.id).name, 'private-test.mp4');
    assert.deepEqual(service.list(1, 1).ids, [created.id]);
    const detailed = service.updateDetails(created.id, { remark: 'private note', tags: ['Epic', 'Epic', 'Public'] });
    assert.equal(detailed.remark, 'private note');
    assert.deepEqual(detailed.tags, ['Epic', 'Public']);
    service.setReferenceInfo(created.id, { albumYear: '2020' });
    assert.deepEqual(service.getReferenceInfo(created.id), { albumYear: '2020' });
    assert.equal('referenceInfo' in service.get(created.id), false);
    const edited = service.setSongMetadata(created.id, { title: 'Edited', album_artist: 'Album artist' });
    assert.equal(edited.songMetadata.album_artist, 'Album artist');
    assert.ok(edited.songMetadataEditedAt > 0);
    const originalCompletedAt = edited.completedAt;
    const originalFileName = edited.outputFileName;
    const originalFileSize = edited.outputFileSize;

    const restored = createYoutubePremiumService({ dataDir, analyze, download });
    assert.equal(restored.get(created.id).status, 'completed');
    assert.equal(restored.get(created.id).hasFile, true);
    const cleared = restored.clear(created.id);
    assert.equal(cleared.status, 'cleared');
    assert.equal(cleared.outputFileName, originalFileName);
    assert.equal(cleared.outputFileSize, originalFileSize);
    assert.equal(cleared.completedAt, originalCompletedAt);
    assert.equal(restored.getFile(created.id), null);
    restored.retry(created.id);
    await waitFor(() => restored.get(created.id).status === 'completed');
    assert.equal(restored.remove(created.id), true);
    assert.equal(restored.get(created.id), null);
    assert.throws(() => restored.create({ url: 'file:///tmp/video', mode: 'default' }), /youtube-url-required/);
    assert.throws(() => restored.create({
        url: 'https://youtu.be/test', mode: 'custom', selectedFormatIds: ['1', '2', '3']
    }), /custom-format-count-invalid/);
});

test('unfinished persisted tasks are requeued after service restart', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop2tunnel-premium-resume-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const now = Date.now();
    fs.writeFileSync(path.join(dataDir, 'youtube-premium-tasks.json'), JSON.stringify([{
        id: 'interrupted-task', url: 'https://youtu.be/interrupted', title: '', cover: '', mode: 'default',
        asMusic: false, selectedFormatIds: [], mediaType: 'video', status: 'downloading', progress: { percent: 73 },
        outputFileName: '', outputFileSize: 0, outputPath: '', coverPath: '', error: '', createdAt: now,
        updatedAt: now, completedAt: 0
    }]));
    const formats = sampleFormats();
    const service = createYoutubePremiumService({
        dataDir,
        analyze: async url => ({
            url, title: 'Recovered', cover: '', mediaType: 'video',
            selection: validateFormatSelection(formats, ['137', '140'], 'video')
        }),
        download: async ({ taskDir }) => {
            fs.mkdirSync(taskDir, { recursive: true });
            const outputPath = path.join(taskDir, 'recovered.mp4');
            fs.writeFileSync(outputPath, 'recovered');
            return { outputPath, outputFileName: 'recovered.mp4', outputFileSize: 9 };
        }
    });
    const completed = await waitFor(() => service.get('interrupted-task')?.status === 'completed' && service.get('interrupted-task'));
    assert.equal(completed.hasFile, true);
    assert.equal(completed.progress.percent, 100);
});

test('queued and running private tasks can be cancelled', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop2tunnel-premium-cancel-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const formats = sampleFormats();
    const analyze = async url => ({
        url, title: 'Cancel test', cover: '', mediaType: 'video',
        selection: validateFormatSelection(formats, ['18'], 'video')
    });
    const download = ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('download-cancelled')), { once: true });
    });
    const service = createYoutubePremiumService({ dataDir, analyze, download, concurrency: 1 });
    const running = service.create({ url: 'https://youtu.be/running' });
    const queued = service.create({ url: 'https://youtu.be/queued' });
    await waitFor(() => service.get(running.id).status === 'downloading');
    assert.equal(service.get(queued.id).status, 'queued');
    assert.equal(service.cancel(queued.id).status, 'cancelled');
    service.cancel(running.id);
    await waitFor(() => service.get(running.id).status === 'cancelled');
});

test('routes, page and extension preserve the private credential boundary', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const service = fs.readFileSync(path.join(ROOT, 'server', 'youtube-premium.js'), 'utf8');
    const page = fs.readFileSync(path.join(ROOT, 'pages', 'youtube-premium-dl.html'), 'utf8');
    const browserCache = fs.readFileSync(path.join(ROOT, 'client', 'youtube-premium-cache.js'), 'utf8');
    const cookiesPage = fs.readFileSync(path.join(ROOT, 'pages', 'sns-cookies.html'), 'utf8');
    const background = fs.readFileSync(path.join(ROOT, 'tools', 'auto-sync-sns-cookies', 'chrome', 'background.js'), 'utf8');
    const options = fs.readFileSync(path.join(ROOT, 'tools', 'auto-sync-sns-cookies', 'chrome', 'options.js'), 'utf8');

    assert.match(server, /app\.get\('\/youtube-premium-dl'[\s\S]*adminAuth\.isAuthenticated/);
    for (const route of ['formats', 'tasks']) {
        assert.match(server, new RegExp(`\\/api\\/youtube-premium\\/${route}[^\\n]*adminAuth\\.requireAuth`));
    }
    assert.match(server, /youtubePremium:\s*getYoutubePremiumCookieStatus\(\{ includeContent: true \}\)/);
    assert.match(cookiesPage, /youtubePremiumContent\.value = premium\.content \|\| ''/);
    assert.doesNotMatch(service, /server[- ]asset|tunnel history/i);
    assert.doesNotMatch(page, /yt-premium-cookies\.txt/);
    assert.match(page, /\.selection\.warning/);
    assert.match(page, /当前仅下载纯/);
    assert.doesNotMatch(page, /单选时必须选择已经包含音视频的完整格式/);
    assert.match(server, /singleTrack === 'audio' \? 'audio' : 'video'/);
    assert.match(page, /id="asMusicInput"/);
    assert.match(page, /checkbox\.disabled = asMusicInput\.checked && checkbox\.dataset\.kind !== 'audio'/);
    assert.match(page, /row\.classList\.toggle\('is-disabled', checkbox\.disabled\)/);
    assert.match(page, /已自动勾选最高音质纯音频编号/);
    assert.match(page, /data\.musicFormatId \? \[data\.musicFormatId\]/);
    assert.match(page, /body: JSON\.stringify\(\{ url, refresh: forceRefresh === true \}\)/);
    assert.match(page, /if \(analysis && analysisInputUrl === urlInput\.value\.trim\(\)\) applyFormatMode\(analysis\)/);
    assert.match(page, /清除服务端缓存/);
    assert.match(page, /重新抓取/);
    assert.match(page, /完全删除/);
    assert.match(page, /if \(!task\.hasFile\) actions\.appendChild\(taskButton\(task, '重新抓取'/);
    assert.match(page, /正在读取链接信息并确认媒体格式/);
    assert.match(page, /item\.dataset\.taskId === created\.id/);
    assert.match(page, /card\.scrollIntoView\(/);
    assert.match(page, /created-highlight'\), 2000/);
    assert.match(server, /\/api\/youtube-premium\/tasks\/:taskId\/clear/);
    assert.match(server, /\/api\/youtube-premium\/tasks\/:taskId\/retry/);
    assert.match(server, /\/api\/youtube-premium\/tasks\/:taskId\/forward/);
    assert.match(server, /\/api\/youtube-premium\/tasks\/:taskId\/info/);
    assert.match(server, /\/api\/youtube-premium\/tasks\/:taskId\/thumbnail/);
    const thumbnailHelper = server.slice(
        server.indexOf('async function downloadYoutubePremiumOriginalThumbnail'),
        server.indexOf('async function analyzeYoutubePremiumUrl')
    );
    assert.match(thumbnailHelper, /--skip-download[\s\S]*--write-thumbnail/);
    assert.match(thumbnailHelper, /getYtDlpCookieArgs\(task\.url, requireYoutubePremiumCookies\(\)\)/);
    assert.doesNotMatch(thumbnailHelper, /--convert-thumbnails/);
    assert.match(server, /mimeType:\s*getMimeTypeFromFileName\(file\.name\)/);
    const forwardHelper = server.slice(
        server.indexOf('async function receiveYoutubePremiumForwardUpload'),
        server.indexOf('async function publishTelegramFileToTunnel')
    );
    assert.match(forwardHelper, /await pipeline\(/);
    assert.match(forwardHelper, /await fs\.promises\.rename\(upload\.path, assetPath\)/);
    assert.doesNotMatch(forwardHelper, /copyFile\(file\.path, assetPath\)/);
    assert.doesNotMatch(server, /fs\.linkSync\(file\.path, assetPath\)/);
    assert.match(server, /Accept-Ranges/);
    assert.match(server, /analysis\.selection\.formatSelector/);
    assert.match(page, /showPreview\(task\)/);
    assert.match(page, /showFileInfo\(task\)/);
    assert.match(page, /MIME type/);
    assert.match(page, /downloadOriginalThumbnail\(task, thumbnail\)/);
    assert.match(page, /原尺寸封面/);
    assert.match(page, /showForward\(task\)/);
    assert.match(page, /id="cacheFilesInput"[^>]*checked/);
    assert.match(page, /browser_cache_caching:\s*'缓存中'/);
    assert.match(page, /browser_cache_cached:\s*'已缓存到浏览器'/);
    assert.match(page, /browser_cache_cleared:\s*'已清除浏览器缓存'/);
    assert.match(page, /cleanupBrowserCacheGarbage/);
    assert.match(browserCache, /cleanupOrphans\(validTaskIds\)/);
    assert.match(page, /任务标签/);
    assert.match(page, /编辑歌曲元信息/);
    assert.match(server, /album_artist/);
    assert.match(server, /normalizeYoutubeSourceUrl/);
    assert.match(server, /youtube-premium-metadata-cache\.json/);
    assert.match(server, /req\.body\?\.refresh === true/);
    assert.match(server, /extractUploadYear/);
    assert.match(server, /bypassCache: forceRefresh/);
    assert.match(server, /--no-cache-dir/);
    assert.match(server, /Cache-Control:no-cache/);
    assert.match(server, /resolveYoutubePremiumMediaType/);
    assert.match(server, /\/api\/youtube-premium\/tasks\/:taskId\/song-metadata/);
    assert.match(service, /referenceInfo/);
    assert.match(service, /task\.coverPath \|\| \(task\.cover[\s\S]*`\/api\/youtube-premium\/tasks/);
    assert.match(page, /premiumBrowserCache\?\.getBlob\(task\)/);
    assert.match(page, /ensureBrowserCachedBlob\(task\)/);
    assert.match(page, /'X-Drop2Tunnel-Cache-Version': taskCacheVersion\(task\)/);
    assert.match(page, /body: blob/);
    assert.match(page, /client\/cache-store\.js/);
    assert.match(browserCache, /createDrop2TunnelCacheStore/);
    assert.match(browserCache, /cacheStore\.beginWrite\(/);
    assert.match(browserCache, /await writer\.writeChunk\(/);
    assert.match(browserCache, /committed = await writer\.commit\(\)/);
    assert.match(browserCache, /indexedDB\.open\(DB_NAME, 1\)/);
    assert.doesNotMatch(browserCache, /CacheStorage|global\.caches|caches\.open/);
    assert.match(app, /fileInfo\.sourceChannel === 'youtube-premium'/);
    assert.match(app, /premium-ready-copy/);
    assert.match(page, /keepalive: true/);
    assert.match(page, /dialog\[open\][^}]*display:grid/);
    assert.match(page, /overscroll-behavior:contain/);
    assert.match(page, /重新采集/);
    assert.match(page, /song-metadata\?refresh=1/);
    assert.match(background, /if \(server\.syncYoutubePremium\) \{\s*if \(!youtube\) throw new Error/);
    assert.match(background, /body\.youtubePremium = youtube\.content/);
    assert.match(background, /result\.youtubePremium\?\.configured !== true/);
    assert.match(background, /--server-policy--/);
    assert.match(background, /protocolVersion: SYNC_PROTOCOL_VERSION/);
    assert.match(options, /syncYoutubePremium/);
    assert.match(options, /response\.protocolVersion !== REQUIRED_SYNC_PROTOCOL_VERSION/);

    for (const target of ['chrome', 'firefox-windows', 'firefox-android']) {
        const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'auto-sync-sns-cookies', target, 'manifest.json'), 'utf8'));
        assert.equal(manifest.version, '1.5.0');
    }

    const scripts = [...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
        .map(match => match[1]).filter(source => source.trim());
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Function(scripts[0]));
});

test('Premium tunnel forwarding accepts only a complete current browser-cache upload', async () => {
    const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'premium-forward-'));
    const receiveUpload = loadPremiumForwardReceiver(assetDir);
    const task = { outputFileSize: 4, completedAt: 123 };
    const request = Readable.from([Buffer.from('ab'), Buffer.from('cd')]);
    request.get = name => ({
        'X-Drop2Tunnel-File-Size': '4',
        'X-Drop2Tunnel-Cache-Version': '123-4'
    })[name] || '';
    request.is = type => type === 'application/octet-stream';

    try {
        const upload = await receiveUpload(request, task);
        assert.equal(upload.size, 4);
        assert.equal(fs.readFileSync(upload.path, 'utf8'), 'abcd');
        fs.rmSync(upload.path, { force: true });

        const stale = Readable.from([Buffer.from('abcd')]);
        stale.get = name => name === 'X-Drop2Tunnel-File-Size' ? '4' : 'old-version';
        stale.is = type => type === 'application/octet-stream';
        await assert.rejects(() => receiveUpload(stale, task), /youtube-premium-forward-cache-stale/);
        assert.deepEqual(fs.readdirSync(assetDir), []);
    } finally {
        fs.rmSync(assetDir, { recursive: true, force: true });
    }
});

test('extension sends and verifies the per-server Premium cookie payload', async () => {
    let requestBody = null;
    const syncServer = loadExtensionSyncServer(async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({ ok: true, youtubePremium: { configured: true } }) };
    });
    const server = { serverUrl: 'https://drop.example', syncToken: 'token', syncYoutubePremium: true };
    const youtube = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tprivate\n';
    const result = await syncServer(server, [{ platform: 'youtube', content: youtube }]);

    assert.equal(requestBody.youtubePremium, youtube);
    assert.equal(requestBody.platforms.youtube, youtube);
    assert.equal(result.premiumConfigured, true);

    await assert.rejects(() => syncServer(server, [{ platform: 'x', content: 'x-cookie' }]), /未发现有效的 YouTube 登录 Cookie/);
    const unconfirmed = loadExtensionSyncServer(async () => ({ ok: true, json: async () => ({ ok: true, youtubePremium: null }) }));
    await assert.rejects(() => unconfirmed(server, [{ platform: 'youtube', content: youtube }]), /服务器未确认/);
});
