'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createDiskOperations } = require('../server/disk-operations');
const { createDiskTelegram } = require('../server/disk-telegram');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-followup-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('缓存读取任务按设备隔离，包括按 ID 查询；上传仍跨设备共享并支持重启', t => {
    const dataDir = temp(t), operations = createDiskOperations({ dataDir });
    const a = { userId: 'user', deviceId: 'device-a' }, b = { userId: 'user', deviceId: 'device-b' };
    const read = operations.create(b, 'read', 'cache'), upload = operations.create(b, 'upload', 'upload');
    assert.equal(operations.get(read.operation_id, a), null);
    assert.equal(operations.list(a, [read.operation_id]).some(job => job.type === 'read'), false);
    assert.equal(operations.get(read.operation_id, b).type, 'read');
    assert.equal(operations.get(upload.operation_id, a).type, 'upload');
    const restarted = createDiskOperations({ dataDir });
    assert.equal(restarted.get(read.operation_id, a), null);
    assert.equal(restarted.get(read.operation_id, b).errorCode, 'SERVER_RESTARTED');
});

test('上传网络失败保留任务文件关联及底层原因、日志不泄露 Bot Token，也不盲目重试', async t => {
    const dataDir = temp(t), filename = path.join(dataDir, 'input'); fs.writeFileSync(filename, 'abc');
    const token = '123:secret-token'; let requests = 0;
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, init) => {
        requests++; for await (const chunk of init.body) void chunk;
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket ' + url), { code: 'ECONNRESET' }) });
    } });
    await assert.rejects(telegram.upload({ token, baseUrl: 'https://api.telegram.org', channelId: '-1' }, [{ logicalId: 'logical-file', name: 'a', path: filename, size: 3 }], () => {}, [], { uploadId: 'upload-test', operationId: 'op-test' }), error => error.message === 'TELEGRAM_NETWORK_ERROR' && error.details.causeCode === 'ECONNRESET');
    assert.equal(requests, 1);
    const log = fs.readFileSync(path.join(dataDir, 'disk-upload.log'), 'utf8');
    assert.ok(!log.includes(token)); assert.ok(!log.includes('/bot'));
    const rows = log.trim().split('\n').map(JSON.parse);
    const failed = rows.find(row => row.event === 'telegram.network-error');
    assert.equal(failed.uploadId, 'upload-test'); assert.equal(failed.operationId, 'op-test');
    assert.equal(failed.parts[0].fileId, 'logical-file'); assert.equal(failed.causeCode, 'ECONNRESET');
    assert.ok(rows.some(row => row.event === 'telegram.part-body-produced'));
    assert.ok(!rows.some(row => row.event === 'telegram.part-confirmed'));
});

test('非 JSON 的 413 代理响应保留 HTTP 错误码', async t => {
    const telegram = createDiskTelegram({ dataDir: temp(t), fetchImpl: async () => ({ ok: false, status: 413, json: async () => { throw new SyntaxError('html'); } }) });
    await assert.rejects(telegram.call({ token: 'test', baseUrl: 'https://example.test' }, 'sendDocument', {}), /TELEGRAM_413/);
});

test('Telegram 下载端忽略 Range 时丢弃前缀并只输出请求窗口', async t => {
    const requests = [];
    const telegram = createDiskTelegram({ dataDir: temp(t), fetchImpl: async (url, init) => {
        if (url.endsWith('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/file.bin' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        requests.push(init?.headers?.Range || '');
        return new Response(Buffer.from('abcdefghij'), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    } });
    const stream = await telegram.readPart({ token: 'test', baseUrl: 'https://example.test', channelId: '-1' }, { fileId: 'file-id', size: 10 }, { start: 2, end: 5 });
    const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), 'cdef');
    assert.deepEqual(requests, ['bytes=2-5']);
});

test('Album 413 拆单后续失败会回滚此前已经确认的分片消息', async t => {
    const dataDir = temp(t), first = path.join(dataDir, 'first'), second = path.join(dataDir, 'second');
    fs.writeFileSync(first, 'abc'); fs.writeFileSync(second, 'def');
    let singles = 0; const deleted = [];
    const reply = result => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, init) => {
        const method = url.split('/').pop();
        if (method === 'sendMediaGroup') { for await (const chunk of init.body) void chunk; return new Response(JSON.stringify({ ok: false, error_code: 413 }), { status: 413, headers: { 'Content-Type': 'application/json' } }); }
        if (method === 'sendDocument') {
            for await (const chunk of init.body) void chunk;
            if (++singles === 1) return reply({ message_id: 11, date: 1, document: { file_id: 'part-1', file_unique_id: 'unique-1' } });
            throw new TypeError('connection reset');
        }
        if (method === 'editMessageCaption') return reply(true);
        if (method === 'deleteMessages') { deleted.push(...JSON.parse(init.body).message_ids); return reply(true); }
        throw new Error('unexpected method ' + method);
    } });
    const files = [{ logicalId: 'logical', name: 'large.bin', type: 'application/octet-stream', size: 6, folderPath: '' }];
    const parts = [
        { fileIndex: 0, logicalFileId: 'logical', partIndex: 1, partCount: 2, originalSize: 6, offset: 0, size: 3, path: first, name: 'large.part01', type: 'application/octet-stream', start: 0, end: 2 },
        { fileIndex: 0, logicalFileId: 'logical', partIndex: 2, partCount: 2, originalSize: 6, offset: 3, size: 3, path: second, name: 'large.part02', type: 'application/octet-stream', start: 0, end: 2 }
    ];
    await assert.rejects(telegram.uploadPhysical({ token: 'test', baseUrl: 'https://example.test', channelId: '-1' }, files, parts, () => {}, { uploadId: 'upload', operationId: 'operation', totalBytes: 6 }), /TELEGRAM_NETWORK_ERROR/);
    assert.deepEqual(deleted, [11]);
});

