'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../client/streaming-console.js'), 'utf8');
function consoleRuntime(options = {}) {
    const storage = new Map(), calls = [], intervals = [], toasts = [];
    const location = { href: 'http://10.0.0.9/', origin: 'http://10.0.0.9' };
    const events = new Map();
    const window = { location, addEventListener(name, run) { const list=events.get(name)||[];list.push(run);events.set(name,list); } };
    if (options.getAccount) window.DiskClient = { getAccount: options.getAccount };
    const context = { window, location, URL, Uint8Array, Uint32Array, structuredClone, AbortController, TextDecoder,
        crypto: { getRandomValues: array => require('node:crypto').randomFillSync(array) },
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        document: { getElementById: () => null, addEventListener() {}, createElement: options.createElement },
        setInterval: (run, ms) => { intervals.push(ms); return 1; }, setTimeout: options.setTimeout || setTimeout, clearTimeout, queueMicrotask,
        fetch: async (url, requestOptions) => {
            calls.push({ url, options: requestOptions }); if (url.endsWith('/provider-work')) return new Promise(() => {});
            if (url.endsWith('/preview') && context.delayPreview) return new Promise(() => {});
            return { ok: true, status: 200, json: async () => options.respond ? options.respond(url, requestOptions) : url.endsWith('/preview') ? { url: '/media/fixture', expiresAt: Date.now() + 600000 } : { identity: null, accounts: [], invitations: [] } };
        } };
    context.delayPreview = options.delayPreview;
    vm.runInNewContext(source.replace('global.StreamingConsole =', 'global.__importTest = { ensureDuration, duration, sync, kindOf, navigate, returnToList, saveUi, getUi: () => ui }; global.StreamingConsole ='), context);
    const start = () => window.StreamingConsole.init({ deviceId: () => 'lan-device', deviceName: () => 'LAN', devices: () => [], tunnels: options.tunnels || (async () => []), toast: message => toasts.push(message) });
    return { window, calls, intervals, storage, toasts, events, start };
}

test('persisted streaming drafts in a closed console do not block homepage refresh with an unexplained warning', async () => {
    const f=consoleRuntime();await f.start();
    const ui=f.window.__importTest.getUi();ui.view='edit';ui.stationId='draft-station';
    ui.drafts[ui.stationId]={name:'尚未发布的串流草稿',loop:true,countdown:'bottom-right',items:[]};
    f.window.__importTest.saveUi();
    let prevented=false;const event={preventDefault(){prevented=true;}};
    for(const run of f.events.get('beforeunload')||[])run(event);
    assert.equal(prevented,false);assert.equal(event.returnValue,undefined);
    for(const run of f.events.get('pagehide')||[])run({persisted:false});
    assert.ok([...f.storage.values()].some(value=>value.includes('尚未发布的串流草稿')),'the local draft remains persisted');
});
test('LAN HTTP initializes with secure getRandomValues when randomUUID is unavailable', async () => {
    const f = consoleRuntime(); await f.start();
    const device = f.calls.find(call => call.url.endsWith('/devices')); assert.ok(device);
    const key = JSON.parse(device.options.body).key; assert.match(key, /^[\w-]{32,128}$/);
    assert.equal(f.toasts.length, 0);
});
test('background identity sync uses one 30 second timer and carries inbox without a second poll', async () => {
    const f = consoleRuntime(); await f.start();
    assert.deepEqual(f.intervals, [30000]);
    assert.equal(f.calls.filter(call => call.url.endsWith('/sync')).length, 1);
    assert.equal(f.calls.filter(call => call.url.endsWith('/inbox')).length, 0);
});
test('duration metadata jobs are shared and at most two upstream probes run concurrently', async () => {
    const probes = [];
    const f = consoleRuntime({ createElement: () => {
        const media = { duration: 12, removeAttribute() {}, load() {}, set src(value) { probes.push(this); } }; return media;
    } }); await f.start();
    const item = id => ({ id, name: id + '.mp4', kind: 'video', size: 100, source: { kind: 'disk', fileId: id, accountId: 'alice' } });
    const a = item('a'), b = item('b'), c = item('c'), duplicate = { ...a, id: 'duplicate' };
    for (const value of [a, b, c, duplicate]) f.window.__importTest.ensureDuration(value);
    await new Promise(setImmediate); assert.equal(probes.length, 2); assert.equal(a.duration, undefined);
    probes[0].onloadedmetadata(); await new Promise(setImmediate);
    assert.equal(a.duration, 12); assert.equal(duplicate.duration, 12); assert.equal(probes.length, 3);
    probes[1].onloadedmetadata(); probes[2].onloadedmetadata(); await new Promise(setImmediate);
    assert.equal(c.duration, 12); assert.equal(f.calls.filter(call => call.url.endsWith('/preview')).length, 3);
});
test('identity changes during an awaited sync keep its original actor and schedule the new actor once', async () => {
    let actor = 'alice', pause = false, release;
    const f = consoleRuntime({ getAccount: () => actor, tunnels: async () => { if (pause) { pause = false; await new Promise(resolve => { release = resolve; }); } return []; } });
    await f.start(); pause = true;
    const pending = f.window.__importTest.sync(); actor = 'bob'; release(); await pending; await new Promise(setImmediate);
    const requests = f.calls.filter(call => call.url.endsWith('/sync'));
    assert.deepEqual(requests.map(call => call.options.headers['X-Disk-Account']), ['alice', 'alice', 'bob']);
});
module.exports = { consoleRuntime };

