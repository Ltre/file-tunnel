'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const { Readable } = require('node:stream');
const { createDiskTelegram } = require('../server/disk-telegram');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { createDiskAuth } = require('../server/disk-auth');
const { MAX_TELEGRAM_PART_SIZE, MAX_TELEGRAM_BATCH_SIZE } = require('../server/disk-limits');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-storage-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const backend = { token: '123:test-secret', channelId: '-1001', baseUrl: 'https://api.telegram.org' };
const ok = result => ({ ok: true, json: async () => ({ ok: true, result }) });
const fail = (description, status = 400) => ({ ok: false, status, json: async () => ({ ok: false, error_code: status, description }) });

test('110 MB 客户端分片直接暂存，Telegram 每批不超过 40 MB；重启索引后合并校验全部字节', async t => {
    const dataDir = temp(t), store = createTelegramDriveStore({ dataDir });
    const size = 115384320, owner = { id: 'user' }, hashes = [], originals = [];
    const job = store.begin({ owner, folderPath: '', files: [{ name: 'large.msi', size }], maxDepth: 20 });
    for (let offset = 0; offset < size; offset += MAX_TELEGRAM_PART_SIZE) {
        const end = Math.min(size, offset + MAX_TELEGRAM_PART_SIZE);
        const bytes = Buffer.alloc(end - offset, originals.length + 1);
        originals.push(bytes); hashes.push(crypto.createHash('sha256').update(bytes).digest('hex'));
        await store.receivePart(job.id, 0, Readable.from([bytes]), `bytes ${offset}-${end - 1}/${size}`);
        if (end !== size) assert.throws(() => store.finish(job.id), /incomplete/);
    }
    assert.equal(job.files[0].path, ''); assert.equal(job.files[0].chunks.length, 6);
    const uploaded = [], captions = [], progress = [];
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, options = {}) => {
        const method = url.split('/').at(-1);
        if (/^send/.test(method)) {
            const chunks = []; for await (const chunk of options.body) chunks.push(chunk);
            const body = Buffer.concat(chunks);
            assert.equal(body.length, Number(options.headers['Content-Length']));
            assert.ok(body.length < MAX_TELEGRAM_BATCH_SIZE + 20000);
            const boundary = options.headers['Content-Type'].split('boundary=')[1];
            const parts = body.toString('latin1').split('--' + boundary).filter(part => part.includes('filename="'));
            const result = parts.map(part => {
                const bytes = Buffer.from(part.slice(part.indexOf('\r\n\r\n') + 4, -2), 'latin1');
                assert.ok(bytes.length <= MAX_TELEGRAM_PART_SIZE);
                assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), hashes[uploaded.length]);
                const id = uploaded.length; uploaded.push(bytes.length);
                return { message_id: id + 1, media_group_id: 'album-' + Math.floor(id / 2), date: 1788658300, document: { file_id: String(id), file_unique_id: 'u' + id } };
            });
            assert.ok(result.length >= 2 && result.length <= 10);
            return ok(result);
        }
        if (method === 'editMessageCaption') { captions.push(JSON.parse(options.body)); return ok(true); }
        if (method === 'getFile') return ok({ file_path: JSON.parse(options.body).file_id });
        if (url.includes('/file/bot')) return new Response(originals[Number(method)]);
        throw new Error('unexpected method');
    } });
    const sent = await telegram.upload(backend, store.finish(job.id).files, patch => progress.push(patch), [], { userId: owner.id });
    assert.equal(sent.length, 1); assert.equal(sent[0].parts.length, 6);
    assert.equal(captions.length, 6); assert.ok(progress.every(p => p.totalBytes === size && p.processedBytes <= size));
    const [file] = store.commit(job.id, backend.channelId, sent);
    const reloaded = createTelegramDriveStore({ dataDir }).get(owner.id, file.id);
    assert.equal(reloaded.parts.length, 6);
    assert.ok(reloaded.parts.every((part, index) => part.logicalFileId === file.id && part.originalSize === size && part.partIndex === index + 1 && part.partCount === 6));
    const hash = crypto.createHash('sha256');
    for await (const bytes of await telegram.read(backend, reloaded)) hash.update(bytes);
    const expected = crypto.createHash('sha256'); originals.forEach(bytes => expected.update(bytes));
    assert.equal(hash.digest('hex'), expected.digest('hex'));
    await assert.rejects(telegram.read(backend, { ...reloaded, parts: reloaded.parts.slice(1) }), /PARTS_INVALID/);
});

