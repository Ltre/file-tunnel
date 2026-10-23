'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { createDiskAccountSessions } = require('../server/disk-account-sessions');
const { createStreamingConsole } = require('../server/streaming-console');
const { createStreamingBroker } = require('../server/streaming-sources');

test('two pages on the same device keep independent provider polls and try the page that owns the file', async t => {
    const broker = createStreamingBroker({ hedgeMs: 1 }); t.after(() => broker.close());
    const a = broker.poll('device', undefined, 'page-a'), b = broker.poll('device', undefined, 'page-b');
    const reading = broker.read({ kind: 'local', fileId: 'only-on-b' }, ['device'], 0, 2); reading.catch(() => {});
    const first = await a; assert.equal(first.length, 1, 'one page must not displace the other page into an immediate empty retry');
    broker.provide('device', first[0].requestId, null, 'missing');
    const second = await b; assert.equal(second.length, 1); broker.provide('device', second[0].requestId, Buffer.from('abc'));
    const chunks = []; for await (const chunk of await reading) chunks.push(chunk); assert.equal(Buffer.concat(chunks).toString(), 'abc');
});

test('repeated response backpressure releases the losing close and error listeners', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../server/streaming-http.js'), 'utf8');
    const statement = source.match(/if \(!res\.write\(chunk\)\) ([^\n]+)/)[1];
    const { waitForDrain } = require('../server/streaming-http');
    const run = new Function('res', 'once', 'waitForDrain', 'return (async()=>{' + statement + '})();');
    const response = new EventEmitter();
    for (let index = 0; index < 9; index++) {
        const pending = run(response, once, waitForDrain); response.emit('drain'); await pending;
        assert.equal(response.listenerCount('close'), 0); assert.equal(response.listenerCount('error'), 0);
    }
});

test('backpressure closure and errors reject once and clean all companion listeners', async () => {
    const { waitForDrain } = require('../server/streaming-http');
    for (const event of ['close', 'error']) { const response = new EventEmitter(), pending = waitForDrain(response); const failure = assert.rejects(pending); response.emit(event, Error('fixture')); await failure;
        for (const name of ['close','drain','error']) assert.equal(response.listenerCount(name), 0); }
});

test('OIDC redirect honours a validated explicit callback and otherwise preserves forwarded domain and scheme', () => {
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const functions = source.slice(source.indexOf('function getTelegramPublicOrigin('), source.indexOf('function isTelegramOidcMockRequest('));
    const env = {}, context = { URL, process: { env }, isTelegramOidcMockRequest: () => false };
    vm.createContext(context); vm.runInContext(functions, context);
    const req = { protocol: 'http', get: name => ({ host: '10.0.0.9', 'x-forwarded-host': 'public.example', 'x-forwarded-proto': 'https' })[name] };
    assert.equal(context.getTelegramOidcRedirectUri(req), 'https://public.example/api/telegram/drive/oidc/callback');
    env.TELEGRAM_OIDC_REDIRECT_URI = 'https://official.example/api/telegram/drive/oidc/callback';
    assert.equal(context.getTelegramOidcRedirectUri(req), env.TELEGRAM_OIDC_REDIRECT_URI);
    env.TELEGRAM_OIDC_REDIRECT_URI = 'https://official.example/elsewhere?token=bad'; assert.throws(() => context.getTelegramOidcRedirectUri(req), /redirect-uri-invalid/);
});

test('selecting offline preserves signed account records without falling back to the active cookie', () => {
    const sessions = createDiskAccountSessions({ keyForRequest: () => 'fixture-key', user: id => ({ id }) });
    const jar = new Map(), req = () => ({ headers: { cookie: [...jar].map(([k,v]) => k + '=' + v).join('; ') } });
    const res = { append(_name, value) { const [pair] = value.split(';'); const i = pair.indexOf('='); if (/Max-Age=0(?:;|$)/.test(value)) jar.delete(pair.slice(0,i)); else jar.set(pair.slice(0,i),pair.slice(i+1)); } };
    sessions.set(req(), res, { id: 'alice' }); sessions.set(req(), res, { id: 'bob' });
    const proofs = sessions.proofs(req()); sessions.select(req(), res, '');
    assert.equal(sessions.identity(req()), null); assert.equal(sessions.list(req()).length, 2);
    assert.deepEqual(sessions.proofs(req()).sort((a,b) => a.id.localeCompare(b.id)), proofs.sort((a,b) => a.id.localeCompare(b.id)));
    sessions.select(req(), res, 'alice'); assert.equal(sessions.identity(req()).id, 'alice');
});

