'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const express = require('express');
const { Readable } = require('node:stream');
const { createDiskAPI } = require('../server/disk-api');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskOperations } = require('../server/disk-operations');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { openDiskRepository } = require('../server/disk-repository');
const { createDiskTelegram } = require('../server/disk-telegram');
const { normalizeChatId, normalizeChatIdentifier, normalizeEntries, createTelegramChatDictionary, createTelegramChatResolver, registerTelegramChatDictionaryRoutes } = require('../server/telegram-chat-dictionary');
const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
function temporary(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-chat-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
const entry = { chatId: '-1001234567890', username: '@Example_channel', label: '示例频道', aliases: ['@Old_channel'] };

test('Chat 字典规范化精确数字 ID、public 链接及历史别名，拒绝冲突和非法输入', () => {
    assert.equal(normalizeChatId(' -001001234567890 '), '-1001234567890');
    assert.equal(normalizeChatIdentifier('https://t.me/Example_channel/'), '@example_channel');
    assert.equal(normalizeChatIdentifier('HTTPS://T.ME/Example_channel'), '@example_channel');
    assert.equal(normalizeChatIdentifier('-1001234567890'), '-1001234567890');
    for (const id of ['0', '1.5', '1e10', '4503599627370496', '-100abc', 9007199254740992]) assert.throws(() => normalizeChatId(id));
    for (const name of ['https://evil.test/example', 't.me/+invite', '@bad:name', 't.me/example/12', '@no space']) assert.throws(() => normalizeChatIdentifier(name));
    assert.throws(() => normalizeEntries([entry, { ...entry, username: '@Different' }]), /已有映射/);
    assert.throws(() => normalizeEntries([entry, { ...entry, chatId: '-1002', username: '@old_channel', aliases: [] }]), /冲突/);
    assert.throws(() => normalizeEntries([{ ...entry, label: 'x'.repeat(101) }]), /100/);
    assert.throws(() => normalizeEntries([{ ...entry, aliases: ['-1001'] }]), /别名/);
});

test('Chat 字典持久化双向查询，改名保留历史别名，删除生效，旧 revision 不覆盖新配置', t => {
    const dataDir = temporary(t), dictionary = createTelegramChatDictionary({ dataDir });
    let state = dictionary.replace([entry], dictionary.list().revision);
    assert.equal(dictionary.lookup('t.me/Old_channel').chatId, entry.chatId);
    assert.equal(dictionary.publicUsername(entry.chatId), '@example_channel');
    assert.equal(createTelegramChatDictionary({ dataDir }).lookup('@EXAMPLE_CHANNEL').label, '示例频道');
    const oldRevision = state.revision;
    state = dictionary.replace([{ ...entry, username: '@New_channel', aliases: ['@Old_channel', '@Example_channel'] }], state.revision);
    assert.equal(dictionary.publicUsername(entry.chatId), '@new_channel');
    assert.throws(() => dictionary.replace([], oldRevision), /已被修改/);
    assert.throws(() => dictionary.replace([entry, entry], state.revision));
    assert.equal(dictionary.lookup('@example_channel').chatId, entry.chatId);
    dictionary.replace([], state.revision);
    assert.equal(dictionary.lookup(entry.chatId), null);
    assert.deepEqual(fs.readdirSync(dataDir), ['telegram-chat-dictionary.json']);
});

test('Chat 字典 API 仅管理员可维护，保存不依赖 Bot 网络，可检测覆盖冲突', async t => {
    const dataDir = temporary(t), dictionary = createTelegramChatDictionary({ dataDir });
    const app = express(); app.use(express.json());
    registerTelegramChatDictionaryRoutes(app, (req, res, next) => req.get('X-Admin') === 'yes' ? next() : res.sendStatus(401), dictionary);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = 'http://127.0.0.1:' + server.address().port + '/api/telegram/chat-dictionary';
    assert.equal((await fetch(url)).status, 401);
    const state = await (await fetch(url, { headers: { 'X-Admin': 'yes' } })).json();
    const put = body => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Admin': 'yes' }, body: JSON.stringify(body) });
    const response = await put({ entries: [entry], revision: state.revision });
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
    const saved = await response.json(); assert.equal(saved.entries[0].username, '@example_channel');
    assert.equal((await put({ entries: [], revision: state.revision })).status, 409);
    assert.equal((await put({ entries: [entry, entry], revision: saved.revision })).status, 422);
});

test('回源 resolver 优先用字典数字 ID 并验证，合并并发；数字 ID 不反向降级', async t => {
    const dictionary = createTelegramChatDictionary({ dataDir: temporary(t) });
    dictionary.replace([entry], dictionary.list().revision);
    let calls = [], time = 0;
    const resolver = createTelegramChatResolver({ dictionary, now: () => time, getChat: async (id, options) => { calls.push([id, options.token]); return { id: Number(entry.chatId) }; } });
    const options = { token: 'bot-a', baseUrl: 'https://api.telegram.org' };
    const values = await Promise.all([resolver.resolve('@Old_channel', options), resolver.resolve('@OLD_CHANNEL', options)]);
    assert.equal(values[0].chatId, entry.chatId); assert.deepEqual(calls, [[entry.chatId, 'bot-a']]);
    assert.equal((await resolver.resolve(entry.chatId, options)).identifier, entry.chatId);
    await resolver.resolve('@Old_channel', options); assert.equal(calls.length, 1);
    await resolver.resolve('@Old_channel', { ...options, token: 'bot-b' }); assert.equal(calls.length, 2);
    time = 300001; await resolver.resolve('@Old_channel', options); assert.equal(calls.length, 3);
    const mismatch = createTelegramChatResolver({ dictionary, getChat: async () => ({ id: -100999 }) });
    await assert.rejects(mismatch.resolve('@Old_channel', options), /MISMATCH/);
});

test('无字典历史来源不因 public 名称转让而迁移；新写入严格拒绝无法解析的目标', async t => {
    const dictionary = createTelegramChatDictionary({ dataDir: temporary(t) }), calls = [];
    const resolver = createTelegramChatResolver({ dictionary, getChat: async id => { calls.push(id); throw new Error('not-found'); } });
    const value = await resolver.resolve('@Old_channel');
    assert.equal(value.identifier, '@Old_channel'); assert.equal(value.chatId, '');
    assert.deepEqual(calls, []);
    await assert.rejects(resolver.resolve('@Old_channel', { strict: true }), /not-found/);
    assert.deepEqual(calls, ['@old_channel']);
});

test('Chat 验证超时终止等待，失败暂退避；新上传不使用失败缓存继续写入', async t => {
    const dictionary = createTelegramChatDictionary({ dataDir: temporary(t) }); dictionary.replace([entry], dictionary.list().revision);
    let calls = 0, signal, time = 0;
    const resolver = createTelegramChatResolver({ dictionary, now: () => time, verificationTimeoutMs: 15, getChat: async (_, options) => { calls++; signal = options.signal; return new Promise(() => {}); } });
    const value = await resolver.resolve('@Old_channel');
    assert.equal(value.chatId, ''); assert.equal(signal.aborted, true); assert.equal(calls, 1);
    await resolver.resolve('@Old_channel'); assert.equal(calls, 1);
    await assert.rejects(resolver.resolve('@Old_channel', { strict: true }), /RESOLVE_TIMEOUT/); assert.equal(calls, 2);
    time = 30001; await resolver.resolve('@Old_channel'); assert.equal(calls, 3);
});

function assetFixture(t, { downloadError = false, chatUnavailable = false, bytes = Buffer.from('data') } = {}) {
    const dataDir = temporary(t), server = source('server.js');
    const dictionary = createTelegramChatDictionary({ dataDir }); dictionary.replace([entry], dictionary.list().revision);
    const calls = [], updates = [];
    const context = vm.createContext({ fs, path, Buffer, TELEGRAM_ASSET_DIR: dataDir, TELEGRAM_CLOUD_GET_FILE_MAX_SIZE: 20 * 1024 * 1024,
        telegramAssetDownloads: new Map(), telegramServerAssets: new Map(),
        telegramChatResolver: createTelegramChatResolver({ dictionary, getChat: async id => { calls.push(['getChat', id]); if (chatUnavailable) throw new Error('chat-unavailable'); return { id: Number(entry.chatId) }; } }),
        getTelegramBotToken: () => 'bot', getTelegramBotApiBaseUrl: () => 'https://api.telegram.org',
        downloadTelegramFile: async id => { calls.push(['getFile', id]); if (downloadError) throw new Error('download-failed'); return bytes; },
        isRecoverableSnsAsset: () => false, restoreSnsServerAssetFile: async () => { throw new Error('unexpected SNS'); },
        sanitizeString: (text, length) => String(text).slice(0, length),
        updateTelegramAssetMetadataInSession: asset => updates.push({ ...asset }), readSnsTask: () => null, sessions: new Map()
    });
    const extract = (start, end) => vm.runInContext(server.slice(server.indexOf(start), server.indexOf(end)), context);
    extract('function getTelegramAssetMetadataPath(', 'function resolveTelegramServerAsset(');
    extract('async function ensureTelegramServerAssetFile(', 'async function restoreSnsServerAssetFile(');
    const asset = { id: 'asset-1', path: path.join(dataDir, 'asset-1'), name: 'x.bin', type: 'application/octet-stream', size: 4, fileId: 'legacy-id', chatId: '@Old_channel', sessionId: 'tunnel', source: 'telegram-bot' };
    return { ...context, asset, calls, updates, dataDir };
}

test('Telegram 实际回源完整成功才升级并持久化 Chat 标注，合并下载且不改变 file_id', async t => {
    const f = assetFixture(t);
    await Promise.all([f.ensureTelegramServerAssetFile(f.asset), f.ensureTelegramServerAssetFile(f.asset)]);
    assert.deepEqual(f.calls, [['getChat', entry.chatId], ['getFile', 'legacy-id']]);
    const metadata = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'asset-1.json')));
    assert.equal(metadata.chatId, entry.chatId); assert.equal(metadata.fileId, 'legacy-id');
    assert.equal(f.asset.chatId, entry.chatId); assert.equal(f.updates.length, 1);
    await f.ensureTelegramServerAssetFile(f.asset); assert.equal(f.calls.length, 2);
});

