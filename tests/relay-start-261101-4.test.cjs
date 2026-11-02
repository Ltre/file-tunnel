'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { registerFileAssetHandlers, cleanupFileAssetRelays } = require('../server/file-assets');

function fixture(t) {
    const sessionId = 'relay-start-261101-4';
    const providerId = 'provider';
    const receiverId = 'receiver';
    const asset = { id: 'asset', name: 'asset.bin', type: 'application/octet-stream', size: 4 };
    const handlers = new Map();
    const receiverHandlers = new Map();
    const targetEvents = [];
    const providerEvents = [];
    const history = [];
    const clientEvents = [];
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    const context = vm.createContext({
        window: {}, console: { info() {}, error() {} },
        setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
        Blob, ArrayBuffer, Uint8Array, DataView
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../client/file-assets.js'), 'utf8'), context);
    const receiver = new context.window.FileAssetTransfer({
        getSocket: () => ({ connected: true, emit: (event, payload) => {
            clientEvents.push({ event, payload });
            receiverHandlers.get(event)?.(payload);
        } }),
        getSessionId: () => sessionId,
        load: async () => null,
        log() {}, onProgress() {}, onUnavailable() {}
    });
    const target = {
        timeout() { return this; },
        emit(event, payload, callback) {
            targetEvents.push({ event, payload });
            const result = event === 'file-asset-relay-start' ? receiver.handleRelayStart(payload) : { ok: true };
            Promise.resolve(result).then(value => callback(null, value), callback);
        }
    };
    const provider = {
        id: 'provider-socket', on: (event, handler) => handlers.set(event, handler),
        emit: (event, payload) => providerEvents.push({ event, payload })
    };
    const record = { metadata: asset, providers: new Set([providerId]), assignments: new Map(), assignmentMeta: new Map(), providerLoads: new Map() };
    const common = {
        sessions: new Map([[sessionId, { devices: new Map([[providerId, {}], [receiverId, {}]]), fileAssets: new Map([[asset.id, record]]) }]]),
        deviceSockets: new Map([[receiverId, target], [providerId, provider]]),
        getSessionId: () => sessionId,
        isValidId: value => typeof value === 'string' && value.length > 0,
        sanitize: value => String(value), historyLog: (event, data) => history.push({ event, data }), clientIp: 'fixture'
    };
    registerFileAssetHandlers(provider, { ...common, getDeviceId: () => providerId });
    registerFileAssetHandlers({ id: 'receiver-socket', on: (event, handler) => receiverHandlers.set(event, handler) }, {
        ...common, getDeviceId: () => receiverId
    });
    t.after(() => cleanupFileAssetRelays(sessionId));
    const call = async (event, payload) => {
        const acknowledgements = [];
        await handlers.get(event)({ sessionId, to: receiverId, ...payload }, value => acknowledgements.push(value));
        assert.equal(acknowledgements.length, 1, 'the provider receives exactly one acknowledgement');
        return acknowledgements[0];
    };
    return { sessionId, providerId, receiverId, asset, receiver, target, targetEvents, providerEvents, record, history, clientEvents, errors, call };
}

test('a relay arriving after the receiver cancels is rejected with an ACK and diagnostic, without an exception log', async t => {
    const f = fixture(t);
    await f.receiver.request(f.asset.id, f.providerId, f.asset);
    const requestId = f.receiver.requestIds.get(f.asset.id);
    assert.ok(requestId, 'the original download was actually requested');
    assert.equal(f.providerEvents[0].payload.requestId, requestId, 'the server forwards the original request identity to its provider');
    f.receiver.cancel(f.asset.id);

    const response = await f.call('file-asset-relay-start', { asset: f.asset, requestId, attemptId: `${requestId}-relay` });
    assert.deepEqual(response, { ok: false, reason: 'receiver-not-requested' });
    assert.equal(f.receiver.transfers.size, 0);
    assert.equal(f.clientEvents.at(-1).payload.reason, 'receiver-not-requested');
    assert.equal(f.errors.length, 0, 'normal cancellation must not become file-asset-relay-start error: Error: receiver-not-requested');
    const diagnostic = f.history.find(item => item.event === 'file-asset-relay-receiver-rejected');
    assert.ok(diagnostic, 'receiver rejection remains diagnosable');
    assert.equal(diagnostic.data.reason, 'receiver-not-requested');
    assert.equal(diagnostic.data.requestId, requestId);
    assert.equal((await f.call('file-asset-relay-chunk', { assetId: f.asset.id, attemptId: `${requestId}-relay`, chunk: Buffer.from('data') })).reason, 'invalid-relay-state');
    assert.equal(f.targetEvents.length, 1, 'rejected starts cannot forward chunks');
});

test('a relay arriving after the download intent is completed remains rejected rather than acknowledged as sent', async t => {
    const f = fixture(t);
    await f.receiver.request(f.asset.id, f.providerId, f.asset);
    const requestId = f.receiver.requestIds.get(f.asset.id);
    f.receiver.releaseCompletedDownload(f.asset.id, f.asset, 'received');
    const response = await f.call('file-asset-relay-start', { asset: f.asset, requestId, attemptId: `${requestId}-relay` });
    assert.deepEqual(response, { ok: false, reason: 'receiver-not-requested' });
    assert.equal(f.errors.length, 0);
    assert.equal(f.history.some(item => item.event === 'file-asset-relay-started'), false);
});

test('an unsolicited relay is still refused without opening receiver state', async t => {
    const f = fixture(t);
    assert.deepEqual(await f.call('file-asset-relay-start', { asset: f.asset }), { ok: false, reason: 'receiver-not-requested' });
    assert.equal(f.receiver.transfers.size, 0);
    assert.equal(f.receiver.desiredAssets.size, 0);
    assert.equal(f.errors.length, 0);
    assert.equal(f.history.at(-1).data.reason, 'receiver-not-requested');
});

test('rejecting an old request preserves the newer active relay and its request identity', async t => {
    const f = fixture(t);
    await f.receiver.request(f.asset.id, f.providerId, f.asset);
    const oldRequestId = f.receiver.requestIds.get(f.asset.id);
    f.receiver.cancel(f.asset.id);
    await f.receiver.request(f.asset.id, f.providerId, f.asset);
    const requestId = f.receiver.requestIds.get(f.asset.id);
    assert.notEqual(oldRequestId, requestId);
    const attemptId = `${requestId}-relay`;
    assert.deepEqual(await f.call('file-asset-relay-start', { asset: f.asset, requestId, attemptId }), { ok: true });

    assert.deepEqual(await f.call('file-asset-relay-start', {
        asset: f.asset, requestId: oldRequestId, attemptId: `${oldRequestId}-relay`
    }), { ok: false, reason: 'receiver-stale-request' });
    assert.equal(f.receiver.requestIds.get(f.asset.id), requestId);
    assert.equal(f.receiver.transfers.get(f.asset.id).attemptId, attemptId);
    assert.equal((await f.call('file-asset-relay-chunk', { assetId: f.asset.id, attemptId, chunk: Buffer.from('data') })).ok, true,
        'a refused old request cannot delete the live relay');
    assert.equal(f.errors.length, 0);
    const diagnostic = f.history.find(item => item.event === 'file-asset-relay-receiver-rejected');
    assert.equal(diagnostic.data.requestId, oldRequestId);
    assert.equal(diagnostic.data.attemptId, `${oldRequestId}-relay`);
});

for (const reason of ['receiver-not-requested', 'receiver-already-cached']) {
    test(`a late ${reason} ACK cannot remove a replacement legacy relay with the same empty-attempt key`, async t => {
        const f = fixture(t);
        await f.receiver.request(f.asset.id, f.providerId, f.asset);
        const oldRequestId = f.receiver.requestIds.get(f.asset.id);
        if (reason === 'receiver-not-requested') f.receiver.cancel(f.asset.id);
        else f.receiver.deps.load = async () => ({ ...f.asset, data: new Uint8Array([1, 2, 3, 4]) });
        let releaseAck;
        let captureAck;
        const captured = new Promise(resolve => { captureAck = resolve; });
        const originalEmit = f.target.emit.bind(f.target);
        let deferFirst = true;
        f.target.emit = (event, payload, callback) => {
            if (event !== 'file-asset-relay-start' || !deferFirst) return originalEmit(event, payload, callback);
            deferFirst = false;
            f.receiver.handleRelayStart(payload).then(result => {
                assert.equal(result.reason, reason);
                releaseAck = () => callback(null, result);
                captureAck();
            });
        };
        const refused = f.call('file-asset-relay-start', { asset: f.asset, requestId: oldRequestId });
        await captured;
        f.receiver.deps.load = async () => null;
        await f.receiver.request(f.asset.id, f.providerId, f.asset);
        const requestId = f.receiver.requestIds.get(f.asset.id);
        assert.notEqual(oldRequestId, requestId);
        assert.deepEqual(await f.call('file-asset-relay-start', { asset: f.asset, requestId }), { ok: true });
        releaseAck();
        assert.equal((await refused).reason, reason);
        assert.equal((await f.call('file-asset-relay-chunk', { assetId: f.asset.id, chunk: Buffer.from('data') })).ok, true,
            'cleanup must compare the relay object as well as its key');
        assert.equal(f.errors.length, 0);
    });
}

for (const [reason, prepare, transfer] of [
    ['receiver-p2p-active', f => f.receiver.begin(f.asset.id, f.asset, f.providerId, 'p2p', 'active-p2p')],
    ['receiver-transfer-active', f => f.receiver.begin(f.asset.id, f.asset, f.providerId, 'socket-relay', '')],
    ['receiver-full-transfer-active', f => f.receiver.begin(f.asset.id, f.asset, f.providerId, 'socket-relay', ''), { transferId: 'range', rangeStart: 0, rangeEnd: 4 }],
    ['receiver-multi-source-active', f => f.receiver.multiSourceTransfers.set(f.asset.id, { ranges: new Map() })]
]) {
    test(`${reason} keeps its negative ACK and diagnostic without an exception log`, async t => {
        const f = fixture(t);
        await f.receiver.request(f.asset.id, f.providerId, f.asset);
        prepare(f);
        const requestId = f.receiver.requestIds.get(f.asset.id);
        assert.deepEqual(await f.call('file-asset-relay-start', { asset: f.asset, requestId, ...transfer }), { ok: false, reason });
        assert.equal(f.errors.length, 0);
        const diagnostic = f.history.find(item => item.event === 'file-asset-relay-receiver-rejected');
        assert.equal(diagnostic.data.reason, reason);
        assert.equal(diagnostic.data.transfer?.transferId, transfer?.transferId);
    });
}

test('a complete receiver cache retains the existing skipped-success acknowledgement', async t => {
    const f = fixture(t);
    await f.receiver.request(f.asset.id, f.providerId, f.asset);
    f.receiver.deps.load = async () => ({ ...f.asset, data: new Uint8Array([1, 2, 3, 4]) });
    const response = await f.call('file-asset-relay-start', { asset: f.asset, requestId: f.receiver.requestIds.get(f.asset.id) });
    assert.deepEqual(response, { ok: true, skipped: true, reason: 'receiver-already-cached' });
    assert.equal(f.errors.length, 0);
    assert.equal(f.history.at(-1).event, 'file-asset-relay-skipped');
    assert.equal((await f.call('file-asset-relay-chunk', { assetId: f.asset.id, chunk: Buffer.from('data') })).reason, 'invalid-relay-state');
});

test('unknown receiver failures remain exception logs and negative acknowledgements', async t => {
    const f = fixture(t);
    f.receiver.handleRelayStart = async () => ({ ok: false, reason: 'receiver-unknown-storage-failure' });
    assert.deepEqual(await f.call('file-asset-relay-start', { asset: f.asset }), { ok: false, reason: 'receiver-unknown-storage-failure' });
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0][0], 'file-asset-relay-start error:');
    assert.equal(f.errors[0][1].message, 'receiver-unknown-storage-failure');
    assert.equal(f.history.at(-1).event, 'file-asset-relay-start-failed');
});

