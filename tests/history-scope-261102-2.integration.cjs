'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const vm = require('node:vm');
const { once } = require('node:events');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');

const serverSource = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const appSource = fs.readFileSync(require.resolve('../app.js'), 'utf8');
function section(source, start, end) {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, 'production function boundaries exist');
    return source.slice(from, to);
}

function historyClient(socket, sessionId, stored) {
    const received = [], rendered = [], writes = [], recovery = [], emitted = [], deleted = [], errors = [];
    const state = { sessionId, deviceId: 'shared-device', socket: {
        get connected() { return socket.connected; },
        emit(event, payload) { emitted.push({ event, payload }); socket.emit(event, payload); }
    } };
    const context = vm.createContext({
        state, console: { error: (...args) => errors.push(args) }, historyLog() {},
        compareHistoryMessages: (a, b) => a.timestamp - b.timestamp,
        summarizeHistoryMessage: message => message,
        getFromStore: async (_store, id) => stored.has(id) ? structuredClone(stored.get(id)) : null,
        saveToStore: async (_store, message) => {
            writes.push(structuredClone(message)); stored.set(message.id, structuredClone(message));
        },
        deleteHistoryMessageLocal: async id => { deleted.push(id); stored.delete(id); },
        getMessageElement: id => rendered.find(message => message.id === id),
        isAuthoritativeHistoryMessageChanged: () => false,
        applyHistoryMessageUpdate: async message => rendered.push(structuredClone(message)),
        addMessageToChat: async message => rendered.push(structuredClone(message)),
        storeInlineFileData: async () => {}, reorderRenderedMessages() {},
        getCurrentSessionMessages: async () => [...stored.values()].filter(message => message.sessionId === state.sessionId),
        reconcileLocalHistory: async () => {}, pruneLocalHistoryToCanonicalSnapshot: async () => {},
        enqueueHistoryAssetRecovery: messages => recovery.push(...structuredClone(messages))
    });
    vm.runInContext(section(appSource, 'async function handleSessionHistory(', 'async function getCurrentSessionMessages('), context);
    let pending = Promise.resolve();
    socket.on('session-history', payload => {
        received.push(payload);
        pending = pending.then(() => context.handleSessionHistory(payload)).catch(error => errors.push(error));
    });
    // A fence follows history packets on the same real Socket.IO connection.
    // Its acknowledgement waits for the asynchronous client handler as well.
    socket.on('fixture-fence', callback => pending.then(() => callback({ ok: true })));
    return { state, received, rendered, writes, recovery, emitted, deleted, errors };
}

async function fixture(t) {
    const webServer = http.createServer((_request, response) => response.writeHead(404).end());
    const io = new Server(webServer, { serveClient: false, transports: ['websocket'] });
    const sessions = new Map(), deviceSockets = new Map(), timers = new Map(), clients = [], completed = new Map();
    const stored = new Map();
    const runtime = vm.createContext({
        io, sessions, deviceSockets, sessionHistoryBroadcastTimers: timers,
        setTimeout, clearTimeout, setImmediate, deliverPendingDeviceNotifications() {},
        isValidSessionId: id => typeof id === 'string' && id.startsWith('tunnel-'),
        canUseTunnelCapability: () => true,
        historyLog(event, details) {
            if (event === 'snapshot-broadcast') { completed.get(details.sessionId)?.(); completed.delete(details.sessionId); }
        }
    });
    vm.runInContext(
        section(serverSource, 'function bindSocketToDevice(', 'function getDeviceSockets(') +
        section(serverSource, 'function emitToReadableSessionDevices(', 'const snsPostPublisher ='), runtime);

    io.on('connection', socket => {
        const { sessionId, deviceId } = socket.handshake.auth;
        const session = sessions.get(sessionId);
        assert.ok(session, 'only synthetic fixture sessions can be joined');
        session.devices.set(deviceId, { deviceId, socketId: socket.id, clientType: 'browser' });
        runtime.bindSocketToDevice(socket, deviceId);
        socket.join(sessionId);
        socket.on('fixture-ready', callback => callback({ socketId: socket.id }));
        // Deliberately retain membership on disconnect to exercise stale records:
        // delivery must never substitute the same device's socket in another tunnel.
    });
    t.after(async () => {
        for (const timer of timers.values()) clearTimeout(timer);
        clients.forEach(socket => socket.disconnect());
        await new Promise(resolve => io.close(resolve));
        if (webServer.listening) await new Promise(resolve => webServer.close(resolve));
    });
    webServer.listen(0, '127.0.0.1');
    await once(webServer, 'listening');
    const origin = 'http://127.0.0.1:' + webServer.address().port;

    async function addClient(sessionId) {
        const socket = connect(origin, { transports: ['websocket'], reconnection: false,
            forceNew: true, autoConnect: false, auth: { sessionId, deviceId: 'shared-device' } });
        clients.push(socket);
        const client = historyClient(socket, sessionId, stored);
        const connected = once(socket, 'connect');
        socket.connect(); await connected;
        const ready = await socket.timeout(3000).emitWithAck('fixture-ready');
        return { socket, serverSocket: io.sockets.sockets.get(ready.socketId), ...client };
    }
    async function fence(client) {
        if (client.socket.connected) await client.serverSocket.timeout(3000).emitWithAck('fixture-fence');
        assert.equal(client.errors.length, 0, 'the real history handler completes without fixture or application errors');
    }
    async function broadcast(sessionId, ...targets) {
        const finished = new Promise(resolve => completed.set(sessionId, resolve));
        runtime.scheduleSessionHistoryBroadcast(sessionId, 'integration-delayed-history', 15);
        await finished;
        await Promise.all(targets.map(fence));
    }
    return { sessions, deviceSockets, stored, addClient, broadcast, fence };
}