test('Telegram 下载失败或字节不完整时保留 public 来源且不写入成功缓存', async t => {
    for (const options of [{ downloadError: true }, { bytes: Buffer.from('bad') }]) {
        const f = assetFixture(t, options);
        await assert.rejects(f.ensureTelegramServerAssetFile(f.asset), /download-failed|size-mismatch/);
        assert.equal(f.asset.chatId, '@Old_channel'); assert.equal(f.updates.length, 0);
        assert.equal(fs.existsSync(f.asset.path), false);
    }
});

function browserFixture({ short = false, partial = false, header = entry.chatId } = {}) {
    const files = new Map(), messages = new Map(), data = new Uint8Array([1, 2, 3, 4]).buffer;
    const fileInfo = { id: 'file-1', name: 'x.bin', type: 'application/octet-stream', size: 4, telegramChatId: '@Old_channel', telegramFileId: 'legacy-id', telegramFileUniqueId: 'unique', serverAssetUrl: '/api/server-assets/file-1', ownerDeviceId: 'owner', isServerAsset: true };
    files.set(fileInfo.id, { ...fileInfo, restoreRequested: true }); messages.set('message-1', { id: 'message-1', type: 'file', fileInfo: { ...fileInfo }, sender: 'owner' });
    const hasCache = file => Boolean(file?.data && file.data.byteLength === file.size && !file.cacheCleared && !file.isPartial);
    const context = vm.createContext({ state: { sessionId: 'tunnel' }, fileAssetTransfer: { announce: async () => {} },
        serverAssetRecoveries: { metadata: new Map() }, fileObjectUrls: new Map(),
        getFromStore: async (table, id) => (table === 'files' ? files : messages).get(id),
        saveToStore: async (table, value) => (table === 'files' ? files : messages).set(value.id, { ...value }),
        getCurrentSessionMessages: async () => [...messages.values()], hasCompleteFileCache: hasCache,
        fetch: async () => ({ ok: true, status: partial ? 206 : 200, headers: { get: name => name === 'x-drop2tunnel-telegram-chat-id' ? header : name === 'content-length' ? '4' : '' }, arrayBuffer: async () => short ? data.slice(0, 3) : data }),
        setServerAssetRecoveryStage() {}, clearServerAssetRecoveryStage() {}, notifyMusicLibraryAssetAvailable() {}, confirmServerAssetCache() {},
        enqueueMediaPosterCache() {}, refreshFileMessage: async () => {}, refreshOpenSnsMediaClientStates() {}, historyLog() {}
    });
    const app = source('app.js');
    vm.runInContext(app.slice(app.indexOf('async function applyConfirmedTelegramChatLocally('), app.indexOf('async function requestServerAssetWithPeerPreference(')), context);
    return { ...context, context, files, messages, fileInfo };
}

