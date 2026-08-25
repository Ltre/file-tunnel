'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { registerFileAssetHandlers } = require('../server/file-assets');

function createSocket({ onRoomEmit } = {}) {
    const handlers = new Map();
    const emitted = [];
    return {
        id: 'socket-current',
        handlers,
        emitted,
        on(event, handler) {
            handlers.set(event, handler);
        },
        emit(event, payload) {
            emitted.push({ event, payload });
        },
        to(room) {
            return {
                emit(event, payload) {
                    onRoomEmit?.(room, event, payload);
                }
            };
        }
    };
}

function registerHarness({ socket, sessionId, session, currentDeviceId, deviceSockets = new Map(), ...audit }) {
    registerFileAssetHandlers(socket, {
        sessions: new Map([[sessionId, session]]),
        deviceSockets,
        getSessionId: () => sessionId,
        getDeviceId: () => currentDeviceId,
        isValidAssetId: value => typeof value === 'string' && value.length > 0,
        isValidDeviceId: value => typeof value === 'string' && value.length > 0,
        isValidSessionId: value => typeof value === 'string' && value.length > 0,
        sanitize: value => String(value || ''),
        historyLog: audit.historyLog || (() => {}),
        clientIp: '127.0.0.1',
        enqueueAudit: audit.enqueueAudit,
        recordFileAsset: audit.recordFileAsset,
        recordTransferEvent: audit.recordTransferEvent
    });
    return socket.handlers;
}

function createAsset(id = 'asset-one') {
    return {
        id,
        name: `${id}.bin`,
        type: 'application/octet-stream',
        size: 1024,
        ownerDeviceId: 'provider-one'
    };
}

function createAssetRecord(asset, providerId = 'provider-one') {
    return {
        metadata: { ...asset },
        providers: new Set([providerId]),
        providerLoads: new Map(),
        assignments: new Map(),
        assignmentMeta: new Map()
    };
}

test('availability broadcasts before queued metadata audit and repeated presence is audit-idempotent', () => {
    const sessionId = 'session-available';
    const providerId = 'provider-one';
    const asset = createAsset();
    const order = [];
    const queuedAudits = [];
    const metadataAudits = [];
    const transferEvents = [];
    const socket = createSocket({
        onRoomEmit(room, event) {
            assert.equal(room, sessionId);
            if (event === 'file-asset-available') order.push('broadcast');
        }
    });
    const session = {
        devices: new Map([[providerId, {}]]),
        fileAssets: new Map()
    };
    const handlers = registerHarness({
        socket,
        sessionId,
        session,
        currentDeviceId: providerId,
        historyLog(event) {
            if (event === 'file-asset-available') order.push('history');
        },
        enqueueAudit(task) {
            order.push('enqueue');
            queuedAudits.push(task);
        },
        recordFileAsset(...args) {
            order.push('audit');
            metadataAudits.push(args);
        },
        recordTransferEvent(...args) {
            transferEvents.push(args);
        }
    });

    handlers.get('file-asset-available')({ sessionId, asset });

    assert.deepEqual(order, ['broadcast', 'history', 'enqueue']);
    assert.equal(metadataAudits.length, 0, 'metadata persistence must not run in the socket callback');
    assert.equal(queuedAudits.length, 1);
    queuedAudits.shift()();
    assert.deepEqual(order, ['broadcast', 'history', 'enqueue', 'audit']);
    assert.equal(metadataAudits.length, 1);
    assert.equal(transferEvents.length, 0, 'presence heartbeat must not become append-only transfer evidence');

    handlers.get('file-asset-available')({ sessionId, asset });

    assert.deepEqual(order.slice(-2), ['broadcast', 'history']);
    assert.equal(queuedAudits.length, 0, 'repeated availability must not enqueue another metadata audit');
    assert.equal(metadataAudits.length, 1);
    assert.equal(transferEvents.length, 0);
});

