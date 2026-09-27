'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskOperations } = require('../server/disk-operations');
const { createDiskShares } = require('../server/disk-shares');
const { createDiskChunkFileCache } = require('../server/disk-chunk-file-cache');
const { createDiskPartCache } = require('../server/disk-part-cache');
const { openDiskRepository } = require('../server/disk-repository');

test('并存的外围 Store 不会抹掉其它用户写入的身份、任务、分享或分片 ID', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-metadata-writers-'));
    t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
    const authA = createDiskAuth({ dataDir:dir });
    const authB = createDiskAuth({ dataDir:dir });
    const alice = authA.fromTelegram({ id:'1001', name:'Alice' });
    const bob = authB.fromTelegram({ id:'1002', name:'Bob' });
    assert.equal(createDiskAuth({ dataDir:dir }).users().length, 2);

    const jobsA = createDiskOperations({ dataDir:dir });
    const jobsB = createDiskOperations({ dataDir:dir });
    const aliceJob = jobsA.create({ userId:alice.id, diskSpace:'' }, 'upload', 'Alice 上传');
    const bobJob = jobsB.create({ userId:bob.id, diskSpace:'' }, 'upload', 'Bob 上传');
    const repository = openDiskRepository(dir);
    assert.deepEqual(new Set(repository.load('operations').map(item => item.operation_id)), new Set([aliceJob.operation_id, bobJob.operation_id]));

    const sharesA = createDiskShares({ dataDir:dir });
    const sharesB = createDiskShares({ dataDir:dir });
    const store = { get(userId, id) { return { id, ownerId:userId, name:'文件.bin', folderPath:'', type:'application/octet-stream', size:1 }; } };
    sharesA.create({ userId:alice.id, diskSpace:'' }, store, [{ kind:'file', id:'alice-file' }]);
    sharesB.create({ userId:bob.id, diskSpace:'' }, store, [{ kind:'file', id:'bob-file' }]);
    assert.equal(repository.load('shares').length, 2);

    const cacheA = createDiskChunkFileCache({ dataDir:dir });
    const cacheB = createDiskChunkFileCache({ dataDir:dir });
    const backend = { baseUrl:'https://api.telegram.org', token:'test' };
    cacheA.put(backend, { sha256:'a'.repeat(64), size:1 }, { fileId:'tg-a' });
    cacheB.put(backend, { sha256:'b'.repeat(64), size:1 }, { fileId:'tg-b' });
    assert.equal(repository.load('chunk_ids').length, 2);
});

test('分片缓存归属的并存写入保留不同用户和分区', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-cache-owners-'));
    t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
    const first = createDiskPartCache({ dataDir:dir });
    const second = createDiskPartCache({ dataDir:dir });
    for await (const _ of await first.open({ key:'alice-part', size:1, source:() => Readable.from(['a']), owner:{ userId:'alice', diskSpace:'' } })) {}
    for await (const _ of await second.open({ key:'bob-part', size:1, source:() => Readable.from(['b']), owner:{ userId:'bob', diskSpace:'other' } })) {}
    const owners = openDiskRepository(dir).load('cache_owners');
    assert.equal(owners.length, 2);
    assert.deepEqual(new Set(owners.flatMap(item => item.scopes.map(scope => scope.userId))), new Set(['alice', 'bob']));
});
