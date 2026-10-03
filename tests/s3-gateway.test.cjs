'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { Readable } = require('node:stream');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskOperations } = require('../server/disk-operations');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { createDiskAPI } = require('../server/disk-api');
const { createS3Gateway } = require('../server/s3');
const { canonicalUri, canonicalQuery, signingKey, sha256 } = require('../server/s3/sigv4');

function signed(method, url, credential, body = Buffer.alloc(0), extra = {}) {
    const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const scope = `${date.slice(0, 8)}/us-east-1/s3/aws4_request`, payload = sha256(body);
    const headers = { host: new URL(url).host, 'x-amz-date': date, 'x-amz-content-sha256': payload, ...extra };
    const names = ['host', 'x-amz-content-sha256', 'x-amz-date'];
    const canonicalHeaders = names.map(name => `${name}:${headers[name]}\n`).join('');
    const target = new URL(url).pathname + new URL(url).search;
    const canonical = [method, canonicalUri(target), canonicalQuery(target), canonicalHeaders, names.join(';'), payload].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
    const signature = crypto.createHmac('sha256', signingKey(credential.secretAccessKey, date.slice(0, 8), 'us-east-1')).update(toSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    return { method, headers, ...(method === 'PUT' || method === 'POST' ? { body } : {}) };
}

async function statusAfterReading(responsePromise) {
    const response = await responsePromise;
    // Release error response bodies before reusing Undici's local connection pool.
    await response.arrayBuffer();
    return response.status;
}
test('S3 SigV4、流式分片、覆盖、Range、Copy、marker 和批量删除共用网盘索引', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2t-s3-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const auth = createDiskAuth({ dataDir }), owner = auth.fromTelegram({ id: '999001' });
    const chunks = new Map(); let message = 0, removed = 0, uploaded = 0, reused = 0;
    const telegram = {
        call: async (_backend, method) => method === 'getFile' ? { file_path: 'ok' } : true,
        parts: file => { assert.ok(file.parts.every(part => part.logicalFileId === file.id), '分片必须关联最终逻辑文件 ID'); return file.parts; },
        readPart: async (_backend, part, { start = 0, end = part.size - 1 } = {}) => Readable.from([chunks.get(part.fileId).subarray(start, end + 1)]),
        uploadPhysical: async (_backend, _files, parts) => parts.map(part => {
            const fileId = `part-${++message}`; uploaded++; if (part.reuseFileId) reused++;
            chunks.set(fileId, part.reuseFileId ? chunks.get(part.reuseFileId) : fs.readFileSync(part.path));
            return { ...part, fileId, fileUniqueId: fileId, messageId: message, messageDate: Date.now(), mediaType: 'document' };
        }),
        remove: async () => { removed++; }
    };
    const disk = createDiskAPI({ dataDir, defaultStore: createTelegramDriveStore({ dataDir }), auth, operations: createDiskOperations({ dataDir }), telegram,
        getDefaultBackend: channelId => ({ token: 'fake', channelId: channelId || '-1001234567890', baseUrl: 'https://api.telegram.org' }),
        getIdentity: () => owner, setIdentity: () => {}, getOrigin: () => 'http://localhost', isMockRequest: () => true, maxDepth: () => 20 });
    t.after(() => disk.close());
    const gateway = createS3Gateway({ dataDir, objectStorage: disk.objectStorage });
    const credential = gateway.credentials.create({ userId: owner.id, bucketMappings: [{ bucket: 'my-bucket', diskSpace: '' }] });
    const other = auth.fromTelegram({ id: '999002' });
    const otherCredential = gateway.credentials.create({ userId: other.id, bucketMappings: [{ bucket: 'other-bucket', diskSpace: '' }] });
    const app = express(); app.use('/S3API', gateway.api); app.use('/s3', gateway.content);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (method, endpoint, body, extra) => {
        const url = base + endpoint, bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
        return fetch(url, signed(method, url, credential, bytes, extra));
    };
    const buckets = await send('GET', '/S3API');
    assert.equal(buckets.status, 200); assert.match(await buckets.text(), /my-bucket/);
    const otherListUrl = base + '/S3API';
    const otherList = await (await fetch(otherListUrl, signed('GET', otherListUrl, otherCredential))).text();
    assert.match(otherList, /other-bucket/); assert.doesNotMatch(otherList, /my-bucket/);
    const forbiddenUrl = base + '/S3API/my-bucket?list-type=2';
    assert.equal(await statusAfterReading(fetch(forbiddenUrl, signed('GET', forbiddenUrl, otherCredential))), 404);
    const name = '/S3API/my-bucket/日本語/hello%20%23%2B.txt';
    const original = Buffer.alloc(20_000_010, 65);
    const put = await send('PUT', name, original, { 'content-type': 'text/plain' });
    assert.equal(put.status, 200, await put.text());
    assert.equal(put.headers.get('etag'), `"${crypto.createHash('md5').update(original).digest('hex')}"`);
    assert.equal(uploaded, 2, '20 MB 分片直接进入现有上传流水线');
    const head = await send('HEAD', name);
    assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), original.length);
    const range = await send('GET', name, '', { range: 'bytes=19999995-20000005' });
    assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 11);
    const invalidRange = await send('GET', name, '', { range: `bytes=${original.length}-` });
    assert.equal(invalidRange.status, 416); assert.equal(invalidRange.headers.get('content-range'), `bytes */${original.length}`);
    await invalidRange.arrayBuffer();
    const forgedUrl = base + name;
    const forged = signed('PUT', forgedUrl, credential, Buffer.from('signed-payload'));
    forged.body = Buffer.from('different-body');
    assert.equal(await statusAfterReading(fetch(forgedUrl, forged)), 400);
    assert.equal(Number((await send('HEAD', name)).headers.get('content-length')), original.length, '散列不符不能覆盖旧文件');
    assert.equal(await statusAfterReading(send('PUT', name, 'same-size', { 'content-md5': Buffer.alloc(16).toString('base64') })), 400);
    assert.equal(Number((await send('HEAD', name)).headers.get('content-length')), original.length, 'MD5 不符同样不能覆盖旧文件');
    const uploadedBeforeCopy=uploaded;
    const bigCopy = await send('PUT', '/S3API/my-bucket/large-copy.bin', '', { 'x-amz-copy-source': '/my-bucket/%E6%97%A5%E6%9C%AC%E8%AA%9E/hello%20%23%2B.txt' });
    assert.equal(bigCopy.status, 200, await bigCopy.text());
    assert.equal(reused, 0, '同一 Bot 的复制只建立 Content 引用，不能重新发送 file_id');
    assert.equal(uploaded,uploadedBeforeCopy,'Copy 不上传正文或创建新 Anchor');
    assert.equal((await (await send('GET', '/S3API/my-bucket/large-copy.bin', '', { range: 'bytes=19999995-20000005' })).arrayBuffer()).byteLength, 11);
    const removedBeforeReplacement=removed;
    const second = Buffer.from('replacement');
    const overwrite = await send('PUT', name, second);
    assert.equal(overwrite.status, 200, await overwrite.text());
    assert.equal(await (await send('GET', name)).text(), 'replacement');
    assert.equal(await (await send('GET', name.replace('/S3API/', '/s3/'))).text(), 'replacement');
    assert.equal(await statusAfterReading(fetch(base + name.replace('/S3API/', '/s3/'))), 403, '内容入口同样需要签名');
    const copy = await send('PUT', '/S3API/my-bucket/copied.txt', '', { 'x-amz-copy-source': '/my-bucket/%E6%97%A5%E6%9C%AC%E8%AA%9E/hello%20%23%2B.txt' });
    assert.equal(copy.status, 200, await copy.text());
    assert.equal(await (await send('GET', '/S3API/my-bucket/copied.txt')).text(), 'replacement');
    assert.equal(removed,removedBeforeReplacement,'覆盖不能清理仍由 large-copy 引用的旧 Content');
    assert.equal((await send('PUT', '/S3API/my-bucket/empty.txt', '')).status, 200);
    assert.equal((await send('PUT', '/S3API/my-bucket/folder/', '')).status, 200);
    const listed = await send('GET', '/S3API/my-bucket?list-type=2&delimiter=%2F');
    const xml = await listed.text(); assert.match(xml, /<CommonPrefixes><Prefix>folder\/<\/Prefix>/); assert.match(xml, /<Contents><Key>copied.txt<\/Key>/);
    assert.equal((await send('DELETE', '/S3API/my-bucket/folder/')).status, 204);
    assert.doesNotMatch(await (await send('GET', '/S3API/my-bucket?list-type=2&delimiter=%2F')).text(), /<Prefix>folder\/<\/Prefix>/);
    const batch = Buffer.from('<Delete><Object><Key>copied.txt</Key></Object><Object><Key>empty.txt</Key></Object></Delete>');
    const deleted = await send('POST', '/S3API/my-bucket?delete', batch, { 'content-type': 'application/xml' });
    assert.equal(deleted.status, 200, await deleted.text());
    assert.equal((await send('HEAD', '/S3API/my-bucket/copied.txt')).status, 404);
    const reloaded = createTelegramDriveStore({ dataDir });
    const saved = reloaded.list(owner.id, '日本語').files[0];
    assert.equal(saved.metadata.s3ETag, crypto.createHash('md5').update(second).digest('hex'));
    assert.equal(saved.parts[0].logicalFileId, saved.id);
    const badUrl = base + '/S3API/my-bucket/unknown';
    const bad = signed('GET', badUrl, credential); bad.headers.authorization = bad.headers.authorization.replace(/.$/, char => char === '0' ? '1' : '0');
    assert.equal(await statusAfterReading(fetch(badUrl, bad)), 403);
});
