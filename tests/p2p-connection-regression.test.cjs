const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadProgressKeyHarness() {
    const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const start = appSource.indexOf('function getSendingProgressPeerId');
    const end = appSource.indexOf('function getProgressBaseFileId');
    assert.ok(start >= 0 && end > start, 'progress key source region must be discoverable');
    const context = vm.createContext({});
    vm.runInContext(appSource.slice(start, end), context, { filename: 'app-progress-key.js' });
    return context;
}

function loadStoredAssetAnnouncementHarness() {
    const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const start = appSource.indexOf('async function announceStoredFileAssets');
    const end = appSource.indexOf('async function handleFileAssetDiscovery');
    assert.ok(start >= 0 && end > start, 'stored asset announcement source region must be discoverable');
    const metrics = { announced: 0, resumed: 0 };
    const context = vm.createContext({
        Date,
        getCurrentSessionFileInventory: async () => [{
            id: 'asset-a', name: 'a.bin', size: 4, ownerDeviceId: 'device-a', isFileAsset: true
        }],
        materializeExternalFileRecord: async file => file,
        hasCompleteFileInventoryCache: () => true,
        saveToStore: async () => {},
        historyLog() {},
        fileAssetTransfer: {
            async announce() { metrics.announced++; },
            resumePending() { metrics.resumed++; }
        }
    });
    vm.runInContext(appSource.slice(start, end), context, { filename: 'app-file-presence.js' });
    return { context, metrics };
}

test('multi-source upload progress is grouped per receiver without splitting P2P and relay attempts', () => {
    const harness = loadProgressKeyHarness();
    const p2pA = harness.getFileProgressKey('asset-a', 'sending-multi-source:device-a:part-0');
    const relayA = harness.getFileProgressKey('asset-a', 'sending-multi-source-relay:device-a:part-0');
    const p2pB = harness.getFileProgressKey('asset-a', 'sending-multi-source:device-b:part-0');

    assert.equal(p2pA, relayA, 'one receiver keeps one row while its range falls back');
    assert.notEqual(p2pA, p2pB, 'different receivers must not overwrite each other');
});

test('routine file presence refresh does not reset pending downloads', async () => {
    const harness = loadStoredAssetAnnouncementHarness();

    await harness.context.announceStoredFileAssets();
    assert.deepEqual(harness.metrics, { announced: 1, resumed: 0 });

    await harness.context.announceStoredFileAssets({ resumePending: true });
    assert.deepEqual(harness.metrics, { announced: 2, resumed: 1 });
});

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
        PEER_STALE_OFFER_MS: 8000,
        editorAssetP2PUnavailablePeers: new Map(),
        EDITOR_ASSET_P2P_COOLDOWN: 5000,
        fileAssetTransfer: null,
        isPrivateNetworkIp(value) {
            const ip = String(value || '').replace(/^::ffff:/i, '');
            return /^10\./.test(ip) ||
                /^192\.168\./.test(ip) ||
                /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
                /^127\./.test(ip) ||
                /^169\.254\./.test(ip) ||
                /^fc/i.test(ip) ||
                /^fd/i.test(ip) ||
                /^fe80:/i.test(ip);
        },
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
    const harness = loadPeerHarness('device-a', 'device-z');
    const pc = await harness.context.connectToPeer(harness.remoteDeviceId);
    assert.equal(pc.offerCount, 1, 'the designated side starts the connection');

    await Promise.all([
        harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId),
        harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId),
        harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId)
    ]);

    assert.equal(pc.offerCount, 1);
    assert.equal(pc.channels.length, 1);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'offer').length, 1);
});

test('a file request lets the non-designated peer start P2P instead of waiting for relay fallback', async () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    const pc = await harness.context.connectToPeer(harness.remoteDeviceId);
    assert.equal(pc.offerCount, 0, 'the non-designated side waits for the remote offer');

    await harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId);

    assert.equal(pc.offerCount, 1);
    assert.equal(pc.channels.length, 1);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'offer').length, 1);
});

