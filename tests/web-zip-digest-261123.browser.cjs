'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const express = require('express');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const { listenHttp } = require('./support/listen-http.cjs');
const { createWebZipTrustIntegrityStamp } = require('../server/web-zip-trust-integrity-stamp');
const { createWebZipLegacy } = require('../server/web-zip-legacy');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t) {
    const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webzip-http-261123-'));
    let server, browser, workerRequests = 0;
    t.after(async () => {
        await browser?.close();
        if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(dir).startsWith('webzip-http-261123-'));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const sessionId = 'fixture-session', content = Buffer.from('历史网页 ZIP：中文与 emoji 🌐');
    const known = { id: 'old-known', name: 'known.html.zip', size: content.length, timestamp: Date.parse('2026-11-22T18:00:00+08:00'), creatorDeviceId: 'creator', webZipSha256: sha256(content) };
    const unknown = { id: 'old-no-hash', name: 'old.html.zip', size: content.length, timestamp: known.timestamp, creatorDeviceId: 'creator' };
    const records = new Map([
        ['known-record', { id: 'known-record', type: 'file', fileInfo: known }],
        ['unknown-record', { id: 'unknown-record', type: 'file', fileInfo: unknown }]
    ]);
    const inventory = createWebZipLegacy({ filename: path.join(dir, 'legacy.json') });
    inventory.initialize({ query(_sql, [offset]) { return [...records.values()].slice(offset, offset + 1000).map(message => ({ session_id: sessionId, message_id: message.id, payload_json: JSON.stringify(message) })); } });
    // Key material and the account fixture exist only in this temporary folder.
    const stamp = createWebZipTrustIntegrityStamp({ dataDir: dir, user: id => id === 'publisher' ? { id, permissionVersion: 1 } : null, hasPermission: id => id === 'publisher' });
    const verificationRequests = [], signingRequests = [];
    const app = express(); app.use(express.json());
    app.get('/client/disk-content-hash-worker.js', (_req, res) => { workerRequests++; res.sendFile(path.join(root, 'client/disk-content-hash-worker.js')); });
    app.use('/client', express.static(path.join(root, 'client')));
    app.get('/fixture', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><script src="/client/web-zip-runtime.js"></script>'));
    app.post('/fixture/sign', (req, res) => {
        signingRequests.push(req.body);
        const scope = { fileId: 'new-file', messageId: 'new-record', sessionId, accountId: 'publisher', sha256: req.body.sha256 };
        const token = stamp.issue(scope);
        records.set(scope.messageId, { id: scope.messageId, type: 'file', fileInfo: { id: scope.fileId, name: 'new.html.zip', timestamp: Date.now(), webZipSha256: scope.sha256, webZipTrustIntegrityStamp: token } });
        res.json({ ...scope, stamp: token });
    });
    app.post('/api/telegram/web-zip/verify', (req, res) => {
        const trust = req.body; verificationRequests.push(trust);
        const candidate = trust.sessionId === sessionId ? records.get(trust.messageId)?.fileInfo : null;
        const file = candidate?.id === trust.fileId ? candidate : null;
        if (file && inventory.allows(file, trust.messageId, trust.sessionId)) return res.json({ ok: true, legacy: true, sha256: file.webZipSha256 || '' });
        const valid = file && file.id === trust.fileId && file.webZipSha256 === trust.sha256 && file.webZipTrustIntegrityStamp === trust.stamp &&
            stamp.verify(trust.stamp, { ...trust, accountId: stamp.accountId(trust.stamp) });
        return valid ? res.json({ ok: true }) : res.status(403).json({ ok: false });
    });
    server = await listenHttp(app);
    // No insecure-origin override, fake secure context, or browser profile from
    // the user: the HTTP hostname remains genuinely non-trustworthy to Chrome.
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP lan.test 127.0.0.1'] });
    const context = await browser.newContext({ locale: 'zh-CN' }), page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://lan.test:' + server.address().port + '/fixture');
    assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, subtle: typeof crypto.subtle })), { secure: false, subtle: 'undefined' });
    return { page, errors, content, sessionId, records, verificationRequests, signingRequests, workerRequests: () => workerRequests };
}

