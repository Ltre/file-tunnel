'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Readable } = require('node:stream');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { createDiskShares } = require('../server/disk-shares');
const { createDiskTelegram, diskCaption, MAX_TELEGRAM_PART_SIZE } = require('../server/disk-telegram');
const { resolvePasskeyBrowserAsset } = require('../server/browser-assets');
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sharing-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
test('公开分享仅包含选中内容快照，隔离用户/分区，撤销和重启后保持失效', async t => {
    const dataDir = temp(t), store = createTelegramDriveStore({ dataDir }), scope = { userId: 'alice', diskSpace: '' };
    const shares = createDiskShares({ dataDir });
    async function upload(name, folderPath = '音乐/专辑', owner = 'alice') {
        const job = store.begin({ owner: { id: owner }, folderPath, files: [{ name, size: 3, type: 'text/plain' }], maxDepth: 20 });
        await store.receive(job.id, 0, Readable.from(['abc'])); return store.commit(job.id, '-10', [{ fileId: 'secret-remote-id', messageId: 1 }])[0];
    }
    const a = await upload('a.txt'), b = await upload('b.txt');
    const dir = shares.create(scope, store, [{ kind: 'directory', path: '音乐' }]);
    const token = dir.url.split('/').pop();
    const later = await upload('later.txt'), other = await upload('private.txt', '', 'bob');
    const share = shares.resolve(token);
    const contents = shares.contents(share, store, '音乐/专辑');
    assert.deepEqual(contents.files.map(f => f.id), [a.id, b.id]);
    assert.equal(contents.files[0].fileId, undefined);
    assert.throws(() => shares.file(share, store, later.id), /FILE_NOT_FOUND/);
    assert.throws(() => shares.file(share, store, other.id), /FILE_NOT_FOUND/);
    assert.throws(() => shares.contents(share, store, '../private'), /NAME_INVALID/);
    assert.throws(() => shares.stop({ userId: 'bob', diskSpace: '' }, dir.id), /SHARE_NOT_FOUND/);
    assert.equal(shares.list({ ...scope, diskSpace: 'other' }).length, 0);
    const files = shares.create(scope, store, [{ id: a.id }, { id: b.id }, { id: a.id }]);
    assert.equal(files.fileCount, 2);
    store.moveDirectory('alice', '音乐', '', 20, '私藏');
    assert.equal(shares.contents(share, store, '音乐/专辑').files.length, 2);
    store.remove('alice', a.id); assert.equal(shares.contents(share, store, '音乐/专辑').files.length, 1);
    assert.throws(() => shares.file(share, store, a.id), /FILE_NOT_FOUND/);
    shares.stop(scope, dir.id); assert.throws(() => createDiskShares({ dataDir }).resolve(token), /SHARE_NOT_FOUND/);
});

test('发布目录 Passkey 路由优先使用已打包脚本，不依赖浏览器 npm 包', t => {
    const root = temp(t); fs.mkdirSync(path.join(root, 'assets'));
    const filename = path.join(root, 'assets', 'simplewebauthn.0123456789.min.js'); fs.writeFileSync(filename, 'var SimpleWebAuthnBrowser = {};');
    fs.writeFileSync(path.join(root, 'build-manifest.json'), JSON.stringify({ scripts: { 'client/simplewebauthn.js': '/assets/simplewebauthn.0123456789.min.js' } }));
    assert.equal(resolvePasskeyBrowserAsset(root, () => { throw new Error('MODULE_NOT_FOUND'); }), filename);
    fs.writeFileSync(path.join(root, 'build-manifest.json'), JSON.stringify({ scripts: { 'client/simplewebauthn.js': '/assets/../../secret.js' } }));
    assert.equal(resolvePasskeyBrowserAsset(root, () => { throw new Error('MODULE_NOT_FOUND'); }), null);
});

test('Telegram 定位备注失败不丢失已上传结果，长路径符合 caption 长度上限', async t => {
    const root = temp(t), filename = path.join(root, 'a.txt'); fs.writeFileSync(filename, 'abc');
    const backend = { token: 'secret', channelId: '-1001', baseUrl: 'https://api.telegram.org' };
    const file = { path: filename, name: '文件.txt', folderPath: '目录/'.repeat(300), size: 3 };
    const caption = diskCaption(file, backend, { userId: 'user-uuid', diskSpace: 'music' }, { fileId: 'file-id', messageId: 123, mediaGroupId: 'album-id' });
    assert.ok(caption.length <= 1024); assert.match(caption, /user_id: user-uuid/); assert.match(caption, /album_id: album-id/);
    const telegram = createDiskTelegram({ fetchImpl: async (url, options) => {
        if (url.endsWith('/editMessageCaption')) throw new Error('offline');
        const chunks = []; for await (const chunk of options.body) chunks.push(chunk);
        assert.match(Buffer.concat(chunks).toString(), /user_id: user-uuid/);
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 1, document: { file_id: 'saved-file' } } }) };
    } });
    const result = await telegram.upload(backend, [file], () => {}, [], { userId: 'user-uuid' });
    assert.equal(result[0].fileId, 'saved-file'); assert.equal(result[0].captionWarning, 'TELEGRAM_CAPTION_UPDATE_FAILED');
});