test('浏览器完整缓存确认后只更新 Chat 标注，单文件与合辑引用一致且重复迁移无额外写入', async () => {
    const f = browserFixture();
    f.messages.set('collection', { id: 'collection', type: 'collection', collection: { files: [{ ...f.fileInfo }, { id: 'other', telegramChatId: '@Untouched' }] } });
    await f.fetchServerAssetCacheOnce(f.fileInfo);
    const stored = f.files.get('file-1'); assert.equal(stored.telegramChatId, entry.chatId); assert.equal(stored.data.byteLength, 4);
    assert.equal(stored.ownerDeviceId, 'owner'); assert.equal(stored.telegramFileId, 'legacy-id');
    assert.equal(f.messages.get('message-1').fileInfo.telegramChatId, entry.chatId);
    assert.equal(f.messages.get('collection').collection.files[1].telegramChatId, '@Untouched');
    const before = f.files.get('file-1'); await f.applyConfirmedTelegramChatLocally('file-1', entry.chatId); assert.equal(f.files.get('file-1'), before);
    f.messages.get('message-1').fileInfo.telegramChatId = '@Old_channel';
    await f.applyConfirmedTelegramChatLocally('file-1', '-100999'); assert.equal(f.files.get('file-1').telegramChatId, entry.chatId);
    assert.equal(f.messages.get('message-1').fileInfo.telegramChatId, '@Old_channel', '冲突确认头不生成第二套来源');
});

