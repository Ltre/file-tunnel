'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createTunnelSnsPostPublisher } = require('../server/sns-post-markdown');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const part = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const url = 'https://www.bilibili.com/video/BV1Nbny69E31';
const run = promisify(execFile);

function fixture(t, { live = false, fail = false, acceptsNormal = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-261117-'));
    t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
    const work = path.join(dir, 'work'), assets = new Map(), calls = [];
    const original = { id: 'post', snsSources: [{ id: 'source', messageId: 'post', sourceUrl: url }], snsMediaItems: [] };
    const records = new Map([['post', original]]), session = { history: [{ message: original }] };
    const write = (_sid, row) => { records.set(row.id, row); const previous = session.history.find(entry => entry.message.id === row.id); if (previous) previous.message = row; else session.history.push({ message: row }); };
    const context = {
        require: require('node:module').createRequire(path.join(__dirname, '../server.js')), fs, path, crypto, console, process, SNS_MEDIA_WORK_DIR: work, TELEGRAM_ASSET_DIR: path.join(dir, 'assets'),
        YT_DLP_CACHE_DIR: path.join(dir, 'cache'), TELEGRAM_BOT_DEVICE_ID: 'sns-server', TELEGRAM_REMARK_MAX_LENGTH: 4000,
        sessions: new Map([['tunnel', session]]), snsMediaTasks: new Map(),
        getHistoryMessageEntry: (_session, id) => records.has(id) ? { message: records.get(id) } : null,
        createStableSnsId: (...parts) => crypto.createHash('sha256').update(parts.join(':')).digest('hex'),
        createServerAssetId: () => crypto.randomUUID(), getTelegramMaxFileSize: () => 256 * 1024 * 1024,
        acquireSnsMediaTaskSlot: async () => () => {}, persistTelegramServerAsset: asset => assets.set(asset.id, asset),
        cleanupSnsWorkFiles(prefix) { if (fs.existsSync(work)) for (const file of fs.readdirSync(work)) if (file.startsWith(prefix)) fs.unlinkSync(path.join(work, file)); },
        findDownloadedSnsFile: prefix => fs.readdirSync(work).filter(file => file.startsWith(prefix) && /\.mp4$/.test(file)).map(file => path.join(work, file))[0],
        isYouTubeUrl: () => false, getYtDlpFormatSelector: () => 'bv*+ba/best',
        getYtDlpRemoteComponentArgs: () => [], getYtDlpFfmpegArgs: () => [], getYtDlpCookieArgs: () => [],
        parseYtDlpProgress() {}, recordExternalDependencyEvent() {}, sanitizeString: value => String(value || ''),
        sanitizeMediaFilePart: () => 'Bilibili sample', getMimeTypeFromFileName: () => 'video/mp4',
        async spawnYtDlpCapture(args) {
            calls.push(args);
            if (fail) throw Error('HTTP Error 567: https://private.invalid/?token=secret');
            if (live) return run('yt-dlp', ['--ignore-config', '--socket-timeout', '15', '--retries', '0', ...args], { timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
            if (!acceptsNormal && args.at(-1) === url && !args.includes('Range:bytes=0-')) throw Error('HTTP Error 567: Unknown Status');
            const target = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4');
            fs.writeFileSync(target, Buffer.from('complete fixture media'));
        },
        async probeMediaFile(file) {
            return live ? JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])).stdout)
                : { streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] };
        }
    };
    vm.runInNewContext(part('function getYtDlpDownloadSelectionArgs(', 'function sanitizeMediaFilePart(') +
        part('function moveSnsFileToAsset(', 'function buildSongRemark(') +
        part('async function fetchSnsMediaIntoTunnelUnrouted(', 'function isValidMagnetAssetPayload('), context);
    const service = createTunnelSnsPostPublisher({ assetDir: context.TELEGRAM_ASSET_DIR, record: (_sid, id) => records.get(id), session: () => session,
        authorize() {}, trackProgress: true, cleanup(_sid, id) { for (const asset of assets.values()) if (asset.markdownOwnerId === id) fs.unlinkSync(asset.path); },
        publish: write, update: write, sender: () => ({ sender: 'sns-server' }),
        metadata: async () => live ? JSON.parse((await run('yt-dlp', ['--ignore-config', '--no-cache-dir', '--no-playlist', '--socket-timeout', '15', '--retries', '0', '-J', url], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 })).stdout)
            : { title: 'Sample', description: 'Post text', webpage_url: url, formats: [{ vcodec: 'avc1', acodec: 'mp4a' }] },
        request: async () => ({ type: 'text/html', data: Buffer.from('<title>Sample</title>') }),
        buildItem: (_id, from, metadata) => ({ id: 'video', sourceId: from.id, sourceUrl: from.sourceUrl, mediaUrl: metadata.webpage_url || from.sourceUrl, mediaKind: 'video' }),
        acquire: context.fetchSnsMediaIntoTunnelUnrouted, registerAsset: context.persistTelegramServerAsset, fileInfo: context.createServerAssetFileInfo
    });
    return { context, calls, assets, records, start: () => service.start({ sessionId: 'tunnel', messageId: 'post', sourceId: 'source', deviceId: 'viewer' }) };
}

test('Bilibili metadata, actual acquisition and bundled Markdown publish only after the complete file is saved', async t => {
    const f = fixture(t), row = await f.start().promise;
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].includes('Range:bytes=0-'), false);
    assert.ok(f.calls[1].includes('Range:bytes=0-'));
    assert.deepEqual(Array.from(f.calls[1]).filter(value => !['--add-headers', 'Range:bytes=0-'].includes(value)), Array.from(f.calls[0]));
    assert.equal(row.markdownAttachments.length, 1);
    const attachment = row.markdownAttachments[0], asset = f.assets.get(attachment.id);
    assert.equal(asset.markdownOwnerId, row.id);
    assert.equal(fs.statSync(asset.path).size, attachment.size);
    assert.match(row.markdown, new RegExp('tunnel-blob:tunnel/' + row.id + '/' + asset.id));
    assert.equal(row.snsMarkdownProgress, undefined);
    assert.equal(f.records.size, 2, 'bundled media does not create extra visible file records');
});

