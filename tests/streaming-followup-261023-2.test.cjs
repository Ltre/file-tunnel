'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { createFixture } = require('./support/disk-content-admin-fixture.cjs');
const read = name => fs.readFileSync(require.resolve('../' + name), 'utf8');

test('native uploads accept a valid long filename in an empty nested destination', async t => {
    const f = await createFixture(); t.after(() => f.close());
    f.api.spaces.get('').createDirectory('alice', '你你/妈妈', 30);
    const response = await fetch(f.base + '/api/telegram/drive/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: '你你/妈妈', files: [{ name: 'a'.repeat(110) + '.png', size: 1, type: 'image/png' }] }) });
    const data = await response.json(); assert.equal(response.status, 201, JSON.stringify(data));
    await fetch(f.base + '/api/telegram/drive/uploads/' + data.uploadId, { method: 'DELETE' });
});

test('tunnel collection preparation handles duplicate names within the batch without changing source metadata', async () => {
    const names = require('../client/disk-upload-names'), input = [{ id: 'one', name: 'photo.png', size: 1 }, { id: 'two', name: 'photo.png', size: 1 }];
    let uploaded; const client = { context: () => ({}), getAccount: () => 'alice', raw: async () => ({ identity: { id: 'alice' } }),
        upload: async (files, path, reader) => { uploaded = files; assert.equal(path, '你你'); assert.equal(await (await reader(files[1])).text(), 'two'); return { items: [] }; } };
    const window = { DiskClient: client, DiskUploadNames: names, DiskUI: { setExporter() {}, chooseSaveDestination: async () => ({ path: '你你', transportContext: { accountId: 'alice' } }), revealUploadedDirectory: async () => {} } };
    vm.runInNewContext(read('client/disk-tunnel-adapter.js'), { window, File, Blob, confirm: () => true, localStorage: { getItem: () => null } });
    window.DiskTunnelAdapter.configure({ filesForRecord: () => input, readFile: file => new Blob([file.id]), linkBackup: async () => {} });
    await window.DiskTunnelAdapter.save({ id: 'collection' });
    assert.deepEqual(Array.from(uploaded, file => file.name), ['photo.png', 'photo (2).png']); assert.equal(input[1].name, 'photo.png'); assert.equal(uploaded[1].id, 'two');
});

test('account panel obtains accounts and login configuration from one status request', async () => {
    const source = read('client/disk-ui.js'), start = source.indexOf('async function manageTelegramDriveAccounts('), end = source.indexOf('    const body =', start);
    const calls = [], empty = () => {}; const window = { AccountUI: { open: async options => options.load() }, DiskClient: { raw: async route => { calls.push(route); return { accounts: [], oidcMode: 'mock' }; } } };
    const context = { window, switchTelegramDriveAccount: empty, logoutTelegramDrive: empty, appendTelegramDriveAddAccount: empty };
    const run = vm.runInNewContext('(' + source.slice(start, end) + '})', context); await run(); assert.deepEqual(calls, ['/me']);
});

test('protected deletion requires an explicit acknowledgement and retains account and recycle-bin boundaries', async t => {
    const f = await createFixture(); t.after(() => f.close());
    const scope = { userId: 'alice', diskSpace: '' }, drive = f.api.spaces.get('');
    const shared = require('../server/disk-static-resources').createDiskStaticResources({ dataDir: f.dataDir });
    const link = shared.create(scope, drive, { preset: 'permanent', items: [{ kind: 'file', id: 'file-a' }] });
    const call = async (url, user = 'alice', method = 'GET') => { const response = await fetch(f.base + '/api/telegram/drive' + url, { method, headers: { 'X-Test-User': user } }); return { status: response.status, data: await response.json() }; };
    const denied = await call('/files/file-a', 'alice', 'DELETE'); assert.equal(denied.data.error, 'STATIC_RESOURCE_ACTIVE'); assert.ok(drive.get('alice', 'file-a'));
    assert.equal((await call('/files/file-a?confirm_exposed_delete=true', 'bob', 'DELETE')).status, 404);
    const removed = await call('/files/file-a?confirm_exposed_delete=true', 'alice', 'DELETE'); assert.equal(removed.status, 202, JSON.stringify(removed.data));
    let operation;
    for (let n = 0; n < 40; n++) { operation = (await call('/operations/' + removed.data.operation_id)).data; if (operation.status === 'completed' || operation.status === 'failed') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(operation.status, 'completed', JSON.stringify(operation)); assert.equal(drive.get('alice', 'file-a'), null);
    assert.equal((await call('/trash')).data.items.length, 1); assert.ok(drive.get('bob', 'file-b'));
    assert.throws(() => shared.file(shared.resolve(link.token), drive, '资料/同名/相同.har'), /FILE_NOT_FOUND/);
});

test('files inside an active collaboration directory also require deletion acknowledgement', async t => {
    const f = await createFixture(); t.after(() => f.close());
    // Use the real invitation API to establish its ordinary validated directory grant.
    const made = await fetch(f.base + '/api/telegram/drive/collaborations/invitations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'directory', path: '资料' }) });
    assert.equal(made.status, 201, await made.text());
    const response = await fetch(f.base + '/api/telegram/drive/files/file-a', { method: 'DELETE' });
    assert.equal((await response.json()).error, 'COLLABORATION_DISABLE_BEFORE_DELETE'); assert.ok(f.api.spaces.get('').get('alice', 'file-a'));
});

test('a completed login closes only the account dialog which initiated that login', () => {
    const source = read('client/account-ui.js'), start = source.indexOf('    function completeSignIn('), end = source.indexOf('    global.AccountUI', start);
    const target = {}, other = {}, closed = [], context = vm.createContext({ current: { signIn: target }, close: identity => closed.push(identity) });
    vm.runInContext(source.slice(start, end), context);
    context.completeSignIn(other, { id: 'other' }); context.completeSignIn(target, null); assert.equal(closed.length, 0);
    context.completeSignIn(target, { id: 'alice' }); assert.deepEqual(closed, [{ id: 'alice' }]);
});

test('cancelling protected batch deletion refreshes completed items and retains the original request account', async () => {
    const source = read('client/disk-ui.js'), start = source.indexOf('async function deleteTelegramDriveItems('), end = source.indexOf('async function copyTelegramDriveItemPath(', start);
    const nodes = [], writes = [], selected = new Map([['one', {}], ['two', {}]]); let renders = 0;
    const context = { accountId: 'alice', diskSpace: '', requestBase: '/api/telegram/drive' };
    const run = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', {
        window: { DiskClient: { context: () => context } }, telegramDriveMountContext: null, telegramDriveSelected: selected, telegramDriveItemKey: item => item.id,
        confirmTelegramDriveAction: async () => true, document: { createElement: tag => { const node = { tag, append() {} }; nodes.push(node); return node; }, createTextNode: String },
        telegramDriveRequest: async (url, options) => { writes.push({ url, options }); if (url.includes('/two?')) throw Error('STATIC_RESOURCE_ACTIVE'); return {}; },
        openTelegramDriveDialog: async options => { assert.throws(options.validate, /请先勾选/); return null; },
        pruneTelegramDriveSearchResults() {}, showAppToast() {}, renderTelegramDrive: async () => { renders++; }, encodeURIComponent
    });
    await run([{ kind: 'file', id: 'one', name: 'one' }, { kind: 'file', id: 'two', name: 'two' }]);
    assert.equal(renders, 1); assert.equal(selected.has('one'), false); assert.equal(selected.has('two'), true);
    assert.equal(writes.length, 2); assert.ok(writes.every(call => call.options.accountId === 'alice'));
});

test('forwarding Markdown uses the existing text capability and does not bypass denial', () => {
    const source = read('server.js'), start = source.indexOf("    socket.on('forward-message'"), end = source.indexOf("    socket.on(", start + 20);
    for (const allowed of [false, true]) {
        let handler, result, capability, published = 0;
        vm.runInNewContext(source.slice(start, end), {
            socket: { id: 'socket', on: (_event, fn) => { handler = fn; } }, sanitizeString: value => value, isValidSessionId: () => true,
            infraStore: { getTunnel: () => ({}), findShortCodeForSession: () => 'ABCDE' }, currentDevice: 'device', currentSession: 'source',
            sessions: new Map([['source', { devices: new Map([['device', {}]]) }]]), MAX_MESSAGE_SIZE: 200000,
            getOrCreateTelegramSession: () => ({}), canUseTunnelCapability: (_session, _device, cap) => { capability = cap; return allowed; },
            addToSessionHistory: () => ({ stored: true }), getSessionAuditFileAssets: () => [], emitToReadableSessionDevices: () => { published++; }, scheduleSessionHistoryBroadcast() {}, clientIp: 'fixture', console
        });
        handler({ targetSessionId: 'target', message: { sender: 'device', type: 'markdown', markdown: 'body' } }, value => { result = value; });
        assert.equal(capability, 'sendText'); assert.equal(result.ok, allowed); assert.equal(published, allowed ? 1 : 0);
    }
});
