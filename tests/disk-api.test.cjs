'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const express = require('express');
const { encodeCBOR } = require('@levischuck/tiny-cbor');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskAPI, createDiskSpaces } = require('../server/disk-api');
const { createDiskOperations } = require('../server/disk-operations');
const { createTelegramDriveStore, normalizeTelegramDrivePath } = require('../server/telegram-drive');
const { createDiskTelegram } = require('../server/disk-telegram');
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const json = body => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const hash = value => crypto.createHash('sha256').update(value).digest();
const b64 = value => Buffer.from(value).toString('base64url');
function authenticator() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' }), id = crypto.randomBytes(32);
    const cose = encodeCBOR(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const client = (challenge, origin, type) => Buffer.from(JSON.stringify({ challenge, origin, type, crossOrigin: false }));
    const authData = (flags, counter) => { const bytes = Buffer.alloc(5); bytes[0] = flags; bytes.writeUInt32BE(counter, 1); return Buffer.concat([hash('disk.test'), bytes]); };
    return {
        register(flow, origin = 'https://disk.test') {
            const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
            const attestation = encodeCBOR(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', Buffer.concat([authData(0x45, 0), Buffer.alloc(16), length, id, cose])]]));
            return { id: b64(id), rawId: b64(id), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64(client(flow.options.challenge, origin, 'webauthn.create')), attestationObject: b64(attestation), transports: ['internal'] } };
        },
        login(flow, counter = 1, origin = 'https://disk.test') {
            const clientData = client(flow.options.challenge, origin, 'webauthn.get'), data = authData(5, counter);
            return { id: b64(id), rawId: b64(id), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64(clientData), authenticatorData: b64(data), signature: b64(crypto.sign('sha256', Buffer.concat([data, hash(clientData)]), privateKey)), userHandle: null } };
        }
    };
}
test('Passkey 使用真实签名验证：注册、登录、重放、Origin、计数器、Telegram 账号补充凭据', async t => {
    const dataDir = temp(t), auth = createDiskAuth({ dataDir }), key = authenticator();
    const options = { username: 'alice', origin: 'https://disk.test', binding: 'browser-binding' };
    const register = await auth.passkeyOptions({ ...options, kind: 'register' });
    const response = key.register(register);
    const user = await auth.passkeyVerify({ flowId: register.flow_id, binding: options.binding, response });
    assert.equal(user.username, 'alice'); assert.equal(user.passkeyCount, 1);
    await assert.rejects(auth.passkeyVerify({ flowId: register.flow_id, binding: options.binding, response }), /FLOW_INVALID/);
    const login = await auth.passkeyOptions({ ...options, kind: 'login' });
    assert.equal((await auth.passkeyVerify({ flowId: login.flow_id, binding: options.binding, response: key.login(login) })).id, user.id);
    const replay = await auth.passkeyOptions({ ...options, kind: 'login' });
    await assert.rejects(auth.passkeyVerify({ flowId: replay.flow_id, binding: options.binding, response: key.login(replay, 1) }));
    const wrongOrigin = await auth.passkeyOptions({ ...options, kind: 'login' });
    await assert.rejects(auth.passkeyVerify({ flowId: wrongOrigin.flow_id, binding: options.binding, response: key.login(wrongOrigin, 2, 'https://evil.test') }));
    const wrongBinding = await auth.passkeyOptions({ ...options, kind: 'login' });
    await assert.rejects(auth.passkeyVerify({ flowId: wrongBinding.flow_id, binding: 'other', response: key.login(wrongBinding, 2) }), /FLOW_INVALID/);
    await assert.rejects(auth.passkeyOptions({ ...options, origin: 'http://192.168.1.2', kind: 'register' }), /HTTPS_REQUIRED/);
    const telegram = auth.fromTelegram({ id: '1234' }), second = authenticator();
    const add = await auth.passkeyOptions({ ...options, username: 'tg_account', existingUserId: telegram.id, kind: 'register' });
    const bound = await auth.passkeyVerify({ flowId: add.flow_id, binding: options.binding, existingUserId: telegram.id, response: second.register(add) });
    assert.equal(bound.id, telegram.id); assert.equal(bound.telegramId, '1234');
    const reloaded = createDiskAuth({ dataDir });
    assert.equal(reloaded.user(user.id).passkeyCount, 1);
    assert.notEqual(auth.fromTelegram({ id: '1234' }, 'mock').id, telegram.id);
});
test('第三方令牌到期、撤销及 Bot 凭据加密持久化；非法配置不留下空应用', async t => {
    const dataDir = temp(t); let now = 1000;
    const auth = createDiskAuth({ dataDir, now: () => now, tokenTTL: 1000 });
    await assert.rejects(auth.saveApp({ app_id: 'bad', app_secret: 'test-secret-long-enough', passkey_origin: 'http://bad.test' }));
    assert.equal(auth.apps().length, 0);
    await auth.saveApp({ app_id: 'app1', app_secret: 'test-secret-long-enough' });
    await assert.rejects(auth.authenticateApp('app1', 'incorrect'), /APP_AUTH_INVALID/);
    const app = await auth.authenticateApp('app1', 'test-secret-long-enough');
    const backend = { token: '1234:super-private-token-test', channelId: '-1001', baseUrl: 'https://api.telegram.org' };
    const token = auth.issueToken(app, backend, { app_secret: 'test-secret-long-enough' });
    assert.equal(auth.access(token.access_token).storage.token, backend.token);
    assert.equal(auth.access(token.access_token).storage.channelId, backend.channelId);
    const savedToken = JSON.parse(fs.readFileSync(path.join(dataDir, 'disk-auth.json'), 'utf8')).tokens[0];
    assert.equal(savedToken.hash, crypto.createHash('sha256').update(token.access_token).digest('hex'));
    const encrypted = Buffer.from(savedToken.encryptedCredentials, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', fs.readFileSync(path.join(dataDir, 'disk-secret.key')), encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(-16));
    const credentials = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]).toString());
    assert.deepEqual(credentials, { app_id: 'app1', app_secret: 'test-secret-long-enough', tg_bot_token: backend.token, tg_channel: backend.channelId });
    const alternate = auth.issueToken(app, { ...backend, token: 'another-bot', channelId: '-1002' }, { app_secret: 'test-secret-long-enough' });
    const restored = createDiskAuth({ dataDir, now: () => now });
    assert.equal(restored.access(alternate.access_token).storage.token, 'another-bot');
    assert.equal(restored.access(alternate.access_token).storage.channelId, '-1002');
    assert.equal(restored.access(token.access_token).storage.token, backend.token, '同应用的两个令牌必须分别解析自己的凭据');
    assert.equal(auth.backend(auth.access(token.access_token).backendId).token, backend.token);
    assert.doesNotMatch(fs.readFileSync(path.join(dataDir, 'disk-auth.json'), 'utf8'), /super-private-token-test|test-secret-long-enough/);
    now = 2001; assert.throws(() => auth.access(token.access_token), /ACCESS_TOKEN_EXPIRED/);
    const fresh = auth.issueToken(app, backend);
    await auth.saveApp({ app_id: 'app1', enabled: false });
    assert.throws(() => auth.access(fresh.access_token), /ACCESS_TOKEN_INVALID/);
    assert.equal(auth.backend(token.backend_id).channelId, '-1001');
});
test('虚拟路径、保留文件名、目录循环与上传期间的冲突均被阻止；分区与用户隔离', async t => {
    const dataDir = temp(t), drive = createTelegramDriveStore({ dataDir });
    const spaces = createDiskSpaces(dataDir, drive), a = spaces.get('musicolet'), b = spaces.get('other');
    assert.equal(normalizeTelegramDrivePath('/音乐\\\\日文//./专辑/'), '音乐/日文/专辑');
    assert.throws(() => normalizeTelegramDrivePath('safe/../secret'), /NAME_INVALID/);
    a.createDirectory('alice', '音乐/专辑', 20);
    assert.equal(a.list('bob').folders.length, 0); assert.equal(b.list('alice').folders.length, 0);
    assert.equal(spaces.get('musicolet').list('alice').folders.length, 1);
    const upload = a.begin({ owner: { id: 'alice' }, folderPath: '音乐/专辑', files: [{ name: 'a.txt', size: 3 }], maxDepth: 20 });
    assert.throws(() => a.createDirectory('alice', '音乐/专辑/a.txt/sub', 20), /CONFLICT/);
    assert.throws(() => a.moveDirectory('alice', '音乐', '', 20, 'new'), /IN_PROGRESS/);
    assert.throws(() => a.removeDirectory('alice', '音乐', true), /IN_PROGRESS/);
    await a.receive(upload.id, 0, Readable.from(['abc']));
    const [file] = a.commit(upload.id, '-1', [{ fileId: 'remote', messageId: 1 }]);
    assert.throws(() => a.createDirectory('alice', '音乐/专辑/a.txt/sub', 20), /CONFLICT/);
    assert.throws(() => a.moveDirectory('alice', '音乐', '音乐/专辑', 20), /cycle/);
    a.createDirectory('alice', 'new', 20); a.modifyFile('alice', file.id, { name: 'new.txt', folderPath: 'new' }, 20);
    assert.equal(a.get('alice', file.id).folderPath, 'new');
    assert.equal(a.get('bob', file.id), null);
});
test('操作任务重启可查询，未结束任务明确失败且不会暴露给其他用户或分区', async t => {
    const dataDir = temp(t), operations = createDiskOperations({ dataDir }), scope = { userId: 'u', diskSpace: '' };
    const job = operations.create(scope, 'upload', 'waiting');
    operations.update(job.operation_id, { status: 'running', percent: 25 }, true);
    assert.equal(operations.get(job.operation_id, { userId: 'other' }), null);
    assert.equal(operations.get(job.operation_id, { userId: 'u', diskSpace: 'other' }), null);
    const reloaded = createDiskOperations({ dataDir });
    assert.equal(reloaded.get(job.operation_id, scope).errorCode, 'SERVER_RESTARTED');
});
test('真实 HTTP 网盘 API：原手机路径、异步操作、移动重命名、下载、幂等完成、部分删除与隔离', async t => {
    const dataDir = temp(t), auth = createDiskAuth({ dataDir }), drive = createTelegramDriveStore({ dataDir }), operations = createDiskOperations({ dataDir });
    await auth.saveApp({ app_id: 'app1', app_secret: 'test-secret-long-enough' });
    const user = auth.fromTelegram({ id: '111' }), other = auth.fromTelegram({ id: '222' });
    let uploads = 0, failDelete = false, failUpload = false;
    const telegram = {
        validate: async () => ({ token: 'fake-secret', channelId: '-1001', baseUrl: 'https://api.telegram.org' }),
        upload: async (_backend, files, update, completed = []) => {
            assert.equal(_backend.token, 'fake-secret'); assert.equal(_backend.channelId, '-1001');
            uploads++; update({ phase: 'telegram-upload', percent: 50, message: 'uploading' });
            completed.push(...files.slice(0, failUpload ? 1 : files.length).map((file, i) => ({ fileId: 'remote-' + i, messageId: i + 1 })));
            if (failUpload) throw new Error('TELEGRAM_NETWORK_ERROR');
            return completed;
        },
        read: async () => Readable.from(['abc']),
        remove: async () => { if (failDelete) throw new Error('TELEGRAM_400'); },
        call: async () => ({ file_path: 'remote' })
    };
    const app = express(); app.use(express.json());
    const api = createDiskAPI({ dataDir, defaultStore: drive, auth, operations, telegram, getDefaultBackend: () => ({ token: 'default', channelId: '-10', baseUrl: 'https://api.telegram.org' }), getIdentity: () => user, setIdentity: () => {}, getOrigin: () => 'http://localhost', isMockRequest: () => true, maxDepth: () => 20 });
    app.use('/api', api.external); app.use('/browser', api.browser); app.use('/shared', api.shared);
    t.after(() => api.close());
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port;
    const issued = await (await fetch(base + '/api/auth/token', { method: 'POST', ...json({ app_id: 'app1', app_secret: 'test-secret-long-enough', tg_bot_token: 'fake', tg_channel: '-1' }) })).json();
    const headers = { Authorization: 'Bearer ' + issued.access_token, 'X-Disk-User-Id': user.id, 'X-Disk-Space': 'music' };
    const request = async (url, options = {}) => { const res = await fetch(base + '/api' + url, { ...options, headers: { ...headers, ...options.headers } }); const data = await res.json(); return { status: res.status, ...data }; };
    const wait = async id => {
        for (let i = 0; i < 100; i++) { const job = await request('/operations/' + id); if (!['queued', 'running'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 10)); }
        throw new Error('test operation timed out');
    };
    assert.equal((await request('/list', { headers: { Authorization: 'Bearer invalid' } })).status, 401);
    const job = await request('/uploads', { method: 'POST', ...json({ files: [{ source_path: '/storage/emulated/0/Music/a.txt', size: 3, type: 'text/plain' }] }) });
    assert.equal(job.status, 201);
    assert.equal((await request('/uploads/' + job.uploadId + '/files/0', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Disk-User-Id': other.id }, body: 'abc' })).status, 404);
    await request('/uploads/' + job.uploadId + '/files/0', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: 'abc' });
    const finished = await request('/uploads/' + job.uploadId + '/finish', { method: 'POST' });
    const done = await wait(finished.operation_id); assert.equal(done.status, 'completed');
    const file = done.result.items[0]; assert.equal(file.folderPath, 'storage/emulated/0/Music'); assert.equal(file.fileId, undefined);
    const share = await request('/shares', { method: 'POST', ...json({ items: [{ kind: 'directory', path: 'storage' }] }) });
    assert.equal(share.status, 201);
    const shareToken = share.url.split('/').pop();
    const publicRoot = await (await fetch(base + '/shared/' + shareToken)).json();
    assert.equal(publicRoot.folders[0].name, 'storage'); assert.equal(publicRoot.ownerId, undefined);
    const publicNested = await (await fetch(base + '/shared/' + shareToken + '?path=storage/emulated/0/Music')).json();
    assert.equal(publicNested.files[0].id, file.id); assert.equal(publicNested.files[0].fileId, undefined);
    assert.equal(await (await fetch(base + '/shared/' + shareToken + '/files/' + file.id + '/download')).text(), 'abc');
    assert.equal((await fetch(base + '/shared/' + shareToken + '/files/unknown/download')).status, 404);
    assert.equal((await request('/shares/' + share.id, { method: 'DELETE', headers: { 'X-Disk-User-Id': other.id } })).status, 404);
    assert.equal((await request('/shares', { headers: { 'X-Disk-Space': 'other' } })).shares.length, 0);
    assert.equal((await request('/shares/' + share.id, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(base + '/shared/' + shareToken)).status, 404);
    assert.equal((await fetch(base + '/shared/' + shareToken + '/files/' + file.id + '/download')).status, 404);
    assert.equal((await request('/uploads/' + job.uploadId + '/finish', { method: 'POST' })).operation_id, finished.operation_id); assert.equal(uploads, 1);
    assert.equal((await request('/list', { headers: { 'X-Disk-Space': 'other' } })).folders.length, 0);
    assert.equal((await request('/files/' + file.id, { headers: { 'X-Disk-User-Id': other.id } })).status, 404);
    const mkdir = await request('/directories', { method: 'POST', ...json({ path: 'new/deep' }) }); assert.equal((await wait(mkdir.operation_id)).status, 'completed');
    const moved = await request('/files/' + file.id, { method: 'PATCH', ...json({ folderPath: 'new/deep', name: 'renamed.txt' }) }); assert.equal((await wait(moved.operation_id)).status, 'completed');
    assert.equal(await (await fetch(base + '/api/files/' + file.id + '/download', { headers })).text(), 'abc');
    failDelete = true;
    const failed = await request('/directories?path=new&recursive=true', { method: 'DELETE' }); assert.equal((await wait(failed.operation_id)).errorCode, 'DISK_DELETE_PARTIAL');
    assert.equal((await request('/files/' + file.id)).name, 'renamed.txt');
    failDelete = false;
    const removed = await request('/directories?path=new&recursive=true', { method: 'DELETE' }); assert.equal((await wait(removed.operation_id)).status, 'completed');
    assert.equal((await request('/files/' + file.id)).status, 404);
    failUpload = true;
    const partial = await request('/uploads', { method: 'POST', ...json({ files: [{ name: 'partial-1.txt', size: 3 }, { name: 'partial-2.txt', size: 3 }] }) });
    for (const index of [0, 1]) await request('/uploads/' + partial.uploadId + '/files/' + index, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: 'abc' });
    const partialFinish = await request('/uploads/' + partial.uploadId + '/finish', { method: 'POST' });
    const partialResult = await wait(partialFinish.operation_id);
    assert.equal(partialResult.status, 'failed');
    assert.equal(partialResult.result.partialItems.length, 1);
    assert.equal((await request('/list')).files[0].name, 'partial-1.txt');
    const mock = await fetch(base + '/browser/passkeys/register/options', { method: 'POST', ...json({ username: 'local' }) });
    assert.equal((await mock.json()).error, 'LOCAL_USE_OIDC_MOCK');
    operations.flush();
});
test('Telegram transport 按 10 个拆 album，字节进度不含 multipart 头，异常不泄露 token', async t => {
    const dataDir = temp(t), filePath = path.join(dataDir, 'test.txt'); fs.writeFileSync(filePath, 'abc');
    const files = Array.from({ length: 11 }, (_, i) => ({ path: filePath, name: i + '.txt', size: 3 }));
    const calls = [], progress = [], captions = [];
    const telegram = createDiskTelegram({ fetchImpl: async (url, options) => {
        const method = url.split('/').at(-1); calls.push(method);
        if (method === 'editMessageCaption') { captions.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true, result: true }) }; }
        const chunks = []; for await (const chunk of options.body) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString(); const count = (body.match(/filename="/g) || []).length;
        const messages = Array.from({ length: count }, (_, i) => ({ message_id: i + 1, document: { file_id: 'f' + i } }));
        return { ok: true, json: async () => ({ ok: true, result: count === 1 ? messages[0] : messages }) };
    } });
    assert.equal((await telegram.upload({ token: 'secret', baseUrl: 'https://api.telegram.org', channelId: '-1' }, files, item => progress.push(item), [], { userId: 'general-user', diskSpace: 'music' })).length, 11);
    assert.deepEqual(calls.filter(method => method !== 'editMessageCaption'), ['sendMediaGroup', 'sendDocument']);
    assert.equal(captions.length, 11);
    assert.ok(captions.every(item => /user_id: general-user/.test(item.caption) && /file_id: f/.test(item.caption) && /message_id:/.test(item.caption) && /channel_id: -1/.test(item.caption)));
    assert.ok(progress.some(item => item.processedBytes === 33));
    assert.ok(progress.every(item => !item.processedBytes || item.processedBytes <= 33));
    const broken = createDiskTelegram({ fetchImpl: async () => { throw new Error('https://host/bot123:secret'); } });
    await assert.rejects(broken.call({ token: 'secret', baseUrl: 'https://api.telegram.org' }, 'getFile', {}), /^Error: TELEGRAM_NETWORK_ERROR$/);
});
