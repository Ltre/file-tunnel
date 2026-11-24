'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), crypto = require('node:crypto');
const { spawn } = require('node:child_process'), { io } = require('socket.io-client');
const { createInfraStore } = require('../server/infra-store');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskAccountSessions } = require('../server/disk-account-sessions');
const { openDiskRepository } = require('../server/disk-repository');
const { CUTOFF } = require('../server/web-zip-legacy');
const uuid = () => crypto.randomUUID(), hash = value => crypto.createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function once(socket, event, predicate = () => true) {
    return new Promise((resolve, reject) => {
        const listener = value => { if (!predicate(value)) return; clearTimeout(timer); socket.off(event, listener); resolve(value); };
        const timer = setTimeout(() => { socket.off(event, listener); reject(Error('TIMEOUT ' + event)); }, 7000);
        socket.on(event, listener);
    });
}

test('真实服务器冻结历史 ZIP：截止日、持久清单、摘要校验、后续签章发布和转发保持独立安全边界', { timeout: 60000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webzip-legacy-261123-')), sockets = [];
    let child, output = '';
    async function stop() {
        for (const socket of sockets.splice(0)) socket.close();
        if (child && child.exitCode === null && child.signalCode === null) {
            const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited;
        }
    }
    t.after(async () => {
        await stop(); openDiskRepository(dir).close();
        const target = path.resolve(dir);
        assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('webzip-legacy-261123-'));
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const sessionId = uuid(), deviceId = uuid(), shortCode = 'ABC23', content = Buffer.from('historical ZIP bytes 原始内容');
    function record(timestamp, extra = {}) {
        return { id: uuid(), sender: deviceId, type: 'file', timestamp, fileInfo: { id: uuid(), name: 'historical.html.zip', type: 'application/zip', size: content.length, webZip: true, isAsset: true, creatorDeviceId: deviceId, timestamp, ...extra } };
    }
    const known = record(CUTOFF - 1, { webZipSha256: hash(content) }), unknown = record(CUTOFF - 1000);
    const after = record(CUTOFF), contradictory = record(CUTOFF + 1, { webZipUpdatedAt: CUTOFF - 1000 });
    const infra = await createInfraStore({ dataDir: dir });
    infra.reserveShortCode(shortCode, sessionId); infra.setTunnelAccess(sessionId, deviceId);
    for (const message of [known, unknown, after, contradictory]) infra.recordHistoryMessage(sessionId, message);
    infra.close();
    // Seed a permitted test account using the existing storage/session adapter;
    // no user credentials or database from the workspace are read or modified.
    const auth = createDiskAuth({ dataDir: dir }), user = auth.fromTelegram({ id: '999000601' }, 'mock');
    auth.setPermissions(user.id, { 'webZip.publishEdit': true });
    const sessionKey = crypto.createHmac('sha256', auth.sessionKey).update('telegram-drive-mock-session').digest();
    const sessions = createDiskAccountSessions({ keyForRequest: () => sessionKey, user: id => auth.user(id) }), cookies = [];
    sessions.set({ headers: {} }, { append(_name, value) { cookies.push(value.split(';')[0]); } }, user);
    const userCookie = cookies.join('; '); openDiskRepository(dir).close();
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const root = 'http://127.0.0.1:' + port;
    async function start() {
        output = '';
        child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), TUNNEL_DATA_DIR: dir, TELEGRAM_OIDC_MOCK_ENABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { output = (output + value).slice(-5000); });
        let ready = false;
        for (let attempt = 0; attempt < 200; attempt++) {
            if (child.exitCode !== null) break;
            try { if ((await fetch(root + '/api/admin/auth/status')).ok) { ready = true; break; } } catch (_) {}
            await pause(40);
        }
        assert.ok(ready, output || 'isolated server failed to start');
    }
    async function post(route, data, headers = {}) {
        return fetch(root + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
    }
    const trust = message => ({ sessionId, messageId: message.id, fileId: message.fileInfo.id });
    async function verify(data) {
        const response = await post('/api/telegram/web-zip/verify', data);
        return { status: response.status, body: await response.json() };
    }
    await start();
    const inventoryFile = path.join(dir, '.web-zip-legacy-261122.json'), frozen = fs.readFileSync(inventoryFile, 'utf8');
    assert.equal(JSON.parse(frozen).entries.length, 2);
    assert.deepEqual(await verify(trust(known)), { status: 200, body: { ok: true, legacy: true, sha256: hash(content) } });
    assert.deepEqual(await verify(trust(unknown)), { status: 200, body: { ok: true, legacy: true, sha256: '' } });
    for (const data of [trust(after), trust(contradictory), { ...trust(known), sha256: '0'.repeat(64) },
        { ...trust(known), sessionId: uuid() }, { ...trust(known), messageId: unknown.id }, { ...trust(known), fileId: uuid() },
        { sessionId, messageId: uuid(), fileId: uuid(), legacy: true }]) assert.equal((await verify(data)).status, 403, JSON.stringify(data));

    async function device(id, targetSession, code = '', createTunnel = false) {
        const socket = io(root, { transports: ['websocket'], reconnection: false }); sockets.push(socket);
        await once(socket, 'connect');
        const grantPromise = once(socket, 'tunnel-access-grant'), codePromise = once(socket, 'session-short-code');
        socket.emit('join-session', { sessionId: targetSession, deviceId: id, deviceName: 'Legacy ZIP test', shortCode: code, createTunnel });
        const grant = (await grantPromise).grant; await codePromise; await pause(50);
        return { socket, id, sessionId: targetSession, grant, emit: (event, data) => new Promise((resolve, reject) => socket.timeout(7000).emit(event, data, (error, value) => error ? reject(error) : resolve(value))) };
    }
    const author = await device(deviceId, sessionId, shortCode);
    const proofResponse = await post('/api/telegram/web-zip/socket-auth', { sessionId, deviceId, socketId: author.socket.id, accessGrant: author.grant }, { Cookie: userCookie });
    assert.equal(proofResponse.status, 200); assert.equal((await author.emit('web-zip-auth', { proof: (await proofResponse.json()).proof })).ok, true);
    const backdated = record(1); backdated.sender = deviceId;
    const denial = once(author.socket, 'permission-denied');
    author.socket.emit('message', { sessionId, message: backdated }); assert.ok((await denial).capability);
    assert.equal((await verify(trust(backdated))).status, 403, '上线后不能仅回填旧时间新增豁免记录');
    const reconciled = once(author.socket, 'session-history');
    author.socket.emit('history-reconcile', { sessionId, messages: [backdated] });
    assert.equal((await reconciled).messages.some(message => message.id === backdated.id), false);

    const newFile = { ...known.fileInfo, id: uuid(), name: 'republished.html.zip', timestamp: Date.now(), webZipUpdatedAt: Date.now(), webZipSha256: hash('updated ZIP bytes') };
    delete newFile.webZipTrustIntegrityStamp;
    author.socket.emit('file-asset-available', { sessionId, asset: newFile });
    // Ordering on one Socket ensures the provider announcement precedes publish.
    const unsigned = await author.emit('web-zip-publish', { sessionId, messageId: known.id, fileId: known.fileInfo.id, fileInfo: newFile });
    assert.equal(unsigned.ok, false); assert.match(unsigned.error, /WEB_ZIP_/);
    const signed = await author.emit('web-zip-stamp', { sessionId, messageId: known.id, fileId: newFile.id, sha256: newFile.webZipSha256 });
    assert.equal(signed.ok, true); newFile.webZipTrustIntegrityStamp = signed.stamp;
    const publication = await author.emit('web-zip-publish', { sessionId, messageId: known.id, fileId: known.fileInfo.id, fileInfo: newFile });
    assert.equal(publication.ok, true, JSON.stringify(publication));
    const published = await verify({ sessionId, messageId: known.id, fileId: newFile.id, sha256: newFile.webZipSha256, stamp: signed.stamp });
    assert.equal(published.status, 200); assert.equal(published.body.legacy, undefined, '重新发布内容必须按新签章验证');
    assert.equal((await verify(trust(known))).status, 403, '被替换的历史内容不能继续借用清单');

    const targetSession = uuid(), target = await device(uuid(), targetSession, '', true);
    const clone = { ...unknown.fileInfo, id: uuid(), sourceFileId: unknown.fileInfo.id, webZipSha256: hash(content), timestamp: Date.now() };
    author.socket.emit('file-asset-available', { sessionId, asset: clone });
    const forwardedMessage = { id: uuid(), sender: deviceId, type: 'file', timestamp: Date.now(), fileInfo: clone, forwardedFrom: { sessionId, messageId: unknown.id } };
    const forwarded = await author.emit('forward-message', { message: forwardedMessage, targetSessionId: targetSession, targetDeviceId: target.id, targetAccessGrant: target.grant, fileSource: 'disk-cache' });
    assert.equal(forwarded.ok, true, JSON.stringify(forwarded)); assert.match(forwarded.message.fileInfo.webZipTrustIntegrityStamp, /^wzt1\./);
    const targetTrust = { sessionId: targetSession, messageId: forwarded.message.id, fileId: clone.id, sha256: clone.webZipSha256, stamp: forwarded.message.fileInfo.webZipTrustIntegrityStamp };
    const targetVerification = await verify(targetTrust); assert.equal(targetVerification.status, 200); assert.equal(targetVerification.body.legacy, undefined, '目标副本获得自己的新签章');
    assert.equal((await verify({ ...targetTrust, sessionId })).status, 403, '目标签章不能回用到来源隧道');
    assert.equal(fs.readFileSync(inventoryFile, 'utf8'), frozen, '正常发布及转发都不扩充历史清单');
    await stop();

    // Simulate a record restored from a backup after the first rollout while the
    // server is stopped. Persisted backdating must not expand the saved cutoff.
    const later = record(1), offline = await createInfraStore({ dataDir: dir });
    offline.recordHistoryMessage(sessionId, later); offline.close();
    await start();
    assert.equal(fs.readFileSync(inventoryFile, 'utf8'), frozen, '服务重启沿用原清单，不重新按浏览器日期收录');
    assert.equal((await verify(trust(later))).status, 403);
    assert.equal((await verify(trust(unknown))).status, 200, '未重新发布的历史档仍可用');
    assert.equal((await verify(targetTrust)).status, 200, '新目标签章在重启后仍可验证');
});
