'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const express = require('express');
const { createS3Credentials, validBucket } = require('../server/s3/credentials');
const { registerS3Admin } = require('../server/s3/admin');
const { renderMarkdown } = require('../server/s3/guide');
const { openDiskRepository } = require('../server/disk-repository');
const { canonicalUri, canonicalQuery, signingKey, sha256, verify } = require('../server/s3/sigv4');

function requestSigned(credential) {
    const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const scope = `${date.slice(0, 8)}/us-east-1/s3/aws4_request`, url = '/S3API/backup?list-type=2';
    const hash = sha256(''), signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = ['GET', canonicalUri(url), canonicalQuery(url), `host:fixture.test\nx-amz-content-sha256:${hash}\nx-amz-date:${date}\n`, signedHeaders, hash].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
    const signature = crypto.createHmac('sha256', signingKey(credential.secretAccessKey, date.slice(0, 8), 'us-east-1')).update(toSign).digest('hex');
    return { method: 'GET', originalUrl: url, headers: { host: 'fixture.test', 'x-amz-date': date, 'x-amz-content-sha256': hash,
        authorization: `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } };
}

test('S3 凭据独立生成、JSON 加密、并发防覆盖、轮换及旧凭据停用兼容', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-admin-credentials-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const firstStore = createS3Credentials(dir), secondStore = createS3Credentials(dir);
    const fields = { userId: crypto.randomUUID(), remark: 'FolderSync 手机', bucketMappings: [{ bucket: 'backup', diskSpace: '' }] };
    const first = firstStore.create(fields), second = secondStore.create({ ...fields, remark: '另一个设备' });
    assert.notEqual(first.accessKeyId, second.accessKeyId);
    assert.notEqual(first.secretAccessKey, second.secretAccessKey);
    assert.equal(firstStore.list().length, 2, '两个存储实例每次修改从最新配置读取，不覆盖另一条凭据');
    const file = path.join(dir, 's3-credentials.json');
    assert.ok(!fs.readFileSync(file, 'utf8').includes(first.secretAccessKey));
    assert.ok(!JSON.stringify(firstStore.list()).includes('encryptedSecret'));
    assert.ok(!JSON.stringify(firstStore.list()).includes('secretAccessKey'));
    const changed = secondStore.update(first.accessKeyId, { remark: '新备注' }, { expectedUpdatedAt: first.updatedAt });
    assert.throws(() => firstStore.update(first.accessKeyId, { remark: '过期备注' }, { expectedUpdatedAt: first.updatedAt }), /S3_CREDENTIAL_CONFLICT/);
    assert.equal(firstStore.list()[0].remark, '新备注');
    const oldRequest = requestSigned(first);
    assert.equal(verify(oldRequest, firstStore).credential.accessKeyId, first.accessKeyId);
    const rotated = firstStore.rotate(first.accessKeyId, { expectedUpdatedAt: changed.updatedAt });
    assert.equal(rotated.accessKeyId, first.accessKeyId);
    assert.notEqual(rotated.secretAccessKey, first.secretAccessKey);
    assert.throws(() => verify(oldRequest, secondStore), /SignatureDoesNotMatch/);
    assert.equal(verify(requestSigned(rotated), secondStore).credential.accessKeyId, first.accessKeyId);
    assert.throws(() => secondStore.rotate(first.accessKeyId, { expectedUpdatedAt: changed.updatedAt }), /S3_CREDENTIAL_CONFLICT/);
    fs.writeFileSync(file + '.lock', 'fixture-lock');
    const locked = fs.readFileSync(file);
    assert.throws(() => firstStore.disable(first.accessKeyId), /S3_CREDENTIALS_BUSY/);
    assert.deepEqual(fs.readFileSync(file), locked);
    fs.unlinkSync(file + '.lock');
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
    legacy.credentials[0].bucketMappings[0].bucket = '127.0.0.1';
    fs.writeFileSync(file, JSON.stringify(legacy));
    assert.equal(secondStore.find(first.accessKeyId).secretAccessKey, rotated.secretAccessKey, '旧记录仍可按原网关行为读取');
    firstStore.disable(first.accessKeyId);
    assert.equal(secondStore.find(first.accessKeyId), null, '历史 Bucket 名称不妨碍立即停用');
    assert.equal(fs.existsSync(file + '.lock'), false);
    assert.throws(() => firstStore.create({ ...fields, bucketMappings: [{ bucket: '127.0.0.1', diskSpace: '' }] }), /S3_CREDENTIAL_INPUT_INVALID/);
    for (const bucket of ['xn--invalid', 'sthree-invalid', 'amzn-s3-demo-invalid', 'name-s3alias', 'name--ol-s3', 'name.mrap', 'name--x-s3', 'name--table-s3', 'name-an']) assert.equal(validBucket(bucket), false);
    assert.equal(validBucket('my.bucket-1'), true);
    assert.throws(() => firstStore.create({ ...fields, bucketMappings: [{ bucket: 'backup', diskSpace: '' }, { bucket: 'backup', diskSpace: 'photos' }] }), /S3_CREDENTIAL_INPUT_INVALID/);
});
test('用户分区 S3 凭据一对一生成，停用和轮换不创建重复 Bucket', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-user-space-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const credentials = createS3Credentials(dir), owner = crypto.randomUUID();
    const first = credentials.enableUserSpace(owner, '');
    assert.equal(first.bucketMappings[0].bucket, 'userbucket-' + owner);
    assert.ok(first.secretAccessKey);
    assert.equal(credentials.enableUserSpace(owner, '').accessKeyId, first.accessKeyId);
    const named = credentials.enableUserSpace(owner, '图片');
    assert.notEqual(named.bucketMappings[0].bucket, first.bucketMappings[0].bucket);
    assert.equal(credentials.list().length, 2);
    const rotated = credentials.rotateUserSpace(owner, '');
    assert.equal(rotated.accessKeyId, first.accessKeyId);
    assert.notEqual(rotated.secretAccessKey, first.secretAccessKey);
    assert.equal(credentials.disableUserSpace(owner, '').enabled, false);
    assert.equal(credentials.find(first.accessKeyId), null);
    assert.equal(credentials.enableUserSpace(owner, '').accessKeyId, first.accessKeyId);
    assert.equal(credentials.list().length, 2);
});

test('后台 S3 管理鉴权、同源检查、用户分区隔离、版本冲突和敏感字段不外泄', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-admin-api-'));
    const repository = openDiskRepository(dir), credentials = createS3Credentials(dir);
    const owner = crypto.randomUUID(), other = crypto.randomUUID(), backendId = crypto.randomUUID();
    repository.replace('users', [{ id: owner, name: '演示用户', passkeys: [{ publicKey: 'DO-NOT-EXPOSE-PASSKEY' }] }, { id: other, username: 'other' }], item => item.id);
    repository.replace('spaces', [{ name: 'photos' }, { name: 'foreign' }], item => item.name);
    repository.replace('space_usage', [{ appId: 'system', userId: owner, diskSpace: 'photos' }, { appId: 'system', userId: other, diskSpace: 'foreign' }], item => `${item.appId}:${item.userId}:${item.diskSpace}`);
    repository.replace('backends', [{ id: backendId, channelId: '-1001234567890', encryptedToken: 'DO-NOT-EXPOSE-BOT-TOKEN' }], item => item.id);
    const app = express(); app.use(express.json());
    registerS3Admin(app, { dataDir: dir, credentials, root: path.join(__dirname, '..'), requireAuth: (req, res, next) => req.get('x-test-admin') === 'allowed' ? next() : res.status(401).json({ error: 'LOGIN_REQUIRED' }) });
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); repository.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`, endpoint = '/api/admin/s3-credentials';
    const send = (url, method = 'GET', body, headers = {}) => fetch(base + url, { method, headers: { 'x-test-admin': 'allowed', 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { Origin: base }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const url of [endpoint, '/s3-management', '/s3-api-guide']) assert.equal((await fetch(base + url)).status, 401);
    assert.equal((await send('/s3-management')).status, 200);
    const fields = { userId: owner, remark: '<第三方备注>', bucketMappings: [{ bucket: 'backup', diskSpace: '' }, { bucket: 'photos', diskSpace: 'photos', backendId }] };
    assert.equal((await send(endpoint, 'POST', fields, { Origin: 'https://other.invalid' })).status, 403);
    assert.equal((await send(endpoint, 'POST', fields, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await send(endpoint, 'POST', { ...fields, userId: crypto.randomUUID() })).status, 400);
    assert.equal((await send(endpoint, 'POST', { ...fields, bucketMappings: [{ bucket: 'foreign', diskSpace: 'foreign' }] })).status, 400);
    assert.equal((await send(endpoint, 'POST', { ...fields, bucketMappings: [{ bucket: 'unknown', diskSpace: 'never-created' }] })).status, 400);
    const createdResponse = await send(endpoint, 'POST', fields);
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()).credential;
    assert.ok(created.secretAccessKey);
    const listingResponse = await send(endpoint), listingText = await listingResponse.text(), listing = JSON.parse(listingText);
    assert.ok(!listingText.includes(created.secretAccessKey));
    assert.ok(!listingText.includes('encryptedSecret'));
    assert.ok(!listingText.includes('DO-NOT-EXPOSE'));
    assert.equal(listing.connection.endpoint, base + '/S3API');
    assert.equal(listing.connection.pathStyle, true);
    assert.deepEqual(listing.spacesByUser[owner], ['', 'photos']);
    const id = endpoint + '/' + created.accessKeyId;
    const changedResponse = await send(id, 'PATCH', { ...fields, remark: '修改后的备注', updatedAt: created.updatedAt });
    assert.equal(changedResponse.status, 200);
    const changed = (await changedResponse.json()).credential;
    assert.ok(!('secretAccessKey' in changed));
    assert.equal((await send(id, 'PATCH', { ...fields, updatedAt: created.updatedAt })).status, 409);
    assert.equal((await send(id, 'PATCH', { ...fields })).status, 400);
    const disabledResponse = await send(id, 'PATCH', { enabled: false, updatedAt: changed.updatedAt });
    assert.equal(disabledResponse.status, 200);
    const disabled = (await disabledResponse.json()).credential;
    assert.equal(credentials.find(created.accessKeyId), null);
    const enabledResponse = await send(id, 'PATCH', { enabled: true, updatedAt: disabled.updatedAt });
    assert.equal(enabledResponse.status, 200);
    const enabled = (await enabledResponse.json()).credential;
    const rotatedResponse = await send(id + '/rotate', 'POST', { updatedAt: enabled.updatedAt });
    assert.equal(rotatedResponse.status, 200);
    assert.notEqual((await rotatedResponse.json()).credential.secretAccessKey, created.secretAccessKey);
    const retired = credentials.create({ userId: crypto.randomUUID(), bucketMappings: [{ bucket: 'retired', diskSpace: 'gone', backendId: crypto.randomUUID() }] });
    const retiredEndpoint = endpoint + '/' + retired.accessKeyId;
    const retiredOff = await send(retiredEndpoint, 'PATCH', { enabled: false, updatedAt: retired.updatedAt });
    assert.equal(retiredOff.status, 200, '账号、分区和后端退役后仍可以停用凭据');
    const retiredDisabled = (await retiredOff.json()).credential;
    assert.equal((await send(retiredEndpoint, 'PATCH', { enabled: true, updatedAt: retiredDisabled.updatedAt })).status, 400, '重新启用仍校验绑定范围');
    assert.equal((await send(retiredEndpoint + '/rotate', 'POST', { updatedAt: retiredDisabled.updatedAt })).status, 200, '轮换与停用不需要访问已退役后端');
    const guide = await send('/s3-api-guide');
    assert.equal(guide.status, 200);
    assert.equal(guide.headers.get('cache-control'), 'no-store');
    assert.match(guide.headers.get('content-security-policy'), /default-src 'none'/);
    const guideHtml = await guide.text();
    assert.match(guideHtml, /<table>/);
    assert.match(guideHtml, /<h2>2\. 管理第三方接入与凭据<\/h2>/);
    assert.match(guideHtml, /FolderSync/);
    assert.doesNotMatch(guideHtml, /<script\b/);
});

test('Markdown 手册只渲染允许的结构，不执行原始 HTML 或危险 URL', () => {
    const result = renderMarkdown('# 手册\n\n<script>alert(1)</script>\n\n[坏链接](javascript:alert) [正常](https://example.test/)\n\n```js\n<img src=x onerror=alert(1)>\n```\n\n| 名称 | 值 |\n|---|---|\n| **示例** | `code` |');
    assert.match(result, /&lt;script&gt;/);
    assert.match(result, /&lt;img/);
    assert.doesNotMatch(result, /<script\b|<img\b|href="javascript:/i);
    assert.match(result, /rel="noopener noreferrer"/);
    assert.match(result, /<strong>示例<\/strong>/);
    assert.match(result, /<code>code<\/code>/);
    assert.match(result, /<table>/);
});

test('S3 修改弹窗只由完整遮罩点击关闭，打开按钮和弹窗留白不会误关闭', () => {
    const nodes = new Map();
    function node(id) {
        if (!nodes.has(id)) nodes.set(id, { value: '', open: false, handlers: {}, closed: 0,
            addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); },
            getBoundingClientRect() { return { left: 100, right: 400, top: 100, bottom: 400 }; },
            close() { this.open = false; this.closed++; for (const handler of this.handlers.close || []) handler({ target: this }); }
        });
        return nodes.get(id);
    }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'client', 's3-management.js'), 'utf8'), {
        document: { getElementById: node }, window: { addEventListener() {} },
        fetch: () => new Promise(() => {}), navigator: {}, console
    });
    const dialog = node('editDialog');
    const emit = (type, x = 50, y = 50, extras = {}) => {
        const event = { target: dialog, pointerId: 1, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {}, ...extras };
        for (const handler of dialog.handlers[type] || []) handler(event);
    };
    dialog.open = true;
    emit('click'); // The button click that just opened showModal has no preceding dialog pointerdown.
    assert.equal(dialog.closed, 0);
    emit('pointerdown', 110, 110); emit('pointerup', 110, 110); emit('click', 110, 110);
    assert.equal(dialog.closed, 0, 'dialog 内部空白区域也属于面板，不能关闭');
    emit('pointerdown', 50, 50); emit('pointerup', 110, 110); emit('click', 50, 50);
    assert.equal(dialog.closed, 0, '手势从遮罩拖入面板不属于遮罩点击');
    emit('pointerdown'); emit('pointercancel'); emit('pointerup'); emit('click');
    assert.equal(dialog.closed, 0);
    emit('pointerdown'); emit('pointerup'); emit('click');
    assert.equal(dialog.closed, 1);
    assert.equal(dialog.open, false);
    assert.equal(dialog.handlers.cancel, undefined, '保留浏览器原生 ESC 关闭行为');
});
