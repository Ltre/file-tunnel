'use strict';

const crypto = require('node:crypto');
const { openDiskRepository } = require('./disk-repository');
const { normalizeTelegramDrivePath } = require('./telegram-drive');

const TABLE = 'collaboration_mounts';
const inTree = (candidate, root) => !root || candidate === root || candidate.startsWith(root + '/');

function checkedPath(value) {
    if (typeof value !== 'string' || value.includes('\\')) throw new Error('MOUNT_PATH_INVALID');
    const path = normalizeTelegramDrivePath(value);
    if (path !== value) throw new Error('MOUNT_PATH_INVALID');
    return path;
}

function checkedName(value) {
    if (typeof value !== 'string' || value !== value.trim() || !value || value === '.' || value === '..'
        || value.length > 100 || /[\\/:*?"<>|\u0000-\u001f]/.test(value)) throw new Error('MOUNT_NAME_INVALID');
    return value;
}

/**
 * A mount is only a local leaf pointer. It never stores a remote path, role,
 * physical Telegram identity, or Content Object reference. Callers must use
 * the current collaboration grant for every visit to the foreign namespace.
 * Mutations that also affect Native directories/grants belong in the caller's
 * repository.atomic() boundary, with reloadPersistence() on rollback.
 */
function createDiskCollaborationMountStore(dataDir, { collaborations, isTargetAvailable } = {}) {
    if (!collaborations) throw new Error('MOUNT_COLLABORATIONS_REQUIRED');
    const repository = openDiskRepository(dataDir);
    let state = repository.loadWithRevision(TABLE);
    const entries = state.items;
    const reloadPersistence = () => {
        state = repository.loadWithRevision(TABLE);
        entries.splice(0, entries.length, ...state.items);
    };
    const save = () => {
        try { repository.replaceMany([{ table: TABLE, items: entries, keyOf: item => item.id, base: state.revisions }]); }
        catch (error) { reloadPersistence(); throw error; }
    };
    const sameSpace = (item, ownerId, diskSpace) => item.ownerId === String(ownerId) && item.diskSpace === String(diskSpace || '');
    const owned = (ownerId, diskSpace) => entries.filter(item => sameSpace(item, ownerId, diskSpace));
    const raw = (id, ownerId, diskSpace) => entries.find(item => item.id === String(id) && sameSpace(item, ownerId, diskSpace)) || null;
    const currentGrant = item => {
        const grant = collaborations.authorized(item.collaborationId, item.ownerId);
        if (!grant || grant.ownerId === item.ownerId) return null;
        try { return typeof isTargetAvailable !== 'function' || isTargetAvailable(grant) ? grant : null; }
        catch (_) { return null; }
    };
    const view = item => ({
        id: item.id, mountId: item.id, kind: 'collaboration_mount', name: item.name,
        parentPath: item.parentPath, folderPath: item.parentPath, diskSpace: item.diskSpace,
        collaborationId: item.collaborationId, status: currentGrant(item) ? 'active' : 'inaccessible',
        lastKnownTitle: item.lastKnownTitle || '', createdAt: item.createdAt, updatedAt: item.updatedAt
    });
    const assertTopology = (ownerId, diskSpace, parentPath) => {
        collaborations.reloadPersistence();
        if (collaborations.forOwner(ownerId, diskSpace).some(grant =>
            grant.kind === 'directory' && inTree(parentPath, grant.path || ''))) throw new Error('MOUNT_COLLABORATION_OVERLAP');
    };
    const assertNativeNameFree = (drive, ownerId, parentPath, name) => {
        const result = drive.list(ownerId, parentPath);
        if (!result || result.files.some(file => file.name === name) || result.folders.some(folder => folder.name === name))
            throw new Error('MOUNT_NAME_CONFLICT');
    };
    const assertMountNameFree = (ownerId, diskSpace, parentPath, name, exceptId = '') => {
        if (owned(ownerId, diskSpace).some(item => item.id !== exceptId && item.parentPath === parentPath && item.name === name))
            throw new Error('MOUNT_NAME_CONFLICT');
    };
    const assertParent = (drive, ownerId, parentPath) => {
        const directory = drive.getDirectory(ownerId, parentPath);
        if (!directory || directory.reviewStatus === 'blocked' || directory.reviewStatus === 'deleted') throw new Error('MOUNT_PARENT_NOT_FOUND');
    };

    return {
        reloadPersistence,
        /** Includes inaccessible pointers but never projects foreign data. */
        list(ownerId, diskSpace, parentPath = null) {
            reloadPersistence();
            collaborations.reloadPersistence();
            const path = parentPath === null ? null : checkedPath(parentPath);
            return owned(ownerId, diskSpace).filter(item => path === null || item.parentPath === path).map(view);
        },
        find(id, ownerId, diskSpace) { reloadPersistence(); collaborations.reloadPersistence(); const item = raw(id, ownerId, diskSpace); return item ? view(item) : null; },
        /** Resolves a mount and its live grant; mount possession is not authorization. */
        resolve(id, ownerId, diskSpace) {
            reloadPersistence();
            collaborations.reloadPersistence();
            const item = raw(id, ownerId, diskSpace);
            if (!item) throw new Error('MOUNT_NOT_FOUND');
            const grant = currentGrant(item);
            if (!grant) throw new Error('MOUNT_ACCESS_REVOKED');
            return { mount: view(item), grant };
        },
        assertNameFree(ownerId, diskSpace, parentPath, name, exceptId = '') {
            reloadPersistence();
            assertMountNameFree(ownerId, diskSpace, checkedPath(parentPath), checkedName(name), exceptId);
        },
        assertCanEnableDirectory(ownerId, diskSpace, directoryPath) {
            reloadPersistence();
            collaborations.reloadPersistence();
            const path = checkedPath(directoryPath);
            if (owned(ownerId, diskSpace).some(item => inTree(item.parentPath, path))) throw new Error('MOUNT_COLLABORATION_OVERLAP');
        },
        assertCanRelocateDirectory(ownerId, diskSpace, oldPath, newPath) {
            reloadPersistence();
            collaborations.reloadPersistence();
            const oldRoot = checkedPath(oldPath), nextRoot = checkedPath(newPath);
            if (!oldRoot || !nextRoot) throw new Error('MOUNT_PATH_INVALID');
            const grants = collaborations.forOwner(ownerId, diskSpace).filter(item => item.kind === 'directory');
            for (const mount of owned(ownerId, diskSpace)) {
                const parent = inTree(mount.parentPath, oldRoot) ? nextRoot + mount.parentPath.slice(oldRoot.length) : mount.parentPath;
                for (const grant of grants) {
                    const grantPath = inTree(grant.path, oldRoot) ? nextRoot + grant.path.slice(oldRoot.length) : grant.path;
                    if (inTree(parent, grantPath)) throw new Error('MOUNT_COLLABORATION_OVERLAP');
                }
            }
        },
        create({ ownerId, diskSpace = '', parentPath = '', name, collaborationId, drive }) {
            reloadPersistence();
            drive.reloadPersistence();
            const parent = checkedPath(parentPath), title = checkedName(name);
            const grant = collaborations.authorizedFresh(collaborationId, ownerId);
            if (!grant || grant.ownerId === String(ownerId)
                || typeof isTargetAvailable === 'function' && !isTargetAvailable(grant)) throw new Error('MOUNT_GRANT_NOT_AVAILABLE');
            assertParent(drive, ownerId, parent);
            assertTopology(ownerId, diskSpace, parent);
            assertNativeNameFree(drive, ownerId, parent, title);
            assertMountNameFree(ownerId, diskSpace, parent, title);
            const now = Date.now();
            const item = { id: crypto.randomUUID(), ownerId: String(ownerId), diskSpace: String(diskSpace),
                parentPath: parent, folderPath: parent, name: title, collaborationId: String(collaborationId),
                lastKnownTitle: grant.name || '', createdAt: now, updatedAt: now };
            entries.push(item);
            save();
            return view(item);
        },
        rename(id, ownerId, diskSpace, name, drive) {
            reloadPersistence();
            drive.reloadPersistence();
            const item = raw(id, ownerId, diskSpace);
            if (!item) throw new Error('MOUNT_NOT_FOUND');
            collaborations.reloadPersistence();
            if (!currentGrant(item)) throw new Error('MOUNT_ACCESS_REVOKED');
            const title = checkedName(name);
            assertNativeNameFree(drive, ownerId, item.parentPath, title);
            assertMountNameFree(ownerId, diskSpace, item.parentPath, title, item.id);
            item.name = title; item.updatedAt = Date.now(); save(); return view(item);
        },
        move(id, ownerId, diskSpace, parentPath, drive) {
            reloadPersistence();
            drive.reloadPersistence();
            const item = raw(id, ownerId, diskSpace);
            if (!item) throw new Error('MOUNT_NOT_FOUND');
            collaborations.reloadPersistence();
            if (!currentGrant(item)) throw new Error('MOUNT_ACCESS_REVOKED');
            const parent = checkedPath(parentPath);
            assertParent(drive, ownerId, parent);
            assertTopology(ownerId, diskSpace, parent);
            assertNativeNameFree(drive, ownerId, parent, item.name);
            assertMountNameFree(ownerId, diskSpace, parent, item.name, item.id);
            item.parentPath = parent; item.folderPath = parent; item.updatedAt = Date.now(); save(); return view(item);
        },
        /** Caller validates ownership of the target partition and wraps in repository.atomic(). */
        moveAcrossPartition(id, ownerId, sourceSpace, targetSpace, parentPath, targetDrive) {
            if (String(sourceSpace || '') === String(targetSpace || ''))
                return this.move(id, ownerId, sourceSpace, parentPath, targetDrive);
            reloadPersistence();
            targetDrive.reloadPersistence();
            collaborations.reloadPersistence();
            const item = raw(id, ownerId, sourceSpace);
            if (!item) throw new Error('MOUNT_NOT_FOUND');
            if (!currentGrant(item)) throw new Error('MOUNT_ACCESS_REVOKED');
            const parent = checkedPath(parentPath);
            assertParent(targetDrive, ownerId, parent);
            assertTopology(ownerId, targetSpace, parent);
            assertNativeNameFree(targetDrive, ownerId, parent, item.name);
            assertMountNameFree(ownerId, targetSpace, parent, item.name);
            item.diskSpace = String(targetSpace || '');
            item.parentPath = parent; item.folderPath = parent; item.updatedAt = Date.now();
            save(); return view(item);
        },
        remove(id, ownerId, diskSpace) {
            reloadPersistence();
            const item = raw(id, ownerId, diskSpace);
            if (!item) throw new Error('MOUNT_NOT_FOUND');
            entries.splice(entries.indexOf(item), 1); save(); return { removedMountId: item.id };
        },
        /** Must run inside the same transaction as Native directory relocation. */
        relocateDirectory(ownerId, diskSpace, oldPath, newPath) {
            const oldRoot = checkedPath(oldPath), nextRoot = checkedPath(newPath);
            this.assertCanRelocateDirectory(ownerId, diskSpace, oldRoot, nextRoot);
            let changed = false;
            for (const item of owned(ownerId, diskSpace)) if (inTree(item.parentPath, oldRoot)) {
                item.parentPath = nextRoot + item.parentPath.slice(oldRoot.length);
                item.folderPath = item.parentPath; item.updatedAt = Date.now(); changed = true;
            }
            if (changed) save();
        },
        /** Never traverses or deletes the foreign collaboration. */
        removeTree(ownerId, diskSpace, directoryPath) {
            reloadPersistence();
            const root = checkedPath(directoryPath);
            if (!root) throw new Error('MOUNT_PATH_INVALID');
            const removed = owned(ownerId, diskSpace).filter(item => inTree(item.parentPath, root));
            for (const item of removed) entries.splice(entries.indexOf(item), 1);
            if (removed.length) save();
            return { removedMounts: removed.length };
        },
        removePartition(ownerId, diskSpace) {
            reloadPersistence();
            const removed = owned(ownerId, diskSpace);
            for (const item of removed) entries.splice(entries.indexOf(item), 1);
            if (removed.length) save();
            return { removedMounts: removed.length };
        },
        removeScope(ownerId, diskSpace) { return this.removePartition(ownerId, diskSpace); },
        countScope(ownerId, diskSpace) { reloadPersistence(); return owned(ownerId, diskSpace).length; },
        countTree(ownerId, diskSpace, directoryPath) {
            reloadPersistence();
            const root = checkedPath(directoryPath);
            return owned(ownerId, diskSpace).filter(item => inTree(item.parentPath, root)).length;
        },
        /** Search only actively authorized foreign grants, never recurse via Mount nodes. */
        searchMounted(ownerId, diskSpace, query, getSourceStore) {
            if (typeof getSourceStore !== 'function') throw new Error('MOUNT_SEARCH_STORE_REQUIRED');
            const needle = String(query || '').trim();
            if (!needle) return { results: [], truncated: false, searchedGrants: 0 };
            if (needle.length > 200) throw new Error('MOUNT_SEARCH_QUERY_INVALID');
            reloadPersistence();
            collaborations.reloadPersistence();
            const seen = new Set(), results = [];
            let truncated = false, searchedGrants = 0;
            for (const mount of owned(ownerId, diskSpace).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
                if (seen.has(mount.collaborationId)) continue;
                seen.add(mount.collaborationId);
                const grant = currentGrant(mount);
                if (!grant) continue;
                if (searchedGrants >= 50 || results.length >= 200) { truncated = true; break; }
                let source;
                try { source = getSourceStore(grant); }
                catch (_) { continue; }
                if (!source) continue;
                searchedGrants++;
                const context = { origin: 'collaboration', mountId: mount.id,
                    collaborationId: grant.id, mountName: mount.name, status: 'active' };
                const root = normalizeTelegramDrivePath(grant.path || '');
                if (grant.kind === 'file') {
                    const file = source.get(grant.ownerId, grant.fileId);
                    if (file && file.reviewStatus !== 'blocked' && file.reviewStatus !== 'deleted'
                        && file.name.toLocaleLowerCase('zh-CN').includes(needle.toLocaleLowerCase('zh-CN'))) {
                        results.push({ ...context, kind: 'mounted_file', id: file.id, name: file.name,
                            folderPath: file.folderPath || '', relativePath: file.name, type: file.type, size: file.size });
                    }
                    continue;
                }
                const found = source.search(grant.ownerId, needle, 201, root);
                for (const folder of found.folders || []) {
                    if (!inTree(folder.path, root) || folder.reviewStatus === 'blocked' || folder.reviewStatus === 'deleted') continue;
                    if (results.length >= 200) { truncated = true; break; }
                    results.push({ ...context, kind: 'mounted_directory', name: folder.name, path: folder.path,
                        relativePath: folder.path.slice(root.length).replace(/^\//, ''), size: folder.size,
                        folderCount: folder.folderCount, fileCount: folder.fileCount });
                }
                for (const file of found.files || []) {
                    if (!inTree(file.folderPath || '', root) || file.reviewStatus === 'blocked' || file.reviewStatus === 'deleted') continue;
                    if (results.length >= 200) { truncated = true; break; }
                    results.push({ ...context, kind: 'mounted_file', id: file.id, name: file.name, folderPath: file.folderPath || '',
                        relativePath: [String(file.folderPath || '').slice(root.length).replace(/^\//, ''), file.name].filter(Boolean).join('/'),
                        type: file.type, size: file.size });
                }
                if (truncated) break;
            }
            return { results, truncated, searchedGrants };
        }
    };
}

module.exports = { createDiskCollaborationMountStore };
