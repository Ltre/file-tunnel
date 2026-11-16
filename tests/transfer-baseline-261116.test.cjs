'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const acorn = require('acorn');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = '0de94882c998bd6d1556e80954fa3840835e0746';
const currentSource = fs.readFileSync(path.join(ROOT, 'client/file-assets.js'), 'utf8');
// Read the requested immutable Git object, never the index or another worktree.
const baselineSource = execFileSync('git', ['show', `${BASELINE}:client/file-assets.js`], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024
});

function parseModule(source) {
    const body = acorn.parse(source, { ecmaVersion: 'latest' }).body[0].expression.callee.body.body;
    const klass = body.find(node => node.type === 'ClassDeclaration');
    return {
        methods: new Map(klass.body.body.map(node => [node.key.name, node.value])),
        constants: Object.fromEntries(body.filter(node => node.type === 'VariableDeclaration')
            .flatMap(node => node.declarations.map(decl => [decl.id.name, normalize(decl.init)])))
    };
}

function normalize(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(normalize).filter(item => item !== null);
    // These are the explicitly retained display/diagnostic adapters. They may
    // change UI bookkeeping, but must not change transfer I/O or its decisions.
    if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' &&
        ['onProgress', 'reportUploadProgress', 'endUploadProgress', 'capturePeerRoute']
            .includes(node.expression.callee.property?.name)) return null;
    const result = Object.fromEntries(Object.entries(node)
        .filter(([key]) => !['start', 'end', 'raw'].includes(key))
        .map(([key, value]) => [key, normalize(value)]));
    if (result.type === 'IfStatement' && !result.consequent && !result.alternate) return null;
    return result;
}

const baseline = parseModule(baselineSource), current = parseModule(currentSource);
test('all 33 transfer sizing, scheduling and timeout constants match the requested historical version', () => {
    assert.equal(Object.keys(baseline.constants).length, 33);
    assert.deepEqual(current.constants, baseline.constants);
});

for (const name of ['handleTransferStatus', 'sendRequestedAsset', 'emitTransferStatus', 'waitForBuffer',
    'sendWithBackpressure', 'waitForChannelDrain', 'waitForTransferAck', 'sendViaDataChannel', 'sendViaSocketRelay']) {
    test(`${name} retains baseline control flow and I/O, apart from the retained progress/diagnostic adapter`, () => {
        assert.ok(current.methods.has(name) && baseline.methods.has(name), `both versions must contain ${name}`);
        assert.deepEqual(normalize(current.methods.get(name)), normalize(baseline.methods.get(name)));
    });
}

function load(source, overrides = {}) {
    const context = { window: {}, console, setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout,
        Blob, ArrayBuffer, Uint8Array, DataView, Date, ...overrides };
    vm.runInNewContext(source, context);
    return context.window.FileAssetTransfer;
}

async function requestTrace(source, options = {}) {
    const Transfer = load(source), trace = [], channels = [];
    const peer = {
        connectionState: 'connected', iceConnectionState: 'connected', signalingState: 'stable',
        createDataChannel(label, config) {
            trace.push(['channel', label, config.ordered]);
            const channel = { label, readyState: 'open', bufferedAmount: 0, close() { trace.push(['close']); this.readyState = 'closed'; } };
            channels.push(channel); return channel;
        }
    };
    const transfer = new Transfer({
        getSessionId: () => 'isolated', getPeer: () => peer,
        getSocket: () => ({ connected: true, emit: (event, payload) => trace.push([event, payload.status || payload.reason, payload.requestId]) }),
        connectPeer: async () => { trace.push(['connect']); if (options.connectError) throw Error(options.connectError); },
        ensurePeerOffer: async () => trace.push(['offer']),
        load: async () => options.missing ? null : ({ id: 'file', name: 'file.bin', size: 4, data: new Uint8Array([1, 2, 3, 4]).buffer }),
        onProgress() {}, onUploadIdle() {}, log() {}
    });
    transfer.setupChannel = () => trace.push(['setup']);
    transfer.waitForChannel = async (_channel, timeout) => { trace.push(['wait-channel', timeout]); return !options.channelTimeout; };
    transfer.sendViaDataChannel = async channel => {
        trace.push(['p2p']);
        if (options.rejected) { channel._fileAssetRejected = 'receiver-stale-request'; throw Error('File asset channel closed'); }
        if (options.sendError) throw Error(options.sendError);
    };
    transfer.sendViaSocketRelay = async (_peer, _asset, range, attempt, request) => {
        trace.push(['relay', range?.transferId || '', attempt, request]);
        if (options.relayError) throw Error('relay-failed');
    };
    const result = await transfer.sendRequestedAsset({ asset: { id: 'file', name: 'file.bin', size: 4 }, from: 'phone',
        requestId: 'fixed-request', ...(options.relayOnly ? { transportHint: 'relay-only' } : {}),
        ...(options.invalidRange ? { transfer: { transferId: 'part', rangeStart: 0, rangeEnd: 5 } } : {}) });
    return { result, trace: JSON.parse(JSON.stringify(trace)), cooldown: transfer.p2pUnavailablePeers.get('phone') > Date.now(),
        channels: channels.map(channel => channel.readyState) };
}

