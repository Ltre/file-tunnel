'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const express = require('express');
const { createDiskAPI } = require('../server/disk-api');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskOperations } = require('../server/disk-operations');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { openDiskRepository } = require('../server/disk-repository');
const { createDiskMetadataTiming } = require('../server/disk-metadata-timing');
const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));

function temporary(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-directory-performance-'));
    t.after(() => { openDiskRepository(dir).close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return dir;
}

test('列表单次汇总的递归大小、数量和时间与属性一致，空目录及其它用户正确隔离', t => {
    const dataDir = temporary(t), repository = openDiskRepository(dataDir);
    const files = [
        { id: 'root', ownerId: 'u', folderPath: '', name: 'root.txt', size: 3, createdAt: 100 },
        { id: 'direct', ownerId: 'u', folderPath: 'parent/a', name: 'direct.txt', size: 5, updatedAt: 200 },
        { id: 'nested', ownerId: 'u', folderPath: 'parent/a/deep/leaf', name: 'nested.txt', size: 7, createdAt: 300 },
        { id: 'sibling', ownerId: 'u', folderPath: 'parent/ab', name: 'sibling.txt', size: 11, updatedAt: 400 },
        { id: 'other', ownerId: 'other', folderPath: 'parent/a', name: 'other.txt', size: 99, updatedAt: 900 }
    ];
    repository.replaceMany([{ table: 'files', items: files, keyOf: item => item.id }]);
    const store = createTelegramDriveStore({ dataDir });
    store.createDirectory('u', 'parent/empty/deep', 20);
    for (const folder of store.list('u', 'parent').folders) {
        const expected = store.getDirectory('u', folder.path);
        for (const key of ['fileCount', 'folderCount', 'size', 'updatedAt', 'createdAt', 'reviewStatus']) assert.equal(folder[key], expected[key], `${folder.path}: ${key}`);
    }
    assert.equal(store.list('u', 'parent').summary.fileCount, 0);
    assert.equal(store.list('u', 'parent/a').files[0].id, 'direct');
    assert.equal(store.list('u', 'parent/a').summary.size, 5);
    assert.equal(store.list('u', 'parent/empty/deep').folders.length, 0);
    assert.equal(store.list('u', 'parent/empty/deep').files.length, 0);
});

test('新建目录只持久化目录，不遍历或改写文件及其分片记录', t => {
    const dataDir = temporary(t), repository = openDiskRepository(dataDir), store = createTelegramDriveStore({ dataDir });
    const tables = [], original = repository.replaceMany.bind(repository);
    t.mock.method(repository, 'replaceMany', changes => { tables.push(...changes.map(change => change.table)); return original(changes); });
    store.createDirectory('u', 'a/b/c', 20);
    assert.deepEqual(tables, ['directories']);
    assert.deepEqual(repository.load('directories').map(item => item.path), ['a', 'a/b', 'a/b/c']);
});

async function apiFixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-directory-http-'));
    const auth = createDiskAuth({ dataDir }), user = auth.fromTelegram({ id: '1' });
    const store = createTelegramDriveStore({ dataDir }), operations = createDiskOperations({ dataDir });
    let release, started;
    const captionStarted = new Promise(resolve => { started = resolve; });
    const captionPending = new Promise(resolve => { release = resolve; });
    const api = createDiskAPI({ dataDir, defaultStore: store, auth, operations,
        telegram: { syncCaption: async () => { started(); await captionPending; } },
        getIdentity: req => req.get('X-Test-Logout') ? null : user,
        getDefaultBackend: () => ({ token: 'test', channelId: '-1001' }),
        setIdentity() {}, getOrigin: () => 'http://localhost', isMockRequest: () => true, maxDepth: () => 20 });
    const app = express(); app.use(express.json()); app.use('/disk', api.browser);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { release(); api.close(); await new Promise(resolve => server.close(resolve)); openDiskRepository(dataDir).close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    const request = async (url, options = {}) => {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/disk' + url, options);
        return { response, data: await response.json() };
    };
    return { dataDir, store, operations, user, request, captionStarted, release };
}
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('本地目录任务的 202 响应直接返回已完成结果，仍保留任务 ID 和服务端身份校验', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await apiFixture(t);
    const { response, data } = await f.request('/directories', json({ path: 'empty' }));
    assert.equal(response.status, 202); assert.equal(data.status, 'completed'); assert.equal(data.result.path, 'empty');
    assert.equal(f.operations.get(data.operation_id, { userId: f.user.id }).status, 'completed');
    assert.match(response.headers.get('server-timing'), /disk-metadata;dur=\d/);
    assert.ok(response.headers.get('x-disk-request-id'));
    const logged = fs.readFileSync(path.join(f.dataDir, 'disk-upload.log'), 'utf8').trim().split('\n').map(JSON.parse);
    const request = logged.find(row => row.event === 'metadata.request');
    assert.equal(request.requestId, response.headers.get('x-disk-request-id')); assert.equal(request.operationId, data.operation_id);
    const denied = await f.request('/list', { headers: { 'X-Test-Logout': '1' } });
    assert.equal(denied.response.status, 401); assert.equal(denied.data.error, 'LOGIN_REQUIRED');
});

test('共享内容改名不等待 Telegram，后续新建和空目录读取及时完成，耗时可关联', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await apiFixture(t);
    f.store.createDirectory(f.user.id, 'empty', 20);
    openDiskRepository(f.dataDir).replaceMany([{ table: 'files', items: [{ id: 'f', ownerId: f.user.id, name: 'a.txt', folderPath: '', size: 1, messageId: 1, fileId: 'remote', channelId: '-1001' }], keyOf: item => item.id }]);
    f.store.reloadPersistence();
    const rename = await f.request('/files/f', { ...json({ name: 'b.txt' }), method: 'PATCH' });
    const mkdir = await f.request('/directories', json({ path: 'new' }));
    const list = await f.request('/list?path=empty');
    assert.equal(list.response.status, 200); assert.deepEqual(list.data.files, []);
    for (let i = 0; i < 30 && f.operations.get(mkdir.data.operation_id, { userId: f.user.id }).status !== 'completed'; i++) await turn();
    assert.equal(f.operations.get(rename.data.operation_id, { userId: f.user.id }).status, 'completed');
    assert.equal(f.store.getDirectory(f.user.id, 'new').path, 'new');
    const rows = fs.readFileSync(path.join(f.dataDir, 'disk-upload.log'), 'utf8').trim().split('\n').map(JSON.parse);
    const completed = rows.find(row => row.event === 'metadata.mutation-end' && row.operationId === mkdir.data.operation_id);
    assert.ok(completed.queuedMs >= 0); assert.ok(completed.workMs >= 0);
});

