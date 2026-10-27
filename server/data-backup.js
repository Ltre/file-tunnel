'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync, backup } = require('node:sqlite');
const express = require('express');
const { readJson, writeJsonAsync } = require('./disk-data');
const { createDiskPartitions } = require('./disk-partitions');
const { objectKey } = require('./object-storage');

const EXCLUDED = ['telegram-content-cache', 'telegram-drive-staging', 'telegram-part-cache'];
const CORE = ['disk-spaces', 'streaming-console', 'youtube-premium-downloads', 'sns-downloads'];
const PART_BYTES = 1024 * 1024 * 1024;
const ACTIVE = new Set(['snapshotting', 'uploading', 'cancelling']);
const join = (...parts) => parts.filter(Boolean).join('/');
const fail = code => { throw new Error(code); };
function relativePath(value = '') {
    if (typeof value !== 'string' || value.includes('\\') || /[\u0000-\u001f]/.test(value)) fail('BACKUP_PATH_INVALID');
    const normalized = value.replace(/^\/+|\/+$/g, '');
    if (normalized && normalized.split('/').some(part => !part || part === '.' || part === '..' || part !== part.trim())) fail('BACKUP_PATH_INVALID');
    return normalized;
}
function safeName(name) {
    // Native directory names have a 100-character limit. Reserve the encoded
    // namespace too, so a real `_name-...` file cannot collide with an alias.
    if (name.length <= 90 && !name.startsWith('_name-') && name === name.trim() && !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && name !== '.' && name !== '..') return name;
    return '_name-' + crypto.createHash('sha256').update(name).digest('hex');
}
const remoteName = name => name.split('/').map(safeName).join('/');
const cancelled = signal => { if (signal?.aborted) fail('BACKUP_CANCELLED'); };
async function hashFile(file, start = 0, end, signal) {
    const hash = crypto.createHash('sha256');
    for await (const bytes of fs.createReadStream(file, { start, ...(end === undefined ? {} : { end }) })) { cancelled(signal); hash.update(bytes); }
    return hash.digest('hex');
}
async function isSQLite(file) {
    const handle = await fsp.open(file, 'r');
    try { const bytes = Buffer.alloc(16); const result = await handle.read(bytes, 0, 16, 0); return result.bytesRead === 16 && bytes.toString('binary') === 'SQLite format 3\u0000'; }
    finally { await handle.close(); }
}
async function sqliteSnapshot(source, destination, signal) {
    cancelled(signal);
    const connection = new DatabaseSync(source, { readOnly: true });
    try { await backup(connection, destination, { rate: 128, progress() { cancelled(signal); } }); }
    finally { connection.close(); }
}
async function copyStable(source, destination, signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
        cancelled(signal);
        const before = await fsp.lstat(source);
        if (!before.isFile() || before.isSymbolicLink()) fail('BACKUP_SOURCE_NOT_REGULAR');
        const hash = crypto.createHash('sha256');
        await pipeline(fs.createReadStream(source), new Transform({ transform(bytes, _enc, done) { hash.update(bytes); done(null, bytes); } }), fs.createWriteStream(destination, { mode: 0o600 }), { signal });
        const after = await fsp.lstat(source);
        if (before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs) {
            if (source.endsWith('.json') && after.size <= 8 * 1024 * 1024) {
                // JSON indexes are small business metadata. Do not snapshot a partially written document.
                try { JSON.parse(await fsp.readFile(destination, 'utf8')); }
                catch (error) { if (attempt === 2) throw new Error('BACKUP_JSON_CHANGED', { cause: error }); continue; }
            }
            return { size: after.size, sha256: hash.digest('hex') };
        }
    }
    fail('BACKUP_SOURCE_CHANGED');
}

