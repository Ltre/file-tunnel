'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), os = require('node:os'), path = require('node:path');
const { createInfraStore } = require('../server/infra-store');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const section = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

async function fixture(t, type, sourceSessionId = 'source-A') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwarded-server-assets-261117-'));
    const infraStore = await createInfraStore({ dataDir: dir });
    t.after(() => { infraStore.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const file = { id: 'copy-media', name: 'clip.mp4', size: 1024, type: 'video/mp4', isAsset: false,
        isServerAsset: true, serverAssetUrl: '/api/server-assets/source-media', backupSourceSessionId: sourceSessionId, forwardedToSessionId: 'target-B' };
    const message = { id: 'older-copy-record', type, sender: 'forwarder', forwardedFrom: { sessionId: sourceSessionId, messageId: 'source-record' },
        ...(type === 'file' ? { fileInfo: file } : { collection: { files: [file] } }) };
    infraStore.recordHistoryMessage('target-B', message, { source: 'cross-tunnel-forward' });
    const target = { devices: new Map([['target-only-viewer', {}]]), history: [], fileAssets: new Map() };
    const events = [], errors = []; let middleware;
    const gate = { sessions: new Map([['target-B', target]]), infraStore, currentSession: 'target-B', currentDevice: 'target-only-viewer',
        trustedInternalClient: false, canUseTunnelCapability: () => true, tunnelAccess: { verify: () => false, verifyFileForward: () => false },
        socket: { data: {}, use: fn => { middleware = fn; }, to: () => ({ emit() {} }) }, emitSocketError: (name, message) => errors.push({ name, message }) };
    vm.runInNewContext(section(server, 'function canReadForwardedFile(', 'function getSessionPermissionPayload(') +
        section(server, '    socket.use(([event,data],next)=>{', "    socket.on('session-short-code-update'"), gate);
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/file-assets.js'), 'utf8'), {
        window, Blob, ArrayBuffer, Uint8Array, DataView, setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout,
        console: { log() {}, warn() {}, error() {} }
    });
    const transfer = new window.FileAssetTransfer({ getSessionId: () => 'target-B', load: async () => null,
        getTunnelAuthorization: () => null, log() {}, getSocket: () => ({ connected: true, emit: (name, data) => {
            let accepted = false; middleware([name, data], () => { accepted = true; }); events.push({ name, data, accepted });
        } }) });
    const scheduled = [], jobs = [];
    const context = { fileAssetTransfer: transfer, getCollectionFiles: value => value.collection.files,
        getFromStore: async () => null, shouldAutoRequestFileAssetCache: () => true, historyLog() {}, summarizeHistoryMessage: value => value.id,
        scheduleServerAssetRecovery: (metadata, owner, reason) => { scheduled.push({ metadata, owner, reason }); jobs.push(transfer.request(metadata.id, owner, metadata)); } };
    vm.runInNewContext(section(app, 'async function requestMissingFileAssetCache(', 'async function handleMessage('), context);
    return { context, message, file, scheduled, jobs, events, errors, target, transfer, gate, infraStore };
}

for (const type of ['file', 'collection']) test('forwarded SNS ' + type + ' backfill keeps its persisted destination anchor without source membership', async t => {
    const f = await fixture(t, type);
    if (type === 'file') await f.context.requestMissingFileAssetCache(f.message, 'snapshot-background');
    else await f.context.requestMissingCollectionAssetCaches(f.message, 'snapshot-collection-background');
    await Promise.all(f.jobs);
    assert.equal(f.scheduled[0].metadata.recordMessageId, f.message.id);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].data.sourceSessionId, 'source-A');
    assert.equal(f.events[0].data.recordMessageId, f.message.id);
    assert.equal(f.events[0].accepted, true, JSON.stringify(f.errors));
    assert.deepEqual(f.errors, []);
    assert.equal(f.target.devices.size, 1, 'read authorization must not join the private source');
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', 'source-original', f.message.id), false);
    f.infraStore.markHistoryDeleted('target-B', f.message.id);
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', f.file.id, f.message.id), false, 'a deleted copy grants no access');
});