function clientFixture(fetch) {
    const window = {};
    vm.runInNewContext(source('client/disk-client.js'), { window, fetch, setInterval() {}, Date, Map, Set, Promise, encodeURIComponent });
    return window.DiskClient;
}

test('新建目录的已完成响应不必再等待任务轮询', async () => {
    const result = { path: 'new' };
    const client = clientFixture(async () => ({ ok: true, json: async () => ({ operation_id: 'mkdir', status: 'completed', result }) }));
    assert.equal(await client.request('/directories', json({ path: 'new' })), result);
});

test('已有轮询先发出时，新登记的等待任务必须重新查询结果，不能误用省略的 result', async () => {
    const requests = [], deferred = [];
    const client = clientFixture(url => {
        requests.push(url); return new Promise(resolve => deferred.push(data => resolve({ ok: true, json: async () => data })));
    });
    client.start();
    let resolved = false;
    const waiting = client.wait('mkdir').then(value => { resolved = true; return value; });
    deferred[0]({ operations: [{ operation_id: 'mkdir', status: 'completed' }] });
    await turn();
    assert.equal(resolved, false); assert.equal(requests.length, 2);
    assert.ok(requests[1].endsWith('ids=mkdir'));
    deferred[1]({ operations: [{ operation_id: 'mkdir', status: 'completed', result: { path: 'new' } }] });
    assert.equal((await waiting).path, 'new');
});

test('慢元数据请求有受控诊断，快列表不写日志，不包含请求正文或 Cookie', () => {
    let time = 0; const logs = [], handlers = {}, headers = {};
    const middleware = createDiskMetadataTiming((event, fields) => logs.push({ event, ...fields }), { now: () => time });
    const run = elapsed => {
        const req = { method: 'GET', path: '/list', headers: { cookie: 'private' }, body: { secret: 'private' } };
        const res = { headersSent: false, statusCode: 200, writableFinished: true,
            json: data => data, set: (key, value) => { headers[key] = value; }, append: (key, value) => { headers[key] = value; }, once: (event, callback) => { handlers[event] = callback; } };
        middleware(req, res, () => {}); time += elapsed; res.json({ files: [] }); handlers.finish(); handlers.close();
    };
    run(5); assert.equal(logs.length, 0);
    run(1500); assert.equal(logs.length, 1); assert.equal(logs[0].serverMs, 1500);
    assert.match(headers['Server-Timing'], /dur=1500\.0/); assert.ok(!JSON.stringify(logs).includes('private'));
});

