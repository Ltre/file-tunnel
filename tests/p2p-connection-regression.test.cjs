const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Unit-level regression coverage only; browser ICE/DataChannel behavior requires an end-to-end test.
const ROOT = path.resolve(__dirname, '..');

class MockDataChannel extends EventTarget {
    constructor(label, readyState = 'connecting') {
        super();
        this.label = label;
        this.readyState = readyState;
        this.bufferedAmount = 0;
        this.sent = [];
    }

    send(payload) {
        this.sent.push(payload);
    }

    close() {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        this.dispatchEvent(new Event('close'));
    }
}

function loadPeerHarness(localDeviceId = 'device-a', remoteDeviceId = 'device-z') {
    const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const start = source.indexOf('// ==================== WebRTC P2P ====================');
    const end = source.indexOf('// ==================== Editor image assets ====================');
    assert.ok(start >= 0 && end > start, 'WebRTC source region must be discoverable');

    const peers = [];
    const signals = [];

    class MockPeerConnection {
        constructor(config) {
            this.config = config;
            this.connectionState = 'new';
            this.iceConnectionState = 'new';
            this.iceGatheringState = 'new';
            this.signalingState = 'stable';
            this.localDescription = null;
            this.remoteDescription = null;
            this.channels = [];
            this.addedCandidates = [];
            this.offerCount = 0;
            this.answerCount = 0;
            this.rollbackCount = 0;
            this.restartIceCount = 0;
            this.closed = false;
            peers.push(this);
        }

        createDataChannel(label) {
            const channel = new MockDataChannel(label);
            this.channels.push(channel);
            return channel;
        }

        async createOffer(options) {
            this.offerCount++;
            await new Promise(resolve => setTimeout(resolve, 5));
            return { type: 'offer', sdp: `offer-${this.offerCount}`, options };
        }

        async createAnswer() {
            this.answerCount++;
            return { type: 'answer', sdp: `answer-${this.answerCount}` };
        }

        async setLocalDescription(description) {
            if (description?.type === 'rollback') {
                this.rollbackCount++;
                this.localDescription = null;
                this.signalingState = 'stable';
                return;
            }
            this.localDescription = description;
            this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
        }

        async setRemoteDescription(description) {
            this.remoteDescription = description;
            this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
        }

        async addIceCandidate(candidate) {
            this.addedCandidates.push(candidate);
        }

        restartIce() {
            this.restartIceCount++;
        }

        close() {
            this.closed = true;
            this.connectionState = 'closed';
            this.iceConnectionState = 'closed';
            this.signalingState = 'closed';
        }
    }

    const state = {
        deviceId: localDeviceId,
        peers: new Map(),
        dataChannels: new Map(),
        pendingIceCandidates: new Map(),
        devices: new Map([[remoteDeviceId, { id: remoteDeviceId }]]),
        socket: {
            connected: true,
            emit(event, payload) {
                signals.push({ event, payload });
            }
        }
    };
    const context = vm.createContext({
        console: { log() {}, info() {}, warn() {}, error() {} },
        setTimeout,
        clearTimeout,
        Map,
        Promise,
        Date,
        RTCPeerConnection: MockPeerConnection,
        RTCSessionDescription: function RTCSessionDescription(value) { return value; },
        RTCIceCandidate: function RTCIceCandidate(value) { return value; },
        state,
        peerSignalQueues: new Map(),
        editorAssetP2PUnavailablePeers: new Map(),
        EDITOR_ASSET_P2P_COOLDOWN: 5000,
        fileAssetTransfer: null,
        historyLog() {},
        handleDataChannelMessage() {},
        setupEditorAssetDataChannel() {}
    });
    vm.runInContext(source.slice(start, end), context, { filename: 'app-webrtc.js' });
    return { context, peers, signals, remoteDeviceId };
}

test('WebRTC keeps native ICE enabled for LAN and public candidates', async () => {
    const harness = loadPeerHarness();
    const pc = await harness.context.createPeerConnection(harness.remoteDeviceId);
    const candidate = { candidate: 'candidate:1 1 UDP 1 192.168.1.20 50000 typ host' };

    pc.onicecandidate({ candidate });

    assert.equal(pc.config.iceTransportPolicy, 'all');
    assert.ok(pc.config.iceServers.length > 0);
    assert.equal(harness.signals.length, 1);
    assert.equal(harness.signals[0].payload.candidate, candidate);
});

