'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createStreamingConsole } = require('../server/streaming-console');
const { createStreamingBroker, createStreamingSources } = require('../server/streaming-sources');
const { createStreamingDisk } = require('../server/streaming-disk');
const { createStreamingTunnels } = require('../server/streaming-tunnels');
function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2t-stream-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    let time = 1000000;
    const revoked = new Set();
    const options = { dataDir, now: () => time, user: id => ({ id, name: id }), loginRevoked: hash => revoked.has(hash), visibleDevices: () => ['A', 'B'],
        sources: { resolve: async source => ({ source, name: source.name || 'image.jpg', type: source.type || 'image/jpeg', size: source.size || 10 }) } };
    const service = createStreamingConsole(options);
    for (const d of ['A', 'B', 'C']) service.register(d, d.repeat(40), d);
    const a = { deviceId: 'A', userId: 'U1', logins: [{ id: 'U1', hash: 'login1', expiresAt: time + 100000 }, { id: 'U2', hash: 'login2', expiresAt: time + 100000 }] };
    const b = { deviceId: 'B', userId: null, logins: [] }, c = { deviceId: 'C', userId: null, logins: [] };
    const create = input => service.create(a, input || {});
    const edit = async (s, items, extra = {}) => service.edit(s.id, a, { configVersion: service.station(s.id).configVersion,
        items: items || [{ id: 'item1', source: { kind: 'local', fileId: 'f1' } }], ...extra });
    const online = (s, visibility = 'public') => service.visibility(s.id, a, { visibility, confirmReset: true, version: service.station(s.id).playback.version });
    const command = (s, action, extra = {}) => service.control(s.id, a, { action, version: service.station(s.id).playback.version, ...extra });
    return { service, a, b, c, create, edit, online, command, options, revoked, time: n => { time += n; }, dataDir };
}
test('device capability rejects impersonation and creation retries keep one identity', t => {
    const f = fixture(t);
    assert.throws(() => f.service.authenticate('A', 'B'.repeat(40)), /DEVICE_DENIED/);
    assert.throws(() => f.service.register('A', 'B'.repeat(40), 'attacker'), /DEVICE_DENIED/);
    const first = f.create({ creationId: 'request1' }), second = f.create({ creationId: 'request1' });
    assert.equal(first.id, second.id);
    assert.equal(f.service.list(f.a, 'local').length, 1);
});