test('短响应、无确认头、非法确认 ID 均不升级浏览器 public 来源', async () => {
    const short = browserFixture({ short: true }); await assert.rejects(short.fetchServerAssetCacheOnce(short.fileInfo), /size-mismatch/);
    assert.equal(short.files.get('file-1').telegramChatId, '@Old_channel');
    const partial = browserFixture({ partial: true }); await assert.rejects(partial.fetchServerAssetCacheOnce(partial.fileInfo), /incomplete-response/);
    assert.equal(partial.files.get('file-1').data, undefined); assert.equal(partial.files.get('file-1').telegramChatId, '@Old_channel');
    for (const header of ['', '@Old_channel', '9007199254740993']) {
        const f = browserFixture({ header }); await f.fetchServerAssetCacheOnce(f.fileInfo);
        assert.equal(f.files.get('file-1').telegramChatId, '@Old_channel');
    }
});

test('Chat 标注写入失败不会阻止完整缓存的 provider 登记和完成确认', async () => {
    const f = browserFixture(), save = f.saveToStore, calls = [];
    f.context.saveToStore = async (table, value) => { if (table === 'files' && value.telegramChatId === entry.chatId) throw new Error('annotation-write-failed'); return save(table, value); };
    f.fileAssetTransfer.announce = async () => calls.push('announce');
    f.context.confirmServerAssetCache = () => calls.push('complete');
    assert.equal(await f.fetchServerAssetCacheOnce(f.fileInfo), true);
    assert.equal(f.files.get('file-1').data.byteLength, 4); assert.equal(f.files.get('file-1').telegramChatId, '@Old_channel');
    assert.deepEqual(calls, ['announce', 'complete']);
});

test('Chat 验证暂不可用时仍从有效 file_id 获取文件，不改坏旧 public 标注', async t => {
    const f = assetFixture(t, { chatUnavailable: true });
    await f.ensureTelegramServerAssetFile(f.asset);
    assert.equal(fs.readFileSync(f.asset.path, 'utf8'), 'data'); assert.equal(f.asset.chatId, '@Old_channel');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'asset-1.json'))).chatId, '@Old_channel');
});

