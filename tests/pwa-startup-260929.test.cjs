'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function cacheFixture() {
    const workers = [];
    const timers = new Map();
    let timerSequence = 0;
    class Worker {
        constructor(url) { this.url = url; this.requests = []; workers.push(this); }
        postMessage(message) { this.requests.push(message); }
        terminate() { this.terminated = true; }
        reply(type, payload = {}) {
            const request = this.requests.find(item => item.type === type);
            assert.ok(request, `missing worker request: ${type}`);
            this.onmessage({ data: { id: request.id, ok: true, ...payload } });
        }
    }
    const window = { Worker };
    const context = vm.createContext({
        window, Worker, navigator: { storage: { getDirectory() {} } },
        ArrayBuffer, Uint8Array, Blob,
        setTimeout: callback => { const id = ++timerSequence; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id)
    });
    vm.runInContext(read('client/cache-store.js'), context);
    return { window, workers, timers };
}

const opfsRecord = () => ({ id: 'old-file', size: 3, cacheStoreRef: { driver: 'opfs', path: 'old-file.bin', size: 3, complete: true } });

test('background OPFS initialization does not delay IndexedDB writes but gates old OPFS reads and deletes', async () => {
    const fixture = cacheFixture();
    const store = await fixture.window.createDrop2TunnelCacheStore({ initializeInBackground: true });
    const worker = fixture.workers[0];
    assert.equal(store.workerReady, false);
    assert.equal(worker.requests.length, 1);

    let completed = 0;
    const materialized = store.materialize(opfsRecord()).then(result => { completed++; return result; });
    const range = store.readRange(opfsRecord(), 1, 3).then(result => { completed++; return result; });
    const deleted = store.deleteReference(opfsRecord()).then(result => { completed++; return result; });
    const writer = await store.beginWrite({ id: 'new-file', size: 3 });
    assert.equal(writer.driver, 'indexeddb-blob');
    await writer.writeChunk(new Uint8Array([4, 5, 6]).buffer, 0);
    assert.deepEqual(Array.from(new Uint8Array((await writer.commit()).data)), [4, 5, 6]);
    await tick();
    assert.equal(completed, 0);
    assert.deepEqual(worker.requests.map(item => item.type), ['probe']);

    worker.reply('probe');
    await tick();
    assert.equal(store.workerReady, true);
    assert.deepEqual(worker.requests.map(item => item.type), ['probe', 'read', 'readRange', 'delete']);
    worker.reply('read', { data: new Uint8Array([1, 2, 3]).buffer });
    worker.reply('readRange', { data: new Uint8Array([2, 3]).buffer });
    worker.reply('delete');
    assert.deepEqual(Array.from(new Uint8Array((await materialized).data)), [1, 2, 3]);
    assert.deepEqual(Array.from(new Uint8Array(await range)), [2, 3]);
    assert.equal(await deleted, true);
    assert.equal(fixture.timers.size, 0);
});

test('existing cache-store callers still await the OPFS probe by default', async () => {
    const fixture = cacheFixture();
    let resolved = false;
    const pending = fixture.window.createDrop2TunnelCacheStore().then(store => { resolved = true; return store; });
    await tick();
    assert.equal(resolved, false);
    fixture.workers[0].reply('probe');
    const store = await pending;
    assert.equal(store.workerReady, true);
    assert.equal(fixture.timers.size, 0);
});

test('a failed worker script releases the probe immediately and old OPFS reads fail explicitly', async () => {
    const fixture = cacheFixture();
    const logs = [];
    const store = await fixture.window.createDrop2TunnelCacheStore({ initializeInBackground: true, log: (event, details) => logs.push({ event, details }) });
    const worker = fixture.workers[0];
    worker.onerror({ message: 'worker unavailable' });
    await store.ready;
    assert.equal(worker.terminated, true);
    assert.equal(store.workerReady, false);
    assert.equal(store.worker, null);
    assert.equal(fixture.timers.size, 0);
    assert.equal(logs.find(item => item.event === 'cache-store-opfs-unavailable').details.error, 'cache-worker-load-failed');
    await assert.rejects(store.materialize(opfsRecord()), /cache-worker-unavailable/);
    await assert.rejects(store.readRange(opfsRecord()), /cache-worker-unavailable/);
    await assert.rejects(store.deleteReference(opfsRecord()), /cache-worker-unavailable/);
    assert.equal(store.isCompleteReference(opfsRecord()), true);
});

