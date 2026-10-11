'use strict';
// Dedicated bridge for Acer's scope/payload Content Object schema. No network calls.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { DatabaseSync, backup } = require('node:sqlite');
const { migrateContentSchema, createContentRepository, physicalRecord, representationSignature } = require('../../server/disk-content-repository');
const { openDiskRepository } = require('../../server/disk-repository');
const prefix = 'acer_261011_';
const key = (scope, id) => JSON.stringify([scope, id]);
function has(db, name) { return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name); }
function check(db) {
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check), ['ok'], 'SQLite integrity check failed');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'SQLite foreign keys invalid');
}
function inspect(db) {
    check(db);
    const cols = db.prepare('PRAGMA table_info(disk_contents)').all().map(r => r.name);
    if (has(db, prefix + 'contents') && cols.includes('state') && has(db, 'disk_content_refs')) return { status: 'already-repaired' };
    assert.ok(cols.includes('scope') && cols.includes('payload') && !cols.includes('state'), 'Unsupported schema: expected Acer legacy scope/payload contents');
    assert.deepEqual(db.prepare('PRAGMA table_info(disk_content_parts)').all().map(r => r.name).sort(), ['scope', 'content_id', 'part_index', 'payload'].sort(), 'Unsupported legacy parts schema');
    const related = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'disk_content%'").all().map(r => r.name);
    assert.deepEqual(related.sort(), ['disk_contents', 'disk_content_parts'].sort(), 'Mixed legacy/new Content schema: refuse repair');
    const version = db.prepare('SELECT MAX(version) AS n FROM disk_schema_migrations').get().n;
    assert.equal(version, 3, 'This tool expects Acer legacy schema version 3');
    for (const name of ['contents', 'parts', 'files']) assert.ok(!has(db, prefix + name), 'Archive name already exists');
    const contents = new Map(db.prepare('SELECT scope,id,payload FROM disk_contents').all().map(r => [key(r.scope, r.id), JSON.parse(r.payload)]));
    const files = db.prepare('SELECT scope,id,payload FROM disk_files ORDER BY scope,id').all();
    const plan = [];
    for (const row of files) {
        const file = JSON.parse(row.payload);
        assert.equal(file.id, row.id, 'Logical file identity mismatch');
        if (file.reviewStatus === 'deleted') continue;
        const old = file.contentId ? contents.get(key(row.scope, file.contentId)) : null;
        if (file.contentId) {
            assert.ok(old, 'Missing legacy content');
            assert.equal(old.state, 'READY', 'Referenced legacy content is not READY; manual review required');
            assert.equal(old.size, file.size, 'Legacy content size mismatch');
        }
        const parts = db.prepare(old ? 'SELECT payload FROM disk_content_parts WHERE scope=? AND content_id=? ORDER BY part_index' : 'SELECT payload FROM disk_file_parts WHERE scope=? AND file_id=? ORDER BY part_index').all(row.scope, old ? file.contentId : row.id).map(r => JSON.parse(r.payload));
        const hydrated = { ...file, ...(old ? { backendId: old.backendId || '', channelId: old.channelId, thumbnail: old.thumbnail, mediaIndex: old.mediaIndex } : {}), parts };
        assert.ok(Number.isSafeInteger(hydrated.size) && hydrated.size >= 0, 'Invalid size');
        if (hydrated.size > 0) {
            assert.ok(hydrated.channelId && parts.length, 'Missing physical location');
            let end = 0;
            for (const part of parts) {
                assert.equal(part.offset, end, 'Invalid part offset');
                assert.ok(Number.isSafeInteger(part.size) && part.size > 0 && part.fileId && Number.isSafeInteger(part.messageId) && part.messageId > 0, 'Invalid physical part');
                end += part.size;
            }
            assert.equal(end, hydrated.size, 'Incomplete physical parts');
        }
        // Historical hashes are preserved in archives, never promoted to verified keys.
        delete hydrated.contentSha256;
        delete hydrated.contentId;
        delete hydrated.logicalContentVersion;
        hydrated.pendingRemoteCleanup = [];
        hydrated.fileIdHistory = [];
        hydrated.contentCandidateId = 'acer-261011-' + crypto.createHash('sha256').update(key(row.scope, file.contentId || row.id)).digest('hex');
        plan.push({ scope: row.scope, id: row.id, file: hydrated, physical: physicalRecord(hydrated) });
    }
    return { status: 'repair-required', files: files.length, liveFiles: plan.length, legacyContents: contents.size, plan };
}
function convert(db, dataDir) {
    if (!db.isTransaction) db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
        const before = inspect(db);
        if (before.status === 'already-repaired') { db.exec('ROLLBACK'); return before; }
        // Renaming keeps the old parts foreign key pointing at the archived contents.
        db.exec(`ALTER TABLE disk_contents RENAME TO ${prefix}contents;
            ALTER TABLE disk_content_parts RENAME TO ${prefix}parts;
            CREATE TABLE ${prefix}files AS SELECT * FROM disk_files;`);
        migrateContentSchema(db);
        const content = createContentRepository(work => work(db), { dataDir });
        for (const item of before.plan) {
            content.syncFile(db, item.scope, item.file);
            const payload = content.strip(item.file);
            payload.__partsHash = representationSignature(item.file);
            db.prepare('UPDATE disk_files SET payload=? WHERE scope=? AND id=?').run(JSON.stringify(payload), item.scope, item.id);
            const stored = JSON.parse(db.prepare('SELECT payload FROM disk_files WHERE scope=? AND id=?').get(item.scope, item.id).payload);
            assert.deepEqual(physicalRecord(content.project(db, stored, item.scope)), item.physical, 'Physical representation changed');
        }
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM disk_content_refs').get().n, before.liveFiles);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM disk_files').get().n, before.files);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM disk_content_cleanup').get().n, 0, 'Repair must not schedule remote cleanup');
        check(db);
        db.exec('COMMIT');
        return { status: 'converted', files: before.files, liveFiles: before.liveFiles, legacyContents: before.legacyContents, contents: db.prepare('SELECT COUNT(*) AS n FROM disk_contents').get().n, conflicts: db.prepare("SELECT COUNT(*) AS n FROM disk_contents WHERE hash_status='anchor_conflict'").get().n };
    } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
}
async function main(argv = process.argv.slice(2)) {
    let dir = path.resolve(process.env.TUNNEL_DATA_DIR || '.tunnel-data'), apply = false, stopped = false;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--data-dir') { assert.ok(argv[i + 1] && !argv[i + 1].startsWith('--'), 'Missing --data-dir'); dir = path.resolve(argv[++i]); }
        else if (argv[i] === '--apply') apply = true;
        else if (argv[i] === '--service-stopped') stopped = true;
        else if (argv[i] !== '--dry-run') throw new Error('Unknown argument: ' + argv[i]);
    }
    assert.ok(!apply || stopped, '--apply requires --service-stopped (stop all service instances first)');
    const filename = path.join(dir, 'disk.sqlite');
    assert.ok(fs.statSync(filename, { throwIfNoEntry: false })?.isFile(), 'Existing disk.sqlite required');
    const source = new DatabaseSync(filename, { readOnly: true });
    let temp, result;
    try {
        const before = inspect(source);
        if (before.status === 'already-repaired') return { mode: 'already-repaired', database: filename };
        temp = fs.mkdtempSync(path.join(os.tmpdir(), '261011-acer-'));
        const scratch = path.join(temp, 'disk.sqlite');
        await backup(source, scratch);
        // Include administrator chat aliases for the same startup guards.
        const dictionary = path.join(dir, 'telegram-chat-dictionary.json');
        if (fs.statSync(dictionary, { throwIfNoEntry: false })?.isFile()) fs.copyFileSync(dictionary, path.join(temp, 'telegram-chat-dictionary.json'));
        const trial = new DatabaseSync(scratch);
        try { result = convert(trial, temp); } finally { trial.close(); }
        const repository = openDiskRepository(temp);
        try { repository.assertIntegrity(); repository.load('files'); repository.checkpoint(); } finally { repository.close(); }
        if (!apply) return { mode: 'dry-run', database: filename, rehearsal: result, startupVerified: true };
        const backups = path.join(dir, 'migration-backups'); fs.mkdirSync(backups, { recursive: true });
        const backupFile = path.join(backups, '261011-acer-' + Date.now() + '-' + crypto.randomUUID() + '.sqlite');
        // Hold a write lock from backup through conversion; revalidate current state.
        const target = new DatabaseSync(filename);
        try {
            target.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
            inspect(target);
            await backup(source, backupFile);
            const saved = new DatabaseSync(backupFile, { readOnly: true });
            try { check(saved); } finally { saved.close(); }
            result = convert(target, dir);
        } finally { if (target.isTransaction) target.exec('ROLLBACK'); target.close(); }
        return { mode: 'applied', database: filename, backup: backupFile, result, nextStep: 'Run the standard content migration dry-run, then start the service to complete schema v5 initialization.' };
    } finally {
        source.close();
        if (temp && path.dirname(temp) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('261011-acer-')) fs.rmSync(temp, { recursive: true, force: true });
    }
}
if (require.main === module) main().then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error('261011-acer repair failed: ' + e.message); process.exitCode = 1; });
module.exports = { main, convert };
