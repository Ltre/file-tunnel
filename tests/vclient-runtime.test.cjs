'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CacheStore } = require('../vclient/cache-store');
const {
    TunnelClient,
    VClientRuntime,
    assetReferencesFromMessage,
    assetReferencesFromRecord,
    constants
} = require('../vclient/runtime');

class FakeSocket {
    constructor(url = '') {
        this.url = url;
        this.connected = false;
        this.handlers = new Map();
        this.outgoing = [];
        this.ackResponder = async () => ({ ok: true });
    }

    on(event, handler) {
        const list = this.handlers.get(event) || [];
        list.push(handler);
        this.handlers.set(event, list);
        return this;
    }

    emit(event, ...args) {
        this.outgoing.push({ event, args });
        return this;
    }

    emitWithAck(event, payload) {
        this.outgoing.push({ event, args: [payload], acknowledged: true });
        return this.ackResponder(event, payload);
    }

    timeout() {
        return this;
    }

    connect() {
        this.connected = true;
        queueMicrotask(() => this.serverEmit('connect'));
        return this;
    }

    disconnect() {
        if (!this.connected) return this;
        this.connected = false;
        this.serverEmit('disconnect', 'client disconnect');
        return this;
    }

    serverEmit(event, ...args) {
        for (const handler of this.handlers.get(event) || []) handler(...args);
    }

    async serverEmitWithAck(event, payload) {
        const handlers = this.handlers.get(event) || [];
        assert.ok(handlers.length, `missing fake handler for ${event}`);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`fake ${event} ack timed out`)), 2000);
            handlers[0](payload, result => {
                clearTimeout(timer);
                resolve(result);
            });
        });
    }
}

async function temporaryStore(t) {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'file-tunnel-vclient-'));
    t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
    const store = new CacheStore(directory);
    await store.init();
    return { directory, store };
}

function runtimeStub(store, socket) {
    const statuses = [];
    const assets = [];
    return {
        store,
        token: 'stub-token',
        serverUrl: 'http://localhost:9999',
        ioFactory: () => socket,
        heartbeatMs: 60000,
        requestTimeoutMs: 60000,
        receiveIdleTimeoutMs: 60000,
        ackTimeoutMs: 2000,
        maxConcurrentDownloads: 3,
        log() {},
        fetchRecords: async () => {},
        reportStatus: (tunnel, details) => statuses.push({ state: tunnel.state, details }),
        reportAssetStatus: (_tunnel, assetId, state, details) => assets.push({ assetId, state, details }),
        statuses,
        assets
    };
}

test('cache store persists a stable UUIDv4 per tunnel and complete asset index', async t => {
    const { directory, store } = await temporaryStore(t);
    const sessionA = 'session_alpha_123';
    const sessionB = 'session_beta_456';
    const first = store.stableDeviceId(sessionA);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(store.stableDeviceId(sessionA), first);
    assert.notEqual(store.stableDeviceId(sessionB), first);

    const bytes = Buffer.from('persistent-cache-data');
    const asset = { id: 'asset_persist_123', name: 'audit.bin', type: 'application/octet-stream', size: bytes.length };
    const temporary = await store.createPartialPath(sessionA, asset.id);
    await fs.promises.writeFile(temporary, bytes);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    await store.commitTemp(sessionA, asset, temporary, { sha256, size: bytes.length });

    const reopened = new CacheStore(directory);
    await reopened.init();
    assert.equal(reopened.stableDeviceId(sessionA), first);
    const cached = await reopened.getCached(sessionA, asset.id, asset);
    assert.equal(cached.sha256, sha256);
    assert.deepEqual(await fs.promises.readFile(cached.path), bytes);
});

test('cache store quarantines same-size content corruption before provider announcement', async t => {
    const { directory, store } = await temporaryStore(t);
    const sessionId = 'session_integrity_123';
    const bytes = Buffer.from('original-cache-bytes');
    const asset = { id: 'asset_integrity_123', name: 'integrity.bin', type: 'application/octet-stream', size: bytes.length };
    const temporary = await store.createPartialPath(sessionId, asset.id);
    await fs.promises.writeFile(temporary, bytes);
    const committed = await store.commitTemp(sessionId, asset, temporary, {
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length
    });
    await fs.promises.writeFile(committed.path, Buffer.from('x'.repeat(bytes.length)));

    const reopened = new CacheStore(directory);
    await reopened.init();
    assert.equal(await reopened.getCached(sessionId, asset.id, asset), null);
    assert.equal(reopened.sessionTotals(sessionId).files, 0);
    const quarantined = (await fs.promises.readdir(path.dirname(committed.path)))
        .some(name => name.includes('.corrupt-'));
    assert.equal(quarantined, true);
});

