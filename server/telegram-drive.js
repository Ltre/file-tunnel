'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const { readJson, writeJson, writeJsonAsync } = require('./disk-data');
const { openDiskRepository } = require('./disk-repository');
const { MAX_TELEGRAM_PART_SIZE } = require('./disk-limits');
const { diskErrorCode, diskErrorDetails } = require('./disk-errors');
const { createGrowingFileReadable, notifyGrowingFile, awaitGrowingFileComplete, stopGrowingReaders, awaitGrowingReadersClosed } = require('./growing-file-readable');


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
        version: job.progressive ? 2 : 1, id: job.id, ownerId: String(job.owner?.id || ''), operationId: String(job.operationId || ''),
        backendId: String(job.backendId || ''), channelId: String(job.channelId || ''), createdAt: Number(job.createdAt) || Date.now(),
        ...(job.progressive ? { progressive: true, owner: job.owner, metadata: job.metadata, sourceAppId: job.sourceAppId,
            replaceId: job.replaceId, folderPath: job.folderPath, maxDepth: job.maxDepth, uploadLimit: job.uploadLimit,
            clientDone: Boolean(job.clientDone), finishing: Boolean(job.finishing), committed: Boolean(job.committed),
            collaborationId: job.collaborationId || '', viewerId: job.viewerId || '', operationScope: job.operationScope || '',
            recoveryDisposition: job.recoveryDisposition || '', recoveryErrorCode: job.recoveryErrorCode || '',
            committedIds: job.committedIds || [], cleanupPending: job.cleanupPending || [] } : {}),
        pendingRollbackParts: job.pendingRollbackParts || [],
        files: job.files.map(file => ({ name: file.name, logicalId: file.logicalId, thumbnail: file.thumbnail ? {
            size: file.thumbnail.size, type: file.thumbnail.type, remote: file.thumbnail.remote || null,
            ...(job.progressive ? { path: path.basename(file.thumbnail.path || ''), status: file.thumbnail.status, warning: file.thumbnail.warning || '' } : {})
        } : null, chunks: (file.chunks || []).map(chunk => ({
            partIndex: chunk.partIndex, size: chunk.size, sha256: chunk.sha256 || '', remote: chunk.remote || null,
            ...(job.progressive ? { path: path.basename(chunk.path || ''), offset: chunk.offset, status: chunk.status,
                receivedBytes: chunk.receivedBytes || 0, writtenBytes: chunk.writtenBytes || 0,
                sourceComplete: Boolean(chunk.sourceComplete || chunk.sourceVerified),
                sourceError: chunk.sourceError ? { code: diskErrorCode(chunk.sourceError), message: diskErrorCode(chunk.sourceError), details: diskErrorDetails(chunk.sourceError) } : null,
                tempRemote: chunk.tempRemote || null, finalRemote: chunk.finalRemote || null,
                attempts: chunk.attempts || 0, retryAt: chunk.retryAt || 0, attemptIntent: chunk.attemptIntent || null,
                telegramPushedBytes: Math.min(chunk.size, Math.max(0, Number(chunk.telegramPushedBytes) || 0)),
                updatedAt: Number(chunk.updatedAt) || 0, lastError: chunk.lastError || null,
                unknownResult: Boolean(chunk.unknownResult), safeRetry: Boolean(chunk.safeRetry) } : {})
        })), ...(job.progressive ? { index: file.index, folderPath: file.folderPath, type: file.type, size: file.size,
            mediaIndex: file.mediaIndex, parts: file.parts, received: file.received, finalized: Boolean(file.finalized),
            finalGroups: file.finalGroups || [] } : {}) }))
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
        for (const chunk of job.files.flatMap(file => file.chunks || [])) stopGrowingReaders(chunk);
    };
    const cleanupWarning = (job, error) => console.warn('[disk-upload] staging.cleanup-failed', { uploadId: job.id, code: error.code || 'UNKNOWN', syscall: error.syscall || '' });
    const unlinkStaging = (job, filename) => {
        const source = job?.files.flatMap(file => file.chunks || []).find(chunk => chunk.path === filename);
        if (source?.readers?.size) { source.unlinkPending = true; return; }
        try { if (filename) fs.unlinkSync(filename); }
        catch (error) { if (error.code !== 'ENOENT') cleanupWarning(job, error); }
    };
    const removeStaging = job => {
        if (job.receivers?.size || job.files.some(file => file.chunks?.some(chunk => chunk.readers?.size))) { job.removeStagingPending = true; return; }
        try { fs.rmSync(job.dir, { recursive: true, force: true }); }
        catch (error) { cleanupWarning(job, error); }
    };
    const receiveToStaging = (request, filename) => {
        const output = fs.createWriteStream(filename, { flags: 'wx' });
        // Request-side aborts also destroy this stream. Only filesystem errors
        // emitted by its own open/write syscall identify a staging write error.
        output.once('error', error => { if (error.syscall) persistenceError(error, 'browser-part-write'); });
        return pipeline(request, output);
    };
    const attachGrowingSource = (job, chunk) => {
        chunk.streamFactory = signal => createGrowingFileReadable(chunk, signal);
        chunk.awaitSourceComplete = signal => awaitGrowingFileComplete(chunk, signal);
        chunk.onReadersClosed = () => {
            if (chunk.unlinkPending && !chunk.readers?.size) { chunk.unlinkPending = false; unlinkStaging(job, chunk.path); }
            if (job.removeStagingPending && !job.receivers?.size && !job.files.some(file => file.chunks?.some(part => part.readers?.size))) removeStaging(job);
        };
        return chunk;
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
        begin({ owner, metadata = {}, folderPath, files, maxDepth, uploadLimit = maxFileSize(), backendId = '', sourceAppId = '', channelId = '', replaceId = '', progressive = false }) {
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
            const job = { id, owner, metadata, backendId, channelId: String(channelId || ''), sourceAppId: String(sourceAppId || ''), replaceId: String(replaceId || ''), uploadLimit, folderPath: safePath, progressive: Boolean(progressive), cleanupPending: [],
files: incoming.map((file, index) => ({ index, logicalId: crypto.randomUUID(), folderPath: Object.hasOwn(file, 'folderPath') ? normalizePath(file.folderPath) : safePath, name: normalizeSegment(file?.name || `file-${index + 1}`, 180) || `file-${index + 1}`, type: String(file?.type || 'application/octet-stream').slice(0, 120), size: Number(file?.size) || 0, mediaIndex: file.mediaIndex && typeof file.mediaIndex === 'object' ? file.mediaIndex : { mode: 'unavailable' }, parts: normalizeUploadParts(file), path: '', received: 0, chunks: [] })), dir, createdAt: Date.now(), maxDepth };
            uploads.set(id, job);
            try { persistUpload(job); return job; }
            catch (error) { stopUpload(job); removeStaging(job); uploads.delete(id); throw error; }
        },
        setUploadContext(uploadId, patch = {}) {
            const job = uploads.get(String(uploadId)); if (!job) return null;
            if (patch.operationId) job.operationId = String(patch.operationId);
            if (patch.channelId) job.channelId = String(patch.channelId);
            if (Object.hasOwn(patch, 'progressive')) job.progressive = Boolean(patch.progressive);
            if (Object.hasOwn(patch, 'collaborationId')) job.collaborationId = String(patch.collaborationId || '');
            for (const key of ['viewerId', 'recoveryDisposition', 'recoveryErrorCode']) if (Object.hasOwn(patch, key)) job[key] = String(patch[key] || '');
            if (Object.hasOwn(patch, 'operationScope')) job.operationScope = patch.operationScope && typeof patch.operationScope === 'object' ? structuredClone(patch.operationScope) : patch.operationScope || '';
            persistUpload(job); return job;
        },
        async setUploadContextAsync(uploadId, patch = {}) {
            const job = uploads.get(String(uploadId)); if (!job) return null;
            if (patch.operationId) job.operationId = String(patch.operationId);
            if (patch.channelId) job.channelId = String(patch.channelId);
            if (Object.hasOwn(patch, 'progressive')) job.progressive = Boolean(patch.progressive);
            if (Object.hasOwn(patch, 'collaborationId')) job.collaborationId = String(patch.collaborationId || '');
            for (const key of ['viewerId', 'recoveryDisposition', 'recoveryErrorCode']) if (Object.hasOwn(patch, key)) job[key] = String(patch[key] || '');
            if (Object.hasOwn(patch, 'operationScope')) job.operationScope = patch.operationScope && typeof patch.operationScope === 'object' ? structuredClone(patch.operationScope) : patch.operationScope || '';
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
                if (!file.chunks.length) {
                    const chunk = { path: target, offset: 0, size, sha256: digest.digest('hex'), partIndex: 1, status: 'queued', remote: null };
                    if (job.progressive) Object.assign(chunk, { writtenBytes: size, receivedBytes: size, sourceVerified: true, sourceComplete: false });
                    file.chunks.push(job.progressive ? attachGrowingSource(job, chunk) : chunk);
                }
                await persistUploadAsync(job);
                assertUploadActive(job);
                if (job.progressive) { file.chunks[0].sourceComplete = true; delete file.chunks[0].sourceVerified; notifyGrowingFile(file.chunks[0]); }
                return { received: size };
            } catch (error) { unlinkStaging(job, target); throw error; }
            finally { file.receiving = false; receiverDone(); }
        },
        async receivePart(uploadId, index, request, range, onProgress, { onReady } = {}) {
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
            if (job.progressive) {
                const chunk = attachGrowingSource(job, { path: target, offset: start, size: length, partIndex: plan.index,
                    sha256: '', status: 'receiving', remote: null, tempRemote: null, finalRemote: null,
                    receivedBytes: 0, writtenBytes: 0, sourceComplete: false, sourceError: null });
                file.chunks.push(chunk);
                let output, notified = false, lastSaved = Date.now();
                try {
                    output = await fsp.open(target, 'wx');
                    // The plan must exist durably before Telegram can create a
                    // message for this growing source. Browser data is never
                    // piped through a Telegram stream or its backpressure.
                    await persistUploadAsync(job);
                    for await (const bytes of request) {
                        assertUploadActive(job);
                        const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
                        size += buffer.length; chunk.receivedBytes = size;
                        if (size > length) throw new Error('telegram-drive-upload-size-mismatch');
                        let offset = 0;
                        while (offset < buffer.length) {
                            const { bytesWritten } = await output.write(buffer, offset, buffer.length - offset, chunk.writtenBytes);
                            if (!bytesWritten) throw Object.assign(new Error('UPLOAD_STAGING_WRITE_FAILED'), { code: 'EIO', syscall: 'write' });
                            offset += bytesWritten; chunk.writtenBytes += bytesWritten;
                        }
                        digest.update(buffer); file.received = start + chunk.writtenBytes;
                        onProgress?.(chunk.writtenBytes);
                        notifyGrowingFile(chunk);
                        if (!notified && chunk.writtenBytes > 0) { notified = true; onReady?.(chunk, file, job); }
                        if (Date.now() - lastSaved >= 1000) { await persistUploadAsync(job); lastSaved = Date.now(); }
                    }
                    await output.close(); output = null;
                    assertUploadActive(job);
                    if (size !== length || chunk.writtenBytes !== length || (await fsp.stat(target)).size !== length) throw new Error('telegram-drive-upload-size-mismatch');
                    chunk.sha256 = digest.digest('hex'); chunk.sourceVerified = true;
                    if (chunk.status === 'receiving') chunk.status = 'queued';
                    // Readers remain gated while the atomic manifest replace is
                    // pending. A failed save must not emit a successful EOF.
                    await persistUploadAsync(job);
                    assertUploadActive(job);
                    chunk.sourceComplete = true; delete chunk.sourceVerified;
                    notifyGrowingFile(chunk);
                    if (!notified) onReady?.(chunk, file, job);
                    return { received: file.received, complete: file.received === file.size };
                } catch (error) {
                    if (error.syscall) persistenceError(error, 'browser-part-write');
                    delete chunk.sourceVerified;
                    chunk.sourceComplete = false; chunk.sourceError = error; chunk.status = 'source_aborted';
                    file.received = start; notifyGrowingFile(chunk); stopGrowingReaders(chunk, error);
                    // Retain the manifest/body for rollback and diagnostics.
                    // abortAsync removes them only after writer/readers close.
                    throw error;
                } finally {
                    await output?.close().catch(() => {});
                    file.receiving = false; receiverDone();
                    if (job.removeStagingPending) removeStaging(job);
                }
            }
            request.on('data', chunk => { size += chunk.length; digest.update(chunk); if (size > length) request.destroy(new Error('telegram-drive-upload-size-mismatch')); onProgress?.(size); });
            try {
                await receiveToStaging(request, target);
                assertUploadActive(job);
                if (size !== length) throw new Error('telegram-drive-upload-size-mismatch');
                file.chunks.push({ path: target, offset: start, size, sha256: digest.digest('hex'), partIndex: plan.index, status: 'queued', remote: null });
                file.received += size;
                await persistUploadAsync(job);
                assertUploadActive(job);
                return { received: file.received, complete: file.received === file.size };
            } catch (error) { unlinkStaging(job, target); throw error; }
            finally { file.receiving = false; receiverDone(); }
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
            const queued = chunks.filter(part => part.status === 'queued');
            const confirmed = part => part.status === 'uploaded' || (job.progressive && Boolean(part.tempRemote));
            const pending = chunks.filter(part => !confirmed(part));
            return { queuedParts: queued.length, queuedBytes: queued.reduce((sum, part) => sum + part.size, 0), pendingParts: pending.length, pendingBytes: pending.reduce((sum, part) => sum + (job.progressive ? part.writtenBytes : part.size), 0), uploadedParts: chunks.filter(confirmed).length, receivedParts: chunks.filter(part => !job.progressive || part.sourceComplete).length, totalParts: job.files.reduce((sum, file) => sum + file.parts.length, 0) };
        },
        markPartUploading(uploadId, fileIndex, partIndex) {
            const job = uploads.get(String(uploadId)), chunk = job?.files[Number(fileIndex)]?.chunks?.find(item => item.partIndex === Number(partIndex));
            if (!chunk || (!job.progressive && chunk.status !== 'queued') || (job.progressive && (!['queued', 'receiving', 'retry_wait'].includes(chunk.status) || chunk.sourceError))) throw new Error('UPLOAD_PART_STATE_INVALID');
            chunk.status = job.progressive ? 'pushing' : 'uploading'; return chunk;
        },
        markPartUploaded(uploadId, fileIndex, partIndex, remote) {
            const chunk = uploads.get(String(uploadId))?.files[Number(fileIndex)]?.chunks?.find(item => item.partIndex === Number(partIndex));
            if (!chunk) throw new Error('UPLOAD_PART_STATE_INVALID');
            const job = uploads.get(String(uploadId));
            if (job.progressive) {
                if (!chunk.sourceComplete || chunk.writtenBytes !== chunk.size || !remote?.fileId || !Number.isSafeInteger(remote.messageId) || remote.messageId <= 0) throw new Error('UPLOAD_PART_STATE_INVALID');
                chunk.status = 'push_confirmed'; chunk.tempRemote = remote; chunk.remote = remote; chunk.attemptIntent = null; chunk.unknownResult = false;
                chunk.telegramPushedBytes = chunk.size; chunk.updatedAt = Date.now();
            } else { chunk.status = 'uploaded'; chunk.remote = remote; }
            persistUpload(uploads.get(String(uploadId)));
            if (!job.progressive) unlinkStaging(uploads.get(String(uploadId)), chunk.path);
            return chunk;
        },
        async markPartsUploaded(uploadId, remotes) {
            const job = uploads.get(String(uploadId));
            if (!job) throw new Error('UPLOAD_PART_STATE_INVALID');
            assertUploadActive(job);
            const confirmed = remotes.map(remote => {
                const chunk = job.files[Number(remote.fileIndex)]?.chunks?.find(item => item.partIndex === Number(remote.partIndex));
                if (!chunk) throw new Error('UPLOAD_PART_STATE_INVALID');
                if (job.progressive && (!chunk.sourceComplete || chunk.writtenBytes !== chunk.size || !remote?.fileId || !Number.isSafeInteger(remote.messageId) || remote.messageId <= 0)) throw new Error('UPLOAD_PART_STATE_INVALID');
                return { chunk, remote };
            });
            // Bind every accepted message before persistence can fail. Rollback
            // must retain the entire album even if its manifest cannot be saved.
            for (const { chunk, remote } of confirmed) {
                chunk.status = job.progressive ? 'push_confirmed' : 'uploaded'; chunk.remote = remote;
                if (job.progressive) { chunk.tempRemote = remote; chunk.attemptIntent = null; chunk.unknownResult = false; chunk.telegramPushedBytes = chunk.size; chunk.updatedAt = Date.now(); }
            }
            await persistUploadAsync(job);
            assertUploadActive(job);
            if (!job.progressive) for (const { chunk } of confirmed) unlinkStaging(job, chunk.path);
            return confirmed.map(entry => entry.chunk);
        },
        async markClientDone(uploadId) {
            const job = this.finish(uploadId);
            assertUploadActive(job); job.clientDone = true; job.finishing = true;
            await persistUploadAsync(job); return job;
        },
        async markProgressiveChunkState(uploadId, fileIndex, partIndex, status, details = {}) {
            const job = uploads.get(String(uploadId)), chunk = job?.files[Number(fileIndex)]?.chunks?.find(part => part.partIndex === Number(partIndex));
            if (!job?.progressive || !chunk || !['receiving', 'queued', 'pushing', 'awaiting_response', 'retry_wait', 'push_unknown', 'push_failed', 'source_aborted', 'push_confirmed'].includes(status)) throw new Error('UPLOAD_PART_STATE_INVALID');
            assertUploadActive(job);
            if (chunk.tempRemote && status !== 'push_confirmed') throw new Error('UPLOAD_PART_STATE_INVALID');
            chunk.status = status;
            chunk.updatedAt = Date.now();
            for (const key of ['attempts', 'retryAt']) if (Number.isSafeInteger(details[key]) && details[key] >= 0) chunk[key] = details[key];
            if (Number.isSafeInteger(details.telegramPushedBytes) && details.telegramPushedBytes >= 0) chunk.telegramPushedBytes = Math.min(chunk.size, details.telegramPushedBytes);
            if (details.errorCode) chunk.lastError = { code: diskErrorCode({ code: details.errorCode }), details: diskErrorDetails({ details: details.details }), at: chunk.updatedAt };
            for (const key of ['unknownResult', 'safeRetry']) if (Object.hasOwn(details, key)) chunk[key] = Boolean(details[key]);
            if (status === 'pushing') chunk.attemptIntent = { startedAt: Number.isSafeInteger(details.attemptedAt) && details.attemptedAt > 0 ? details.attemptedAt : chunk.updatedAt, attempt: chunk.attempts || 1 };
            if (status === 'awaiting_response') chunk.attemptIntent = { ...chunk.attemptIntent, bodyComplete: true };
            if (status === 'push_unknown') chunk.unknownResult = true;
            if (['retry_wait', 'push_failed'].includes(status) && !chunk.unknownResult) chunk.attemptIntent = null;
            if (Object.hasOwn(details, 'attemptIntent')) chunk.attemptIntent = details.attemptIntent ? {
                startedAt: Number(details.attemptIntent.startedAt) || chunk.updatedAt,
                attempt: Number(details.attemptIntent.attempt) || chunk.attempts || 1,
                bodyComplete: Boolean(details.attemptIntent.bodyComplete)
            } : null;
            await persistUploadAsync(job); return chunk;
        },
        async markFinalGroupStarted(uploadId, fileIndex, groupIndex, details = {}) {
            const job = uploads.get(String(uploadId)), file = job?.files[Number(fileIndex)];
            if (!job?.progressive || !file || !Number.isSafeInteger(groupIndex) || groupIndex < 0) throw new Error('UPLOAD_FINAL_GROUP_INVALID');
            assertUploadActive(job); file.finalGroups ||= [];
            const existing = file.finalGroups.find(group => group.index === groupIndex);
            if (existing?.status === 'confirmed' || existing?.remotes?.length) return existing;
            if (existing?.intent && existing.status !== 'retry_wait') throw new Error('UPLOAD_FINAL_RESULT_UNKNOWN');
            const group = existing || { index: groupIndex, remotes: [] };
            const startedAt = Number.isSafeInteger(details.startedAt) && details.startedAt > 0 ? details.startedAt : Date.now();
            const attempt = Number.isSafeInteger(details.attempt) && details.attempt > 0 ? details.attempt : (group.attempt || 0) + 1;
            const partIndexes = Array.isArray(details.partIndexes) ? details.partIndexes.filter(index => Number.isSafeInteger(index) && index > 0 && index <= file.parts.length) : [];
            Object.assign(group, { status: 'finalizing', attempt, startedAt, updatedAt: startedAt,
                intent: { startedAt, attempt, partIndexes }, unknownResult: false });
            if (!existing) file.finalGroups.push(group);
            await persistUploadAsync(job); return group;
        },
        async markFinalGroupUploaded(uploadId, fileIndex, groupIndex, remotes) {
            const job = uploads.get(String(uploadId)), file = job?.files[Number(fileIndex)];
            if (!job?.progressive || !file || !Number.isSafeInteger(groupIndex) || groupIndex < 0 || !Array.isArray(remotes) || !remotes.length || remotes.length > 10 || (remotes.length === 1 && file.parts.length !== 1)) throw new Error('UPLOAD_FINAL_GROUP_INVALID');
            assertUploadActive(job); file.finalGroups ||= [];
            const existing = file.finalGroups.find(group => group.index === groupIndex);
            if (existing?.status === 'confirmed') {
                if (JSON.stringify(existing.remotes) !== JSON.stringify(remotes)) throw new Error('UPLOAD_FINAL_GROUP_CONFLICT');
                return existing;
            }
            const indexes = new Set();
            for (const remote of remotes) {
                const chunk = file.chunks.find(part => part.partIndex === Number(remote.partIndex));
                if (!chunk?.tempRemote || !remote.fileId || !Number.isSafeInteger(remote.messageId) || remote.messageId <= 0 || indexes.has(chunk.partIndex) || file.finalGroups.some(group => group.index !== groupIndex && group.remotes?.some(part => part.partIndex === chunk.partIndex))) throw new Error('UPLOAD_FINAL_GROUP_INVALID');
                indexes.add(chunk.partIndex);
            }
            const group = existing || { index: groupIndex };
            Object.assign(group, { status: 'confirmed', remotes: remotes.map(remote => ({ ...remote })), intent: null, unknownResult: false, updatedAt: Date.now() });
            if (!existing) file.finalGroups.push(group);
            for (const remote of remotes) file.chunks.find(chunk => chunk.partIndex === remote.partIndex).finalRemote = { ...remote };
            // Assign every returned message before persistence; a failed save
            // can then retain all newly created album messages for recovery.
            await persistUploadAsync(job); return group;
        },
        async markFinalGroupState(uploadId, fileIndex, groupIndex, status, details = {}) {
            const job = uploads.get(String(uploadId)), file = job?.files[Number(fileIndex)];
            const group = file?.finalGroups?.find(item => item.index === groupIndex);
            if (!job?.progressive || !group || !['retry_wait', 'unknown', 'failed'].includes(status)) throw new Error('UPLOAD_FINAL_GROUP_INVALID');
            assertUploadActive(job); group.status = status; group.unknownResult = status === 'unknown'; group.updatedAt = Date.now();
            if (Number.isSafeInteger(details.retryAt) && details.retryAt >= 0) group.retryAt = details.retryAt;
            if (Number.isSafeInteger(details.attempt) && details.attempt > 0) group.attempt = details.attempt;
            if (details.errorCode) {
                group.errorCode = diskErrorCode({ code: details.errorCode });
                group.lastError = { code: group.errorCode, details: diskErrorDetails({ details: details.details }), at: group.updatedAt };
            }
            if (status !== 'unknown') group.intent = null;
            await persistUploadAsync(job); return group;
        },
        async markProgressiveFinalized(uploadId, fileIndex) {
            const job = uploads.get(String(uploadId)), file = job?.files[Number(fileIndex)];
            if (!job?.progressive || !file || file.chunks.length !== file.parts.length || file.chunks.some(chunk => !chunk.tempRemote || !chunk.sourceComplete)) throw new Error('UPLOAD_FINAL_GROUP_INVALID');
            assertUploadActive(job);
            if (file.chunks.length === 1 && !file.chunks[0].finalRemote) file.chunks[0].finalRemote = file.chunks[0].tempRemote;
            if (file.chunks.some(chunk => !chunk.finalRemote)) throw new Error('UPLOAD_FINAL_GROUP_INCOMPLETE');
            file.finalized = true;
            for (const chunk of file.chunks) { chunk.remote = chunk.finalRemote; chunk.status = 'uploaded'; }
            await persistUploadAsync(job);
            // A confirmed temporary upload is insufficient to discard the
            // source. Keep it until the entire final file is recorded safely.
            for (const chunk of file.chunks) unlinkStaging(job, chunk.path);
            return file;
        },
        async setTemporaryCleanup(uploadId, remotes) {
            const job = uploads.get(String(uploadId));
            if (!job?.progressive || !Array.isArray(remotes)) throw new Error('UPLOAD_NOT_FOUND');
            assertUploadActive(job); job.cleanupPending = remotes.map(remote => ({ ...remote }));
            await persistUploadAsync(job); return job.cleanupPending;
        },
        async markTemporaryCleanup(uploadId, messageIds) {
            const job = uploads.get(String(uploadId));
            if (!job?.progressive) throw new Error('UPLOAD_NOT_FOUND');
            assertUploadActive(job); const removed = new Set(messageIds.map(Number));
            job.cleanupPending = (job.cleanupPending || []).filter(remote => !removed.has(Number(remote.messageId)));
            await persistUploadAsync(job); return job.cleanupPending;
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
            for (const chunk of job?.files.flatMap(file => file.chunks || []) || []) if (chunk.status === 'uploading') chunk.status = 'queued';
        },
        uploadResults(uploadId) {
            const job = uploads.get(String(uploadId));
            if (!job) return [];
            return job.files.map(file => {
                if (job.progressive && !file.finalized) return null;
                const parts = file.chunks.map(chunk => chunk.remote).filter(Boolean).sort((a, b) => a.partIndex - b.partIndex);
                if (parts.length !== file.parts.length) return null;
                const first = parts[0] || {};
                const pendingParts = job.progressive ? file.chunks.map(chunk => chunk.tempRemote).filter(remote => remote && !parts.some(part => part.messageId === remote.messageId)) : [];
                const pendingRemoteCleanup = pendingParts.length ? [{ name: file.name, channelId: job.channelId, backendId: job.backendId, createdAt: job.createdAt, messageId: pendingParts[0].messageId, parts: pendingParts, thumbnail: null, progressive: true, operationId: job.operationId || '' }] : [];
                return { ...first, parts, partCount: parts.length, size: file.size, originalSize: file.size, thumbnail: file.thumbnail?.remote || null, captionWarning: parts.some(part => part.captionWarning) ? 'TELEGRAM_CAPTION_UPDATE_FAILED' : '', ...(job.progressive ? { pendingRemoteCleanup } : {}) };
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
        finish(uploadId) { const job = uploads.get(String(uploadId)); if (!job) throw new Error('telegram-drive-upload-not-found'); if (job.files.some(file => file.receiving || (!file.path && (!file.chunks?.length || file.received !== file.size)) || (job.progressive && file.chunks.some(chunk => !chunk.sourceComplete || chunk.sourceError)))) throw new Error('telegram-drive-upload-incomplete'); return job; },
        ownsUpload(ownerId, uploadId) { const job = uploads.get(String(uploadId)); return Boolean(job && String(job.owner?.id) === String(ownerId)); },
        commit(uploadId, channelId, sent) {
            const job = this.finish(uploadId); const now = Date.now();
            if (job.receivers?.size || job.manifestPending) throw new Error('UPLOAD_IN_PROGRESS');
            if (job.pendingRollbackParts?.length) throw new Error('UPLOAD_ROLLBACK_PENDING');
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
                    parts: old.parts || [], fileId: old.fileId, messageId: old.messageId, thumbnail: old.thumbnail || null,
                    ...(old.progressive ? { progressive: true } : {})
                }));
                if (Array.isArray(remote.pendingRemoteCleanup) && remote.pendingRemoteCleanup.length) item.pendingRemoteCleanup = [...(item.pendingRemoteCleanup || []), ...remote.pendingRemoteCleanup];
                records.set(item.id, item); return item;
            });
            for (const file of job.files) touchDirectory(job.owner.id, file.folderPath, now);
            persist();
            if (job.progressive) {
                job.committed = true; job.committedIds = created.map(file => file.id);
                // The SQLite transaction is authoritative after it succeeds.
                // A manifest cleanup failure must not roll back readable files.
                try { persistUpload(job); } catch (error) { cleanupWarning(job, error); }
            }
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
                await Promise.all(job.files.flatMap(file => file.chunks || []).map(awaitGrowingReadersClosed));
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
                await Promise.all(job.files.flatMap(file => file.chunks || []).map(awaitGrowingReadersClosed));
                await persistUploadAsync(job, true);
                uploads.delete(job.id); return job;
            })();
            job.preservePromise = pending;
            try { return await pending; }
            finally { if (job.preservePromise === pending) job.preservePromise = null; }
        },
        finalizeExpired(uploadId) { this.abort(uploadId); },
        recoveredUploads() { return recoveredUploads.splice(0); },
        async activateRecoveredUpload(manifest) {
            if (!manifest?.progressive || manifest.version !== 2 || !/^[a-f0-9-]{36}$/.test(String(manifest.id || '')) || !manifest.ownerId || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('UPLOAD_RECOVERY_MANIFEST_INVALID');
            if (uploads.has(manifest.id)) return uploads.get(manifest.id);
            const dir = path.join(stagingRoot, manifest.id);
            if (path.resolve(manifest.dir || dir) !== path.resolve(dir)) throw new Error('UPLOAD_RECOVERY_MANIFEST_INVALID');
            const recoveryPath = filename => {
                if (!filename || path.basename(filename) !== filename || /[\\/]/.test(filename)) throw new Error('UPLOAD_RECOVERY_MANIFEST_INVALID');
                return path.join(dir, filename);
            };
            const validRemote = remote => Boolean(remote?.fileId && Number.isSafeInteger(remote.messageId) && remote.messageId > 0);
            const job = { ...manifest, owner: { ...(manifest.owner || {}), id: String(manifest.ownerId) }, dir, closed: false,
                metadata: manifest.metadata || {}, maxDepth: Number(manifest.maxDepth) || 20, uploadLimit: Number(manifest.uploadLimit) || maxFileSize(), files: [] };
            job.folderPath = normalizePath(job.folderPath); assertDepth(job.folderPath, job.maxDepth);
            for (const [index, saved] of manifest.files.entries()) {
                if (!Number.isSafeInteger(saved.size) || saved.size < 0 || saved.size > job.uploadLimit || !saved.logicalId || !Array.isArray(saved.parts) || !saved.parts.length || saved.parts.length > 10000 || !Array.isArray(saved.chunks)) throw new Error('UPLOAD_RECOVERY_MANIFEST_INVALID');
                const file = { ...saved, index, name: normalizeSegment(saved.name, 180), folderPath: normalizePath(saved.folderPath), receiving: false, path: '', chunks: [], finalGroups: saved.finalGroups || [] };
                assertDepth(file.folderPath, job.maxDepth);
                let expectedOffset = 0;
                for (const [planIndex, plan] of file.parts.entries()) {
                    if (plan.index !== planIndex + 1 || !Number.isSafeInteger(plan.size) || plan.size < 0 || plan.size > MAX_TELEGRAM_PART_SIZE || plan.byteStart !== expectedOffset || plan.byteEnd !== expectedOffset + plan.size - 1) throw new Error('UPLOAD_RECOVERY_MANIFEST_INVALID');
                    expectedOffset += plan.size;
                }
                if (expectedOffset !== file.size || saved.chunks.length !== file.parts.length) throw new Error('UPLOAD_RECOVERY_SOURCE_INCOMPLETE');
                for (const [chunkIndex, savedChunk] of saved.chunks.entries()) {
                    const plan = file.parts[chunkIndex];
                    if (!savedChunk.sourceComplete || savedChunk.sourceError || savedChunk.partIndex !== plan.index || savedChunk.size !== plan.size || savedChunk.offset !== plan.byteStart || !/^[a-f0-9]{64}$/.test(savedChunk.sha256 || '')) throw new Error('UPLOAD_RECOVERY_SOURCE_INCOMPLETE');
                    const chunk = { ...savedChunk, path: recoveryPath(savedChunk.path), writtenBytes: plan.size, receivedBytes: plan.size, sourceError: null, sourceComplete: true };
                    if ((chunk.tempRemote && !validRemote(chunk.tempRemote)) || (chunk.finalRemote && !validRemote(chunk.finalRemote))) throw new Error('UPLOAD_RECOVERY_REMOTE_INVALID');
                    const stat = await fsp.stat(chunk.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
                    if (stat) {
                        if (!stat.isFile() || stat.size !== plan.size) throw new Error('UPLOAD_RECOVERY_SOURCE_INVALID');
                        const digest = crypto.createHash('sha256');
                        for await (const bytes of fs.createReadStream(chunk.path)) digest.update(bytes);
                        if (digest.digest('hex') !== chunk.sha256) throw new Error('UPLOAD_RECOVERY_SOURCE_INVALID');
                    } else if (!file.finalized || !validRemote(chunk.finalRemote)) throw new Error('UPLOAD_RECOVERY_SOURCE_MISSING');
                    if (chunk.tempRemote) { chunk.status = file.finalized ? 'uploaded' : 'push_confirmed'; chunk.remote = file.finalized ? chunk.finalRemote : chunk.tempRemote; chunk.attemptIntent = null; chunk.unknownResult = false; }
                    else if (chunk.attemptIntent || chunk.unknownResult || ['pushing', 'awaiting_response', 'push_unknown'].includes(chunk.status)) { chunk.status = 'push_unknown'; chunk.unknownResult = true; }
                    else if (['queued', 'receiving', 'retry_wait'].includes(chunk.status) || (chunk.status === 'push_failed' && chunk.safeRetry)) { chunk.status = 'queued'; }
                    else throw new Error('UPLOAD_RECOVERY_SOURCE_INVALID');
                    file.chunks.push(attachGrowingSource(job, chunk));
                }
                file.received = file.size;
                for (const group of file.finalGroups) {
                    if (!Number.isSafeInteger(group.index) || group.index < 0 || !Array.isArray(group.remotes)) throw new Error('UPLOAD_RECOVERY_MANIFEST_INVALID');
                    if (group.remotes.length) {
                        if (group.remotes.some(remote => !validRemote(remote) || !file.chunks.some(chunk => chunk.partIndex === remote.partIndex))) throw new Error('UPLOAD_RECOVERY_REMOTE_INVALID');
                        group.status = 'confirmed'; group.intent = null; group.unknownResult = false;
                        for (const remote of group.remotes) file.chunks.find(chunk => chunk.partIndex === remote.partIndex).finalRemote = remote;
                    } else if (group.intent || group.status === 'finalizing' || group.unknownResult) { group.status = 'unknown'; group.unknownResult = true; }
                }
                if (saved.thumbnail) {
                    file.thumbnail = { ...saved.thumbnail, path: recoveryPath(saved.thumbnail.path), receiving: false };
                    if (file.thumbnail.remote) { if (!validRemote(file.thumbnail.remote)) throw new Error('UPLOAD_RECOVERY_REMOTE_INVALID'); file.thumbnail.status = 'uploaded'; }
                    else if (file.thumbnail.status === 'uploading') { file.thumbnail.status = 'failed'; file.thumbnail.warning = 'TELEGRAM_THUMBNAIL_UPLOAD_FAILED'; }
                    else if (file.thumbnail.status !== 'failed') {
                        const thumbnailStat = await fsp.stat(file.thumbnail.path).catch(() => null);
                        if (!thumbnailStat?.isFile() || thumbnailStat.size !== file.thumbnail.size) { file.thumbnail.status = 'failed'; file.thumbnail.warning = 'TELEGRAM_THUMBNAIL_UPLOAD_FAILED'; }
                        else file.thumbnail.status = 'queued';
                    }
                }
                job.files.push(file);
            }
            uploads.set(job.id, job);
            try { await persistUploadAsync(job); return job; }
            catch (error) { uploads.delete(job.id); throw error; }
        },
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
