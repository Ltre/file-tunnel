'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { openDiskRepository } = require('../server/disk-repository');
const { main, args } = require('../tools/change-tgdisk-channel-id.cjs');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-channel-'));
    const repository = openDiskRepository(dir);
    t.after(() => { repository.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const flags = ['--data-dir', dir, '--chat-id', '-1001234567890'];
    return { dir, repository, flags };
}

test('参数缺值明确拒绝，环境变量为默认目录且显式目录优先', () => {
    assert.throws(() => args(['--data-dir']), /--data-dir 缺少参数值/);
    assert.throws(() => args(['--data-dir', '--chat-id', '-1001234567890']), /--data-dir 缺少参数值/);
    assert.throws(() => args(['--chat-id']), /--chat-id 缺少参数值/);
    assert.throws(() => args(['--chat-id', '--apply']), /--chat-id 缺少参数值/);
    const env = { TUNNEL_DATA_DIR: 'configured-data' };
    assert.equal(args(['--chat-id', '-1001234567890'], env).dataDir, path.resolve(env.TUNNEL_DATA_DIR));
    assert.equal(args(['--chat-id', '-1001234567890', '--data-dir', 'explicit-data'], env).dataDir, path.resolve('explicit-data'));
    assert.equal(args(['--chat-id', '-1001234567890'], {}).dataDir, path.resolve('.tunnel-data'));
});

test('预演连接真正只读，空网盘给出无需修改提示', async t => {
    const { dir, flags } = fixture(t);
    const before = fs.readFileSync(path.join(dir, 'disk.sqlite'));
    const originalExec = DatabaseSync.prototype.exec;
    let checked = 0;
    DatabaseSync.prototype.exec = function(sql) {
        if (sql === 'PRAGMA busy_timeout = 5000') {
            assert.throws(() => originalExec.call(this, 'CREATE TABLE forbidden_dry_run_write (id INTEGER)'), /readonly|read-only/i);
            checked++;
        }
        return originalExec.call(this, sql);
    };
    let report;
    try { report = await main(flags); }
    finally { DatabaseSync.prototype.exec = originalExec; }
    assert.equal(checked, 1);
    assert.equal(report.totalFiles, 0);
    assert.equal(report.status, 'empty');
    assert.equal(report.migrationRequired, false);
    assert.match(report.message, /无需修改/);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'disk.sqlite')), before);
    assert.equal(fs.existsSync(path.join(dir, 'migration-backups')), false);
    assert.equal((await main([...flags, '--service-stopped', '--apply'])).changed, 0);
});

test('错误数据目录或缺失数据库不会创建新数据库', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-channel-missing-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    await assert.rejects(main(['--data-dir', dir, '--chat-id', '-1001234567890']), /找不到网盘 SQLite 数据库/);
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('空 SQLite 检出默认和命名分区旧记录，阻止假成功且不改旧数据', async t => {
    const { dir, repository, flags } = fixture(t);
    const legacyFile = { id: 'legacy', ownerId: 'owner', name: 'legacy.txt', channelId: '@old' };
    const named = '相册';
    const hash = crypto.createHash('sha256').update(named).digest('hex');
    const partition = path.join(dir, 'disk-spaces', hash);
    fs.mkdirSync(partition, { recursive: true });
    fs.writeFileSync(path.join(dir, 'disk-spaces.json'), JSON.stringify([named]));
    fs.writeFileSync(path.join(dir, 'telegram-drive-index.json'), JSON.stringify([legacyFile]));
    fs.writeFileSync(path.join(partition, 'telegram-drive-index.json'), JSON.stringify([{ ...legacyFile, id: 'other' }]));
    const before = fs.readFileSync(path.join(dir, 'telegram-drive-index.json'));
    const report = await main(flags);
    assert.equal(report.totalFiles, 0);
    assert.equal(report.legacyTotalFiles, 2);
    assert.equal(report.migrationRequired, true);
    assert.equal(report.status, 'legacy-json-not-imported');
    assert.deepEqual(report.legacyIndexes.map(entry => [entry.scope, entry.records]), [['', 1], [named, 1]]);
    assert.match(report.nextStep, /migrate-tgdisk-json-to-sqlite/);
    await assert.rejects(main([...flags, '--service-stopped', '--apply']), error => {
        assert.equal(error.code, 'DISK_LEGACY_MIGRATION_REQUIRED');
        assert.equal(error.report.mode, 'blocked');
        return true;
    });
    assert.deepEqual(fs.readFileSync(path.join(dir, 'telegram-drive-index.json')), before);
    assert.equal(repository.load('files').length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'migration-backups')), false);
});

test('缺失分区清单仍检出旧索引，不猜分区名称', async t => {
    const { dir, flags } = fixture(t);
    const partition = path.join(dir, 'disk-spaces', 'a'.repeat(64));
    fs.mkdirSync(partition, { recursive: true });
    fs.writeFileSync(path.join(partition, 'telegram-drive-index.json'), JSON.stringify([{ id: 'a', ownerId: 'u', name: 'a' }]));
    const report = await main(flags);
    assert.equal(report.legacyTotalFiles, 1);
    assert.equal(report.legacyIndexes[0].scope, null);
    assert.ok(report.warnings.some(message => /无法从 disk-spaces.json/.test(message)));
    await assert.rejects(main([...flags, '--service-stopped', '--apply']), /旧 JSON 文件记录/);
});