for (const scope of ['messageId', 'collectionMessageId']) test('a forwarded Web ZIP preview carries its ' + scope + ' anchor into cache recovery', async t => {
    const f = await fixture(t, 'file'), jobs = [], seen = [];
    const context = { state: { sessionId: 'target-B' }, filePreviewLoadVersion: 0,
        openWebZipStandalone: (metadata, options) => { seen.push({ metadata, options }); jobs.push(f.transfer.request(metadata.id, 'forwarder', metadata)); return true; } };
    vm.runInNewContext(section(app, 'async function openFilePreviewForInfo(', 'async function openFileRecord('), context);
    assert.equal(await context.openFilePreviewForInfo({ ...f.file, name: 'web.html.zip' }, { [scope]: f.message.id }), true);
    await Promise.all(jobs);
    assert.equal(seen[0].metadata.recordMessageId, f.message.id);
    assert.equal(f.events[0].accepted, true, JSON.stringify(f.errors));
    assert.deepEqual(f.errors, []);
});

test('a twice-forwarded media copy reads its immediate predecessor without granting the original private asset', async t => {
    const f = await fixture(t, 'collection', 'middle-C');
    await f.context.requestMissingCollectionAssetCaches(f.message, 'snapshot-collection-background');
    await Promise.all(f.jobs);
    assert.equal(f.events[0].data.sourceSessionId, 'middle-C');
    assert.equal(f.events[0].accepted, true, JSON.stringify(f.errors));
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', f.file.id, f.message.id), false);
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'middle-C', 'private-original', f.message.id), false);
    assert.deepEqual(f.errors, []);
});

for (const type of ['file', 'collection']) test('persisted destination copy remains readable when a recovery request has no record hint (' + type + ')', async t => {
    const f = await fixture(t, type);
    await f.transfer.request(f.file.id, 'forwarder', { ...f.file });
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].data.recordMessageId, undefined);
    assert.equal(f.events[0].accepted, true, JSON.stringify(f.errors));
    assert.equal(f.gate.canReadForwardedFile('target-B', 'outsider', 'source-A', f.file.id), false);
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'wrong-source', f.file.id), false);
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', 'private-original'), false);
    f.infraStore.markHistoryDeleted('target-B', f.message.id);
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', f.file.id), false);
});

test('a persisted ordinary reference cannot manufacture forwarded ownership without a source grant', async t => {
    const f = await fixture(t, 'file');
    const forged = { ...f.message, id: 'untrusted-record' };
    f.infraStore.markHistoryDeleted('target-B', f.message.id);
    f.infraStore.recordHistoryMessage('target-B', forged, { source: 'message' });
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', f.file.id), false);
});