test('real Socket.IO keeps delayed A history out of empty B for the same device identity', { timeout: 15000 }, async t => {
    const f = await fixture(t);
    const messages = Array.from({ length: 65 }, (_, index) => ({
        id: 'A-' + index, sessionId: 'tunnel-A', timestamp: index, type: 'file',
        fileInfo: { id: 'A-file-' + index, isAsset: true }
    }));
    messages.forEach(message => f.stored.set(message.id, structuredClone(message)));
    f.sessions.set('tunnel-A', { devices: new Map(), history: messages.map(message => ({ message })), deletedMessageIds: [] });
    f.sessions.set('tunnel-B', { devices: new Map(), history: [], deletedMessageIds: [] });
    const a = await f.addClient('tunnel-A');
    const b = await f.addClient('tunnel-B');
    assert.equal(f.deviceSockets.get('shared-device').id, b.serverSocket.id, 'B owns the latest global device binding');
    assert.equal(f.sessions.get('tunnel-A').devices.get('shared-device').socketId, a.serverSocket.id);

    await t.test('old A delayed broadcast reaches A only and leaves B UI, cache and recovery empty', async () => {
        await f.broadcast('tunnel-A', a, b);
        assert.equal(a.received.length, 1);
        assert.equal(a.received[0].sessionId, 'tunnel-A', 'history envelopes carry their originating tunnel');
        assert.equal(a.rendered.length, 65);
        assert.equal(a.recovery.length, 65);
        assert.equal(b.received.length, 0, 'the server must not route A data to B');
        assert.equal(b.rendered.length + b.writes.length + b.recovery.length + b.emitted.length, 0);
        assert.equal([...f.stored.values()].filter(message => message.sessionId === 'tunnel-B').length, 0);
    });

    await t.test('disconnected A with stale session membership never falls back to B', async () => {
        const disconnected = once(a.serverSocket, 'disconnect');
        a.socket.disconnect(); await disconnected;
        assert.ok(f.sessions.get('tunnel-A').devices.has('shared-device'), 'retain the stale member intentionally');
        await f.broadcast('tunnel-A', b);
        assert.equal(b.received.length, 0);
        assert.equal(b.rendered.length + b.writes.length + b.recovery.length + b.emitted.length, 0);
    });

    await t.test('the actual client handler rejects a late foreign envelope before deletion or acknowledgement', async () => {
        b.serverSocket.emit('session-history', { sessionId: 'tunnel-A', messages,
            deletedMessageIds: ['B-protected'], authoritative: true });
        await f.fence(b);
        assert.equal(b.received.length, 1, 'the fixture actually delivers the late packet over Socket.IO');
        assert.equal(b.rendered.length + b.writes.length + b.recovery.length + b.emitted.length + b.deleted.length, 0);
    });

    await t.test('legacy unscoped A records already in shared storage cannot render or recover in B', async () => {
        b.serverSocket.emit('session-history', { messages: messages.map(({ sessionId, ...message }) => message) });
        await f.fence(b);
        assert.equal(b.received.length, 2);
        assert.equal(b.rendered.length + b.writes.length + b.recovery.length, 0);
        assert.ok([...f.stored.values()].every(message => message.sessionId === 'tunnel-A'));
    });

    await t.test('B still receives, stores, renders and schedules recovery for its own history', async () => {
        const message = { id: 'B-own', sessionId: 'tunnel-B', timestamp: 100, type: 'file',
            fileInfo: { id: 'B-file', isAsset: true } };
        f.sessions.get('tunnel-B').history.push({ message });
        await f.broadcast('tunnel-B', b);
        assert.equal(b.received.at(-1).sessionId, 'tunnel-B');
        assert.deepEqual(b.rendered.map(item => item.id), ['B-own']);
        assert.deepEqual(b.writes.map(item => item.sessionId), ['tunnel-B']);
        assert.deepEqual(b.recovery.map(item => item.id), ['B-own']);
        assert.equal(f.stored.get('B-own').sessionId, 'tunnel-B');
        assert.equal(b.emitted.at(-1).payload.sessionId, 'tunnel-B');
    });
});
