'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const express = require('express');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskOperations } = require('../server/disk-operations');
const { createDiskAPI } = require('../server/disk-api');
const { openDiskRepository } = require('../server/disk-repository');
const { createDiskChunkFileCache } = require('../server/disk-chunk-file-cache');
const crypto = require('node:crypto');
const { diskErrorCode, diskErrorDetails } = require('../server/disk-errors');

const json = value => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
async function fixture(t, uploadPhysical) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-upload-errors-'));
    const store = createTelegramDriveStore({ dataDir }), auth = createDiskAuth({ dataDir }), operations = createDiskOperations({ dataDir });
    const user = auth.fromTelegram({ id: '12345' }), other = auth.fromTelegram({ id: '67890' }), removed = [];
    const telegram = { uploadPhysical, call: async () => ({}), remove: async (_backend, file) => { removed.push(...file.parts.map(part => part.messageId)); } };
    const api = createDiskAPI({ dataDir, defaultStore: store, auth, operations, telegram,
        getDefaultBackend: () => ({ token: 'test-token', channelId: '-100', baseUrl: 'https://example.test' }),
        getIdentity: req => req.get('X-Test-Other') ? other : user, setIdentity() {}, getOrigin: () => 'http://localhost', isMockRequest: () => false, maxDepth: () => 20 });
    const app = express(); app.use(express.json()); app.use('/api/telegram/drive', api.browser);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/telegram/drive`;
    t.after(async () => { api.close(); operations.flush(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); openDiskRepository(dataDir).close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    const request = async (url, options = {}) => { const response = await fetch(base + url, options); return { status: response.status, data: await response.json() }; };
    const create = async (body = { files: [{ name: 'a.md', size: 3 }, { name: 'b.webp', size: 3 }] }) => (await request('/uploads', { method: 'POST', ...json(body) })).data;
    const send = async (job, index) => request(`/uploads/${job.uploadId}/files/${index}`, { method: 'PUT', headers: { 'Content-Range': 'bytes 0-2/3' }, body: 'abc' });
    const terminal = async job => {
        for (let index = 0; index < 250; index++) {
            const result = (await request('/operations/' + job.operation_id)).data;
            if (['completed', 'failed', 'cancelled'].includes(result.status)) return result;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('upload did not finish');
    };
    return { dataDir, store, user, removed, request, create, send, terminal, telegram };
}
const remotes = parts => parts.map((part, index) => ({ ...part, fileId: 'remote-' + index, messageId: 101 + index, fileUniqueId: 'u-' + index, messageDate: Date.now() }));

test('HTTP and durable operation preserve EPERM and sanitized Telegram/network diagnostics', t => {
    assert.equal(diskErrorCode(Object.assign(new Error("EPERM: rename 'private/path'"), { code: 'EPERM' })), 'EPERM');
    const error = Object.assign(new Error('TELEGRAM_400'), { telegramDescription: 'bad https://api.telegram.org/bot123:secret/file', details: { method: 'sendMediaGroup', requestId: 'r', elapsedMs: 15, privatePath: 'private/path' } });
    const safe = diskErrorDetails(error);
    assert.equal(safe.method, 'sendMediaGroup'); assert.equal(safe.elapsedMs, 15);
    assert.doesNotMatch(JSON.stringify(safe), /secret|private\/path|api.telegram.org/);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-operation-errors-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const operations = createDiskOperations({ dataDir }), scope = { userId: 'u' }, job = operations.create(scope, 'upload', 'test');
    operations.fail(job.operation_id, error);
    assert.equal(operations.get(job.operation_id, scope).errorDetails.method, 'sendMediaGroup');
});

test('after Telegram rollback phase/PUT/thumbnail preserve the original failure instead of UPLOAD_NOT_FOUND', async t => {
    const f = await fixture(t, async () => { await new Promise(resolve => setTimeout(resolve, 30)); throw Object.assign(new Error('TELEGRAM_400'), { telegramDescription: 'Bad Request: media invalid', details: { method: 'sendMediaGroup' } }); });
    const job = await f.create(); await f.send(job, 0); await f.send(job, 1);
    const result = await f.terminal(job);
    assert.equal(result.errorCode, 'TELEGRAM_400'); assert.equal(result.errorDetails.method, 'sendMediaGroup');
    assert.equal(f.store.upload(job.uploadId), undefined);
    for (const [url, options] of [
        [`/uploads/${job.uploadId}/phase`, { method: 'POST', ...json({ index: 1 }) }],
        [`/uploads/${job.uploadId}/files/1`, { method: 'PUT', body: 'abc' }],
        [`/uploads/${job.uploadId}/files/1/thumbnail`, { method: 'PUT', body: 'abc' }]
    ]) {
        const response = await f.request(url, options);
        assert.equal(response.data.error, 'TELEGRAM_400');
        assert.equal(response.data.errorDetails.telegramDescription, 'Bad Request: media invalid');
    }
    const other = await f.request(`/uploads/${job.uploadId}/phase`, { method: 'POST', headers: { 'X-Test-Other': '1' } });
    assert.equal(other.data.error, 'UPLOAD_NOT_FOUND', 'another user cannot inspect the original failure');
    assert.equal(f.store.list(f.user.id).files.length, 0);
});

test('optional chunk cache persistence failures cannot discard accepted messages or fail a valid batch', async t => {
    const f = await fixture(t, async (_backend, _files, parts) => remotes(parts));
    const repository = openDiskRepository(f.dataDir), replaceMany = repository.replaceMany;
    let failed = 0;
    t.mock.method(repository, 'replaceMany', changes => {
        if (changes.some(change => change.table === 'chunk_ids')) { failed++; throw new Error('DISK_WRITE_CONFLICT'); }
        return replaceMany(changes);
    });
    const job = await f.create(); await f.send(job, 0); await f.send(job, 1);
    await f.request(`/uploads/${job.uploadId}/finish`, { method: 'POST' });
    assert.equal((await f.terminal(job)).status, 'completed');
    assert.ok(failed > 0); assert.equal(f.store.list(f.user.id).files.length, 2); assert.deepEqual(f.removed, []);
});

test('permanent manifest EPERM rolls back every accepted message and reports a filesystem cause', async t => {
    let rejectManifest = false;
    const f = await fixture(t, async (_backend, _files, parts) => { rejectManifest = true; return remotes(parts); });
    const rename = fsp.rename;
    t.mock.method(fsp, 'rename', async (...args) => {
        if (rejectManifest && args[1].endsWith('upload-manifest.json')) throw Object.assign(new Error('EPERM: rename manifest'), { code: 'EPERM', syscall: 'rename' });
        return rename(...args);
    });
    const job = await f.create(); await f.send(job, 0); await f.send(job, 1);
    await f.request(`/uploads/${job.uploadId}/finish`, { method: 'POST' });
    const result = await f.terminal(job);
    assert.equal(result.errorCode, 'EPERM'); assert.deepEqual(f.removed.sort(), [101, 102]);
    assert.equal(f.store.list(f.user.id).files.length, 0);
    const next = await f.request(`/uploads/${job.uploadId}/phase`, { method: 'POST' });
    assert.equal(next.data.error, 'EPERM');
    const logged = fs.readFileSync(path.join(f.dataDir, 'disk-upload.log'), 'utf8');
    assert.match(logged, /upload.pipeline-failed/); assert.match(logged, /rename/);
});

test('failed upload initialization releases its filename reservation and records the first cause', async t => {
    const f = await fixture(t, async (_backend, _files, parts) => remotes(parts));
    const rename = fsp.rename; let fail = true;
    t.mock.method(fsp, 'rename', async (...args) => {
        if (fail && args[1].endsWith('upload-manifest.json')) throw Object.assign(new Error('EPERM: rename manifest'), { code: 'EPERM', syscall: 'rename' });
        return rename(...args);
    });
    const failed = await f.create();
    assert.equal(failed.error, 'EPERM');
    const jobs = (await f.request('/operations')).data.operations;
    assert.equal(jobs[0].status, 'failed'); assert.equal(jobs[0].errorCode, 'EPERM');
    fail = false;
    const retried = await f.create(); assert.ok(retried.uploadId, 'failed initialization must not reserve the same filename');
    await f.request(`/uploads/${retried.uploadId}`, { method: 'DELETE' });
});

test('getFile size mismatch invalidates a cached mapping and uploads the original bytes', async t => {
    const seen = [];
    const f = await fixture(t, async (_backend, _files, parts) => { seen.push(...parts); return remotes(parts); });
    const backend = { token: 'test-token', channelId: '-100', baseUrl: 'https://example.test' };
    const cache = createDiskChunkFileCache({ dataDir: f.dataDir });
    const part = { sha256: crypto.createHash('sha256').update('abc').digest('hex'), size: 3 };
    cache.put(backend, part, { fileId: 'old-file', size: 3 });
    t.mock.method(f.telegram, 'call', async () => ({ file_size: 4 }));
    const job = await f.create(); await f.send(job, 0); await f.send(job, 1);
    await f.request(`/uploads/${job.uploadId}/finish`, { method: 'POST' });
    assert.equal((await f.terminal(job)).status, 'completed');
    assert.ok(seen.length === 2 && seen.every(part => !part.reuseFileId));
    assert.notEqual(cache.get(backend, part).fileId, 'old-file');
});

test('intentional cancellation during transport cannot become a Telegram network failure', async t => {
    let started;
    const active = new Promise(resolve => { started = resolve; });
    const f = await fixture(t, async (_backend, _files, _parts, _progress, context) => {
        started();
        await new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('TELEGRAM_NETWORK_ERROR')), { once: true }));
    });
    const job = await f.create(); await f.send(job, 0); await f.send(job, 1); await active;
    assert.equal((await f.request(`/uploads/${job.uploadId}`, { method: 'DELETE' })).status, 200);
    const result = await f.terminal(job);
    assert.equal(result.status, 'cancelled'); assert.equal(result.errorCode, '');
    assert.equal(f.store.list(f.user.id).files.length, 0);
});

test('parallel 11/20-file batches remain invisible until complete and share a serial Telegram queue', async t => {
    let active = 0, maxActive = 0, nextId = 100;
    const f = await fixture(t, async (_backend, _files, parts) => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise(resolve => setTimeout(resolve, 2));
        active--;
        return remotes(parts).map(part => ({ ...part, messageId: ++nextId, fileId: 'remote-' + nextId }));
    });
    const types = ['webp', 'winmd', 'md', 'zip', 'exe', 'json', 'jpg', 'pdf'];
    const batches = await Promise.all([11, 20].map(count => f.create({ folderPath: 'batch-' + count,
        files: Array.from({ length: count }, (_item, index) => ({ name: `file-${index}.${types[index % types.length]}`, size: 3 })) })));
    await Promise.all(batches.map(async (job, batch) => {
        for (let index = 0; index < [11, 20][batch]; index++) await f.send(job, index);
    }));
    assert.equal(f.store.adminFiles().length, 0, 'the batch must not be partially visible');
    await Promise.all(batches.map(job => f.request(`/uploads/${job.uploadId}/finish`, { method: 'POST' })));
    for (const job of batches) assert.equal((await f.terminal(job)).status, 'completed');
    assert.equal(f.store.adminFiles().length, 31); assert.equal(maxActive, 1);
});

test('failed partial transport cleanup keeps known messages in the recovery manifest without masking the original error', async t => {
    const f = await fixture(t, async (_backend, _files, parts) => {
        throw Object.assign(new Error('TELEGRAM_400'), { telegramDescription: 'Bad Request: invalid file', unremovedParts: remotes(parts.slice(0, 1)) });
    });
    t.mock.method(f.telegram, 'remove', async () => { throw new Error('TELEGRAM_NETWORK_ERROR'); });
    const job = await f.create(); await f.send(job, 0); await f.send(job, 1);
    const result = await f.terminal(job);
    assert.equal(result.errorCode, 'TELEGRAM_400');
    assert.equal(f.store.adminFiles().length, 0);
    const filename = path.join(f.dataDir, 'telegram-drive-staging', job.uploadId, 'upload-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(manifest.pendingRollbackParts[0].messageId, 101);
    assert.equal(manifest.files[0].chunks[0].remote, null, 'failed partial results must not be recorded as successful parts');
    assert.equal((await f.request(`/uploads/${job.uploadId}`, { method: 'DELETE' })).data.error, 'UPLOAD_NOT_FOUND');
    assert.equal(fs.existsSync(filename), true, 'browser cancellation after failure must not remove the recovery manifest');
});

test('browser recovers the original operation failure when a later request sees a removed upload', async () => {
    const window = {}, requests = [];
    const fetch = async (url, options = {}) => {
        requests.push(url);
        if (url.endsWith('/uploads')) return { ok: true, json: async () => ({ uploadId: 'u', operation_id: 'op' }) };
        if (url.endsWith('/phase')) return { ok: false, status: 404, json: async () => ({ error: 'UPLOAD_NOT_FOUND' }) };
        if (url.endsWith('/operations/op')) return { ok: true, json: async () => ({ errorCode: 'TELEGRAM_400', errorDetails: { telegramDescription: 'Bad Request: media invalid' } }) };
        return { ok: true, json: async () => ({ operations: [] }) };
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'client/disk-client.js'), 'utf8'), { window, fetch, setInterval() {}, Date, Map, Set, Promise, encodeURIComponent });
    await assert.rejects(window.DiskClient.upload([{ name: 'a', size: 3 }]), error => error.message === 'TELEGRAM_400' && error.errorDetails.telegramDescription === 'Bad Request: media invalid');
    assert.ok(requests.some(url => url.endsWith('/operations/op')));
});
