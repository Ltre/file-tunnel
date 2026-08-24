const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Server } = require('socket.io');
const { createPushPayload, parseArguments, pushToVClient } = require('../scripts/vclient-push');

test('VClient shell push accepts a tunnel, repeated files, collection metadata and a remark', () => {
    const options = parseArguments([
        '--tunnel', 'A1B2C', '--file', 'one.m4a', '--file', 'two.jpg',
        '--name', '测试合辑', '--remark', '服务器审核备注', '--timeout', '60'
    ]);
    assert.deepEqual(options.files, ['one.m4a', 'two.jpg']);
    assert.equal(options.name, '测试合辑');
    assert.equal(options.remark, '服务器审核备注');
    const payload = createPushPayload([
        { path: 'one.m4a', name: 'one.m4a', size: 123 },
        { path: 'two.jpg', name: 'two.jpg', size: 456 }
    ], options, '11111111-1111-4111-8111-111111111111', 1000);
    assert.equal(payload.message.type, 'collection');
    assert.equal(payload.message.collection.name, '测试合辑');
    assert.equal(payload.message.collection.count, 2);
    assert.equal(payload.message.collection.totalSize, 579);
    assert.equal(payload.message.collection.remark, '服务器审核备注');
    assert.equal(payload.assets[0].type, 'audio/mp4');
    assert.equal(payload.assets[1].type, 'image/jpeg');
});

test('VClient shell push server grants only authenticated server-shell clients privileged send access', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /trustedInternalClient && requestedInternalType === 'server-shell'/);
    assert.match(server, /clientType === 'server-shell'\) return true/);
    assert.match(server, /SERVER_SHELL_VCLIENT_TUNNEL_NOT_READY/);
    assert.match(server, /data\.clientType === 'server-shell' \? 'server-shell' : 'browser'/);
});

test('VClient shell push streams bytes and waits for the cache-node completion acknowledgement', async () => {
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vclient-push-test-'));
    const sourcePath = path.join(temporaryDirectory, 'payload.txt');
    const expected = Buffer.from('shell-to-vclient-protocol-smoke-test');
    await fs.promises.writeFile(sourcePath, expected);
    const httpServer = http.createServer();
    const io = new Server(httpServer);
    const vclientDeviceId = '22222222-2222-4222-8222-222222222222';
    const received = [];
    let announcedAsset = null;
    let message = null;
    io.on('connection', socket => {
        socket.on('join-by-short-code', () => socket.emit('short-code-session', { sessionId: 'shelltest1' }));
        socket.on('join-session', () => socket.emit('session-devices', {
            devices: [{ deviceId: vclientDeviceId, clientType: 'vclient' }]
        }));
        socket.on('file-asset-available', data => { announcedAsset = data.asset; });
        socket.on('message', data => {
            message = data.message;
            socket.emit('message-ack', { messageId: message.id, stored: true });
            setImmediate(() => socket.emit('file-asset-request', {
                asset: announcedAsset,
                from: vclientDeviceId,
                requestId: 'mock-request'
            }));
        });
        socket.on('file-asset-relay-start', (_, ack) => ack({ ok: true }));
        socket.on('file-asset-relay-chunk', (data, ack) => {
            received.push(Buffer.from(data.chunk));
            ack({ ok: true });
        });
        socket.on('file-asset-relay-complete', (_, ack) => ack({ ok: true }));
    });
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    try {
        const options = parseArguments([
            '--tunnel', 'A1B2C', '--file', sourcePath,
            '--server', `http://127.0.0.1:${httpServer.address().port}`, '--timeout', '10'
        ]);
        const result = await pushToVClient(options, { VCLIENT_TOKEN: 'test-control-token' });
        assert.equal(result.sessionId, 'shelltest1');
        assert.equal(message.type, 'file');
        assert.deepEqual(Buffer.concat(received), expected);
    } finally {
        await io.close();
        await new Promise(resolve => httpServer.close(resolve));
        await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
    }
});
