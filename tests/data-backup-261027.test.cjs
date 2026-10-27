'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const { createDataBackup, registerDataBackup, relativePath } = require('../server/data-backup');

async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-test-')), dataDir = path.join(root, 'data'); await fs.mkdir(dataDir);
    const objects = new Map(), directories = new Set(['backups']), calls = []; let failName = '', blocker = null;
    const storage = {
        resolveTarget: async target => { if (target.userId !== 'owner' || target.partitionId !== 'part') throw new Error('BACKUP_USER_NOT_FOUND'); return { ...target, userName: '测试备份账号', loginId: '999000001', partitionName: 'FULL', diskSpace: 'full' }; },
        listDirectories: async () => [...directories],
        mkdir: async (_target, folder) => { directories.add(folder); },
        stat: async (_target, key) => objects.get(key) || null,
        put: async (_target, key, input, info) => {
            if (blocker) await blocker(info.signal);
            if (failName && key.endsWith(failName)) { failName = ''; throw new Error('SIMULATED_SAVE_FAILED'); }
            const chunks = []; for await (const bytes of input) chunks.push(bytes); const body = Buffer.concat(chunks);
            assert.equal(body.length, info.size); assert.equal(crypto.createHash('sha256').update(body).digest('hex'), info.expectedSha256);
            info.onProgress?.({ percent: 100, phase: 'index', detail: '网盘索引已保存' });
            const object = { size: body.length, body, file: { id: crypto.randomUUID(), metadata: info.metadata } }; objects.set(key, object); calls.push(key); return object;
        }
    };
    const service = createDataBackup({ dataDir, storage, tempDir: root, now: () => new Date(2026, 9, 27, 12).getTime(), ...options });
    await service.configure('full', { userId: 'owner', partitionId: 'part', folderPath: '/backups' });
    await service.configure('core', { userId: 'owner', partitionId: 'part', folderPath: '/backups' });
    t.after(async () => { service.close(); await service.wait(); await fs.rm(root, { recursive: true, force: true }); });
    return { root, dataDir, service, objects, directories, calls, storage, failOnce(name) { failName = name; }, block(fn) { blocker = fn; },
        async put(name, body = name) { await fs.mkdir(path.dirname(path.join(dataDir, name)), { recursive: true }); await fs.writeFile(path.join(dataDir, name), body); },
        manifest() { return JSON.parse([...objects.entries()].find(([key]) => key.endsWith('/backup-manifest.json'))[1].body); } };
}
test('FULL snapshots all source content except the three disposable cache directories, preserves empty files and numbered versions', async t => {
    const f = await fixture(t);
    await f.put('ordinary.json', '{"ok":true}'); await f.put('another-business/item.txt'); await f.put('empty.bin', '');
    for (const folder of ['telegram-content-cache', 'telegram-drive-staging', 'telegram-part-cache']) await f.put(folder + '/discard.bin');
    const first = await f.service.start({ mode: 'full', requestId: 'full-first-1234' }); await f.service.wait();
    const job = f.service.state().jobs[0]; assert.equal(job.status, 'completed'); assert.equal(job.folder, 'backups/1-20261027'); assert.equal(job.completedFiles, job.totalFiles);
    const manifest = f.manifest(); assert.equal(manifest.status, 'completed'); assert.ok(manifest.files.some(file => file.name === 'another-business/item.txt'));
    assert.ok(manifest.files.some(file => file.name === 'empty.bin' && file.size === 0)); assert.equal(manifest.files.some(file => /discard.bin$/.test(file.name)), false);
    assert.equal(manifest.excluded.length, 3); assert.ok(manifest.files.every(file => file.segments.every(part => part.fileId && part.done && part.sha256)));
    assert.match(manifest.note, /cannot index its newly saved files/);
    assert.equal((await f.service.start({ mode: 'full', requestId: 'full-first-1234' })).id, first.id); assert.equal(f.service.state().jobs.length, 1);
    await f.service.start({ mode: 'full', requestId: 'full-second-1234' }); await f.service.wait(); assert.equal(f.service.state().jobs[1].folder, 'backups/2-20261027');
});
test('CORE includes every root file and the four specified directories, not unrelated subdirectories', async t => {
    const f = await fixture(t); await f.put('.private-key', 'sensitive'); await f.put('some-cookies.txt'); await f.put('new-unlisted-file.dat');
    for (const dir of ['disk-spaces', 'streaming-console', 'youtube-premium-downloads', 'sns-downloads']) await f.put(dir + '/content.dat');
    await f.put('other-business/out.txt'); await f.service.start({ mode: 'core', requestId: 'core-request-1234' }); await f.service.wait();
    const names = f.manifest().files.map(file => file.name); assert.ok(names.includes('.private-key')); assert.ok(names.includes('new-unlisted-file.dat')); assert.ok(names.includes('sns-downloads/content.dat')); assert.equal(names.includes('other-business/out.txt'), false);
});

