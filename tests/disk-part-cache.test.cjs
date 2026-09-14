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
