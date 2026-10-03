'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { readJson, writeJson, writeJsonAsync } = require('./disk-data');
const { openDiskRepository } = require('./disk-repository');
const { MAX_TELEGRAM_PART_SIZE } = require('./disk-limits');
const { createGrowingFileReadable } = require('./growing-file-readable');


function normalizeSegment(value, limit = 100) {
    const name = String(value || '').trim();
    if (!name || name === '.' || name === '..' || name.length > limit || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) throw new Error('DISK_NAME_INVALID');
    return name;
}

function normalizePath(value) {
    return String(value || '').replace(/\\/g, '/').split('/').map(part => part.trim()).filter(part => part && part !== '.').map(part => normalizeSegment(part)).join('/');
}

function parentPath(value) {
    return normalizePath(value).split('/').slice(0, -1).join('/');
}

function baseName(value) {
    return normalizePath(value).split('/').filter(Boolean).at(-1) || '';
}

function joinPath(...parts) {
    return normalizePath(parts.filter(Boolean).join('/'));
}

function createTelegramDriveStore({ dataDir, repositoryDir = dataDir, diskSpace = '', maxFileSize = () => 2 * 1024 * 1024 * 1024 }) {
    const repository = openDiskRepository(repositoryDir);
    const stagingRoot = path.join(dataDir, 'telegram-drive-staging');
    const records = new Map();
    const directories = new Map();
    const uploads = new Map();
    const recoveredUploads = [];
    let fileState = repository.loadWithRevision('files', diskSpace);
    let directoryState = repository.loadWithRevision('directories', diskSpace);
    const restoreViews = () => {
        records.clear();
        directories.clear();
        for (const item of fileState.items) if (item?.id && item?.ownerId) records.set(item.id, item);
        for (const item of directoryState.items) {
            if (!item?.ownerId || !normalizePath(item.path)) continue;
            const safe = normalizePath(item.path);
            directories.set(`${item.ownerId}:${safe}`, { ...item, ownerId: String(item.ownerId), path: safe, updatedAt: Number(item.updatedAt) || Number(item.createdAt) || Date.now() });
        }
    };
    const reloadPersistence = () => {
        fileState = repository.loadWithRevision('files', diskSpace);
        directoryState = repository.loadWithRevision('directories', diskSpace);
        restoreViews();
    };
    restoreViews();
    const persist = (directoriesOnly = false) => {
        try {
            repository.replaceMany([
                ...(!directoriesOnly ? [{ table: 'files', scope: diskSpace, items: [...records.values()], keyOf: item => item.id, base: fileState.revisions }] : []),
                { table: 'directories', scope: diskSpace, items: [...directories.values()], keyOf: item => `${item.ownerId}:${item.path}`, base: directoryState.revisions }
            ]);
        } catch (error) {
            reloadPersistence();
            throw error;
        }
    };
    const uploadManifestPath = job => path.join(job.dir, 'upload-manifest.json');
    const uploadManifest = job => ({
        version: 1, id: job.id, ownerId: String(job.owner?.id || ''), operationId: String(job.operationId || ''),
        backendId: String(job.backendId || ''), channelId: String(job.channelId || ''), createdAt: Number(job.createdAt) || Date.now(),
        pendingRollbackParts: job.pendingRollbackParts || [],
        pendingCleanupParts: job.pendingCleanupParts || [],
        files: job.files.map(file => ({ name: file.name, logicalId: file.logicalId, thumbnail: file.thumbnail ? {
            size: file.thumbnail.size, type: file.thumbnail.type, remote: file.thumbnail.remote || null
        } : null, chunks: (file.chunks || []).map(chunk => ({
            partIndex: chunk.partIndex, size: chunk.size, writtenBytes: Number(chunk.writtenBytes) || 0,
            sourceComplete: chunk.sourceComplete === true, finalized: chunk.finalized === true,
            sha256: chunk.sha256 || '', remote: chunk.remote || null
        })) }))
    });
    const persistenceError = (error, stage) => {
        error.details = { ...error.details, stage: error.details?.stage || stage, syscall: error.details?.syscall || error.syscall || '' };
        return error;
    };
    const persistUpload = job => {
        try { writeJson(uploadManifestPath(job), uploadManifest(job)); }
        catch (error) { throw persistenceError(error, 'upload-manifest-write'); }
    };
    const persistUploadAsync = (job, allowClosed = false) => {
        // Receive and Telegram confirmation can overlap. Serialize replacements
        // and take the snapshot only after the preceding write has finished.
        job.manifestPending = (job.manifestPending || 0) + 1;
        const pending = (job.manifestWrite || Promise.resolve()).catch(() => {}).then(async () => {
            try {
                if (job.closed && !allowClosed) throw new Error('OPERATION_CANCELLED');
                try { await writeJsonAsync(uploadManifestPath(job), uploadManifest(job)); }
                catch (error) { throw persistenceError(error, 'upload-manifest-write'); }
            } finally { job.manifestPending--; }
        });
        job.manifestWrite = pending;
        pending.catch(() => {});
        return pending;
    };
    const assertUploadActive = job => {
        if (job.closed || uploads.get(job.id) !== job) throw new Error('OPERATION_CANCELLED');
    };
    const registerReceiver = (job, request) => {
        assertUploadActive(job);
        job.receivers ||= new Set();
        let done;
        const receiver = { request, done: new Promise(resolve => { done = resolve; }) };
        job.receivers.add(receiver);
        return () => { job.receivers.delete(receiver); done(); };
    };
    const stopUpload = job => {
        job.closed = true;
        for (const receiver of job.receivers || []) receiver.request.destroy(new Error('OPERATION_CANCELLED'));
    };
    const cleanupWarning = (job, error) => console.warn('[disk-upload] staging.cleanup-failed', { uploadId: job.id, code: error.code || 'UNKNOWN', syscall: error.syscall || '' });
    const unlinkStaging = (job, filename) => {
        try { if (filename) fs.unlinkSync(filename); }
        catch (error) { if (error.code !== 'ENOENT') cleanupWarning(job, error); }
    };
    const removeStaging = job => {
        try { fs.rmSync(job.dir, { recursive: true, force: true }); }
        catch (error) { cleanupWarning(job, error); }
    };
    const notifyChunk = chunk => {
        for (const wake of chunk.growthWaiters || []) wake();
        chunk.growthWaiters?.clear();
    };
    const prepareGrowingChunk = chunk => {
        chunk.writtenBytes = Math.max(0, Number(chunk.writtenBytes) || 0);
        chunk.sourceComplete = chunk.sourceComplete === true;
        chunk.growthWaiters ||= new Set();
        chunk.waitForGrowth = (offset, signal) => {
            if (chunk.writtenBytes > offset || chunk.sourceComplete || chunk.sourceError) return Promise.resolve();
            return new Promise((resolve, reject) => {
                let settled = false;
                const finish = error => {
                    if (settled) return; settled = true;
                    signal?.removeEventListener?.('abort', onAbort);
                    chunk.growthWaiters.delete(wake);
                    error ? reject(error) : resolve();
                };
                const wake = () => finish();
                const onAbort = () => finish(Object.assign(new Error('OPERATION_CANCELLED'), { name:'AbortError' }));
                chunk.growthWaiters.add(wake);
                signal?.addEventListener?.('abort', onAbort, { once:true });
                if (signal?.aborted) onAbort();
            });
        };
        chunk.waitForSourceComplete = signal => {
            if (chunk.sourceComplete || chunk.sourceError) return chunk.sourceError ? Promise.reject(chunk.sourceError) : Promise.resolve();
            return new Promise((resolve, reject) => {
                const poll = () => {
                    if (signal?.aborted) return reject(Object.assign(new Error('OPERATION_CANCELLED'), { name:'AbortError' }));
                    if (chunk.sourceError) return reject(chunk.sourceError);
                    if (chunk.sourceComplete) return resolve();
                    chunk.waitForGrowth(chunk.writtenBytes, signal).then(poll, reject);
                };
                poll();
            });
        };
        chunk.streamFactory = ({ signal } = {}) => createGrowingFileReadable({
            path: chunk.path, size: chunk.size, signal,
            getWrittenBytes: () => chunk.writtenBytes,
            waitForGrowth: (offset, waitSignal) => chunk.waitForGrowth(offset, waitSignal),
            getSourceError: () => chunk.sourceError || null
        });
        return chunk;
    };
    const receiveToStaging = async (request, filename, onWritten) => {
        const output = fs.createWriteStream(filename, { flags: 'wx' });
        // Count a byte as available to Telegram only after the filesystem
        // writable callback fires. Browser ingress and Telegram egress are
        // deliberately decoupled by this staging file.
        const markFilesystemError = error => {
            if (error?.syscall) persistenceError(error, 'browser-part-write');
            return error;
        };
        const writeChunk = chunk => new Promise((resolve, reject) => {
            const onError = error => { cleanup(); reject(markFilesystemError(error)); };
            const cleanup = () => output.removeListener('error', onError);
            output.once('error', onError);
            output.write(chunk, error => {
                cleanup();
                error ? reject(markFilesystemError(error)) : resolve();
            });
        });
        const finish = () => new Promise((resolve, reject) => {
            const onError = error => { cleanup(); reject(markFilesystemError(error)); };
            const onFinish = () => { cleanup(); resolve(); };
            const cleanup = () => { output.removeListener('error', onError); output.removeListener('finish', onFinish); };
            output.once('error', onError);
            output.once('finish', onFinish);
            output.end();
        });
        try {
            for await (const raw of request) {
                const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
                await writeChunk(chunk);
                onWritten?.(chunk);
            }
            await finish();
        } catch (error) {
            output.destroy();
            throw markFilesystemError(error);
        }
    };
    fs.mkdirSync(stagingRoot, { recursive: true });
    for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
        const dir = path.join(stagingRoot, entry.name), manifestPath = path.join(dir, 'upload-manifest.json');
        try {
            const manifest = readJson(manifestPath, null);
            if (manifest?.id === entry.name && Array.isArray(manifest.files)) recoveredUploads.push({ ...manifest, dir });
        } catch (error) {
            console.warn('[disk-upload] recovery.manifest-invalid', { uploadId: entry.name, error: error?.message || String(error) });
        }
    }
    const ownerRecords = ownerId => [...records.values()].filter(item => item.ownerId === String(ownerId));
    const ownerDirectories = ownerId => [...directories.values()].filter(item => item.ownerId === String(ownerId));
    const directoryKey = (ownerId, folderPath) => `${ownerId}:${normalizePath(folderPath)}`;
    const assertDepth = (folderPath, maxDepth) => {
        if (normalizePath(folderPath).split('/').filter(Boolean).length > Math.max(1, Math.min(20, Number(maxDepth) || 20))) throw new Error('telegram-drive-folder-depth-exceeded');
    };
    const pendingFiles = (ownerId, exceptUpload = '') => [...uploads.values()].filter(job => String(job.owner.id) === String(ownerId) && job.id !== exceptUpload).flatMap(job => job.files);
    const assertNoPendingTree = (ownerId, folderPath) => {
        if (pendingFiles(ownerId).some(file => file.folderPath === folderPath || file.folderPath.startsWith(folderPath + '/'))) throw new Error('DISK_UPLOAD_IN_PROGRESS');
    };
    const assertFreeName = (ownerId, folderPath, name, exceptId = '', exceptUpload = '') => {
        const target = [folderPath, name].filter(Boolean).join('/');
        if (pendingFiles(ownerId, exceptUpload).some(file => (file.folderPath === folderPath && file.name === name) || file.folderPath === target || file.folderPath.startsWith(target + '/'))) throw new Error('DISK_NAME_CONFLICT');
        if (ownerRecords(ownerId).some(item => item.id !== exceptId && (item.folderPath || '') === folderPath && item.name === name) || directories.has(String(ownerId) + ':' + target)) throw new Error('DISK_NAME_CONFLICT');
    };
    const ensureDirectoryRecords = (ownerId, folderPath, maxDepth, now = Date.now(), exceptUpload = '') => {
        const safe = normalizePath(folderPath); assertDepth(safe, maxDepth);
        const segments = safe.split('/').filter(Boolean);
        segments.forEach((segment, index) => {
            const parent = segments.slice(0, index).join('/');
            if (pendingFiles(ownerId, exceptUpload).some(file => file.folderPath === parent && file.name === segment)) throw new Error('DISK_NAME_CONFLICT');
            if (ownerRecords(ownerId).some(file => (file.folderPath || '') === parent && file.name === segment)) throw new Error('DISK_NAME_CONFLICT');
        });
        let current = '';
        for (const segment of safe.split('/').filter(Boolean)) {
            current = joinPath(current, segment);
            const key = directoryKey(ownerId, current);
            if (!directories.has(key)) directories.set(key, { ownerId: String(ownerId), path: current, createdAt: now, updatedAt: now });
        }
        return directories.get(directoryKey(ownerId, safe)) || { ownerId: String(ownerId), path: '' };
    };
    const directoryExists = (ownerId, folderPath) => {
        const safe = normalizePath(folderPath);
        return !safe || directories.has(directoryKey(ownerId, safe));
    };
    const touchDirectory = (ownerId, folderPath, now = Date.now()) => {
        const directory = directories.get(directoryKey(ownerId, folderPath));
        if (directory) directory.updatedAt = now;
    };
    const directorySnapshot = (ownerId, folderPath) => {
        const owner = String(ownerId);
        const safe = normalizePath(folderPath);
        const prefix = safe ? `${safe}/` : '';
        const nestedDirectories = ownerDirectories(owner).filter(item => item.path === safe || item.path.startsWith(prefix));
        const nestedFiles = ownerRecords(owner).filter(item => (item.folderPath || '') === safe || (item.folderPath || '').startsWith(prefix));
        const directory = safe ? directories.get(directoryKey(owner, safe)) : null;
        return {
            kind: 'directory',
            name: safe ? baseName(safe) : '根目录',
            path: safe,
            parentPath: parentPath(safe),
            reviewStatus: directory?.reviewStatus || 'active',
            reviewUpdatedAt: Number(directory?.reviewUpdatedAt) || 0,
            createdAt: Number(directory?.createdAt) || 0,
            updatedAt: Math.max(Number(directory?.updatedAt) || 0, ...nestedFiles.map(item => Number(item.updatedAt || item.createdAt) || 0), 0),
            folderCount: nestedDirectories.filter(item => item.path !== safe).length,
            fileCount: nestedFiles.length,
            size: nestedFiles.reduce((sum, item) => sum + Math.max(0, Number(item.size) || 0), 0),
            files: nestedFiles,
            directories: nestedDirectories
        };
    };

    // Older indexes may only contain the deepest explicit path. Materialize every
    // ancestor once so directory CRUD has a stable object to operate on.
    for (const directory of [...directories.values()]) ensureDirectoryRecords(directory.ownerId, directory.path, 20, Number(directory.createdAt) || Date.now());
    for (const item of records.values()) if (item.folderPath) ensureDirectoryRecords(item.ownerId, item.folderPath, 20, Number(item.createdAt) || Date.now());

    const store = {
        reloadPersistence,
        assertDirectoryWritable(ownerId, folderPath) { assertNoPendingTree(ownerId, folderPath); },
        createDirectory(ownerId, folderPath, maxDepth, sourceAppId = '') {
            const safe = normalizePath(folderPath);
            if (!safe) throw new Error('telegram-drive-folder-name-required');
            const result = ensureDirectoryRecords(ownerId, safe, maxDepth);
            if (sourceAppId && result.path) result.sourceAppId ||= String(sourceAppId);
            touchDirectory(ownerId, parentPath(safe));
            persist(true);
            return result;
        },
        setFolderMarker(ownerId, folderPath, metadata = {}, maxDepth = 20) {
            const safe = normalizePath(folderPath);
            if (!safe) throw new Error('DISK_NAME_INVALID');
            const existed = new Set(ownerDirectories(ownerId).map(item => item.path));
            const item = ensureDirectoryRecords(ownerId, safe, maxDepth);
            let current = '';
            for (const part of safe.split('/')) {
                current = joinPath(current, part);
                if (!existed.has(current)) directories.get(directoryKey(ownerId, current)).s3CreatedDirectory = true;
            }
            Object.assign(item, { s3Marker: { metadata, updatedAt: Date.now() }, updatedAt: Date.now() });
            persist(); return item;
        },
        clearFolderMarker(ownerId, folderPath) {
            const item = directories.get(directoryKey(ownerId, folderPath));
            if (!item?.s3Marker) return;
            delete item.s3Marker; item.updatedAt = Date.now();
            let current = normalizePath(folderPath);
            while (current) {
                const directory = directories.get(directoryKey(ownerId, current));
                if (!directory?.s3CreatedDirectory || directory.s3Marker || ownerRecords(ownerId).some(file => (file.folderPath || '') === current || (file.folderPath || '').startsWith(current + '/'))
                    || ownerDirectories(ownerId).some(child => child.path !== current && child.path.startsWith(current + '/'))) break;
                directories.delete(directoryKey(ownerId, current));
                current = parentPath(current);
            }
            persist();
        },
        list(ownerId, folderPath = '') {
            const owner = String(ownerId);
            const safe = normalizePath(folderPath);
            const prefix = safe ? `${safe}/` : '';
            const children = new Map();
            for (const item of ownerDirectories(owner)) {
                if (!item.path.startsWith(prefix)) continue;
                const child = item.path.slice(prefix.length).split('/')[0];
                if (!child) continue;
                const childPath = joinPath(safe, child);
                if (!children.has(childPath)) {
                    const directory = directories.get(directoryKey(owner, childPath));
                    children.set(childPath, { kind: 'directory', name: child, path: childPath, createdAt: Number(directory?.createdAt) || 0, updatedAt: Number(directory?.updatedAt) || 0, reviewStatus: directory?.reviewStatus || 'active', reviewUpdatedAt: Number(directory?.reviewUpdatedAt) || 0, folderCount: 0, fileCount: 0, size: 0 });
                }
                if (item.path !== childPath) children.get(childPath).folderCount++;
            }
            // Aggregate each descendant once. Rebuilding an entire subtree
            // snapshot per child made one user's wide listing block everyone.
            const files = [];
            for (const item of ownerRecords(owner)) {
                const folderPath = normalizePath(item.folderPath || '');
                if (folderPath === safe) { files.push({ ...item, kind: 'file' }); continue; }
                if (!folderPath.startsWith(prefix)) continue;
                const child = children.get(joinPath(safe, folderPath.slice(prefix.length).split('/')[0]));
                if (!child) continue;
                child.fileCount++;
                child.size += Math.max(0, Number(item.size) || 0);
                child.updatedAt = Math.max(child.updatedAt, Number(item.updatedAt || item.createdAt) || 0);
            }
            const folders = [...children.values()];
            return {
                path: safe,
                breadcrumbs: safe.split('/').filter(Boolean).map((name, index, all) => ({ name, path: all.slice(0, index + 1).join('/') })),
                folders,
                files,
                summary: { folderCount: folders.length, fileCount: files.length, size: files.reduce((sum, item) => sum + Math.max(0, Number(item.size) || 0), 0) }
            };
        },
        listDirectories(ownerId) {
            return ownerDirectories(ownerId).map(item => ({ ...item, name: baseName(item.path), parentPath: parentPath(item.path) })).sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
        },
        getDirectory(ownerId, folderPath) {
            const safe = normalizePath(folderPath);
            if (safe && !directoryExists(ownerId, safe)) return null;
            const snapshot = directorySnapshot(ownerId, safe);
            delete snapshot.files;
            delete snapshot.directories;
            return snapshot;
        },
        getDirectoryTree(ownerId, folderPath) {
            const safe = normalizePath(folderPath);
            if (safe && !directoryExists(ownerId, safe)) return null;
            return directorySnapshot(ownerId, safe);
        },
        renameDirectory(ownerId, folderPath, newName, maxDepth) {
            return this.moveDirectory(ownerId, folderPath, parentPath(folderPath), maxDepth, newName);
        },
        moveDirectory(ownerId, folderPath, destinationPath, maxDepth, requestedName = '') {
            const owner = String(ownerId);
            const source = normalizePath(folderPath);
            const destination = normalizePath(destinationPath);
            const name = normalizeSegment(requestedName || baseName(source));
            if (!source || !name) throw new Error('telegram-drive-folder-name-required');
            if (!directoryExists(owner, source)) throw new Error('telegram-drive-folder-not-found');
            if (!directoryExists(owner, destination)) throw new Error('telegram-drive-destination-not-found');
            if (destination === source || destination.startsWith(`${source}/`)) throw new Error('telegram-drive-folder-cycle');
            const target = joinPath(destination, name);
            if (target === source) return this.getDirectory(owner, source);
            assertNoPendingTree(owner, source);
            assertNoPendingTree(owner, target);
            if (directoryExists(owner, target)) throw new Error('telegram-drive-folder-exists');
            assertFreeName(owner, destination, name);
            const snapshot = directorySnapshot(owner, source);
            const rewrite = oldPath => joinPath(target, normalizePath(oldPath).slice(source.length).replace(/^\//, ''));
            for (const directory of snapshot.directories) assertDepth(rewrite(directory.path), maxDepth);
            for (const file of snapshot.files) assertDepth(rewrite(file.folderPath || ''), maxDepth);
            for (const directory of snapshot.directories) directories.delete(directoryKey(owner, directory.path));
            const now = Date.now();
            for (const directory of snapshot.directories) {
                const nextPath = rewrite(directory.path);
                directories.set(directoryKey(owner, nextPath), { ...directory, path: nextPath, updatedAt: now });
            }
            for (const file of snapshot.files) Object.assign(file, { folderPath: rewrite(file.folderPath || ''), updatedAt: now });
            touchDirectory(owner, parentPath(source), now);
            touchDirectory(owner, destination, now);
            persist();
            return this.getDirectory(owner, target);
        },
        removeDirectory(ownerId, folderPath, recursive = false) {
            const owner = String(ownerId);
            const safe = normalizePath(folderPath);
            if (!safe) throw new Error('telegram-drive-root-delete-forbidden');
            assertNoPendingTree(owner, safe);
            const snapshot = directorySnapshot(owner, safe);
            if (!snapshot.directories.length) throw new Error('telegram-drive-folder-not-found');
            if (!recursive && (snapshot.files.length || snapshot.directories.length > 1)) throw new Error('telegram-drive-folder-not-empty');
            for (const file of snapshot.files) records.delete(file.id);
            for (const directory of snapshot.directories) directories.delete(directoryKey(owner, directory.path));
            touchDirectory(owner, parentPath(safe));
            persist();
            return { removedDirectories: snapshot.directories.length, removedFiles: snapshot.files.length };
        },
        get(ownerId, id) { const item = records.get(String(id)); return item?.ownerId === String(ownerId) ? item : null; },
        getFileProperties(ownerId, id) { const item = this.get(ownerId, id); return item ? { ...item, kind: 'file', parentPath: normalizePath(item.folderPath || '') } : null; },
        moveFile(ownerId, id, destinationPath, maxDepth) {
            const item = this.get(ownerId, id);
            const destination = normalizePath(destinationPath);
            if (!item) throw new Error('telegram-drive-file-not-found');
            if (!directoryExists(ownerId, destination)) throw new Error('telegram-drive-destination-not-found');
            assertDepth(destination, maxDepth);
            if (normalizePath(item.folderPath || '') === destination) return item;
            assertFreeName(ownerId, destination, item.name, item.id);
            const oldParent = normalizePath(item.folderPath || '');
            Object.assign(item, { folderPath: destination, updatedAt: Date.now() });
            touchDirectory(ownerId, oldParent);
            touchDirectory(ownerId, destination);
            persist();
            return item;
        },
        renameFile(ownerId, id, newName) {
            const item = this.get(ownerId, id);
            const name = normalizeSegment(newName, 180);
            if (!item) throw new Error('telegram-drive-file-not-found');
            if (!name) throw new Error('telegram-drive-file-name-required');
            assertFreeName(ownerId, item.folderPath || '', name, item.id);
            Object.assign(item, { name, updatedAt: Date.now(), captionSyncPending: true });
            touchDirectory(ownerId, item.folderPath || '');
            persist();
            return item;
        },
        modifyFile(ownerId, id, patch, maxDepth) {
            const item = this.get(ownerId, id);
            if (!item) throw new Error('telegram-drive-file-not-found');
            const destination = Object.hasOwn(patch, 'folderPath') ? normalizePath(patch.folderPath) : item.folderPath || '';
            const name = Object.hasOwn(patch, 'name') ? normalizeSegment(patch.name, 180) : item.name;
            if (!directoryExists(ownerId, destination)) throw new Error('telegram-drive-destination-not-found');
            assertDepth(destination, maxDepth);
            assertFreeName(ownerId, destination, name, item.id);
            touchDirectory(ownerId, item.folderPath || '');
            const renamed = name !== item.name;
            Object.assign(item, { folderPath: destination, name, updatedAt: Date.now(), ...(renamed ? { captionSyncPending: true } : {}) });
            touchDirectory(ownerId, destination); persist(); return item;
        },
        hasChannel(channelId) { return [...records.values()].some(item => String(item.channelId) === String(channelId)); },
        begin({ owner, metadata = {}, folderPath, files, maxDepth, uploadLimit = maxFileSize(), backendId = '', sourceAppId = '', channelId = '', replaceId = '' }) {
            const safePath = normalizePath(folderPath); assertDepth(safePath, maxDepth);
            const incoming = Array.isArray(files) ? files : [];
            if (incoming.length > 100) throw new Error('DISK_BATCH_LIMIT');
            if (!incoming.length) throw new Error('telegram-drive-files-required');
            const total = incoming.reduce((sum, file) => sum + Math.max(0, Number(file?.size) || 0), 0);
            if (incoming.some(file => !Number.isSafeInteger(file?.size) || file.size < 0 || file.size > uploadLimit)) throw new Error('telegram-drive-upload-size-invalid');
            const names = new Set();
            for (const file of incoming) {
                const name = normalizeSegment(file.name, 180);
                const folder = Object.hasOwn(file, 'folderPath') ? normalizePath(file.folderPath) : safePath;
                assertDepth(folder, maxDepth);
                const key = folder + '/' + name;
                if (names.has(key)) throw new Error('DISK_NAME_CONFLICT');
                names.add(key); assertFreeName(owner.id, folder, name, replaceId);
                // A batch cannot reserve both a file and a descendant of that file.
                const parts = folder.split('/').filter(Boolean);
                for (let i = 0; i < parts.length; i++) {
                    const parent = parts.slice(0, i).join('/');
                    if ([...ownerRecords(owner.id), ...pendingFiles(owner.id), ...incoming.map(entry => ({ ...entry, folderPath: Object.hasOwn(entry, 'folderPath') ? normalizePath(entry.folderPath) : safePath }))].some(entry => (entry.folderPath || '') === parent && entry.name === parts[i])) throw new Error('DISK_NAME_CONFLICT');
                }
                if ([...uploads.values()].some(job => job.owner.id === owner.id && job.files.some(entry => entry.folderPath === folder && entry.name === name))) throw new Error('DISK_NAME_CONFLICT');
            }
            const normalizeUploadParts = file => {
                const submitted = Array.isArray(file.parts) ? file.parts : [];
                const parts = submitted.length ? submitted.map((part, index) => ({
                    index: index + 1,
                    byteStart: Number(part.byteStart),
                    byteEnd: Number(part.byteEnd),
                    size: Number(part.size)
                })) : Array.from({ length: Math.max(1, Math.ceil(file.size / MAX_TELEGRAM_PART_SIZE)) }, (_, index) => {
                    const byteStart = index * MAX_TELEGRAM_PART_SIZE;
                    const size = Math.min(MAX_TELEGRAM_PART_SIZE, file.size - byteStart);
                    return { index: index + 1, byteStart, byteEnd: byteStart + size - 1, size };
                });
                let next = 0;
                for (const part of parts) {
                    if (!Number.isSafeInteger(part.byteStart) || !Number.isSafeInteger(part.byteEnd) || !Number.isSafeInteger(part.size) ||
                        part.byteStart !== next || part.byteEnd !== part.byteStart + part.size - 1 || part.size < 0 || part.size > MAX_TELEGRAM_PART_SIZE) throw new Error('UPLOAD_PART_PLAN_INVALID');
                    next = part.byteEnd + 1;
                }
                if (next !== file.size || parts.length > 10000) throw new Error('UPLOAD_PART_PLAN_INVALID');
                return parts;
            };
            const id = crypto.randomUUID(); const dir = path.join(stagingRoot, id); fs.mkdirSync(dir, { recursive: true });
            const job = { id, owner, metadata, backendId, channelId: String(channelId || ''), sourceAppId: String(sourceAppId || ''), replaceId: String(replaceId || ''), uploadLimit, folderPath: safePath,
files: incoming.map((file, index) => ({ index, logicalId: crypto.randomUUID(), folderPath: Object.hasOwn(file, 'folderPath') ? normalizePath(file.folderPath) : safePath, name: normalizeSegment(file?.name || `file-${index + 1}`, 180) || `file-${index + 1}`, type: String(file?.type || 'application/octet-stream').slice(0, 120), size: Number(file?.size) || 0, mediaIndex: file.mediaIndex && typeof file.mediaIndex === 'object' ? file.mediaIndex : { mode: 'unavailable' }, parts: normalizeUploadParts(file), path: '', received: 0, chunks: [] })), dir, createdAt: Date.now(), maxDepth };
            uploads.set(id, job);
            try { persistUpload(job); return job; }
            catch (error) { stopUpload(job); removeStaging(job); uploads.delete(id); throw error; }
        },
        setUploadContext(uploadId, patch = {}) {
            const job = uploads.get(String(uploadId)); if (!job) return null;
            if (patch.operationId) job.operationId = String(patch.operationId);
            if (patch.channelId) job.channelId = String(patch.channelId);
            persistUpload(job); return job;
        },
        async setUploadContextAsync(uploadId, patch = {}) {
            const job = uploads.get(String(uploadId)); if (!job) return null;
            if (patch.operationId) job.operationId = String(patch.operationId);
            if (patch.channelId) job.channelId = String(patch.channelId);
            await persistUploadAsync(job); return job;
        },
        async receive(uploadId, index, request, onProgress) {
            const job = uploads.get(String(uploadId)); const file = job?.files[Number(index)]; if (!job || !file) throw new Error('telegram-drive-upload-not-found');
            if (file.path || file.receiving || file.chunks?.length) throw new Error('telegram-drive-upload-already-received');
            const receiverDone = registerReceiver(job, request);
            file.receiving = true;
            const target = path.join(job.dir, `${file.index}-${file.name}`); let size = 0; const digest = crypto.createHash('sha256');
            request.on('data', chunk => { size += chunk.length; digest.update(chunk); if (size > file.size || size > job.uploadLimit) request.destroy(new Error('telegram-drive-upload-size-mismatch')); onProgress?.(size, file.size); });
            try {
                await receiveToStaging(request, target);
                assertUploadActive(job);
                if (size !== file.size) throw new Error('telegram-drive-upload-size-mismatch');
                file.path = target; file.received = size;
                if (!file.chunks.length) file.chunks.push({ path: target, offset: 0, size, sha256: digest.digest('hex'), partIndex: 1, status: 'queued', remote: null });
                await persistUploadAsync(job);
                assertUploadActive(job);
                return { received: size };
            } catch (error) { unlinkStaging(job, target); throw error; }
            finally { file.receiving = false; receiverDone(); }
        },
        async receivePart(uploadId, index, request, range, onProgress) {
            const job = uploads.get(String(uploadId)), file = job?.files[Number(index)];
            if (!file || !job) throw new Error('telegram-drive-upload-not-found');
            if (file.receiving || file.path) throw new Error('telegram-drive-upload-already-received');
            const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(range || ''));
            if (!match) throw new Error('UPLOAD_RANGE_INVALID');
            const [start, end, total] = match.slice(1).map(Number);
            const length = end - start + 1;
            const plan = file.parts[file.chunks.length];
            if (![start, end, total].every(Number.isSafeInteger) || total !== file.size || start !== file.received || end < start || end >= total || !plan || plan.byteStart !== start || plan.byteEnd !== end || plan.size !== length) throw new Error('UPLOAD_RANGE_INVALID');
            const receiverDone = registerReceiver(job, request);
            file.receiving = true;
            const target = path.join(job.dir, `${file.index}-part-${file.chunks?.length || 0}`);
            let size = 0; const digest = crypto.createHash('sha256');
            // Create the chunk before the request finishes. The Telegram reader
            // can then follow writtenBytes while the browser keeps appending.
            const chunk = prepareGrowingChunk({ path: target, offset: start, size: length, writtenBytes: 0, sourceComplete: false, sha256: '', partIndex: plan.index, status: 'receiving', remote: null, finalized: false });
            file.chunks.push(chunk);
            try {
                await persistUploadAsync(job);
                await receiveToStaging(request, target, bytes => {
                    size += bytes.length;
                    if (size > length) throw new Error('telegram-drive-upload-size-mismatch');
                    digest.update(bytes);
                    chunk.writtenBytes = size;
                    notifyChunk(chunk);
                    onProgress?.(size);
                });
                assertUploadActive(job);
                if (size !== length) throw new Error('telegram-drive-upload-size-mismatch');
                chunk.sha256 = digest.digest('hex');
                chunk.sourceComplete = true;
                if (chunk.status === 'receiving') chunk.status = 'queued';
                file.received += size;
                await persistUploadAsync(job);
                notifyChunk(chunk);
                assertUploadActive(job);
                return { received: file.received, complete: file.received === file.size };
            } catch (error) {
                chunk.sourceError = error;
                chunk.sourceComplete = true;
                notifyChunk(chunk);
                throw error;
            } finally { file.receiving = false; receiverDone(); }
        },
        async receiveThumbnail(uploadId, index, request, declaredSize, declaredType = 'image/jpeg') {
            const job = uploads.get(String(uploadId)), file = job?.files[Number(index)];
            const sizeLimit = 2 * 1024 * 1024;
            if (!job || !file) throw new Error('telegram-drive-upload-not-found');
            const expected = Number(declaredSize);
            if (!Number.isSafeInteger(expected) || expected <= 0 || expected > sizeLimit || !String(declaredType).startsWith('image/')) throw new Error('UPLOAD_THUMBNAIL_INVALID');
            if (file.thumbnail?.path || file.thumbnail?.receiving || file.thumbnail?.remote) throw new Error('telegram-drive-upload-already-received');
            const receiverDone = registerReceiver(job, request);
            const target = path.join(job.dir, `${file.index}-media-cover.jpg`);
            const thumbnail = file.thumbnail = { size: expected, type: String(declaredType).slice(0, 120), path: target, receiving: true, status: 'receiving', remote: null };
            let received = 0;
            request.on('data', chunk => { received += chunk.length; if (received > expected || received > sizeLimit) request.destroy(new Error('UPLOAD_THUMBNAIL_INVALID')); });
            try {
                await receiveToStaging(request, target);
                assertUploadActive(job);
                if (received !== expected) throw new Error('UPLOAD_THUMBNAIL_INVALID');
                // The Telegram pipeline must not consume a cover until its
                // receiving manifest has been saved. Otherwise a failed save
                // can clear the thumbnail while Telegram is accepting it.
                await persistUploadAsync(job);
                assertUploadActive(job);
                Object.assign(thumbnail, { receiving: false, status: 'queued' });
                return { received };
            } catch (error) {
                file.thumbnail = null; unlinkStaging(job, target); throw error;
            }
            finally { receiverDone(); }
        },
        upload(uploadId) { return uploads.get(String(uploadId)); },
        uploadQueue(uploadId) {
            const job = uploads.get(String(uploadId));
            if (!job) return null;
            const chunks = job.files.flatMap(file => file.chunks || []);
            const queued = chunks.filter(part => part.status === 'queued' || (part.status === 'receiving' && Number(part.writtenBytes) > 0));
            const pending = chunks.filter(part => part.status !== 'uploaded');
            const completeSource = part => part.sourceComplete === true || (!Object.hasOwn(part, 'sourceComplete') && part.status !== 'receiving');
            const stagedBytes = part => completeSource(part) ? Number(part.size) || 0 : Math.max(0, Math.min(Number(part.size) || 0, Number(part.writtenBytes) || 0));
            return {
                queuedParts: queued.length,
                queuedBytes: queued.reduce((sum, part) => sum + stagedBytes(part), 0),
                pendingParts: pending.length,
                pendingBytes: pending.reduce((sum, part) => sum + stagedBytes(part), 0),
                uploadedParts: chunks.filter(part => part.status === 'uploaded').length,
                finalizedParts: chunks.filter(part => part.finalized === true).length,
                receivedParts: chunks.filter(completeSource).length,
                totalParts: job.files.reduce((sum, file) => sum + file.parts.length, 0)
            };
        },
        markPartUploading(uploadId, fileIndex, partIndex) {
            const chunk = uploads.get(String(uploadId))?.files[Number(fileIndex)]?.chunks?.find(item => item.partIndex === Number(partIndex));
            if (!chunk || !['queued', 'receiving'].includes(chunk.status) || (chunk.status === 'receiving' && !Number(chunk.writtenBytes))) throw new Error('UPLOAD_PART_STATE_INVALID');
            chunk.status = 'uploading'; return chunk;
        },
        markPartUploaded(uploadId, fileIndex, partIndex, remote) {
            const chunk = uploads.get(String(uploadId))?.files[Number(fileIndex)]?.chunks?.find(item => item.partIndex === Number(partIndex));
            if (!chunk) throw new Error('UPLOAD_PART_STATE_INVALID');
            chunk.status = 'uploaded'; chunk.remote = remote;
            persistUpload(uploads.get(String(uploadId)));
            unlinkStaging(uploads.get(String(uploadId)), chunk.path);
            return chunk;
        },
        async markPartsUploaded(uploadId, remotes) {
            const job = uploads.get(String(uploadId));
            if (!job) throw new Error('UPLOAD_PART_STATE_INVALID');
            assertUploadActive(job);
            const confirmed = remotes.map(remote => {
                const chunk = job.files[Number(remote.fileIndex)]?.chunks?.find(item => item.partIndex === Number(remote.partIndex));
                if (!chunk) throw new Error('UPLOAD_PART_STATE_INVALID');
                return { chunk, remote };
            });
            // Bind every accepted message before persistence can fail. Rollback
            // must retain the entire album even if its manifest cannot be saved.
            for (const { chunk, remote } of confirmed) { chunk.status = 'uploaded'; chunk.remote = remote; }
            await persistUploadAsync(job);
            assertUploadActive(job);
            for (const { chunk } of confirmed) unlinkStaging(job, chunk.path);
            return confirmed.map(entry => entry.chunk);
        },
        async markPartsFinalized(uploadId, remotes, cleanupParts = []) {
            const job = uploads.get(String(uploadId));
            if (!job) throw new Error('UPLOAD_PART_STATE_INVALID');
            assertUploadActive(job);
            for (const remote of remotes || []) {
                const chunk = job.files[Number(remote.fileIndex)]?.chunks?.find(item => item.partIndex === Number(remote.partIndex));
                if (!chunk?.remote) throw new Error('UPLOAD_PART_STATE_INVALID');
                chunk.remote = remote;
                chunk.finalized = true;
            }
            const cleanup = new Map((job.pendingCleanupParts || []).map(remote => [Number(remote.messageId), remote]));
            for (const remote of cleanupParts || []) {
                const messageId = Number(remote?.messageId);
                if (Number.isSafeInteger(messageId) && messageId > 0) cleanup.set(messageId, remote);
            }
            job.pendingCleanupParts = [...cleanup.values()];
            await persistUploadAsync(job);
            return remotes;
        },
        async clearUploadCleanupParts(uploadId, messageIds = []) {
            const job = uploads.get(String(uploadId));
            if (!job) return [];
            const removed = new Set((messageIds || []).map(Number));
            job.pendingCleanupParts = (job.pendingCleanupParts || []).filter(remote => !removed.has(Number(remote.messageId)));
            await persistUploadAsync(job);
            return job.pendingCleanupParts;
        },
        async keepUploadRollbackParts(uploadId, remotes) {
            const job = uploads.get(String(uploadId));
            if (!job) throw new Error('UPLOAD_NOT_FOUND');
            assertUploadActive(job);
            const retained = new Map((job.pendingRollbackParts || []).map(remote => [Number(remote.messageId), remote]));
            for (const remote of remotes || []) {
                const messageId = Number(remote?.messageId);
                if (!Number.isSafeInteger(messageId) || messageId <= 0) continue;
                retained.set(messageId, { ...retained.get(messageId), ...remote, messageId });
            }
            // These messages need rollback only. They must never contribute to
            // uploaded chunk counts or replace another message for the same part.
            job.pendingRollbackParts = [...retained.values()];
            await persistUploadAsync(job);
            return job.pendingRollbackParts;
        },
        markThumbnailUploading(uploadId, fileIndex) {
            const thumbnail = uploads.get(String(uploadId))?.files[Number(fileIndex)]?.thumbnail;
            if (!thumbnail || thumbnail.status !== 'queued') throw new Error('UPLOAD_THUMBNAIL_STATE_INVALID');
            thumbnail.status = 'uploading'; return thumbnail;
        },
        markThumbnailUploaded(uploadId, fileIndex, remote) {
            const job = uploads.get(String(uploadId)), thumbnail = job?.files[Number(fileIndex)]?.thumbnail;
            if (!thumbnail) throw new Error('UPLOAD_THUMBNAIL_STATE_INVALID');
            thumbnail.status = 'uploaded'; thumbnail.remote = remote; persistUpload(job);
            unlinkStaging(job, thumbnail.path);
            return thumbnail;
        },
        async markThumbnailUploadedAsync(uploadId, fileIndex, remote) {
            const job = uploads.get(String(uploadId)), thumbnail = job?.files[Number(fileIndex)]?.thumbnail;
            if (!thumbnail) throw new Error('UPLOAD_THUMBNAIL_STATE_INVALID');
            assertUploadActive(job);
            thumbnail.status = 'uploaded'; thumbnail.remote = remote;
            await persistUploadAsync(job);
            assertUploadActive(job);
            unlinkStaging(job, thumbnail.path); return thumbnail;
        },
        resetUploadingThumbnail(uploadId, fileIndex) {
            const thumbnail = uploads.get(String(uploadId))?.files[Number(fileIndex)]?.thumbnail;
            if (thumbnail?.status === 'uploading') thumbnail.status = 'queued';
        },
        async failThumbnailAsync(uploadId, fileIndex) {
            const job = uploads.get(String(uploadId)), thumbnail = job?.files[Number(fileIndex)]?.thumbnail;
            if (!thumbnail || thumbnail.remote) throw new Error('UPLOAD_THUMBNAIL_STATE_INVALID');
            assertUploadActive(job);
            thumbnail.status = 'failed'; thumbnail.warning = 'TELEGRAM_THUMBNAIL_UPLOAD_FAILED';
            await persistUploadAsync(job);
            unlinkStaging(job, thumbnail.path);
        },
        resetUploadingParts(uploadId) {
            const job = uploads.get(String(uploadId));
            for (const chunk of job?.files.flatMap(file => file.chunks || []) || []) if (chunk.status === 'uploading') chunk.status = chunk.sourceComplete === false ? 'receiving' : 'queued';
        },
        uploadResults(uploadId) {
            const job = uploads.get(String(uploadId));
            if (!job) return [];
            return job.files.map(file => {
                const parts = file.chunks.map(chunk => chunk.remote).filter(Boolean).sort((a, b) => a.partIndex - b.partIndex);
                if (parts.length !== file.parts.length || file.chunks.some(chunk => chunk.finalized !== true)) return null;
                const first = parts[0] || {};
                return { ...first, parts, partCount: parts.length, size: file.size, originalSize: file.size, thumbnail: file.thumbnail?.remote || null, captionWarning: parts.some(part => part.captionWarning) ? 'TELEGRAM_CAPTION_UPDATE_FAILED' : '' };
            });
        },
        validateUpload(uploadId) {
            const job = this.finish(uploadId);
            for (const file of job.files) {
                assertFreeName(job.owner.id, file.folderPath, file.name, job.replaceId || '', job.id);
                assertDepth(file.folderPath, job.maxDepth);
                const parts = file.folderPath.split('/').filter(Boolean);
                for (let index = 0; index < parts.length; index++) {
                    if (ownerRecords(job.owner.id).some(item => item.folderPath === parts.slice(0, index).join('/') && item.name === parts[index])) throw new Error('DISK_NAME_CONFLICT');
                }
            }
        },
        finish(uploadId) { const job = uploads.get(String(uploadId)); if (!job) throw new Error('telegram-drive-upload-not-found'); if (job.files.some(file => file.receiving || (!file.path && (!file.chunks?.length || file.received !== file.size)))) throw new Error('telegram-drive-upload-incomplete'); return job; },
        ownsUpload(ownerId, uploadId) { const job = uploads.get(String(uploadId)); return Boolean(job && String(job.owner?.id) === String(ownerId)); },
        commit(uploadId, channelId, sent) {
            const job = this.finish(uploadId); const now = Date.now();
            if (job.receivers?.size || job.manifestPending) throw new Error('UPLOAD_IN_PROGRESS');
            if (job.pendingRollbackParts?.length) throw new Error('UPLOAD_ROLLBACK_PENDING');
            if (job.files.some(file => file.chunks.some(chunk => chunk.finalized !== true))) throw new Error('TELEGRAM_FINALIZATION_INCOMPLETE');
            this.validateUpload(uploadId);
            for (const file of job.files) if (file.folderPath) ensureDirectoryRecords(job.owner.id, file.folderPath, job.maxDepth || 20, now, job.id);
            const created = job.files.map((file, index) => {
                const remote = sent[index] || {};
                const parts = (Array.isArray(remote.parts) && remote.parts.length ? remote.parts : [remote]).map((part, partIndex, all) => ({ fileId: String(part.fileId || ''), fileUniqueId: String(part.fileUniqueId || ''), messageId: Number(part.messageId) || 0, messageDate: Number(part.messageDate) || now, mediaType: part.mediaType || 'document', mediaGroupId: String(part.mediaGroupId || ''), logicalFileId: file.logicalId, originalSize: file.size, partIndex: Number(part.partIndex) || partIndex + 1, partCount: Number(part.partCount) || all.length, size: Number(part.size) || (all.length === 1 ? file.size : 0), offset: Number(part.offset) || 0, sha256: String(part.sha256 || '') }));
                const thumbnail = remote.thumbnail ? { fileId: String(remote.thumbnail.fileId || ''), fileUniqueId: String(remote.thumbnail.fileUniqueId || ''), messageId: Number(remote.thumbnail.messageId) || 0, messageDate: Number(remote.thumbnail.messageDate) || now, mediaType: remote.thumbnail.mediaType || 'document', size: Number(remote.thumbnail.size) || 0, type: String(remote.thumbnail.type || 'image/jpeg') } : null;
                const previous = job.replaceId ? this.get(job.owner.id, job.replaceId) : null;
                if (job.replaceId && (!previous || previous.folderPath !== file.folderPath || previous.name !== file.name)) throw new Error('DISK_NAME_CONFLICT');
                const item = { id: previous?.id || file.logicalId || crypto.randomUUID(), ownerId: String(job.owner.id), ownerName: String(job.owner.name || ''), ownerUsername: String(job.owner.username || ''), folderPath: file.folderPath, name: file.name, type: file.type, size: file.size, channelId: String(channelId), messageId: Number(remote.messageId) || 0, mediaGroupId: String(remote.mediaGroupId || ''), fileId: String(remote.fileId || ''), fileUniqueId: String(remote.fileUniqueId || ''), parts, partCount: parts.length, thumbnail, mediaIndex: file.mediaIndex || { mode: 'unavailable' }, fileIdHistory: [], createdAt: now, updatedAt: now, lastCheckedAt: 0 };
                if (previous) for (const part of parts) part.logicalFileId = item.id;
                item.metadata = job.metadata; item.backendId = job.backendId;
                item.sourceAppId = job.sourceAppId || '';
                item.captionWarning = remote.captionWarning || '';
                item.captionSyncPending = Boolean(remote.captionWarning);
                if (previous) item.pendingRemoteCleanup = [...(previous.pendingRemoteCleanup || []), previous].map(old => ({
                    name: old.name, channelId: old.channelId, backendId: old.backendId, createdAt: old.createdAt,
                    parts: old.parts || [], fileId: old.fileId, messageId: old.messageId, thumbnail: old.thumbnail || null
                }));
                const stagedCleanup = (job.pendingCleanupParts || []).filter(part => String(part.logicalFileId || '') === String(file.logicalId || '') || Number(part.fileIndex) === index);
                if (stagedCleanup.length) {
                    item.pendingRemoteCleanup = [...(item.pendingRemoteCleanup || []), {
                        name: file.name, channelId: String(channelId), backendId: job.backendId || '', createdAt: job.createdAt,
                        parts: stagedCleanup, fileId: '', messageId: 0, thumbnail: null
                    }];
                }
                records.set(item.id, item); return item;
            });
            for (const file of job.files) touchDirectory(job.owner.id, file.folderPath, now);
            persist();
            stopUpload(job); removeStaging(job); uploads.delete(job.id); return created;
        },
        abort(uploadId) { const job = uploads.get(String(uploadId)); if (!job) return; stopUpload(job); removeStaging(job); uploads.delete(job.id); },
        async abortAsync(uploadId) {
            const job = uploads.get(String(uploadId)); if (!job) return;
            if (job.abortPromise) return job.abortPromise;
            if (job.preservePromise) { await job.preservePromise; return; }
            const pending = (async () => {
                stopUpload(job);
                await Promise.all([...(job.receivers || [])].map(receiver => receiver.done));
                await job.manifestWrite?.catch(() => {});
                await fsp.rm(job.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
                uploads.delete(job.id);
            })();
            job.abortPromise = pending;
            try { await pending; }
            finally { if (job.abortPromise === pending) job.abortPromise = null; }
        },
        putMetadataObject(owner, folderPath, name, type = 'application/octet-stream', metadata = {}, maxDepth = 20, replaceId = '') {
            const safe = normalizePath(folderPath), fileName = normalizeSegment(name, 180), now = Date.now();
            assertDepth(safe, maxDepth);
            const previous = replaceId ? this.get(owner.id, replaceId) : null;
            if (replaceId && (!previous || previous.folderPath !== safe || previous.name !== fileName)) throw new Error('DISK_NAME_CONFLICT');
            assertFreeName(owner.id, safe, fileName, replaceId);
            ensureDirectoryRecords(owner.id, safe, maxDepth, now);
            const item = { id: previous?.id || crypto.randomUUID(), ownerId: String(owner.id), ownerName: String(owner.name || ''), ownerUsername: String(owner.username || ''), folderPath: safe, name: fileName, type, size: 0, channelId: '', backendId: '', parts: [], partCount: 0, fileId: '', fileUniqueId: '', messageId: 0, thumbnail: null, metadata, createdAt: now, updatedAt: now };
            if (previous) item.pendingRemoteCleanup = [...(previous.pendingRemoteCleanup || []), previous].map(old => ({ name: old.name, channelId: old.channelId, backendId: old.backendId, createdAt: old.createdAt, parts: old.parts || [], fileId: old.fileId, messageId: old.messageId, thumbnail: old.thumbnail || null }));
            records.set(item.id, item); touchDirectory(owner.id, safe, now); persist(); return item;
        },
        putCopiedObject(owner, folderPath, name, source, remotes, backend, maxDepth = 20, replaceId = '', logicalId = '') {
            const safe = normalizePath(folderPath), fileName = normalizeSegment(name, 180), now = Date.now();
            assertDepth(safe, maxDepth);
            const previous = replaceId ? this.get(owner.id, replaceId) : null;
            if (replaceId && (!previous || previous.folderPath !== safe || previous.name !== fileName)) throw new Error('DISK_NAME_CONFLICT');
            assertFreeName(owner.id, safe, fileName, replaceId);
            ensureDirectoryRecords(owner.id, safe, maxDepth, now);
            const id = previous?.id || logicalId || crypto.randomUUID();
            const parts = remotes.map((remote, index) => ({ ...source.parts[index], ...remote, logicalFileId: id, partIndex: index + 1, partCount: remotes.length, originalSize: source.size }));
            const first = parts[0] || {};
            const item = { ...source, id, ownerId: String(owner.id), ownerName: String(owner.name || ''), ownerUsername: String(owner.username || ''), folderPath: safe, name: fileName, backendId: backend.id || '', channelId: String(backend.channelId), parts, partCount: parts.length, fileId: first.fileId || '', fileUniqueId: first.fileUniqueId || '', messageId: first.messageId || 0, mediaGroupId: first.mediaGroupId || '', thumbnail: null, createdAt: now, updatedAt: now };
            delete item.pendingRemoteCleanup;
            if (previous) item.pendingRemoteCleanup = [...(previous.pendingRemoteCleanup || []), previous].map(old => ({ name: old.name, channelId: old.channelId, backendId: old.backendId, createdAt: old.createdAt, parts: old.parts || [], fileId: old.fileId, messageId: old.messageId, thumbnail: old.thumbnail || null }));
            records.set(item.id, item); touchDirectory(owner.id, safe, now); persist(); return item;
        },
        preserveForRecovery(uploadId) {
            const job = uploads.get(String(uploadId));
            if (!job) return null;
            stopUpload(job); persistUpload(job); uploads.delete(job.id); return job;
        },
        async preserveForRecoveryAsync(uploadId) {
            const job = uploads.get(String(uploadId)); if (!job) return null;
            if (job.preservePromise) return job.preservePromise;
            const cleanup = job.abortPromise;
            const pending = (async () => {
                if (cleanup) {
                    await cleanup.catch(() => {});
                    if (uploads.get(job.id) !== job) return null;
                }
                stopUpload(job);
                await Promise.all([...(job.receivers || [])].map(receiver => receiver.done));
                await persistUploadAsync(job, true);
                uploads.delete(job.id); return job;
            })();
            job.preservePromise = pending;
            try { return await pending; }
            finally { if (job.preservePromise === pending) job.preservePromise = null; }
        },
        finalizeExpired(uploadId) { this.abort(uploadId); },
        recoveredUploads() { return recoveredUploads.splice(0); },
        discardRecovered(job) { if (!job?.dir) return; uploads.delete(String(job.id)); removeStaging(job); },
        update(ownerId, id, patch) { const item = this.get(ownerId, id); if (!item) return null; Object.assign(item, patch, { updatedAt: Date.now() }); records.set(item.id, item); touchDirectory(ownerId, item.folderPath || ''); persist(); return item; },
        clearPendingRemoteCleanup(ownerId, id, messageId, channelId) {
            const item = this.get(ownerId, id); if (!item) return null;
            item.pendingRemoteCleanup = (item.pendingRemoteCleanup || []).filter(old => old.messageId !== messageId || old.channelId !== channelId);
            persist(); return item;
        },
        setReviewStatus(ownerId, id, status) {
            const item = this.get(ownerId, id);
            if (!item || !['active', 'blocked'].includes(status)) throw new Error('FILE_NOT_FOUND');
            Object.assign(item, { reviewStatus: status === 'active' ? '' : status, reviewUpdatedAt: Date.now(), updatedAt: Date.now() });
            persist(); return { ...item };
        },
        setDirectoryReviewStatus(ownerId, folderPath, status) {
            if (!['active', 'blocked'].includes(status)) throw new Error('REVIEW_ACTION_INVALID');
            const snapshot = directorySnapshot(ownerId, folderPath);
            if (!snapshot.path || !snapshot.directories.length) throw new Error('DIRECTORY_NOT_FOUND');
            const now = Date.now();
            for (const directory of snapshot.directories) Object.assign(directory, { reviewStatus: status, reviewUpdatedAt: now, updatedAt: now });
            for (const file of snapshot.files) Object.assign(file, { reviewStatus: status === 'active' ? '' : status, reviewUpdatedAt: now, updatedAt: now });
            persist(); return this.getDirectory(ownerId, folderPath);
        },
        tombstone(ownerId, id) {
            const item = this.get(ownerId, id);
            if (!item) throw new Error('FILE_NOT_FOUND');
            Object.assign(item, { reviewStatus: 'deleted', reviewUpdatedAt: Date.now(), deletedAt: Date.now(), updatedAt: Date.now(), fileId: '', fileUniqueId: '', fileIdHistory: [], messageId: 0, mediaGroupId: '', parts: [], partCount: 0, thumbnail: null });
            persist(); return { ...item };
        },
        tombstoneDirectory(ownerId, folderPath) {
            const snapshot = directorySnapshot(ownerId, folderPath);
            if (!snapshot.path || !snapshot.directories.length) throw new Error('DIRECTORY_NOT_FOUND');
            const now = Date.now();
            for (const directory of snapshot.directories) Object.assign(directory, { reviewStatus: 'deleted', reviewUpdatedAt: now, deletedAt: now, updatedAt: now });
            for (const item of snapshot.files) Object.assign(item, { reviewStatus: 'deleted', reviewUpdatedAt: now, deletedAt: now, updatedAt: now, fileId: '', fileUniqueId: '', fileIdHistory: [], messageId: 0, mediaGroupId: '', parts: [], partCount: 0, thumbnail: null });
            persist(); return this.getDirectory(ownerId, folderPath);
        },
        search(ownerId, query, limit = 500) {
            const needle = String(query || '').trim().toLocaleLowerCase('zh-CN');
            if (!needle) return { folders: [], files: [] };
            const folders = ownerDirectories(ownerId).filter(item => baseName(item.path).toLocaleLowerCase('zh-CN').includes(needle)).slice(0, limit).map(item => ({ ...directorySnapshot(ownerId, item.path), files: undefined, directories: undefined }));
            const files = ownerRecords(ownerId).filter(item => item.name.toLocaleLowerCase('zh-CN').includes(needle)).slice(0, Math.max(0, limit - folders.length)).map(item => ({ ...item, kind: 'file' }));
            return { folders, files };
        },
        adminFiles() { return [...records.values()].map(item => ({ ...item })); },
        adminDirectories() { return [...directories.values()].map(item => ({ ...item })); },
        remove(ownerId, id) { const item = this.get(ownerId, id); if (!item) return false; records.delete(item.id); touchDirectory(ownerId, item.folderPath || ''); persist(); return true; },
        removeMany(ownerId, ids) {
            const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
            let removed = 0;
            for (const item of ownerRecords(ownerId)) {
                if (!wanted.has(item.id)) continue;
                records.delete(item.id);
                touchDirectory(ownerId, item.folderPath || '');
                removed += 1;
            }
            if (removed) persist();
            return removed;
        },
        migrateOwner(oldId, newId) {
            if (oldId === newId) return;
            const files = ownerRecords(oldId); const folders = ownerDirectories(oldId);
            if (!files.length && !folders.length) return;
            for (const file of files) file.ownerId = String(newId);
            for (const folder of folders) {
                directories.delete(directoryKey(oldId, folder.path));
                folder.ownerId = String(newId); directories.set(directoryKey(newId, folder.path), folder);
            }
            persist();
        },
        cleanup() {
            const cutoff = Date.now() - 2 * 60 * 60 * 1000, expired = [];
            for (const job of uploads.values()) if (!job.finishing && !job.expiring && job.createdAt < cutoff) { job.expiring = true; expired.push(job); }
            // Legacy staging from an interrupted previous process has no manifest
            // and therefore no recoverable Telegram message identifiers.
            if (fs.existsSync(stagingRoot)) for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
                if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name) || uploads.has(entry.name)) continue;
                const orphan = path.join(stagingRoot, entry.name);
                if (fs.existsSync(path.join(orphan, 'upload-manifest.json'))) continue;
                if (fs.statSync(orphan).mtimeMs < cutoff) fs.rmSync(orphan, { recursive: true, force: true });
            }
            return expired;
        }
    };
    return store;
}

module.exports = { createTelegramDriveStore, normalizeTelegramDrivePath: normalizePath };
