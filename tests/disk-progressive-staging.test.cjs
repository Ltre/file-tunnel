'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Readable } = require('node:stream');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { openDiskRepository } = require('../server/disk-repository');

const turn = () => new Promise(resolve => setImmediate(resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t, { size = 6, parts, progressive = true } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-growing-staging-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const drive = createTelegramDriveStore({ dataDir });
    const job = drive.begin({ owner: { id: 'owner-1', name: 'Owner' }, folderPath: '', channelId: '-10042', maxDepth: 20, progressive,
        files: [{ name: 'clip.bin', size, ...(parts ? { parts } : {}) }] });
    return { dataDir, drive, job };
}
const manifest = job => JSON.parse(fs.readFileSync(path.join(job.dir, 'upload-manifest.json'), 'utf8'));
const remote = (partIndex, messageId) => ({ fileIndex: 0, partIndex, partCount: 2, offset: (partIndex - 1) * 3, size: 3, fileId: 'file-' + messageId, messageId });
async function twoChunks(t) {
    const setup = fixture(t, { parts: [{ byteStart: 0, byteEnd: 2, size: 3 }, { byteStart: 3, byteEnd: 5, size: 3 }] });
    await setup.drive.receivePart(setup.job.id, 0, Readable.from(['abc']), 'bytes 0-2/6');
    await setup.drive.receivePart(setup.job.id, 0, Readable.from(['def']), 'bytes 3-5/6');
    return setup;
}

test('first written browser bytes become readable before the whole part arrives, then the reader waits for growth', async t => {
    const { drive, job } = fixture(t);
    const input = new PassThrough();
    let ready;
    const available = new Promise(resolve => { ready = resolve; });
    const progress = [];
    const receiving = drive.receivePart(job.id, 0, input, 'bytes 0-5/6', value => progress.push(value), { onReady: ready });
    input.write('abc');
    const chunk = await available;
    assert.equal(chunk.writtenBytes, 3); assert.equal(chunk.sourceComplete, false);
    const iterator = chunk.streamFactory()[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.toString(), 'abc');
    let ended = false;
    const tail = iterator.next().then(value => { ended = true; return value; });
    await pause(15); assert.equal(ended, false, 'catching the writer cannot emit EOF');
    input.end('def');
    await receiving;
    assert.equal((await tail).value.toString(), 'def');
    assert.equal((await iterator.next()).done, true);
    assert.deepEqual(progress, [3, 6]);
    assert.equal(chunk.sourceComplete, true);
    assert.equal(manifest(job).files[0].chunks[0].sourceComplete, true);
});

test('a slow Telegram reader does not hold browser staging back and drains every tail byte after source completion', async t => {
    const size = 256 * 1024, { drive, job } = fixture(t, { size });
    const input = new PassThrough();
    let ready;
    const available = new Promise(resolve => { ready = resolve; });
    const receiving = drive.receivePart(job.id, 0, input, `bytes 0-${size - 1}/${size}`, null, { onReady: ready });
    input.write(Buffer.alloc(32 * 1024, 1));
    const chunk = await available, reader = chunk.streamFactory(), iterator = reader[Symbol.asyncIterator]();
    const first = await iterator.next();
    input.end(Buffer.alloc(size - first.value.length, 2));
    await receiving;
    assert.equal(chunk.writtenBytes, size); assert.equal(chunk.sourceComplete, true);
    assert.equal(reader.destroyed, false);
    const received = [first.value];
    for (;;) { const next = await iterator.next(); if (next.done) break; received.push(next.value); }
    assert.equal(Buffer.concat(received).length, size);
    assert.equal(Buffer.concat(received).at(-1), 2);
});

test('the growing source cannot EOF until the verified manifest replacement succeeds', async t => {
    const { drive, job } = fixture(t, { size: 3 });
    const rename = fsp.rename;
    let releaseFinal, finalStarted;
    const started = new Promise(resolve => { finalStarted = resolve; });
    const release = new Promise(resolve => { releaseFinal = resolve; });
    t.mock.method(fsp, 'rename', async (...args) => {
        if (job.files[0].chunks[0]?.sourceVerified) { finalStarted(); await release; }
        return rename(...args);
    });
    const input = new PassThrough();
    let reader;
    const receiving = drive.receivePart(job.id, 0, input, 'bytes 0-2/3', null, { onReady: chunk => { reader = chunk.streamFactory(); } });
    input.end('abc'); await started;
    let done = false;
    const consumed = (async () => { const buffers = []; for await (const bytes of reader) buffers.push(bytes); done = true; return Buffer.concat(buffers); })();
    await pause(15);
    assert.equal(job.files[0].chunks[0].writtenBytes, 3); assert.equal(job.files[0].chunks[0].sourceComplete, false); assert.equal(done, false);
    releaseFinal(); await receiving;
    assert.equal((await consumed).toString(), 'abc'); assert.equal(done, true);
});

test('a failed final source manifest wakes and fails waiting readers instead of silently completing the part', async t => {
    const { drive, job } = fixture(t, { size: 3 });
    const rename = fsp.rename;
    t.mock.method(fsp, 'rename', async (...args) => {
        if (job.files[0].chunks[0]?.sourceVerified) throw Object.assign(new Error('manifest write failed'), { code: 'EIO' });
        return rename(...args);
    });
    const input = new PassThrough();
    let consumed;
    const receiving = drive.receivePart(job.id, 0, input, 'bytes 0-2/3', null, { onReady: chunk => {
        consumed = (async () => { for await (const _bytes of chunk.streamFactory()) {} })(); consumed.catch(() => {});
    } });
    input.end('abc');
    await assert.rejects(receiving, error => error.code === 'EIO');
    await assert.rejects(consumed, error => error.code === 'EIO');
    assert.equal(job.files[0].chunks[0].sourceComplete, false);
});

test('browser abort rejects active readers and async cleanup waits until all read and write handles close', async t => {
    const { drive, job } = fixture(t);
    const input = new PassThrough(); let ready;
    const available = new Promise(resolve => { ready = resolve; });
    const receiving = drive.receivePart(job.id, 0, input, 'bytes 0-5/6', null, { onReady: ready }); receiving.catch(() => {});
    input.write('abc');
    const chunk = await available;
    const consumed = (async () => { for await (const _bytes of chunk.streamFactory()) {} })(); consumed.catch(() => {});
    await turn(); await drive.abortAsync(job.id);
    await assert.rejects(receiving, /OPERATION_CANCELLED/);
    await assert.rejects(consumed, /OPERATION_CANCELLED/);
    assert.equal(chunk.readers.size, 0);
    assert.equal(fs.existsSync(job.dir), false);
});

test('aborting one attempt leaves a second reader and the independent browser writer alive', async t => {
    const { drive, job } = fixture(t);
    const input = new PassThrough(); let ready;
    const available = new Promise(resolve => { ready = resolve; });
    const receiving = drive.receivePart(job.id, 0, input, 'bytes 0-5/6', null, { onReady: ready });
    input.write('abc'); const chunk = await available;
    const abort = new AbortController();
    const first = (async () => { for await (const _bytes of chunk.streamFactory(abort.signal)) {} })(); first.catch(() => {});
    const second = (async () => { const buffers = []; for await (const bytes of chunk.streamFactory()) buffers.push(bytes); return Buffer.concat(buffers); })();
    await turn(); abort.abort(); await assert.rejects(first, /OPERATION_CANCELLED/);
    input.end('def'); await receiving;
    assert.equal((await second).toString(), 'abcdef');
});

test('destroying an attempt without a signal wakes its pending iterator and releases the Windows read handle', async t => {
    const { drive, job } = fixture(t);
    const input = new PassThrough(); let ready;
    const available = new Promise(resolve => { ready = resolve; });
    const receiving = drive.receivePart(job.id, 0, input, 'bytes 0-5/6', null, { onReady: ready });
    input.write('abc'); const chunk = await available;
    const stream = chunk.streamFactory();
    const consumed = (async () => { for await (const _bytes of stream) {} })(); consumed.catch(() => {});
    await pause(10);
    stream.destroy(new Error('TELEGRAM_NETWORK_ERROR'));
    await assert.rejects(consumed, /TELEGRAM_NETWORK_ERROR/);
    assert.equal(chunk.readers.size, 0);
    input.end('def'); await receiving;
    assert.equal(chunk.sourceComplete, true);
});

test('temporary Telegram confirmation retains staging and only durable complete final groups allow its deletion', async t => {
    const { drive, job } = await twoChunks(t);
    const chunks = job.files[0].chunks, paths = chunks.map(chunk => chunk.path);
    await drive.markPartsUploaded(job.id, [remote(1, 101), remote(2, 102)]);
    assert.deepEqual(chunks.map(chunk => chunk.status), ['push_confirmed', 'push_confirmed']);
    assert.deepEqual(paths.map(filename => fs.existsSync(filename)), [true, true]);
    assert.equal(drive.uploadResults(job.id)[0], null);
    await drive.markFinalGroupStarted(job.id, 0, 0);
    await drive.markFinalGroupUploaded(job.id, 0, 0, [remote(1, 201), remote(2, 202)]);
    assert.deepEqual(paths.map(filename => fs.existsSync(filename)), [true, true]);
    await drive.markProgressiveFinalized(job.id, 0);
    assert.deepEqual(paths.map(filename => fs.existsSync(filename)), [false, false]);
    assert.deepEqual(drive.uploadResults(job.id)[0].parts.map(part => part.messageId), [201, 202]);
    assert.deepEqual(drive.uploadResults(job.id)[0].pendingRemoteCleanup[0].parts.map(part => part.messageId), [101, 102]);
});

test('a temporary confirmation manifest failure retains every returned Telegram message for recovery', async t => {
    const { drive, job, dataDir } = await twoChunks(t);
    t.mock.method(fsp, 'rename', async () => { throw Object.assign(new Error('manifest failed'), { code: 'EIO' }); });
    await assert.rejects(drive.markPartsUploaded(job.id, [remote(1, 101), remote(2, 102)]), error => error.code === 'EIO');
    assert.deepEqual(job.files[0].chunks.map(chunk => chunk.tempRemote.messageId), [101, 102]);
    assert.ok(job.files[0].chunks.every(chunk => fs.existsSync(chunk.path)));
    t.mock.restoreAll(); await drive.preserveForRecoveryAsync(job.id);
    const replacement = createTelegramDriveStore({ dataDir });
    const recovered = await replacement.activateRecoveredUpload(replacement.recoveredUploads()[0]);
    assert.deepEqual(recovered.files[0].chunks.map(chunk => chunk.status), ['push_confirmed', 'push_confirmed']);
});

test('partial final album persistence failure retains all temporary and final remote associations without deleting bodies', async t => {
    const { drive, job, dataDir } = await twoChunks(t);
    await drive.markPartsUploaded(job.id, [remote(1, 101), remote(2, 102)]);
    t.mock.method(fsp, 'rename', async () => { throw Object.assign(new Error('manifest failed'), { code: 'EIO' }); });
    await assert.rejects(drive.markFinalGroupUploaded(job.id, 0, 0, [remote(1, 201), remote(2, 202)]), error => error.code === 'EIO');
    assert.deepEqual(job.files[0].chunks.map(chunk => [chunk.tempRemote.messageId, chunk.finalRemote.messageId]), [[101, 201], [102, 202]]);
    assert.ok(job.files[0].chunks.every(chunk => fs.existsSync(chunk.path)));
    t.mock.restoreAll(); await drive.preserveForRecoveryAsync(job.id);
    const replacement = createTelegramDriveStore({ dataDir }), recovered = await replacement.activateRecoveredUpload(replacement.recoveredUploads()[0]);
    assert.equal(recovered.files[0].finalized, false);
    assert.deepEqual(recovered.files[0].finalGroups[0].remotes.map(part => part.messageId), [201, 202]);
    await replacement.markProgressiveFinalized(recovered.id, 0);
    assert.deepEqual(replacement.uploadResults(recovered.id)[0].parts.map(part => part.messageId), [201, 202]);
});

test('safe retry clears rejected attempts while confirmed final groups cannot be overwritten or duplicate another group', async t => {
    const { drive, job } = await twoChunks(t);
    await drive.markProgressiveChunkState(job.id, 0, 1, 'pushing', { attempts: 1 });
    await drive.markProgressiveChunkState(job.id, 0, 1, 'retry_wait', { safeRetry: true });
    assert.equal(job.files[0].chunks[0].attemptIntent, null);
    await drive.markPartsUploaded(job.id, [remote(1, 101), remote(2, 102)]);
    await drive.markFinalGroupStarted(job.id, 0, 0); await drive.markFinalGroupState(job.id, 0, 0, 'failed');
    assert.equal(job.files[0].finalGroups[0].intent, null);
    await drive.markFinalGroupStarted(job.id, 0, 0);
    await drive.markFinalGroupUploaded(job.id, 0, 0, [remote(1, 201), remote(2, 202)]);
    await assert.rejects(drive.markFinalGroupUploaded(job.id, 0, 0, [remote(1, 301), remote(2, 302)]), /UPLOAD_FINAL_GROUP_CONFLICT/);
    await assert.rejects(drive.markFinalGroupUploaded(job.id, 0, 1, [remote(1, 301)]), /UPLOAD_FINAL_GROUP_INVALID/);
});

test('manifest keeps bounded push bytes, attempts and sanitized retry errors without Bot URLs or secrets', async t => {
    const { drive, job } = await twoChunks(t);
    const token = '123456:bot-secret';
    const detail = { causeCode: `ECONNRESET https://api.telegram.org/bot${token}/sendDocument`, method: 'sendDocument',
        reason: `bot ${token} https://example.com/private`, elapsedMs: 1000, sentFileBytes: 2,
        authorization: 'Bearer never-store', headers: { cookie: 'never-store' }, body: 'never-store' };
    await drive.markProgressiveChunkState(job.id, 0, 1, 'pushing', { attempts: 2, attemptedAt: 12345 });
    await drive.markProgressiveChunkState(job.id, 0, 1, 'retry_wait', { attempts: 2, retryAt: 99999, safeRetry: true,
        telegramPushedBytes: 10, errorCode: 'TELEGRAM_NETWORK_ERROR', details: detail });
    const saved = manifest(job).files[0].chunks[0];
    assert.equal(saved.attempts, 2); assert.equal(saved.retryAt, 99999); assert.equal(saved.telegramPushedBytes, 3);
    assert.equal(saved.lastError.code, 'TELEGRAM_NETWORK_ERROR');
    assert.equal(saved.lastError.details.method, 'sendDocument'); assert.equal(saved.lastError.details.sentFileBytes, 2);
    assert.ok(saved.updatedAt > 0); assert.equal(saved.attemptIntent, null);
    assert.doesNotMatch(JSON.stringify(saved), /123456|bot-secret|api\.telegram|never-store|example\.com/);
});

test('final group manifests record sanitized attempt intent, retry time and failure diagnostics', async t => {
    const { drive, job } = await twoChunks(t);
    await drive.markPartsUploaded(job.id, [remote(1, 101), remote(2, 102)]);
    await drive.markFinalGroupStarted(job.id, 0, 0, { attempt: 3, startedAt: 12345, partIndexes: [1, 2, -1, 50], secret: 'never-store' });
    let saved = manifest(job).files[0].finalGroups[0];
    assert.deepEqual(saved.intent, { startedAt: 12345, attempt: 3, partIndexes: [1, 2] });
    await drive.markFinalGroupState(job.id, 0, 0, 'retry_wait', { attempt: 3, retryAt: 99999, errorCode: 'TELEGRAM_429',
        details: { requestId: 'request-1', causeCode: '429', reason: 'https://api.telegram.org/bot123456:bot-secret/sendMediaGroup', cookie: 'never-store' } });
    saved = manifest(job).files[0].finalGroups[0];
    assert.equal(saved.attempt, 3); assert.equal(saved.startedAt, 12345); assert.equal(saved.retryAt, 99999);
    assert.equal(saved.errorCode, 'TELEGRAM_429'); assert.equal(saved.lastError.details.requestId, 'request-1');
    assert.equal(saved.intent, null); assert.ok(saved.updatedAt > 0);
    assert.doesNotMatch(JSON.stringify(saved), /123456|bot-secret|api\.telegram|never-store/);
});

test('restart validates complete source hashes and restores clientDone without deleting or re-uploading confirmed chunks', async t => {
    const { drive, job, dataDir } = await twoChunks(t);
    await drive.markPartsUploaded(job.id, [remote(1, 101)]);
    await drive.markClientDone(job.id); await drive.preserveForRecoveryAsync(job.id);
    const replacement = createTelegramDriveStore({ dataDir }), [saved] = replacement.recoveredUploads();
    const restored = await replacement.activateRecoveredUpload(saved);
    assert.equal(restored.clientDone, true);
    assert.equal(restored.finishing, true);
    assert.deepEqual(restored.files[0].chunks.map(chunk => chunk.status), ['push_confirmed', 'queued']);
    assert.ok(restored.files[0].chunks.every(chunk => fs.existsSync(chunk.path)));
    assert.equal((await (async () => { const bytes = []; for await (const buffer of restored.files[0].chunks[1].streamFactory()) bytes.push(buffer); return Buffer.concat(bytes); })()).toString(), 'def');
});

test('restart marks in-flight push and final group intents as uncertain and never silently retries them', async t => {
    const { drive, job, dataDir } = await twoChunks(t);
    await drive.markPartsUploaded(job.id, [remote(1, 101)]);
    await drive.markProgressiveChunkState(job.id, 0, 2, 'pushing', { attempts: 1 });
    await drive.markFinalGroupStarted(job.id, 0, 0);
    await drive.preserveForRecoveryAsync(job.id);
    const replacement = createTelegramDriveStore({ dataDir });
    const restored = await replacement.activateRecoveredUpload(replacement.recoveredUploads()[0]);
    assert.equal(restored.files[0].chunks[1].status, 'push_unknown');
    assert.equal(restored.files[0].chunks[1].unknownResult, true);
    assert.equal(restored.files[0].finalGroups[0].status, 'unknown');
    await assert.rejects(replacement.markFinalGroupStarted(restored.id, 0, 0), /UPLOAD_FINAL_RESULT_UNKNOWN/);
});

test('restart rejects corrupt bodies and incomplete browser data while retaining their recovery files', async t => {
    const { drive, job, dataDir } = await twoChunks(t);
    await drive.preserveForRecoveryAsync(job.id);
    fs.writeFileSync(job.files[0].chunks[1].path, 'xyz');
    const replacement = createTelegramDriveStore({ dataDir }), saved = replacement.recoveredUploads()[0];
    await assert.rejects(replacement.activateRecoveredUpload(saved), /UPLOAD_RECOVERY_SOURCE_INVALID/);
    assert.equal(replacement.upload(job.id), undefined);
    assert.equal(fs.existsSync(job.dir), true);
    saved.files[0].chunks[1].sourceComplete = false;
    await assert.rejects(replacement.activateRecoveredUpload(saved), /UPLOAD_RECOVERY_SOURCE_INCOMPLETE/);
    assert.equal(fs.existsSync(job.dir), true);
});

test('recovery rejects paths outside its staging directory and preserves structured operation scope', async t => {
    const { drive, job, dataDir } = await twoChunks(t);
    await drive.setUploadContextAsync(job.id, { operationScope: { userId: 'viewer', diskSpace: 'scope' }, collaborationId: 'collab', viewerId: 'viewer' });
    await drive.preserveForRecoveryAsync(job.id);
    const replacement = createTelegramDriveStore({ dataDir }), saved = replacement.recoveredUploads()[0];
    assert.deepEqual(saved.operationScope, { userId: 'viewer', diskSpace: 'scope' });
    saved.files[0].chunks[0].path = '..\\private.bin';
    await assert.rejects(replacement.activateRecoveredUpload(saved), /UPLOAD_RECOVERY_MANIFEST_INVALID/);
    assert.equal(fs.existsSync(job.dir), true);
});

test('finalized remote records survive restart even after staging bodies were safely removed', async t => {
    const { drive, job, dataDir } = await twoChunks(t);
    await drive.markPartsUploaded(job.id, [remote(1, 101), remote(2, 102)]);
    await drive.markFinalGroupUploaded(job.id, 0, 0, [remote(1, 201), remote(2, 202)]);
    await drive.markProgressiveFinalized(job.id, 0); await drive.markClientDone(job.id); await drive.preserveForRecoveryAsync(job.id);
    const replacement = createTelegramDriveStore({ dataDir }), restored = await replacement.activateRecoveredUpload(replacement.recoveredUploads()[0]);
    assert.equal(restored.files[0].finalized, true);
    assert.deepEqual(replacement.uploadResults(restored.id)[0].parts.map(part => part.messageId), [201, 202]);
});

test('committing a progressive file persists temporary cleanup in the Content outbox independently of Logical parts', async t => {
    const { drive, job, dataDir } = await twoChunks(t);
    await drive.markPartsUploaded(job.id, [remote(1, 101), remote(2, 102)]);
    await drive.markFinalGroupUploaded(job.id, 0, 0, [remote(1, 201), remote(2, 202)]);
    await drive.markProgressiveFinalized(job.id, 0); await drive.markClientDone(job.id);
    const [file] = drive.commit(job.id, '-10042', drive.uploadResults(job.id));
    assert.deepEqual(file.parts.map(part => part.messageId), [201, 202]);
    assert.deepEqual(file.pendingRemoteCleanup,[]);
    const reloaded = createTelegramDriveStore({ dataDir }).get('owner-1', file.id);
    assert.deepEqual(reloaded.pendingRemoteCleanup,[]);
    const task=openDiskRepository(dataDir).content.claimCleanup();
    assert.equal(task.purpose,'temporary-upload');assert.deepEqual(task.physical.parts.map(part=>part.messageId),[101,102]);
});

test('legacy callers retain full-part staging and confirmation cleanup semantics', async t => {
    const { drive, job } = fixture(t, { size: 3, progressive: false });
    const input = new PassThrough();
    const receiving = drive.receivePart(job.id, 0, input, 'bytes 0-2/3');
    input.write('a'); await turn(); assert.equal(job.files[0].chunks.length, 0);
    input.end('bc'); await receiving;
    const chunk = job.files[0].chunks[0]; assert.equal(chunk.streamFactory, undefined);
    await drive.markPartsUploaded(job.id, [remote(1, 101)]);
    assert.equal(chunk.status, 'uploaded'); assert.equal(fs.existsSync(chunk.path), false);
});