for (const legacy of [false, true, 'waiting']) test('target-only receiver restores real bytes through existing Relay handlers (' + (legacy === 'waiting' ? 'legacy waits for a destination holder' : legacy ? 'legacy destination-only lookup' : 'verified source copy') + ')', async t => {
    const f = await fixture(t, 'file'), { registerFileAssetHandlers } = require('../server/file-assets');
    t.after(() => f.transfer.cancel(f.file.id));
    if (legacy) {
        f.infraStore.markHistoryDeleted('target-B', f.message.id);
        const record = { ...f.message, id: 'legacy-copy' }; delete record.forwardedFrom;
        f.infraStore.recordHistoryMessage('target-B', record, { source: 'history-reconcile' });
        f.target.devices.set('forwarder', {});
    }
    const sessions = f.gate.sessions, deviceSockets = new Map(), wire = [], stored = new Map();
    sessions.set('source-A', { devices: new Map([['forwarder', {}]]), fileAssets: new Map() });
    f.transfer.deps.store = async file => stored.set(file.id, file);
    const progress = [], unavailable = [];
    f.transfer.deps.onProgress = (...data) => progress.push(data);
    f.transfer.deps.onUnavailable = (...data) => unavailable.push(data);
    f.transfer.deps.onReceived = async () => {};
    const incoming = { 'file-asset-relay-start': 'handleRelayStart', 'file-asset-relay-chunk': 'handleRelayChunk', 'file-asset-relay-complete': 'handleRelayComplete', 'file-asset-unavailable': 'handleUnavailable' };
    function endpoint(sessionId, deviceId) {
        const handlers = new Map(), socket = { id: deviceId, data: {}, on: (name, run) => handlers.set(name, run),
            to: () => ({ emit() {} }), timeout() { return this; }, emit(name, data, ack) {
                wire.push({ name, deviceId, data });
                if (deviceId === 'target-only-viewer' && incoming[name]) {
                    Promise.resolve(f.transfer[incoming[name]](data)).then(result => ack?.(null, result), error => ack?.(error));
                } else ack?.(null, { ok: true });
            } };
        deviceSockets.set(deviceId, socket);
        registerFileAssetHandlers(socket, { sessions, deviceSockets, getSessionId: () => sessionId, getDeviceId: () => deviceId,
            sanitize: String, historyLog() {}, isValidId: value => typeof value === 'string' && !!value });
        return handlers;
    }
    const providerSession = legacy ? 'target-B' : 'source-A';
    const provider = endpoint(providerSession, 'forwarder'), viewer = endpoint('target-B', 'target-only-viewer');
    if (legacy === 'waiting') f.target.devices.delete('forwarder');
    else provider.get('file-asset-available')({ sessionId: providerSession, asset: f.file });
    await f.transfer.request(f.file.id, 'forwarder', { ...f.file });
    assert.equal(f.events[0].accepted, true, JSON.stringify(f.errors));
    assert.equal(f.events[0].data.sourceAccessGrant, '');
    viewer.get('file-asset-request')(f.events[0].data);
    if (legacy === 'waiting') {
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(wire.find(item => item.name === 'file-asset-unavailable').data.reason, 'no-known-provider');
        assert.equal(f.transfer.desiredAssets.has(f.file.id), true, 'keep the download intent while no destination holder is online');
        assert.equal(stored.size, 0); assert.deepEqual(progress, []); assert.deepEqual(unavailable, []); assert.deepEqual(f.errors, []);
        assert.equal(wire.some(item => item.name === 'file-asset-request' && item.deviceId === 'forwarder'), false);
        f.target.devices.set('forwarder', {});
        provider.get('file-asset-available')({ sessionId: providerSession, asset: f.file });
        const before = f.events.filter(item => item.name === 'file-asset-request').length;
        f.transfer.handleAvailable({ asset: f.file, from: 'forwarder' });
        const requests = f.events.filter(item => item.name === 'file-asset-request');
        assert.equal(requests.length, before + 1, 'a destination cache announcement resumes automatically without another manual restore');
        assert.equal(requests.at(-1).data.sourceSessionId, 'target-B');
        viewer.get('file-asset-request')(requests.at(-1).data);
    }
    const request = wire.find(item => item.name === 'file-asset-request' && item.deviceId === 'forwarder').data;
    const call = (name, data) => new Promise(resolve => provider.get(name)({ sessionId: providerSession, to: 'target-only-viewer', requestId: request.requestId, ...data }, resolve));
    const payload = Uint8Array.from({ length: f.file.size }, (_, index) => index % 251);
    assert.equal((await call('file-asset-relay-start', { asset: f.file })).ok, true);
    assert.equal((await call('file-asset-relay-chunk', { assetId: f.file.id, chunk: payload.buffer })).ok, true);
    assert.equal((await call('file-asset-relay-complete', { assetId: f.file.id })).ok, true);
    assert.deepEqual(Buffer.from(stored.get(f.file.id).data), Buffer.from(payload));
    assert.equal(sessions.get('source-A').devices.has('target-only-viewer'), false);
    if (legacy) assert.equal(f.events[0].data.sourceSessionId, 'target-B');
    assert.deepEqual(f.errors, []);
});

