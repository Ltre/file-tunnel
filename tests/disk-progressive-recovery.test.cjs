'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Readable } = require('node:stream');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskOperations } = require('../server/disk-operations');
const { createDiskAPI } = require('../server/disk-api');
const { openDiskRepository } = require('../server/disk-repository');
const { partitionMediaGroups } = require('../server/disk-telegram');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
    for (let index = 0; index < 300; index++) { const result = predicate(); if (result) return result; await sleep(10); }
    throw new Error('recovery did not settle');
}
function chunkRemote(file, chunk, messageId) {
    return { fileId: `remote-${messageId}`, fileUniqueId: `unique-${messageId}`, messageId, messageDate: Date.now(),
        fileIndex: 0, logicalFileId: file.logicalId, partIndex: chunk.partIndex, partCount: file.parts.length,
        originalSize: file.size, offset: chunk.offset, size: chunk.size, sha256: chunk.sha256 };
}
async function setup(t, prepare, partCount = 2) {
    t.mock.method(console, 'info', () => {});
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'progressive-recovery-'));
    let store = createTelegramDriveStore({ dataDir }), operations = createDiskOperations({ dataDir });
    const auth = createDiskAuth({ dataDir }), user = auth.fromTelegram({ id: '1234' });
    const scope = { userId: user.id, diskSpace: '' }, backend = { token: 'fixture', channelId: '-100', baseUrl: 'https://example.test' };
    const job = store.begin({ owner: user, folderPath: 'A/B', progressive: true,
        files: [{ name: 'two.bin', size: partCount * 3, parts: Array.from({ length: partCount }, (_, index) => ({ byteStart: index * 3, byteEnd: index * 3 + 2, size: 3 })) }], maxDepth: 20, uploadLimit: 1000, channelId: backend.channelId });
    const operation = operations.create(scope, 'upload', '恢复测试', partCount * 3); job.operationId = operation.operation_id;
    await store.setUploadContextAsync(job.id, { operationId: job.operationId, channelId: backend.channelId, operationScope: scope });
    operations.update(job.operationId, { progressive: true, uploadId: job.id, status: 'running', phase: 'telegram-queue' }, true);
    for (let index = 0; index < partCount; index++) await store.receivePart(job.id, 0, Readable.from(['abc']), `bytes ${index * 3}-${index * 3 + 2}/${partCount * 3}`);
    await store.markClientDone(job.id);
    await prepare({ store, operations, job, user, scope, backend, dataDir });
    operations.flush();
    // Construct a fresh process view from durable state only; no old runners
    // remain alive and no network action is allowed before the manifest check.
    store = createTelegramDriveStore({ dataDir }); operations = createDiskOperations({ dataDir });
    let pushed = 0, finalized = 0, cleaned = 0;
    const telegram = {
        async pushChunk(_storage, file, part, update, context) {
            pushed++;
            await context.onState('pushing', { attempt: 1 });
            let bytes = 0; for await (const buffer of part.streamFactory(context.signal)) { bytes += buffer.length; update({ telegramPartBytesSent: bytes }); }
            const remote = { ...part, streamFactory: undefined, awaitSourceComplete: undefined,
                fileId: 'restored-' + part.partIndex, fileUniqueId: 'u', messageId: 100 + part.partIndex, messageDate: Date.now() };
            await context.onConfirmed(remote); await context.onState('push_confirmed'); return remote;
        },
        async finalizeGroups(_storage, file, parts, context) {
            const final = [];
            for (const [index, group] of partitionMediaGroups(parts).entries()) {
                const saved = context.groups.find(item => item.groupIndex === index && item.parts?.length);
                if (saved) { final.push(...saved.parts); continue; }
                finalized++; await context.onGroupStarted(index);
                const remotes = group.map(part => ({ ...part, fileId: `final-${part.partIndex}`, messageId: 200 + part.partIndex }));
                await context.onGroupConfirmed(remotes, index); final.push(...remotes);
            }
            return final;
        },
        async remove() { cleaned++; }
    };
    const api = createDiskAPI({ dataDir, defaultStore: store, auth, operations, telegram, getDefaultBackend: () => backend,
        getIdentity: () => user, setIdentity() {}, getOrigin: () => 'http://localhost', isMockRequest: () => false, maxDepth: () => 20 });
    const result = () => operations.get(job.operationId, scope);
    t.after(async () => {
        api.close(); await store.upload(job.id)?.pipelineDone;
        operations.flush(); openDiskRepository(dataDir).close(); fs.rmSync(dataDir, { recursive: true, force: true });
    });
    return { job, dataDir, store, operations, user, scope, telegram, result, counts: () => ({ pushed, finalized, cleaned }) };
}

test('重启恢复完整落盘未请求分片，自动继续并仅整批提交一次', async t => {
    const f = await setup(t, async () => {});
    const result = await until(() => f.result().status === 'completed' && f.result());
    assert.equal(f.counts().pushed, 2); assert.equal(f.counts().finalized, 1);
    assert.equal(result.result.items.length, 1); assert.equal(f.store.adminFiles().length, 1);
    assert.deepEqual(f.store.adminFiles()[0].parts.map(part => part.messageId), [201, 202]);
});

