'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../client/file-assets.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
    let now = 10000;
    class Clock extends Date { static now() { return now; } }
    const peers = new Map(), logs = [], context = { window: { location: { origin: 'https://fixture.invalid' } }, Date: Clock, setInterval: () => 0 };
    vm.runInNewContext(source, context);
    const transfer = new context.window.FileAssetTransfer({ getPeer: id => peers.get(id), log: (event, details) => logs.push({ event, details }) });
    return { transfer, peers, logs, advance: ms => { now += ms; } };
}
function report({ timestamp = 1000, sent = 100, received = 200, pairId = 'pair', transport = true } = {}) {
    return new Map([
        ...(transport ? [['transport', { type: 'transport', selectedCandidatePairId: pairId }]] : []),
        [pairId, { id: pairId, type: 'candidate-pair', state: 'succeeded', nominated: true, timestamp, bytesSent: sent, bytesReceived: received, currentRoundTripTime: .012, localCandidateId: 'local', remoteCandidateId: 'remote' }],
        ['local', { type: 'local-candidate', candidateType: 'host', address: '10.0.0.21', port: 50001, protocol: 'udp', usernameFragment: 'secret', url: 'turn:credential@hidden', sdp: 'private' }],
        ['remote', { type: 'remote-candidate', candidateType: 'host', address: '10.0.0.22', port: 50002, protocol: 'udp' }]
    ]);
}

test('records selected addresses and RTT without credentials; rate is connection-scoped and throttled', async () => {
    const h = harness(); let calls = 0, stats = report();
    h.peers.set('b', { connectionState: 'connected', getStats() { calls++; return Promise.resolve(stats); } });
    assert.equal(h.transfer.capturePeerRoute('b', { assetId: 'file-a', attemptId: 'attempt', fileTransport: 'p2p' }), undefined);
    for (let n = 0; n < 100; n++) h.transfer.capturePeerRoute('b');
    await flush(); assert.equal(calls, 1);
    const first = h.logs[0]; assert.equal(first.event, 'file-asset-route-connection-stats');
    assert.equal(first.details.local.address, '10.0.0.21'); assert.equal(first.details.remote.protocol, 'udp');
    assert.equal(first.details.rttMs, 12); assert.equal(first.details.assetId, 'file-a');
    assert.equal(first.details.scope, 'peer-connection'); assert.equal(first.details.connectionSendBytesPerSecond, null);
    assert.doesNotMatch(JSON.stringify(first), /secret|credential|private|usernameFragment/);
    h.advance(4999); h.transfer.capturePeerRoute('b'); await flush(); assert.equal(calls, 1);
    h.advance(1); stats = report({ timestamp: 6000, sent: 10100, received: 5200 });
    h.transfer.capturePeerRoute('b', { assetId: 'file-b', fileTransport: 'socket.io-relay' }); await flush();
    const second = h.logs[1].details;
    assert.equal(second.connectionSendBytesPerSecond, 2000); assert.equal(second.connectionReceiveBytesPerSecond, 1000);
    assert.equal(second.sampleIntervalMs, 5000); assert.equal(second.fileTransport, 'socket.io-relay');
    assert.equal(second.assetId, 'file-b', 'the sampled file context is distinct from the shared connection counters');
});

test('a hanging getStats never blocks callers or grows the pending sample set beyond 32 peers', async () => {
    const h = harness(); let calls = 0, finish;
    for (let n = 0; n < 50; n++) h.peers.set('p' + n, { getStats: () => { calls++; return new Promise(resolve => { if (n === 0) finish = resolve; }); } });
    for (let n = 0; n < 50; n++) assert.equal(h.transfer.capturePeerRoute('p' + n), undefined);
    await flush(); assert.equal(calls, 32); assert.equal(h.transfer.peerRouteSamples.size, 32);
    h.advance(100000); h.transfer.capturePeerRoute('p0'); await flush(); assert.equal(calls, 32, 'pending sampling is never duplicated');
    finish(report()); await flush(); h.transfer.capturePeerRoute('p49'); await flush();
    assert.equal(calls, 33); assert.equal(h.transfer.peerRouteSamples.size, 32);
    assert.equal(h.transfer.peerRouteSamples.has('p0'), false, 'only an idle entry is evicted');
});

test('failed or unavailable stats cannot fail a transfer and failure logs remain throttled', async () => {
    const h = harness(); h.transfer.capturePeerRoute('missing');
    h.peers.set('old-browser', {}); h.transfer.capturePeerRoute('old-browser');
    h.peers.set('failed', { getStats: () => { throw Error('unsupported'); } });
    h.transfer.capturePeerRoute('failed'); await flush();
    assert.equal(h.logs.length, 1); assert.equal(h.logs[0].event, 'file-asset-route-stats-unavailable');
    h.transfer.capturePeerRoute('failed'); await flush(); assert.equal(h.logs.length, 1);
    h.transfer.deps.log = () => { throw Error('logger unavailable'); };
    h.advance(5000); h.transfer.capturePeerRoute('failed'); await flush();
    h.transfer.deps.getPeer = () => { throw Error('peer lookup unavailable'); };
    assert.doesNotThrow(() => h.transfer.capturePeerRoute('failed'));
});

test('replaced connections discard late stats and never combine counters across PeerConnections or candidate pairs', async () => {
    const h = harness(); let finish;
    h.peers.set('b', { getStats: () => new Promise(resolve => { finish = resolve; }) });
    h.transfer.capturePeerRoute('b'); await flush();
    const replacement = { getStats: () => Promise.resolve(report({ timestamp: 6000, sent: 500 })) };
    h.peers.set('b', replacement); finish(report()); await flush(); assert.equal(h.logs.length, 0);
    h.advance(5000); h.transfer.capturePeerRoute('b'); await flush(); assert.equal(h.logs.length, 1);
    h.peers.set('b', { getStats: () => Promise.resolve(report({ timestamp: 11000, sent: 10000 })) });
    h.advance(5000); h.transfer.capturePeerRoute('b'); await flush();
    assert.equal(h.logs[1].details.connectionSendBytesPerSecond, null);
    h.peers.get('b').getStats = () => Promise.resolve(report({ timestamp: 16000, sent: 20000, pairId: 'new-pair', transport: false }));
    h.advance(5000); h.transfer.capturePeerRoute('b'); await flush();
    assert.equal(h.logs[2].details.selected, true); assert.equal(h.logs[2].details.connectionSendBytesPerSecond, null);
});

test('no selected candidate pair is recorded as unknown, not as a local route', async () => {
    const h = harness(); h.peers.set('b', { getStats: () => Promise.resolve(new Map()) });
    h.transfer.capturePeerRoute('b'); await flush();
    assert.equal(h.logs[0].details.selected, false); assert.equal(h.logs[0].details.local, null);
    assert.equal(h.logs[0].details.remote, null); assert.equal(h.logs[0].details.rttMs, null);
});
