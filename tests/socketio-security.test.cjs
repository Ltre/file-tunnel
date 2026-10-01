'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');

async function socketServer(t) {
    const httpServer = http.createServer();
    const io = new Server(httpServer, { serveClient: false });
    io.on('connection', socket => socket.on('echo', (data, reply) => reply(data)));
    t.after(() => new Promise(resolve => io.close(resolve)));
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    return { io, port: httpServer.address().port };
}

function request(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path, headers, agent: false }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('upgrade', (res, socket) => {
            socket.destroy();
            resolve({ status: res.statusCode });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('Socket.IO test request timed out')));
    });
}

for (const protocol of ['3', null]) {
    test(`reject a WebSocket upgrade with ${protocol === null ? 'missing' : 'mismatched'} EIO`, { timeout: 10000 }, async t => {
        const { io, port } = await socketServer(t);
        const handshake = await request(port, '/socket.io/?EIO=4&transport=polling');
        assert.equal(handshake.status, 200);
        assert.equal(handshake.body[0], '0');
        const { sid } = JSON.parse(handshake.body.slice(1));
        const query = new URLSearchParams({ transport: 'websocket', sid });
        if (protocol !== null) query.set('EIO', protocol);
        const rejected = await request(port, `/socket.io/?${query}`, {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
            'Sec-WebSocket-Version': '13'
        });
        assert.equal(rejected.status, 400);
        assert.equal(io.engine.clients[sid].protocol, 4);
        assert.equal(io.engine.clients[sid].transport.name, 'polling');
        assert.equal((await request(port, '/socket.io/?EIO=4&transport=polling')).status, 200);
    });
}

for (const transports of [['polling'], ['websocket'], ['polling', 'websocket']]) {
    test(`normal ${transports.join(' → ')} connections retain text and binary acknowledgements`, { timeout: 10000 }, async t => {
        const { port } = await socketServer(t);
        const client = connect(`http://127.0.0.1:${port}`, {
            autoConnect: false, forceNew: true, reconnection: false, transports, timeout: 3000
        });
        t.after(() => client.disconnect());
        const connected = new Promise((resolve, reject) => {
            client.once('connect', resolve);
            client.once('connect_error', reject);
        });
        client.connect();
        const upgraded = transports.length > 1
            ? new Promise(resolve => client.io.engine.once('upgrade', resolve))
            : null;
        await connected;
        if (upgraded) await upgraded;
        assert.equal(client.io.engine.transport.name, transports.at(-1));
        const text = { message: '安全补丁连接回归', id: 'test-resource' };
        assert.deepEqual(await client.timeout(3000).emitWithAck('echo', text), text);
        const bytes = Buffer.from([0, 1, 127, 128, 255]);
        assert.deepEqual(await client.timeout(3000).emitWithAck('echo', bytes), bytes);
    });
}