test('concurrent connects share one PeerConnection and one offer', async () => {
    const harness = loadPeerHarness();

    const results = await Promise.all(Array.from(
        { length: 24 },
        () => harness.context.connectToPeer(harness.remoteDeviceId)
    ));

    assert.equal(harness.peers.length, 1);
    assert.equal(new Set(results).size, 1);
    assert.equal(harness.peers[0].offerCount, 1);
    assert.equal(harness.peers[0].channels.length, 1);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'offer').length, 1);
});

test('the non-designated peer can initiate an offer for an actual file request', async () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    const pc = await harness.context.connectToPeer(harness.remoteDeviceId);

    assert.equal(pc.offerCount, 0);
    await harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId);

    assert.equal(pc.offerCount, 1);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'offer').length, 1);
});

test('concurrent file requests share one offer', async () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    const pc = await harness.context.connectToPeer(harness.remoteDeviceId);

    await Promise.all(Array.from(
        { length: 12 },
        () => harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId)
    ));

    assert.equal(pc.offerCount, 1);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'offer').length, 1);
});

test('file requests do not renegotiate an existing offer-answer exchange', async () => {
    const harness = loadPeerHarness();
    const pc = await harness.context.connectToPeer(harness.remoteDeviceId);
    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'answer',
        sdp: { type: 'answer', sdp: 'initial-answer' }
    });

    await Promise.all([
        harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId),
        harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId)
    ]);

    assert.equal(pc.signalingState, 'stable');
    assert.equal(pc.offerCount, 1);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'offer').length, 1);
});

test('an in-progress local offer is reused instead of renegotiated', async () => {
    const harness = loadPeerHarness();
    const pc = await harness.context.connectToPeer(harness.remoteDeviceId);

    await Promise.all([
        harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId),
        harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId),
        harness.context.connectToPeer(harness.remoteDeviceId)
    ]);

    assert.equal(pc.signalingState, 'have-local-offer');
    assert.equal(pc.offerCount, 1);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'offer').length, 1);
});

test('ICE received before the offer is queued and flushed before answering', async () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    const candidate = { candidate: 'candidate-before-offer' };

    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'ice-candidate',
        candidate
    });
    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'offer',
        sdp: { type: 'offer', sdp: 'remote-offer' }
    });

    assert.equal(harness.peers.length, 1);
    assert.deepEqual(harness.peers[0].addedCandidates, [candidate]);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'answer').length, 1);
    assert.equal(harness.context.state.pendingIceCandidates.has(harness.remoteDeviceId), false);
});

test('the designated initiator ignores a competing remote offer', async () => {
    const harness = loadPeerHarness('device-a', 'device-z');
    const pc = await harness.context.connectToPeer(harness.remoteDeviceId);

    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'offer',
        sdp: { type: 'offer', sdp: 'competing-offer' }
    });

    assert.equal(pc.rollbackCount, 0);
    assert.equal(pc.remoteDescription, null);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'answer').length, 0);
});

test('the non-designated side rolls back its file offer and answers the designated peer', async () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    const pc = await harness.context.connectToPeer(harness.remoteDeviceId);
    await harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId);

    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'offer',
        sdp: { type: 'offer', sdp: 'designated-offer' }
    });

    assert.equal(pc.rollbackCount, 1);
    assert.equal(pc.remoteDescription.sdp, 'designated-offer');
    assert.equal(pc.signalingState, 'stable');
    assert.equal(harness.signals.filter(item => item.payload?.type === 'answer').length, 1);
});

test('a failed ICE connection restarts ICE without replacing the peer immediately', async () => {
    const harness = loadPeerHarness();
    const pc = await harness.context.createPeerConnection(harness.remoteDeviceId);

    pc.iceConnectionState = 'failed';
    pc.oniceconnectionstatechange();

    assert.equal(pc.restartIceCount, 1);
    assert.equal(harness.context.state.peers.get(harness.remoteDeviceId), pc);
});

test('a Socket.IO reconnect does not discard an in-progress WebRTC peer', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const start = source.indexOf('function handleDeviceUpdated(data)');
    const end = source.indexOf('\nfunction getSelfContactProfile()', start);
    const handler = source.slice(start, end);

    assert.ok(start >= 0 && end > start, 'device update handler must be discoverable');
    assert.match(handler, /if \(!existing\) connectToPeer\(data\.deviceId\);/);
    assert.doesNotMatch(handler, /data\.reconnected|pc\.close\(\)/);
});

function loadFileAssetTransfer() {
    const source = fs.readFileSync(path.join(ROOT, 'client', 'file-assets.js'), 'utf8');
    const context = vm.createContext({
        window: {},
        console: { log() {}, info() {}, warn() {}, error() {} },
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval() {},
        Blob,
        ArrayBuffer,
        Uint8Array,
        DataView,
        Event,
        EventTarget,
        Date,
        Map,
        Set,
        Promise,
        Math,
        JSON,
        String,
        Number,
        RegExp,
        Error
    });
    vm.runInContext(source, context, { filename: 'client/file-assets.js' });
    return context.window.FileAssetTransfer;
}

