'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const app = fs.readFileSync('app.js', 'utf8'), adapter = fs.readFileSync('client/disk-tunnel-adapter.js', 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const turn = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture({ queued = true, cached = true } = {}) {
    const restore = deferred(), events = [], alerts = [], handlers = new Map(), pending = new Map();
    if (queued) pending.set('telegram-drive-pending-forward', JSON.stringify({ targetId: 'old-tunnel-A', files: [{ id: 'disk-file', name: 'cached.txt', type: 'text/plain' }] }));
    const state = { sessionId: 'old-tunnel-A', deviceId: 'device-id', deviceName: '设备', shortCode: 'ABCDE', sessionRemark: '', socket: null };
    const sessionStorage = { getItem: key => pending.get(key) || null, setItem: (key, value) => pending.set(key, value), removeItem: key => pending.delete(key) };
    const nodes = new Map(); const node = id => nodes.get(id) || (nodes.set(id, { hidden: true, removeAttribute() {} }), nodes.get(id));
    const socket = { connected: true, on: (name, run) => handlers.set(name, run), emit: (name, value) => events.push({ name, value }) };
    const window = { DiskUI: { setExporter() {} }, TelegramDriveCache: { get: async () => cached ? { blob: new Blob(['cached']) } : null } };
    const context = vm.createContext({ window, state, sessionStorage, localStorage: { getItem: () => null }, File, Blob, Map, Set, Date,
        document: { getElementById: node }, alert: message => alerts.push(message), DEFAULT_TUNNEL_PERMISSIONS: {},
        configureLightTransfer() {}, initFileAssetTransfer() {}, initMediaController() {}, initEditor() {}, initDragDrop() {}, initClipboardImagePaste() {}, markStartupShellReady() {},
        restoreMusicPlayerState: async () => {}, loadContacts: async () => {}, loadSessionData: () => restore.promise,
        runStartupStage: (_name, run) => run(), initAssetPresenceRefresh() {}, ensureHomeHistoryGuard() {},
        handlePendingRecordNavigation: async () => {}, handlePendingDeviceCallOrIntercom: async () => {},
        telegramDriveFilesForMessage() {}, getTelegramDriveBlob() {}, associateTelegramDriveBackup() {}, readSessionDirectoryCache: () => [], getAllFromStore: async () => [],
        openSession() {}, normalizeLocalShortCode: String, applyTunnelPermissionUi() {},
        nextHistoryTimestamp: () => 1, lastLocalHistoryTimestamp: 0, pendingHistoryMessageIds: new Set(),
        saveToStore: async (store, value) => events.push({ name: 'stored-' + store, value }), historyLog() {}, summarizeHistoryMessage: value => value,
        addMessageToChat: async () => {}, setTimeout() {}, requestSessionHistory() {},
        initSocket: () => {
            state.socket = socket;
            vm.runInContext(section("    state.socket.on('session-permissions'", "    state.socket.on('permission-denied'"), context);
        },
        initUI: () => vm.runInContext(section('    window.DiskTunnelAdapter.configure({', "    document.getElementById('telegramDriveBtn')"), context)
    });
    vm.runInContext(adapter, context);
    vm.runInContext(section('async function publishHistoryMessage(', 'function updateTextInputHeight(') + section('async function startTunnelApplication(', 'function registerServiceWorker('), context);
    context.sendSelectedFiles = files => context.publishHistoryMessage({ id: 'forwarded', type: 'file', fileInfo: { name: files[0].name } });
    return { state, alerts, events, pending, restore, start: () => context.startTunnelApplication(), joined: () => handlers.get('session-permissions')?.({ permissions: {} }) };
}

test('restored disk forwarding waits through old tunnel startup and sends only after joined permissions arrive', async () => {
    const f = fixture(), starting = f.start(); await turn();
    assert.equal(f.state.socket, null); assert.deepEqual(f.alerts, [], 'restoring a known tunnel must not attempt to publish before its socket exists');
    assert.equal(f.events.some(event => event.name === 'message'), false);
    f.restore.resolve(); await starting; assert.equal(f.events.some(event => event.name === 'message'), false, 'a transport alone does not confirm tunnel membership');
    assert.equal(f.pending.has('telegram-drive-pending-forward'), true, 'pending work stays intact until the server confirms membership');
    f.joined(); await turn();
    assert.deepEqual(f.alerts, []); assert.equal(f.events.filter(event => event.name === 'message').length, 1);
    assert.equal(f.events.find(event => event.name === 'message').value.sessionId, 'old-tunnel-A');
    assert.equal(f.pending.has('telegram-drive-pending-forward'), false);
});

test('repeated permission snapshots do not duplicate a pending disk file forward', async () => {
    const f = fixture(), starting = f.start(); await turn(); f.restore.resolve(); await starting;
    f.joined(); f.joined(); await turn();
    assert.equal(f.events.filter(event => event.name === 'message').length, 1); assert.deepEqual(f.alerts, []);
});

test('switching an old tunnel without queued forwarding never publishes or raises a forwarding connection alert', async () => {
    const f = fixture({ queued: false }), starting = f.start(); await turn(); f.restore.resolve(); await starting; f.joined(); await turn();
    assert.equal(f.events.some(event => event.name === 'message'), false); assert.deepEqual(f.alerts, []);
});

test('genuine missing disk cache after membership confirmation retains queued work and reports the original actionable error', async () => {
    const f = fixture({ cached: false }), starting = f.start(); await turn(); assert.deepEqual(f.alerts, []);
    f.restore.resolve(); await starting; f.joined(); await turn();
    assert.equal(f.events.some(event => event.name === 'message'), false); assert.equal(f.pending.has('telegram-drive-pending-forward'), true);
    assert.deepEqual(f.alerts, ['切换隧道后找不到完整网盘缓存，请重新转发']);
});
