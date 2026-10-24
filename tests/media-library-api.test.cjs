'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { Readable } = require('node:stream');
const { createFixture } = require('./support/media-library-fixture.cjs');
const { createMediaRoutes } = require('../server/media-library/routes');
const { createMediaDiskAdapter, createLoopbackSource } = require('../server/media-library/disk-adapter');
const { createDiskAuth } = require('../server/disk-auth'), { createDiskOperations } = require('../server/disk-operations'), { createTelegramDriveStore } = require('../server/telegram-drive'), { createDiskAPI } = require('../server/disk-api');

test('state delivers usable source media metadata without internal probe locations or unlisted fields', async t => {
    const f = createFixture(), app = express();
    app.use('/media', createMediaRoutes({ service: f.service, disk: f.disk, downloads: f.downloads, identity: () => ({ id: 'alice' }), requireAuth: (_req, _res, next) => next(), origin: () => 'http://localhost' }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.close(); });
    f.service.processing.probe = async () => ({
        format: { filename: 'http://internal.test/private?token=secret', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '4', bit_rate: '1200000', tags: { encoder: 'Lavf', private_url: 'secret' } },
        streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '25/1', disposition: { attached_pic: 0 }, tags: { language: 'eng', private_path: 'secret' }, source: '/private/source' },
            { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, bit_rate: '128000' }], private: 'secret'
    });
    const resource = f.service.createImport({ kind: 'disk', ...f.put('video') }, { id: 'alice' }); await f.service.pump();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/media/state`); assert.equal(response.status, 200);
    const actual = (await response.json()).imports.find(value => value.id === resource.id);
    assert.equal(actual.available, true); assert.equal(actual.probe?.format?.bit_rate, '1200000');
    assert.equal(actual.probe.streams[0].width, 1920); assert.equal(actual.probe.streams[0].height, 1080);
    assert.equal(actual.probe.streams[1].sample_rate, '48000'); assert.equal(actual.probe.streams[1].channels, 2);
    assert.equal(actual.probe.streams[0].tags.language, 'eng'); assert.equal(actual.probe.format.tags.encoder, 'Lavf');
    assert.doesNotMatch(JSON.stringify(actual.probe), /internal\.test|private|secret/); assert.equal(actual.bindToken, undefined);
});

test('frame neighbors step relative to the displayed frame and provide an interior seek point; invalid times and revoked reads remain blocked', async t => {
    const f=createFixture(),app=express();app.use(express.json());
    app.use('/media',createMediaRoutes({service:f.service,disk:f.disk,downloads:f.downloads,identity:()=>({id:'alice'}),requireAuth:(_req,_res,next)=>next(),origin:()=> 'http://localhost'}));
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.close();});
    const resource=f.service.createImport({kind:'disk',...f.put('video')},{id:'alice'});await f.service.pump();
    const base=`http://127.0.0.1:${server.address().port}/media/imports/${resource.id}/frame-neighbor`;
    const reply=await (await fetch(base+'?time=0.45')).json();assert.equal(reply.previous,.32);assert.equal(reply.next,.48);
    assert.ok(reply.previousSeekTime>.32&&reply.previousSeekTime<.4);assert.ok(reply.nextSeekTime>=.48);
    const precise=await fetch(base+'?time=0.42600900000000004&player_time=0.42600900000000004');assert.equal(precise.status,200);
    assert.equal((await precise.json()).next,.48);
    for(const value of ['', 'NaN', 'Infinity', '-1', '0:01', '1&time=2'])assert.equal((await fetch(base+'?time='+value)).status,422);
    assert.equal((await fetch(base+'?time=0.4&cache_id=missing')).status,422);
    assert.equal((await fetch(base+'?time=99')).status,422);
    const session=f.service.createSession(resource.id,'same playback source'),job=f.service.clip(session.id,{start:.37,end:1.81},true);await f.service.pump();
    const cacheId=f.service.get('job',job.id).result.cacheId,probed=[];
    f.service.processing.frameNeighbors=async url=>{probed.push(url);return [.32,.4,.48];};
    const segment=await fetch(base+'?time=0.8260090000000001&player_time=0.45600900000000005&cache_id='+cacheId);assert.equal(segment.status,200);
    const frame=await segment.json();assert.ok(Math.abs(frame.next-.85)<1e-9);assert.equal(frame.nextFrameTime,.48);assert.equal(probed.at(-1).startsWith('http:'),false);
    await fetch(base+'?time=0.45');assert.equal(probed.at(-1).startsWith('http:'),true,'original playback does not silently probe a cached encoding');
    const other=f.service.createImport({kind:'disk',...f.put('other-video')},{id:'alice'});await f.service.pump();
    const forged=await fetch(base.replace(resource.id,other.id)+'?time=0.4&cache_id='+cacheId);assert.equal(forged.status,422);assert.equal((await forged.json()).error,'MEDIA_SEGMENT_SOURCE_INVALID');
    f.files.delete(f.service.get('import',resource.id).file.fileId);const denied=await fetch(base+'?time=0.45');assert.equal(denied.status,403);
});
test('admin API guards identity and origin, serves ranges, and revoked grants block media reads', async t => {
    const f = createFixture(); const app = express(); app.use(express.json());
    app.use('/api/media-library', createMediaRoutes({ service: f.service, disk: f.disk, downloads: f.downloads, identity: req => req.get('X-Test-Account') ? { id: req.get('X-Test-Account') } : null,
        requireAuth: (req, res, next) => req.get('X-Test-Admin') === '1' ? next() : res.status(401).json({ error: 'AUTH_REQUIRED' }), origin: () => 'http://localhost' }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await f.close(); });
    const base = `http://127.0.0.1:${server.address().port}/api/media-library`, headers = { 'X-Test-Admin': '1', 'X-Test-Account': 'alice', 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/state')).status, 401);
    const wrongOrigin = await fetch(base + '/imports', { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{}' }); assert.equal(wrongOrigin.status, 403); await wrongOrigin.arrayBuffer();
    const ref = f.put('0123456789'), request = { method: 'POST', headers, body: JSON.stringify({ kind: 'disk', ...ref }) };
    const forged = await fetch(base + '/imports', { ...request, headers: { ...headers, 'X-Test-Account': 'bob' } }); assert.equal(forged.status, 403); await forged.arrayBuffer();
    const record = await (await fetch(base + '/imports', request)).json(); await f.service.pump();
    const partial = await fetch(base + '/files/' + record.id, { headers: { ...headers, Range: 'bytes=2-5' } }); assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await partial.text(), '2345');
    const local = await f.service.receive({ name: '本地.mp4', size: 5 }, Readable.from(['video']), { id: 'alice' }); await f.service.pump(); f.service.revoke(f.service.config().workspace.grantId);
    const blocked = await fetch(base + '/files/' + local.id, { headers }); assert.equal(blocked.status, 403); assert.match((await blocked.json()).error, /AUTHORIZATION_REVOKED/);
    const state = await (await fetch(base + '/state', { headers })).json(); assert.equal(state.imports.find(r => r.id === local.id).available, false); assert.equal(state.imports.find(r => r.id === record.id).available, true);
});
test('loopback read cancellation reaches upstream; invalid paths cannot read data', async t => {
    let aborted = false; const source = await createLoopbackSource(async (range, signal) => {
        const stream = new Readable({ read() {} }); const timer = setInterval(() => stream.push(Buffer.alloc(512)), 10);
        signal.addEventListener('abort', () => { aborted = true; clearInterval(timer); stream.destroy(); }, { once: true }); stream.once('close', () => clearInterval(timer));
        return { object: { size: 10000000 }, range: { start: 0, end: 9999999 }, stream };
    }); t.after(() => source.close());
    assert.equal((await fetch(new URL('/not-the-token', source.url))).status, 404);
    const response = await fetch(source.url); const reader = response.body.getReader(); await reader.read(); await reader.cancel();
    for (let n = 0; n < 100 && !aborted; n++) await new Promise(r => setTimeout(r, 10)); assert.equal(aborted, true);
    const stop = new AbortController(); stop.abort(); await assert.rejects(createLoopbackSource(() => {}, stop.signal), /MEDIA_CANCELLED/);
});
test('real drive adapter stores verified content references, preserves others on delete, and validates ownership', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr2t-media-adapter-')), auth = createDiskAuth({ dataDir }), owner = auth.fromTelegram({ id: '999001' }), other = auth.fromTelegram({ id: '999002' });
    const bytes = new Map(); let messages = 0;
    const telegram = { check: async () => true, call: async () => true, parts: file => file.parts,
        readPart: async (backend, part, { start = 0, end = part.size - 1 } = {}) => Readable.from([bytes.get(part.fileId).subarray(start, end + 1)]),
        uploadPhysical: async (backend, files, parts) => parts.map(part => { const id = 'test-' + ++messages; bytes.set(id, fs.readFileSync(part.path)); return { ...part, fileId: id, fileUniqueId: id, messageId: messages, mediaType: 'document' }; }), remove: async () => {} };
    const operations = createDiskOperations({ dataDir }), store = createTelegramDriveStore({ dataDir }), api = createDiskAPI({ dataDir, defaultStore: store, auth, operations, telegram, getDefaultBackend: () => ({ token: 'fixture', channelId: '-100123', baseUrl: 'https://example.test' }), getIdentity: () => owner, isMockRequest: () => true, contentCleanupMode: 'observe' });
    t.after(() => { api.close(); require('../server/disk-repository').openDiskRepository(dataDir).close(); if (!dataDir.startsWith(path.join(os.tmpdir(), 'dr2t-media-adapter-'))) throw Error('unsafe cleanup'); fs.rmSync(dataDir, { recursive: true, force: true }); });
    store.createDirectory(owner.id, 'workspace'); const adapter = createMediaDiskAdapter({ dataDir, diskAPI: api, auth, backend: () => ({ token: 'fixture', channelId: '-100123' }) });
    assert.throws(() => adapter.location({ userId: owner.id, path: 'workspace' }, other), /NOT_AUTHORIZED/);
    const loc = adapter.location({ userId: owner.id, path: 'workspace' }, owner), body = path.join(dataDir, 'body.mp4'); fs.writeFileSync(body, 'shared-content');
    const nested=await adapter.ensureDirectory(loc,'提取会话/clips',()=>{});assert.equal(nested.path,'workspace/提取会话/clips');assert.ok(store.getDirectoryRecord(owner.id,nested.path));
    assert.equal((await adapter.ensureDirectory(loc,'提取会话/clips',()=>{})).path,nested.path);assert.equal(messages,0,'creating session folders does not upload media');
    await assert.rejects(adapter.ensureDirectory(loc,'../outside',()=>{}));
    await assert.rejects(adapter.ensureDirectory(loc,'禁止创建',()=>{throw Error('MEDIA_AUTHORIZATION_REVOKED');}),/REVOKED/);assert.equal(store.getDirectoryRecord(owner.id,'workspace/禁止创建'),null);
    const progress = [], reused = [];
    const a = await adapter.write(loc, body, 'a.mp4', 'producer-a', () => {}, undefined, patch => progress.push(patch)), b = await adapter.write(loc, body, 'b.mp4', 'producer-b', () => {}, undefined, patch => reused.push(patch));
    assert.ok(progress.some(patch => patch.phase === 'hashing')); assert.ok(progress.some(patch => Number.isFinite(patch.telegramBytesSent)), 'the existing Telegram upload pipeline reports real byte progress');
    assert.equal(progress.at(-1).phase, 'committing'); assert.ok(reused.some(patch => patch.phase === 'verifying')); assert.equal(reused.at(-1).phase, 'committing');
    assert.equal(messages, 1, 'second body reuses verified Content Object without re-sending'); assert.equal(adapter.file(a).item.contentId, adapter.file(b).item.contentId);
    store.createDirectory(other.id, 'collection'); const otherLocation = adapter.location({ userId: other.id, path: 'collection' }, other);
    const c = await adapter.write(otherLocation, body, 'c.mp4', 'producer-c', () => {});
    assert.equal(adapter.file(c).item.contentId, adapter.file(a).item.contentId); assert.equal(messages, 1, 'verified whole-body possession also supports explicitly authorized cross-account collection');
    assert.equal((await adapter.write(loc, body, 'a.mp4', 'producer-a', () => {})).fileId, a.fileId); assert.equal(messages, 1);
    assert.throws(() => adapter.file({ ...a, userId: other.id, partitionId: undefined }), /SOURCE_UNAVAILABLE/);
    const opened = await adapter.open(a, 'bytes=0-5'); let bodyRead = ''; for await (const part of opened.stream) bodyRead += part; assert.equal(bodyRead, 'shared');
    await adapter.remove(a, 'producer-a', () => {}); assert.throws(() => adapter.file(a), /SOURCE_UNAVAILABLE/); assert.equal(adapter.file(b).item.id, b.fileId);
    const staging = path.join(dataDir, 'telegram-drive-staging', '12345678-1234-1234-1234-123456789012'); fs.mkdirSync(staging, { recursive: true }); fs.writeFileSync(path.join(staging, 'upload-manifest.json'), JSON.stringify({ metadata: { mediaProducerId: 'pending' } }));
    await assert.rejects(adapter.write(loc, body, 'pending.mp4', 'pending', () => {}), /MEDIA_WRITE_PENDING/); assert.equal(messages, 1);
});