function createFileAssetHarness() {
    const FileAssetTransfer = loadFileAssetTransfer();
    const socketEvents = [];
    const channels = [];
    const progressEvents = [];
    const metrics = { connects: 0, offers: 0, p2pSends: 0, relaySends: 0 };
    const peer = {
        connectionState: 'connecting',
        iceConnectionState: 'checking',
        signalingState: 'stable',
        iceGatheringState: 'gathering',
        createDataChannel(label) {
            const channel = new MockDataChannel(label, 'open');
            channels.push(channel);
            return channel;
        }
    };
    const transfer = new FileAssetTransfer({
        getSocket: () => ({
            connected: true,
            emit(event, payload) {
                socketEvents.push({ event, payload });
            }
        }),
        getSessionId: () => 'session-a',
        getPeer: () => peer,
        connectPeer: async () => {
            metrics.connects++;
            return peer;
        },
        ensurePeerOffer: async () => {
            metrics.offers++;
            return peer;
        },
        waitForDataChannel: async () => true,
        load: async fileId => ({
            id: fileId,
            name: `${fileId}.bin`,
            type: 'application/octet-stream',
            size: 4,
            data: new Uint8Array([1, 2, 3, 4])
        }),
        onProgress(...args) {
            progressEvents.push(args);
        },
        log() {}
    });
    transfer.sendViaDataChannel = async () => {
        metrics.p2pSends++;
    };
    transfer.sendViaSocketRelay = async () => {
        metrics.relaySends++;
    };
    return { transfer, peer, channels, socketEvents, progressEvents, metrics };
}

test('a requested asset creates a file channel and uses P2P first', async () => {
    const harness = createFileAssetHarness();

    const sent = await harness.transfer.sendRequestedAsset({
        asset: { id: 'asset-a', name: 'asset-a.bin', size: 4 },
        from: 'device-b',
        requestId: 'request-a'
    });

    assert.equal(sent, true);
    assert.equal(harness.metrics.connects, 1);
    assert.equal(harness.metrics.offers, 1);
    assert.equal(harness.metrics.p2pSends, 1);
    assert.equal(harness.metrics.relaySends, 0);
    assert.equal(harness.channels.length, 1);
    assert.equal(harness.channels[0].label, 'file-asset:asset-a');
});

test('a P2P channel failure falls back to Socket.IO relay once', async () => {
    const harness = createFileAssetHarness();
    harness.transfer.sendViaDataChannel = async () => {
        harness.metrics.p2pSends++;
        throw new Error('File asset channel closed');
    };

    const sent = await harness.transfer.sendRequestedAsset({
        asset: { id: 'asset-fallback', name: 'asset-fallback.bin', size: 4 },
        from: 'device-b',
        requestId: 'request-fallback'
    });

    assert.equal(sent, true);
    assert.equal(harness.metrics.p2pSends, 1);
    assert.equal(harness.metrics.relaySends, 1);
    assert.ok(harness.transfer.p2pUnavailablePeers.get('device-b') > Date.now());
});

test('a P2P channel timeout cools the peer so the next file relays without another wait', async () => {
    const harness = createFileAssetHarness();
    harness.transfer.waitForChannel = async () => false;

    for (const assetId of ['asset-timeout-a', 'asset-timeout-b']) {
        assert.equal(await harness.transfer.sendRequestedAsset({
            asset: { id: assetId, name: `${assetId}.bin`, size: 4 },
            from: 'device-b',
            requestId: `request-${assetId}`
        }), true);
    }

    assert.equal(harness.metrics.connects, 1);
    assert.equal(harness.metrics.offers, 1);
    assert.equal(harness.metrics.relaySends, 2);
    assert.ok(harness.transfer.p2pUnavailablePeers.get('device-b') > Date.now());
});

test('P2P backpressure does not start a competing relay upload', async () => {
    const harness = createFileAssetHarness();
    harness.transfer.sendViaDataChannel = async () => {
        harness.metrics.p2pSends++;
        throw new Error('File asset send queue is full');
    };

    const sent = await harness.transfer.sendRequestedAsset({
        asset: { id: 'asset-pressure', name: 'asset-pressure.bin', size: 4 },
        from: 'device-b',
        requestId: 'request-pressure'
    });

    assert.equal(sent, false);
    assert.equal(harness.metrics.p2pSends, 1);
    assert.equal(harness.metrics.relaySends, 0);
});