test('legacy external-file copy treats empty MIME as the indexed unknown type without relaxing ownership proof', async t => {
    const f = await fixture(t, 'file');
    f.infraStore.markHistoryDeleted('target-B', f.message.id);
    const file = { ...f.file, type: '', isExternalFile: true };
    const original = { id: 'source-record', type: 'file', sender: 'forwarder', fileInfo: { ...file, id: 'original-file' } };
    f.infraStore.recordHistoryMessage('source-A', original, { source: 'history-reconcile' });
    f.infraStore.recordFileAsset('source-A', f.transfer.metadata(file), { sourceDeviceId: 'forwarder' });
    const copy = { ...f.message, id: 'legacy-copy', fileInfo: file };
    f.infraStore.recordHistoryMessage('target-B', copy, { source: 'history-reconcile' });
    assert.equal(f.infraStore.get('SELECT mime_type FROM file_assets WHERE session_id = ? AND file_id = ?', ['source-A', file.id]).mime_type, 'application/octet-stream');
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', file.id, copy.id), true);
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', file.id), true);
    f.infraStore.recordFileAsset('source-A', { ...file, type: 'text/x-different' }, { sourceDeviceId: 'forwarder' });
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', file.id, copy.id), false, 'different known MIME still fails');
    f.infraStore.recordFileAsset('source-A', file, { sourceDeviceId: 'another-device' });
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', file.id), false, 'unknown MIME never grants another sender ownership');
});

for (const type of ['file', 'collection']) test('legacy destination reference can seek its own copy without opening the private source (' + type + ')', async t => {
    const f = await fixture(t, type);
    f.infraStore.markHistoryDeleted('target-B', f.message.id);
    // Old reconciled history has no surviving server forward audit or origin
    // anchor. Its destination marker is not proof of access to the source.
    const legacy = { ...f.message, id: 'legacy-owned-record' };
    delete legacy.forwardedFrom;
    f.infraStore.recordHistoryMessage('target-B', legacy, { source: 'history-reconcile' });
    assert.equal(f.target.history.length, 0, 'startup recovery may run before live history is populated');
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', f.file.id, legacy.id), false);
    await f.transfer.request(f.file.id, 'forwarder', { ...f.file, recordMessageId: legacy.id });
    assert.equal(f.events[0].accepted, true, JSON.stringify(f.errors));
    assert.equal(f.events[0].data.sourceSessionId, 'target-B', 'only destination caches may supply an unproven legacy reference');
    assert.deepEqual(f.errors, []);
    for (const [device, source, file, record] of [['outsider', 'source-A', f.file.id, legacy.id], ['target-only-viewer', 'other-source', f.file.id, legacy.id], ['target-only-viewer', 'source-A', 'private-file', legacy.id], ['target-only-viewer', 'source-A', f.file.id, 'missing-record']]) {
        assert.equal(f.gate.canSeekDestinationCopy('target-B', device, source, file, record), false);
    }
    f.infraStore.run('UPDATE transfer_files SET removed_at = ? WHERE session_id = ? AND message_id = ? AND file_id = ?', [Date.now(), 'target-B', legacy.id, f.file.id]);
    assert.equal(f.gate.canSeekDestinationCopy('target-B', 'target-only-viewer', 'source-A', f.file.id, legacy.id), false, 'a removed file reference grants no fallback');
    f.infraStore.run('UPDATE transfer_files SET removed_at = NULL WHERE session_id = ? AND message_id = ? AND file_id = ?', ['target-B', legacy.id, f.file.id]);
    const canRead = f.gate.canUseTunnelCapability;
    f.gate.canUseTunnelCapability = () => false;
    assert.equal(f.gate.canSeekDestinationCopy('target-B', 'target-only-viewer', 'source-A', f.file.id, legacy.id), false, 'destination membership alone cannot bypass its read permission');
    f.gate.canUseTunnelCapability = canRead;
    assert.equal(f.gate.canSeekDestinationCopy('target-B', 'target-only-viewer', 'source-A', f.file.id, legacy.id), true);
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', f.file.id, legacy.id), false, 'fallback must never grant source access');
    f.infraStore.markHistoryDeleted('target-B', legacy.id);
    await f.transfer.cancel(f.file.id);
    await f.transfer.request(f.file.id, 'forwarder', { ...f.file, recordMessageId: legacy.id });
    assert.equal(f.events.at(-1).accepted, false, 'deleted destination records grant no fallback');
    assert.equal(f.errors.at(-1).name, 'permission-denied');
});