test('Bot 接收各种媒体直接保存数字 Chat ID 及消息 ID，不依赖转发来源 public 名称', () => {
    const server = source('server.js'), context = vm.createContext({ TELEGRAM_REMARK_MAX_LENGTH: 2000, normalizeChatId });
    vm.runInContext(server.slice(server.indexOf('function getTelegramFileFromMessage('), server.indexOf('async function publishTelegramPending(')), context);
    for (const kind of ['document', 'video', 'audio', 'animation', 'voice', 'video_note', 'photo']) {
        const media = { file_id: 'id', file_size: 4 };
        const value = context.getTelegramFileFromMessage({ chat: { id: Number(entry.chatId), username: 'Old_channel' }, message_id: 10, [kind]: kind === 'photo' ? [media] : media });
        assert.equal(value.chatId, entry.chatId); assert.equal(value.telegramMessageId, 10);
    }
});

async function driveFixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-chat-drive-'));
    const auth = createDiskAuth({ dataDir }), user = auth.fromTelegram({ id: '1' });
    const drive = createTelegramDriveStore({ dataDir }), operations = createDiskOperations({ dataDir });
    const dictionary = createTelegramChatDictionary({ dataDir }); dictionary.replace([entry], dictionary.list().revision);
    const chats = [], reads = [], uploads = [], locked = [];
    const resolver = createTelegramChatResolver({ dictionary, getChat: async id => { chats.push(id); return { id: Number(entry.chatId) }; } });
    const api = createDiskAPI({ dataDir, defaultStore: drive, auth, operations,
        telegram: {
            parts: file => file.parts,
            readPart: async (backend, part, options) => { reads.push(backend.channelId); return Readable.from([Buffer.from('data').subarray(options.start, options.end + 1)]); },
            upload: async (backend, files) => { uploads.push(backend.channelId); return files.map((file, i) => ({ fileId: 'new-id-' + i, messageId: 20 + i })); },
            syncCaption: async () => {}, remove: async () => {}
        },
        getDefaultBackend: channelId => ({ token: 'bot', channelId: channelId || '@Old_channel', baseUrl: 'https://api.telegram.org' }),
        resolveStorageBackend: async (backend, options = {}) => { const value = await resolver.resolve(backend.channelId, { ...backend, strict: options.strict !== false }); return { ...backend, requestedChannelId: backend.channelId, channelId: value.chatId || backend.channelId }; },
        onDefaultUpload: id => locked.push(id), getIdentity: req => req.get('X-Logout') ? null : user,
        setIdentity() {}, getOrigin: () => 'http://localhost', isMockRequest: () => true, maxDepth: () => 20 });
    const app = express(); app.use(express.json()); app.use('/disk', api.browser);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { api.close(); await new Promise(resolve => server.close(resolve)); openDiskRepository(dataDir).close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    return { drive, operations, user, chats, reads, uploads, locked, base: 'http://127.0.0.1:' + server.address().port + '/disk' };
}

test('网盘真实 Range 路由使用数字 Chat 后端，保持分片内容、鉴权及旧记录；回传确认头', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await driveFixture(t);
    const upload = f.drive.begin({ owner: f.user, folderPath: '', files: [{ name: 'legacy.bin', type: 'application/octet-stream', size: 4 }], maxDepth: 20, channelId: '@Old_channel' });
    await f.drive.receive(upload.id, 0, Readable.from(['data']));
    const [file] = f.drive.commit(upload.id, '@Old_channel', [{ fileId: 'old-file', messageId: 1 }]);
    const url = f.base + '/files/' + file.id + '/stream';
    assert.equal((await fetch(url, { headers: { 'X-Logout': 'yes' } })).status, 401);
    assert.equal(f.chats.length, 0);
    const response = await fetch(url, { headers: { Range: 'bytes=1-2' } });
    assert.equal(response.status, 206, response.status !== 206 ? await response.text() : ''); assert.equal(response.headers.get('content-range'), 'bytes 1-2/4');
    assert.equal(response.headers.get('x-drop2tunnel-telegram-chat-id'), entry.chatId); assert.equal(await response.text(), 'at');
    assert.deepEqual(f.chats, [entry.chatId]); assert.deepEqual(f.reads, [entry.chatId]);
    assert.equal(f.drive.get(f.user.id, file.id).channelId, '@Old_channel', '读取不批量修改历史 SQLite 记录');
});

