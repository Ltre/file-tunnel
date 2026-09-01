'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

function atomicJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2));
    try { fs.renameSync(temp, filePath); } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        fs.copyFileSync(temp, filePath); try { fs.unlinkSync(temp); } catch (_) {}
    }
}

function normalizeSegment(value, limit = 100) {
    return String(value || '').trim().replace(/[\/:*?"<>|\u0000-\u001f]/g, '').slice(0, limit);
}

function normalizePath(value) {
    return String(value || '').split('/').map(part => normalizeSegment(part)).filter(Boolean).join('/');
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

function createTelegramDriveStore({ dataDir, maxFileSize = () => 2 * 1024 * 1024 * 1024 }) {
    const indexPath = path.join(dataDir, 'telegram-drive-index.json');
    const directoriesPath = path.join(dataDir, 'telegram-drive-directories.json');
    const stagingRoot = path.join(dataDir, 'telegram-drive-staging');
    const records = new Map();
    const directories = new Map();
    const uploads = new Map();
    try { for (const item of JSON.parse(fs.readFileSync(indexPath, 'utf8')) || []) if (item?.id && item?.ownerId) records.set(item.id, item); } catch (_) {}
    try {
        for (const item of JSON.parse(fs.readFileSync(directoriesPath, 'utf8')) || []) {
            if (!item?.ownerId || !normalizePath(item.path)) continue;
            const safe = normalizePath(item.path);
            directories.set(`${item.ownerId}:${safe}`, { ...item, ownerId: String(item.ownerId), path: safe, updatedAt: Number(item.updatedAt) || Number(item.createdAt) || Date.now() });
        }
    } catch (_) {}
    const persist = () => { atomicJson(indexPath, [...records.values()]); atomicJson(directoriesPath, [...directories.values()]); };
    const ownerRecords = ownerId => [...records.values()].filter(item => item.ownerId === String(ownerId));
    const ownerDirectories = ownerId => [...directories.values()].filter(item => item.ownerId === String(ownerId));
    const directoryKey = (ownerId, folderPath) => `${ownerId}:${normalizePath(folderPath)}`;
    const assertDepth = (folderPath, maxDepth) => {
        if (normalizePath(folderPath).split('/').filter(Boolean).length > Math.max(1, Math.min(20, Number(maxDepth) || 20))) throw new Error('telegram-drive-folder-depth-exceeded');
    };
    const ensureDirectoryRecords = (ownerId, folderPath, maxDepth, now = Date.now()) => {
        const safe = normalizePath(folderPath); assertDepth(safe, maxDepth);
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
        createDirectory(ownerId, folderPath, maxDepth) {
            const safe = normalizePath(folderPath);
            if (!safe) throw new Error('telegram-drive-folder-name-required');
            const result = ensureDirectoryRecords(ownerId, safe, maxDepth);
            touchDirectory(ownerId, parentPath(safe));
            persist();
            return result;
        },
        list(ownerId, folderPath = '') {
            const owner = String(ownerId);
            const safe = normalizePath(folderPath);
            const prefix = safe ? `${safe}/` : '';
            const childPaths = new Set();
            for (const item of ownerDirectories(owner)) {
                if (!item.path.startsWith(prefix)) continue;
                const child = item.path.slice(prefix.length).split('/')[0];
                if (child) childPaths.add(joinPath(safe, child));
            }
            const folders = [...childPaths].map(childPath => {
                const item = directories.get(directoryKey(owner, childPath));
                const snapshot = directorySnapshot(owner, childPath);
                return { kind: 'directory', name: baseName(childPath), path: childPath, createdAt: Number(item?.createdAt) || 0, updatedAt: snapshot.updatedAt, folderCount: snapshot.folderCount, fileCount: snapshot.fileCount, size: snapshot.size };
            });
            const files = ownerRecords(owner).filter(item => normalizePath(item.folderPath || '') === safe).map(item => ({ ...item, kind: 'file' }));
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
            if (directoryExists(owner, target)) throw new Error('telegram-drive-folder-exists');
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
            Object.assign(item, { name, updatedAt: Date.now() });
            touchDirectory(ownerId, item.folderPath || '');
            persist();
            return item;
        },
        hasChannel(channelId) { return [...records.values()].some(item => String(item.channelId) === String(channelId)); },
        begin({ owner, sessionId, sourceMessageId, folderPath, files, maxDepth }) {
            const safePath = normalizePath(folderPath); assertDepth(safePath, maxDepth);
            const incoming = Array.isArray(files) ? files.slice(0, 100) : [];
            if (!incoming.length) throw new Error('telegram-drive-files-required');
            const total = incoming.reduce((sum, file) => sum + Math.max(0, Number(file?.size) || 0), 0);
            if (total <= 0 || total > maxFileSize()) throw new Error('telegram-drive-upload-size-invalid');
            const id = crypto.randomUUID(); const dir = path.join(stagingRoot, id); fs.mkdirSync(dir, { recursive: true });
            const job = { id, owner, sessionId: String(sessionId || ''), sourceMessageId: String(sourceMessageId || ''), folderPath: safePath,
                files: incoming.map((file, index) => ({ index, name: normalizeSegment(file?.name || `file-${index + 1}`, 180) || `file-${index + 1}`, type: String(file?.type || 'application/octet-stream').slice(0, 120), size: Number(file?.size) || 0, sourceAssetId: String(file?.sourceAssetId || '').slice(0, 100), path: '', received: 0 })), dir, createdAt: Date.now(), maxDepth };
            uploads.set(id, job); return job;
        },
        async receive(uploadId, index, request) {
            const job = uploads.get(String(uploadId)); const file = job?.files[Number(index)]; if (!job || !file) throw new Error('telegram-drive-upload-not-found');
            if (file.path) throw new Error('telegram-drive-upload-already-received');
            const target = path.join(job.dir, `${file.index}-${file.name}`); let size = 0;
            request.on('data', chunk => { size += chunk.length; if (size > file.size || size > maxFileSize()) request.destroy(new Error('telegram-drive-upload-size-mismatch')); });
            try { await pipeline(request, fs.createWriteStream(target, { flags: 'wx' })); } catch (error) { try { fs.unlinkSync(target); } catch (_) {} throw error; }
            if (size !== file.size) { try { fs.unlinkSync(target); } catch (_) {} throw new Error('telegram-drive-upload-size-mismatch'); }
            file.path = target; file.received = size; return { received: size };
        },
        finish(uploadId) { const job = uploads.get(String(uploadId)); if (!job) throw new Error('telegram-drive-upload-not-found'); if (job.files.some(file => !file.path)) throw new Error('telegram-drive-upload-incomplete'); return job; },
        ownsUpload(ownerId, uploadId) { const job = uploads.get(String(uploadId)); return Boolean(job && String(job.owner?.id) === String(ownerId)); },
        commit(uploadId, channelId, sent) {
            const job = this.finish(uploadId); const now = Date.now();
            if (job.folderPath) ensureDirectoryRecords(job.owner.id, job.folderPath, job.maxDepth || 20, now);
            const created = job.files.map((file, index) => {
                const remote = sent[index] || {}; const item = { id: crypto.randomUUID(), ownerId: String(job.owner.id), ownerName: String(job.owner.name || ''), ownerUsername: String(job.owner.username || ''), folderPath: job.folderPath, name: file.name, type: file.type, size: file.size, sourceAssetId: file.sourceAssetId, sourceSessionId: job.sessionId, sourceMessageId: job.sourceMessageId, channelId: String(channelId), messageId: Number(remote.messageId) || 0, mediaGroupId: String(remote.mediaGroupId || ''), fileId: String(remote.fileId || ''), fileUniqueId: String(remote.fileUniqueId || ''), fileIdHistory: [], createdAt: now, updatedAt: now, lastCheckedAt: 0 };
                records.set(item.id, item); return item;
            });
            touchDirectory(job.owner.id, job.folderPath, now);
            try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch (_) {} uploads.delete(job.id); persist(); return created;
        },
        abort(uploadId) { const job = uploads.get(String(uploadId)); if (!job) return; try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch (_) {} uploads.delete(job.id); },
        update(ownerId, id, patch) { const item = this.get(ownerId, id); if (!item) return null; Object.assign(item, patch, { updatedAt: Date.now() }); records.set(item.id, item); touchDirectory(ownerId, item.folderPath || ''); persist(); return item; },
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
        cleanup() { const cutoff = Date.now() - 2 * 60 * 60 * 1000; for (const [id, job] of uploads) if (job.createdAt < cutoff) this.abort(id); }
    };
    return store;
}

module.exports = { createTelegramDriveStore, normalizeTelegramDrivePath: normalizePath };
