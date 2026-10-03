'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Readable, Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { writeJsonAsync } = require('../server/disk-data');
const { createTelegramDriveStore } = require('../server/telegram-drive');

const temporary = t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-upload-staging-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
};
const filesystemError = code => Object.assign(new Error(code + ': manifest replacement failed'), { code });
const manifestPath = job => path.join(job.dir, 'upload-manifest.json');
const manifest = job => JSON.parse(fs.readFileSync(manifestPath(job), 'utf8'));
async function twoPartJob(t) {
    const dataDir = temporary(t), drive = createTelegramDriveStore({ dataDir });
    const job = drive.begin({ owner: { id: 'user-1' }, folderPath: '', files: [{ name: 'a.bin', size: 3 }, { name: 'b.bin', size: 3 }], maxDepth: 20, channelId: '-100' });
    await drive.receivePart(job.id, 0, Readable.from(['abc']), 'bytes 0-2/3');
    await drive.receivePart(job.id, 1, Readable.from(['def']), 'bytes 0-2/3');
    for (let index = 0; index < 2; index++) drive.markPartUploading(job.id, index, 1);
    const remotes = [0, 1].map(fileIndex => ({ fileIndex, partIndex: 1, partCount: 1, offset: 0, size: 3, fileId: 'file-' + fileIndex, messageId: 101 + fileIndex }));
    return { dataDir, drive, job, remotes };
}

test('manifest replacement retries Windows sharing errors asynchronously and retains the previous file', async t => {
    const dir = temporary(t), target = path.join(dir, 'manifest.json');
    fs.writeFileSync(target, JSON.stringify({ revision: 1 }));
    const rename = fsp.rename;
    let attempts = 0, eventLoopAdvanced = false;
    t.mock.method(fsp, 'rename', async (...args) => {
        attempts++;
        if (attempts <= 2) {
            assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { revision: 1 });
            throw filesystemError(attempts === 1 ? 'EPERM' : 'EBUSY');
        }
        assert.equal(eventLoopAdvanced, true);
        return rename(...args);
    });
    const writing = writeJsonAsync(target, { revision: 2 });
    await new Promise(resolve => setImmediate(() => { eventLoopAdvanced = true; resolve(); }));
    await writing;
    assert.equal(attempts, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { revision: 2 });
    assert.deepEqual(fs.readdirSync(dir), ['manifest.json']);
});