function createDataBackup({ dataDir, storage, beforeSnapshot = () => {}, now = Date.now, tempDir = os.tmpdir(), partBytes = PART_BYTES }) {
    const sourceRoot = path.resolve(dataDir), stateFile = path.join(sourceRoot, '.system-backup-state.json');
    if (path.resolve(tempDir) === sourceRoot || path.resolve(tempDir).startsWith(sourceRoot + path.sep)) fail('BACKUP_STAGING_INSIDE_SOURCE');
    if (!Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > PART_BYTES) fail('BACKUP_PART_SIZE_INVALID');
    const state = readJson(stateFile, { version: 1, config: { full: null, core: null }, jobs: [] });
    state.config ||= { full: null, core: null }; state.jobs ||= [];
    for (const job of state.jobs) if (ACTIVE.has(job.status)) { job.status = 'interrupted'; job.error = 'BACKUP_PROCESS_INTERRUPTED'; }
    let running = null, closed = false, starting = false;
    // Serialize atomic replacements: Windows indexers may briefly lock the
    // destination. Never treat a state-write error as an unreadable source.
    let stateWrites = Promise.resolve();
    const persist = () => {
        const value = structuredClone(state);
        const write = stateWrites.catch(() => {}).then(() => writeJsonAsync(stateFile, value));
        stateWrites = write;
        return write.catch(error => { throw new Error('BACKUP_STATE_WRITE_FAILED [' + (error.code || error.message) + ']', { cause: error }); });
    };
    const publicJob = job => ({ id: job.id, mode: job.mode, status: job.status, stage: job.stage, target: job.target, folder: job.folder,
        createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt || 0, totalFiles: job.files.length,
        completedFiles: job.files.filter(file => file.done).length, totalBytes: job.totalBytes || 0,
        completedBytes: job.files.filter(file => file.done).reduce((n, file) => n + file.size, 0), currentFile: job.currentFile || '',
        currentProgress: job.currentProgress || null, error: job.error || '', excluded: job.excluded || [],
        cleanupWarning: job.cleanupWarning || '', skipped: job.skipped || [],
        consistency: 'online-per-file', snapshotStartedAt: job.snapshotStartedAt || 0, snapshotCompletedAt: job.snapshotCompletedAt || 0 });
    const changed = async job => { job.updatedAt = now(); await persist(); };
    const permissionError = error => ['EACCES', 'EPERM'].includes(error.code);
    const validateTarget = async value => {
        if (!value || typeof value.userId !== 'string' || typeof value.partitionId !== 'string') fail('BACKUP_TARGET_REQUIRED');
        const folderPath = relativePath(value.folderPath || '');
        const resolved = await storage.resolveTarget({ userId: value.userId, partitionId: value.partitionId, folderPath });
        return { ...resolved, userId: value.userId, partitionId: value.partitionId, folderPath };
    };
    async function collect(mode, signal) {
        const entries = [], omitted = [], skipped = [], realRoot = await fsp.realpath(sourceRoot);
        async function walk(folder, relative) {
            let children;
            try { children = await fsp.readdir(folder, { withFileTypes: true }); }
            catch (error) { if (!relative || !permissionError(error)) throw error; skipped.push({ name: relative, code: error.code, stage: 'read-directory' }); return; }
            for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
                cancelled(signal);
                const name = join(relative, entry.name), absolute = path.join(folder, entry.name);
                if(!relative&&/^\.system-backup-state\.json\.[\w-]+\.tmp$/.test(entry.name)){omitted.push(name+' (temporary state write)');continue;}
                if (!relative && entry.isDirectory() && (mode === 'full' ? EXCLUDED.includes(entry.name) : !CORE.includes(entry.name))) { omitted.push(name); continue; }
                if (entry.isSymbolicLink()) throw new Error('BACKUP_SYMBOLIC_LINK: ' + name);
                let resolved;
                try { resolved = await fsp.realpath(absolute); }
                catch (error) { if (!permissionError(error)) throw error; skipped.push({ name, code: error.code, stage: 'read-source' }); continue; }
                if (!resolved.startsWith(realRoot + path.sep)) throw new Error('BACKUP_SOURCE_OUTSIDE_ROOT: ' + name);
                if (entry.isDirectory()) { entries.push({ name, source: absolute, directory: true }); await walk(absolute, name); }
                else if (entry.isFile()) entries.push({ name, source: absolute });
                else throw new Error('BACKUP_SOURCE_NOT_REGULAR: ' + name);
            }
        }
        await walk(sourceRoot, '');
        const sqliteFiles = new Set();
        for (const entry of entries) if (!entry.directory) {
            try { if (await isSQLite(entry.source)) sqliteFiles.add(entry.name); }
            catch (error) { if (!permissionError(error)) throw error; entry.denied = true; skipped.push({ name: entry.name, code: error.code, stage: 'read-source' }); }
        }
        return { entries: entries.filter(entry => {
            if (entry.denied) return false;
            if (/-(wal|shm)$/.test(entry.name) && sqliteFiles.has(entry.name.replace(/-(wal|shm)$/, ''))) { omitted.push(entry.name + ' (SQLite online backup includes committed WAL)'); return false; }
            entry.sqlite = sqliteFiles.has(entry.name); return true;
        }), omitted, skipped };
    }
    async function snapshot(job, signal) {
        job.stage = 'snapshot'; job.status = 'snapshotting'; job.snapshotStartedAt = now(); await changed(job);
        await beforeSnapshot();
        job.staging = await fsp.mkdtemp(path.join(tempDir, 'dr2t-system-backup-'));
        await fsp.chmod(job.staging, 0o700);
        const { entries, omitted, skipped } = await collect(job.mode, signal); job.excluded = omitted; job.skipped = skipped;
        const realRoot = await fsp.realpath(sourceRoot);
        job.files = []; job.directories = []; job.totalBytes = 0;
        for (const entry of entries) {
            cancelled(signal);
            let resolved,entryStat;
            try { resolved = await fsp.realpath(entry.source); entryStat = await fsp.lstat(entry.source); }
            catch(error){if(!permissionError(error))throw error;job.skipped.push({name:entry.name,code:error.code,stage:'snapshot-source'});continue;}
            if (!resolved.startsWith(realRoot + path.sep) || entryStat.isSymbolicLink()) throw new Error('BACKUP_SOURCE_OUTSIDE_ROOT: ' + entry.name);
            if (entry.directory) { job.directories.push({ name: entry.name, key: join('.tunnel-data', remoteName(entry.name)), mode: entryStat.mode & 0o777, mtime: entryStat.mtimeMs }); continue; }
            job.currentFile = entry.name; await changed(job);
            const destination = path.join(job.staging, 'file-' + job.files.length);
            let size, sha256;
            try {
                if (entry.sqlite) { await sqliteSnapshot(entry.source, destination, signal); await fsp.chmod(destination, 0o600); size = (await fsp.stat(destination)).size; sha256 = await hashFile(destination, 0, undefined, signal); }
                else ({ size, sha256 } = await copyStable(entry.source, destination, signal));
            } catch (error) {
                if (permissionError(error) && (!error.path || path.resolve(error.path) === path.resolve(entry.source))) {
                    job.skipped.push({ name: entry.name, code: error.code, stage: 'snapshot-source' });
                    await fsp.rm(destination, { force: true }); continue;
                }
                throw new Error(`${error.message} · ${entry.name}`, { cause: error });
            }
            const segments = [];
            for (let start = 0; start < Math.max(size, 1); start += partBytes) {
                const bytes = Math.min(partBytes, size - start), split = size > partBytes;
                const key = split ? join('_backup-parts', crypto.createHash('sha256').update(entry.name).digest('hex'), String(segments.length + 1).padStart(6, '0') + '.part') : join('.tunnel-data', remoteName(entry.name));
                const digest = split ? await hashFile(destination, start, start + bytes - 1, signal) : sha256;
                segments.push({ key, start, size: bytes, sha256: digest, done: false });
            }
            const original = entryStat;
            job.files.push({ name: entry.name, snapshot: destination, size, sha256, mode: original.mode & 0o777, mtime: original.mtimeMs, sqlite: Boolean(entry.sqlite), segments, done: false });
            job.totalBytes += size; await changed(job);
        }
        job.snapshotCompletedAt = now(); job.currentFile = ''; await changed(job);
    }
    async function send(job, key, input, size, sha256, signal, fileName) {
        try {
        const target = await validateTarget(job.target);
        const fullKey = join(job.folder, key); objectKey(fullKey);
        const existing = await storage.stat(target, fullKey);
        if (existing && existing.size === size && existing.file?.metadata?.backupSha256 === sha256) { input.destroy?.(); return existing; }
        if (existing) { input.destroy?.(); fail('BACKUP_TARGET_CONTENT_CONFLICT'); }
        const result = await storage.put(target, fullKey, input, { size, contentType: 'application/octet-stream', expectedSha256: sha256,
            metadata: { systemBackupId: job.id, backupSha256: sha256, originalPath: fileName }, signal,
            onProgress: progress => { job.currentProgress = { percent: Number(progress.percent) || 0, phase: String(progress.phase || ''), detail: String(progress.detail || progress.message || '') }; } });
        if (!result || result.size !== size || !result.file?.id) fail('BACKUP_SAVE_NOT_CONFIRMED');
        return result;
        } finally { input.destroy?.(); }
    }
    async function upload(job, signal) {
        job.status = 'uploading'; job.stage = 'upload'; await changed(job);
        const target = await validateTarget(job.target);
        await storage.mkdir(target, job.folder);
        for (const folder of job.directories) { cancelled(signal); await storage.mkdir(target, join(job.folder, typeof folder === 'string' ? folder : folder.key)); }
        for (const file of job.files) {
            cancelled(signal); job.currentFile = file.name; job.currentProgress = null; await changed(job);
            const staging = path.resolve(job.staging || ''), resolved = await fsp.realpath(file.snapshot), snapshotInfo = await fsp.lstat(file.snapshot);
            if (path.dirname(staging) !== path.resolve(tempDir) || !path.basename(staging).startsWith('dr2t-system-backup-')
                || path.dirname(resolved) !== await fsp.realpath(staging) || !snapshotInfo.isFile() || snapshotInfo.isSymbolicLink()) fail('BACKUP_STAGING_INVALID');
            for (const segment of file.segments) {
                cancelled(signal);
                const stream = segment.size ? Readable.from((async function* () { yield* fs.createReadStream(file.snapshot, { start: segment.start, end: segment.start + segment.size - 1 }); })()) : Readable.from([]);
                const result = await send(job, segment.key, stream, segment.size, segment.sha256, signal, file.name);
                segment.done = true; segment.fileId = result.file.id; await changed(job);
            }
            file.done = true; await changed(job);
        }
        const manifest = { format: 'drop2tunnel-system-backup', version: 1, id: job.id, mode: job.mode, createdAt: job.createdAt,
            target: job.target, folder: job.folder, consistency: 'online-per-file', snapshotStartedAt: job.snapshotStartedAt,
            snapshotCompletedAt: job.snapshotCompletedAt, status: 'completed', note: 'Each SQLite database is an online backup including committed WAL; WAL/SHM sidecars are not restored. Ordinary files are stable copies. Different files/databases are not one global transaction. Stop application writers before restoring. Concatenate split segments in start order and verify SHA-256. The disk.sqlite snapshot predates this backup upload and cannot index its newly saved files; obtain backup contents using the target account/partition/path and this manifest, not by restoring the old index alone.',
            excluded: job.excluded, skipped: job.skipped || [], directories: job.directories, files: job.files.map(({ name, size, sha256, mode, mtime, sqlite, segments }) => ({ name, size, sha256, mode, mtime, sqlite, segments })) };
        const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
        await send(job, 'backup-manifest.json', Readable.from([bytes]), bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), signal, 'backup-manifest.json');
        job.status = 'completed'; job.stage = 'completed'; job.completedAt = now(); job.error = ''; job.currentFile = ''; job.currentProgress = null; await changed(job);
        try { await cleanup(job); }
        catch (error) { job.cleanupWarning = error.message; await changed(job); }
    }
    async function cleanup(job) {
        if (!job.staging) return;
        const resolved = path.resolve(job.staging), parent = path.resolve(tempDir);
        if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('dr2t-system-backup-')) fail('BACKUP_STAGING_INVALID');
        await fsp.rm(resolved, { recursive: true, force: true }); job.staging = ''; await changed(job);
    }
    function launch(job) {
        const controller = new AbortController();
        const work = { job, controller, promise: null }; running = work;
        work.promise = Promise.resolve().then(async () => {
            if (!job.snapshotCompletedAt) { if (job.staging) await cleanup(job); await snapshot(job, controller.signal); }
            await upload(job, controller.signal);
        }).catch(async error => {
            job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = controller.signal.aborted ? 'BACKUP_CANCELLED' : error.message; job.currentProgress = null;
            try { await changed(job); } catch (stateError) { job.error += ' · ' + stateError.message; }
        }).finally(() => { if (running === work) running = null; });
        return publicJob(job);
    }
    return {
        state() { return { config: structuredClone(state.config), jobs: state.jobs.map(publicJob), coreDirectories: CORE, fullExcluded: EXCLUDED, active: running?.job.id || '' }; },
        async configure(mode, value) { if (!['full', 'core'].includes(mode)) fail('BACKUP_MODE_INVALID'); state.config[mode] = await validateTarget(value); await persist(); return this.state(); },
        async start({ mode, requestId }) {
            if (closed) fail('BACKUP_CLOSED');
            if (!['full', 'core'].includes(mode)) fail('BACKUP_MODE_INVALID');
            if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{12,80}$/.test(requestId)) fail('BACKUP_REQUEST_ID_INVALID');
            const prior = state.jobs.find(job => job.requestId === requestId); if (prior) return publicJob(prior);
            if (running || starting) fail('BACKUP_ALREADY_RUNNING');
            starting = true;
            try {
                const target = await validateTarget(state.config[mode]);
                const directories = await storage.listDirectories(target);
                if (closed) fail('BACKUP_CLOSED');
                const prefix = target.folderPath ? target.folderPath + '/' : '';
                const used = directories.filter(folder => folder.startsWith(prefix)).map(folder => folder.slice(prefix.length)).filter(folder => /^\d+-\d{8}$/.test(folder)).map(folder => Number(folder.split('-')[0]));
                const sequence = Math.max(0, ...used, ...state.jobs.filter(job => job.target.userId === target.userId && job.target.partitionId === target.partitionId && job.target.folderPath === target.folderPath).map(job => job.sequence || 0)) + 1;
                const date = new Date(now()), stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
                const job = { id: crypto.randomUUID(), requestId, mode, target, sequence, folder: join(target.folderPath, `${sequence}-${stamp}`), status: 'snapshotting', stage: 'snapshot', createdAt: now(), updatedAt: now(), files: [], directories: [], excluded: [] };
                state.jobs.push(job);
                try { await persist(); } catch (error) { job.status = 'failed'; job.error = error.message; throw error; }
                return launch(job);
            } finally { starting = false; }
        },
        async retry(id) { if (closed || running || starting) fail('BACKUP_ALREADY_RUNNING'); starting = true; try { const job = state.jobs.find(item => item.id === id); if (!job || !['failed', 'interrupted', 'cancelled'].includes(job.status)) fail('BACKUP_RETRY_INVALID'); await validateTarget(job.target); job.error = ''; return launch(job); } finally { starting = false; } },
        async cancel(id) { if (!running || running.job.id !== id) fail('BACKUP_NOT_RUNNING'); const work = running; work.job.status = 'cancelling'; work.controller.abort(); await changed(work.job); return publicJob(work.job); },
        async discard(id) { const job = state.jobs.find(item => item.id === id); if (!job || ACTIVE.has(job.status) || running?.job.id === id) fail('BACKUP_DISCARD_INVALID'); await cleanup(job); job.snapshotCompletedAt = 0; job.files = []; job.totalBytes = 0; job.status = 'discarded'; await changed(job); return publicJob(job); },
        async wait() { await running?.promise; },
        close() { closed = true; running?.controller.abort(); }
    };
}