test('网盘配置 public 目标时，新上传索引与返回结果保存数字 ID，同时保持原分区锁定', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await driveFixture(t);
    const response = await fetch(f.base + '/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: [{ name: 'new.bin', size: 4, type: 'application/octet-stream' }] }) });
    assert.equal(response.status, 201); const job = await response.json();
    const received = await fetch(f.base + '/uploads/' + job.uploadId + '/files/0', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-3/4' }, body: 'data' });
    assert.equal(received.status, 200);
    await fetch(f.base + '/uploads/' + job.uploadId + '/finish', { method: 'POST' });
    let done;
    for (let i = 0; i < 100; i++) { done = f.operations.get(job.operation_id, { userId: f.user.id }); if (!['queued', 'running'].includes(done.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(done.status, 'completed'); const file = done.result.items[0];
    assert.equal(file.telegramChatId, entry.chatId); assert.equal(f.drive.get(f.user.id, file.id).channelId, entry.chatId);
    assert.deepEqual(f.uploads, [entry.chatId]); assert.deepEqual(f.locked, ['@Old_channel']);
});

test('已确认数字 Chat 标注不会被旧设备历史消息覆盖；不同文件不互相串用', () => {
    const server = source('server.js'), context = vm.createContext({});
    vm.runInContext(server.slice(server.indexOf('function preserveNewestTelegramFileIds('), server.indexOf('function summarizeHistoryMessage(')), context);
    const previous = { fileInfo: { id: 'same', telegramChatId: entry.chatId, telegramFileIdUpdatedAt: 1 } };
    const next = { fileInfo: { id: 'same', telegramChatId: '@Old_channel', telegramFileIdUpdatedAt: 2 } };
    context.preserveNewestTelegramFileIds(previous, next); assert.equal(next.fileInfo.telegramChatId, entry.chatId);
    const other = { fileInfo: { id: 'other', telegramChatId: '@Different' } };
    context.preserveNewestTelegramFileIds(previous, other); assert.equal(other.fileInfo.telegramChatId, '@Different');
});

test('旧消息操作只解析 chat 字段，不改动 file_id、消息 ID 或调用方 payload', async t => {
    t.mock.method(console, 'info', () => {});
    const dataDir = temporary(t), dictionary = createTelegramChatDictionary({ dataDir }); dictionary.replace([entry], dictionary.list().revision);
    const sent = [];
    const telegram = createDiskTelegram({ dataDir, resolveChatIdentifier: value => dictionary.lookup(value)?.chatId || value,
        fetchImpl: async (_, options) => { sent.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) }; } });
    const payload = { chat_id: '@Old_channel', from_chat_id: '@Unknown_channel', message_id: 18, file_id: 'unchanged-file-id' };
    try {
        await telegram.call({ token: 'bot', baseUrl: 'https://api.telegram.org', channelId: '@Old_channel' }, 'copyMessage', payload);
        assert.deepEqual(sent[0], { ...payload, chat_id: entry.chatId }); assert.equal(payload.chat_id, '@Old_channel');
    } finally { openDiskRepository(dataDir).close(); }
});

test('托管频道移除 public 名称后，内容管理仍识别映射 ID，避免采集回写形成循环', t => {
    const dictionary = createTelegramChatDictionary({ dataDir: temporary(t) }); dictionary.replace([entry], dictionary.list().revision);
    const storageChannels = source('server.js').match(/getStorageChannelIds:\(\) => ([^\n]+),/)[1];
    const context = vm.createContext({ telegramConfig: { driveChannels: [{ id: '@Old_channel' }, { id: '@Unmapped_channel' }] }, telegramChatDictionary: dictionary });
    context.options = { getStorageChannelIds: vm.runInContext('() => ' + storageChannels, context) };
    const content = source('server/telegram-content-manager.js');
    vm.runInContext(content.slice(content.indexOf('function isStorageChat('), content.indexOf('async function observeChat(')), context);
    assert.equal(context.isStorageChat({ id: Number(entry.chatId) }), true);
    assert.equal(context.isStorageChat({ id: -100999, username: 'Old_channel' }), false, '已映射旧名称被转让时不忽略另一 Chat');
    assert.equal(context.isStorageChat({ id: -100999, username: 'Unmapped_channel' }), true, '未映射配置仍保留原公开名称判断');
    assert.equal(context.isStorageChat({ id: -100999, username: 'unrelated_channel' }), false);
});
