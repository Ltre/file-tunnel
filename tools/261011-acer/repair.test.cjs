'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { main, convert } = require('./repair.cjs');
const { openDiskRepository } = require('../../server/disk-repository');
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acer-repair-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = new DatabaseSync(path.join(dir, 'disk.sqlite'));
    db.exec(`CREATE TABLE disk_schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO disk_schema_migrations VALUES(1),(2),(3);
        CREATE TABLE disk_files(scope TEXT NOT NULL,id TEXT NOT NULL,owner_id TEXT NOT NULL,folder_path TEXT NOT NULL,name TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id));
        CREATE TABLE disk_file_parts(scope TEXT NOT NULL,file_id TEXT NOT NULL,part_index INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,file_id,part_index));
        CREATE TABLE disk_contents(scope TEXT NOT NULL DEFAULT '',id TEXT NOT NULL,owner_id TEXT NOT NULL DEFAULT '',folder_path TEXT NOT NULL DEFAULT '',name TEXT NOT NULL DEFAULT '',payload TEXT NOT NULL,PRIMARY KEY(scope,id));
        CREATE TABLE disk_content_parts(scope TEXT NOT NULL DEFAULT '',content_id TEXT NOT NULL,part_index INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,content_id,part_index),FOREIGN KEY(scope,content_id) REFERENCES disk_contents(scope,id));
        CREATE TABLE disk_shares(scope TEXT NOT NULL,id TEXT NOT NULL,owner_id TEXT NOT NULL,folder_path TEXT NOT NULL,name TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope,id));`);
    db.prepare('INSERT INTO disk_shares VALUES(?,?,?,?,?,?)').run('', 'share', 'owner', '', '', JSON.stringify({token:'token', files:[{id:'f0'}]}));
    for (const [i, scope] of ['', 'other'].entries()) {
        const part = { offset:0, size:3, fileId:'remote' + i, messageId:100 + i };
        const file = { id:'f' + i, ownerId:'owner', name:'file' + i, folderPath:'', size:3, contentId:'same-id', createdAt:123, channelId:'-100', pendingRemoteCleanup:[{channelId:'-100',parts:[part]}] };
        const content = { id:'same-id', size:3, state:'READY', originalName:'old', channelId:'-100', backendId:'', createdAt:123, contentSha256:'a'.repeat(64) };
        db.prepare('INSERT INTO disk_files VALUES(?,?,?,?,?,?)').run(scope,file.id,'owner','',file.name,JSON.stringify(file));
        db.prepare('INSERT INTO disk_contents VALUES(?,?,?,?,?,?)').run(scope,'same-id','','','',JSON.stringify(content));
        db.prepare('INSERT INTO disk_file_parts VALUES(?,?,?,?)').run(scope,file.id,0,JSON.stringify(part));
        db.prepare('INSERT INTO disk_content_parts VALUES(?,?,?,?)').run(scope,'same-id',0,JSON.stringify(part));
    }
    db.close(); return dir;
}
test('dry-run leaves original intact; apply backs up, preserves locations, scopes and shares; rerun is inert', async t => {
    const dir = fixture(t), filename = path.join(dir, 'disk.sqlite'), original = fs.readFileSync(filename);
    const dry = await main(['--data-dir',dir]);
    assert.equal(dry.startupVerified,true); assert.equal(dry.rehearsal.liveFiles,2);
    assert.deepEqual(fs.readFileSync(filename),original);
    await assert.rejects(main(['--data-dir',dir,'--apply']),/service-stopped/);
    const result = await main(['--data-dir',dir,'--apply','--service-stopped']);
    const saved = new DatabaseSync(result.backup,{readOnly:true});
    assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM disk_contents').get().n,2);
    assert.ok(saved.prepare('PRAGMA table_info(disk_contents)').all().some(c=>c.name==='payload')); saved.close();
    const db = new DatabaseSync(filename,{readOnly:true});
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acer_261011_contents').get().n,2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acer_261011_parts').get().n,2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acer_261011_files').get().n,2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM disk_content_cleanup').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM disk_content_keys').get().n,0);
    assert.equal(db.prepare('SELECT payload FROM disk_shares').get().payload,JSON.stringify({token:'token',files:[{id:'f0'}]}));
    db.close();
    const repository = openDiskRepository(dir);
    try {
        repository.assertIntegrity();
        const first=repository.load('files','')[0],second=repository.load('files','other')[0];
        assert.equal(first.id,'f0'); assert.equal(second.id,'f1');
        assert.equal(first.parts[0].fileId,'remote0'); assert.equal(second.parts[0].messageId,101);
        assert.notEqual(first.contentId,second.contentId);
    } finally { repository.close(); }
    const repaired = fs.readFileSync(filename);
    assert.equal((await main(['--data-dir',dir,'--apply','--service-stopped'])).mode,'already-repaired');
    assert.deepEqual(fs.readFileSync(filename),repaired);
});
test('failed conversion rolls back table renames and payload updates', t => {
    const dir=fixture(t),db=new DatabaseSync(path.join(dir,'disk.sqlite'));
    // Abort after the schema is renamed, not just during preflight.
    db.exec("CREATE TRIGGER injected_failure BEFORE UPDATE ON disk_files BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    assert.throws(()=>convert(db,dir),/injected failure/);
    assert.ok(db.prepare('PRAGMA table_info(disk_contents)').all().some(c=>c.name==='payload'));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='acer_261011_contents'").get().n,0);
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM disk_files LIMIT 1').get().payload).contentId,'same-id');
    db.close();
});
test('missing referenced content fails before writing', async t => {
    const dir=fixture(t),filename=path.join(dir,'disk.sqlite');
    let db=new DatabaseSync(filename); db.exec("DELETE FROM disk_content_parts WHERE scope='other'; DELETE FROM disk_contents WHERE scope='other'"); db.close();
    const bytes=fs.readFileSync(filename);
    await assert.rejects(main(['--data-dir',dir]),/Missing legacy content/);
    assert.deepEqual(fs.readFileSync(filename),bytes);
});
test('incomplete physical layout is rejected without touching original database', async t => {
    const dir=fixture(t),filename=path.join(dir,'disk.sqlite');
    const db=new DatabaseSync(filename);
    db.prepare("UPDATE disk_content_parts SET payload=? WHERE scope='other'").run(JSON.stringify({offset:0,size:2,fileId:'remote1',messageId:101}));
    db.close(); const bytes=fs.readFileSync(filename);
    await assert.rejects(main(['--data-dir',dir]),/Incomplete physical parts/);
    assert.deepEqual(fs.readFileSync(filename),bytes);
});