test('视频自动识别返回 video/animation 时保留 file_id；新文档禁用内容识别', async t => {
    const dataDir = temp(t), filename = path.join(dataDir, 'movie.mp4'); fs.writeFileSync(filename, 'video');
    for (const mediaType of ['video', 'animation', 'audio', 'document']) {
        const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, init) => {
            if (url.endsWith('/editMessageCaption')) return ok(true);
            const bytes = []; for await (const chunk of init.body) bytes.push(chunk);
            assert.match(Buffer.concat(bytes).toString(), /name="disable_content_type_detection"\r\n\r\ntrue/);
            return ok({ message_id: 100, [mediaType]: { file_id: 'valid-' + mediaType } });
        } });
        const [item] = await telegram.upload(backend, [{ path: filename, name: 'movie.mp4', size: 5 }], () => {});
        assert.equal(item.fileId, 'valid-' + mediaType); assert.equal(item.parts[0].mediaType, mediaType);
    }
});

test('413 将被拒绝的 Album 拆小重试；无效结果清理消息并记录安全诊断', async t => {
    const dataDir = temp(t), filename = path.join(dataDir, 'a.bin'); fs.writeFileSync(filename, 'abc');
    let id = 0, album = 0, deleted = [];
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, init) => {
        const method = url.split('/').at(-1);
        if (method === 'editMessageCaption') return ok(true);
        if (method === 'deleteMessages') { deleted = JSON.parse(init.body).message_ids; return ok(true); }
        for await (const chunk of init.body) void chunk;
        if (method === 'sendMediaGroup') { album++; return fail('Request Entity Too Large', 413); }
        id++; return ok(id === 3 ? { message_id: id, text: 'unexpected' } : { message_id: id, document: { file_id: 'f' + id } });
    } });
    const files = [0, 1].map(i => ({ logicalId: 'logical' + i, path: filename, name: i + '.bin', size: 3 }));
    assert.equal((await telegram.upload(backend, files, () => {})).length, 2); assert.equal(album, 1);
    await assert.rejects(telegram.upload(backend, files.slice(0, 1), () => {}), error => error.message === 'TELEGRAM_UPLOAD_RESULT_INVALID' && error.details.receivedMessages === 1);
    assert.deepEqual(deleted, [3]);
});

test('47 小时 57 分钟边界前直接删除；边界起逐条替换 1 Byte 占位并跨重启复用各 Bot 的 file_id', async t => {
    const dataDir = temp(t), now = 2_000_000_000_000, windowMs = (47 * 60 + 57) * 60000;
    const calls = []; let seeds = 0;
    const fetchImpl = async (url, init) => {
        const method = url.split('/').at(-1);
        if (method === 'sendDocument') {
            seeds++; const chunks = []; for await (const chunk of init.body) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString('latin1'); assert.match(raw, /filename="deleted.bin"[^]*\r\n\r\n\x00\r\n/);
            return ok({ message_id: 1000 + seeds, document: { file_id: 'placeholder-' + seeds } });
        }
        const body = JSON.parse(init.body); calls.push({ method, body });
        if (method === 'deleteMessage' && body.message_id === 5) return fail("Bad Request: message can't be deleted");
        return ok(true);
    };
    const file = { channelId: backend.channelId, name: 'cpu-z_2.11-cn.zip', createdAt: now, parts: [
        { messageId: 1, partIndex: 1, messageDate: now - windowMs + 1 },
        { messageId: 2, partIndex: 2, messageDate: now - windowMs },
        { messageId: 3, partIndex: 3, messageDate: now - windowMs - 1 },
        { messageId: 5, partIndex: 4 }
    ] };
    const make = () => createDiskTelegram({ dataDir, now: () => now, fetchImpl });
    await make().remove(backend, file);
    assert.equal(seeds, 1);
    assert.deepEqual(calls.filter(c => c.method === 'editMessageMedia').map(c => c.body.message_id), [2, 3, 5]);
    assert.ok(calls.filter(c => c.method === 'editMessageMedia').every(c => c.body.media.media === 'placeholder-1' && c.body.media.caption === file.name + ' 已删除'));
    await make().remove(backend, { ...file, parts: file.parts.slice(1, 2) }); assert.equal(seeds, 1);
    await make().remove({ ...backend, token: 'another-bot' }, { ...file, parts: file.parts.slice(1, 2) }); assert.equal(seeds, 2);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, 'tg-1byte-file.id')))).length, 2);
});

