'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const express = require('express');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskOperations } = require('../server/disk-operations');
const { createDiskAPI } = require('../server/disk-api');
const { createDiskTelegram } = require('../server/disk-telegram');
const { createTelegramUploadScheduler } = require('../server/telegram-upload-scheduler');
const { openDiskRepository } = require('../server/disk-repository');
const json = body => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = await predicate(); if (value) return value; await sleep(10); }
    throw new Error(description);
}
async function fixture(t, telegram) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'progressive-api-'));
    const store = createTelegramDriveStore({ dataDir }), auth = createDiskAuth({ dataDir }), operations = createDiskOperations({ dataDir });
    const user = auth.fromTelegram({ id: '1234' }), other = auth.fromTelegram({ id: '5678' });
    const storage = { token: 'test-token', channelId: '-100', baseUrl: 'https://example.test' };
    telegram ||= {};
    telegram.remove ||= async () => {};
    const api = createDiskAPI({ dataDir, defaultStore: store, auth, operations, telegram, getDefaultBackend: () => storage,
        getIdentity: req => req.get('X-Other') ? other : user, setIdentity() {}, getOrigin: () => 'http://localhost', isMockRequest: () => false, maxDepth: () => 20 });
    const app = express(); app.use(express.json()); app.use('/api/telegram/drive', api.browser);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/telegram/drive`;
    const request = async (url, options = {}) => { const response = await fetch(base + url, options); return { status: response.status, data: await response.json() }; };
    const create = async files => (await request('/uploads', { method: 'POST', ...json({ progressive: true, files }) })).data;
    const terminal = job => until(async () => {
        const result = (await request('/operations/' + job.operation_id)).data;
        return ['failed', 'completed', 'cancelled'].includes(result.status) ? result : null;
    }, 'operation remained running');
    t.after(async () => {
        api.close();
        for (const job of operations.list({ userId: user.id })) if (!['completed', 'failed', 'cancelled'].includes(job.status)) await operations.cancel(job.operation_id, { userId: user.id });
        for (const job of operations.list({ userId: user.id })) await store.upload(job.uploadId)?.pipelineDone;
        operations.flush(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        openDiskRepository(dataDir).close(); fs.rmSync(dataDir, { recursive: true, force: true });
    });
    return { api, dataDir, store, auth, operations, user, storage, telegram, base, request, create, terminal };
}
function remote(part, id) { return { ...part, streamFactory: undefined, awaitSourceComplete: undefined, fileId: `remote-${id}`, fileUniqueId: `unique-${id}`, messageId: id, messageDate: Date.now() }; }
function fakeTelegram() {
    let id = 100;
    return {
        async pushChunk(_backend, _file, part, update, context) {
            await context.onState('pushing', { attempt: 1 });
            let bytes = 0;
            for await (const buffer of part.streamFactory(context.signal)) { bytes += buffer.length; update({ telegramPartBytesSent: bytes }); }
            await part.awaitSourceComplete(context.signal);
            const value = remote(part, ++id); await context.onConfirmed(value); await context.onState('push_confirmed'); return value;
        },
        async finalizeGroups(_backend, _file, parts, context) { await context.onGroupConfirmed(parts, 0); return parts; },
        remove: async () => {}
    };
}

test('真实HTTP：首片仅落盘5MB时Telegram已发送正文，两段连续进度及SSE无需等片完成', async t => {
    t.mock.method(console, 'info', () => {});
    let upstreamBytes = 0;
    const upstream = http.createServer((req, res) => {
        let bytes = 0;
        req.on('data', chunk => { bytes += chunk.length; upstreamBytes = bytes; });
        req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true,
            result: { message_id: 123, date: Math.floor(Date.now() / 1000), document: { file_id: 'remote', file_unique_id: 'u', file_size: 20_000_000 } } })); });
    });
    upstream.listen(0, '127.0.0.1'); await new Promise(resolve => upstream.once('listening', resolve));
    t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
    const f = await fixture(t, fakeTelegram());
    Object.assign(f.storage, { baseUrl: `http://127.0.0.1:${upstream.address().port}` });
    const actual = createDiskTelegram({ dataDir: f.dataDir, uploadScheduler: createTelegramUploadScheduler({ pacingMs: 0 }) });
    f.telegram.pushChunk = actual.pushChunk; f.telegram.finalizeGroups = actual.finalizeGroups;
    const job = await f.create([{ name: 'first.bin', size: 20_000_000 }]);
    assert.equal(job.progressive, true);
    const transfer = http.request(f.base + `/uploads/${job.uploadId}/files/0`, { method: 'PUT', headers: {
        'Content-Length': 20_000_000, 'Content-Range': 'bytes 0-19999999/20000000' } });
    transfer.on('error', () => {});
    const finished = new Promise((resolve, reject) => { transfer.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); transfer.on('error', reject); });
    finished.catch(() => {}); t.after(() => transfer.destroy());
    const streamAbort = new AbortController(); t.after(() => streamAbort.abort());
    const progressResponse = await fetch(f.base + `/uploads/${job.uploadId}/progress`, { signal: streamAbort.signal });
    assert.match(progressResponse.headers.get('content-type'), /text\/event-stream/);
    const reader = progressResponse.body.getReader(); const firstEvent = await reader.read(); assert.match(Buffer.from(firstEvent.value).toString(), /event: progress/);
    transfer.write(Buffer.alloc(5_000_000, 3));
    await until(() => upstreamBytes > 4_900_000, 'Telegram did not receive the initial disk increment');
    const chunk = f.store.upload(job.uploadId).files[0].chunks[0];
    assert.equal(chunk.sourceComplete, false); assert.equal(chunk.writtenBytes, 5_000_000);
    const progress = await until(async () => {
        const current = (await f.request('/operations/' + job.operation_id)).data;
        return current.telegramBytesSent > 0 && current.clientBytesReceived >= 5_000_000 && current;
    }, 'real socket progress missing');
    assert.ok(progress.telegramBytesSent < 20_000_000); assert.equal(progress.telegramBytesConfirmed, 0);
    const laterEvent = await reader.read(); assert.match(Buffer.from(laterEvent.value).toString(), /telegramBytesSent/);
    transfer.end(Buffer.alloc(15_000_000, 4));
    assert.equal(await finished, 200);
    await f.request(`/uploads/${job.uploadId}/finish`, { method: 'POST' });
    const completed = await f.terminal(job); assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.equal(completed.result.items[0].partCount, 1); assert.equal(f.store.get(f.user.id, completed.result.items[0].id).fileId, 'remote');
    streamAbort.abort();
});

