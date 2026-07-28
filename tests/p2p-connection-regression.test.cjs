const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

class MockDataChannel extends EventTarget {
    constructor(label, readyState = 'connecting') {
        super();
        this.label = label;
        this.readyState = readyState;
        this.bufferedAmount = 0;
    }

    send() {}

    close() {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        this.dispatchEvent(new Event('close'));
    }
}

function loadPeerHarness(localDeviceId = 'device-a', remoteDeviceId = 'device-b') {
    const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const start = appSource.indexOf('// ==================== WebRTC P2P ====================');
    const end = appSource.indexOf('// ==================== Editor image assets ====================');
    assert.ok(start >= 0 && end > start, 'WebRTC source region must be discoverable');

    const signals = [];
    const peers = [];
    class MockPeerConnection {
        constructor() {
            this.connectionState = 'new';
            this.iceConnectionState = 'new';
            this.signalingState = 'stable';
            this.iceGatheringState = 'new';
            this.localDescription = null;
            this.remoteDescription = null;
            this.offerCount = 0;
            this.channels = [];
            this.addedCandidates = [];
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
            return { type: 'answer', sdp: 'answer' };
        }

        async setLocalDescription(description) {
            if (description?.type === 'rollback') {
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

        close() {
            this.closed = true;
            this.connectionState = 'closed';
            this.iceConnectionState = 'closed';
            this.signalingState = 'closed';
        }
    }

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
        state: {
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
        },
        peerSignalQueues: new Map(),
        peerReconnectTimers: new Map(),
        PEER_RECONNECT_DELAY: 5,
        editorAssetP2PUnavailablePeers: new Map(),
        EDITOR_ASSET_P2P_COOLDOWN: 5000,
        fileAssetTransfer: null,
        historyLog() {},
        handleDataChannelMessage() {},
        setupEditorAssetDataChannel() {}
    });
    vm.runInContext(appSource.slice(start, end), context, { filename: 'app-webrtc.js' });
    return { context, peers, signals, remoteDeviceId };
}

test('concurrent connects share one PeerConnection and one offer', async () => {
    const harness = loadPeerHarness();
    await Promise.all(Array.from(
        { length: 24 },
        () => harness.context.connectToPeer(harness.remoteDeviceId)
    ));

    assert.equal(harness.peers.length, 1);
    assert.equal(harness.peers[0].offerCount, 1);
    assert.equal(harness.peers[0].channels.length, 1);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'offer').length, 1);
});

test('file offer requests are single-flight for the same peer', async () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    const pc = await harness.context.connectToPeer(harness.remoteDeviceId);
    assert.equal(pc.offerCount, 0, 'non-designated side waits until a file needs the connection');

    await Promise.all([
        harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId),
        harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId),
        harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId)
    ]);

    assert.equal(pc.offerCount, 1);
    assert.equal(pc.channels.length, 1);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'offer').length, 1);
});

test('failed peers are closed and cannot emit stale ICE candidates', async () => {
    const harness = loadPeerHarness();
    const pc = await harness.context.connectToPeer(harness.remoteDeviceId);
    const signalCount = harness.signals.length;
    harness.context.state.socket.connected = false;
    pc.connectionState = 'failed';
    pc.onconnectionstatechange();

    assert.equal(pc.closed, true);
    assert.equal(harness.context.state.peers.has(harness.remoteDeviceId), false);
    pc.onicecandidate({ candidate: { candidate: 'stale-candidate' } });
    assert.equal(harness.signals.length, signalCount);
});

test('peer readiness waits for the shared connection instead of a file channel', async () => {
    const harness = loadPeerHarness();
    const pc = await harness.context.connectToPeer(harness.remoteDeviceId);
    const readiness = harness.context.waitForPeerConnection(harness.remoteDeviceId, 250);
    setTimeout(() => {
        pc.connectionState = 'connected';
        pc.iceConnectionState = 'connected';
        pc.onconnectionstatechange();
    }, 20);
    assert.equal(await readiness, true);
});

test('queued ICE is applied to the same peer before one answer is sent', async () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'ice-candidate',
        candidate: { candidate: 'candidate-before-offer' }
    });
    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'offer',
        sdp: { type: 'offer', sdp: 'remote-offer' }
    });

    assert.equal(harness.peers.length, 1);
    assert.equal(harness.peers[0].addedCandidates.length, 1);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'answer').length, 1);
    assert.equal(harness.context.state.pendingIceCandidates.has(harness.remoteDeviceId), false);
});