test('relay start returns the receiver rejection to the server acknowledgement', async () => {
    const harness = createFileAssetHarness();
    harness.transfer.processRelayStart = async () => ({ ok: false, reason: 'receiver-stale-request' });

    const result = await harness.transfer.handleRelayStart({
        asset: { id: 'asset-stale', name: 'asset-stale.bin', size: 4 },
        from: 'device-b'
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'receiver-stale-request');
});

test('missing local data is rejected without opening either transport', async () => {
    const harness = createFileAssetHarness();
    harness.transfer.deps.load = async () => null;

    const sent = await harness.transfer.sendRequestedAsset({
        asset: { id: 'asset-missing', name: 'asset-missing.bin', size: 4 },
        from: 'device-b',
        requestId: 'request-missing'
    });

    assert.equal(sent, false);
    assert.equal(harness.metrics.connects, 0);
    assert.equal(harness.metrics.p2pSends, 0);
    assert.equal(harness.metrics.relaySends, 0);
    assert.ok(harness.socketEvents.some(item =>
        item.event === 'file-asset-unavailable' &&
        item.payload.reason === 'provider-missing-local-data'
    ));
});

test('the restored transfer timing contract keeps the 1500ms P2P preference window', () => {
    const source = fs.readFileSync(path.join(ROOT, 'client', 'file-assets.js'), 'utf8');

    assert.match(source, /const P2P_TIMEOUT = 1500;/);
    assert.match(source, /const P2P_FILE_CHANNEL_TIMEOUT = 5000;/);
});

test('a pending retry cannot be requeued early by the request watchdog', () => {
    const harness = createFileAssetHarness();
    const assetId = 'asset-pending-retry';
    const timer = setTimeout(() => {}, 60000);
    harness.transfer.desiredAssets.set(assetId, null);
    harness.transfer.retryTimers.set(assetId, timer);

    harness.transfer.checkRequestStalls();

    assert.equal(harness.transfer.downloadQueue.includes(assetId), false);
    assert.equal(harness.socketEvents.some(item => item.event === 'file-asset-request'), false);
    harness.transfer.clearRetryTimer(assetId);
});

test('an obsolete provider failure cannot replace the current receiver request', () => {
    const harness = createFileAssetHarness();
    const assetId = 'asset-current-request';
    let retries = 0;
    harness.transfer.desiredAssets.set(assetId, 'device-b');
    harness.transfer.requestIds.set(assetId, 'request-current');
    harness.transfer.retryDownload = () => { retries++; };

    harness.transfer.handleUnavailable({
        assetId,
        from: 'device-b',
        reason: 'asset-transfer-failed',
        requestId: 'request-obsolete'
    });
    assert.equal(retries, 0);

    harness.transfer.handleUnavailable({
        assetId,
        from: 'device-b',
        reason: 'asset-transfer-failed',
        requestId: 'request-current'
    });
    assert.equal(retries, 1);
});

test('presence refresh resumes pending downloads only after a socket connection', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

    assert.match(source, /announceStoredFileAssets\(\{ resumePending: true \}\)/);
    assert.match(source, /if \(options\.resumePending\) fileAssetTransfer\.resumePending\(\);/);
});

test('server retries a signal when the target socket finishes reconnecting', () => {
    const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const start = source.indexOf('const signal = { from, type, sdp, candidate };');
    const end = source.indexOf('\n        } catch (err) {', start);
    const timers = [];
    const sourceSocket = {};
    const deviceSockets = new Map([['device-a', sourceSocket]]);
    const emitted = [];
    const context = vm.createContext({
        from: 'device-a',
        to: 'device-b',
        type: 'offer',
        sdp: { type: 'offer', sdp: 'test-offer' },
        candidate: undefined,
        socket: sourceSocket,
        deviceSockets,
        setTimeout(callback, delay) {
            timers.push({ callback, delay });
        }
    });

    assert.ok(start >= 0 && end > start, 'server signal forwarding block must be discoverable');
    vm.runInContext(`(() => { ${source.slice(start, end)} })()`, context);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 500);

    deviceSockets.set('device-b', { emit: (...args) => emitted.push(args) });
    timers[0].callback();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0][0], 'signal');
    assert.equal(emitted[0][1].type, 'offer');
});

test('terminal transfer progress keeps the restored Set contract', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

    assert.match(source, /const completedFileProgress = new Set\(\);/);
    assert.match(source, /completedFileProgress\.add\(progressKey\)/);
    assert.doesNotMatch(source, /const completedFileProgress = new Map\(\);/);
});

