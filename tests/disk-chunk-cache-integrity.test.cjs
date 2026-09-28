'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiskChunkFileCache } = require('../server/disk-chunk-file-cache');
const { openDiskRepository } = require('../server/disk-repository');
const { MAX_TELEGRAM_PART_SIZE } = require('../server/disk-limits');

const backend = { token: 'fixture-bot', baseUrl: 'https://api.telegram.org' };
const part = { sha256: 'a'.repeat(64), size: 3 };
const keyOf = (storage, chunk) => `${crypto.createHash('sha256').update(storage.baseUrl + '\0' + storage.token).digest('hex')}:${chunk.sha256}:${chunk.size}`;
function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-chunk-integrity-'));
    const repository = openDiskRepository(dataDir);
    t.after(() => {
        repository.close();
        const relative = path.relative(os.tmpdir(), dataDir);
        assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
    return { dataDir, repository, cache: createDiskChunkFileCache({ dataDir }) };
}

test('分片复用按 Bot、哈希和大小隔离，持久化后仍匹配原大小', t => {
    const { dataDir, repository, cache } = fixture(t);
    const larger = { ...part, size: 4 }, otherBot = { ...backend, token: 'fixture-other-bot' };
    cache.put(backend, part, { fileId: 'size-3', fileUniqueId: 'unique-3', size: 3 });
    assert.equal(cache.get(backend, larger), null);
    assert.equal(cache.get(otherBot, part), null);
    cache.put(backend, larger, { fileId: 'size-4', size: 4 });
    cache.put(otherBot, part, { fileId: 'other-bot', size: 3 });
    const reopened = createDiskChunkFileCache({ dataDir });
    assert.equal(reopened.get(backend, part).fileId, 'size-3');
    assert.equal(reopened.get(backend, larger).fileId, 'size-4');
    assert.equal(reopened.get(otherBot, part).fileId, 'other-bot');
    assert.equal(repository.load('chunk_ids').length, 3);
    repository.assertIntegrity();
});

test('异常缓存索引的大小或 file_id 不匹配时忽略映射', t => {
    const { repository, cache } = fixture(t);
    for (const value of [null, {}, { fileId: 'wrong-size', size: 4 }, { fileId: 'string-size', size: '3' },
        { fileId: 'zero-size', size: 0 }, { fileId: '', size: 3 }, { fileId: { id: 'invalid' }, size: 3 }]) {
        repository.replace('chunk_ids', [{ key: keyOf(backend, part), value }], item => item.key);
        assert.equal(cache.get(backend, part), null);
    }
    repository.replace('chunk_ids', [{ key: keyOf(backend, part), value: { fileId: 'repaired', size: 3 } }], item => item.key);
    assert.equal(cache.get(backend, part).fileId, 'repaired');
});

test('无效分片或远端大小不符不写入、不覆盖已有有效映射', t => {
    const { repository, cache } = fixture(t);
    for (const size of [0, -1, 1.5, NaN, Infinity, '3', MAX_TELEGRAM_PART_SIZE + 1]) {
        const invalid = { ...part, size };
        cache.put(backend, invalid, { fileId: 'invalid', size });
        assert.equal(cache.get(backend, invalid), null);
    }
    cache.put(backend, { ...part, sha256: 'invalid' }, { fileId: 'invalid', size: 3 });
    for (const remote of [{ fileId: 'mismatch', size: 4 }, { fileId: 'zero', size: 0 },
        { fileId: 'null', size: null }, { fileId: 'string', size: '3' }, { fileId: {}, size: 3 }]) {
        cache.put(backend, part, remote);
    }
    assert.deepEqual(repository.load('chunk_ids'), []);
    cache.put(backend, part, { fileId: 'valid-without-size' });
    cache.put(backend, part, { fileId: 'bad-overwrite', size: 4 });
    assert.equal(cache.get(backend, part).fileId, 'valid-without-size');
    const maximum = { ...part, size: MAX_TELEGRAM_PART_SIZE };
    cache.put(backend, maximum, { fileId: 'maximum', size: MAX_TELEGRAM_PART_SIZE });
    assert.equal(cache.get(backend, maximum).size, MAX_TELEGRAM_PART_SIZE);
    assert.equal(repository.load('chunk_ids').length, 2);
});

test('并存缓存实例的写入和失效同步可见，不抹掉其它映射', t => {
    const { dataDir, repository, cache: first } = fixture(t);
    const second = createDiskChunkFileCache({ dataDir });
    const different = { ...part, sha256: 'b'.repeat(64) };
    first.put(backend, part, { fileId: 'first', size: 3 });
    assert.equal(second.get(backend, part).fileId, 'first');
    second.put(backend, different, { fileId: 'second', size: 3 });
    first.remove(backend, part);
    assert.equal(second.get(backend, part), null);
    assert.equal(first.get(backend, different).fileId, 'second');
    assert.equal(repository.load('chunk_ids').length, 1);
});

test('并发修改发生写入冲突时重载持久化映射，后续写入仍正常', t => {
    const { repository, cache } = fixture(t);
    cache.put(backend, part, { fileId: 'original', size: 3 });
    const originalReplace = repository.replaceMany;
    repository.replaceMany = changes => {
        repository.replaceMany = originalReplace;
        originalReplace([{ table: 'chunk_ids', items: [{ key: keyOf(backend, part), value: { fileId: 'concurrent', size: 3 } }], keyOf: item => item.key }]);
        originalReplace(changes);
    };
    t.after(() => { repository.replaceMany = originalReplace; });
    assert.throws(() => cache.put(backend, part, { fileId: 'stale', size: 3 }), /DISK_WRITE_CONFLICT/);
    assert.equal(cache.get(backend, part).fileId, 'concurrent');
    const different = { ...part, sha256: 'c'.repeat(64) };
    cache.put(backend, different, { fileId: 'following', size: 3 });
    assert.equal(cache.get(backend, part).fileId, 'concurrent');
    assert.equal(cache.get(backend, different).fileId, 'following');
    repository.assertIntegrity();
});