test('file requests do not renegotiate a peer that is already checking ICE', async () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    const pc = await harness.context.connectToPeer(harness.remoteDeviceId);
    await harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId);
    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'answer',
        sdp: { type: 'answer', sdp: 'answer' }
    });
    pc.iceConnectionState = 'checking';
    pc.connectionState = 'connecting';

    await Promise.all([
        harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId),
        harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId),
        harness.context.connectToPeer(harness.remoteDeviceId)
    ]);

    assert.equal(pc.offerCount, 1);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'offer').length, 1);
});

test('failed peers close without starting an unsynchronized background reconnect', async () => {
    const harness = loadPeerHarness();
    const pc = await harness.context.connectToPeer(harness.remoteDeviceId);
    const signalCount = harness.signals.length;
    pc.connectionState = 'failed';
    pc.onconnectionstatechange();
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(pc.closed, true);
    assert.equal(harness.context.state.peers.has(harness.remoteDeviceId), false);
    assert.equal(harness.peers.length, 1);
    pc.onicecandidate({ candidate: { candidate: 'stale-candidate' } });
    assert.equal(harness.signals.length, signalCount);
});

test('the next file request creates one fresh peer after the previous peer failed', async () => {
    const harness = loadPeerHarness();
    const failedPeer = await harness.context.connectToPeer(harness.remoteDeviceId);
    failedPeer.connectionState = 'failed';
    failedPeer.onconnectionstatechange();

    const replacement = await harness.context.connectToPeerForFileAsset(harness.remoteDeviceId);
    await harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId);

    assert.notEqual(replacement, failedPeer);
    assert.equal(failedPeer.closed, true);
    assert.equal(harness.peers.length, 2);
    assert.equal(replacement.offerCount, 1);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'offer').length, 2);
});

test('a fresh ICE checking peer is reused instead of being churned', async () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    const peer = await harness.context.connectToPeer(harness.remoteDeviceId);
    peer.iceConnectionState = 'checking';
    peer.connectionState = 'connecting';
    peer.oniceconnectionstatechange();

    const reused = await harness.context.connectToPeer(harness.remoteDeviceId);

    assert.equal(reused, peer);
    assert.equal(peer.closed, false);
    assert.equal(harness.peers.length, 1);
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

test('heartbeat retries only unresolved session peers', async () => {
    const harness = loadPeerHarness();

    assert.equal(harness.context.shouldPreconnectSessionPeer(harness.remoteDeviceId, true, ''), true);
    assert.equal(harness.context.shouldPreconnectSessionPeer(harness.remoteDeviceId, true, 'heartbeat'), true);
    assert.equal(harness.context.shouldPreconnectSessionPeer(harness.remoteDeviceId, true, 'history-request'), false);
    assert.equal(harness.context.shouldPreconnectSessionPeer(harness.remoteDeviceId, false, ''), false);
    assert.equal(harness.context.shouldPreconnectSessionPeer(harness.remoteDeviceId, false, 'heartbeat'), true);

    const peer = await harness.context.connectToPeer(harness.remoteDeviceId);
    assert.equal(harness.context.shouldPreconnectSessionPeer(harness.remoteDeviceId, false, 'heartbeat'), false);
    peer._offerSentAt = Date.now() - 9000;
    assert.equal(harness.context.shouldPreconnectSessionPeer(harness.remoteDeviceId, false, 'heartbeat'), true);
    peer.connectionState = 'connected';
    peer.iceConnectionState = 'connected';
    assert.equal(harness.context.shouldPreconnectSessionPeer(harness.remoteDeviceId, false, 'heartbeat'), false);
});

test('a heartbeat retry replaces a stale unanswered local offer', async () => {
    const harness = loadPeerHarness();
    const stalePeer = await harness.context.connectToPeer(harness.remoteDeviceId);
    stalePeer._offerSentAt = Date.now() - 9000;

    const replacement = await harness.context.connectToPeer(harness.remoteDeviceId);

    assert.notEqual(replacement, stalePeer);
    assert.equal(stalePeer.closed, true);
    assert.equal(harness.peers.length, 2);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'offer').length, 2);
});

