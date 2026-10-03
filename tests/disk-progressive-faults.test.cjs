'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const express = require('express');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskOperations } = require('../server/disk-operations');
const { createDiskAPI } = require('../server/disk-api');
const { createProgressiveUploadRunner } = require('../server/disk-progressive-upload');
const { openDiskRepository } = require('../server/disk-repository');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate, message, timeout = 5000) {
    const stop = Date.now() + timeout;
    while (Date.now() < stop) { const value = await predicate(); if (value) return value; await sleep(10); }
    throw new Error(message);
}
const json = value => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const accepted = (part, messageId) => ({ fileIndex: part.fileIndex, logicalFileId: part.logicalFileId,
    partIndex: part.partIndex, partCount: part.partCount, size: part.size, offset: part.offset,
    originalSize: part.originalSize, fileId: 'remote-' + messageId, fileUniqueId: 'unique-' + messageId,
    messageId, messageDate: Date.now(), mediaType: 'document' });

function fakeTelegram() {
    let id = 100;
    return {
        async pushChunk(_backend, _file, part, update, context) {
            await context.onState('pushing', { attempt: 1 });
            let received = 0;
            for await (const bytes of part.streamFactory(context.signal)) { received += bytes.length; update({ telegramPartBytesSent: received }); }
            await part.awaitSourceComplete(context.signal);
            const result = accepted(part, ++id);
            try { await context.onConfirmed(result); await context.onState('push_confirmed', { telegramPushedBytes: part.size }); }
            catch (error) { error.unremovedParts = [result]; throw error; }
            return result;
        },
        async finalizeGroups(_backend, _file, parts, context) {
            const result = parts.length === 1 ? parts : parts.map(part => ({ ...part, messageId: ++id, fileId: 'final-' + id }));
            await context.onGroupConfirmed(result, 0); return result;
        },
        async remove() {}
    };
}