test('非安全 HTTP Chrome：WebCrypto 真不可用时，真实 Worker 对空、中文和多块二进制计算准确 SHA-256，并可签章验证', { timeout: 40000 }, async t => {
    const f = await fixture(t);
    const binary = Buffer.alloc(3 * 1048576 + 173);
    for (let index = 0; index < binary.length; index++) binary[index] = index * 31 % 256;
    const samples = [Buffer.alloc(0), Buffer.from('s10p创建：简体中文、繁體、🌐\u0000'), Buffer.from([0, 1, 2, 255, 128, 0]), binary];
    for (const data of samples) {
        const actual = await f.page.evaluate(async base64 => {
            const bytes = Uint8Array.from(atob(base64), value => value.charCodeAt(0));
            return WebZipRuntime.digestArchive(new Blob([bytes]));
        }, data.toString('base64'));
        assert.equal(actual, sha256(data), '真实 Worker 摘要应与 Node 独立计算一致');
    }
    assert.equal(f.workerRequests(), samples.length, '每次均实际加载现有增量摘要 Worker');
    const result = await f.page.evaluate(async () => {
        const blob = new Blob(['s10p创建.html.zip publication']);
        const sha256 = await WebZipRuntime.digestArchive(blob);
        const response = await fetch('/fixture/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha256 }) });
        const trust = await response.json();
        return { verified: await WebZipRuntime.verifyArchive(blob, trust), trust };
    });
    assert.equal(result.verified, true); assert.match(result.trust.stamp, /^wzt1\./);
    assert.deepEqual(Object.keys(f.signingRequests[0]), ['sha256'], '签章只提交摘要，未上传 ZIP 字节');
    assert.equal(f.verificationRequests.at(-1).sha256, result.trust.sha256);
    assert.deepEqual(f.errors, []);
});

test('非安全 HTTP Chrome：无戳旧档必须由服务端明确放行，拒绝伪造 legacy、错误作用域及已知摘要篡改', { timeout: 40000 }, async t => {
    const f = await fixture(t);
    async function verify(trust, data = f.content) {
        return f.page.evaluate(async ({ trust, base64 }) => {
            const blob = new Blob([Uint8Array.from(atob(base64), value => value.charCodeAt(0))]);
            try { return { ok: await WebZipRuntime.verifyArchive(blob, trust), trust }; }
            catch (error) { return { ok: false, error: error.message, trust }; }
        }, { trust, base64: data.toString('base64') });
    }
    const known = { fileId: 'old-known', messageId: 'known-record', sessionId: f.sessionId };
    const accepted = await verify(known);
    assert.equal(accepted.ok, true); assert.equal(accepted.trust.legacy, true); assert.equal(accepted.trust.sha256, sha256(f.content));
    const noHash = await verify({ fileId: 'old-no-hash', messageId: 'unknown-record', sessionId: f.sessionId });
    assert.equal(noHash.ok, true); assert.equal(noHash.trust.legacy, true);
    assert.equal(f.verificationRequests.at(-1).legacy, undefined, '兼容标记由响应建立，不能自行断言放行');
    const tampered = Buffer.from(f.content); tampered[0] ^= 1;
    const changed = await verify({ ...known, legacy: true }, tampered);
    assert.equal(changed.ok, false); assert.match(changed.error, /摘要不匹配/);
    const fakeNew = { id: 'new-unsigned', name: 'new.html.zip', size: f.content.length, timestamp: 1, creatorDeviceId: 'creator' };
    f.records.set('new-unsigned-record', { id: 'new-unsigned-record', type: 'file', fileInfo: fakeNew });
    const forged = await verify({ fileId: fakeNew.id, messageId: 'new-unsigned-record', sessionId: f.sessionId, legacy: true });
    assert.equal(forged.ok, false); assert.match(forged.error, /签名无效/);
    assert.equal((await verify({ ...known, sessionId: 'other-session', legacy: true })).ok, false);
    assert.equal((await verify({ ...known, messageId: 'unknown-record', legacy: true })).ok, false);
    assert.deepEqual(f.errors, []);
});