test('进入空目录直接刷新列表和面包屑，不再请求 /me 或重建登录 UI', async () => {
    const ui = source('client/disk-ui.js'), calls = [], breadcrumbs = [];
    const context = vm.createContext({ telegramDriveCurrentData: { path: 'old', files: [] }, telegramDrivePath: 'new', telegramDriveRenderGeneration: 0,
        document: { getElementById: () => ({ hidden: false }) }, window: { DiskClient: { raw: async url => { calls.push(url); return { path: 'new', files: [], folders: [], breadcrumbs: [{ name: 'new', path: 'new' }] }; } } },
        getTelegramDriveIdentity: () => assert.fail('目录切换不应另查身份'), renderTelegramDriveBreadcrumbs: data => breadcrumbs.push(data.path),
        renderTelegramDriveItems() {}, updateTelegramDriveSelectionBar() {}, refreshDiskCollaborations: async () => {}, refreshTelegramDriveStaticLinks: async () => {}, scheduleTelegramDriveSearch() {}, encodeURIComponent });
    vm.runInContext(ui.slice(ui.indexOf('async function renderTelegramDrive('), ui.indexOf('async function navigateTelegramDrive(')), context);
    await context.renderTelegramDrive({ contentsOnly: true });
    assert.deepEqual(calls, ['/list?path=new']); assert.deepEqual(breadcrumbs, ['new']);
    assert.equal(context.telegramDriveContentStale, false);
});

test('目录查询发现登录已失效时仍回到登录界面，不把旧账号内容继续展示', async () => {
    const ui = source('client/disk-ui.js'); let identities = 0;
    const nodes = new Map();
    const node = () => ({ hidden: false, setAttribute() {}, replaceChildren() {}, append() {} });
    const context = vm.createContext({ telegramDriveCurrentData: { path: 'old', files: [] }, telegramDrivePath: 'new', telegramDriveRenderGeneration: 0,
        telegramDriveSort: 'name', telegramDriveSortAscending: true, telegramDriveView: 'list',
        document: { getElementById: id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node },
        window: { DiskClient: { raw: async () => { throw new Error('LOGIN_REQUIRED'); }, getSpace: () => '' } },
        getTelegramDriveIdentity: async () => { identities++; return { identity: null, oidcMode: 'mock' }; },
        isTelegramDriveGlobalSearchActive: () => false, closeTelegramDriveItemMenu() {}, startTelegramDriveLogin() {}, encodeURIComponent });
    vm.runInContext(ui.slice(ui.indexOf('async function renderTelegramDrive('), ui.indexOf('async function navigateTelegramDrive(')), context);
    await context.renderTelegramDrive({ contentsOnly: true });
    assert.equal(identities, 1); assert.equal(context.telegramDriveCurrentData, null);
    assert.equal(nodes.get('telegramDriveWorkspace').hidden, true); assert.equal(nodes.get('telegramDriveLogoutBtn').hidden, true);
});

test('账号变更时重新加载身份控件，普通目录刷新不反复查身份', async () => {
    const ui = source('client/disk-ui.js'); let identities = 0;
    const context = vm.createContext({ telegramDriveCurrentData: { path: 'old', user_id: 'before' }, telegramDrivePath: 'new', telegramDriveRenderGeneration: 0,
        document: { getElementById: () => ({ hidden: false }) }, encodeURIComponent,
        window: { DiskClient: { raw: async () => ({ path: 'new', user_id: 'after', files: [] }) } },
        renderTelegramDrive: async () => { identities++; } });
    vm.runInContext(ui.slice(ui.indexOf('async function refreshTelegramDriveContents()'), ui.indexOf('async function navigateTelegramDrive(')), context);
    await context.refreshTelegramDriveContents();
    assert.equal(identities, 1); assert.equal(context.telegramDriveCurrentData, null);
});
