'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), vm = require('node:vm');
const express = require('express');
const { createDiskAccountSessions } = require('../server/disk-account-sessions');
const { createDiskAuth } = require('../server/disk-auth');
const { openDiskRepository } = require('../server/disk-repository');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { createDiskOperations } = require('../server/disk-operations');
const { createDiskAPI } = require('../server/disk-api');
const { createContentProof } = require('../server/disk-content-proof');
const source = fs.readFileSync(path.join(__dirname, '../client/disk-client.js'), 'utf8');

async function fixture(t, options = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-accounts-'));
    const repository = openDiskRepository(dataDir);
    repository.replace('users', ['alice', 'bob'].map(id => ({ id, name: id === 'alice' ? '小林' : '小陈', username: id,
        ...(options.webauthn ? { passkeys: [{ id: id + '-passkey', publicKey: Buffer.from('fixture-public-key').toString('base64'), rpID: 'fixture.example', counter: 0 }] } : {}) })), value => value.id);
    const auth = createDiskAuth({ dataDir, ...(options.webauthn ? { webauthn: async () => options.webauthn } : {}) }), store = createTelegramDriveStore({ dataDir }), operations = createDiskOperations({ dataDir });
    store.createDirectory('alice', '甲目录', 30); store.createDirectory('bob', '乙目录', 30);
    store.putMetadataObject(auth.user('alice'), '甲目录', '甲.txt', 'text/plain', {}, 30);
    store.putMetadataObject(auth.user('bob'), '乙目录', '乙.txt', 'text/plain', {}, 30);
    let api, time = Date.now();
    const sessions = createDiskAccountSessions({ keyForRequest: () => auth.sessionKey, user: id => auth.user(id), now: () => time,
        isRevoked: value => api.isContentSessionRevoked(value) });
    api = createDiskAPI({ dataDir, auth, defaultStore: store, operations, telegram: options.telegram || {}, getIdentity: req => sessions.identity(req),
        setIdentity: (req, res, value) => sessions.set(req, res, value), getOrigin: req => options.webauthn ? 'https://fixture.example' : req.protocol + '://' + req.get('host'),
        isMockRequest: () => !options.webauthn, getDefaultBackend: () => ({ token: 'fixture-only', channelId: '-1001', baseUrl: 'https://example.invalid' }), maxDepth: () => 30, contentCleanupMode: 'observe' });
    const app = express(); app.use(express.json());
    sessions.registerRoutes(app, { origin: req => req.protocol + '://' + req.get('host'), revoke: req => api.revokeContentSession(req) });
    app.post('/fixture-login/:id', (req, res) => { try { sessions.set(req, res, auth.user(req.params.id)); res.json({ ok: true }); } catch (error) { res.status(422).json({ error: error.message }); } });
    app.get('/fixture-me', (req, res) => res.json({ identity: sessions.identity(req), fingerprint: req.diskSessionCookie ? crypto.createHash('sha256').update(req.diskSessionCookie).digest('hex') : '' }));
    app.use('/api/telegram/drive', api.browser);
    let server;
    for (let i = 0; i < 12; i++) {
        server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
        try { await fetch('http://127.0.0.1:' + server.address().port + '/fixture-me'); break; } catch (_) { await new Promise(resolve => server.close(resolve)); server = null; }
    }
    assert.ok(server);
    const base = 'http://127.0.0.1:' + server.address().port, jar = new Map();
    const call = async (route, body, { accountId, method = body ? 'POST' : 'GET', headers = {}, cookie, updateCookies = true, rawBody } = {}) => {
        const response = await fetch(base + route, { method, headers: { Cookie: cookie ?? [...jar].map(([key, value]) => key + '=' + value).join('; '),
            ...(accountId ? { 'X-Disk-Account': accountId } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(rawBody !== undefined ? { body: rawBody } : body ? { body: JSON.stringify(body) } : {}) });
        if (updateCookies) for (const value of response.headers.getSetCookie()) { const [name, token] = value.split(';')[0].split('='); if (/Max-Age=0(?:;|$)/.test(value)) jar.delete(name); else jar.set(name, token); }
        return { response, data: await response.json() };
    };
    t.after(async () => { api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); repository.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    return { sessions, call, jar, auth, repository, api, advance: milliseconds => { time += milliseconds; } };
}

test('两个账号同时保留；显式 selector 只选择已签名 Cookie，分区数据与默认切换隔离', async t => {
    const { call, jar } = await fixture(t);
    const first = await call('/fixture-login/alice', {}); assert.equal(first.response.status, 200);
    assert.ok(first.response.headers.getSetCookie().every(value => /HttpOnly/.test(value) && /SameSite=Lax/.test(value)));
    const before = (await call('/fixture-me', null, { accountId: 'alice' })).data;
    await call('/fixture-login/bob', {});
    const list = await call('/api/telegram/drive/accounts'); assert.equal(list.data.accounts.length, 2); assert.equal(list.data.identity.id, 'bob');
    assert.ok(list.data.accounts.every(value => value.identity.passkeys === undefined && value.token === undefined));
    const alice = await call('/api/telegram/drive/list?path=' + encodeURIComponent('甲目录'), null, { accountId: 'alice' });
    const bob = await call('/api/telegram/drive/list?path=' + encodeURIComponent('乙目录'), null, { accountId: 'bob' });
    assert.equal(alice.data.files[0].name, '甲.txt'); assert.equal(bob.data.files[0].name, '乙.txt');
    assert.equal((await call('/fixture-me', null, { accountId: 'alice' })).data.fingerprint, before.fingerprint, '另一账号登录不改变已有账号的 PoP session');
    assert.equal((await call('/api/telegram/drive/list?disk_account=mallory')).response.status, 401);
    assert.equal((await call('/api/telegram/drive/list?disk_account=bob', null, { accountId: 'alice' })).response.status, 401);
    assert.equal((await call('/api/telegram/drive/accounts/select', { accountId: 'mallory' })).response.status, 401);
    const cookie = jar.get('drop2tunnel_telegram_drive'); const fake = Buffer.from(JSON.stringify({ id: 'mallory', version: 2, exp: Date.now() + 10000 })).toString('base64url');
    assert.equal((await call('/api/telegram/drive/list', null, { cookie: 'drop2tunnel_telegram_drive=' + fake + '.' + cookie.split('.')[1] })).response.status, 401);
    assert.equal((await call('/api/telegram/drive/accounts/select', { accountId: 'alice' }, { headers: { Origin: 'https://evil.invalid' } })).response.status, 403);
    await call('/api/telegram/drive/accounts/select', { accountId: 'alice' });
    assert.equal((await call('/fixture-me')).data.identity.id, 'alice');
});

test('退出单个账号撤销其旧 Cookie，另一个账号及登录有效期独立', async t => {
    const { call, jar, advance, repository } = await fixture(t);
    await call('/fixture-login/alice', {}); const oldAlice = [...jar].map(([key, value]) => key + '=' + value).join('; ');
    advance(86400000); await call('/fixture-login/bob', {});
    advance(6 * 86400000 + 1);
    const accounts = (await call('/api/telegram/drive/accounts')).data.accounts;
    assert.equal(accounts.find(value => value.identity.id === 'alice').reauthRequired, true);
    assert.equal(accounts.find(value => value.identity.id === 'bob').reauthRequired, false);
    assert.equal((await call('/api/telegram/drive/list', null, { accountId: 'alice' })).response.status, 401);
    assert.equal((await call('/api/telegram/drive/list', null, { accountId: 'bob' })).response.status, 200);
    // Reauthenticate only expired Alice, then remove her; Bob remains usable.
    await call('/fixture-login/alice', {}); const renewed = [...jar].map(([key, value]) => key + '=' + value).join('; ');
    const removed = await call('/api/telegram/drive/accounts/alice', null, { method: 'DELETE' }); assert.equal(removed.data.identity.id, 'bob');
    assert.equal((await call('/api/telegram/drive/list', null, { cookie: renewed, accountId: 'alice', updateCookies: false })).response.status, 401);
    assert.equal((await call('/api/telegram/drive/list', null, { cookie: oldAlice, accountId: 'alice', updateCookies: false })).response.status, 401);
    assert.equal((await call('/api/telegram/drive/list')).response.status, 200);
    const revoked = repository.content.write(db => db.prepare('SELECT count(*) AS n FROM disk_content_revoked_sessions').get().n);
    assert.equal(revoked, 1);
});

test('兼容单个旧版本签名 Cookie；添加第二账号保留旧账号稳定身份', async t => {
    const { call, jar, auth } = await fixture(t);
    const body = Buffer.from(JSON.stringify({ id: 'alice', version: 2, exp: Date.now() + 7 * 86400000 })).toString('base64url');
    const token = body + '.' + crypto.createHmac('sha256', auth.sessionKey).update(body).digest('base64url');
    jar.set('drop2tunnel_telegram_drive', token);
    await call('/fixture-login/bob', {});
    assert.equal((await call('/api/telegram/drive/accounts')).data.accounts.length, 2);
    assert.equal((await call('/fixture-me', null, { accountId: 'alice' })).data.identity.id, 'alice');
});

test('切换默认 Cookie 后，旧账号的 Content 复用票据仍绑定其自身会话并可完成附着', async t => {
    const { call, jar, sessions, repository } = await fixture(t), bytes = Buffer.from('stable-content');
    const contentSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    repository.replace('files', [{ id: 'proof-source', ownerId: 'alice', name: '源.bin', folderPath: '', size: bytes.length, contentSha256,
        channelId: '-1001', parts: [{ offset: 0, size: bytes.length, fileId: 'isolated-proof', messageId: 123, messageDate: Date.now() }] }], file => file.id);
    const proof = createContentProof({ content: repository.content, validate: async () => true, open: async () => { throw Error('owner reuse should not sample remote body'); } });
    const req = () => { const value = { headers: { cookie: [...jar].map(([key, token]) => key + '=' + token).join('; '), 'x-disk-account': 'alice' }, diskScope: { diskSpace: '' } }; value.diskUser = sessions.identity(value); return value; };
    await call('/fixture-login/alice', {});
    const file = { name: '副本.bin', type: 'application/octet-stream', size: bytes.length, contentSha256 };
    const before = req(), ticket = await proof.preflight(before, file, ''); assert.equal(ticket.status, 'reuse');
    await call('/fixture-login/bob', {}); const after = req();
    assert.equal(proof.authorization(before).session, proof.authorization(after).session);
    assert.equal(proof.consume(after, { ...file, reuseTicket: ticket.reuseTicket }, '').id, repository.load('files')[0].contentId);
    await call('/api/telegram/drive/accounts/bob', null, { method: 'DELETE' });
    proof.assertAuthorization(proof.authorization(req()));
});

test('Passkey 添加其它账号与给原账号绑定通行密钥分离；默认账号变化不改变显式发起身份', async t => {
    const { call, repository } = await fixture(t, { webauthn: {
        generateAuthenticationOptions: async () => ({ challenge: 'fixture-auth-challenge' }),
        verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: 1 } }),
        generateRegistrationOptions: async () => ({ challenge: 'fixture-register-challenge' }),
        verifyRegistrationResponse: async () => ({ verified: true, registrationInfo: { credential: { id: 'alice-second-passkey', publicKey: new Uint8Array([1, 2, 3]), counter: 0 } } })
    } });
    await call('/fixture-login/alice', {});
    const add = await call('/api/telegram/drive/passkeys/login/options', { username: 'bob', addAccount: true }, { accountId: 'alice' });
    assert.equal(add.response.status, 200);
    const login = await call('/api/telegram/drive/passkeys/verify', { flow_id: add.data.flow_id, response: { id: 'bob-passkey' }, addAccount: true }, { accountId: 'alice' });
    assert.equal(login.data.identity.id, 'bob'); assert.equal((await call('/api/telegram/drive/accounts')).data.accounts.length, 2);
    const bind = await call('/api/telegram/drive/passkeys/register/options', { username: 'alice', addAccount: false }, { accountId: 'alice' });
    assert.equal(bind.response.status, 200);
    await call('/api/telegram/drive/accounts/select', { accountId: 'bob' });
    const result = await call('/api/telegram/drive/passkeys/verify', { flow_id: bind.data.flow_id, response: { id: 'alice-second-passkey' }, addAccount: false }, { accountId: 'alice' });
    assert.equal(result.data.identity.id, 'alice');
    const users = repository.load('users');
    assert.ok(users.find(user => user.id === 'alice').passkeys.some(key => key.id === 'alice-second-passkey'));
    assert.ok(!users.find(user => user.id === 'bob').passkeys.some(key => key.id === 'alice-second-passkey'));
    const mismatch = await call('/api/telegram/drive/passkeys/register/options', { username: 'alice', addAccount: false }, { accountId: 'alice' });
    const rejected = await call('/api/telegram/drive/passkeys/verify', { flow_id: mismatch.data.flow_id, response: { id: 'unexpected-key' }, addAccount: false }, { accountId: 'bob' });
    assert.equal(rejected.data.error, 'PASSKEY_FLOW_INVALID');
});

