'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { Readable } = require('node:stream');
const express = require('express');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskAPI } = require('../server/disk-api');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { createDiskOperations } = require('../server/disk-operations');

async function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-move-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const auth = createDiskAuth({ dataDir }), owner = auth.fromTelegram({ id: '101' }), guest = auth.fromTelegram({ id: '202' });
    const store = createTelegramDriveStore({ dataDir }), operations = createDiskOperations({ dataDir });
    for (const folder of ['共享/来源/内层', '共享/目标', '共享之外/私密']) store.createDirectory(owner.id, folder, 20);
    const staged = store.begin({ owner, folderPath: '共享/来源/内层', files: [{ name: '内容.txt', size: 1 }], maxDepth: 20 });
    await store.receive(staged.id, 0, Readable.from(['x']));
    const [file] = store.commit(staged.id, '-1001', [{ fileId: 'fake-file', messageId: 10 }]);
    const api = createDiskAPI({ dataDir, defaultStore: store, auth, operations, telegram: { remove: async () => {} },
        getDefaultBackend: () => ({ token: 'fake', channelId: '-1001' }), getIdentity: req => req.get('X-Test-User') === 'owner' ? owner : guest,
        setIdentity() {}, getOrigin: () => 'http://localhost', isMockRequest: () => true, maxDepth: () => 20 });
    t.after(() => api.close());
    const app = express(); app.use(express.json()); app.use('/drive', api.browser);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/drive`;
    const call = async (url, method = 'GET', body, user = 'guest') => {
        const response = await fetch(base + url, { method, headers: { 'X-Test-User': user, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, data: await response.json() };
    };
    const invitation = await call('/collaborations/invitations', 'POST', { kind: 'directory', path: '共享' }, 'owner');
    assert.equal(invitation.status, 201);
    const token = invitation.data.url.split('/').pop();
    const joined = await call('/collaborations/join', 'POST', { token }); assert.equal(joined.status, 200);
    const id = joined.data.collaboration.id, scope = `/collaboration-scope/${id}`;
    const wait = async response => {
        assert.equal(response.status, 202, JSON.stringify(response.data));
        for (let index = 0; index < 100; index++) {
            const job = operations.get(response.data.operation_id, { userId: owner.id, diskSpace: '' });
            if (!['queued', 'running'].includes(job.status)) { assert.equal(job.status, 'completed', JSON.stringify(job)); return job.result; }
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.fail('协同移动任务超时');
    };
    return { call, scope, id, store, file, owner, guest, wait };
}

test('协同目录树只返回授权范围；新建多级目录、文件和目录跨层级移动保持数据一致', async t => {
    const f = await fixture(t), { call, scope, store, owner, file } = f;
    const tree = await call(scope + '/directories'); assert.equal(tree.status, 200);
    assert.deepEqual(tree.data.directories.map(dir => dir.path).sort(), ['共享', '共享/来源', '共享/来源/内层', '共享/目标'].sort());
    const normal = await call('/directories', 'GET', undefined, 'owner'); assert.ok(normal.data.directories.some(dir => dir.path === '共享之外/私密'));
    const created = await call(scope + '/directories', 'POST', { path: '共享/目标/新建/多级' });
    const folder = created.status === 202 ? await f.wait(created) : created.data.result;
    assert.equal(folder.path, '共享/目标/新建/多级');
    await f.wait(await call(scope + '/files/' + file.id, 'PATCH', { folderPath: '共享/目标/新建/多级' }));
    assert.equal(store.get(owner.id, file.id).folderPath, '共享/目标/新建/多级');
    await f.wait(await call(scope + '/files/' + file.id, 'PATCH', { folderPath: '共享' }));
    assert.equal(store.get(owner.id, file.id).folderPath, '共享', '面包屑根目录应可接收文件');
    await f.wait(await call(scope + '/directories', 'PATCH', { path: '共享/来源', destinationPath: '共享/目标' }));
    assert.ok(store.getDirectory(owner.id, '共享/目标/来源/内层')); assert.equal(store.getDirectory(owner.id, '共享/来源'), null);
    await f.wait(await call(scope + '/directories', 'PATCH', { path: '共享/目标/来源', destinationPath: '共享' }));
    assert.ok(store.getDirectory(owner.id, '共享/来源/内层'), '面包屑根目录应可接收目录树');
});

test('目录树与移动接口拒绝越权、移动协同根和访问其他任务；撤销成员后立即失效', async t => {
    const f = await fixture(t), { call, scope, file } = f;
    for (const response of [
        await call(scope + '/directories', 'POST', { path: '共享之外/新增' }),
        await call(scope + '/files/' + file.id, 'PATCH', { folderPath: '共享之外/私密' }),
        await call(scope + '/directories', 'PATCH', { path: '共享/来源', destinationPath: '共享之外/私密' }),
        await call(scope + '/directories', 'PATCH', { path: '共享', destinationPath: '共享/目标' })
    ]) assert.equal(response.status, 403, JSON.stringify(response.data));
    assert.equal((await call(scope + '/directories', 'POST', { path: '共享/../私密' })).status, 422);
    const ownUpload = await call('/uploads', 'POST', { folderPath: '共享', files: [{ name: 'owner.txt', size: 1 }] }, 'owner');
    assert.equal(ownUpload.status, 201);
    assert.equal((await call(scope + `/uploads/${ownUpload.data.uploadId}/queue`)).status, 403);
    const upload = await call(scope + '/uploads', 'POST', { folderPath: '共享', files: [{ name: 'guest.txt', size: 1 }] });
    assert.equal(upload.status, 201); assert.equal((await call(scope + `/uploads/${upload.data.uploadId}/queue`)).status, 200);
    await call(scope + `/uploads/${upload.data.uploadId}`, 'DELETE'); await call(`/uploads/${ownUpload.data.uploadId}`, 'DELETE', undefined, 'owner');
    assert.equal((await call(`/collaborations/${f.id}/members/${f.guest.id}`, 'DELETE', undefined, 'owner')).status, 200);
    assert.equal((await call(scope + '/directories')).status, 404);
    assert.equal((await call(scope + '/files/' + file.id, 'PATCH', { folderPath: '共享' })).status, 404);
});

test('协同 iframe 关闭只移除本层；忽略不匹配的窗口消息并保持主网盘状态', () => {
    const source = fs.readFileSync(path.join(__dirname, '../client/disk-ui.js'), 'utf8');
    const listeners = new Map(), classes = new Set(), children = [], focused = [];
    class Element {
        constructor(tag) { this.tagName = tag; this.children = []; this.contentWindow = {}; this.events = {}; }
        setAttribute() {} append(...nodes) { this.children.push(...nodes); }
        addEventListener(type, handler) { this.events[type] = handler; }
        showModal() { this.open = true; } close() { this.open = false; } remove() { this.removed = true; }
    }
    const context = vm.createContext({ URL, location: { origin: 'http://localhost' },
        window: { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) },
        document: { createElement: tag => new Element(tag), getElementById: id => ({ focus: () => focused.push(id) }),
            body: { append: node => children.push(node), classList: { add: value => classes.add(value), remove: value => classes.delete(value) } } } });
    vm.runInContext('let telegramDriveCollaborationFrame=null; let telegramDrivePath="原目录"; let telegramDriveMinimized=false;\n' +
        source.slice(source.indexOf('function closeDiskCollaborationFrame()'), source.indexOf('async function showDiskCollaborations()')), context);
    vm.runInContext('openDiskCollaborationFrame({id:"grant",name:"共享"})', context);
    const dialog = children[0], [frame, close] = dialog.children;
    assert.equal(frame.src, '/disk-collab/view/grant?embedded=1'); assert.equal(dialog.open, true);
    listeners.get('message')({ origin: 'https://other', source: frame.contentWindow, data: { type: 'disk-collaboration:close' } }); assert.equal(dialog.open, true);
    listeners.get('message')({ origin: 'http://localhost', source: {}, data: { type: 'disk-collaboration:close' } }); assert.equal(dialog.open, true);
    close.onclick(); assert.equal(dialog.open, false); assert.equal(dialog.removed, true); assert.equal(frame.src, 'about:blank'); assert.equal(listeners.size, 0);
    assert.equal(vm.runInContext('telegramDrivePath', context), '原目录'); assert.equal(vm.runInContext('telegramDriveMinimized', context), false); assert.equal(classes.size, 0);
    vm.runInContext('openDiskCollaborationFrame({id:"second",name:"共享2",mountId:"mount-1",path:"共享/子目录",fileId:"file-1"})', context);
    assert.equal(children[1].children[0].src, '/disk-collab/view/second?embedded=1&mount_id=mount-1&path=%E5%85%B1%E4%BA%AB%2F%E5%AD%90%E7%9B%AE%E5%BD%95&file_id=file-1');
    const second = children[1]; listeners.get('message')({ origin: 'http://localhost', source: second.children[0].contentWindow, data: { type: 'disk-collaboration:close' } });
    assert.equal(second.removed, true); assert.equal(listeners.size, 0); assert.equal(focused.length, 2);
});

test('所有者直接打开邀请定位主网盘，不消费邀请、不切换为受邀 iframe', async () => {
    const calls = [], redirects = [], elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { dataset: {}, addEventListener() {}, classList: { toggle() {} } });
        return elements.get(id);
    };
    const context = vm.createContext({ URLSearchParams, encodeURIComponent,
        location: { pathname: '/disk-collab/owner-token', search: '', origin: 'http://localhost', replace: url => redirects.push(url) },
        document: { getElementById: element, body: { classList: { toggle() {} } }, addEventListener() {} },
        window: { parent: null, addEventListener() {}, DiskClient: { json() {}, subscribe() {},
            raw: async url => { calls.push(url); return { invitation: { id: 'own/project', owned: true } }; },
            setCollaboration() { assert.fail('所有者不应进入受邀范围客户端'); } } } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../client/disk-collaboration.js'), 'utf8'), context);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['/api/telegram/drive/collaborations/invitations/owner-token/preview']);
    assert.deepEqual(redirects, ['/disk?collaboration=own%2Fproject']);
    assert.equal(element('returnHome').hidden, false);
});