test('retrying sources restores a valid current item after all sources were marked unavailable', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-261023-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const service = createStreamingConsole({ dataDir, sources: { resolve: async source => ({ source, name: 'a.png', size: 8, type: 'image/png' }) } });
    const actor = { deviceId: 'A', userId: null, logins: [] }; service.register('A', 'A'.repeat(40), 'A');
    const station = service.create(actor, {}); await service.edit(station.id, actor, { configVersion: 1, items: [{ id: 'one', source: { kind: 'local', fileId: 'file' } }] });
    service.visibility(station.id, actor, { visibility: 'public', version: service.station(station.id).playback.version });
    service.unavailable(station.id, 'one', 'STREAM_PROVIDER_OFFLINE');
    assert.equal(service.station(station.id).items[0].unavailable, null, 'a transient provider outage must not permanently invalidate the file');
});

test('station and subscription summaries carry their actual ordering timestamps', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-order-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true })); let now = 1000;
    const service = createStreamingConsole({ dataDir, now: () => now, user: id => ({ id }) });
    service.register('A', 'A'.repeat(40), 'A'); const actor = { deviceId: 'A', userId: null, logins: [] };
    const station = service.create(actor, {}); assert.equal(station.createdAt, 1000); assert.equal(station.updatedAt, 1000);
    now = 2000; await service.edit(station.id, actor, { configVersion: 1, items: [] });
    assert.equal(service.list(actor, 'local')[0].updatedAt, 2000);
});

test('ownership-only version changes can be reconciled but changed playlists cannot', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-revision-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const service = createStreamingConsole({ dataDir }); service.register('A', 'A'.repeat(40), 'A');
    const actor = { deviceId: 'A', userId: null, logins: [] }, station = service.create(actor, { name: 'draft' });
    const baseline = { name: station.name, configVersion: station.configVersion, loop: true, countdown: station.countdown, items: [] };
    actor.userId = 'alice'; actor.logins = [{ id: 'alice', expiresAt: Date.now()+60000, hash: 'retained-login' }]; service.ownership(station.id, actor, 'claim');
    assert.deepEqual(service.revision(station.id, actor, baseline), { matches: true, configVersion: 2 });
    await service.edit(station.id, actor, { ...baseline, configVersion: 2, name: 'changed elsewhere' });
    assert.equal(service.revision(station.id, actor, baseline).matches, false);
    await assert.rejects(service.edit(station.id, actor, baseline), error => error.message === 'STREAM_CONFLICT' && error.currentVersion === 3 && error.expectedVersion === 1);
    assert.throws(() => service.revision(station.id, { ...actor, deviceId: 'B' }, baseline), /LOCAL_ONLY/);
});

test('legacy provider-offline flags do not prevent the first viewer from resuming a station', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-legacy-health-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const service = createStreamingConsole({ dataDir, sources: { resolve: async source => ({ source, name: 'old.png', type: 'image/png', size: 8 }) } });
    service.register('A', 'A'.repeat(40), 'A'); const actor = { deviceId: 'A', userId: null, logins: [] }, station = service.create(actor, {});
    await service.edit(station.id, actor, { configVersion: 1, items: [{ id: 'old', source: { kind: 'local', fileId: 'old-file' } }] });
    const stored = service.station(station.id); stored.items[0].unavailable = 'STREAM_PROVIDER_OFFLINE'; stored.playback.itemId = null;
    service.visibility(station.id, actor, { visibility: 'public', version: stored.playback.version });
    const result = service.report(station.id, actor, { watchId: 'legacy-view', status: 'waiting' });
    assert.equal(result.station.items[0].unavailable, null); assert.equal(result.station.playback.status, 'playing'); assert.equal(result.station.playback.itemId, 'old');
    service.unavailable(station.id, 'old', 'STREAM_SOURCE_DELETED');
    assert.equal(service.station(station.id).items[0].unavailable, 'STREAM_SOURCE_DELETED', 'permanent deletion must replace a legacy transient flag');
});