test('a fresh remote offer cancels disposal of a temporarily disconnected peer', async () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    const peer = await harness.context.connectToPeer(harness.remoteDeviceId);
    peer.iceConnectionState = 'disconnected';
    peer.oniceconnectionstatechange();
    assert.ok(peer._disconnectTimer);

    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'offer',
        sdp: { type: 'offer', sdp: 'recovery-offer' }
    });

    assert.equal(peer._disconnectTimer, null);
    assert.equal(peer.closed, false);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'answer').length, 1);
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

test('answers send the current local description with already gathered candidates', async () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    const pc = await harness.context.createPeerConnection(harness.remoteDeviceId);
    const setLocalDescription = pc.setLocalDescription.bind(pc);
    pc.setLocalDescription = async description => {
        await setLocalDescription(description);
        if (description.type === 'answer') {
            pc.localDescription = { ...description, sdp: 'answer-with-current-candidates' };
        }
    };

    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'offer',
        sdp: { type: 'offer', sdp: 'offer' }
    });

    const answer = harness.signals.find(item => item.payload?.type === 'answer');
    assert.equal(answer.payload.sdp.sdp, 'answer-with-current-candidates');
});

test('a server-observed private address supplements an mDNS host candidate', async () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'ice-candidate',
        observedIp: '::ffff:10.0.0.23',
        candidate: {
            candidate: 'candidate:1 1 udp 2122260223 peer-name.local 54321 typ host generation 0',
            sdpMid: '0',
            sdpMLineIndex: 0,
            usernameFragment: 'remote'
        }
    });
    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'offer',
        sdp: { type: 'offer', sdp: 'remote-offer' }
    });

    assert.equal(harness.peers[0].addedCandidates.length, 2);
    assert.match(harness.peers[0].addedCandidates[0].candidate, /peer-name\.local/);
    assert.match(harness.peers[0].addedCandidates[1].candidate, /\s10\.0\.0\.23\s54321\s/);
});

test('a server-observed private address supplements host candidates embedded in SDP', async () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'offer',
        observedIp: '10.0.0.23',
        sdp: {
            type: 'offer',
            sdp: 'v=0\r\na=candidate:1 1 udp 2122260223 peer-name.local 54321 typ host generation 0\r\n'
        }
    });

    assert.match(harness.peers[0].remoteDescription.sdp, /peer-name\.local/);
    assert.match(harness.peers[0].remoteDescription.sdp, /\s10\.0\.0\.23\s54321\s/);
});

test('a public server-observed address does not rewrite an mDNS host candidate', () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    harness.context.state.devices.set(harness.remoteDeviceId, {
        id: harness.remoteDeviceId,
        externalIp: '203.0.113.8'
    });
    const variants = harness.context.getRemoteIceCandidateVariants(harness.remoteDeviceId, {
        candidate: 'candidate:1 1 udp 2122260223 peer-name.local 54321 typ host generation 0'
    });

    assert.equal(variants.length, 1);
    assert.match(variants[0].candidate, /peer-name\.local/);
});