test('音乐图标只随最小化显示，关闭后播放状态更新也不能恢复图标', () => {
    const code = source('app.js');
    const button = { classList: { toggle() {} } }, marquee = { querySelector: () => ({}) };
    const musicPlayer = { queue: [{}], miniEnabled: false };
    const context = { musicPlayer, document: { getElementById: id => id === 'topbarMusicBtn' ? button : marquee }, getCurrentMusicTrack: () => ({ name: 'song' }), isBackgroundMusicPlaying: () => true };
    vm.runInNewContext(code.slice(code.indexOf('function updateTopbarMusicState()'), code.indexOf('function initMusicMediaSession()')) + '; updateTopbarMusicState();', context);
    assert.equal(button.hidden, true);
    musicPlayer.miniEnabled = true; context.updateTopbarMusicState(); assert.equal(button.hidden, false);
    musicPlayer.miniEnabled = false; context.updateTopbarMusicState(); assert.equal(button.hidden, true); assert.equal(marquee.hidden, true);
});

test('分享缓存七天边界失效，普通网盘缓存不受影响', () => {
    const code = source('client/telegram-drive-cache.js');
    const begin = code.indexOf('    const SHARE_TTL'), end = code.indexOf('    function open()');
    const expired = vm.runInNewContext(code.slice(begin, end) + '; expired', { Date: { now: () => 2_000_000_000_000 } });
    const cachedAt = 2_000_000_000_000 - 7 * 86400000;
    assert.equal(expired({ id: 'share:token:file', cachedAt: cachedAt + 1 }), false);
    assert.equal(expired({ id: 'share:token:file', cachedAt }), true);
    assert.equal(expired({ id: 'file', source: 'public-share', cachedAt }), true);
    assert.equal(expired({ id: 'share:legacy:file' }), true);
    assert.equal(expired({ id: 'file', cachedAt }), false);
});

test('全局搜索取消旧请求，旧结果不能覆盖新结果且不启动居中加载', async () => {
    const code = source('client/disk-ui.js'), input = { value: 'a', setAttribute() {} }, global = { checked: true }, spinner = { hidden: true };
    const requests = []; let timer;
    const context = { telegramDriveSearchTimer: 0, telegramDriveSearchAbort: undefined, telegramDriveSearchGeneration: 0, telegramDriveSearchData: null,
        document: { getElementById: id => id === 'telegramDriveSearch' ? input : id === 'telegramDriveSearchAll' ? global : spinner },
        window: { DiskClient: { raw: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })) } },
        renderTelegramDriveItems() {}, showAppToast: assert.fail, AbortController, encodeURIComponent, clearTimeout() {}, setTimeout(fn) { timer = fn; } };
    vm.runInNewContext(code.slice(code.indexOf('function scheduleTelegramDriveSearch()'), code.indexOf('function getTelegramDriveItemMeta(')), context);
    context.scheduleTelegramDriveSearch(); const first = timer(); assert.equal(spinner.hidden, false);
    input.value = 'ab'; context.scheduleTelegramDriveSearch(); const second = timer();
    assert.equal(requests[0].options.signal.aborted, true);
    requests[1].resolve({ files: ['new'] }); await second; assert.equal(spinner.hidden, true);
    requests[0].resolve({ files: ['old'] }); await first;
    assert.deepEqual(context.telegramDriveSearchData.files, ['new']);
});

test('后台刷新更新当前目录，过期目录请求不能覆盖导航后的列表', async () => {
    const code = source('client/disk-ui.js'), summary = {}, requests = [];
    let renders = 0;
    const context = { telegramDriveCurrentData: { files: [] }, telegramDriveRenderGeneration: 0, telegramDrivePath: '',
        document: { getElementById: id => id === 'telegramDriveOverlay' ? { hidden: false } : summary },
        window: { DiskClient: { raw: () => new Promise(resolve => requests.push(resolve)) } }, encodeURIComponent,
        renderTelegramDriveItems() { renders++; }, scheduleTelegramDriveSearch() {} };
    vm.runInNewContext(code.slice(code.indexOf('async function refreshTelegramDriveContents()'), code.indexOf('async function navigateTelegramDrive(')), context);
    const first = context.refreshTelegramDriveContents(); requests[0]({ files: ['new'], summary: { fileCount: 1 } }); await first;
    assert.deepEqual(context.telegramDriveCurrentData.files, ['new']); assert.equal(renders, 1);
    const stale = context.refreshTelegramDriveContents(); context.telegramDrivePath = 'other'; context.telegramDriveRenderGeneration++;
    requests[1]({ files: ['stale'] }); await stale;
    assert.deepEqual(context.telegramDriveCurrentData.files, ['new']); assert.equal(renders, 1);
});