test('history scan extracts file, collection and rich-text file references without duplicates', () => {
    const file = assetReferencesFromMessage({
        type: 'file',
        fileInfo: { id: 'asset_single_123', name: 'one.txt', type: 'text/plain', size: 3 }
    });
    assert.deepEqual(file.map(item => item.id), ['asset_single_123']);
    assert.equal(file[0].asset.name, 'one.txt');

    const collection = assetReferencesFromMessage({
        type: 'collection',
        collection: { files: [
            { id: 'asset_album_a12', name: 'a.mp3', type: 'audio/mpeg', size: 10 },
            { id: 'asset_album_b12', name: 'b.mp3', type: 'audio/mpeg', size: 20 }
        ] }
    });
    assert.deepEqual(collection.map(item => item.id), ['asset_album_a12', 'asset_album_b12']);

    const rich = assetReferencesFromMessage({
        type: 'rich',
        content: '<a data-tunnel-file-ref-id="asset_rich_ref1" onclick="downloadFile(\'asset_rich_ref1\')">x</a>' +
            '<span data-tunnel-asset-id="asset_rich_ref2"></span>'
    });
    assert.deepEqual(rich.map(item => item.id), ['asset_rich_ref1', 'asset_rich_ref2']);
    assert.equal(rich[0].asset, null);
    assert.equal(rich[0].kind, 'file');
    assert.equal(rich[1].kind, 'editor');

    const audited = assetReferencesFromRecord({
        files: [{
            file_id: 'asset_audit_123',
            file_name: 'audit.mp4',
            mime_type: 'video/mp4',
            declared_size: 456
        }],
        rich_asset_ids: ['asset_rich_ref3']
    });
    assert.deepEqual(audited.map(item => item.id), ['asset_audit_123', 'asset_rich_ref3']);
    assert.equal(audited[0].asset.size, 456);

    const richAudited = assetReferencesFromRecord({
        message: { type: 'rich', content: '<img data-tunnel-asset-id="asset_rich_editor">' },
        files: [{
            file_id: 'asset_rich_editor',
            file_name: 'rich.png',
            mime_type: 'image/png',
            declared_size: 12,
            asset_kind: 'editor'
        }]
    });
    assert.equal(richAudited[0].kind, 'editor');
    assert.equal(richAudited[0].asset.name, 'rich.png');
});

test('audited rich editor assets use the editor relay protocol and persist their kind', async t => {
    const { store } = await temporaryStore(t);
    const socket = new FakeSocket();
    socket.connected = true;
    const tunnel = new TunnelClient(runtimeStub(store, socket), 'session_editor_123');
    tunnel.socket = socket;
    tunnel.bindSocket();
    tunnel.initialScanComplete = true;

    const bytes = Buffer.from('editor-image-bytes');
    const asset = {
        id: 'asset_editor_123',
        name: 'rich.png',
        type: 'image/png',
        size: bytes.length,
        assetKind: 'editor'
    };
    await tunnel.ensureAsset({ id: asset.id, kind: 'editor', asset: null });
    assert.equal(socket.outgoing.at(-1).event, 'editor-asset-request');

    await tunnel.onEditorRelayStart({ asset, from: 'editor-provider-123' });
    await tunnel.onEditorRelayChunk({ assetId: asset.id, from: 'editor-provider-123', chunk: bytes });
    await tunnel.onEditorRelayComplete({ assetId: asset.id, from: 'editor-provider-123' });

    const cached = await store.getCached(tunnel.sessionId, asset.id, asset);
    assert.equal(cached.asset.assetKind, 'editor');
    assert.deepEqual(await fs.promises.readFile(cached.path), bytes);
    assert.ok(socket.outgoing.some(item => item.event === 'editor-asset-available'));
    assert.equal(socket.outgoing.some(item => item.event === 'file-asset-available'), false);
    await tunnel.stop();
});