test('a media HTTP failure retains framework/0 of 1 progress and a safe status without URLs or credentials', async t => {
    const f = fixture(t, { fail: true }), job = f.start();
    await assert.rejects(job.promise, /HTTP Error 567/);
    const row = f.records.get(job.id);
    assert.deepEqual(JSON.parse(JSON.stringify(row.snsMarkdownProgress)), { stage: 'failed', frameworkReady: true, done: 0, total: 1, resource: 'video', error: 'SNS_POST_MEDIA_UNAVAILABLE', httpStatus: 567 });
    assert.equal(row.markdown, ''); assert.equal(row.markdownAttachments, undefined);
    assert.doesNotMatch(JSON.stringify(row), /private\.invalid|secret/);
    assert.equal(f.calls.length, 2, 'the range fallback does not retry itself');
});

test('Bilibili request headers do not change unrelated sites, selection, size limits or Cookie arguments', async t => {
    const f = fixture(t);
    f.context.getYtDlpCookieArgs = () => ['--cookies', 'fixture-cookie.txt'];
    await f.context.runYtDlpDownload('https://x.com/u/status/1', 'other', () => {}, 2);
    const args = f.calls[0];
    assert.equal(args.includes('Range:bytes=0-'), false);
    assert.equal(args[args.indexOf('-f') + 1], 'bv*+ba/best');
    assert.equal(args[args.indexOf('--playlist-items') + 1], '2');
    assert.equal(args[args.indexOf('--max-filesize') + 1], String(256 * 1024 * 1024));
    assert.equal(args[args.indexOf('--cookies') + 1], 'fixture-cookie.txt');
});

test('HTTP 567 retries only Bilibili hosts and preserves normal successful requests and other failures', async t => {
    const f = fixture(t);
    const capture = f.context.spawnYtDlpCapture;
    f.context.spawnYtDlpCapture = async (args, options) => {
        if (!args.includes('Range:bytes=0-')) { f.calls.push(args); throw Error('HTTP Error 567: Unknown Status'); }
        return capture(args, options);
    };
    for (const [address, allowed] of [
        ['https://bilibili.com/video/example', true], ['https://m.bilibili.com/video/example', true], ['https://b23.tv/example', true],
        ['HTTPS://WWW.BILIBILI.COM/video/example', true], ['https://bilibili.com.evil.invalid/video/example', false],
        ['https://bilibili.com@evil.invalid/video/example', false], ['https://evil.invalid/?next=https://bilibili.com/video/example', false]
    ]) {
        const before = f.calls.length;
        const download = f.context.runYtDlpDownload(address, 'host-boundary', () => {});
        if (allowed) await download; else await assert.rejects(download, /HTTP Error 567/);
        assert.equal(f.calls.length - before, allowed ? 2 : 1);
        assert.equal(f.calls.at(-1).includes('Range:bytes=0-'), allowed, address);
    }
    const normal = fixture(t, { acceptsNormal: true });
    await normal.start().promise;
    assert.equal(normal.calls.length, 1); assert.equal(normal.calls[0].includes('Range:bytes=0-'), false);
    for (const message of ['HTTP Error 403', 'download-cancelled', 'yt-dlp-download-timeout']) {
        let attempts = 0; normal.context.spawnYtDlpCapture = async () => { attempts++; throw Error(message); };
        await assert.rejects(normal.context.runYtDlpDownload(url, 'no-retry', () => {}), error => error.message === message);
        assert.equal(attempts, 1, message);
    }
    const controller = new AbortController(); let attempts = 0;
    normal.context.spawnYtDlpCapture = async () => { attempts++; controller.abort(); throw Error('HTTP Error 567'); };
    await assert.rejects(normal.context.runYtDlpDownload(url, 'cancelled-567', () => {}, 0, { signal: controller.signal }), /HTTP Error 567/);
    assert.equal(attempts, 1, 'cancellation after the first failure prevents a fallback process');
});

test('a Bilibili range retry removes only its first attempt outputs before publishing a complete replacement', async t => {
    const f = fixture(t), capture = f.context.spawnYtDlpCapture; let attempts = 0;
    const unrelated = path.join(f.context.SNS_MEDIA_WORK_DIR, 'unrelated.mp4');
    f.context.spawnYtDlpCapture = async (args, options) => {
        const output = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4');
        if (++attempts === 1) {
            fs.writeFileSync(output + '.part', 'incomplete'); fs.writeFileSync(unrelated, 'keep');
            throw Error('HTTP Error 567');
        }
        assert.equal(fs.existsSync(output + '.part'), false);
        assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
        return capture(args, options);
    };
    const row = await f.start().promise;
    assert.equal(attempts, 2); assert.equal(row.markdownAttachments.length, 1);
});

test('live Bilibili sample produces a stored playable Markdown attachment', { skip: process.env.BILIBILI_LIVE_PROBE !== '1', timeout: 160000 }, async t => {
    const f = fixture(t, { live: true }), row = await f.start().promise;
    const asset = f.assets.get(row.markdownAttachments[0].id), probe = await f.context.probeMediaFile(asset.path);
    assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
    assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
    assert.equal(Number(probe.format.size), row.markdownAttachments[0].size);
    t.diagnostic(JSON.stringify({ bytes: asset.size, duration: probe.format.duration, stored: true, markdown: true }));
});
