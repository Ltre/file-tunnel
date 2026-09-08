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
