'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');
const express = require('express'), rateLimit = require('../server/request-rate-limit');
const { createTunnelAccess } = require('../server/tunnel-access');
const { listenHttp } = require('./support/listen-http.cjs');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const slice = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

async function serve(t, app) {
    const server = await listenHttp(app);
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = 'http://127.0.0.1:' + server.address().port;
    return (route, options = {}) => fetch(base + route, options);
}
function gate(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-rejoin-rate-261121-'));
    t.after(() => {
        const resolved = path.resolve(dir);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('tunnel-rejoin-rate-261121-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    return createTunnelAccess(dir);
}
function routes(t) {
    const app = express(); app.use(express.json());
    const tunnelAccess = gate(t), sessionId = crypto.randomUUID(), deviceId = crypto.randomUUID();
    const shortCode = '2U52R', grant = tunnelAccess.issue(sessionId, deviceId);
    const context = { app, tunnelAccess, sessions: new Map(), shortCodes: new Map([[shortCode, sessionId]]),
        infraStore: { getTunnel: id => id === sessionId ? { short_code: shortCode } : null, findSessionIdByShortCode: code => code === shortCode ? sessionId : null },
        isValidSessionId: id => typeof id === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(id),
        isValidDeviceId: id => typeof id === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(id),
        normalizeShortCode: code => /^[A-Z0-9]{5}$/.test(String(code || '').toUpperCase()) ? code.toUpperCase() : '' };
    vm.runInNewContext(slice(source, "app.post('/api/tunnel-access'", 'mountMarkdownReferenceRoute(app'), context);
    vm.runInNewContext(slice(source, "app.get('/api/short-codes/:shortCode'", '\n\nconst io ='), context);
    return { app, tunnelAccess, context, sessionId, deviceId, shortCode, grant };
}

test('navigation and shell resources do not consume the API budget or turn refresh into JSON after API exhaustion', async t => {
    const context = { normalizeLanguageCode: x => x, translateTelegramText: x => x };
    vm.runInNewContext(slice(source, 'const RATE_LIMIT = {', 'const adminAuthRateLimit =') + ';this.options=RATE_LIMIT;', context);
    const app = express(); app.use(rateLimit({ ...context.options, max: 3 }));
    app.use((req, res) => req.path.startsWith('/api/') ? res.json({ ok: true }) : res.type('html').send('<!doctype html><main>tunnel shell</main>'));
    const call = await serve(t, app);
    const shell = ['/', '/?open=1', '/?leave=1', '/index.html', '/tunnel-entry.html', '/record/tunnel-id/message-id',
        '/app.js', '/runtime-config.js', '/manifest.webmanifest', '/service-worker.js', '/tunnel-icon.svg',
        '/client/index.css', '/client/tunnel-entry.js', '/client/i18n/ja.json', '/assets/app.1234567890.min.js'];
    for (const route of shell) assert.equal((await call(route)).status, 200, route);
    for (let i = 0; i < 3; i++) assert.equal((await call('/api/probe')).status, 200);
    const denied = await call('/api/probe'); assert.equal(denied.status, 429);
    assert.equal((await denied.json()).code, 'LOCAL_REQUEST_RATE_LIMIT');
    for (const route of shell) assert.equal((await call(route)).status, 200, route + ' must remain available after exhaustion');
    for (const route of ['/api/private.js', '/api/private.json', '/client-api.js', '/unknown']) assert.equal((await call(route)).status, 429, route);
    assert.equal((await call('/app.js', { method: 'POST' })).status, 429, 'only safe shell reads bypass the API budget');
});

test('a verified member can resolve its code after guessing is limited, without exempting missing or mismatched credentials', async t => {
    const f = routes(t), call = await serve(t, f.app);
    for (let i = 0; i < 40; i++) assert.equal((await call('/api/short-codes/WRONG')).status, 404);
    assert.equal((await call('/api/short-codes/WRONG')).status, 429);
    const proof = { 'X-Tunnel-Device': f.deviceId, 'X-Tunnel-Grant': f.grant };
    for (let i = 0; i < 45; i++) {
        const response = await call('/api/short-codes/' + f.shortCode, { headers: proof });
        assert.equal(response.status, 200, 'stored membership is not another code guess');
        const data = await response.json(); assert.equal(data.sessionId, f.sessionId); assert.equal(data.grant, f.grant);
    }
    for (const headers of [{}, { ...proof, 'X-Tunnel-Device': crypto.randomUUID() }, { ...proof, 'X-Tunnel-Grant': f.grant + 'x' }]) {
        assert.equal((await call('/api/short-codes/' + f.shortCode, { headers })).status, 429);
    }
    assert.equal((await call('/api/short-codes/WRONG', { headers: proof })).status, 429, 'a grant does not bypass guessing for another code');
    const otherSession = crypto.randomUUID(); f.context.shortCodes.set('OTHER', otherSession);
    assert.equal((await call('/api/short-codes/OTHER', { headers: proof })).status, 429, 'a valid grant cannot exempt a different existing tunnel');
    assert.equal((await call('/api/short-codes/' + f.shortCode, { headers: { ...proof, 'X-Tunnel-Grant': f.tunnelAccess.issue(otherSession, f.deviceId) } })).status, 429);
    const response = await call('/api/tunnel-access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: f.sessionId, deviceId: f.deviceId, grant: f.grant }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).allowed, true);
});

test('the Socket.IO short-code boundary also exempts only proof for that exact member and tunnel', t => {
    const f = routes(t), handlers = new Map(), replies = [];
    for (let i = 0; i < 41; i++) f.tunnelAccess.attempt('fixture-ip');
    const socket = { on: (name, handler) => handlers.set(name, handler), emit: (name, data) => replies.push({ name, data }) };
    vm.runInNewContext(slice(source, "socket.on('join-by-short-code'", "socket.on('session-remark-update'"), {
        ...f.context, socket, clientIp: 'fixture-ip', currentDevice: null, profileDevice: null,
        deleteShortCode() {}, emitSocketError: (name, message) => replies.push({ name, message })
    });
    handlers.get('join-by-short-code')({ shortCode: f.shortCode, deviceId: f.deviceId, accessGrant: f.grant });
    assert.equal(replies.pop().name, 'short-code-session');
    handlers.get('join-by-short-code')({ shortCode: f.shortCode, deviceId: f.deviceId });
    assert.equal(replies.pop().name, 'short-code-error');
    handlers.get('join-by-short-code')({ shortCode: 'WRONG', deviceId: f.deviceId, accessGrant: f.grant });
    assert.equal(replies.pop().name, 'short-code-error');
});

function client(reply) {
    const sessionId = 'fixture-session-id', deviceId = 'fixture-member-id', grant = 'fixture-private-grant', values = new Map([
        ['deviceId', 'other-global-device'], ['tunnel-authorization:' + sessionId, JSON.stringify({ deviceId, grant })]
    ]), requests = [], state = { sessionId, deviceId, shortCode: '2U52R' };
    const context = vm.createContext({ state, URL, localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
        readSessionDirectoryCache: () => [{ sessionId, shortCode: '2U52R' }], sessionStorage: { getItem: () => null }, history: { replaceState() {} },
        window: { location: { href: 'http://localhost/?open=1#' + sessionId } },
        fetch: async (url, options) => { requests.push({ url, options }); return reply(url); }, openSession: id => { context.opened = id; } });
    vm.runInContext(slice(appSource, 'function savedTunnelGrant(', 'async function initSession()'), context);
    return { context, requests, state, sessionId, deviceId, grant };
}

test('full-page code selection sends the saved tunnel identity only for its matching code', async () => {
    const f = client(url => ({ ok: true, status: 200, json: async () => url.startsWith('/api/short-codes') ? { sessionId: 'fixture-session-id' } : { allowed: true, grant: 'fixture-private-grant' } }));
    await f.context.selectTunnelByShortCode('2U52R');
    assert.equal(f.requests[0].options.headers?.['X-Tunnel-Device'], f.deviceId);
    assert.equal(f.requests[0].options.headers?.['X-Tunnel-Grant'], f.grant);
    await f.context.selectTunnelByShortCode('OTHER');
    assert.equal(f.requests[2].options.headers?.['X-Tunnel-Grant'], undefined, 'never attach another tunnel’s private credential');
});

test('full-page selection distinguishes generic throttling from a code-attempt throttle', async () => {
    for (const stage of ['lookup', 'authorization']) for (const code of ['LOCAL_REQUEST_RATE_LIMIT', undefined]) {
        const f = client(url => stage === 'authorization' && url.startsWith('/api/short-codes') ?
            { ok: true, status: 200, json: async () => ({ sessionId: 'fixture-session-id' }) } :
            { ok: false, status: 429, json: async () => ({ code, error: 'untrusted arbitrary text' }) });
        await assert.rejects(f.context.selectTunnelByShortCode('2U52R'), error => error.message ===
            (code ? '请求过于频繁，请稍后再试' : '短码尝试过于频繁，请稍后再试'));
        assert.equal(f.context.opened, undefined);
    }
});

test('a temporary HTTP throttle preserves a saved membership for the normal Socket.IO verification', async () => {
    const f = client(() => ({ ok: false, status: 429, json: async () => ({ code: 'LOCAL_REQUEST_RATE_LIMIT' }) }));
    assert.equal(await f.context.ensureTunnelAccess(), true);
    assert.equal(f.state.sessionId, f.sessionId); assert.equal(f.state.shortCode, '2U52R');
});

test('a non-JSON lookup failure keeps the original friendly failure instead of exposing a parser error', async () => {
    const f = client(() => ({ ok: false, status: 404, json: async () => { throw Error('Unexpected token <'); } }));
    await assert.rejects(f.context.selectTunnelByShortCode('2U52R'), /没有找到该传输隧道/);
    assert.equal(f.context.opened, undefined);
});