async function apiFixture(t, telegram) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-progressive-fault-'));
    const store = createTelegramDriveStore({ dataDir }), auth = createDiskAuth({ dataDir }), operations = createDiskOperations({ dataDir });
    const user = auth.fromTelegram({ id: '1234' });
    const backend = { token: 'fixture-token', channelId: '-10042', baseUrl: 'https://example.test' };
    const api = createDiskAPI({ dataDir, defaultStore: store, auth, operations, telegram, getDefaultBackend: () => backend,
        getIdentity: () => user, setIdentity() {}, getOrigin: () => 'http://localhost', isMockRequest: () => false, maxDepth: () => 20 });
    const app = express(); app.use(express.json()); app.use('/api/telegram/drive', api.browser);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/telegram/drive`;
    const request = async (url, options = {}) => { const response = await fetch(base + url, options); return { status: response.status, data: await response.json() }; };
    const create = async files => (await request('/uploads', { method: 'POST', ...json({ progressive: true, files }) })).data;
    const terminal = job => until(() => {
        const operation = operations.get(job.operation_id, { userId: user.id });
        return ['completed', 'failed', 'cancelled'].includes(operation?.status) && operation;
    }, 'operation did not become terminal');
    t.after(async () => {
        api.close();
        for (const operation of operations.list({ userId: user.id })) {
            if (!['completed', 'failed', 'cancelled'].includes(operation.status)) await operations.cancel(operation.operation_id, { userId: user.id });
            await store.upload(operation.uploadId)?.pipelineDone;
        }
        operations.flush(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        openDiskRepository(dataDir).close(); fs.rmSync(dataDir, { recursive: true, force: true });
    });
    return { dataDir, store, operations, user, request, create, terminal };
}

test('onConfirmed manifest save is gated: no finalization or SQLite commit may run until persistence succeeds', async t => {
    t.mock.method(console, 'info', () => {});
    const gate = deferred(), started = deferred(); t.after(gate.resolve);
    const telegram = fakeTelegram(), finalize = telegram.finalizeGroups;
    let finalized = 0;
    telegram.finalizeGroups = async (...args) => { finalized++; return finalize(...args); };
    const f = await apiFixture(t, telegram);
    const confirm = f.store.markPartsUploaded;
    t.mock.method(f.store, 'markPartsUploaded', async (...args) => { started.resolve(); await gate.promise; return confirm.apply(f.store, args); });
    const job = await f.create([{ name: 'one.bin', size: 3 }]);
    await f.request(`/uploads/${job.uploadId}/files/0`, { method: 'PUT', headers: { 'Content-Range': 'bytes 0-2/3' }, body: 'abc' });
    await started.promise;
    assert.equal((await f.request(`/uploads/${job.uploadId}/finish`, { method: 'POST' })).status, 202);
    await sleep(30);
    assert.equal(finalized, 0); assert.equal(f.store.adminFiles().length, 0);
    assert.equal(f.store.upload(job.uploadId).files[0].chunks[0].tempRemote, null);
    gate.resolve();
    assert.equal((await f.terminal(job)).status, 'completed');
    assert.equal(finalized, 1); assert.equal(f.store.adminFiles().length, 1);
});

test('a failed confirmed-message manifest save rolls back its known Telegram ID without finalization or commit', async t => {
    t.mock.method(console, 'info', () => {});
    const telegram = fakeTelegram(); let finalized = 0;
    const removed = [];
    telegram.finalizeGroups = async () => { finalized++; throw new Error('must not finalize'); };
    telegram.cleanupTemporaryMessages = async (_backend, file) => { removed.push(...file.parts.map(part => part.messageId)); };
    const f = await apiFixture(t, telegram), rename = fsp.rename;
    let injected = false, upload;
    t.mock.method(fsp, 'rename', async (...args) => {
        const job = upload && f.store.upload(upload.uploadId);
        if (!injected && job?.files[0].chunks[0]?.tempRemote) { injected = true; throw Object.assign(new Error('confirmed manifest failed'), { code: 'EIO' }); }
        return rename(...args);
    });
    upload = await f.create([{ name: 'one.bin', size: 3 }]);
    const active = f.store.upload(upload.uploadId);
    await f.request(`/uploads/${upload.uploadId}/files/0`, { method: 'PUT', headers: { 'Content-Range': 'bytes 0-2/3' }, body: 'abc' });
    const operation = await f.terminal(upload); await active.pipelineDone;
    assert.equal(injected, true); assert.equal(operation.status, 'failed'); assert.equal(operation.errorCode, 'EIO');
    assert.equal(finalized, 0); assert.equal(f.store.adminFiles().length, 0);
    assert.deepEqual(removed, [101]); assert.equal(active.pipelineError, 'EIO');
    assert.equal(fs.existsSync(active.dir), false);
});

test('operations.fail throwing cannot mask the original upload failure or prevent abort and rollback of known message IDs', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-progressive-fault-runner-'));
    const store = createTelegramDriveStore({ dataDir });
    t.after(() => { openDiskRepository(dataDir).close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    const job = store.begin({ owner: { id: 'owner' }, folderPath: '', maxDepth: 20, progressive: true,
        files: [{ name: 'accepted.bin', size: 3 }, { name: 'failed.bin', size: 3 }], channelId: '-10042' });
    job.operationId = 'operation'; job.storage = { token: 'fixture-token', channelId: '-10042', baseUrl: 'https://example.test' };
    for (let index = 0; index < 2; index++) await store.receivePart(job.id, index, Readable.from(['abc']), 'bytes 0-2/3');
    await store.markClientDone(job.id);
    const confirmed = deferred(); let otherAborted = false, failures = 0, committed = false;
    const original = Object.assign(new Error('TELEGRAM_400'), { telegramDescription: 'Bad Request: injected' });
    const logged = [], rolledBack = [];
    const telegram = {
        async pushChunk(_backend, _file, part, _update, context) {
            if (part.fileIndex === 0) {
                await context.onState('pushing', { attempt: 1 });
                await context.onConfirmed(accepted(part, 101)); confirmed.resolve();
                await new Promise((resolve, reject) => {
                    const abort = () => { otherAborted = true; reject(new Error('OPERATION_CANCELLED')); };
                    context.signal.addEventListener('abort', abort, { once: true });
                    if (context.signal.aborted) abort();
                });
            }
            await confirmed.promise;
            context.onFailure(original);
            throw original;
        }
    };
    const operations = { onCancel() {}, fail() { failures++; throw Object.assign(new Error('status save failed'), { code: 'SQLITE_BUSY' }); } };
    const wake = source => { for (const resolve of source.waiters || []) resolve(); source.waiters?.clear(); };
    const wait = source => new Promise(resolve => { source.waiters ||= new Set(); source.waiters.add(resolve); });
    const run = createProgressiveUploadRunner({ telegram, operations, chunkFileCache: { get() { return null; }, put() {} },
        log: (event, details) => logged.push({ event, details }), wake, wait,
        commit: async () => { committed = true; }, rollback: async source => {
            rolledBack.push(...source.files.flatMap(file => file.chunks.map(chunk => chunk.tempRemote)).filter(Boolean).map(part => part.messageId));
            await store.abortAsync(source.id);
        } });
    await assert.rejects(run({ diskScope: { userId: 'owner' } }, store, job, () => {}, { cancelled: false, throwIfCancelled() {} }), error => error === original);
    assert.ok(failures >= 2); assert.equal(otherAborted, true); assert.equal(job.pipelineAbort.signal.aborted, true);
    assert.equal(committed, false); assert.deepEqual(rolledBack, [101]);
    assert.equal(job.pipelineFailure, original); assert.equal(job.pipelineError, 'TELEGRAM_400');
    assert.ok(logged.some(item => item.event === 'upload.failure-state-write-failed'));
    assert.equal(fs.existsSync(job.dir), false);
});

test('temporary-message cleanup failure leaves committed files readable, retains pending cleanup and adds a warning', async t => {
    t.mock.method(console, 'info', () => {});
    const telegram = fakeTelegram(); let cleanupCalls = 0;
    telegram.cleanupTemporaryMessages = async (_backend, file, context) => {
        cleanupCalls++;
        assert.deepEqual(file.parts.map(part => part.messageId), [101, 102]);
        assert.deepEqual(context.finalMessageIds, [103, 104]);
        throw new Error('TELEGRAM_NETWORK_ERROR');
    };
    const f = await apiFixture(t, telegram);
    const job = await f.create([{ name: 'two-parts.bin', size: 6, parts: [
        { byteStart: 0, byteEnd: 2, size: 3 }, { byteStart: 3, byteEnd: 5, size: 3 }
    ] }]);
    const active = f.store.upload(job.uploadId);
    // Optional thumbnail failure and cleanup failure may settle in different
    // microtasks; operation completion must retain both independent warnings.
    active.files[0].thumbnail = { size: 1, type: 'image/jpeg', path: path.join(active.dir, 'cover.jpg'),
        status: 'failed', warning: 'TELEGRAM_THUMBNAIL_UPLOAD_FAILED', remote: null };
    for (const range of ['bytes 0-2/6', 'bytes 3-5/6']) assert.equal((await f.request(`/uploads/${job.uploadId}/files/0`, {
        method: 'PUT', headers: { 'Content-Range': range }, body: 'abc'
    })).status, 200);
    await f.request(`/uploads/${job.uploadId}/finish`, { method: 'POST' });
    const result = await f.terminal(job); await active.pipelineDone;
    const warning = await until(() => {
        const current = f.operations.get(job.operation_id, { userId: f.user.id });
        return current.warnings?.includes('TELEGRAM_TEMP_CLEANUP_PENDING') && current;
    }, 'missing durable cleanup warning');
    assert.equal(result.status, 'completed'); assert.equal(warning.status, 'completed'); assert.ok(cleanupCalls >= 1);
    assert.ok(warning.warnings.includes('TELEGRAM_THUMBNAIL_UPLOAD_FAILED'));
    assert.ok(warning.warnings.includes('TELEGRAM_TEMP_CLEANUP_PENDING'));
    const file = f.store.get(f.user.id, result.result.items[0].id);
    assert.deepEqual(file.parts.map(part => part.messageId), [103, 104]);
    assert.deepEqual(file.pendingRemoteCleanup[0].parts.map(part => part.messageId), [101, 102]);
    assert.equal(file.pendingRemoteCleanup[0].operationId, job.operation_id);
    assert.equal(f.store.adminFiles().length, 1);
    const reloaded = createTelegramDriveStore({ dataDir: f.dataDir }).get(f.user.id, file.id);
    assert.deepEqual(reloaded.pendingRemoteCleanup[0].parts.map(part => part.messageId), [101, 102]);
});