test('file metadata audit failures remain visible to the server retry queue', () => {
    const sessionId = 'session-audit-retry';
    const providerId = 'provider-one';
    const socket = createSocket();
    const session = {
        devices: new Map([[providerId, {}]]),
        fileAssets: new Map()
    };
    let queuedAudit = null;
    const handlers = registerHarness({
        socket,
        sessionId,
        session,
        currentDeviceId: providerId,
        enqueueAudit(task) {
            queuedAudit = task;
        },
        recordFileAsset() {
            throw new Error('audit-write-failed');
        }
    });

    handlers.get('file-asset-available')({ sessionId, asset: createAsset('asset-retry') });

    assert.equal(typeof queuedAudit, 'function');
    assert.throws(() => queuedAudit(), /audit-write-failed/);
});

test('a never-settling audit task cannot delay forwarding a file request', () => {
    const sessionId = 'session-request';
    const providerId = 'provider-one';
    const receiverId = 'receiver-one';
    const asset = createAsset();
    const record = createAssetRecord(asset, providerId);
    const session = {
        devices: new Map([[providerId, {}], [receiverId, {}]]),
        fileAssets: new Map([[asset.id, record]])
    };
    const order = [];
    const neverSettles = new Promise(() => {});
    const providerEvents = [];
    const socket = createSocket();
    const handlers = registerHarness({
        socket,
        sessionId,
        session,
        currentDeviceId: receiverId,
        deviceSockets: new Map([[providerId, {
            emit(event, payload) {
                order.push('forward');
                providerEvents.push({ event, payload });
            }
        }]]),
        enqueueAudit(task) {
            order.push('enqueue');
            task();
        },
        recordTransferEvent() {
            order.push('audit-start');
            return neverSettles;
        }
    });

    handlers.get('file-asset-request')({
        sessionId,
        assetId: asset.id,
        preferredProviderId: providerId,
        requestId: 'request-one'
    });

    assert.deepEqual(order, ['forward', 'enqueue', 'audit-start']);
    assert.equal(providerEvents.length, 1);
    assert.equal(providerEvents[0].event, 'file-asset-request');
    assert.equal(providerEvents[0].payload.requestId, 'request-one');
});

test('started transfer status is forwarded without being persisted as a failed audit event', () => {
    const sessionId = 'session-status';
    const providerId = 'provider-one';
    const receiverId = 'receiver-one';
    const asset = createAsset();
    const record = createAssetRecord(asset, providerId);
    const assignmentKey = `${asset.id}:${receiverId}:full`;
    record.assignments.set(assignmentKey, providerId);
    record.providerLoads.set(providerId, 1);
    record.assignmentMeta.set(assignmentKey, {
        providerId,
        requestId: 'request-status',
        assignedAt: Date.now(),
        updatedAt: Date.now(),
        status: 'assigned'
    });
    const session = {
        devices: new Map([[providerId, {}], [receiverId, {}]]),
        fileAssets: new Map([[asset.id, record]])
    };
    const receiverEvents = [];
    const auditEvents = [];
    const socket = createSocket();
    const handlers = registerHarness({
        socket,
        sessionId,
        session,
        currentDeviceId: providerId,
        deviceSockets: new Map([[receiverId, {
            emit(event, payload) {
                receiverEvents.push({ event, payload });
            }
        }]]),
        enqueueAudit(task) {
            task();
        },
        recordTransferEvent(_sessionId, eventType) {
            auditEvents.push(eventType);
        }
    });

    handlers.get('file-asset-transfer-status')({
        sessionId,
        assetId: asset.id,
        to: receiverId,
        status: 'started',
        requestId: 'request-status'
    });

    assert.equal(receiverEvents.length, 1);
    assert.equal(receiverEvents[0].event, 'file-asset-transfer-status');
    assert.equal(receiverEvents[0].payload.status, 'started');
    assert.deepEqual(auditEvents, []);

    handlers.get('file-asset-transfer-status')({
        sessionId,
        assetId: asset.id,
        to: receiverId,
        status: 'completed',
        requestId: 'request-status'
    });

    assert.deepEqual(auditEvents, ['client-completed']);
    assert.equal(auditEvents.includes('failed'), false);
});