test('超过 20 MiB 的逻辑文件按分片 album 上传、统一索引、顺序合并读取并批量删除', async t => {
    const root = temp(t), filename = path.join(root, 'large.bin');
    const original = Buffer.alloc(MAX_TELEGRAM_PART_SIZE + 37, 0x5a); original.fill(0x2b, MAX_TELEGRAM_PART_SIZE);
    fs.writeFileSync(filename, original);
    const backend = { token: 'secret', channelId: '-1001', baseUrl: 'https://api.telegram.org' };
    const partBuffers = [original.subarray(0, MAX_TELEGRAM_PART_SIZE), original.subarray(MAX_TELEGRAM_PART_SIZE)];
    let uploadMethods = [], deleted = [];
    const telegram = createDiskTelegram({ fetchImpl: async (url, options = {}) => {
        const method = url.split('/').at(-1);
        if (method === 'sendMediaGroup' || method === 'sendDocument') {
            uploadMethods.push(method); const chunks = []; for await (const chunk of options.body) chunks.push(chunk);
            const count = (Buffer.concat(chunks).toString('latin1').match(/filename="/g) || []).length;
            const messages = Array.from({ length: count }, (_, index) => ({ message_id: 100 + index, media_group_id: 'album-large', document: { file_id: 'part-' + index, file_unique_id: 'unique-' + index } }));
            return { ok: true, json: async () => ({ ok: true, result: count === 1 ? messages[0] : messages }) };
        }
        if (method === 'editMessageCaption') return { ok: true, json: async () => ({ ok: true, result: true }) };
        if (method === 'getFile') {
            const index = Number(JSON.parse(options.body).file_id.split('-').at(-1));
            return { ok: true, json: async () => ({ ok: true, result: { file_path: 'parts/' + index } }) };
        }
        if (method === 'deleteMessages') { deleted = JSON.parse(options.body).message_ids; return { ok: true, json: async () => ({ ok: true, result: true }) }; }
        if (url.includes('/file/bot')) {
            const index = Number(url.split('/').at(-1)); return new Response(partBuffers[index]);
        }
        throw new Error('unexpected telegram request: ' + url);
    } });
    const completed = await telegram.upload(backend, [{ logicalId: 'logical-large', path: filename, name: 'large.bin', folderPath: '备份', type: 'application/octet-stream', size: original.length }], () => {}, [], { userId: 'user-1' });
    assert.equal(completed.length, 1); assert.equal(completed[0].parts.length, 2); assert.equal(completed[0].partCount, 2);
    assert.deepEqual(uploadMethods, ['sendMediaGroup']); assert.deepEqual(completed[0].parts.map(item => item.partIndex), [1, 2]);
    const output = []; for await (const chunk of await telegram.read(backend, completed[0])) output.push(chunk);
    assert.deepEqual(Buffer.concat(output), original);
    await telegram.check(backend, completed[0]);
    await telegram.remove(backend, { ...completed[0], channelId: backend.channelId });
    assert.deepEqual(deleted, [100, 101]);
});

test('逻辑文件删除对已经丢失的 Telegram 分片幂等，并继续清理其余分片', async () => {
    const singles = [];
    const telegram = createDiskTelegram({ fetchImpl: async (url, options = {}) => {
        const method = url.split('/').at(-1), payload = JSON.parse(options.body);
        if (method === 'deleteMessages') return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: message to delete not found' }) };
        if (method === 'deleteMessage') {
            singles.push(payload.message_id);
            if (payload.message_id === 10) return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: message to delete not found' }) };
            return { ok: true, json: async () => ({ ok: true, result: true }) };
        }
        throw new Error('unexpected telegram request');
    } });
    await telegram.remove({ token: 'secret', baseUrl: 'https://api.telegram.org' }, { channelId: '-1001', parts: [{ messageId: 10, partIndex: 1 }, { messageId: 11, partIndex: 2 }] });
    assert.deepEqual(singles, [10, 11]);
});