test('已确认临时消息重启无需重发正文，只组装剩余最终媒体组', async t => {
    const f = await setup(t, async ({ store, job }) => {
        const file = job.files[0]; await store.markPartsUploaded(job.id, file.chunks.map(chunk => chunkRemote(file, chunk, chunk.partIndex + 10)));
    });
    const result = await until(() => f.result().status === 'completed' && f.result());
    assert.equal(f.counts().pushed, 0); assert.equal(f.counts().finalized, 1);
    assert.equal(result.result.items[0].partCount, 2);
});

test('最终媒体组已持久但正文已删除：重启仅补SQL提交，不发送任何消息', async t => {
    const f = await setup(t, async ({ store, job }) => {
        const file = job.files[0]; await store.markPartsUploaded(job.id, file.chunks.map(chunk => chunkRemote(file, chunk, chunk.partIndex + 10)));
        await store.markFinalGroupUploaded(job.id, 0, 0, file.chunks.map(chunk => ({ ...chunk.tempRemote, messageId: chunk.partIndex + 20, fileId: `final-${chunk.partIndex}` })));
        await store.markProgressiveFinalized(job.id, 0);
    });
    await until(() => f.result().status === 'completed'); assert.equal(f.counts().pushed, 0); assert.equal(f.counts().finalized, 0);
    assert.deepEqual(f.store.adminFiles()[0].parts.map(part => part.messageId), [21, 22]);
});

test('前10片最终组已提交：重启只提交剩余2片组，复用全部正文', async t => {
    const f = await setup(t, async ({ store, job }) => {
        const file = job.files[0]; await store.markPartsUploaded(job.id, file.chunks.map(chunk => chunkRemote(file, chunk, chunk.partIndex + 10)));
        await store.markFinalGroupUploaded(job.id, 0, 0, file.chunks.slice(0, 10).map(chunk => ({ ...chunk.tempRemote, messageId: chunk.partIndex + 20, fileId: `final-${chunk.partIndex}` })));
    }, 12);
    await until(() => f.result().status === 'completed'); assert.equal(f.counts().pushed, 0); assert.equal(f.counts().finalized, 1);
    assert.deepEqual(f.store.adminFiles()[0].parts.map(part => part.messageId), [...Array.from({ length: 10 }, (_, index) => index + 21), 211, 212]);
});

test('SQL已提交但任务未完成时崩溃：残留旧manifest只补任务完成，不重复提交', async t => {
    const f = await setup(t, async ({ store, job, dataDir }) => {
        const file = job.files[0]; await store.markPartsUploaded(job.id, file.chunks.map(chunk => chunkRemote(file, chunk, chunk.partIndex + 10)));
        await store.markFinalGroupUploaded(job.id, 0, 0, file.chunks.map(chunk => ({ ...chunk.tempRemote, messageId: chunk.partIndex + 20, fileId: `final-${chunk.partIndex}` })));
        await store.markProgressiveFinalized(job.id, 0);
        const filename = path.join(job.dir, 'upload-manifest.json'), manifest = fs.readFileSync(filename);
        store.commit(job.id, job.channelId, store.uploadResults(job.id));
        fs.mkdirSync(job.dir, { recursive: true }); fs.writeFileSync(filename, manifest);
    });
    const result = await until(() => f.result().status === 'completed' && f.result());
    assert.equal(f.counts().pushed, 0); assert.equal(f.counts().finalized, 0); assert.equal(result.result.items[0].id, f.job.files[0].logicalId);
    assert.equal(f.store.adminFiles().length, 1);
});

for (const kind of ['push', 'final']) test(`重启时${kind}结果未知：保留完整正文和清单，禁止自动重发/清除`, async t => {
    const f = await setup(t, async ({ store, job }) => {
        if (kind === 'push') await store.markProgressiveChunkState(job.id, 0, 1, 'awaiting_response', { attempts: 1 });
        else {
            const file = job.files[0]; await store.markPartsUploaded(job.id, file.chunks.map(chunk => chunkRemote(file, chunk, chunk.partIndex + 10)));
            await store.markFinalGroupStarted(job.id, 0, 0);
        }
    });
    const result = await until(() => f.result().status === 'failed' && f.result());
    assert.equal(result.errorCode, 'TELEGRAM_UPLOAD_OUTCOME_UNKNOWN'); assert.deepEqual(f.counts(), { pushed: 0, finalized: 0, cleaned: 0 });
    const manifest = path.join(f.dataDir, 'telegram-drive-staging', f.job.id, 'upload-manifest.json');
    assert.ok(fs.existsSync(manifest)); assert.equal(f.store.adminFiles().length, 0);
});

test('普通任务重启仍失败，渐进上传恢复不是通用任务复活', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'progressive-operation-'));
    t.after(() => { openDiskRepository(dataDir).close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    const scope = { userId: 'u' }, first = createDiskOperations({ dataDir });
    const legacy = first.create(scope, 'upload', '旧API'), moving = first.create(scope, 'move', '移动'), progressive = first.create(scope, 'upload', '渐进');
    first.update(progressive.operation_id, { progressive: true }, true); first.flush();
    const next = createDiskOperations({ dataDir });
    assert.equal(next.get(legacy.operation_id, scope).errorCode, 'SERVER_RESTARTED');
    assert.equal(next.get(moving.operation_id, scope).errorCode, 'SERVER_RESTARTED');
    assert.equal(next.get(progressive.operation_id, scope).phase, 'recovering');
    assert.equal(next.resumeUpload(progressive.operation_id, { userId: 'other' }), false); next.flush();
});
