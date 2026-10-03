'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { migrate } = require('../tools/migrate-tgdisk-json-to-sqlite.cjs');
const { openDiskRepository } = require('../server/disk-repository');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { createDiskCollaborationStore } = require('../server/disk-collaboration');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-json-migration-'));
    t.after(() => {
        const relative = path.relative(os.tmpdir(), dir);
        assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const write = (relative, value) => {
        const filename = path.join(dir, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, JSON.stringify(value));
    };
    const space = 'archive';
    const prefix = `disk-spaces/${crypto.createHash('sha256').update(space).digest('hex')}/`;
    const file = { id: 'f-1', ownerId: 'u-1', folderPath: 'photos', name: 'one.jpg', size: 3,
        parts: [{ partIndex: 1, fileId: 'telegram-1', messageId: 2, size: 3 }] };
    const second = { id: 'f-2', ownerId: 'u-2', folderPath: '', name: 'two.mp4', size: 4,
        parts: [{ partIndex: 1, fileId: 'telegram-2', messageId: 3, size: 4 }] };
    write('disk-spaces.json', [space]);
    write('telegram-drive-index.json', [file]);
    write('telegram-drive-directories.json', [{ ownerId: 'u-1', path: 'photos', createdAt: 100, updatedAt: 200 }]);
    write(prefix + 'telegram-drive-index.json', [second]);
    write(prefix + 'telegram-drive-directories.json', []);
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encryptedToken = Buffer.concat([iv, cipher.update('test-bot-token', 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
    write('disk-auth.json', { users: [{ id: 'u-1', username: 'alice', passkeys: [] }, { id: 'u-2', username: 'bob', passkeys: [] }],
        apps: [{ app_id: 'app-1' }], backends: [{ id: 'backend-1', fingerprint: 'bot-1', encryptedToken }], tokens: [{ hash: 'hash-1' }] });
    fs.writeFileSync(path.join(dir, 'disk-secret.key'), key);
    write('disk-space-usage.json', [{ appId: 'app-1', userId: 'u-2', diskSpace: space, createdAt: 100 }]);
    write('disk-shares.json', [{ id: 'share-1', token: 'token-1', ownerId: 'u-1', diskSpace: '', files: [{ id: 'f-1' }], directories: [] }]);
    write('disk-operations.json', [{ operation_id: 'op-1', userId: 'u-1', status: 'completed' }]);
    write('disk-collaborations.json', [{ id: 'collab-1', ownerId: 'u-1', diskSpace: '', kind: 'file', fileId: 'f-1',
        name: 'one.jpg', members: ['u-2'], invites: [], active: true }]);
    write('telegram-chunk-file-ids.json', { version: 1, entries: { 'key-1': { fileId: 'tg-chunk-1', size: 3 } } });
    write('telegram-part-cache/.owners.json', { 'cache-1': [{ userId: 'u-1', diskSpace: '' }] });
    write('tg-1byte-file.id', { 'bot-1': { file_id: 'tg-placeholder' } });
    return { dir, write, file, second, space, prefix };
}

test('旧网盘 JSON 预检不写库；导入保留分区、文件分片、身份与协同并可重复执行', async t => {
    const { dir, file, second, space } = fixture(t);
    const preview = await migrate({ dataDir: dir, apply: false });
    assert.equal(preview.mode, 'dry-run');
    assert.deepEqual(preview.missing, []);
    assert.deepEqual(preview.warnings, []);
    assert.equal(fs.existsSync(path.join(dir, 'disk.sqlite')), false);
    const applied = await migrate({ dataDir: dir, apply: true });
    assert.equal(applied.mode, 'applied');
    assert.equal(fs.existsSync(path.join(applied.backupDir, 'disk-before.sqlite')), true);
    assert.equal(fs.existsSync(path.join(applied.backupDir, 'disk-secret.key')), true);
    assert.equal(fs.existsSync(path.join(dir, 'disk-auth.json')), true);
    const repository = openDiskRepository(dir);
    for(const [scope,expected] of [['',file],[space,second]]){
        const [actual]=repository.load('files',scope);
        for(const key of ['id','ownerId','folderPath','name','size'])assert.equal(actual[key],expected[key]);
        assert.ok(actual.contentId);assert.equal(actual.logicalContentVersion,1);
        assert.equal(actual.parts[0].fileId,expected.parts[0].fileId);
        assert.equal(actual.parts[0].messageId,expected.parts[0].messageId);
    }
    assert.equal(repository.load('collaborations')[0].fileId, file.id);
    assert.equal(createDiskCollaborationStore(dir).ownedTarget('u-1', '', 'file', file.id).id, 'collab-1');
    assert.equal(repository.load('shares')[0].files[0].id, file.id);
    assert.equal(repository.load('chunk_ids')[0].value.fileId, 'tg-chunk-1');
    assert.equal(repository.load('cache_owners')[0].scopes[0].userId, 'u-1');
    assert.equal(repository.load('placeholders')[0].fileId, 'tg-placeholder');
    assert.equal(repository.load('users').length, 2);
    const store = createTelegramDriveStore({ dataDir: dir });
    assert.equal(store.list('u-1', 'photos').files[0].id, file.id);
    const repeated = await migrate({ dataDir: dir, apply: true });
    assert.equal(repeated.mode, 'already-imported');
    assert.equal(repository.load('files').length, 1);
    repository.close();
});

test('目标库已有独立记录时合并，标识冲突时不覆盖任何记录', async t => {
    const { dir } = fixture(t);
    const repository = openDiskRepository(dir);
    repository.replace('operations', [{ operation_id: 'new-op', userId: 'u-3', status: 'completed' }], item => item.operation_id);
    const first = await migrate({ dataDir: dir, apply: true });
    assert.equal(first.mode, 'applied');
    assert.equal(repository.load('operations').length, 2);
    repository.close();

    const { dir: conflictDir, write } = fixture(t);
    const conflictRepository = openDiskRepository(conflictDir);
    conflictRepository.replace('operations', [{ operation_id: 'op-1', userId: 'other', status: 'failed' }], item => item.operation_id);
    await assert.rejects(migrate({ dataDir: conflictDir, apply: true }), /内容不同/);
    assert.deepEqual(conflictRepository.load('files'), []);
    assert.equal(conflictRepository.load('operations')[0].userId, 'other');
    conflictRepository.close();
});

test('相同分片哈希对应不同有效 file_id 时保留 SQLite 映射并导入旧库独有映射', async t => {
    const { dir, write } = fixture(t);
    const sharedKey = `${'a'.repeat(64)}:${'b'.repeat(64)}:3`;
    const legacyValue = { fileId: 'legacy-file', fileUniqueId: 'legacy-unique', size: 3, updatedAt: 100 };
    const currentValue = { fileId: 'current-file', fileUniqueId: 'current-unique', size: 3, updatedAt: 200 };
    write('telegram-chunk-file-ids.json', { version: 1, entries: { [sharedKey]: legacyValue, 'key-1': { fileId: 'tg-chunk-1', size: 3 } } });
    const repository = openDiskRepository(dir);
    repository.replace('chunk_ids', [{ key: sharedKey, value: currentValue }], item => item.key);

    const preview = await migrate({ dataDir: dir, apply: false });
    assert.equal(preview.report.find(item => item.table === 'chunk_ids').retainedExisting, 1);
    assert.equal(preview.report.find(item => item.table === 'chunk_ids').added, 1);
    assert.match(preview.warnings[0], /保留现有 SQLite 映射/);
    assert.deepEqual(repository.load('chunk_ids'), [{ key: sharedKey, value: currentValue }]);

    await migrate({ dataDir: dir, apply: true });
    assert.deepEqual(repository.load('chunk_ids').find(item => item.key === sharedKey).value, currentValue);
    assert.equal(repository.load('chunk_ids').find(item => item.key === 'key-1').value.fileId, 'tg-chunk-1');
    const repeated = await migrate({ dataDir: dir, apply: false });
    assert.equal(repeated.changed, false);
    repository.close();
});

test('分片缓存标识相同但大小与哈希键不符时仍拒绝导入', async t => {
    const { dir, write } = fixture(t);
    const sharedKey = `${'a'.repeat(64)}:${'b'.repeat(64)}:3`;
    write('telegram-chunk-file-ids.json', { version: 1, entries: { [sharedKey]: { fileId: 'legacy-file', size: 4 } } });
    const repository = openDiskRepository(dir);
    repository.replace('chunk_ids', [{ key: sharedKey, value: { fileId: 'current-file', size: 3 } }], item => item.key);
    await assert.rejects(migrate({ dataDir: dir, apply: false }), /内容不同/);
    assert.equal(repository.load('chunk_ids')[0].value.fileId, 'current-file');
    repository.close();
});

test('相同登录身份的新旧用户 ID 不同，旧文件、分享、任务、协同和缓存归属同步映射', async t => {
    const { dir, write } = fixture(t);
    const auth = JSON.parse(fs.readFileSync(path.join(dir, 'disk-auth.json'), 'utf8'));
    auth.users = auth.users.map((user, index) => ({ ...user, provider: 'telegram', telegramId: String(index + 100) }));
    write('disk-auth.json', auth);
    write('disk-space-usage.json', [{ appId: 'app-1', userId: 'u-2', diskSpace: 'archive', createdAt: 100, lastUsedAt: 200 }]);
    write('disk-operations.json', [{ operation_id: 'op-1', userId: 'u-1', status: 'completed', result: { ownerId: 'u-2' } }]);
    const repository = openDiskRepository(dir);
    repository.replace('users', auth.users.map((user, index) => ({ ...user, id: `current-${index + 1}`, createdAt: 150 })), item => item.id);
    repository.replace('space_usage', [{ appId: 'app-1', userId: 'current-2', diskSpace: 'archive', createdAt: 150, lastUsedAt: 300 }],
        item => `${item.appId}:${item.userId}:${item.diskSpace}`);

    const preview = await migrate({ dataDir: dir, apply: false });
    assert.match(preview.warnings[0], /旧数据引用已映射到现有用户/);
    assert.equal(preview.report.find(item => item.table === 'users').retainedExisting, 2);
    assert.equal(repository.load('files').length, 0);

    await migrate({ dataDir: dir, apply: true });
    assert.deepEqual(repository.load('users').map(item => item.id), ['current-1', 'current-2']);
    assert.equal(repository.load('files')[0].ownerId, 'current-1');
    assert.equal(repository.load('files', 'archive')[0].ownerId, 'current-2');
    assert.equal(repository.load('directories')[0].ownerId, 'current-1');
    assert.equal(repository.load('shares')[0].ownerId, 'current-1');
    assert.equal(repository.load('operations')[0].userId, 'current-1');
    assert.equal(repository.load('operations')[0].result.ownerId, 'current-2');
    assert.equal(repository.load('collaborations')[0].ownerId, 'current-1');
    assert.deepEqual(repository.load('collaborations')[0].members, ['current-2']);
    assert.equal(repository.load('cache_owners')[0].scopes[0].userId, 'current-1');
    assert.deepEqual(repository.load('space_usage')[0], { appId: 'app-1', userId: 'current-2', diskSpace: 'archive', createdAt: 100, lastUsedAt: 300 });
    assert.equal(createDiskCollaborationStore(dir).ownedTarget('current-1', '', 'file', 'f-1').id, 'collab-1');
    assert.equal((await migrate({ dataDir: dir, apply: false })).changed, false);
    repository.close();
});

test('旧用户 ID 与 SQLite 不同身份冲突时拒绝迁移', async t => {
    const { dir, write } = fixture(t);
    const auth = JSON.parse(fs.readFileSync(path.join(dir, 'disk-auth.json'), 'utf8'));
    auth.users[0] = { ...auth.users[0], provider: 'telegram', telegramId: '100' };
    write('disk-auth.json', auth);
    const repository = openDiskRepository(dir);
    repository.replace('users', [{ id: 'u-1', provider: 'telegram', telegramId: 'different', name: 'someone else' }], item => item.id);
    await assert.rejects(migrate({ dataDir: dir, apply: false }), /不同登录身份/);
    assert.deepEqual(repository.load('files'), []);
    repository.close();
});

test('SQL 唯一约束失败时包括协同数据在内的整个导入事务回滚', async t => {
    const { dir } = fixture(t);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-migration-scratch-'));
    t.after(() => {
        const relative = path.relative(os.tmpdir(), scratch);
        assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
        fs.rmSync(scratch, { recursive: true, force: true });
    });
    const repository = openDiskRepository(dir);
    repository.replace('files', [{ id: 'other-id', ownerId: 'u-1', folderPath: 'photos', name: 'one.jpg', size: 2, parts: [] }], item => item.id);
    await assert.rejects(migrate({ dataDir: dir, scratchDir: scratch, apply: false }), /UNIQUE constraint failed/);
    assert.deepEqual(fs.readdirSync(scratch), []);
    await assert.rejects(migrate({ dataDir: dir, apply: true }), /UNIQUE constraint failed/);
    assert.deepEqual(repository.load('files').map(item => item.id), ['other-id']);
    assert.deepEqual(repository.load('collaborations'), []);
    assert.deepEqual(repository.load('users'), []);
    const db = new DatabaseSync(path.join(dir, 'disk.sqlite'), { readOnly: true });
    assert.equal(db.prepare('SELECT count(*) AS n FROM disk_file_parts').get().n, 0);
    db.close();
    assert.equal(fs.existsSync(path.join(dir, 'migration-backups')), false);
    repository.close();
});

test('未列出的旧分区与缺失认证密钥在写入前明确报错', async t => {
    const { dir, write } = fixture(t);
    write('disk-spaces.json', []);
    await assert.rejects(migrate({ dataDir: dir, apply: true }), /未列于 disk-spaces.json/);
    assert.equal(fs.existsSync(path.join(dir, 'disk.sqlite')), false);
    write('disk-spaces.json', ['archive']);
    fs.unlinkSync(path.join(dir, 'disk-secret.key'));
    await assert.rejects(migrate({ dataDir: dir, apply: true }), /disk-secret.key/);
    assert.equal(fs.existsSync(path.join(dir, 'disk.sqlite')), false);
});

test('旧文件索引缺少 parts 字段时仍可导入并重复预检', async t => {
    const { dir, write, file } = fixture(t);
    const legacy = { ...file };
    delete legacy.parts;
    write('telegram-drive-index.json', [legacy]);
    await migrate({ dataDir: dir, apply: true });
    const second = await migrate({ dataDir: dir, apply: false });
    assert.equal(second.changed, false);
    assert.deepEqual(openDiskRepository(dir).load('files')[0].parts, []);
    openDiskRepository(dir).close();
});

test('正确长度但与认证 JSON 不配套的密钥在预检阶段拒绝', async t => {
    const { dir } = fixture(t);
    fs.writeFileSync(path.join(dir, 'disk-secret.key'), crypto.randomBytes(32));
    await assert.rejects(migrate({ dataDir: dir, apply: false }), /无法解密旧 Bot 凭据/);
    assert.equal(fs.existsSync(path.join(dir, 'disk.sqlite')), false);
});

test('正式导入中途报错时整个事务回滚', async t => {
    const { dir } = fixture(t);
    const repository = openDiskRepository(dir);
    const original = repository.replaceMany;
    repository.replaceMany = changes => {
        original([changes[0]]);
        throw new Error('模拟提交前中断');
    };
    try {
        await assert.rejects(migrate({ dataDir: dir, apply: true }), error => {
            assert.match(error.message, /模拟提交前中断/);
            const backupDir = error.message.split('备份目录：')[1];
            assert.ok(backupDir && fs.existsSync(path.join(backupDir, 'disk-before.sqlite')));
            assert.ok(fs.existsSync(path.join(backupDir, 'disk-auth.json')));
            return true;
        });
        assert.deepEqual(repository.load('spaces'), []);
        assert.deepEqual(repository.load('files'), []);
        assert.deepEqual(repository.load('collaborations'), []);
    } finally {
        repository.replaceMany = original;
        repository.close();
    }
});

test('预检列出缺失旧文件与历史孤儿关联，但保留原数据供核对', async t => {
    const { dir, write } = fixture(t);
    fs.unlinkSync(path.join(dir, 'telegram-part-cache', '.owners.json'));
    const auth = JSON.parse(fs.readFileSync(path.join(dir, 'disk-auth.json'), 'utf8'));
    auth.users = auth.users.filter(item => item.id !== 'u-2');
    write('disk-auth.json', auth);
    const collaborations = JSON.parse(fs.readFileSync(path.join(dir, 'disk-collaborations.json'), 'utf8'));
    collaborations[0].fileId = 'missing-file';
    write('disk-collaborations.json', collaborations);
    const result = await migrate({ dataDir: dir, apply: false });
    assert.ok(result.missing.includes('telegram-part-cache/.owners.json'));
    assert.equal(result.warnings.length, 2);
    assert.equal(fs.existsSync(path.join(dir, 'disk.sqlite')), false);
});