test('verified legacy device aliases preserve one-way discovery and fixed-device offline invitations', async t => {
    const f = fixture(t), s = f.create(); await f.edit(s); f.online(s);
    f.service.syncDevice(f.a, { aliases: ['legacy-A'] }); f.service.syncDevice(f.b, { aliases: ['legacy-B'] });
    const service = createStreamingConsole({ ...f.options, visibleDevices: () => [] });
    const manager = { ...f.a, deviceId: 'C' };
    service.syncDevice(manager, { follows: ['legacy-A', 'legacy-B', 'legacy-D'] });
    assert.equal(service.list(f.c).length, 1, 'one-way follows of a tunnel alias discover its source device');
    const direct = service.invitation(s.id, manager, { deviceId: 'legacy-B' });
    assert.equal(direct.deviceId, 'B'); assert.equal(service.inbox(f.b).length, 1);
    assert.throws(() => service.inspectInvite(direct.token, f.c), /INVITE_DEVICE/);
    const waiting = service.invitation(s.id, manager, { deviceId: 'legacy-D' });
    service.register('D', 'D'.repeat(40), 'D'); const d = { deviceId: 'D', userId: null, logins: [] };
    service.syncDevice(d, { aliases: ['legacy-D'] });
    assert.equal(service.inbox(d).length, 1); service.delivered(waiting.token, d);
    assert.equal(service.invitations(s.id, manager).find(value => value.id === waiting.id).deviceId, 'D');
    service.accept(waiting.token, d); assert.equal(service.view(s.id, d).id, s.id);
});
test('anonymous creation, login without claiming and explicit local ownership', async t => {
    const f = fixture(t), s = f.service.create({ ...f.a, userId: null }, {});
    f.service.syncDevice(f.a); assert.equal(f.service.station(s.id).ownerId, null);
    f.service.ownership(s.id, f.a, 'claim'); assert.equal(f.service.station(s.id).ownerId, 'U1');
    assert.throws(() => f.service.ownership(s.id, { ...f.a, deviceId: 'B' }, 'release'), /LOCAL_ONLY/);
    f.service.ownership(s.id, f.a, 'release'); assert.equal(f.service.station(s.id).ownerId, null);
});
test('retained accounts run through selection, logout locks only matching local stations', async t => {
    const f = fixture(t), s1 = f.create(), s2 = f.service.create({ ...f.a, userId: 'U2' }, {});
    const unowned = f.create({ unowned: true });
    for (const s of [s1, unowned]) { await f.edit(s); f.online(s); }
    f.service.visibility(s2.id, { ...f.a, userId: 'U2' }, { visibility: 'public', version: 1 });
    f.service.syncDevice({ ...f.a, userId: 'U2' }); assert.equal(f.service.station(s1.id).visibility, 'public');
    assert.throws(() => f.service.control(s1.id, { ...f.a, userId: 'U2' }, { action: 'play', version: 1 }), /OWNER_REQUIRED/);
    f.service.revokeLogin('login1');
    assert.equal(f.service.station(s1.id).visibility, 'offline'); assert.equal(f.service.station(s2.id).visibility, 'public');
    assert.equal(f.service.station(unowned.id).visibility, 'public');
    assert.throws(() => f.service.visibility(s1.id, { ...f.a, deviceId: 'B' }, { visibility: 'public', version: 2 }), /SOURCE_LOGIN_REQUIRED/);
    f.service.syncDevice(f.a); assert.equal(f.service.station(s1.id).visibility, 'offline');
});
test('remote owner has controls but no source editing/deletion/release; viewer cannot control', async t => {
    const f = fixture(t), s = f.create(); await f.edit(s); f.online(s);
    const remote = { ...f.a, deviceId: 'B' };
    assert.equal(f.service.view(s.id, remote).manageable, true);
    await assert.rejects(f.service.edit(s.id, remote, { items: [], configVersion: 2 }), /LOCAL_ONLY/);
    assert.throws(() => f.service.remove(s.id, remote), /LOCAL_ONLY/);
    assert.throws(() => f.service.control(s.id, f.b, { action: 'play', version: 2 }), /OWNER_REQUIRED/);
    const s2 = f.service.create({ ...f.a, userId: null }, {});
    assert.throws(() => f.service.control(s2.id, f.b, { action: 'play', version: 1 }), /OWNER_REQUIRED/);
});
test('unwatched clock advances across static and AV items, pause and nonloop stop', async t => {
    const f = fixture(t), s = f.create();
    await f.edit(s, [{ id: 'img', stay: 10, source: { kind: 'local', fileId: 'image' } },
        { id: 'vid', duration: 30, start: 10, source: { kind: 'local', fileId: 'video', name: 'movie.mp4', type: 'video/mp4' } }]);
    f.online(s); f.command(s, 'play'); f.time(15000);
    let state = f.service.view(s.id, f.b); assert.equal(state.playback.itemId, 'vid'); assert.equal(state.playback.position, 5);
    f.command(s, 'pause'); f.time(10000); assert.equal(f.service.view(s.id, f.b).playback.position, 5);
    f.service.station(s.id).login.expiresAt += 1000000000;
    f.command(s, 'play'); f.time(900000000); state = f.service.view(s.id, f.b); assert.equal(state.playback.itemId, 'vid'); assert.equal(state.playback.position, 5);
    await f.edit(s, null, { loop: false }); f.command(s, 'play'); f.time(11000);
    assert.equal(f.service.view(s.id, f.b).playback.status, 'stopped');
});
test('repeat source identity and live reorder preserve current item, removed and cleared items progress', async t => {
    const f = fixture(t), s = f.create(), source = { kind: 'local', fileId: 'same' };
    await f.edit(s, [{ id: 'one', source }, { id: 'two', source }, { id: 'three', source }]);
    f.online(s); f.command(s, 'select', { itemId: 'two' }); f.command(s, 'play'); f.time(4000);
    await f.edit(s, [{ id: 'three' }, { id: 'two' }, { id: 'one' }]);
    assert.equal(f.service.view(s.id, f.b).playback.itemId, 'two'); assert.equal(f.service.view(s.id, f.b).playback.position, 4);
    await f.edit(s, [{ id: 'three' }, { id: 'one' }]); assert.equal(f.service.view(s.id, f.b).playback.itemId, 'one');
    await f.edit(s, []); assert.equal(f.service.view(s.id, f.b).playback.status, 'stopped');
});
test('invalid AV start and stale configuration/command versions are rejected atomically', async t => {
    const f = fixture(t), s = f.create();
    await assert.rejects(f.edit(s, [{ id: 'vid', duration: 10, start: 10, source: { kind: 'local', name: 'a.mp4', type: 'video/mp4' } }]), /START_INVALID/);
    assert.equal(f.service.station(s.id).items.length, 0);
    await f.edit(s); f.online(s); const version = f.service.station(s.id).playback.version;
    f.command(s, 'play'); assert.throws(() => f.service.control(s.id, f.a, { action: 'pause', version }), /CONFLICT/);
    await assert.rejects(f.service.edit(s.id, f.a, { items: [], configVersion: 1 }), /CONFLICT/);
});
test('general grants survive expiry/revoke, anonymous later login carries grant, bookmarks remain independent', async t => {
    const f = fixture(t), s = f.create(); await f.edit(s); f.online(s, 'invite');
    const invite = f.service.invitation(s.id, f.a, { hours: 1 }); f.service.accept(invite.token, f.b);
    f.service.syncDevice({ ...f.b, userId: 'viewer' });
    f.service.revoke(s.id, f.a, invite.id); f.time(3600001);
    const remote = { ...f.c, userId: 'viewer' };
    // Keep owner login alive to isolate invitation expiry.
    f.service.station(s.id).login.expiresAt += 86400000;
    assert.equal(f.service.view(s.id, remote).id, s.id);
    assert.deepEqual(f.service.list(remote, 'bookmarks'), []);
    f.service.bookmark(s.id, remote, true); f.service.bookmark(s.id, remote, false);
    assert.equal(f.service.view(s.id, remote).id, s.id);
    assert.throws(() => f.service.accept(invite.token, f.c), /REVOKED/);
});
test('direct device grant never expands through account; offline inbox reflects delivery and real outcomes', async t => {
    const f = fixture(t), s = f.create(); await f.edit(s); f.online(s, 'invite');
    const invite = f.service.invitation(s.id, f.a, { deviceId: 'B' });
    assert.equal(f.service.invitations(s.id, f.a)[0].status, 'sent');
    assert.equal(f.service.inbox(f.b)[0].status, 'sent');
    f.service.delivered(invite.token, f.b); assert.equal(f.service.inbox(f.b)[0].status, 'delivered');
    f.service.accept(invite.token, { ...f.b, userId: 'viewer' });
    assert.equal(f.service.invitations(s.id, f.a)[0].status, 'accepted');
    assert.throws(() => f.service.view(s.id, { ...f.c, userId: 'viewer' }), /INVITATION_REQUIRED/);
    assert.throws(() => f.service.accept(invite.token, f.c), /INVITE_DEVICE/);
});
test('public to invite invalidates all old grants/invitations but keeps bookmarks; kick cannot reenter', async t => {
    const f = fixture(t), s = f.create(); await f.edit(s); f.online(s);
    const viewer = { ...f.b, userId: 'viewer' }, invite = f.service.invitation(s.id, f.a, {});
    f.service.accept(invite.token, viewer); f.service.bookmark(s.id, viewer, true); f.online(s, 'invite');
    assert.throws(() => f.service.view(s.id, viewer), /INVITATION_REQUIRED/);
    assert.throws(() => f.service.accept(invite.token, viewer), /REVOKED/);
    assert.equal(f.service.list(viewer, 'bookmarks').length, 1);
    f.online(s); f.service.access(s.id, f.a, 'B', false);
    assert.throws(() => f.service.view(s.id, viewer), /KICKED/);
    const fresh = f.service.invitation(s.id, f.a, {}); assert.throws(() => f.service.accept(fresh.token, viewer), /KICKED/);
    f.service.access(s.id, f.a, 'B', true); assert.equal(f.service.view(s.id, viewer).id, s.id);
});
test('discovery is device scoped while creator/public link can expose public stations across devices', async t => {
    const f = fixture(t), s = f.create(); await f.edit(s); f.online(s);
    // visibleDevices includes A; a fixture without that relationship shows none.
    const separate = createStreamingConsole({ ...f.options, visibleDevices: () => [] });
    assert.equal(separate.list(f.c).length, 0);
    assert.equal(separate.list(f.c, 'creator', 'U1').length, 1);
    assert.equal(separate.view(s.id, f.c).id, s.id);
    assert.equal(separate.list({ ...f.a, deviceId: 'C' }, 'local').length, 0);
});
test('restart resumes elapsed clock without creator and no media bytes; genuine session expiry locks', async t => {
    const f = fixture(t), s = f.create(); await f.edit(s); f.online(s); f.command(s, 'play'); f.time(5000);
    const restored = createStreamingConsole(f.options); assert.equal(restored.view(s.id, f.b).playback.position, 5);
    const raw = fs.readFileSync(path.join(f.dataDir, 'streaming-console.json'), 'utf8'); assert.ok(!raw.includes('base64,'));
    f.time(100001); restored.tick(); assert.equal(restored.station(s.id).visibility, 'offline');
    assert.throws(() => restored.control(s.id, f.a, { action: 'play', version: 1 }), /SOURCE_LOGIN_REQUIRED/);
    restored.remove(s.id, { ...f.a, userId: null }); assert.equal(restored.list(f.a, 'local').length, 0);
});
test('source failures skip independent entries and all unavailable stops without infinite loops', async t => {
    const f = fixture(t), s = f.create(); await f.edit(s, [{ id: 'a', source: { fileId: 'same' } }, { id: 'b', source: { fileId: 'same' } }]);
    f.online(s); f.command(s, 'play'); f.service.unavailable(s.id, 'a', 'deleted');
    assert.equal(f.service.view(s.id, f.b).playback.itemId, 'b'); f.service.unavailable(s.id, 'b', 'deleted');
    assert.equal(f.service.view(s.id, f.b).playback.status, 'stopped');
});
test('source adapter delegates existing storage reads, checks deletion and never mutates disk', async () => {
    let exists = true, opened = 0;
    const disk = createStreamingDisk({ identity: req => req.headers['x-disk-account'] === 'owner' ? { id: 'owner' } : null,
        partitions: { find: (owner, space) => { assert.equal(owner, 'owner'); return { scopeKey: space }; } },
        objects: { list: () => exists ? [{ kind: 'file', key: 'dir/a.txt', file: { id: 'f', name: 'a.txt' }, type: 'text/plain', size: 4 }] : [],
            open: async (scope, key, range) => { opened++; assert.equal(key, 'dir/a.txt'); assert.equal(range, 'bytes=0-3'); return { stream: require('node:stream').Readable.from('test') }; } } });
    const item = disk.resolve({ headers: {}, query: {} }, { accountId: 'owner', fileId: 'f' });
    const stream = await disk.read(item.source, 0, 3); assert.equal((await Array.fromAsync(stream)).join(''), 'test'); assert.equal(opened, 1);
    exists = false; assert.throws(() => disk.stat(item.source), /SOURCE_DELETED/);
});
test('ephemeral broker restricts provider identity, exact ranges and closes pending reads', async t => {
    const broker = createStreamingBroker({ timeout: 200 }); t.after(() => broker.close());
    const controller = new AbortController(); const work = broker.poll('A', controller.signal);
    const read = broker.read({ kind: 'local', fileId: 'f' }, ['A'], 2, 5);
    const [request] = await work;
    assert.throws(() => broker.provide('B', request.requestId, Buffer.from('abcd')), /EXPIRED/);
    assert.throws(() => broker.provide('A', request.requestId, Buffer.from('a')), /RANGE_INVALID/);
    broker.provide('A', request.requestId, Buffer.from('abcd')); const stream = await read;
    assert.equal((await Array.fromAsync(stream)).join(''), 'abcd');
    await assert.rejects(broker.read({}, ['offline'], 0, 1), /PROVIDER_OFFLINE/);
});
test('Markdown references authorize only explicit tunnel resources and messages are idempotent', async () => {
    const records = [{ id: 'message1', type: 'file', fileInfo: { id: 'asset1', name: 'x.jpg', type: 'image/jpeg', size: 1 } }];
    const tunnel = createStreamingTunnels({ session: () => ({}), messages: () => records,
        admitted: (_s, _d, proof) => proof === 'valid', capability: () => true, publish: (_s, _session, message) => records.push(message) });
    assert.throws(() => tunnel.resolve({ sessionId: 'tunnel', messageId: 'message1', fileId: 'asset1' }, { deviceId: 'A' }), /TUNNEL_DENIED/);
    const input = { sessionId: 'tunnel', accessGrant: 'valid', messageId: 'message2', body: '![image](tunnel-blob:tunnel/message1/asset1)', tunnelGrants: { tunnel: 'valid' } };
    tunnel.send(input, { deviceId: 'A' }); assert.equal(tunnel.send(input, { deviceId: 'A' }).duplicate, true);
    assert.equal(records.length, 2);
    const sources = createStreamingSources({ disk: {}, tunnel, broker: createStreamingBroker() });
    const text = Buffer.from(input.body); const source = { kind: 'local', deviceId: 'A', fileId: 'md', name: 'notes.md', type: 'text/markdown', size: text.length, tunnelGrants: input.tunnelGrants };
    // Resolve through the real broker, proving no unreferenced file is added.
    const work = sources.broker.poll('A'); const resolving = sources.resolve(source, { deviceId: 'A' });
    const [request] = await work; sources.broker.provide('A', request.requestId, text);
    const resolved = await resolving; assert.equal(resolved.references.length, 1); assert.equal(resolved.references[0].source.fileId, 'asset1'); sources.broker.close();
});
test('invitation retry is idempotent; accepting then revoking does not revoke the grant', async t => {
    const f = fixture(t), s = f.create(); await f.edit(s); f.online(s, 'invite');
    const a = f.service.invitation(s.id, f.a, { requestId: 'one-request' }), b = f.service.invitation(s.id, f.a, { requestId: 'one-request' });
    assert.equal(a.token, b.token); assert.equal(f.service.invitations(s.id, f.a).length, 1);
    f.service.accept(a.token, f.b); f.service.revoke(s.id, f.a, a.id); assert.equal(f.service.view(s.id, f.b).id, s.id);
});
test('tunnel source rights are rechecked without altering the transfer service', () => {
    let readable = true;
    const records = [{ id: 'r1', type: 'file', fileInfo: { id: 'f1', name: 'binary.bin', type: 'application/octet-stream', size: 3 } }];
    const adapter = createStreamingTunnels({ session: () => ({}), messages: () => records, admitted: () => true, capability: () => readable });
    const input = { sessionId: 'tunnel', messageId: 'r1', fileId: 'f1', accessGrant: 'proof' };
    assert.equal(adapter.candidates(input, { deviceId: 'A' }).candidates.length, 0);
    assert.equal(adapter.resources(input, { deviceId: 'A' }).candidates.length, 1);
    const source = adapter.resolve(input, { deviceId: 'A' }).source; readable = false;
    assert.throws(() => adapter.stat(source), /SOURCE_REVOKED/);
});
test('all unavailable can be retried explicitly; a nonloop failed last item does not wrap', async t => {
    const f = fixture(t), s = f.create(); await f.edit(s, [{ id: 'first', source: { fileId: 'f' } }, { id: 'last', source: { fileId: 'l' } }], { loop: false });
    f.online(s); f.command(s, 'select', { itemId: 'last' }); f.command(s, 'play'); f.service.unavailable(s.id, 'last', 'missing');
    assert.equal(f.service.view(s.id, f.b).playback.status, 'stopped');
    f.service.unavailable(s.id, 'first', 'missing'); f.command(s, 'retry');
    assert.ok(f.service.station(s.id).items.every(item => !item.unavailable)); assert.equal(f.service.view(s.id, f.b).playback.status, 'paused');
});
