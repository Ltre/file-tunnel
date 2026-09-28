'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listV2 } = require('../server/s3/routes');
const { objectKey, parseByteRange } = require('../server/object-storage');

test('ListObjectsV2 的目录聚合、分页令牌和 start-after 按 Key 排序', () => {
    const objects = ['a/1.txt', 'a/2.txt', 'b.txt', 'c.txt'].map((key, index) => ({ key, size: index, etag: 'e' + index, updatedAt: Date.now() }));
    const first = listV2({ objects, bucket: 'backup', query: { delimiter: '/', 'max-keys': '1' }, secret: 'secret' });
    assert.match(first, /<CommonPrefixes><Prefix>a\/<\/Prefix>/);
    assert.match(first, /<IsTruncated>true<\/IsTruncated>/);
    const token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(first)[1];
    const second = listV2({ objects, bucket: 'backup', query: { delimiter: '/', 'max-keys': '1', 'continuation-token': token }, secret: 'secret' });
    assert.match(second, /<Key>b.txt<\/Key>/); assert.doesNotMatch(second, /<Prefix>a\/<\/Prefix>/);
    const after = listV2({ objects, bucket: 'backup', query: { delimiter: '/', 'start-after': 'a/' }, secret: 'secret' });
    assert.doesNotMatch(after, /<Prefix>a\/<\/Prefix>/);
    assert.throws(() => listV2({ objects, bucket: 'other', query: { 'continuation-token': token }, secret: 'secret' }), /InvalidArgument/);
    const emptyDirectory = { kind: 'virtual-directory', key: 'empty/', size: 0 };
    assert.match(listV2({ objects: [emptyDirectory], bucket: 'backup', query: { delimiter: '/' }, secret: 'secret' }), /<CommonPrefixes><Prefix>empty\/<\/Prefix>/);
    assert.doesNotMatch(listV2({ objects: [emptyDirectory], bucket: 'backup', query: {}, secret: 'secret' }), /<Contents>/);
});
test('S3 Key 无法无损映射时明确拒绝，Range 仅返回指定字节', () => {
    assert.equal(objectKey('中 文/かな/# + %.txt').name, '# + %.txt');
    assert.equal(objectKey('a/' + 'x'.repeat(150)).name.length, 150);
    for (const key of ['a//b', 'a/../b', ' a.txt', 'a\\b', 'a:<b', 'a/'.repeat(22) + 'x']) assert.throws(() => objectKey(key), /InvalidObjectName/);
    assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9, partial: true });
    assert.deepEqual(parseByteRange('bytes=8-', 10), { start: 8, end: 9, partial: true });
    assert.throws(() => parseByteRange('bytes=10-', 10), /InvalidRange/);
});