test('Windows state replacement retries transient locks without interrupting the backup', async t => {
    const f = await fixture(t); await f.put('readable.txt');
    const rename = fs.rename; let locks = 2;
    fs.rename = async (from, to) => { if (to === path.join(f.dataDir, '.system-backup-state.json') && locks-- > 0) throw Object.assign(Error('state locked'), { code: 'EPERM' }); return rename(from, to); };
    try { await f.service.start({ mode: 'core', requestId: 'locked-state-261027' }); await f.service.wait(); }
    finally { fs.rename = rename; }
    assert.ok(locks < 0, 'the backup must use the retrying asynchronous state writer');
    assert.equal(f.service.state().jobs[0].status, 'completed');
});

test('unreadable source files are skipped with a manifest report, readable files still save', async t => {
    const f = await fixture(t); await f.put('denied.bin'); await f.put('readable.txt');
    const open = fs.open;
    fs.open = async (file, ...args) => { if (file === path.join(f.dataDir, 'denied.bin')) throw Object.assign(Error('source denied'), { code: 'EACCES' }); return open(file, ...args); };
    try { await f.service.start({ mode: 'core', requestId: 'source-denied-261027' }); await f.service.wait(); }
    finally { fs.open = open; }
    const job = f.service.state().jobs[0]; assert.equal(job.status, 'completed', job.error);
    assert.ok(f.manifest().files.some(file => file.name === 'readable.txt'));
    assert.deepEqual(f.manifest().skipped.map(item => [item.name, item.code]), [['denied.bin', 'EACCES']]);
    assert.equal(job.skipped.length, 1);
});