test('Windows read handles that deny deletion only delay atomic manifest replacement', { skip: process.platform !== 'win32' }, async t => {
    const dir = temporary(t), target = path.join(dir, 'manifest.json');
    fs.writeFileSync(target, JSON.stringify({ revision: 1 }));
    const literal = target.replace(/'/g, "''");
    const script = `$manifestHandle = [System.IO.File]::Open('${literal}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); try { [Console]::WriteLine('locked'); [System.Threading.Thread]::Sleep(200) } finally { $manifestHandle.Dispose() }`;
    const locker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    t.after(() => { if (locker.exitCode === null) locker.kill(); });
    const exited = once(locker, 'exit');
    const [output] = await once(locker.stdout, 'data');
    assert.match(output.toString(), /locked/);
    await assert.rejects(fsp.rename(target, path.join(dir, 'blocked.json')), error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code));
    await writeJsonAsync(target, { revision: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { revision: 2 });
    const [code] = await exited;
    assert.equal(code, 0);
});

test('every Telegram message in an album is bound before a failed manifest save and remains recoverable', async t => {
    const { dataDir, drive, job, remotes } = await twoPartJob(t);
    const paths = job.files.map(file => file.chunks[0].path);
    let attempts = 0;
    t.mock.method(fsp, 'rename', async () => { attempts++; throw filesystemError('EIO'); });
    await assert.rejects(drive.markPartsUploaded(job.id, remotes), error => error.code === 'EIO' && error.details.stage === 'upload-manifest-write');
    assert.equal(attempts, 1, 'unknown filesystem failures must not be retried');
    assert.deepEqual(job.files.map(file => file.chunks[0].remote.messageId), [101, 102]);
    assert.deepEqual(paths.map(filename => fs.existsSync(filename)), [true, true]);
    assert.equal(fs.readdirSync(job.dir).some(filename => filename.endsWith('.tmp')), false);
    t.mock.restoreAll();
    await drive.preserveForRecoveryAsync(job.id);
    const [recovered] = createTelegramDriveStore({ dataDir }).recoveredUploads();
    assert.deepEqual(recovered.files.map(file => file.chunks[0].remote.messageId), [101, 102]);
});

test('partial transport rollback messages survive persistence failure without being counted as uploaded chunks', async t => {
    const { dataDir, drive, job } = await twoPartJob(t);
    const parts = [201, 202].map(messageId => ({ messageId, fileIndex: 0, partIndex: 1, partCount: 1, fileId: 'rollback-' + messageId, size: 3 }));
    t.mock.method(fsp, 'rename', async () => { throw filesystemError('EIO'); });
    await assert.rejects(drive.keepUploadRollbackParts(job.id, parts), error => error.code === 'EIO' && error.details.stage === 'upload-manifest-write');
    assert.deepEqual(job.pendingRollbackParts.map(remote => remote.messageId), [201, 202]);
    assert.equal(drive.uploadQueue(job.id).uploadedParts, 0);
    assert.deepEqual(drive.uploadResults(job.id), [null, null]);
    assert.ok(job.files.every(file => file.chunks[0].remote === null));
    t.mock.restoreAll();
    await drive.keepUploadRollbackParts(job.id, [{ ...parts[0], fileId: 'updated-rollback-201' }, { messageId: 0 }, { messageId: -1 }, { messageId: 1.2 }, { messageId: Infinity }]);
    assert.deepEqual(job.pendingRollbackParts.map(remote => remote.messageId), [201, 202]);
    assert.equal(job.pendingRollbackParts[0].fileId, 'updated-rollback-201');
    assert.throws(() => drive.commit(job.id, '-100', [{ fileId: 'a', messageId: 301 }, { fileId: 'b', messageId: 302 }]), /UPLOAD_ROLLBACK_PENDING/);
    await drive.preserveForRecoveryAsync(job.id);
    const [recovered] = createTelegramDriveStore({ dataDir }).recoveredUploads();
    assert.deepEqual(recovered.pendingRollbackParts.map(remote => remote.messageId), [201, 202]);
    assert.deepEqual(recovered.pendingRollbackParts.map(remote => remote.partIndex), [1, 1]);
    assert.equal(recovered.pendingRollbackParts[0].fileId, 'updated-rollback-201');
});

test('confirmed album retries transient EPERM and deletes staging parts only after the whole manifest is saved', async t => {
    const { drive, job, remotes } = await twoPartJob(t);
    const paths = job.files.map(file => file.chunks[0].path);
    const rename = fsp.rename;
    let attempts = 0;
    t.mock.method(fsp, 'rename', async (...args) => {
        attempts++;
        assert.deepEqual(paths.map(filename => fs.existsSync(filename)), [true, true]);
        assert.deepEqual(job.files.map(file => file.chunks[0].remote.messageId), [101, 102]);
        if (attempts === 1) throw filesystemError('EPERM');
        return rename(...args);
    });
    await drive.markPartsUploaded(job.id, remotes);
    assert.equal(attempts, 2);
    assert.deepEqual(manifest(job).files.map(file => file.chunks[0].remote.messageId), [101, 102]);
    assert.deepEqual(paths.map(filename => fs.existsSync(filename)), [false, false]);
});

test('overlapping context and Telegram confirmation writes cannot overwrite newer remote associations', async t => {
    const { drive, job, remotes } = await twoPartJob(t);
    const rename = fsp.rename;
    let releaseFirst, firstStarted;
    const firstReady = new Promise(resolve => { firstStarted = resolve; });
    const firstReleased = new Promise(resolve => { releaseFirst = resolve; });
    let calls = 0;
    t.mock.method(fsp, 'rename', async (...args) => {
        if (++calls === 1) { firstStarted(); await firstReleased; }
        return rename(...args);
    });
    const contextWrite = drive.setUploadContextAsync(job.id, { operationId: 'operation-1' });
    await firstReady;
    const confirmationWrite = drive.markPartsUploaded(job.id, remotes);
    releaseFirst();
    await Promise.all([contextWrite, confirmationWrite]);
    assert.equal(manifest(job).operationId, 'operation-1');
    assert.deepEqual(manifest(job).files.map(file => file.chunks[0].remote.messageId), [101, 102]);
});

test('only a filesystem output error receives the browser staging write diagnostic stage', async t => {
    const drive = createTelegramDriveStore({ dataDir: temporary(t) });
    const job = drive.begin({ owner: { id: 'user-1' }, folderPath: '', files: [{ name: 'a.bin', size: 3 }], maxDepth: 20 });
    t.mock.method(fs, 'createWriteStream', () => new Writable({ write(_bytes, _encoding, callback) { callback(Object.assign(filesystemError('EIO'), { syscall: 'write' })); } }));
    await assert.rejects(drive.receivePart(job.id, 0, Readable.from(['abc']), 'bytes 0-2/3'), error => error.code === 'EIO' && error.details.stage === 'browser-part-write' && error.details.syscall === 'write');
});

test('a thumbnail with a pending or failed receiving manifest cannot enter the Telegram upload queue', async t => {
    const drive = createTelegramDriveStore({ dataDir: temporary(t) });
    const job = drive.begin({ owner: { id: 'user-1' }, folderPath: '', files: [{ name: 'clip.mp4', size: 3 }], maxDepth: 20 });
    await drive.receivePart(job.id, 0, Readable.from(['abc']), 'bytes 0-2/3');
    drive.markPartUploading(job.id, 0, 1);
    await drive.markPartsUploaded(job.id, [{ fileIndex: 0, partIndex: 1, partCount: 1, offset: 0, size: 3, fileId: 'video', messageId: 101 }]);
    let manifestStarted, failManifest;
    const started = new Promise(resolve => { manifestStarted = resolve; });
    const failed = new Promise(resolve => { failManifest = resolve; });
    t.mock.method(fsp, 'rename', async () => { manifestStarted(); await failed; throw filesystemError('EIO'); });
    const receiving = drive.receiveThumbnail(job.id, 0, Readable.from(['jpg']), 3, 'image/jpeg');
    const rejected = assert.rejects(receiving, error => error.code === 'EIO' && error.details.stage === 'upload-manifest-write');
    await started;
    assert.equal(job.files[0].thumbnail.status, 'receiving');
    assert.equal(job.files[0].thumbnail.receiving, true);
    assert.throws(() => drive.markThumbnailUploading(job.id, 0), /UPLOAD_THUMBNAIL_STATE_INVALID/);
    failManifest();
    await rejected;
    assert.equal(job.files[0].thumbnail, null);
    assert.throws(() => drive.markThumbnailUploading(job.id, 0), /UPLOAD_THUMBNAIL_STATE_INVALID/);
});

test('concurrent abort and preserve requests share cleanup and cannot rewrite a removed manifest', async t => {
    const drive = createTelegramDriveStore({ dataDir: temporary(t) });
    const job = drive.begin({ owner: { id: 'user-1' }, folderPath: '', files: [{ name: 'a.bin', size: 3 }], maxDepth: 20 });
    const remove = fsp.rm;
    let calls = 0, removeStarted, releaseRemoval;
    const started = new Promise(resolve => { removeStarted = resolve; });
    const released = new Promise(resolve => { releaseRemoval = resolve; });
    t.mock.method(fsp, 'rm', async (...args) => { calls++; removeStarted(); await released; return remove(...args); });
    const firstAbort = drive.abortAsync(job.id);
    await started;
    const secondAbort = drive.abortAsync(job.id);
    const preserve = drive.preserveForRecoveryAsync(job.id);
    releaseRemoval();
    await Promise.all([firstAbort, secondAbort]);
    assert.equal(await preserve, null);
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(job.dir), false);
});