test('慢Telegram reader不会通过pipe阻塞浏览器落盘；完成前批量文件不可见', async t => {
    t.mock.method(console, 'info', () => {});
    let release; const gate = new Promise(resolve => { release = resolve; }); t.after(release);
    const telegram = fakeTelegram(), send = telegram.pushChunk;
    telegram.pushChunk = async (...args) => { await gate; return send(...args); };
    const f = await fixture(t, telegram), job = await f.create([{ name: 'a.md', size: 3 }, { name: 'b.md', size: 3 }]);
    for (let i = 0; i < 2; i++) assert.equal((await f.request(`/uploads/${job.uploadId}/files/${i}`, { method: 'PUT', headers: { 'Content-Range': 'bytes 0-2/3' }, body: 'abc' })).status, 200);
    assert.equal(f.store.upload(job.uploadId).files.reduce((sum, file) => sum + file.received, 0), 6);
    assert.equal(f.store.adminFiles().length, 0);
    await f.request(`/uploads/${job.uploadId}/finish`, { method: 'POST' }); release();
    const result = await f.terminal(job); assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(f.store.adminFiles().length, 2);
});

test('上传专用SSE只允许本人且终态后仍能查询；普通旧API不变', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await fixture(t, fakeTelegram()), job = await f.create([{ name: 'a.md', size: 3 }]);
    const denied = await f.request(`/uploads/${job.uploadId}/progress`, { headers: { 'X-Other': '1' } }); assert.equal(denied.status, 404);
    await f.request(`/uploads/${job.uploadId}/files/0`, { method: 'PUT', headers: { 'Content-Range': 'bytes 0-2/3' }, body: 'abc' });
    await f.request(`/uploads/${job.uploadId}/finish`, { method: 'POST' }); assert.equal((await f.terminal(job)).status, 'completed');
    const response = await fetch(f.base + `/uploads/${job.uploadId}/progress`); assert.match(await response.text(), /"status":"completed"/);
});

