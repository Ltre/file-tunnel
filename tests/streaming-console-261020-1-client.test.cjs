'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../client/streaming-console.js'), 'utf8');
function consoleRuntime(options = {}) {
    const storage = new Map(), calls = [], intervals = [], toasts = [];
    const location = { href: 'http://10.0.0.9/', origin: 'http://10.0.0.9' };
    const window = { location, addEventListener() {} };
    if (options.getAccount) window.DiskClient = { getAccount: options.getAccount };
    const context = { window, location, URL, Uint8Array, Uint32Array, structuredClone, AbortController, TextDecoder,
        crypto: { getRandomValues: array => require('node:crypto').randomFillSync(array) },
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        document: { getElementById: () => null, addEventListener() {}, createElement: options.createElement },
        setInterval: (run, ms) => { intervals.push(ms); return 1; }, setTimeout, clearTimeout, queueMicrotask,
        fetch: async (url, options) => {
            calls.push({ url, options }); if (url.endsWith('/provider-work')) return new Promise(() => {});
            return { ok: true, status: 200, json: async () => url.endsWith('/preview') ? { url: '/media/fixture', expiresAt: Date.now() + 600000 } : { identity: null, accounts: [], invitations: [] } };
        } };
    vm.runInNewContext(source.replace('global.StreamingConsole =', 'global.__importTest = { ensureDuration, sync }; global.StreamingConsole ='), context);
    const start = () => window.StreamingConsole.init({ deviceId: () => 'lan-device', deviceName: () => 'LAN', devices: () => [], tunnels: options.tunnels || (async () => []), toast: message => toasts.push(message) });
    return { window, calls, intervals, storage, toasts, start };
}
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