test('真实 HTTP 渐进上传跨默认账号切换后仍只向发起者提交，另一账号不能接管分片', async t => {
    let id = 100;
    const { call } = await fixture(t, { telegram: {
        async pushChunk(_backend, _file, part, update, context) {
            await context.onState('pushing', { attempt: 1 }); let bytes = 0;
            for await (const chunk of part.streamFactory(context.signal)) { bytes += chunk.length; update({ telegramPartBytesSent: bytes }); }
            await part.awaitSourceComplete(context.signal);
            const remote = { ...part, streamFactory: undefined, awaitSourceComplete: undefined, fileId: 'fixture-upload-' + ++id, messageId: id, messageDate: Date.now() };
            await context.onConfirmed(remote); await context.onState('push_confirmed'); return remote;
        },
        async finalizeGroups(_backend, _file, parts, context) { await context.onGroupConfirmed(parts, 0); return parts; }, remove: async () => {}
    } });
    await call('/fixture-login/alice', {});
    const started = await call('/api/telegram/drive/uploads', { progressive: true, folderPath: '甲目录', files: [{ name: '新正文.txt', type: 'text/plain', size: 5 }] }, { accountId: 'alice' });
    assert.equal(started.response.status, 201);
    await call('/fixture-login/bob', {});
    const uploadId = started.data.uploadId, route = '/api/telegram/drive/uploads/' + uploadId;
    const rejected = await call(route + '/files/0', null, { accountId: 'bob', method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-4/5' }, rawBody: 'wrong' });
    assert.equal(rejected.response.status, 404);
    const sent = await call(route + '/files/0', null, { accountId: 'alice', method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-4/5' }, rawBody: 'hello' });
    assert.equal(sent.response.status, 200);
    const finish = await call(route + '/finish', {}, { accountId: 'alice' }); assert.ok(finish.response.ok);
    let terminal;
    for (let i = 0; i < 250; i++) { const result = await call('/api/telegram/drive/operations/' + started.data.operation_id, null, { accountId: 'alice' }); if (['completed', 'failed', 'cancelled'].includes(result.data.status)) { terminal = result.data; break; } await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(terminal?.status, 'completed', terminal?.errorCode);
    const source = (await call('/api/telegram/drive/list?path=' + encodeURIComponent('甲目录'), null, { accountId: 'alice' })).data.files;
    const other = (await call('/api/telegram/drive/list?path=' + encodeURIComponent('乙目录'), null, { accountId: 'bob' })).data.files;
    assert.ok(source.some(file => file.name === '新正文.txt' && file.size === 5)); assert.ok(!other.some(file => file.name === '新正文.txt'));
});

test('客户端账号切换后上传 XHR、SSE、完成等待仍绑定原账号；当前界面不混入旧任务', async () => {
    const requests = [], xhrs = [], streams = [], snapshots = [], window = {}; let finished = false;
    class XHR {
        constructor() { this.headers = {}; this.events = {}; this.upload = { addEventListener() {} }; }
        open(method, url) { this.url = url; this.method = method; }
        setRequestHeader(key, value) { this.headers[key] = value; }
        addEventListener(name, run) { this.events[name] = run; }
        send() { xhrs.push(this); }
        abort() { this.events.abort?.(); }
    }
    class EventSource { constructor(url) { this.url = url; this.events = {}; streams.push(this); } addEventListener(name, run) { this.events[name] = run; } close() {} }
    const fetch = async (url, options = {}) => {
        const parsed = new URL(url, 'http://fixture.test'), id = options.headers?.['X-Disk-Account'] || ''; requests.push({ url, options, id }); let data = {};
        if (parsed.pathname.endsWith('/uploads')) data = { uploadId: 'alice-upload', operation_id: 'alice-task', progressive: true };
        else if (parsed.pathname.endsWith('/finish')) { finished = true; data = { operation_id: 'alice-task' }; }
        else if (parsed.pathname.endsWith('/operations')) data = { operations: id === 'alice' ? [{ operation_id: 'alice-task', type: 'upload', status: finished ? 'completed' : 'running', result: { items: [{ id: 'saved-alice' }] } }] : [] };
        return { ok: true, json: async () => data };
    };
    vm.runInNewContext(source, { window, fetch, location: { origin: 'http://fixture.test' }, URL, URLSearchParams, XMLHttpRequest: XHR, EventSource, AbortController, setInterval() {}, setTimeout, clearTimeout });
    const client = window.DiskClient; client.setAccount('alice'); client.subscribe(jobs => snapshots.push(jobs.map(value => value.operation_id)));
    const initialContext = client.context();
    const upload = client.upload([{ name: '正文.bin', size: 10 }], '', async () => ({ size: 10, slice: () => ({ size: 10 }) }), { transportContext: initialContext });
    for (let i = 0; i < 100 && !xhrs.length; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(xhrs.length, 1); assert.equal(xhrs[0].headers['X-Disk-Account'], 'alice');
    assert.equal(new URL(streams[0].url, 'http://fixture.test').searchParams.get('disk_account'), 'alice');
    initialContext.accountId = 'bob'; initialContext.diskSpace = '后来切换的分区';
    client.setAccount('bob'); await new Promise(resolve => setImmediate(resolve)); await client.refresh(true);
    assert.equal(snapshots.at(-1).length, 0);
    xhrs[0].status = 200; xhrs[0].responseText = '{}'; xhrs[0].events.load();
    const result = await upload; assert.equal(result.items[0].id, 'saved-alice');
    assert.equal(requests.find(request => request.url.includes('/finish')).id, 'alice');
    assert.ok(requests.filter(request => request.url.includes('/alice-upload')).every(request => request.id === 'alice'));
    const stream = client.streamUrl({ id: 'old-file', diskTransportContext: { requestBase: '/api/telegram/drive', diskSpace: '', accountId: 'alice' } });
    assert.equal(new URL(stream, 'http://fixture.test').searchParams.get('disk_account'), 'alice');
    assert.equal(snapshots.at(-1).length, 0); client.stop();
});

test('一个账号轮询失效仅结束自己的等待，不影响另一个账号的后台任务', async () => {
    const window = {}; let expire = false, complete = false;
    const fetch = async (_url, options) => {
        const id = options.headers['X-Disk-Account'];
        if (expire && id === 'alice') return { ok: false, status: 401, json: async () => ({ error: 'LOGIN_REQUIRED' }) };
        return { ok: true, json: async () => ({ operations: complete && id === 'bob' ? [{ operation_id: 'bob-task', status: 'completed', result: { ok: true } }] : [] }) };
    };
    vm.runInNewContext(source, { window, fetch, location: { origin: 'http://fixture.test' }, URL, AbortController, setInterval() {}, setTimeout, clearTimeout });
    const client = window.DiskClient; client.setAccount('alice');
    const first = client.wait('alice-task'); const rejected = assert.rejects(first, /LOGIN_REQUIRED/);
    client.setAccount('bob'); const second = client.wait('bob-task');
    await client.refresh(true); expire = true; await new Promise(resolve => setImmediate(resolve)); await client.refresh(true); await rejected;
    complete = true; await client.refresh(true); assert.equal((await second).ok, true); client.stop();
});

test('上传创建被幂等记录拒绝时，释放本次内容票据且不误通知其它上传任务失败', async () => {
    const window = {}, requests = [];
    class Worker { postMessage() { queueMicrotask(() => this.onmessage({ data: { sha256: 'a'.repeat(64) } })); } terminate() {} }
    const fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (url.endsWith('/content/preflight')) return { ok: true, json: async () => ({ files: [{ status: 'reuse', reuseTicket: 'this-attempt-ticket' }] }) };
        if (url.endsWith('/uploads')) { window.DiskClient.setAccount('bob'); return { ok: false, status: 409, json: async () => ({ error: 'PENDING_SAVE_ALREADY_STARTED' }) }; }
        return { ok: true, json: async () => ({ operations: [] }) };
    };
    vm.runInNewContext(source, { window, fetch, Worker, queueMicrotask, AbortController, location: { origin: 'http://fixture.test' }, URL, setInterval() {}, setTimeout, clearTimeout });
    const client = window.DiskClient; client.setAccount('alice');
    await assert.rejects(client.upload([{ name: '正文.bin', size: 4 }], '', async () => new Blob(['body'])), /PENDING_SAVE_ALREADY_STARTED/);
    const release = requests.find(value => value.url.endsWith('/content/release'));
    assert.equal(release.options.headers['X-Disk-Account'], 'alice'); assert.deepEqual(JSON.parse(release.options.body).tickets, ['this-attempt-ticket']);
    assert.ok(!requests.some(value => value.url.endsWith('/failure') || value.options.method === 'DELETE'));
    client.stop();
});

test('后台浏览器缓存下载绑定发起账号，切换后其进度不污染另一个账号', async () => {
    const window = {}, requests = []; let resume;
    const pending = new Promise(resolve => { resume = resolve; }); let chunk = 0;
    const fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (url.includes('/operations?')) return { ok: true, json: async () => ({ operations: [] }) };
        return { ok: true, headers: { get: key => key === 'Content-Length' ? '4' : '' }, body: { getReader: () => ({ read: async () => {
            chunk++; if (chunk === 1) return { done: false, value: new Uint8Array([1, 2]) };
            if (chunk === 2) { await pending; return { done: false, value: new Uint8Array([3, 4]) }; }
            return { done: true };
        } }) } };
    };
    vm.runInNewContext(source, { window, fetch, AbortController, Blob, location: { origin: 'http://fixture.test' }, URL, setInterval() {}, setTimeout, clearTimeout });
    const client = window.DiskClient; client.setAccount('alice');
    const reading = client.read({ id: 'shared-logical-file', name: '正文.bin', size: 4 });
    for (let i = 0; i < 100 && chunk < 2; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.cacheProgress('shared-logical-file').percent, 50); assert.equal(client.isCaching('shared-logical-file'), true);
    client.setAccount('bob'); assert.equal(client.cacheProgress('shared-logical-file'), null); assert.equal(client.isCaching('shared-logical-file'), false);
    assert.equal(requests.find(value => value.url.endsWith('/download')).options.headers['X-Disk-Account'], 'alice');
    resume(); assert.equal((await reading).size, 4); client.stop();
});

function accountUiFixture(remaining = { identity: { id: 'bob' }, accounts: [{ identity: { id: 'bob' } }] }) {
    const ui = fs.readFileSync(path.join(__dirname, '../client/disk-ui.js'), 'utf8');
    const start = ui.indexOf('function rememberTelegramDriveActiveAccount('), end = ui.indexOf('\nfunction appendTelegramDriveAddAccount(', start);
    const logoutStart = ui.indexOf('async function logoutTelegramDrive('), logoutEnd = ui.indexOf('\nasync function manageTelegramDriveSpaces(', logoutStart);
    const startupLine = ui.split('\n').find(line => line.includes("const saved = telegramDriveEntryQuery.get('disk_account')"));
    // Every execution below represents a fresh page load, with a fresh entry snapshot.
    const startupSelection = startupLine && `(() => { const telegramDriveEntryQuery = new URLSearchParams(location.search); ${startupLine} })();`;
    assert.ok(start >= 0 && end > start && logoutStart >= 0 && logoutEnd > logoutStart && startupSelection, '测试使用实际账号记录、切换、退出函数与实际启动解析逻辑');
    const storage = new Map([['telegram-drive-active-account', 'alice']]), records = [], requested = [], stopped = [], events = [], previewOptions = [];
    let accountId = 'alice';
    const location = { href: 'https://fixture.example/disk?disk_account=alice&pendingSave=pending-id&collaboration=alice-grant#record', pathname: '/disk',
        search: '?disk_account=alice&pendingSave=pending-id&collaboration=alice-grant', origin: 'https://fixture.example' };
    const history = { state: { retained: true, diskAccountId: 'alice', telegramDrivePath: '甲目录', diskMountContext: { id: 'old-mount' } },
        replaceState(state, _title, target) { this.state = state; const address = new URL(target, location.href); location.href = address.href; location.pathname = address.pathname; location.search = address.search; records.push({ state, url: address.href }); } };
    const client = { raw: async (route, options) => { requested.push({ route, options }); return route === '/accounts' ? remaining : { identity: { id: 'bob' } }; },
        accountOperations: async id => ({ accountId:id,operations:[] }),
        json: (method, body) => ({ method, body: JSON.stringify(body) }), setAccount: value => { accountId = value; }, getAccount: () => accountId,
        setMount() {}, setCollaboration() {}, setSpace() {}, stopAccount: value => stopped.push(value) };
    const context = vm.createContext({ window: { DiskClient: client }, location, history, URL, URLSearchParams,
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        rememberTelegramDriveAccountView() {}, cancelTelegramDrivePendingMount() { events.push('cancel-mount'); }, closeDiskCollaborationFrame() { events.push('close-frame'); }, closeDiskPreview(options) { previewOptions.push(options); },
        confirmTelegramDriveAction: async () => true, showAppToast() {},
        clearTelegramDriveSearch() {}, clearTelegramDriveSelection() {}, renderTelegramDrive: async () => {},
        telegramDriveEntryPending: false, telegramDriveNavigationVersion: 0, telegramDriveRenderGeneration: 0, telegramDriveMountContext: { id: 'old-mount' }, telegramDrivePath: '甲目录', telegramDriveCurrentData: {}, telegramDriveStaticLinks: [], telegramDriveSpaceOwner: 'alice', telegramDriveSpaces: [] });
    vm.runInContext(ui.slice(start, end) + '\n' + ui.slice(logoutStart, logoutEnd), context);
    return { context, location, history, storage, records, requested, stopped, events, previewOptions, client, startupSelection };
}

test('从显式账号链接切换后更新地址和历史状态；刷新采用新账号且保留待转存恢复参数', async () => {
    const { context, client, location, storage, records, requested, previewOptions, startupSelection } = accountUiFixture();
    await context.switchTelegramDriveAccount('bob');
    assert.equal(requested[0].route, '/accounts/select'); assert.equal(JSON.parse(requested[0].options.body).accountId, 'bob');
    assert.equal(records.at(-1).state.diskAccountId, 'bob'); assert.equal(records.at(-1).state.diskMountContext, null);
    const updated = new URL(location.href);
    assert.equal(updated.searchParams.get('disk_account'), 'bob'); assert.equal(updated.searchParams.get('pendingSave'), 'pending-id');
    assert.equal(updated.hash, '#record'); assert.equal(updated.searchParams.has('collaboration'), false, '不能刷新后重放前一账号的协同定位');
    assert.equal(previewOptions[0]?.replaceHistory, true, '切换账号不得通过关闭预览的history.back恢复旧账号URL');
    client.setAccount(''); storage.set('telegram-drive-active-account', 'alice');
    vm.runInContext(startupSelection, context); assert.equal(client.getAccount(), 'bob', '刷新时URL的新账号优先于其它页面写入的localStorage账号');
});

test('退出当前账号后URL与剩余账号一致，最后退出清除选择器，退出其它账号不改变当前浏览状态', async t => {
    await t.test('退出当前账号后刷新仍选择剩余账号', async () => {
        const { context, client, location, history, storage, stopped, events, previewOptions, startupSelection } = accountUiFixture();
        await context.logoutTelegramDrive('alice');
        assert.deepEqual(stopped, ['alice']); assert.equal(client.getAccount(), 'bob');
        assert.equal(history.state.diskAccountId, 'bob'); assert.equal(history.state.diskMountContext, null); assert.equal(context.telegramDriveMountContext, null);
        assert.equal(new URL(location.href).searchParams.get('disk_account'), 'bob'); assert.equal(new URL(location.href).searchParams.has('collaboration'), false);
        assert.equal(new URL(location.href).searchParams.get('pendingSave'), 'pending-id'); assert.equal(new URL(location.href).hash, '#record');
        assert.equal(storage.get('telegram-drive-active-account'), 'bob'); assert.ok(events.includes('close-frame'));
        assert.equal(previewOptions[0]?.replaceHistory, true, '退出账号不得通过关闭预览的history.back恢复已退出账号URL');
        client.setAccount(''); vm.runInContext(startupSelection, context); assert.equal(client.getAccount(), 'bob');
    });
    await t.test('最后一个账号退出后清除URL和本地活跃身份', async () => {
        const { context, client, location, history, storage, startupSelection } = accountUiFixture({ identity: null, accounts: [] });
        await context.logoutTelegramDrive('alice');
        assert.equal(client.getAccount(), ''); assert.equal(history.state.diskAccountId, '');
        assert.equal(new URL(location.href).searchParams.has('disk_account'), false); assert.equal(storage.has('telegram-drive-active-account'), false);
        assert.equal(new URL(location.href).searchParams.get('pendingSave'), 'pending-id'); assert.equal(new URL(location.href).hash, '#record');
        vm.runInContext(startupSelection, context); assert.equal(client.getAccount(), '');
    });
    await t.test('退出非当前账号保留当前账号URL、路径和挂载导航', async () => {
        const { context, client, location, history, storage, records, stopped, events } = accountUiFixture();
        const originalUrl = location.href, originalState = history.state, originalMount = context.telegramDriveMountContext;
        await context.logoutTelegramDrive('bob');
        assert.deepEqual(stopped, ['bob']); assert.equal(client.getAccount(), 'alice'); assert.equal(location.href, originalUrl);
        assert.equal(history.state, originalState); assert.equal(context.telegramDriveMountContext, originalMount); assert.equal(context.telegramDrivePath, '甲目录');
        assert.equal(storage.get('telegram-drive-active-account'), 'alice'); assert.equal(records.length, 0);
        assert.deepEqual(events, [], '退出其它账号不得取消当前账号的挂载导航或关闭其协同浮层');
    });
});