test('a loopback proxy address does not rewrite an mDNS host candidate', () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    harness.context.state.devices.set(harness.remoteDeviceId, {
        id: harness.remoteDeviceId,
        externalIp: '127.0.0.1'
    });
    const variants = harness.context.getRemoteIceCandidateVariants(harness.remoteDeviceId, {
        candidate: 'candidate:1 1 udp 2122260223 peer-name.local 54321 typ host generation 0'
    });

    assert.equal(variants.length, 1);
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

test('a file-triggered offer rolls back cleanly when the designated initiator offer arrives', async () => {
    const harness = loadPeerHarness('device-z', 'device-a');
    const peer = await harness.context.connectToPeer(harness.remoteDeviceId);
    await harness.context.ensurePeerOfferForFileAsset(harness.remoteDeviceId);

    await harness.context.handleSignal({
        from: harness.remoteDeviceId,
        type: 'offer',
        sdp: { type: 'offer', sdp: 'designated-initiator-offer' }
    });

    assert.equal(harness.peers.length, 1);
    assert.equal(harness.context.state.peers.get(harness.remoteDeviceId), peer);
    assert.equal(peer.signalingState, 'stable');
    assert.equal(harness.signals.filter(item => item.payload?.type === 'offer').length, 1);
    assert.equal(harness.signals.filter(item => item.payload?.type === 'answer').length, 1);
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
    const progressEvents = [];
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
        onProgress(...args) {
            progressEvents.push(args);
        },
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
        socketEvents,
        progressEvents,
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
    assert.equal(harness.channels[0].readyState, 'closed');
    assert.equal(harness.channels[0].onmessage, null);
    assert.equal(harness.channels[0]._fileAssetPeerConnection, null);
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
    assert.equal(harness.channels.every(channel => channel.readyState === 'closed'), true);
    assert.equal(harness.channels.every(channel => channel.onmessage === null), true);
    assert.equal(harness.channels.every(channel => channel._fileAssetPeerConnection === null), true);
});

test('a failed file DataChannel releases its references before relay fallback', async () => {
    const harness = createFileAssetHarness();
    harness.transfer.sendViaDataChannel = async () => {
        throw new Error('simulated P2P send failure');
    };
    const send = harness.transfer.sendRequestedAsset({
        asset: { id: 'asset-fallback', name: 'fallback.jpg', type: 'image/jpeg', size: 4 },
        from: 'device-b',
        requestId: 'request-fallback'
    });

    harness.releaseReadiness();
    assert.equal(await send, true);
    assert.equal(harness.channels.length, 1);
    assert.equal(harness.channels[0].readyState, 'closed');
    assert.equal(harness.channels[0].onmessage, null);
    assert.equal(harness.channels[0]._fileAssetPeerConnection, null);
    assert.equal(harness.relaySends, 1);
});

test('a file channel close does not put a healthy shared peer into cooldown', async () => {
    const harness = createFileAssetHarness();
    harness.transfer.sendViaDataChannel = async () => {
        throw new Error('File asset channel closed before receiver acknowledgement');
    };
    const send = harness.transfer.sendRequestedAsset({
        asset: { id: 'asset-channel-close', name: 'channel-close.jpg', type: 'image/jpeg', size: 4 },
        from: 'device-b',
        requestId: 'request-channel-close'
    });

    harness.releaseReadiness();
    assert.equal(await send, true);
    assert.equal(harness.relaySends, 1);
    assert.equal(harness.transfer.p2pUnavailablePeers.has('device-b'), false);
});

test('a file channel failure still cools down a failed shared peer', async () => {
    const harness = createFileAssetHarness();
    harness.transfer.sendViaDataChannel = async () => {
        harness.peer.connectionState = 'failed';
        throw new Error('File asset channel closed');
    };
    const send = harness.transfer.sendRequestedAsset({
        asset: { id: 'asset-peer-failed', name: 'peer-failed.jpg', type: 'image/jpeg', size: 4 },
        from: 'device-b',
        requestId: 'request-peer-failed'
    });

    harness.releaseReadiness();
    assert.equal(await send, true);
    assert.equal(harness.relaySends, 1);
    assert.equal(harness.transfer.p2pUnavailablePeers.has('device-b'), true);
});

test('receiver leaves a completed channel open until the sender receives its acknowledgement', async () => {
    const harness = createFileAssetHarness();
    const channel = new MockDataChannel('file-asset:asset-ack', 'open');
    harness.transfer.complete = async () => {};

    await harness.transfer.handleChannelMessage(
        'device-b',
        'asset-ack',
        JSON.stringify({ type: 'file-asset-complete', assetId: 'asset-ack', attemptId: 'attempt-ack' }),
        channel
    );

    assert.equal(channel.readyState, 'open');
    assert.equal(channel.sent.length, 1);
    assert.deepEqual(JSON.parse(channel.sent[0]), {
        type: 'file-asset-complete-ack',
        assetId: 'asset-ack',
        transferId: '',
        attemptId: 'attempt-ack',
        ok: true
    });
    channel.close();
});

test('a late incoming transfer cancels its pending retry before it can be requested again', () => {
    const harness = createFileAssetHarness();
    const assetId = 'asset-late-after-retry';
    const asset = { id: assetId, name: 'late.bin', type: 'application/octet-stream', size: 4 };
    harness.transfer.desiredAssets.set(assetId, 'device-b');
    harness.transfer.requestedMetadata.set(assetId, asset);
    harness.transfer.activeDownloads.add(assetId);

    harness.transfer.retryDownload(assetId, 'device-b', 'simulated-late-start');
    assert.equal(harness.transfer.retryTimers.has(assetId), true);
    assert.equal(harness.transfer.activeDownloads.has(assetId), false);

    assert.equal(harness.transfer.begin(assetId, asset, 'device-b', 'p2p', 'late-attempt'), true);
    assert.equal(harness.transfer.retryTimers.has(assetId), false);
    assert.equal(harness.transfer.activeDownloads.has(assetId), true);
    harness.transfer.cancel(assetId);
});

test('the request watchdog does not bypass a pending retry timer', () => {
    const harness = createFileAssetHarness();
    const assetId = 'asset-pending-provider-retry';
    harness.transfer.desiredAssets.set(assetId, null);
    harness.transfer.requestedMetadata.set(assetId, {
        id: assetId,
        name: 'pending.bin',
        type: 'application/octet-stream',
        size: 4
    });
    const timer = setTimeout(() => {}, 60000);
    harness.transfer.retryTimers.set(assetId, timer);

    for (let index = 0; index < 100; index++) harness.transfer.checkRequestStalls();

    assert.equal(harness.transfer.activeDownloads.has(assetId), false);
    assert.equal(harness.transfer.downloadQueue.includes(assetId), false);
    assert.equal(harness.socketEvents.some(({ event }) => event === 'file-asset-request'), false);

    harness.transfer.clearRetryTimer(assetId);
    assert.equal(harness.transfer.ensureDesiredDownloadQueued(assetId, 'retry-owner-released'), true);
    assert.equal(harness.socketEvents.filter(({ event }) => event === 'file-asset-request').length, 1);
    harness.transfer.cancel(assetId);
});

test('provider backpressure is reported as a transient failure without relay fallback', async () => {
    const harness = createFileAssetHarness();
    harness.transfer.sendViaDataChannel = async () => {
        throw new Error('File asset channel backpressure timeout');
    };
    const send = harness.transfer.sendRequestedAsset({
        asset: { id: 'asset-backpressure', name: 'backpressure.jpg', type: 'image/jpeg', size: 4 },
        from: 'device-b',
        requestId: 'request-backpressure'
    });

    harness.releaseReadiness();
    assert.equal(await send, false);
    assert.equal(harness.relaySends, 0);
    const statusEvent = harness.socketEvents.find(({ event, payload }) => (
        event === 'file-asset-transfer-status' && payload.status === 'failed'
    ));
    assert.equal(statusEvent?.payload.reason, 'provider-backpressure');
    assert.equal(statusEvent?.payload.retryAfterMs, 1200);
});

test('full-file provider backpressure requeues without consuming a retry', async () => {
    const harness = createFileAssetHarness();
    const assetId = 'asset-full-backpressure';
    harness.transfer.desiredAssets.set(assetId, 'device-b');
    harness.transfer.requestIds.set(assetId, 'request-full');
    harness.transfer.requestedMetadata.set(assetId, {
        id: assetId,
        name: 'full.bin',
        type: 'application/octet-stream',
        size: 4
    });
    harness.transfer.activeDownloads.add(assetId);
    harness.transfer.priorityDownloads.add(assetId);
    harness.transfer.transfers.set(assetId, {
        asset: harness.transfer.requestedMetadata.get(assetId),
        from: 'device-b'
    });

    await harness.transfer.handleTransferStatus({
        assetId,
        from: 'device-b',
        status: 'failed',
        requestId: 'request-full',
        reason: 'provider-backpressure',
        retryAfterMs: 500
    });

    assert.equal(harness.transfer.retryCounts.has(assetId), false);
    assert.equal(harness.transfer.desiredAssets.has(assetId), true);
    assert.equal(harness.transfer.priorityDownloads.has(assetId), true);
    assert.equal(harness.transfer.transfers.has(assetId), false);
    assert.equal(harness.transfer.retryTimers.has(assetId), true);
    harness.transfer.clearRetryTimer(assetId);
});

test('multi-source provider backpressure defers only its range without consuming a retry', async () => {
    const harness = createFileAssetHarness();
    const assetId = 'asset-range-backpressure';
    const transferId = 'part-0';
    const range = {
        transferId,
        rangeStart: 0,
        rangeEnd: 4,
        receivedSize: 2,
        retryCount: 2,
        retryScheduled: false,
        active: true,
        completed: false,
        from: 'device-b',
        providerId: 'device-b',
        providerCursor: 0,
        requestId: 'request-range',
        pendingChunks: Promise.resolve(),
        lastActivityAt: Date.now()
    };
    harness.transfer.desiredAssets.set(assetId, 'device-b');
    harness.transfer.multiSourceTransfers.set(assetId, {
        asset: { id: assetId, name: 'range.bin', size: 4 },
        providers: ['device-b', 'device-c'],
        ranges: new Map([[transferId, range]]),
        activeRangeIds: new Set([transferId]),
        queuedRangeIds: [],
        receivedBytes: 2,
        completedBytes: 0
    });

    await harness.transfer.handleTransferStatus({
        assetId,
        from: 'device-b',
        status: 'failed',
        transferId,
        requestId: 'request-range',
        reason: 'provider-backpressure',
        retryAfterMs: 500
    });

    assert.equal(range.retryCount, 2);
    assert.equal(range.retryScheduled, true);
    assert.equal(range.active, false);
    assert.equal(range.receivedSize, 0);
    assert.equal(range.providerCursor, 1);
    assert.equal(harness.transfer.multiSourceTransfers.get(assetId).receivedBytes, 0);
    assert.equal(harness.transfer.rangeTimers.has(`${assetId}:${transferId}`), true);
    harness.transfer.clearRangeTimers(assetId);
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

test('multi-source watchdog gives a fully received range time to process its completion frame', () => {
    const harness = createFileAssetHarness();
    const now = Date.now();
    const range = {
        transferId: 'part-0',
        rangeStart: 0,
        rangeEnd: 4,
        receivedSize: 4,
        lastActivityAt: now - 13000,
        providerId: 'device-b',
        active: true,
        completed: false,
        retryScheduled: false
    };
    harness.transfer.multiSourceTransfers.set('asset-range', {
        asset: { id: 'asset-range', name: 'range.bin', size: 4 },
        ranges: new Map([['part-0', range]]),
        activeRangeIds: new Set(['part-0']),
        queuedRangeIds: [],
        startedAt: now - 13000,
        lastProgressAt: now - 13000
    });
    let retries = 0;
    harness.transfer.retryMultiSourceRange = () => { retries++; };

    harness.transfer.checkMultiSourceStall('asset-range');
    assert.equal(retries, 0, '12 second data stall must not discard a range whose bytes are complete');

    range.lastActivityAt = Date.now() - 31000;
    harness.transfer.checkMultiSourceStall('asset-range');
    assert.equal(retries, 1, 'a missing completion frame still retries after the normal receive timeout');
});

test('multi-source provider progress accumulates unique range bytes without retry regressions', () => {
    const harness = createFileAssetHarness();
    const asset = {
        id: 'asset-progress',
        name: 'progress.bin',
        size: 8,
        data: new Uint8Array(8)
    };
    const part0 = { transferId: 'part-0', rangeStart: 0, rangeEnd: 4 };
    const part1 = { transferId: 'part-1', rangeStart: 4, rangeEnd: 8 };

    harness.transfer.reportUploadProgress(asset, 'device-b', part0, 4, 'sending-multi-source:device-b:part-0', {
        rangeComplete: true
    });
    harness.transfer.reportUploadProgress(asset, 'device-b', part1, 2, 'sending-multi-source:device-b:part-1');
    harness.transfer.reportUploadProgress(asset, 'device-b', part0, 1, 'sending-multi-source:device-b:part-0');
    harness.transfer.reportUploadProgress(asset, 'device-b', part1, 4, 'sending-multi-source:device-b:part-1');
    harness.transfer.reportUploadProgress(asset, 'device-b', part1, 4, 'sending-multi-source:device-b:part-1', {
        rangeComplete: true
    });

    assert.deepEqual(harness.progressEvents.map(event => event[2]), [50, 75, 75, 99, 100]);
    assert.equal(harness.transfer.multiSourceUploadProgress.size, 0);
});

test('stale upload bookkeeping is pruned without touching fresh transfer state', () => {
    const harness = createFileAssetHarness();
    const now = Date.now();
    harness.transfer.multiSourceUploadProgress.set('old', {
        ranges: new Map(),
        uniqueSentBytes: 0,
        updatedAt: now - (3 * 60 * 1000)
    });
    harness.transfer.multiSourceUploadProgress.set('fresh', {
        ranges: new Map(),
        uniqueSentBytes: 0,
        updatedAt: now
    });
    harness.transfer.rejectedUploadKeys.set('expired', now - 1);
    harness.transfer.rejectedUploadKeys.set('fresh', now + 30000);

    harness.transfer.cleanupMultiSourceUploadProgress(now);
    harness.transfer.cleanupRejectedUploads(now);

    assert.equal(harness.transfer.multiSourceUploadProgress.has('old'), false);
    assert.equal(harness.transfer.multiSourceUploadProgress.has('fresh'), true);
    assert.equal(harness.transfer.rejectedUploadKeys.has('expired'), false);
    assert.equal(harness.transfer.rejectedUploadKeys.has('fresh'), true);
});

test('late multi-source starts are rejected while the completed file is being stored', () => {
    const harness = createFileAssetHarness();
    harness.transfer.desiredAssets.set('asset-completing', 'device-b');
    harness.transfer.multiSourceTransfers.set('asset-completing', {
        completing: true,
        ranges: new Map()
    });

    const acceptance = harness.transfer.shouldAcceptIncomingTransfer(
        'asset-completing',
        { id: 'asset-completing', size: 4 },
        'attempt-a',
        'part-0'
    );
    assert.equal(acceptance.ok, false);
    assert.equal(acceptance.reason, 'multi-source-completing');

    harness.transfer.multiSourceTransfers.set('asset-completing', {
        completing: false,
        ranges: new Map([['part-0', { completed: true }]])
    });
    const completedRangeAcceptance = harness.transfer.shouldAcceptIncomingTransfer(
        'asset-completing',
        { id: 'asset-completing', size: 4 },
        'attempt-b',
        'part-0'
    );
    assert.equal(completedRangeAcceptance.ok, false);
    assert.equal(completedRangeAcceptance.reason, 'range-completed');
});