test('旧索引损坏或不是普通文件时预演明确警告并拒绝执行', async t => {
    const { dir, flags } = fixture(t);
    const index = path.join(dir, 'telegram-drive-index.json');
    fs.writeFileSync(index, '{invalid');
    assert.equal((await main(flags)).status, 'legacy-inspection-incomplete');
    await assert.rejects(main([...flags, '--service-stopped', '--apply']), error => error.code === 'DISK_LEGACY_INSPECTION_INCOMPLETE');
    assert.equal(fs.readFileSync(index, 'utf8'), '{invalid');
    fs.rmSync(index);
    fs.mkdirSync(index);
    const report = await main(flags);
    assert.equal(report.legacyIndexes[0].records, null);
    assert.ok(report.warnings.some(message => /不是普通文件/.test(message)));
    await assert.rejects(main([...flags, '--service-stopped', '--apply']), /旧索引检查未完成/);
});

test('JSON null 不是合法旧文件索引或分区清单，不能误报空网盘', async t => {
    const { dir, flags } = fixture(t);
    const index = path.join(dir, 'telegram-drive-index.json');
    fs.writeFileSync(index, 'null');
    const indexReport = await main(flags);
    assert.equal(indexReport.status, 'legacy-inspection-incomplete');
    assert.ok(indexReport.warnings.some(message => /文件索引格式无效/.test(message)));
    await assert.rejects(main([...flags, '--service-stopped', '--apply']), error => error.code === 'DISK_LEGACY_INSPECTION_INCOMPLETE');
    assert.equal(fs.readFileSync(index, 'utf8'), 'null');
    fs.writeFileSync(index, '[]');
    fs.writeFileSync(path.join(dir, 'disk-spaces.json'), 'null');
    const spacesReport = await main(flags);
    assert.equal(spacesReport.status, 'legacy-inspection-incomplete');
    assert.ok(spacesReport.warnings.some(message => /分区清单格式无效/.test(message)));
    await assert.rejects(main([...flags, '--service-stopped', '--apply']), error => error.code === 'DISK_LEGACY_INSPECTION_INCOMPLETE');
});

test('数据库缺少网盘文件表时明确报错而不创建 schema', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-channel-schema-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, 'disk.sqlite');
    const database = new DatabaseSync(filename);
    database.exec('CREATE TABLE unrelated (id INTEGER)');
    database.close();
    const before = fs.readFileSync(filename);
    const flags = ['--data-dir', dir, '--chat-id', '-1001234567890'];
    await assert.rejects(main(flags), /缺少网盘 disk_files 表.*本工具不会创建表/);
    await assert.rejects(main([...flags, '--service-stopped', '--apply']), /请检查数据目录.*SQLite schema/);
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.equal(fs.existsSync(path.join(dir, 'migration-backups')), false);
});

test('频道 ID 迁移预演不写入，停服确认后跨分区事务更新且保留分片', async t => {
    const { dir, repository, flags } = fixture(t);
    const part = { fileId: 'telegram-file', messageId: 42, size: 3, offset: 0, partIndex: 1, partCount: 1 };
    repository.replace('files', [{ id: 'a', ownerId: 'u', folderPath: '', name: 'a.txt', channelId: '@old', parts: [part], pendingRemoteCleanup: [{ channelId: '@old', messageId: 40, parts: [part] }] }], file => file.id);
    repository.replace('files', [{ id: 'b', ownerId: 'v', folderPath: '', name: 'b.txt', channelId: '-1002222222222', parts: [{...part,messageId:43}] }], file => file.id, 'photos');
    // Successfully migrated installations normally retain old JSON; it must not
    // prevent changing the live SQLite records, even if the old file is stale.
    fs.writeFileSync(path.join(dir, 'telegram-drive-index.json'), '{stale-old-json');
    const before = await main(flags);
    assert.equal(before.mode, 'dry-run'); assert.equal(before.changed, 2);
    assert.equal(repository.load('files')[0].channelId, '@old');
    await assert.rejects(main([...flags, '--apply']), /service-stopped/);
    const applied = await main([...flags, '--service-stopped', '--apply']);
    assert.equal(applied.changed, 2); assert.ok(fs.existsSync(applied.backup));
    assert.equal(repository.load('files')[0].channelId, '-1001234567890');
    assert.equal(repository.content.withDatabase(db=>JSON.parse(db.prepare("SELECT payload FROM disk_content_cleanup WHERE purpose='legacy-debt'").get().payload).channelId),'-1001234567890');
    assert.equal(repository.load('files', 'photos')[0].channelId, '-1001234567890');
    assert.equal(repository.load('files')[0].parts[0].fileId,part.fileId);
    assert.equal(repository.load('files')[0].parts[0].messageId,part.messageId);
    assert.equal(fs.readFileSync(path.join(dir, 'telegram-drive-index.json'), 'utf8'), '{stale-old-json');
    assert.equal((await main([...flags, '--service-stopped', '--apply'])).changed, 0);
});