test('a worker message failure immediately rejects active operations and clears their timers', async () => {
    const fixture = cacheFixture();
    const store = await fixture.window.createDrop2TunnelCacheStore({ initializeInBackground: true });
    const worker = fixture.workers[0];
    worker.reply('probe');
    await store.ready;
    const pending = store.materialize(opfsRecord());
    const rejected = assert.rejects(pending, /cache-worker-message-failed/);
    await tick();
    worker.onmessageerror({});
    await rejected;
    assert.equal(fixture.timers.size, 0);
    assert.equal(store.pending.size, 0);
});

test('the versioned script loader emits ordered defer scripts and preserves force-refresh versions', () => {
    const page = read('pages/index.html');
    const loader = page.match(/<script>\s*(\(function loadVersionedClientScripts[\s\S]*?)<\/script>/)[1];
    for (const search of ['', '?_reload=a%2Fb']) {
        const writes = [];
        vm.runInNewContext(loader, { URLSearchParams, window: { location: { search } }, document: { write: markup => writes.push(markup) } });
        const paths = writes.map(markup => {
            assert.match(markup, /^<script defer src="[^"\n]+"><\/script>$/);
            assert.doesNotMatch(markup, /\basync\b/);
            return markup.match(/src="([^"]+)"/)[1];
        });
        const suffix = search ? '?v=a%2Fb' : '';
        assert.equal(paths[0], `/runtime-config.js${suffix}`);
        assert.equal(paths.at(-1), `/app.js${suffix}`);
        for (const dependency of ['cache-store', 'file-assets', 'media', 'disk-ui', 'disk-tunnel-adapter']) {
            assert.ok(paths.indexOf(`/client/${dependency}.js${suffix}`) >= 0);
        }
        assert.ok(paths.indexOf(`/client/simplewebauthn.js${suffix}`) < paths.indexOf(`/client/disk-client.js${suffix}`));
        assert.ok(paths.indexOf(`/client/disk-client.js${suffix}`) < paths.indexOf(`/client/disk-ui.js${suffix}`));
        assert.ok(paths.indexOf(`/client/disk-ui.js${suffix}`) < paths.indexOf(`/client/disk-tunnel-adapter.js${suffix}`));
    }
    assert.match(page, /<script defer src="\/client\/qrcode-1\.0\.0\.min\.js"><\/script>/);
    assert.ok(page.indexOf('qrcode-1.0.0.min.js') < page.indexOf('function loadVersionedClientScripts'));
});