test('relay receiver registers availability only after full size and SHA-256 commit', async t => {
    const { store } = await temporaryStore(t);
    const socket = new FakeSocket();
    socket.connected = true;
    const runtime = runtimeStub(store, socket);
    const tunnel = new TunnelClient(runtime, 'session_relay_123');
    tunnel.socket = socket;
    tunnel.bindSocket();
    tunnel.initialScanComplete = true;

    const bytes = Buffer.from('complete relay content');
    const asset = { id: 'asset_receive_123', name: 'received.bin', type: 'application/octet-stream', size: bytes.length };
    await tunnel.ensureAsset({ id: asset.id, asset });
    const beforeStart = socket.outgoing.filter(item => item.event === 'file-asset-available').length;
    assert.equal(beforeStart, 0);

    const from = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const start = await socket.serverEmitWithAck('file-asset-relay-start', {
        asset,
        from,
        attemptId: 'attempt-1',
        requestId: 'request-1'
    });
    assert.equal(start.ok, true);
    assert.equal(socket.outgoing.filter(item => item.event === 'file-asset-available').length, 0);

    const chunk = await socket.serverEmitWithAck('file-asset-relay-chunk', {
        assetId: asset.id,
        from,
        attemptId: 'attempt-1',
        chunk: bytes
    });
    assert.equal(chunk.receivedSize, bytes.length);
    assert.equal(socket.outgoing.filter(item => item.event === 'file-asset-available').length, 0);

    const complete = await socket.serverEmitWithAck('file-asset-relay-complete', {
        assetId: asset.id,
        from,
        attemptId: 'attempt-1'
    });
    assert.equal(complete.ok, true);
    assert.equal(complete.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(socket.outgoing.filter(item => item.event === 'file-asset-available').length, 1);
    const cached = await store.getCached(tunnel.sessionId, asset.id, asset);
    assert.deepEqual(await fs.promises.readFile(cached.path), bytes);
    await tunnel.stop();
});

test('relay receiver aborts an idle partial and releases its download slot for retry', async t => {
    const { store } = await temporaryStore(t);
    const socket = new FakeSocket();
    socket.connected = true;
    const runtime = runtimeStub(store, socket);
    runtime.receiveIdleTimeoutMs = 20;
    const tunnel = new TunnelClient(runtime, 'session_idle_123');
    tunnel.socket = socket;
    tunnel.bindSocket();
    tunnel.initialScanComplete = true;
    const asset = { id: 'asset_idle_timeout', name: 'idle.bin', type: 'application/octet-stream', size: 8 };
    await tunnel.ensureAsset({ id: asset.id, asset });
    const from = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    assert.equal((await socket.serverEmitWithAck('file-asset-relay-start', { asset, from })).ok, true);
    assert.equal(tunnel.receives.size, 1);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(tunnel.receives.size, 0);
    assert.equal(tunnel.activeDownloads.size, 0);
    assert.ok(runtime.assets.some(item => item.assetId === asset.id && item.state === 'interrupted'));
    await tunnel.stop();
});

test('provider device departure aborts only its partial receives and schedules retry', async t => {
    const { store } = await temporaryStore(t);
    const socket = new FakeSocket();
    socket.connected = true;
    const runtime = runtimeStub(store, socket);
    const tunnel = new TunnelClient(runtime, 'session_departure_123');
    tunnel.socket = socket;
    tunnel.bindSocket();
    tunnel.initialScanComplete = true;
    const asset = { id: 'asset_departure_1', name: 'part.bin', type: 'application/octet-stream', size: 9 };
    await tunnel.ensureAsset({ id: asset.id, asset });
    const from = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await socket.serverEmitWithAck('file-asset-relay-start', { asset, from });
    socket.serverEmit('device-left', { deviceId: from });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(tunnel.receives.size, 0);
    assert.equal(tunnel.activeDownloads.size, 0);
    assert.ok(runtime.assets.some(item => item.assetId === asset.id && item.details.reason === 'provider-disconnected'));
    await tunnel.stop();
});

test('provider serves an exact requested range directly over Socket.IO relay', async t => {
    const { store } = await temporaryStore(t);
    const sessionId = 'session_provider_123';
    const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    const asset = { id: 'asset_provider_123', name: 'range.bin', type: 'application/octet-stream', size: bytes.length };
    const temporary = await store.createPartialPath(sessionId, asset.id);
    await fs.promises.writeFile(temporary, bytes);
    await store.commitTemp(sessionId, asset, temporary, {
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length
    });

    const socket = new FakeSocket();
    socket.connected = true;
    const sentChunks = [];
    socket.ackResponder = async (event, payload) => {
        if (event === 'file-asset-relay-chunk') sentChunks.push(Buffer.from(payload.chunk));
        return { ok: true };
    };
    const tunnel = new TunnelClient(runtimeStub(store, socket), sessionId);
    tunnel.socket = socket;
    const transfer = { transferId: 'part-0', rangeStart: 4, rangeEnd: 19 };
    const succeeded = await tunnel.sendCachedAsset({
        asset,
        from: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        transfer,
        relayOnly: true,
        requestId: 'request-range'
    });
    assert.equal(succeeded, true);
    assert.deepEqual(Buffer.concat(sentChunks), bytes.subarray(transfer.rangeStart, transfer.rangeEnd));
    assert.ok(sentChunks.every(chunk => chunk.length <= constants.RELAY_CHUNK_SIZE));
    const start = socket.outgoing.find(item => item.event === 'file-asset-relay-start');
    assert.equal(start.args[0].rangeStart, transfer.rangeStart);
    assert.equal(start.args[0].rangeEnd, transfer.rangeEnd);
});

test('editor provider serves cached rich media through editor Socket.IO relay', async t => {
    const { store } = await temporaryStore(t);
    const sessionId = 'session_editor_provider';
    const bytes = Buffer.from('cached-editor-image');
    const asset = {
        id: 'asset_editor_provider',
        name: 'cached.webp',
        type: 'image/webp',
        size: bytes.length,
        assetKind: 'editor'
    };
    const temporary = await store.createPartialPath(sessionId, asset.id);
    await fs.promises.writeFile(temporary, bytes);
    await store.commitTemp(sessionId, asset, temporary, {
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length
    });
    const socket = new FakeSocket();
    socket.connected = true;
    const tunnel = new TunnelClient(runtimeStub(store, socket), sessionId);
    tunnel.socket = socket;

    assert.equal(await tunnel.sendCachedEditorAsset({ asset, from: 'editor-receiver-123' }), true);
    const chunks = socket.outgoing
        .filter(item => item.event === 'editor-asset-relay-chunk')
        .map(item => Buffer.from(item.args[0].chunk));
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(socket.outgoing[0].event, 'editor-asset-relay-start');
    assert.equal(socket.outgoing.at(-1).event, 'editor-asset-relay-complete');
});

test('unsupported interactive requests receive explicit negative responses', async t => {
    const { store } = await temporaryStore(t);
    const socket = new FakeSocket();
    socket.connected = true;
    const tunnel = new TunnelClient(runtimeStub(store, socket), 'session_reject_123');
    tunnel.socket = socket;
    tunnel.bindSocket();
    const peer = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    socket.serverEmit('device-camera-request', { requestId: 'camera-1', from: peer, mode: 'open-remote' });
    socket.serverEmit('contact-call-request', { callId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', from: peer });
    socket.serverEmit('device-tunnel-invite', { invitationId: 'invite-1', from: peer, sessionId: tunnel.sessionId });
    socket.serverEmit('file-offer', { from: peer, fileInfo: { id: 'legacy-file-1' } });
    socket.serverEmit('light-network-chunks-request', { requestId: 'light-1', taskId: 'task-1' });

    const response = event => socket.outgoing.find(item => item.event === event)?.args[0];
    assert.equal(response('device-camera-response').accepted, false);
    assert.equal(response('contact-call-rejected').reason, 'vclient-unsupported');
    assert.equal(response('device-tunnel-invite-ack').accepted, false);
    assert.equal(response('file-answer').accepted, false);
    assert.equal(response('light-network-chunks-response').unavailable, true);
    await tunnel.stop();
});

test('one runtime reuses one physical process while maintaining isolated sockets per enabled tunnel', async t => {
    const { directory } = await temporaryStore(t);
    const sockets = [];
    const runtime = new VClientRuntime({
        serverUrl: 'http://localhost:9999',
        token: 'test-token',
        dataDir: directory,
        ioFactory: (url, options) => {
            const socket = new FakeSocket(url);
            socket.options = options;
            sockets.push(socket);
            return socket;
        },
        logger: { info() {} },
        heartbeatMs: 60000,
        ackTimeoutMs: 1000
    });
    await runtime.store.init();
    await runtime.applyAssignments({ tunnels: [
        { sessionId: 'session_multi_123', enabled: true },
        { sessionId: 'session_multi_456', enabled: true }
    ] });
    assert.equal(runtime.tunnels.size, 2);
    assert.equal(sockets.length, 2);
    assert.equal(sockets[0].options.auth.vclientToken, 'test-token');
    const ids = Array.from(runtime.tunnels.values()).map(tunnel => tunnel.deviceId);
    assert.notEqual(ids[0], ids[1]);

    await runtime.applyAssignments({ tunnels: [{ sessionId: 'session_multi_123', enabled: true }] });
    assert.equal(runtime.tunnels.size, 1);
    assert.equal(sockets.length, 2, 'existing logical tunnel must reuse its prior socket');
    await runtime.suspendTunnels('control-disconnected');
    assert.equal(runtime.tunnels.size, 0, 'control loss must remove every data tunnel from the old process');
    await runtime.stop();
});
