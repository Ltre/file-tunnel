'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskOperations } = require('../server/disk-operations');
const { createDiskAPI } = require('../server/disk-api');
const { openDiskRepository } = require('../server/disk-repository');
const json = body => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function until(predicate) {
    for (let index = 0; index < 250; index++) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(await predicate(), 'upload state did not settle');
}
async function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-progressive-boundaries-'));
    const store = createTelegramDriveStore({ dataDir }), auth = createDiskAuth({ dataDir }), operations = createDiskOperations({ dataDir });
    const user = auth.fromTelegram({ id: '12345' }), other = auth.fromTelegram({ id: '67890' });
    const calls = { legacy: 0, progressive: 0 }, removed = [];
    const telegram = {
        call: async () => ({}),
        pushChunk: async () => { calls.progressive++; throw new Error('unexpected progressive transfer'); },
        finalizeGroups: async () => { throw new Error('unexpected progressive finalization'); },
        uploadPhysical: async (_backend, _files, parts) => { calls.legacy++; return parts.map((part, index) => ({ ...part, messageId: 100 + index, fileId: 'remote-' + index, fileUniqueId: 'unique-' + index, messageDate: Date.now() })); },
        remove: async (_backend, file) => { removed.push(...file.parts.map(part => part.messageId)); }
    };
    const api = createDiskAPI({ dataDir, defaultStore: store, auth, operations, telegram,
        getDefaultBackend: () => ({ token: 'test-token', channelId: '-100', baseUrl: 'https://example.test' }),
        getIdentity: req => req.get('X-Test-Other') ? other : user, setIdentity() {}, getOrigin: () => 'http://localhost', isMockRequest: () => false, maxDepth: () => 20 });
    const app = express(); app.use(express.json()); app.use('/api/telegram/drive', api.browser);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/telegram/drive`;
    const request = async (url, options = {}) => { const response = await fetch(base + url, options); return { status: response.status, data: await response.json() }; };
    t.after(async () => {
        for (const owner of [user, other]) for (const job of operations.list({ userId: owner.id, diskSpace: '' })) if (['queued', 'running'].includes(job.status)) await operations.cancel(job.operation_id, { userId: owner.id, diskSpace: '' });
        await new Promise(resolve => setTimeout(resolve, 50));
        api.close(); operations.flush(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        openDiskRepository(dataDir).close(); fs.rmSync(dataDir, { recursive: true, force: true });
    });
    const create = async (name, progressive = true, prefix = '', headers = {}) => request(prefix + '/uploads', { method: 'POST', ...json({ files: [{ name, size: 3 }], progressive }), headers: { 'Content-Type': 'application/json', ...headers } });
    return { dataDir, store, user, other, operations, api, calls, request, create, base, server };
}

test('旧API不声明渐进式时仍完整落盘后走原pipeline，不调用新push/finalize接口', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await fixture(t), created = await f.create('legacy.bin', false);
    assert.equal(created.status, 201); assert.equal(created.data.progressive, false);
    const job = created.data;
    assert.equal((await f.request(`/uploads/${job.uploadId}/files/0`, { method: 'PUT', headers: { 'Content-Range': 'bytes 0-2/3' }, body: 'abc' })).status, 200);
    await f.request(`/uploads/${job.uploadId}/finish`, { method: 'POST' });
    await until(() => f.operations.get(job.operation_id, { userId: f.user.id }).status === 'completed');
    assert.equal(f.calls.legacy, 1); assert.equal(f.calls.progressive, 0);
    assert.equal(f.store.list(f.user.id, '').files.length, 1);
});

test('20个渐进式任务占位时拒绝第21个，失败清理后释放容量', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await fixture(t), jobs = [];
    for (let index = 0; index < 20; index++) {
        const result = await f.create(`pending-${index}.bin`); assert.equal(result.status, 201); jobs.push(result.data);
    }
    const refused = await f.create('capacity-overflow.bin');
    assert.equal(refused.data.error, 'UPLOAD_ACTIVE_LIMIT'); assert.ok(refused.status >= 400);
    assert.equal(f.operations.list({ userId: f.user.id }).length, 20, '拒绝前必须不创建任务或reservation');
    await f.request(`/uploads/${jobs[0].uploadId}/failure`, { method: 'POST', ...json({ errorCode: 'UPLOAD_CLIENT_NETWORK_ERROR', reason: 'test' }) });
    await until(() => !f.store.upload(jobs[0].uploadId));
    assert.equal((await f.create('after-cleanup.bin')).status, 201);
});

test('SSE持续推送后续250ms进度并在终态结束，其他用户无法访问', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await fixture(t), job = (await f.create('events.bin')).data;
    const denied = await f.request(`/uploads/${job.uploadId}/progress`, { headers: { 'X-Test-Other': '1' } });
    assert.equal(denied.status, 404); assert.equal(denied.data.error, 'UPLOAD_NOT_FOUND');
    const response = await fetch(f.base + `/uploads/${job.uploadId}/progress`);
    assert.match(response.headers.get('Content-Type'), /text\/event-stream/);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    assert.match(decoder.decode((await reader.read()).value), /event: progress/);
    f.operations.update(job.operation_id, { telegramBytesSent: 123, telegramTotalBytes: 300 });
    const next = decoder.decode((await reader.read()).value);
    assert.match(next, /"telegramBytesSent":123/);
    f.operations.fail(job.operation_id, new Error('TELEGRAM_400'));
    const terminal = decoder.decode((await reader.read()).value);
    assert.match(terminal, /"status":"failed"/); assert.equal((await reader.read()).done, true);
    await f.request(`/uploads/${job.uploadId}/failure`, { method: 'POST', ...json({ reason: 'test' }) });
});

test('中断SSE连接后停止250ms快照读取，不保留后台轮询计时器', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await fixture(t), job = (await f.create('abort-events.bin')).data;
    let snapshots = 0;
    const original = f.operations.get;
    t.mock.method(f.operations, 'get', function (id, ...args) {
        if (id === job.operation_id) snapshots++;
        return original.call(this, id, ...args);
    });
    const abort = new AbortController();
    const response = await fetch(f.base + `/uploads/${job.uploadId}/progress`, { signal: abort.signal });
    assert.match(new TextDecoder().decode((await response.body.getReader().read()).value), /event: progress/);
    abort.abort();
    await new Promise(resolve => setTimeout(resolve, 100));
    const afterClose = snapshots;
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(snapshots, afterClose, '已关闭的SSE不能继续读取operation或向断开的response写入');
});

test('协同SSE仅允许当前grant，普通owner任务和其它grant不可越界读取', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await fixture(t);
    f.store.createDirectory(f.user.id, 'grant-a', 20); f.store.createDirectory(f.user.id, 'grant-b', 20);
    const enable = async folder => {
        const result = await f.request('/collaborations/invitations', { method: 'POST', ...json({ kind: 'directory', path: folder }) });
        assert.equal(result.status, 201);
        const token = result.data.url.split('/').pop();
        assert.equal((await f.request('/collaborations/join', { method: 'POST', ...json({ token }), headers: { 'Content-Type': 'application/json', 'X-Test-Other': '1' } })).status, 200);
        return `/collaboration-scope/${result.data.collaboration.id}`;
    };
    const a = await enable('grant-a'), b = await enable('grant-b');
    const normal = (await f.create('owner.bin')).data;
    const selected = await f.create('member.bin', true, a, { 'X-Test-Other': '1' }); assert.equal(selected.status, 201);
    const scopeJob = selected.data;
    for (const [prefix, job] of [[a, normal], [b, scopeJob]]) {
        const response = await f.request(prefix + `/uploads/${job.uploadId}/progress`, { headers: { 'X-Test-Other': '1' } });
        assert.ok(response.status >= 400, '不同scope应拒绝');
    }
    const abort = new AbortController();
    const response = await fetch(f.base + a + `/uploads/${scopeJob.uploadId}/progress`, { headers: { 'X-Test-Other': '1' }, signal: abort.signal });
    assert.equal(response.status, 200, '协同scope应允许其自身上传的progress SSE');
    assert.match(new TextDecoder().decode((await response.body.getReader().read()).value), new RegExp(scopeJob.operation_id));
    abort.abort();
});