test('receiver rejection releases the receiver assignment', () => {
    const { registerFileAssetHandlers } = require(path.join(ROOT, 'server', 'file-assets.js'));
    const handlers = new Map();
    const forwarded = [];
    const sessionId = 'session-a';
    const providerId = 'device-provider';
    const receiverId = 'device-receiver';
    const assetId = 'asset-a';
    const assignment = `${assetId}:${receiverId}:full`;
    const record = {
        metadata: { id: assetId, name: 'asset.bin', type: 'application/octet-stream', size: 4 },
        providers: new Set([providerId]),
        assignments: new Map([[assignment, providerId]]),
        assignmentMeta: new Map([[assignment, { providerId, status: 'started', requestId: 'request-a' }]]),
        providerLoads: new Map([[providerId, 1]])
    };
    const session = {
        devices: new Map([[providerId, {}], [receiverId, {}]]),
        fileAssets: new Map([[assetId, record]])
    };
    const socket = {
        id: 'socket-provider',
        on(event, handler) {
            handlers.set(event, handler);
        }
    };

    registerFileAssetHandlers(socket, {
        sessions: new Map([[sessionId, session]]),
        deviceSockets: new Map([[receiverId, {
            emit(event, payload) {
                forwarded.push({ event, payload });
            }
        }]]),
        getSessionId: () => sessionId,
        getDeviceId: () => providerId,
        isValidId: value => typeof value === 'string' && value.length > 0,
        sanitize: value => String(value || ''),
        historyLog() {},
        clientIp: '127.0.0.1'
    });

    handlers.get('file-asset-unavailable')({
        sessionId,
        assetId,
        to: receiverId,
        reason: 'receiver-stale-request',
        requestId: 'request-old'
    });

    assert.equal(record.assignments.get(assignment), providerId);
    assert.equal(record.assignmentMeta.get(assignment).requestId, 'request-a');

    handlers.get('file-asset-unavailable')({
        sessionId,
        assetId,
        to: receiverId,
        reason: 'receiver-stale-request',
        requestId: 'request-a'
    });

    assert.equal(record.assignments.has(assignment), false);
    assert.equal(record.assignmentMeta.has(assignment), false);
    assert.equal(record.providerLoads.has(providerId), false);
    assert.ok(forwarded.some(item =>
        item.event === 'file-asset-unavailable' &&
        item.payload.reason === 'receiver-stale-request'
    ));
});

test('a new receiver request replaces a fresh assignment with an obsolete request id', () => {
    const { registerFileAssetHandlers } = require(path.join(ROOT, 'server', 'file-assets.js'));
    const handlers = new Map();
    const providerEvents = [];
    const sessionId = 'session-a';
    const providerId = 'device-provider';
    const receiverId = 'device-receiver';
    const assetId = 'asset-a';
    const assignment = `${assetId}:${receiverId}:full`;
    const record = {
        metadata: { id: assetId, name: 'asset.bin', type: 'application/octet-stream', size: 4 },
        providers: new Set([providerId]),
        assignments: new Map([[assignment, providerId]]),
        assignmentMeta: new Map([[assignment, {
            providerId,
            status: 'assigned',
            requestId: 'request-old',
            assignedAt: Date.now(),
            updatedAt: Date.now()
        }]]),
        providerLoads: new Map([[providerId, 1]])
    };
    const session = {
        devices: new Map([[providerId, {}], [receiverId, {}]]),
        fileAssets: new Map([[assetId, record]])
    };
    const socket = {
        id: 'socket-receiver',
        on(event, handler) {
            handlers.set(event, handler);
        },
        emit() {},
        to() {
            return { emit() {} };
        }
    };

    registerFileAssetHandlers(socket, {
        sessions: new Map([[sessionId, session]]),
        deviceSockets: new Map([[providerId, {
            emit(event, payload) {
                providerEvents.push({ event, payload });
            }
        }]]),
        getSessionId: () => sessionId,
        getDeviceId: () => receiverId,
        isValidId: value => typeof value === 'string' && value.length > 0,
        sanitize: value => String(value || ''),
        historyLog() {},
        clientIp: '127.0.0.1'
    });

    handlers.get('file-asset-request')({
        sessionId,
        assetId,
        preferredProviderId: providerId,
        requestId: 'request-new'
    });

    assert.equal(providerEvents.length, 1);
    assert.equal(providerEvents[0].event, 'file-asset-request');
    assert.equal(providerEvents[0].payload.requestId, 'request-new');
    assert.equal(record.assignmentMeta.get(assignment).requestId, 'request-new');
    assert.equal(record.providerLoads.get(providerId), 1);
});
