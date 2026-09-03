'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { readJson, writeJson } = require('./disk-data');


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

function createTelegramDriveStore({ dataDir, maxFileSize = () => 2 * 1024 * 1024 * 1024 }) {
    const indexPath = path.join(dataDir, 'telegram-drive-index.json');
    const directoriesPath = path.join(dataDir, 'telegram-drive-directories.json');
    const stagingRoot = path.join(dataDir, 'telegram-drive-staging');
    const records = new Map();
    const directories = new Map();
    const uploads = new Map();
    for (const item of readJson(indexPath, [])) if (item?.id && item?.ownerId) records.set(item.id, item);
    {
        for (const item of readJson(directoriesPath, [])) {
            if (!item?.ownerId || !normalizePath(item.path)) continue;
            const safe = normalizePath(item.path);
            directories.set(`${item.ownerId}:${safe}`, { ...item, ownerId: String(item.ownerId), path: safe, updatedAt: Number(item.updatedAt) || Number(item.createdAt) || Date.now() });
        }
    }
    const persist = () => { writeJson(indexPath, [...records.values()]); writeJson(directoriesPath, [...directories.values()]); };
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
        assertDirectoryWritable(ownerId, folderPath) { assertNoPendingTree(ownerId, folderPath); },
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
            Object.assign(item, { name, updatedAt: Date.now() });
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
            Object.assign(item, { folderPath: destination, name, updatedAt: Date.now() });
            touchDirectory(ownerId, destination); persist(); return item;
        },
        hasChannel(channelId) { return [...records.values()].some(item => String(item.channelId) === String(channelId)); },
        begin({ owner, metadata = {}, folderPath, files, maxDepth, uploadLimit = maxFileSize(), backendId = '' }) {
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
                names.add(key); assertFreeName(owner.id, folder, name);
                // A batch cannot reserve both a file and a descendant of that file.
                const parts = folder.split('/').filter(Boolean);
                for (let i = 0; i < parts.length; i++) {
                    const parent = parts.slice(0, i).join('/');
                    if ([...ownerRecords(owner.id), ...pendingFiles(owner.id), ...incoming.map(entry => ({ ...entry, folderPath: Object.hasOwn(entry, 'folderPath') ? normalizePath(entry.folderPath) : safePath }))].some(entry => (entry.folderPath || '') === parent && entry.name === parts[i])) throw new Error('DISK_NAME_CONFLICT');
                }
                if ([...uploads.values()].some(job => job.owner.id === owner.id && job.files.some(entry => entry.folderPath === folder && entry.name === name))) throw new Error('DISK_NAME_CONFLICT');
            }
            const id = crypto.randomUUID(); const dir = path.join(stagingRoot, id); fs.mkdirSync(dir, { recursive: true });
            const job = { id, owner, metadata, backendId, uploadLimit, folderPath: safePath,
files: incoming.map((file, index) => ({ index, folderPath: Object.hasOwn(file, 'folderPath') ? normalizePath(file.folderPath) : safePath, name: normalizeSegment(file?.name || `file-${index + 1}`, 180) || `file-${index + 1}`, type: String(file?.type || 'application/octet-stream').slice(0, 120), size: Number(file?.size) || 0, path: '', received: 0 })), dir, createdAt: Date.now(), maxDepth };
            uploads.set(id, job); return job;
        },
        async receive(uploadId, index, request, onProgress) {
            const job = uploads.get(String(uploadId)); const file = job?.files[Number(index)]; if (!job || !file) throw new Error('telegram-drive-upload-not-found');
            if (file.path || file.receiving) throw new Error('telegram-drive-upload-already-received');
            file.receiving = true;
            const target = path.join(job.dir, `${file.index}-${file.name}`); let size = 0;
            request.on('data', chunk => { size += chunk.length; if (size > file.size || size > job.uploadLimit) request.destroy(new Error('telegram-drive-upload-size-mismatch')); onProgress?.(size, file.size); });
            try { await pipeline(request, fs.createWriteStream(target, { flags: 'wx' })); } catch (error) { try { fs.unlinkSync(target); } catch (_) {} throw error; }
            if (size !== file.size) { try { fs.unlinkSync(target); } catch (_) {} throw new Error('telegram-drive-upload-size-mismatch'); }
            file.path = target; file.received = size; return { received: size };
        },
        upload(uploadId) { return uploads.get(String(uploadId)); },
        validateUpload(uploadId) {
            const job = this.finish(uploadId);
            for (const file of job.files) {
                assertFreeName(job.owner.id, file.folderPath, file.name, '', job.id);
                assertDepth(file.folderPath, job.maxDepth);
                const parts = file.folderPath.split('/').filter(Boolean);
                for (let index = 0; index < parts.length; index++) {
                    if (ownerRecords(job.owner.id).some(item => item.folderPath === parts.slice(0, index).join('/') && item.name === parts[index])) throw new Error('DISK_NAME_CONFLICT');
                }
            }
        },
        finish(uploadId) { const job = uploads.get(String(uploadId)); if (!job) throw new Error('telegram-drive-upload-not-found'); if (job.files.some(file => !file.path)) throw new Error('telegram-drive-upload-incomplete'); return job; },
        ownsUpload(ownerId, uploadId) { const job = uploads.get(String(uploadId)); return Boolean(job && String(job.owner?.id) === String(ownerId)); },
        commit(uploadId, channelId, sent) {
            const job = this.finish(uploadId); const now = Date.now();
            this.validateUpload(uploadId);
            for (const file of job.files) if (file.folderPath) ensureDirectoryRecords(job.owner.id, file.folderPath, job.maxDepth || 20, now, job.id);
            const created = job.files.map((file, index) => {
                const remote = sent[index] || {}; const item = { id: crypto.randomUUID(), ownerId: String(job.owner.id), ownerName: String(job.owner.name || ''), ownerUsername: String(job.owner.username || ''), folderPath: file.folderPath, name: file.name, type: file.type, size: file.size, channelId: String(channelId), messageId: Number(remote.messageId) || 0, mediaGroupId: String(remote.mediaGroupId || ''), fileId: String(remote.fileId || ''), fileUniqueId: String(remote.fileUniqueId || ''), fileIdHistory: [], createdAt: now, updatedAt: now, lastCheckedAt: 0 };
                item.metadata = job.metadata; item.backendId = job.backendId;
                item.captionWarning = remote.captionWarning || '';
                records.set(item.id, item); return item;
            });
            for (const file of job.files) touchDirectory(job.owner.id, file.folderPath, now);
            persist();
            try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch (_) {} uploads.delete(job.id); return created;
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
            for (const [id, job] of uploads) if (!job.finishing && job.createdAt < cutoff) { expired.push(job.operationId); this.abort(id); }
            // Staging from an interrupted previous process has no in-memory job.
            if (fs.existsSync(stagingRoot)) for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
                if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name) || uploads.has(entry.name)) continue;
                const orphan = path.join(stagingRoot, entry.name);
                if (fs.statSync(orphan).mtimeMs < cutoff) fs.rmSync(orphan, { recursive: true, force: true });
            }
            return expired;
        }
    };
    return store;
}

module.exports = { createTelegramDriveStore, normalizeTelegramDrivePath: normalizePath };