test('acknowledgement transport failures remain visible and are not classified as receiver refusals', async t => {
    const f = fixture(t);
    f.target.emit = (_event, _payload, callback) => callback(new Error('fixture acknowledgement timed out'));
    assert.deepEqual(await f.call('file-asset-relay-start', { asset: f.asset }), { ok: false, reason: 'fixture acknowledgement timed out' });
    assert.equal(f.errors.length, 1);
    assert.equal(f.history.at(-1).event, 'file-asset-relay-start-failed');
});

test('invalid session and range inputs never reach the receiver', async t => {
    const f = fixture(t);
    assert.equal((await f.call('file-asset-relay-start', { sessionId: 'other-session', asset: f.asset })).reason, 'invalid-relay-start');
    assert.equal((await f.call('file-asset-relay-start', { asset: f.asset, transferId: 'range', rangeStart: 0, rangeEnd: 5 })).reason, 'invalid-relay-range');
    assert.equal(f.targetEvents.length, 0);
    assert.equal(f.errors.length, 0);
});

test('a requested relay still starts and forwards its chunks normally', async t => {
    const f = fixture(t);
    await f.receiver.request(f.asset.id, f.providerId, f.asset);
    const requestId = f.receiver.requestIds.get(f.asset.id);
    const attemptId = `${requestId}-relay`;
    assert.deepEqual(await f.call('file-asset-relay-start', { asset: f.asset, requestId, attemptId }), { ok: true });
    assert.equal(f.receiver.transfers.get(f.asset.id).transport, 'socket-relay');
    assert.equal(f.targetEvents[0].payload.requestId, requestId);
    assert.deepEqual(await f.call('file-asset-relay-chunk', { assetId: f.asset.id, attemptId, chunk: Buffer.from('data') }), {
        ok: true, receivedSize: 4, expectedSize: 4
    });
    assert.equal(f.errors.length, 0);
});