test('某片删除失败仍尝试其余片；修改备注覆盖全部片且忽略 not modified', async t => {
    const calls = [], file = { id: 'logical', name: 'renamed.zip', channelId: '-9', folderPath: 'new/folder', size: 6, parts: [1, 2, 3].map(i => ({ messageId: i, fileId: 'f' + i, partIndex: i, partCount: 3 })) };
    const telegram = createDiskTelegram({ dataDir: temp(t), fetchImpl: async (url, init) => {
        const payload = JSON.parse(init.body); calls.push(payload);
        if (url.endsWith('/deleteMessage') && payload.message_id === 2) return fail('Forbidden', 403);
        if (url.endsWith('/editMessageCaption') && payload.message_id === 2) return fail('message is not modified');
        return ok(true);
    } });
    await assert.rejects(telegram.remove(backend, file), /TELEGRAM_403/); assert.deepEqual(calls.map(c => c.message_id), [1, 2, 3]);
    calls.length = 0; await telegram.syncCaption(backend, file, { userId: 'u' });
    assert.equal(calls.length, 3); assert.ok(calls.every(c => c.chat_id === '-9' && c.caption.includes('path: /new/folder') && c.caption.includes('logical_file_id: logical')));
});

test('网盘会话签名密钥重启持久、Mock 与正式环境隔离', t => {
    const dataDir = temp(t), code = source('server.js');
    const fn = code.slice(code.indexOf('function getDiskIdentitySessionKey('), code.indexOf('\nfunction getTelegramDriveIdentity('));
    const key = auth => vm.runInNewContext(fn + '; [getDiskIdentitySessionKey(true), getDiskIdentitySessionKey(false)]', { crypto, diskAuth: auth, isTelegramOidcMockRequest: req => req });
    const before = key(createDiskAuth({ dataDir })), after = key(createDiskAuth({ dataDir }));
    assert.deepEqual(before[0], after[0]); assert.deepEqual(before[1], after[1]); assert.notDeepEqual(before[0], before[1]);
});

test('不重排、不重复、不截断接收分片，完整性失败时不产生逻辑文件', async t => {
    const store = createTelegramDriveStore({ dataDir: temp(t) });
    const job = store.begin({ owner: { id: 'u' }, files: [{ name: 'x', size: MAX_TELEGRAM_PART_SIZE + 2 }], maxDepth: 20 });
    await assert.rejects(store.receivePart(job.id, 0, Readable.from(['ab']), `bytes ${MAX_TELEGRAM_PART_SIZE}-${MAX_TELEGRAM_PART_SIZE + 1}/${MAX_TELEGRAM_PART_SIZE + 2}`), /UPLOAD_RANGE_INVALID/);
    await assert.rejects(store.receivePart(job.id, 0, Readable.from(['short']), `bytes 0-${MAX_TELEGRAM_PART_SIZE - 1}/${MAX_TELEGRAM_PART_SIZE + 2}`), /size-mismatch/);
    assert.throws(() => store.finish(job.id), /incomplete/); assert.equal(store.list('u').files.length, 0);
    store.abort(job.id);
});

test('明确 429 后等待重建 multipart 流，成功结果不重发', async t => {
    const dataDir = temp(t), filename = path.join(dataDir, 'a'); fs.writeFileSync(filename, 'abc');
    let attempts = 0; const bodies = [], phases = [];
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, init) => {
        if (url.endsWith('/editMessageCaption')) return ok(true);
        attempts++; const chunks = []; for await (const chunk of init.body) chunks.push(chunk);
        bodies.push(Buffer.concat(chunks));
        if (attempts === 1) return { ok: false, status: 429, json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 1 } }) };
        return ok({ message_id: 8, document: { file_id: 'f8' } });
    } });
    assert.equal((await telegram.upload(backend, [{ path: filename, name: 'a', size: 3 }], update => phases.push(update.phase))).length, 1);
    assert.equal(attempts, 2); assert.ok(phases.includes('telegram-wait'));
    assert.ok(bodies.every(body => body.includes(Buffer.from('\r\n\r\nabc\r\n'))));
});