function registerDataBackup(app, { dataDir, root, diskAPI, auth, requireAuth, origin, beforeSnapshot }) {
    const partitions = createDiskPartitions({ dataDir, spaces: diskAPI.spaces });
    const resolveTarget = value => {
        const user = auth.user(value.userId); if (!user) fail('BACKUP_USER_NOT_FOUND');
        const partition = partitions.find(value.userId, value.partitionId), folderPath = relativePath(value.folderPath);
        const store = diskAPI.spaces.get(partition.scopeKey);
        if (folderPath && !store.listDirectories(user.id).some(item => item.path === folderPath)) fail('BACKUP_DIRECTORY_NOT_FOUND');
        return { userId: user.id, userName: user.name || user.username || user.telegramId || user.id, loginId: user.telegramId || user.username || user.id,
            partitionId: partition.id, partitionName: partition.displayName, diskSpace: partition.scopeKey, folderPath };
    };
    const mapping = target => ({ userId: target.userId, diskSpace: target.diskSpace, sourceAppId: 'system-backup', assertAuthorized() { resolveTarget(target); } });
    const storage = { resolveTarget,
        listDirectories: target => diskAPI.spaces.get(target.diskSpace).listDirectories(target.userId).map(item => item.path),
        mkdir: (target, folder) => diskAPI.objectStorage.put(mapping(target), folder + '/', Readable.from([]), { size: 0, metadata: { systemBackup: true } }),
        stat: (target, key) => diskAPI.objectStorage.stat(mapping(target), key),
        put: (target, key, input, options) => diskAPI.objectStorage.put(mapping(target), key, input, options) };
    const service = createDataBackup({ dataDir, storage, beforeSnapshot });
    app.get(['/system-backup', '/pages/system-backup.html'], requireAuth, (_req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(root, 'pages', 'system-backup.html')));
    const router = express.Router(); router.use(requireAuth); router.use(express.json({ limit: '16kb' }));
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (!['GET', 'HEAD'].includes(req.method)) {
            let valid = false;
            try { valid = Boolean(req.get('Origin')) && new URL(req.get('Origin')).origin === new URL(origin(req)).origin; } catch (_) {}
            if (!valid) return res.status(403).json({ error: 'BACKUP_ORIGIN_INVALID' });
        }
        next();
    });
    const wrap = work => (req, res, next) => Promise.resolve().then(() => work(req, res)).catch(next);
    router.get('/state', (_req, res) => res.json({ ...service.state(), users: auth.users() }));
    router.get('/targets', wrap((req, res) => {
        const userId = String(req.query.userId || ''); if (!auth.user(userId)) fail('BACKUP_USER_NOT_FOUND');
        const choices = partitions.list(userId).filter(item => item.state === 'ACTIVE');
        const selected = req.query.partitionId ? partitions.find(userId, String(req.query.partitionId)) : choices[0];
        const folderPath = relativePath(String(req.query.path || ''));
        const target = resolveTarget({ userId, partitionId: selected.id, folderPath });
        const listing = diskAPI.spaces.get(target.diskSpace).list(userId, folderPath);
        res.json({ partitions: choices, selected: target.partitionId, path: folderPath, directories: listing.directories || listing.folders || [] });
    }));
    router.put('/config/:mode', wrap(async (req, res) => res.json(await service.configure(req.params.mode, req.body))));
    router.post('/jobs', wrap(async (req, res) => res.status(202).json(await service.start(req.body))));
    router.post('/jobs/:id/retry', wrap(async (req, res) => res.status(202).json(await service.retry(req.params.id))));
    router.post('/jobs/:id/cancel', wrap(async (req, res) => res.json(await service.cancel(req.params.id))));
    router.post('/jobs/:id/discard', wrap(async (req, res) => res.json(await service.discard(req.params.id))));
    router.use((error, _req, res, _next) => res.status(/NOT_FOUND/.test(error.message) ? 404 : /RUNNING|CONFLICT/.test(error.message) ? 409 : 422).json({ error: error.message }));
    app.use('/api/system-backup', router);
    return service;
}
module.exports = { createDataBackup, registerDataBackup, relativePath, CORE, EXCLUDED };