for (const mode of ['file', 'part', 'thumbnail']) {
    test('abort waits for the active ' + mode + ' stream and cannot recreate a deleted staging directory', async t => {
        const drive = createTelegramDriveStore({ dataDir: temporary(t) });
        const job = drive.begin({ owner: { id: 'user-1' }, folderPath: '', files: [{ name: 'a.bin', size: 3 }], maxDepth: 20 });
        const input = new PassThrough();
        const receiving = mode === 'file' ? drive.receive(job.id, 0, input)
            : mode === 'part' ? drive.receivePart(job.id, 0, input, 'bytes 0-2/3')
                : drive.receiveThumbnail(job.id, 0, input, 3, 'image/jpeg');
        const rejected = assert.rejects(receiving, error => error.message === 'OPERATION_CANCELLED' && !error.details?.stage);
        input.write('a');
        await drive.abortAsync(job.id);
        await rejected;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(drive.upload(job.id), undefined);
        assert.equal(fs.existsSync(job.dir), false);
    });
}


test('分片接收尚未结束时即暴露已落盘字节，增长 reader 等待后续数据而不提前 EOF', async t => {
    const drive = createTelegramDriveStore({ dataDir: temporary(t) });
    const job = drive.begin({ owner: { id:'user-1' }, folderPath:'', files:[{ name:'progressive.bin', size:6 }], maxDepth:20 });
    const input = new PassThrough();
    const receiving = drive.receivePart(job.id, 0, input, 'bytes 0-5/6');
    input.write('abc');
    await new Promise(resolve => setImmediate(resolve));

    const chunk = job.files[0].chunks[0];
    assert.ok(chunk, '第一个 PUT 尚未结束时就必须建立 chunk');
    assert.equal(chunk.status, 'receiving');
    assert.equal(chunk.writtenBytes, 3);
    assert.equal(chunk.sourceComplete, false);
    assert.equal(drive.uploadQueue(job.id).receivedParts, 0);
    assert.equal(drive.uploadQueue(job.id).pendingBytes, 3);

    const source = chunk.streamFactory();
    const iterator = source[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.toString(), 'abc');

    let secondSettled = false;
    const second = iterator.next().then(value => { secondSettled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(secondSettled, false, 'reader 追上 writtenBytes 后必须等待，不得把增长中的文件当 EOF');

    input.end('def');
    assert.equal((await second).value.toString(), 'def');
    assert.equal((await iterator.next()).done, true);
    await receiving;

    assert.equal(chunk.sourceComplete, true);
    assert.equal(chunk.writtenBytes, 6);
    assert.match(chunk.sha256, /^[a-f0-9]{64}$/);
    assert.equal(drive.uploadQueue(job.id).receivedParts, 1);
    assert.equal(drive.uploadQueue(job.id).pendingBytes, 6);
});
