'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./support/streaming-console-fixture.cjs');
async function setup(t) {
    const f = await createFixture(); t.after(() => f.close());
    const cookies = new Map(), deviceCookies = new Map();
    async function login(name) {
        const response = await fetch(f.base + '/fixture-account/' + name, { redirect: 'manual' });
        for (const value of response.headers.getSetCookie()) { const [pair] = value.split(';'), i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
    }
    const headers = (device, signed = false) => ({ 'X-Stream-Device': device, 'X-Stream-Key': device.repeat(8),
        ...(signed ? { Cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; '), 'X-Disk-Account': 'alice' } : {}) });
    async function call(device, route, method = 'GET', body, signed = false) {
        const response = await fetch(f.base + '/api/streaming' + route, { method, headers: { ...headers(device, signed), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
    }
    await login('alice');
    for (const device of ['device-A', 'device-B', 'device-C']) {
        const response = await fetch(f.base + '/api/streaming/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: device, key: device.repeat(8), name: device }) }); assert.equal(response.status, 200);
        deviceCookies.set(device, response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '));
    }
    const { body: s } = await call('device-A', '/stations', 'POST', { name: 'HTTP 文件台', creationId: 'http-create' }, true);
    const files = f.store.list('alice', '').files;
    const items = files.map((file, index) => ({ id: 'item' + index, source: { kind: 'disk', accountId: 'alice', fileId: file.id,
        ...(file.name.endsWith('.md') ? { tunnelGrants: { 'fixture-tunnel': 'fixture-proof' } } : {}) } }));
    const saved = await call('device-A', '/stations/' + s.id, 'PUT', { configVersion: 1, items, loop: true, countdown: 'edge' }, true);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const activated = await call('device-A', '/stations/' + s.id + '/visibility', 'POST', { visibility: 'public', version: saved.body.playback.version }, true); assert.equal(activated.status, 200);
    return { ...f, headers, call, login, s, items, files, deviceCookies };
}
test('real HTTP drive adapter delegates only selected bytes without recipient source credentials', async t => {
    const f = await setup(t), item = f.items.find((item, index) => f.files[index].name.endsWith('.txt'));
    const view = await f.call('device-C', '/stations/' + f.s.id);
    assert.equal(view.status, 200); assert.ok(!JSON.stringify(view.body).includes('fileId'));
    assert.equal(view.body.local, false); assert.equal(view.body.manageable, false);
    const denied = await f.call('device-C', '/stations/' + f.s.id + '/control', 'POST', { action: 'play', version: view.body.playback.version }); assert.equal(denied.status, 403);
    const ticket = await f.call('device-C', '/stations/' + f.s.id + '/ticket', 'POST', { itemId: item.id });
    assert.equal(ticket.status, 200); assert.ok(!JSON.stringify(ticket.body).includes('token:'));
    assert.equal((await fetch(f.base + ticket.body.url)).status, 403, 'a copied media URL is not a device credential');
    assert.equal((await fetch(f.base + ticket.body.url, { headers: { Cookie: f.deviceCookies.get('device-B') } })).status, 403);
    const cookieMedia = await fetch(f.base + ticket.body.url, { headers: { Cookie: f.deviceCookies.get('device-C') } });
    assert.equal(cookieMedia.status, 200); await cookieMedia.arrayBuffer();
    const partial = await fetch(f.base + ticket.body.url, { headers: { ...f.headers('device-C'), Range: 'bytes=0-5' } });
    assert.equal(partial.status, 206, partial.status === 206 ? '' : await partial.clone().text()); assert.equal((await partial.arrayBuffer()).byteLength, 6);
    assert.match(partial.headers.get('cache-control'), /no-store/);
    const suffix = await fetch(f.base + ticket.body.url, { headers: { ...f.headers('device-C'), Range: 'bytes=-6' } }); assert.equal(suffix.status, 206); await suffix.arrayBuffer();
    const invalid = await fetch(f.base + ticket.body.url, { headers: { ...f.headers('device-C'), Range: 'bytes=999999-' } }); assert.equal(invalid.status, 416);
    const stranger = await f.call('device-C', '/stations/' + f.s.id + '/ticket', 'POST', { itemId: 'unselected' }); assert.equal(stranger.status, 422);
    const anonymousBookmark = await f.call('device-C', '/stations/' + f.s.id + '/bookmark', 'PUT'); assert.equal(anonymousBookmark.status, 403);
});
test('HTTP tickets stop after access reset, kick, offline and source deletion; bookmarks survive', async t => {
    const f = await setup(t), station = f.streaming.service.station(f.s.id), item = f.items.find((item, index) => f.files[index].name.endsWith('.png'));
    let ticket = (await f.call('device-B', '/stations/' + f.s.id + '/ticket', 'POST', { itemId: item.id })).body;
    await f.call('device-A', '/stations/' + f.s.id + '/bookmark', 'PUT', undefined, true);
    const reset = await f.call('device-A', '/stations/' + f.s.id + '/visibility', 'POST', { visibility: 'invite', version: station.playback.version, confirmReset: true }, true); assert.equal(reset.status, 200);
    assert.equal((await fetch(f.base + ticket.url, { headers: f.headers('device-B') })).status, 403);
    assert.equal((await f.call('device-A', '/stations?kind=bookmarks', 'GET', undefined, true)).body.stations.length, 1);
    await f.call('device-A', '/stations/' + f.s.id + '/visibility', 'POST', { visibility: 'public', version: station.playback.version }, true);
    ticket = (await f.call('device-B', '/stations/' + f.s.id + '/ticket', 'POST', { itemId: item.id })).body;
    await f.call('device-A', '/stations/' + f.s.id + '/access', 'POST', { deviceId: 'device-B', allow: false }, true);
    assert.equal((await fetch(f.base + ticket.url, { headers: f.headers('device-B') })).status, 403);
    await f.call('device-A', '/stations/' + f.s.id + '/access', 'POST', { deviceId: 'device-B', allow: true }, true);
    const file = f.files[f.items.indexOf(item)]; f.store.remove('alice', file.id);
    const missing = await fetch(f.base + ticket.url, { headers: f.headers('device-B') }); assert.equal(missing.status, 422); assert.equal((await missing.json()).error, 'STREAM_SOURCE_DELETED');
    assert.equal(station.items.find(value => value.id === item.id).unavailable, 'STREAM_SOURCE_DELETED');
});
test('Markdown programme delegates its exact tunnel reference, with no unrelated media capability', async t => {
    const f = await setup(t), item = f.items.find((item, index) => f.files[index].name.endsWith('.md'));
    const main = (await f.call('device-B', '/stations/' + f.s.id + '/ticket', 'POST', { itemId: item.id })).body;
    assert.equal(main.references.length, 1);
    const delegated = await f.call('device-B', '/stations/' + f.s.id + '/ticket', 'POST', { itemId: item.id, reference: main.references[0].id }); assert.equal(delegated.status, 200);
    const image = await fetch(f.base + delegated.body.url, { headers: f.headers('device-B') }); assert.equal(image.status, 200); assert.equal((await image.arrayBuffer()).byteLength, 68);
    const forbidden = await f.call('device-B', '/stations/' + f.s.id + '/ticket', 'POST', { itemId: item.id, reference: 'image-asset' }); assert.equal(forbidden.status, 422);
    f.records.splice(0, f.records.length);
    const missing = await fetch(f.base + delegated.body.url, { headers: f.headers('device-B') }); assert.equal(missing.status, 422);
    assert.equal(f.streaming.service.station(f.s.id).items.find(value => value.id === item.id).unavailable, null, 'missing attachment must not skip the readable document');
    const document = await fetch(f.base + main.url, { headers: f.headers('device-B') }); assert.equal(document.status, 200); await document.text();
});

test('authenticated state stream broadcasts committed controls and terminates after kick', async t => {
    const f = await setup(t), controller = new AbortController(); t.after(() => controller.abort());
    await f.call('device-B', '/stations/' + f.s.id + '/report', 'POST', { watchId: 'http-watch', status: 'waiting' });
    const response = await fetch(f.base + '/api/streaming/stations/' + f.s.id + '/events', { headers: f.headers('device-B'), signal: controller.signal });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /ndjson/);
    const reader = response.body.getReader(); let pending = '';
    async function next() {
        const timeout = setTimeout(() => controller.abort(), 3000);
        try {
            while (!pending.includes('\n')) { const part = await reader.read(); if (part.done) throw Error('event-stream-ended'); pending += new TextDecoder().decode(part.value); }
            const end = pending.indexOf('\n'), line = pending.slice(0, end); pending = pending.slice(end + 1); return JSON.parse(line);
        } finally { clearTimeout(timeout); }
    }
    const first = await next();
    const control = await f.call('device-A', '/stations/' + f.s.id + '/control', 'POST', { action: 'play', version: first.station.playback.version }, true);
    assert.equal(control.status, 200);
    const changed = await next(); assert.equal(changed.station.playback.status, 'playing'); assert.ok(changed.station.playback.version > first.station.playback.version);
    await f.call('device-A', '/stations/' + f.s.id + '/access', 'POST', { deviceId: 'device-B', allow: false }, true);
    assert.equal((await next()).error, 'STREAM_KICKED');
    await reader.cancel();
});
test('HTTP device inbox, general invite account promotion and CSRF rejection use real account cookies', async t => {
    const f = await setup(t), station = f.streaming.service.station(f.s.id);
    await f.call('device-A', '/stations/' + f.s.id + '/visibility', 'POST', { visibility: 'invite', version: station.playback.version, confirmReset: true }, true);
    const general = await f.call('device-A', '/stations/' + f.s.id + '/invitations', 'POST', {}, true);
    assert.equal((await f.call('device-B', '/invitations/' + general.body.token, 'POST', { decision: 'accept' })).status, 200);
    await f.call('device-B', '/sync', 'POST', { follows: [], tunnels: [] }, true);
    assert.equal((await f.call('device-C', '/stations/' + f.s.id, 'GET', undefined, true)).status, 200);
    const direct = await f.call('device-A', '/stations/' + f.s.id + '/invitations', 'POST', { deviceId: 'device-B' }, true);
    assert.equal((await f.call('device-C', '/invitations/' + direct.body.token, 'GET', undefined, true)).status, 403);
    const inbox = await f.call('device-B', '/inbox'); assert.equal(inbox.body.invitations[0].status, 'sent');
    await f.call('device-B', '/invitations/' + direct.body.token + '/delivered', 'POST', {});
    assert.equal((await f.call('device-B', '/inbox')).body.invitations[0].status, 'delivered');
    const crossOrigin = await fetch(f.base + '/api/streaming/stations', { method: 'POST', headers: { ...f.headers('device-A', true), Origin: 'https://other.invalid', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(crossOrigin.status, 403);
});