test('the designated initiator ignores a competing offer without replacing its peer', async () => {
    const harness = loadPeerHarness('device-a', 'device-z');
    const peer = await harness.context.connectToPeer(harness.remoteDeviceId);
    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'offer',
        sdp: { type: 'offer', sdp: 'competing-offer' }
    });

    assert.equal(harness.peers.length, 1);
    assert.equal(harness.context.state.peers.get(harness.remoteDeviceId), peer);
    assert.equal(peer.signalingState, 'have-local-offer');
    assert.equal(harness.signals.filter(item => item.payload?.type === 'offer').length, 1);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'answer').length, 0);
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

function createFileAssetHarness({ connect = true } = {}) {
    const FileAssetTransfer = loadFileAssetTransfer();
    const socketEvents = [];
    const channels = [];
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
    let releaseReadiness;
    const readiness = new Promise(resolve => {
        releaseReadiness = () => {
            if (connect) {
                peer.connectionState = 'connected';
                peer.iceConnectionState = 'connected';
            }
            resolve(connect);
        };
    });
    const transfer = new FileAssetTransfer({
        getSocket: () => ({
            connected: true,
            emit(event, payload) {
                socketEvents.push({ event, payload });
            }
        }),
        getSessionId: () => 'session',
        getPeer: () => peer,
        connectPeer: async () => peer,
        ensurePeerOffer: async () => peer,
        waitForPeerConnection: async () => readiness,
        load: async fileId => ({
            id: fileId,
            name: `${fileId}.jpg`,
            type: 'image/jpeg',
            size: 4,
            data: new Uint8Array([1, 2, 3, 4])
        }),
        onProgress() {},
        log() {}
    });
    let p2pSends = 0;
    let relaySends = 0;
    transfer.sendViaDataChannel = async () => {
        p2pSends++;
    };
    transfer.sendViaSocketRelay = async () => {
        relaySends++;
    };
    return {
        transfer,
        peer,
        channels,
        releaseReadiness,
        get p2pSends() { return p2pSends; },
        get relaySends() { return relaySends; }
    };
}

test('file DataChannel is created only after the shared peer becomes connected', async () => {
    const harness = createFileAssetHarness();
    const send = harness.transfer.sendRequestedAsset({
        asset: { id: 'asset-a', name: 'a.jpg', type: 'image/jpeg', size: 4 },
        from: 'device-b',
        requestId: 'request-a'
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(harness.channels.length, 0);
    harness.releaseReadiness();
    assert.equal(await send, true);
    assert.equal(harness.channels.length, 1);
    assert.equal(harness.p2pSends, 1);
    assert.equal(harness.relaySends, 0);
});

test('a batch of small files waits on one shared peer before opening file channels', async () => {
    const harness = createFileAssetHarness();
    const sends = Array.from({ length: 16 }, (_, index) => harness.transfer.sendRequestedAsset({
        asset: {
            id: `asset-batch-${index}`,
            name: `batch-${index}.jpg`,
            type: 'image/jpeg',
            size: 4
        },
        from: 'device-b',
        requestId: `request-batch-${index}`
    }));

    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(harness.channels.length, 0);
    harness.releaseReadiness();
    assert.deepEqual(await Promise.all(sends), Array(16).fill(true));
    assert.equal(harness.channels.length, 16);
    assert.equal(harness.p2pSends, 16);
    assert.equal(harness.relaySends, 0);
});

test('failed shared peer readiness falls back once without creating a file channel', async () => {
    const harness = createFileAssetHarness({ connect: false });
    const send = harness.transfer.sendRequestedAsset({
        asset: { id: 'asset-b', name: 'b.jpg', type: 'image/jpeg', size: 4 },
        from: 'device-b',
        requestId: 'request-b'
    });
    harness.releaseReadiness();
    assert.equal(await send, true);
    assert.equal(harness.channels.length, 0);
    assert.equal(harness.p2pSends, 0);
    assert.equal(harness.relaySends, 1);
    assert.equal(harness.transfer.p2pUnavailablePeers.size, 0);
});