test('完整请求响应丢失保留原始网络码并明确提示未知结果，不清理唯一来源或重发', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await fixture(t, fakeTelegram());
    let calls = 0;
    const actual = createDiskTelegram({ dataDir: f.dataDir, uploadScheduler: createTelegramUploadScheduler({ pacingMs: 0 }),
        fetchImpl: async (_url, options) => {
            calls++;
            for await (const _bytes of options.body) { /* all multipart bytes left the source */ }
            throw new TypeError('fetch failed', { cause: Object.assign(new Error('response lost'), { code: 'ECONNRESET' }) });
        }
    });
    f.telegram.pushChunk = actual.pushChunk; f.telegram.finalizeGroups = actual.finalizeGroups;
    const job = await f.create([{ name: 'unknown.bin', size: 3 }]), active = f.store.upload(job.uploadId);
    assert.equal((await f.request(`/uploads/${job.uploadId}/files/0`, { method: 'PUT', headers: { 'Content-Range': 'bytes 0-2/3' }, body: 'abc' })).status, 200);
    const failed = await f.terminal(job); await active.pipelineDone;
    assert.equal(calls, 1); assert.equal(failed.errorCode, 'TELEGRAM_NETWORK_ERROR');
    assert.equal(failed.errorDetails.causeCode, 'ECONNRESET'); assert.equal(failed.errorDetails.requestOutcomeUnknown, true);
    assert.match(failed.errorMessage, /未确认.*勿直接重复上传/);
    const manifest = JSON.parse(fs.readFileSync(path.join(active.dir, 'upload-manifest.json'), 'utf8'));
    assert.equal(manifest.recoveryDisposition, 'unknown'); assert.equal(manifest.files[0].chunks[0].status, 'push_unknown');
    assert.equal(fs.readFileSync(path.join(active.dir, manifest.files[0].chunks[0].path), 'utf8'), 'abc');
    assert.equal(f.store.adminFiles().length, 0);
});

test('渐进任务过期先中断并等待推送结束，再由runner清理，不与最终提交竞争', async t => {
    t.mock.method(console, 'info', () => {});
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args));
    let maintenance;
    const nativeInterval = global.setInterval;
    t.mock.method(global, 'setInterval', (callback, delay, ...args) => {
        // API maintenance is installed before the rate-limit stores' timers.
        if (delay === 60000 && !maintenance) maintenance = callback;
        return nativeInterval(callback, delay, ...args);
    });
    let pushing = false, aborted = false, finalized = false;
    const telegram = fakeTelegram();
    telegram.pushChunk = async (_backend, _file, _part, _update, context) => {
        await context.onState('pushing', { attempt: 1 }); pushing = true;
        await new Promise(resolve => context.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
        throw new Error('OPERATION_CANCELLED');
    };
    telegram.finalizeGroups = async () => { finalized = true; throw new Error('must not finalize'); };
    const f = await fixture(t, telegram), job = await f.create([{ name: 'expired.bin', size: 3 }]);
    const active = f.store.upload(job.uploadId);
    await f.request(`/uploads/${job.uploadId}/files/0`, { method: 'PUT', headers: { 'Content-Range': 'bytes 0-2/3' }, body: 'abc' });
    await until(() => pushing, 'push never entered its running state');
    active.createdAt = Date.now() - 3 * 60 * 60 * 1000;
    assert.equal(typeof maintenance, 'function'); maintenance();
    const expired = await f.terminal(job); await active.pipelineDone;
    assert.equal(expired.status, 'failed'); assert.equal(expired.errorCode, 'UPLOAD_EXPIRED');
    assert.equal(aborted, true); assert.equal(finalized, false); assert.equal(fs.existsSync(active.dir), false);
    assert.equal(f.store.adminFiles().length, 0);
    await sleep(20); assert.deepEqual(warnings, []);
});
