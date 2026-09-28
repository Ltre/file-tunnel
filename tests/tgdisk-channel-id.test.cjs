'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDiskRepository } = require('../server/disk-repository');
const { main } = require('../tools/change-tgdisk-channel-id.cjs');

test('频道 ID 迁移预演不写入，停服确认后跨分区事务更新且保留分片', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-channel-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const repository = openDiskRepository(dir);
    const part = { fileId: 'telegram-file', messageId: 42, size: 3, offset: 0, partIndex: 1, partCount: 1 };
    repository.replace('files', [{ id: 'a', ownerId: 'u', folderPath: '', name: 'a.txt', channelId: '@old', parts: [part], pendingRemoteCleanup: [{ channelId: '@old', messageId: 40, parts: [part] }] }], file => file.id);
    repository.replace('files', [{ id: 'b', ownerId: 'v', folderPath: '', name: 'b.txt', channelId: '-1002222222222', parts: [part] }], file => file.id, 'photos');
    const flags = ['--data-dir', dir, '--chat-id', '-1001234567890'];
    const before = await main(flags);
    assert.equal(before.mode, 'dry-run'); assert.equal(before.changed, 2);
    assert.equal(repository.load('files')[0].channelId, '@old');
    await assert.rejects(main([...flags, '--apply']), /service-stopped/);
    const applied = await main([...flags, '--service-stopped', '--apply']);
    assert.equal(applied.changed, 2); assert.ok(fs.existsSync(applied.backup));
    assert.equal(repository.load('files')[0].channelId, '-1001234567890');
    assert.equal(repository.load('files')[0].pendingRemoteCleanup[0].channelId, '-1001234567890');
    assert.equal(repository.load('files', 'photos')[0].channelId, '-1001234567890');
    assert.deepEqual(repository.load('files')[0].parts, [part]);
    assert.equal((await main([...flags, '--service-stopped', '--apply'])).changed, 0);
});
