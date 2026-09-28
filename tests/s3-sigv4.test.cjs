'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { verify, canonicalUri, canonicalQuery, signingKey, decodeAwsChunks, sha256 } = require('../server/s3/sigv4');

test('Canonical URI 保留完整挂载前缀与连续斜线，查询参数稳定排序', () => {
    assert.equal(canonicalUri('/S3API/a/中%20文//x%2By'), '/S3API/a/%E4%B8%AD%20%E6%96%87//x%2By');
    assert.equal(canonicalQuery('/S3API/a?z=2&b=a%20b&b=a'), 'b=a&b=a%20b&z=2');
});
test('SigV4 拒绝错误密钥、错误路径和过期时间', () => {
    const secret = 'example-secret', accessKeyId = 'D2TEXAMPLE', date = '20260928T000000Z';
    const scope = '20260928/us-east-1/s3/aws4_request', payloadHash = sha256('');
    const url = '/S3API/bucket/%E6%B5%8B%E8%AF%95.txt?list-type=2';
    const headers = { host: 'example.test', 'x-amz-date': date, 'x-amz-content-sha256': payloadHash };
    const signed = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = ['GET', canonicalUri(url), canonicalQuery(url), `host:example.test\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`, signed, payloadHash].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
    const signature = crypto.createHmac('sha256', signingKey(secret, '20260928', 'us-east-1')).update(toSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
    const credentials = { find: id => id === accessKeyId ? { secretAccessKey: secret } : null };
    const req = { method: 'GET', originalUrl: url, headers };
    assert.equal(verify(req, credentials, Date.parse('2026-09-28T00:00:00Z')).signature, signature);
    assert.throws(() => verify({ ...req, originalUrl: url.replace('/S3API', '/s3') }, credentials, Date.parse('2026-09-28T00:00:00Z')), /SignatureDoesNotMatch/);
    assert.throws(() => verify(req, { find: () => ({ secretAccessKey: 'wrong' }) }, Date.parse('2026-09-28T00:00:00Z')), /SignatureDoesNotMatch/);
    assert.throws(() => verify(req, credentials, Date.parse('2026-09-28T01:00:00Z')), /RequestTimeTooSkewed/);
});
test('AWS SigV4 streaming 分块签名在每片输出前校验', async () => {
    const secret = 'streaming-secret', date = '20260928T000000Z', scope = '20260928/us-east-1/s3/aws4_request';
    const key = signingKey(secret, '20260928', 'us-east-1'), initial = '0'.repeat(64);
    const sign = (previous, body) => crypto.createHmac('sha256', key).update(['AWS4-HMAC-SHA256-PAYLOAD', date, scope, previous, sha256(''), sha256(body)].join('\n')).digest('hex');
    const bytes = Buffer.from('你好');
    const first = sign(initial, bytes), last = sign(first, Buffer.alloc(0));
    const encoded = Buffer.concat([Buffer.from(`${bytes.length.toString(16)};chunk-signature=${first}\r\n`), bytes, Buffer.from(`\r\n0;chunk-signature=${last}\r\n\r\n`)]);
    const request = Readable.from([encoded]); request.headers = { 'x-amz-decoded-content-length': String(bytes.length) };
    const decoded = decodeAwsChunks(request, { payloadHash: 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD', signature: initial, signingKey: key, date, scope });
    const result = []; for await (const chunk of decoded) result.push(chunk);
    assert.deepEqual(Buffer.concat(result), bytes);
});