for (const options of [{}, { missing: true }, { invalidRange: true }, { relayOnly: true },
    { connectError: 'Peer connection failed' }, { channelTimeout: true },
    { sendError: 'File asset channel backpressure stalled' },
    { sendError: 'File asset channel backpressure timeout: send queue is full' },
    { sendError: 'File asset channel drain timeout' }, { rejected: true },
    { sendError: 'File asset channel closed', relayError: true }, { relayOnly: true, relayError: true }]) {
    test(`requested-asset transport, status, cooldown and failure trace matches baseline: ${JSON.stringify(options)}`, async () => {
        assert.deepEqual(await requestTrace(currentSource, options), await requestTrace(baselineSource, options));
    });
}

async function wireTrace(source, transport, range) {
    const Transfer = load(source), trace = [], data = Uint8Array.from({ length: 160 * 1024 }, (_, n) => n % 251);
    const transfer = new Transfer({ getSessionId: () => 'isolated', getPeer: () => null,
        getSocket: () => ({ connected: true }), onProgress() {}, log() {} });
    const asset = { id: 'file', name: 'file.bin', size: data.length, data: data.buffer };
    function record(event, payload, timeout) {
        const chunk = typeof payload === 'string' ? JSON.parse(payload) : payload;
        const bytes = chunk instanceof ArrayBuffer ? chunk : chunk?.chunk;
        trace.push(bytes ? [event, [...new Uint8Array(bytes)]] : [event, JSON.parse(JSON.stringify(chunk)), timeout]);
    }
    transfer.sendWithBackpressure = async (_channel, payload) => record('datachannel', payload);
    transfer.waitForTransferAck = async (_channel, assetId, transferId, attemptId) => trace.push(['ack', assetId, transferId, attemptId]);
    transfer.waitForChannelDrain = async () => trace.push(['drain']);
    transfer.emitWithAck = async (event, payload, timeout) => { record(event, payload, timeout); return { ok: true }; };
    if (transport === 'p2p') await transfer.sendViaDataChannel({ readyState: 'open', bufferedAmount: 0 }, asset, range, 'phone', 'attempt');
    else await transfer.sendViaSocketRelay('phone', asset, range, 'attempt', 'fixed-request');
    return trace;
}

for (const transport of ['p2p', 'relay']) for (const range of [null, { transferId: 'part', rangeStart: 65536, rangeEnd: 160 * 1024 }]) {
    test(`${transport} preserves actual start/chunk/complete bytes, range boundaries and completion ordering (${range ? 'range' : 'full'})`, async () => {
        assert.deepEqual(await wireTrace(currentSource, transport, range), await wireTrace(baselineSource, transport, range));
    });
}

async function bufferFailure(source, kind) {
    let now = 0, ticks = 0;
    const channel = { readyState: 'open', bufferedAmount: kind === 'timeout' ? 12 * 1024 * 1024 : 5 * 1024 * 1024,
        addEventListener() {}, removeEventListener() {} };
    const Transfer = load(source, { Date: { now: () => now },
        setTimeout(callback, delay) { return setImmediate(() => { now += delay; ticks++; if (kind === 'draining' && ticks === 2) channel.bufferedAmount = 0; if (kind === 'closed') channel.readyState = 'closed'; callback(); }); },
        clearTimeout: clearImmediate });
    const transfer = new Transfer({});
    try { await transfer.waitForBuffer(channel); return { result: 'drained', ticks, threshold: channel.bufferedAmountLowThreshold }; }
    catch (err) { return { result: err.message, ticks, threshold: channel.bufferedAmountLowThreshold }; }
}
for (const kind of ['draining', 'timeout', 'stalled', 'closed']) {
    test(`buffer wait preserves baseline drain/stall/timeout decisions: ${kind}`, async () => {
        assert.deepEqual(await bufferFailure(currentSource, kind), await bufferFailure(baselineSource, kind));
    });
}