test('station returns retain the originating list and direct invitations explicitly return to discovery', async () => {
    const f = consoleRuntime(); await f.start(); const runtime = f.window.__importTest;
    for (const origin of ['discover', 'local', 'bookmarks']) {
        runtime.navigate(origin); runtime.navigate('watch', 'station-' + origin); runtime.navigate('access', 'station-' + origin); runtime.returnToList(); assert.equal(runtime.getUi().view, origin);
    }
    runtime.navigate('local'); runtime.navigate('watch', 'linked-station', false, 'discover'); runtime.returnToList(); assert.equal(runtime.getUi().view, 'discover');
});

test('a failed metadata probe invalidates its preview ticket before a user retry', async () => {
    const probes = []; const f = consoleRuntime({ createElement: () => ({ duration: 12, removeAttribute() {}, load() {}, set src(value) { probes.push(this); } }) }); await f.start();
    const item = { name: 'song.m4a', kind: 'audio', size: 100, source: { kind: 'disk', fileId: 'song', accountId: 'alice' } };
    const first = f.window.__importTest.duration(item, 'alice'); const rejected = assert.rejects(first); await new Promise(setImmediate); probes[0].onerror(); await rejected;
    const second = f.window.__importTest.duration(item, 'alice'); await new Promise(setImmediate); probes[1].onloadedmetadata(); await second;
    assert.equal(f.calls.filter(call => call.url.endsWith('/preview')).length, 2);
});

test('import uses current MIME before extensions, matching the server classification', () => {
    const f = consoleRuntime(), kindOf = f.window.__importTest.kindOf;
    assert.equal(kindOf({ name: 'replaced.m4a', type: 'image/png' }), 'image');
    assert.equal(kindOf({ name: 'replaced.m4a', type: 'text/plain' }), 'text');
    assert.equal(kindOf({ name: 'replaced.m4a', type: 'application/pdf' }), '');
});

test('the duration deadline covers a stalled preview authorization request, not only media metadata', async () => {
    const timers = []; const f = consoleRuntime({ delayPreview: true, setTimeout: (run,ms) => { timers.push({run,ms}); return 0; } }); await f.start();
    const job = f.window.__importTest.duration({ name: 'slow.mp4', kind: 'video', source: { kind: 'disk', fileId: 'slow' } }, 'alice');
    await new Promise(setImmediate); const rejected = assert.rejects(job, /DURATION_REQUIRED/); timers.find(timer=>timer.ms===30000).run(); await rejected;
    assert.equal(f.calls.find(call => call.url.endsWith('/preview')).options.signal.aborted, true);
});
