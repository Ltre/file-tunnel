'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiskPartCache } = require('../server/disk-part-cache');

async function collect(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

test('服务端临时缓存按用户、分区及全部范围清理，重启后关联仍保留且不触及其它目录', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-cache-scope-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const outside = path.join(dataDir, 'original.mp4'); fs.writeFileSync(outside, 'original');
    const cache = createDiskPartCache({ dataDir });
    for (const [key, userId, diskSpace] of [['a', 'u1', ''], ['b', 'u1', 'other'], ['c', 'u2', 'other']]) {
        await collect(await cache.open({ key, size: 3, source: async () => require('node:stream').Readable.from(['abc']), owner: { userId, diskSpace } }));
    }
    assert.equal((await cache.overview()).files, 3);
    const restarted = createDiskPartCache({ dataDir });
    assert.equal((await restarted.clear({ scope: 'user-partition', userId: 'u1', diskSpace: '' })).removedFiles, 1);
    assert.equal((await restarted.overview()).files, 2);
    assert.equal((await restarted.clear({ scope: 'user', userId: 'u1' })).removedFiles, 1);
    assert.equal((await restarted.clear({ scope: 'partition', diskSpace: 'other' })).removedFiles, 1);
    await collect(await restarted.open({ key: 'last', size: 3, source: async () => require('node:stream').Readable.from(['abc']) }));
    assert.equal((await restarted.clear()).removedFiles, 1); assert.equal((await restarted.overview()).bytes, 0);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'original'); assert.ok(fs.existsSync(path.join(dataDir, 'telegram-part-cache', '.schema')));
});

test('清理会跳过正在共享读取的临时分片，完成后可清理；旧无索引缓存按关联键匹配', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-cache-busy-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const cache = createDiskPartCache({ dataDir }); let release;
    const pending = new Promise(resolve => { release = resolve; });
    const stream = await cache.open({ key: 'busy', size: 3, owner: { userId: 'u1', diskSpace: '' }, source: async function* () { await pending; yield Buffer.from('abc'); } });
    const result = await cache.clear({ scope: 'user', userId: 'u1' }); assert.equal(result.removedFiles, 0); assert.equal(result.busyFiles, 1);
    release(); assert.equal((await collect(stream)).toString(), 'abc');
    await new Promise(resolve => setImmediate(resolve)); assert.equal((await cache.clear()).removedFiles, 1);
    const key = 'old-window', id = require('node:crypto').createHash('sha256').update(key).digest('hex');
    fs.writeFileSync(path.join(dataDir, 'telegram-part-cache', id + '.part'), 'old');
    assert.equal((await cache.clear({ scope: 'user', userId: 'u1', legacyKeys: ['different-window'] })).removedFiles, 0);
    assert.equal((await cache.clear({ scope: 'user', userId: 'u1', legacyKeys: [key] })).removedFiles, 1);
});

test('相同 Telegram 字节窗口只建立一个上游读取，下载者可共享增长中的缓存文件', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-part-cache-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const cache = createDiskPartCache({ dataDir, maxBytes: 1024 * 1024 });
    let sources = 0;
    const source = async function* () {
        sources++;
        yield Buffer.from('abcd');
        await new Promise(resolve => setTimeout(resolve, 15));
        yield Buffer.from('efghij');
    };
    const [left, right] = await Promise.all([
        cache.open({ key: 'same-file:0-9', size: 10, start: 2, end: 7, source }),
        cache.open({ key: 'same-file:0-9', size: 10, start: 2, end: 7, source })
    ]);
    const [a, b] = await Promise.all([collect(left), collect(right)]);
    assert.equal(a.toString(), 'cdefgh');
    assert.equal(b.toString(), 'cdefgh');
    assert.equal(sources, 1);
    for (let index = 0; index < 20 && cache.inflightCount(); index++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(cache.inflightCount(), 0);
    assert.equal((await collect(await cache.open({ key: 'same-file:0-9', size: 10, source }))).toString(), 'abcdefghij');
    assert.equal(sources, 1, '完整缓存命中不应再次请求 Telegram');
});

test('一个播放器取消 Range 读取不会中断共享缓存填充，后续读取仍命中完整缓存', { timeout: 5000 }, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-part-cache-abort-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const cache = createDiskPartCache({ dataDir, maxBytes: 1024 * 1024 });
    let sources = 0;
    let releaseSource;
    const remaining = new Promise(resolve => { releaseSource = resolve; });
    t.after(() => releaseSource());
    // Trigger writer backpressure so the first block is on disk before pausing
    // the source, rather than relying on a timer or a tiny buffered write.
    const prefix = Buffer.alloc(64 * 1024, 'a'); prefix.write('abc');
    const expected = Buffer.concat([prefix, Buffer.from('defghij')]);
    const source = async function* () {
        sources++;
        yield prefix;
        await remaining;
        yield Buffer.from('defghij');
    };
    const controller = new AbortController();
    const first = await cache.open({ key: 'seek-window', size: expected.length, source, signal: controller.signal });
    const iterator = first[Symbol.asyncIterator]();
    assert.deepEqual(Buffer.from((await iterator.next()).value), prefix);
    controller.abort();
    releaseSource();
    await assert.rejects(iterator.next(), /OPERATION_CANCELLED/);
    for (let index = 0; index < 40 && cache.inflightCount(); index++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(await collect(await cache.open({ key: 'seek-window', size: expected.length, source })), expected);
    assert.equal(sources, 1);
});

test('完整分片写入时校验哈希，缓存结构升级会清除旧缓存和中断临时文件', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-part-cache-schema-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const root = path.join(dataDir, 'telegram-part-cache'); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, '.schema'), '1\n'); fs.writeFileSync(path.join(root, 'old.part'), 'old'); fs.writeFileSync(path.join(root, 'old.tmp'), 'old');
    const cache = createDiskPartCache({ dataDir });
    assert.equal(fs.readFileSync(path.join(root, '.schema'), 'utf8').trim(), '2');
    assert.equal(fs.existsSync(path.join(root, 'old.part')), false);
    assert.equal(fs.existsSync(path.join(root, 'old.tmp')), false);
    const wrong = await cache.open({ key: 'hash', size: 3, expectedSha256: '0'.repeat(64), source: async function* () { yield Buffer.from('abc'); } });
    await assert.rejects(collect(wrong), /TELEGRAM_PART_HASH_MISMATCH/);
});