test('persistent state write failure is reported separately and leaves a retryable job',async t=>{
    const f=await fixture(t);await f.put('readable.txt');const rename=fs.rename;
    fs.rename=async(from,to)=>{if(to===path.join(f.dataDir,'.system-backup-state.json'))throw Object.assign(Error('state denied'),{code:'EPERM'});return rename(from,to);};
    try{await assert.rejects(f.service.start({mode:'core',requestId:'permanent-state-261027'}),/BACKUP_STATE_WRITE_FAILED/);await f.service.wait();}
    finally{fs.rename=rename;}
    const job=f.service.state().jobs[0];assert.equal(job.status,'failed');assert.equal(job.currentFile,'');assert.equal(job.skipped.length,0);assert.equal(f.objects.size,0);
    await f.service.retry(job.id);await f.service.wait();assert.equal(f.service.state().jobs[0].status,'completed');
});
test('SQLite online snapshot includes committed WAL and omits sidecars rather than copying an inconsistent triple', async t => {
    const f = await fixture(t), dbPath = path.join(f.dataDir, 'live.sqlite'), db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(value TEXT); INSERT INTO records VALUES (\'latest committed WAL value\')');
    try {
        assert.ok((await fs.stat(dbPath + '-wal')).size > 0);
        await f.service.start({ mode: 'core', requestId: 'sqlite-backup-1234' }); await f.service.wait(); assert.equal(f.service.state().jobs[0].status, 'completed');
        const manifest = f.manifest(); assert.ok(manifest.files.find(file => file.name === 'live.sqlite').sqlite); assert.equal(manifest.files.some(file => /live.sqlite-(wal|shm)$/.test(file.name)), false);
        const bytes = f.objects.get('backups/1-20261027/.tunnel-data/live.sqlite').body, restored = path.join(f.root, 'restored.sqlite'); await fs.writeFile(restored, bytes);
        const copy = new DatabaseSync(restored); try { assert.equal(copy.prepare('SELECT value FROM records').get().value, 'latest committed WAL value'); } finally { copy.close(); }
    } finally { db.close(); }
});
test('failure preserves the fixed snapshot and retry confirms existing files without duplicate upload', async t => {
    const f = await fixture(t); await f.put('a.txt', 'old-a'); await f.put('b.txt', 'old-b'); f.failOnce('/b.txt');
    const job = await f.service.start({ mode: 'core', requestId: 'retry-backup-1234' }); await f.service.wait(); assert.equal(f.service.state().jobs[0].status, 'failed');
    assert.equal([...f.objects.keys()].some(key => key.endsWith('backup-manifest.json')), false);
    await f.put('b.txt', 'new-b'); await f.service.retry(job.id); await f.service.wait(); assert.equal(f.service.state().jobs[0].status, 'completed');
    assert.equal(f.calls.filter(key => key.endsWith('/a.txt')).length, 1); assert.equal(f.objects.get('backups/1-20261027/.tunnel-data/b.txt').body.toString(), 'old-b');
});
test('large files split into bounded streams and manifest retains reconstruction order and hashes', async t => {
    const f = await fixture(t, { partBytes: 4 }); await f.put('big.bin', '0123456789'); await f.service.start({ mode: 'core', requestId: 'split-backup-1234' }); await f.service.wait();
    const file = f.manifest().files.find(file => file.name === 'big.bin'); assert.deepEqual(file.segments.map(part => [part.start, part.size]), [[0,4],[4,4],[8,2]]);
    assert.equal(Buffer.concat(file.segments.map(part => f.objects.get('backups/1-20261027/' + part.key).body)).toString(), '0123456789');
});
test('parallel starts cannot allocate duplicate work and cancellation preserves retryable state', async t => {
    const f = await fixture(t); await f.put('a.txt');
    f.block(signal => new Promise((resolve, reject) => { if (signal.aborted) reject(new Error('cancelled')); else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }));
    const results = await Promise.allSettled([f.service.start({ mode: 'core', requestId: 'parallel-one-1234' }), f.service.start({ mode: 'core', requestId: 'parallel-two-1234' })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(f.service.state().jobs.length, 1);
    f.service.cancel(f.service.state().jobs[0].id); await f.service.wait(); assert.equal(f.service.state().jobs[0].status, 'cancelled');
});
test('invalid paths and source symlinks are rejected without following resources outside the data directory', async t => {
    for (const value of ['../other', '/hello/../there', 'a\\b', 'a//b']) assert.throws(() => relativePath(value), /PATH_INVALID/);
    const f = await fixture(t); await assert.rejects(f.service.configure('full', { userId: 'owner', partitionId: 'part', folderPath: '/../outside' }), /PATH_INVALID/);
    const outside = path.join(f.root, 'outside.txt'); await fs.writeFile(outside, 'not backup data');
    try { await fs.symlink(outside, path.join(f.dataDir, 'link.txt')); } catch (error) { if (error.code === 'EPERM') { t.diagnostic('Windows 当前测试用户无符号链接创建权限，符号链接分支未执行'); return; } throw error; }
    await f.service.start({ mode: 'full', requestId: 'symlink-backup-1234' }); await f.service.wait(); assert.equal(f.service.state().jobs[0].status, 'failed'); assert.match(f.service.state().jobs[0].error, /SYMBOLIC_LINK/); assert.equal(f.objects.size, 0);
});
test('admin routes require authentication and reject cross-origin mutations', async t => {
    const f = await fixture(t), app = express();
    const auth = { users: () => [], user: () => null };
    const service = registerDataBackup(app, { dataDir: f.dataDir, root: path.resolve(__dirname, '..'), diskAPI: { spaces: { forUser: () => [], get: () => ({}) } }, auth,
        origin: () => 'http://backup.test', requireAuth: (req, res, next) => req.get('X-Test-Admin') === 'yes' ? next() : res.status(401).json({ error: 'ADMIN_REQUIRED' }) });
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => { service.close(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    assert.equal((await fetch(base + '/api/system-backup/state')).status, 401);
    assert.equal((await fetch(base + '/api/system-backup/state', { headers: { 'X-Test-Admin': 'yes' } })).status, 200);
    assert.equal((await fetch(base + '/api/system-backup/jobs', { method: 'POST', headers: { 'X-Test-Admin': 'yes', Origin: 'http://evil.test', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(base + '/pages/system-backup.html')).status, 401);
});
test('real drive adapter saves the core backup using backend upload, records source identity and returns a complete manifest', async t => {
    const f = await require('./support/data-backup-261027-fixture.cjs').create(); t.after(() => f.close());
    const response = await fetch(f.base + '/api/system-backup/jobs', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'core', requestId: 'integrated-backup-1234' }) });
    assert.equal(response.status, 202); await f.backup.wait();
    const job = f.backup.state().jobs[0]; assert.equal(job.status, 'completed', job.error);
    const files = f.api.spaces.get(f.core.scopeKey).adminFiles().filter(file => file.ownerId === 'bob' && file.metadata?.systemBackupId === job.id);
    assert.ok(files.length > 2); assert.ok(files.some(file => file.name === 'backup-manifest.json')); assert.ok(files.every(file => file.size === 0 || file.sourceAppId === 'system-backup'));
    assert.ok(files.some(file => file.folderPath.endsWith('.tunnel-data/streaming-console') && file.name === 'fixture.txt'));
    assert.equal(files.some(file => file.name === 'excluded.txt'), false);
});