test('shell readiness is reached with a stalled OPFS probe while local restoration precedes Socket initialization', async () => {
    const app = read('app.js');
    const helpers = app.slice(app.indexOf('const startupTimings ='), app.indexOf('document.addEventListener(\'DOMContentLoaded\', async () =>'));
    const cacheInit = app.slice(app.indexOf('async function initFileCacheStore()'), app.indexOf('async function materializeCachedFileRecord('));
    const startApp = app.slice(app.indexOf('async function startTunnelApplication()'), app.indexOf('function registerServiceWorker()'));
    let resolveProbe, resolveHistory;
    const probe = new Promise(resolve => { resolveProbe = resolve; });
    const history = new Promise(resolve => { resolveHistory = resolve; });
    const calls = [];
    const elements = new Map();
    const window = { performance: { now: () => 10, mark: name => calls.push(name) }, createDrop2TunnelCacheStore: async options => {
        assert.equal(options.initializeInBackground, true);
        return { ready: probe, workerReady: false };
    } };
    const context = vm.createContext({
        window, fileCacheStore: null, console,
        historyLog() {},
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        document: {
            dispatchEvent: event => calls.push(event.type),
            getElementById: id => { if (!elements.has(id)) elements.set(id, { hidden: true, removeAttribute() {} }); return elements.get(id); }
        },
        initFileAssetTransfer: () => calls.push('file-assets'), initMediaController: () => calls.push('media'),
        initUI: () => calls.push('ui'), initEditor: () => calls.push('editor'),
        initDragDrop: () => calls.push('drag-drop'), initClipboardImagePaste: () => calls.push('clipboard'),
        restoreMusicPlayerState: async () => calls.push('music'), loadContacts: async () => calls.push('contacts'),
        loadSessionData: async () => { calls.push('history'); await history; },
        initSocket: () => calls.push('socket'), initAssetPresenceRefresh() {}, ensureHomeHistoryGuard() {},
        handlePendingRecordNavigation: async () => {}, handlePendingDeviceCallOrIntercom: async () => {}
    });
    vm.runInContext(helpers + cacheInit + startApp, context);
    await context.initFileCacheStore();
    const startup = context.startTunnelApplication();
    await tick();
    assert.equal(elements.get('appShell').hidden, false);
    assert.equal(window.TunnelStartup.shellReadyMs, 10);
    assert.deepEqual(calls.slice(0, 6), ['file-assets', 'media', 'ui', 'editor', 'drag-drop', 'clipboard']);
    assert.ok(calls.indexOf('tunnel-shell-ready') < calls.indexOf('music'));
    assert.ok(calls.indexOf('music') < calls.indexOf('contacts'));
    assert.ok(calls.indexOf('contacts') < calls.indexOf('history'));
    assert.equal(calls.includes('socket'), false);
    resolveHistory();
    await startup;
    assert.ok(calls.indexOf('socket') > calls.indexOf('history'));
    resolveProbe();
    await tick();
    assert.equal(window.TunnelStartup.stages.find(stage => stage.name === 'cache-store-probe').opfsReady, false);
});

test('startup timing records failures and keeps initialization errors visible', async () => {
    const app = read('app.js');
    const helpers = app.slice(app.indexOf('const startupTimings ='), app.indexOf('document.addEventListener(\'DOMContentLoaded\', async () =>'));
    const context = vm.createContext({ window: { performance: { now: () => 5 } }, historyLog() {} });
    vm.runInContext(helpers, context);
    await assert.rejects(context.runStartupStage('indexeddb-open', async () => { throw new Error('db blocked'); }), /db blocked/);
    assert.equal(context.window.TunnelStartup.stages[0].failed, true);
    assert.equal(context.window.TunnelStartup.shellReadyMs, null);
});

test('a blocked IndexedDB upgrade reports an actionable error and closes a late successful connection', async () => {
    const app = read('app.js');
    const storageInit = app.slice(app.indexOf('async function initStorage()'), app.indexOf('// 辅助函数：创建所有必需的对象存储'));
    const request = {};
    let closes = 0;
    let aborts = 0;
    const indexedDB = { open: () => request };
    const context = vm.createContext({ window: { indexedDB }, indexedDB, state: { db: null }, CONFIG: { TUNNEL_DB_VER: 7 }, console: { log() {}, error() {} } });
    vm.runInContext(storageInit, context);
    const pending = context.initStorage();
    const rejected = assert.rejects(pending, /关闭其它 Drop2Tunnel 页面/);
    request.onblocked();
    await rejected;
    request.onupgradeneeded({ target: { transaction: { abort: () => aborts++ } } });
    request.onsuccess({ target: { result: { close: () => closes++ } } });
    assert.equal(aborts, 1);
    assert.equal(closes, 1);
    assert.equal(context.state.db, null);
});
