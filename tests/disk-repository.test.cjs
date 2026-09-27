'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDiskRepository } = require('../server/disk-repository');
const { createTelegramDriveStore } = require('../server/telegram-drive');

test('网盘文件、目录和分片在同一 WAL 事务中保存；失败时全部回滚', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-repository-'));
    t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
    const repository = openDiskRepository(dir);
    const db = new DatabaseSync(repository.filename, { readOnly:true });
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    db.close();
    const file = { id:'file-1', ownerId:'alice', folderPath:'A', name:'one.bin', size:3,
        parts:[{ partIndex:1, fileId:'tg-part-1', size:3 }] };
    const directory = { ownerId:'alice', path:'A', name:'A' };
    repository.replaceMany([
        { table:'files', scope:'space-1', items:[file], keyOf:item => item.id },
        { table:'directories', scope:'space-1', items:[directory], keyOf:item => `${item.ownerId}:${item.path}` }
    ]);
    assert.deepEqual(repository.load('files', 'space-1'), [file]);
    assert.deepEqual(repository.load('directories', 'space-1'), [directory]);
    assert.deepEqual(repository.load('files', 'space-2'), []);
    const partsBefore = new DatabaseSync(repository.filename, { readOnly:true });
    assert.equal(partsBefore.prepare('SELECT count(*) AS count FROM disk_file_parts').get().count, 1);
    partsBefore.close();
    assert.throws(() => repository.replaceMany([
        { table:'files', scope:'space-1', items:[{ ...file, name:'changed.bin' }], keyOf:item => item.id },
        { table:'directories', scope:'space-1', items:[directory, directory], keyOf:item => `${item.ownerId}:${item.path}` }
    ]), /DISK_RECORD_KEY_INVALID/);
    assert.deepEqual(repository.load('files', 'space-1'), [file]);
    assert.deepEqual(repository.load('directories', 'space-1'), [directory]);
    repository.replaceMany([{ table:'files', scope:'space-1', items:[], keyOf:item => item.id }]);
    const partsAfter = new DatabaseSync(repository.filename, { readOnly:true });
    assert.equal(partsAfter.prepare('SELECT count(*) AS count FROM disk_file_parts').get().count, 0);
    partsAfter.close();
    assert.equal(fs.existsSync(path.join(dir, 'telegram-drive-index.json')), false);
});

test('网盘仓库在线备份包含尚未 checkpoint 的 WAL 数据', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-backup-'));
    t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
    const repository = openDiskRepository(dir);
    repository.replace('operations', [{ operation_id:'job-1', userId:'alice', status:'completed' }], item => item.operation_id);
    const backup = path.join(dir, 'backup.sqlite');
    await repository.backup(backup);
    const copy = new DatabaseSync(backup, { readOnly:true });
    try { assert.equal(JSON.parse(copy.prepare('SELECT payload FROM disk_operations WHERE id = ?').get('job-1').payload).userId, 'alice'); }
    finally { copy.close(); }
    const restoredDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-restored-'));
    t.after(() => fs.rmSync(restoredDir, { recursive:true, force:true }));
    fs.copyFileSync(backup, path.join(restoredDir, 'disk.sqlite'));
    assert.equal(openDiskRepository(restoredDir).load('operations')[0].operation_id, 'job-1');
});

test('并存的旧内存视图不能抹掉其它用户新写入的目录', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-writers-'));
    t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
    const first = createTelegramDriveStore({ dataDir:dir });
    const second = createTelegramDriveStore({ dataDir:dir });
    first.createDirectory('alice', 'A', 20);
    second.createDirectory('bob', 'B', 20);
    const reopened = createTelegramDriveStore({ dataDir:dir });
    assert.ok(reopened.listDirectories('alice').some(item => item.path === 'A'));
    assert.ok(reopened.listDirectories('bob').some(item => item.path === 'B'));
    assert.throws(() => second.createDirectory('alice', 'A', 20), /DISK_WRITE_CONFLICT/);
    assert.ok(second.listDirectories('alice').some(item => item.path === 'A'));
});

test('旧版本服务不会写入更高版本的网盘数据库', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-schema-version-'));
    t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
    const repository = openDiskRepository(dir);
    const db = new DatabaseSync(repository.filename);
    db.exec('INSERT INTO disk_schema_migrations(version) VALUES (2)');
    db.close();
    repository.close();
    assert.throws(() => openDiskRepository(dir), /DISK_SCHEMA_TOO_NEW/);
});
