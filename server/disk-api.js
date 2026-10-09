'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('crypto');
const { performance } = require('node:perf_hooks');
const { Transform, Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { createTelegramDriveStore, normalizeTelegramDrivePath } = require('./telegram-drive');
const { openDiskRepository } = require('./disk-repository');
const { createDiskShares } = require('./disk-shares');
const { createDiskCollaborationStore } = require('./disk-collaboration');
const { createDiskCollaborationMountStore } = require('./disk-collaboration-mounts');
const { MAX_TELEGRAM_PART_SIZE } = require('./disk-limits');
const { createDiskUploadLog, networkDetails } = require('./disk-upload-log');
const { createDiskMetadataTiming } = require('./disk-metadata-timing');
const { createDiskPartCache } = require('./disk-part-cache');
const { createDiskChunkFileCache } = require('./disk-chunk-file-cache');
const { createObjectStorage } = require('./object-storage');
const { diskErrorCode, diskErrorDetails, diskOperationError, diskUserMessage } = require('./disk-errors');
const { createProgressiveUploadRunner } = require('./disk-progressive-upload');
const { createContentProof } = require('./disk-content-proof');
const { createContentAdmin } = require('./disk-content-admin');
const { createS3Credentials } = require('./s3/credentials');
const { createDiskStaticResources } = require('./disk-static-resources');
const { createDiskPartitions, validateName: validatePartitionName } = require('./disk-partitions');
const { createDiskTrash } = require('./disk-trash');
const LOGICAL_FILE_UPLOAD_LIMIT = 2000 * 1024 * 1024;

const publicFile = item => item ? {
    id: item.id, kind: 'file', name: item.name, type: item.type, size: item.size,
    folderPath: item.folderPath || '', createdAt: item.createdAt, updatedAt: item.updatedAt,
    lastCheckedAt: item.lastCheckedAt || 0, repairedAt: item.repairedAt || 0,
    metadata: item.metadata || {}, reviewStatus: item.reviewStatus || 'active', reviewUpdatedAt: item.reviewUpdatedAt || 0,
    partCount: Number(item.partCount) || (Array.isArray(item.parts) && item.parts.length) || 1,
    mediaIndex: item.mediaIndex || { mode: 'unavailable' },
    thumbnailAvailable: Boolean(item.thumbnail?.fileId),
    logicalContentVersion: item.logicalContentVersion || 1
} : null;
const uploadResultFile = item => item ? {
    ...publicFile(item),
    telegramFileId: item.fileId || '',
    telegramFileUniqueId: item.fileUniqueId || '',
    telegramChatId: item.channelId || '',
    telegramMessageId: item.messageId || 0,
    telegramPartFileIds: (item.parts || []).map(part => part.fileId),
    serverAssetUrl: `/api/telegram/drive/files/${encodeURIComponent(item.id)}/stream`
} : null;
function createDiskSpaces(dataDir, defaultStore) {
    const stores = new Map([['', defaultStore]]);
    let externalNameGuard = null;
    const repository = openDiskRepository(dataDir);
    let spacesState = repository.loadWithRevision('spaces');
    let usagesState = repository.loadWithRevision('space_usage');
    const spaces = spacesState.items.map(item => item.name);
    const usages = usagesState.items;
    const saveUsages = () => {
        try { repository.replaceMany([{ table:'space_usage', items:usages, keyOf:item => `${item.appId}:${item.userId}:${item.diskSpace}`, base:usagesState.revisions }]); }
        catch (error) {
            usagesState = repository.loadWithRevision('space_usage');
            usages.splice(0, usages.length, ...usagesState.items);
            throw error;
        }
    };
    const track = (appId, userId, diskSpace) => {
        const now = Date.now();
        let item = usages.find(entry => entry.appId === appId && entry.userId === userId && entry.diskSpace === diskSpace);
        if (!item) { item = { appId, userId, diskSpace, createdAt: now, lastUsedAt: now }; usages.push(item); saveUsages(); }
        else if (now - item.lastUsedAt > 60 * 60 * 1000) { item.lastUsedAt = now; saveUsages(); }
    };
    return {
        installExternalNameGuard(guard) {
            externalNameGuard = guard;
            for (const [diskSpace, store] of stores) store.setExternalNameGuard?.((ownerId, parentPath, name) => guard(ownerId, diskSpace, parentPath, name));
        },
        cleanup() { return [...stores.values()].flatMap(store => store.cleanup().map(job => ({ store, job }))); },
        recoveries() { return this.entries().flatMap(({ store }) => store.recoveredUploads().map(job => ({ store, job }))); },
        entries() { return ['', ...new Set(spaces)].map(diskSpace => ({ diskSpace, store: this.get(diskSpace) })); },
        usages() { return usages.map(item => ({ ...item })); },
        forUser(userId) {
            const owned = new Set(['']);
            for (const item of usages) if (item.userId === userId) owned.add(item.diskSpace);
            for (const space of spaces) {
                const drive = this.get(space);
                if (drive.adminFiles().some(file => file.ownerId === userId) || drive.adminDirectories().some(folder => folder.ownerId === userId)) owned.add(space);
            }
            return [...owned];
        },
        createForUser(userId, name) {
            if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 100 || /[\\/<>:"|?*\u0000-\u001f]/.test(name)) throw new Error('DISK_SPACE_INVALID');
            if (this.forUser(userId).includes(name)) throw new Error('DISK_SPACE_EXISTS');
            this.get(name); track('system', userId, name);
            return name;
        },
        track(appId, userId, diskSpace = '') { track(String(appId || 'system'), String(userId), String(diskSpace || '')); },
        get(value = '') {
            if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f]/.test(value)) throw new Error('DISK_SPACE_INVALID');
            if (!stores.has(value)) {
                const id = crypto.createHash('sha256').update(value).digest('hex');
                stores.set(value, createTelegramDriveStore({ dataDir: path.join(dataDir, 'disk-spaces', id), repositoryDir: dataDir, diskSpace: value }));
                if (externalNameGuard) stores.get(value).setExternalNameGuard?.((ownerId, parentPath, name) => externalNameGuard(ownerId, value, parentPath, name));
                if (!spaces.includes(value)) {
                    spaces.push(value);
                    try { repository.replaceMany([{ table:'spaces', items:spaces.map(name => ({ name })), keyOf:item => item.name, base:spacesState.revisions }]); }
                    catch (error) {
                        spacesState = repository.loadWithRevision('spaces');
                        spaces.splice(0, spaces.length, ...spacesState.items.map(item => item.name));
                        stores.delete(value);
                        throw error;
                    }
                }
            }
            return stores.get(value);
        }
    };
}
function errorStatus(code) {
    if (/^COLLABORATION_|^INVITE_/.test(code)) return /NOT_FOUND/.test(code) ? 404 : 403;
    if (/^MOUNT_(?:ACCESS_REVOKED|GRANT_NOT_AVAILABLE)/.test(code)) return 403;
    if (/^MOUNT_(?:COLLABORATION_OVERLAP|NAME_CONFLICT|TRANSFER_UNSUPPORTED)/.test(code)) return 409;
    if (code === 'PASSKEY_SERVER_UNAVAILABLE') return 503;
    if (code === 'FILE_REMOVED_BY_REVIEW') return 410;
    if (/ACCESS_TOKEN_|APP_AUTH_|LOGIN_REQUIRED|PASSKEY_FLOW_INVALID/.test(code)) return 401;
    if (/NOT_FOUND|not-found/.test(code)) return 404;
    if (/CONFLICT|EXISTS|exists|not-empty|BUSY|IN_PROGRESS|STATIC_RESOURCE_ACTIVE|STATIC_OR_COLLABORATION_ACTIVE|DISK_SPACE_COLLABORATION_ACTIVE/.test(code)) return 409;
    if (/TELEGRAM_|STORAGE_/.test(code)) return 502;
    return 422;
}
function createDiskAPI({ dataDir, defaultStore, auth, operations, telegram, getDefaultBackend, getIdentity, setIdentity, getOrigin, isMockRequest, maxDepth, onDefaultUpload = () => {}, resolveStorageBackend = async backend => backend,
    contentReuseMode = process.env.DR2T_CONTENT_REUSE_MODE || 'all', contentCleanupMode = process.env.DR2T_CONTENT_CLEANUP_MODE || 'execute' }) {
    if(!['all','owner','off'].includes(contentReuseMode)) throw new Error('CONTENT_REUSE_MODE_INVALID');
    if(!['execute','observe'].includes(contentCleanupMode)) throw new Error('CONTENT_CLEANUP_MODE_INVALID');
    const log = createDiskUploadLog(dataDir);
    const userS3Credentials = createS3Credentials(dataDir);
    const recordUploadFailure = (job, error) => {
        try { operations.fail(job.operationId, error); }
        catch (diagnosticError) { log('upload.failure-state-write-failed', { uploadId: job.id, operationId: job.operationId, error: networkDetails(diagnosticError) }); }
    };
    const persistence = openDiskRepository(dataDir);
    const content = persistence.content;
    telegram.setAnchorGuard?.(physical => content.allowed(physical));
    const partCache = createDiskPartCache({ dataDir });
    const chunkFileCache = createDiskChunkFileCache({ dataDir });
    const browser = express.Router();
    const external = express.Router();
    const metadataTiming = createDiskMetadataTiming(log);
    browser.use(metadataTiming); external.use(metadataTiming);
    const admin = express.Router();
    const spaces = createDiskSpaces(dataDir, defaultStore);
    const partitions = createDiskPartitions({ dataDir, spaces, s3Credentials: userS3Credentials });
    let objectStorage;
    const contentProof=createContentProof({content,reuseMode:contentReuseMode,
        validate:async (candidate,req)=>{
            const physical=candidate.physical, target=req.diskApp ? req.diskApp.storage : getDefaultBackend(), source=physical.backendId ? auth.backend(physical.backendId) : getDefaultBackend(physical.channelId);
            if(!source || String(source.token)!==String(target?.token) || String(source.baseUrl || '')!==String(target?.baseUrl || '')) return false;
            // Empty content has no Telegram message to inspect. The backend
            // boundary above still applies, but check() would invent an empty
            // part and incorrectly mark this reusable Content as broken.
            if(candidate.size===0 && physical.parts?.length===0 && !physical.thumbnail) {
                content.setHealth(candidate.id,candidate.current_revision,true);return true;
            }
            try { if(telegram.check && Date.now()-candidate.last_checked_at>180_000) await telegram.check(source,{...physical,size:candidate.size}); }
            catch(error) { content.setHealth(candidate.id,candidate.current_revision,false,diskErrorCode(error)); return false; }
            content.setHealth(candidate.id,candidate.current_revision,true); return true;
        },
        open:async(candidate,start,end,req)=>{
            const physical=candidate.physical, storage=physical.backendId ? auth.backend(physical.backendId) : getDefaultBackend(physical.channelId);
            // PoP samples do not establish ownership of the browser/server
            // cache. The requesting viewer earns that scope only after proof.
            return readRemote(storage,{...physical,size:candidate.size,contentId:candidate.id,ownerId:req.diskUser.id,viewerId:req.diskViewerId || req.diskUser.id,contentProofRead:true},start,end,undefined,req.diskScope.diskSpace || '');
        }
    });
    const shares = createDiskShares({ dataDir });
    const staticResources = createDiskStaticResources({ dataDir });
    const assertStaticFileWritable = (scope, file) => {
        if (staticResources.protectFile(scope, file)) throw diskOperationError('STATIC_RESOURCE_ACTIVE','STATIC_FILE_OPEN',{targetPath:[file.folderPath,file.name].filter(Boolean).join('/')});
    };
    const assertStaticDirectoryWritable = (scope, store, folder) => {
        if (staticResources.protectDirectory(scope, store, folder)) throw diskOperationError('STATIC_RESOURCE_ACTIVE','STATIC_DIRECTORY_OPEN',{targetPath:normalizeTelegramDrivePath(folder||'')});
    };
    const collaborations = createDiskCollaborationStore(dataDir);
    const mounts = createDiskCollaborationMountStore(dataDir, { collaborations, isTargetAvailable: grant => {
        try {
            const ownerSpace = partitions.find(grant.ownerId, grant.diskSpace).scopeKey;
            const ownerStore = spaces.get(ownerSpace);
            ownerStore.reloadPersistence();
            const target = grant.kind === 'file' ? ownerStore.get(grant.ownerId, grant.fileId) : ownerStore.getDirectory(grant.ownerId, grant.path);
            return Boolean(target && !['blocked', 'deleted'].includes(target.reviewStatus));
        } catch (_) { return false; }
    } });
    spaces.installExternalNameGuard((ownerId, diskSpace, parentPath, name) => mounts.assertNameFree(ownerId, diskSpace, parentPath, name));
    const trash = createDiskTrash({repository:persistence,spaces,mounts,maxDepth,assertWritable:(userId,diskSpace,selection,drive)=>{
        partitions.find(userId,diskSpace);collaborations.reloadPersistence();
        if(selection.kind==='file'){const file=drive.get(userId,selection.id);if(!file)throw new Error('FILE_NOT_FOUND');assertStaticFileWritable({userId,diskSpace},file);if(collaborations.protectFile(userId,diskSpace,file.id))throw new Error('COLLABORATION_DISABLE_BEFORE_DELETE');}
        else if(selection.kind==='restore'){for(const file of selection.snapshot.files)assertStaticFileWritable({userId,diskSpace},file);for(const directory of selection.snapshot.directories)assertStaticDirectoryWritable({userId,diskSpace},drive,directory.path);}
        else {assertStaticDirectoryWritable({userId,diskSpace},drive,selection.path);if(collaborations.protectDirectory(userId,diskSpace,selection.path))throw new Error('COLLABORATION_DISABLE_BEFORE_DELETE');}
    }});
    const shared = express.Router();
    const publicStatic = express.Router();
    function copyGrantedItem({ kind, grant, ownerId, diskSpace, selection, targetUser, targetSpace, destinationPath }) {
        if (ownerId === targetUser.id) throw new Error('CONTENT_COPY_SELF_OWNED');
        targetSpace = partitions.find(targetUser.id, targetSpace).scopeKey;
        const targetDrive = spaces.get(targetSpace), sourceDrive = spaces.get(diskSpace);
        const destination = normalizeTelegramDrivePath(destinationPath || '');
        if (!targetDrive.getDirectory(targetUser.id, destination)) throw new Error('DIRECTORY_NOT_FOUND');
        const selectedDirectory = selection?.kind === 'directory';
        const selectedPath = selectedDirectory ? normalizeTelegramDrivePath(selection.path || '') : '';
        let directories = [], files = [];
        if (kind === 'share') {
            if (selectedDirectory) {
                if (!selectedPath || !grant.directories.includes(selectedPath)) throw new Error('DIRECTORY_NOT_FOUND');
                directories = grant.directories.filter(value => value === selectedPath || value.startsWith(selectedPath + '/'));
                files = grant.files.filter(entry => entry.folderPath === selectedPath || entry.folderPath.startsWith(selectedPath + '/'));
            } else {
                const selected = grant.files.find(entry => entry.id === selection?.id);
                if (!selected) throw new Error('FILE_NOT_FOUND');
                files = [selected];
            }
        } else {
            const base = normalizeTelegramDrivePath(grant.path || '');
            if (selectedDirectory) {
                if (grant.kind !== 'directory' || !selectedPath || selectedPath !== base && !selectedPath.startsWith(base + '/')) throw diskOperationError('COLLABORATION_OUT_OF_SCOPE',grant.kind==='file' ? 'FILE_GRANT_SOURCE' : 'SOURCE_OUTSIDE_GRANT');
                const tree = sourceDrive.getDirectoryTree(ownerId, selectedPath);
                if (!tree) throw new Error('DIRECTORY_NOT_FOUND');
                directories = tree.directories.map(entry => entry.path);
                files = tree.files.map(entry => ({ id: entry.id, folderPath: entry.folderPath }));
            } else {
                const file = sourceDrive.get(ownerId, selection?.id);
                if (!file || grant.kind === 'file' && file.id !== grant.fileId || grant.kind === 'directory' && base && file.folderPath !== base && !file.folderPath.startsWith(base + '/'))
                    throw diskOperationError('COLLABORATION_OUT_OF_SCOPE','FILE_OUTSIDE_GRANT');
                files = [{ id: file.id, folderPath: file.folderPath }];
            }
        }
        if (files.length > 10000 || directories.length > 10000) throw new Error('CONTENT_COPY_TOO_LARGE');
        const rootName = selectedDirectory ? selectedPath.split('/').at(-1) : '';
        const targetRoot = [destination, rootName].filter(Boolean).join('/');
        if (selectedDirectory && targetDrive.getDirectory(targetUser.id, targetRoot)) throw diskOperationError('DISK_NAME_CONFLICT','NAME_CONFLICT',{targetPath:targetRoot});
        const translate = path => selectedDirectory ? [targetRoot, path.slice(selectedPath.length).replace(/^\//, '')].filter(Boolean).join('/') : destination;
        const candidates = files.map(entry => {
            const source = sourceDrive.get(ownerId, entry.id);
            if (!source || ['blocked', 'deleted'].includes(source.reviewStatus) || !source.contentId) throw new Error('CONTENT_COPY_SOURCE_INVALID');
            return { source, folderPath: translate(entry.folderPath) };
        });
        const leases = new Map();
        try {
            for (const { source } of candidates) if (!leases.has(source.contentId)) leases.set(source.contentId, content.lease(source.contentId, targetUser.id, 'copy-granted', 'reuse'));
            const created = persistence.atomic(() => {
                for (const directory of directories.sort((a, b) => a.length - b.length)) targetDrive.createDirectory(targetUser.id, translate(directory), maxDepth(), 'system');
                const result = [];
                for (const { source, folderPath } of candidates) {
                    const physical = content.resolve(source.contentId)?.physical;
                    if (!physical) throw new Error('CONTENT_NOT_AVAILABLE');
                    const backend = physical.backendId ? auth.backend(physical.backendId) : getDefaultBackend(physical.channelId);
                    if (!backend) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
                    const contentCopyGrant = { kind, id: grant.id, ...(kind === 'share' ? { token: grant.token } : { viewerId: targetUser.id, version: grant.memberVersions?.[targetUser.id] || 1 }),
                        sourceSpace: diskSpace, sourceOwnerId: ownerId, sourceFileId: source.id };
                    const copied = targetDrive.putCopiedObject(targetUser, folderPath, source.name,
                        { ...source, ...physical, contentId: source.contentId, contentLease: leases.get(source.contentId), contentCopyGrant },
                        physical.parts, backend, maxDepth());
                    result.push({ id: copied.id, name: copied.name, folderPath: copied.folderPath });
                }
                return result;
            }, () => targetDrive.reloadPersistence());
            return { copied: created, directoryCount: directories.length, destination: targetRoot || destination };
        } finally { for (const lease of leases.values()) content.releaseLease(lease); }
    }
    function copyAcrossNamespaces(actor, input, defaultPartitionId) {
        if (input?.mode !== 'copy') throw new Error('CONTENT_COPY_MODE_INVALID');
        const sourceInput = input.source, targetInput = input.target;
        if (!sourceInput || !targetInput || !['native', 'collaboration'].includes(sourceInput.kind)
            || !['native', 'collaboration'].includes(targetInput.kind)
            || sourceInput.kind === 'native' && targetInput.kind === 'native')
            throw diskOperationError('CONTENT_COPY_SCOPE_INVALID', sourceInput?.kind==='native' && targetInput?.kind==='native' ? 'NATIVE_PAIR' : 'REQUEST_SCOPE_INVALID');
        const resolve = (value, target) => {
            if (value.kind === 'native') {
                const partition = partitions.find(actor.id, value.partitionId ?? defaultPartitionId);
                return { kind: 'native', ownerId: actor.id, diskSpace: partition.scopeKey,
                    drive: spaces.get(partition.scopeKey), partitionId: partition.id };
            }
            const grant = collaborations.authorizedFresh(value.collaborationId, actor.id);
            if (!grant || grant.ownerId === actor.id) throw diskOperationError('COLLABORATION_NOT_FOUND',grant?.ownerId===actor.id ? 'OWN_PROJECT_USE_NATIVE' : 'GRANT_MEMBERSHIP_MISSING');
            if (target && grant.kind !== 'directory') throw diskOperationError('COLLABORATION_OUT_OF_SCOPE','FILE_GRANT_TARGET');
            if (target && grant.role !== 'editor') throw diskOperationError('COLLABORATION_READ_ONLY','TARGET_READ_ONLY');
            const partition = partitions.find(grant.ownerId, grant.diskSpace);
            return { kind: 'collaboration', id: grant.id, version: grant.grantVersion,
                ownerId: grant.ownerId, diskSpace: partition.scopeKey, drive: spaces.get(partition.scopeKey), grant };
        };
        const source = resolve(sourceInput, false), target = resolve(targetInput, true);
        if (source.kind === 'collaboration' && target.kind === 'collaboration' && source.id === target.id)
            throw diskOperationError('CONTENT_COPY_SCOPE_INVALID', 'SAME_COLLABORATION');
        const checkedPath = value => {
            if (typeof value !== 'string' || value.includes('\\')) throw new Error('DISK_NAME_INVALID');
            const normalized = normalizeTelegramDrivePath(value);
            if (normalized !== value) throw new Error('DISK_NAME_INVALID');
            return normalized;
        };
        const activeReview = item => item && (!item.reviewStatus || item.reviewStatus === 'active');
        const assertVisibleDirectory = (drive, ownerId, value, errorCode) => {
            let current = '';
            for (const segment of value.split('/').filter(Boolean)) {
                current = current ? current + '/' + segment : segment;
                if (!activeReview(drive.getDirectory(ownerId, current))) throw new Error(errorCode);
            }
        };
        const withinGrant = (grant, value) => !grant.path || value === grant.path || value.startsWith(grant.path + '/');
        source.drive.reloadPersistence(); target.drive.reloadPersistence();
        const selection = sourceInput.selection;
        if (!selection || !['file', 'directory'].includes(selection.kind)) throw new Error('DISK_SELECTION_INVALID');
        let sourcePath = '', directories = [], selectedFiles = [];
        if (selection.kind === 'directory') {
            sourcePath = checkedPath(selection.path);
            if (!sourcePath || source.kind === 'collaboration'
                && (source.grant.kind !== 'directory' || !withinGrant(source.grant, sourcePath)))
                throw diskOperationError('COLLABORATION_OUT_OF_SCOPE',sourcePath ? 'SOURCE_OUTSIDE_GRANT' : 'SOURCE_ROOT_INVALID');
            const tree = source.drive.getDirectoryTree(source.ownerId, sourcePath);
            if (!activeReview(tree) || tree.directories.some(item => !activeReview(item))
                || tree.files.some(item => !activeReview(item))) throw diskOperationError('CONTENT_COPY_SOURCE_INVALID','SOURCE_UNAVAILABLE');
            assertVisibleDirectory(source.drive, source.ownerId, sourcePath, 'CONTENT_COPY_SOURCE_INVALID');
            if (source.kind === 'native' && mounts.countTree(source.ownerId, source.diskSpace, sourcePath))
                throw diskOperationError('MOUNT_TRANSFER_UNSUPPORTED','MOUNT_IN_SOURCE',{targetPath:sourcePath});
            directories = tree.directories.map(item => item.path);
            selectedFiles = tree.files.map(item => item.id);
        } else {
            const file = source.drive.get(source.ownerId, selection.id);
            if (!activeReview(file) || source.kind === 'collaboration'
                && (source.grant.kind === 'file' ? source.grant.fileId !== file.id
                    : !withinGrant(source.grant, file.folderPath || '')))
                throw diskOperationError('CONTENT_COPY_SOURCE_INVALID',activeReview(file) ? 'FILE_OUTSIDE_GRANT' : 'SOURCE_UNAVAILABLE');
            assertVisibleDirectory(source.drive, source.ownerId, file.folderPath || '', 'CONTENT_COPY_SOURCE_INVALID');
            selectedFiles = [file.id];
        }
        if (directories.length > 10000 || selectedFiles.length > 10000) throw new Error('CONTENT_COPY_TOO_LARGE');
        const destination = checkedPath(targetInput.destinationPath ?? '');
        if (!activeReview(target.drive.getDirectory(target.ownerId, destination))) throw new Error('DIRECTORY_NOT_FOUND');
        assertVisibleDirectory(target.drive, target.ownerId, destination, 'DIRECTORY_NOT_FOUND');
        if (target.kind === 'collaboration' && !withinGrant(target.grant, destination))
            throw diskOperationError('COLLABORATION_OUT_OF_SCOPE','TARGET_OUTSIDE_GRANT');
        assertStaticDirectoryWritable({ userId: target.ownerId, diskSpace: target.diskSpace }, target.drive, destination);
        const rootName = sourcePath.split('/').at(-1) || '';
        const targetRoot = sourcePath ? [destination, rootName].filter(Boolean).join('/') : destination;
        if (sourcePath && target.drive.getDirectory(target.ownerId, targetRoot)) throw diskOperationError('DISK_NAME_CONFLICT','NAME_CONFLICT',{targetPath:targetRoot});
        if (sourcePath && source.ownerId === target.ownerId && source.diskSpace === target.diskSpace
            && (destination === sourcePath || destination.startsWith(sourcePath + '/')))
            throw diskOperationError('CONTENT_COPY_SCOPE_INVALID', 'DESTINATION_INSIDE_SOURCE', {sourcePath,targetPath:destination});
        const translate = value => sourcePath
            ? [targetRoot, value.slice(sourcePath.length).replace(/^\//, '')].filter(Boolean).join('/') : destination;
        const candidates = selectedFiles.map(id => {
            const file = source.drive.get(source.ownerId, id);
            if (!activeReview(file) || !file.contentId) throw diskOperationError('CONTENT_COPY_SOURCE_INVALID',activeReview(file)&&!file.contentId ? 'CONTENT_REFERENCE_MISSING' : 'SOURCE_UNAVAILABLE');
            return { id, contentId: file.contentId, folderPath: file.folderPath || '' };
        });
        const leases = new Map();
        try {
            for (const candidate of candidates) if (!leases.has(candidate.contentId))
                leases.set(candidate.contentId, content.lease(candidate.contentId, target.ownerId, 'cross-scope-copy', 'reuse'));
            return persistence.atomic(() => {
                for (const scope of [source, target]) {
                    if (scope.kind === 'native') partitions.find(actor.id, scope.partitionId);
                    else {
                        const current = collaborations.authorizedFresh(scope.id, actor.id);
                        if (!current || current.ownerId !== scope.ownerId || current.diskSpace !== scope.diskSpace
                            || String(current.grantVersion) !== String(scope.version)
                            || scope === target && (current.kind !== 'directory' || current.role !== 'editor'))
                            throw diskOperationError('COLLABORATION_NOT_FOUND',!current ? 'GRANT_MEMBERSHIP_MISSING' : scope===target&&current.role!=='editor' ? 'TARGET_READ_ONLY' : String(current.grantVersion)!==String(scope.version) ? 'GRANT_VERSION_CHANGED' : 'GRANT_CHANGED');
                        partitions.find(current.ownerId, current.diskSpace);
                    }
                }
                source.drive.reloadPersistence(); target.drive.reloadPersistence();
                if (!activeReview(target.drive.getDirectory(target.ownerId, destination))) throw new Error('DIRECTORY_NOT_FOUND');
                assertVisibleDirectory(target.drive, target.ownerId, destination, 'DIRECTORY_NOT_FOUND');
                assertStaticDirectoryWritable({ userId: target.ownerId, diskSpace: target.diskSpace }, target.drive, destination);
                if (sourcePath) {
                    const currentTree = source.drive.getDirectoryTree(source.ownerId, sourcePath);
                    if (!activeReview(currentTree) || currentTree.directories.some(item => !activeReview(item))
                        || currentTree.files.some(item => !activeReview(item))
                        || currentTree.directories.map(item => item.path).sort().join('\n') !== directories.slice().sort().join('\n')
                        || currentTree.files.map(item => item.id).sort().join('\n') !== selectedFiles.slice().sort().join('\n'))
                        throw diskOperationError('CONTENT_COPY_SOURCE_CHANGED','SOURCE_REFERENCE_CHANGED');
                    assertVisibleDirectory(source.drive, source.ownerId, sourcePath, 'CONTENT_COPY_SOURCE_INVALID');
                    if (source.kind === 'native' && mounts.countTree(source.ownerId, source.diskSpace, sourcePath))
                        throw diskOperationError('MOUNT_TRANSFER_UNSUPPORTED','MOUNT_IN_SOURCE',{targetPath:sourcePath});
                }
                for (const directory of directories.sort((a, b) => a.length - b.length))
                    target.drive.createDirectory(target.ownerId, translate(directory), maxDepth(), 'system');
                const targetUser = target.kind === 'native' ? actor : auth.user(target.ownerId);
                if (!targetUser) throw new Error('USER_NOT_FOUND');
                const copied = [];
                for (const candidate of candidates) {
                    const file = source.drive.get(source.ownerId, candidate.id);
                    if (!activeReview(file) || file.contentId !== candidate.contentId
                        || String(file.folderPath || '') !== candidate.folderPath) throw diskOperationError('CONTENT_COPY_SOURCE_CHANGED','SOURCE_REFERENCE_CHANGED');
                    assertVisibleDirectory(source.drive, source.ownerId, file.folderPath || '', 'CONTENT_COPY_SOURCE_INVALID');
                    const physical = content.resolve(file.contentId)?.physical;
                    if (!physical) throw new Error('CONTENT_NOT_AVAILABLE');
                    const backend = physical.backendId ? auth.backend(physical.backendId) : getDefaultBackend(physical.channelId);
                    if (!backend) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
                    const proof = { kind: 'cross-scope', actorId: actor.id,
                        source: { kind: source.kind, ownerId: source.ownerId, diskSpace: source.diskSpace,
                            fileId: file.id, ...(source.kind === 'collaboration' ? { id: source.id, version: source.version } : {}) },
                        target: { kind: target.kind, ownerId: target.ownerId, diskSpace: target.diskSpace,
                            ...(target.kind === 'collaboration' ? { id: target.id, version: target.version } : {}) } };
                    const item = target.drive.putCopiedObject(targetUser, translate(file.folderPath || ''), file.name,
                        { ...file, ...physical, contentId: file.contentId, contentLease: leases.get(file.contentId),
                            contentCopyGrant: proof }, physical.parts || [], backend, maxDepth());
                    copied.push({ id: item.id, name: item.name, folderPath: item.folderPath });
                }
                return { copied, directoryCount: directories.length, destination: targetRoot,
                    sourceKind: source.kind, targetKind: target.kind };
            }, () => { source.drive.reloadPersistence(); target.drive.reloadPersistence(); mounts.reloadPersistence(); });
        } finally { for (const lease of leases.values()) content.releaseLease(lease); }
    }
    let retryingCaptions = false, closed = false;
    let recoveringUploads = false, recoveryRetryTimer = null;
    const recoveryBacklog = [];
    const activeProgressiveUploads = new Set();
    const queueUploadRecovery = entry => {
        if (!entry?.job?.id || recoveryBacklog.some(item => item.store === entry.store && item.job.id === entry.job.id)) return;
        recoveryBacklog.push(entry);
        if (!closed && !recoveryRetryTimer) {
            recoveryRetryTimer = setTimeout(() => { recoveryRetryTimer = null; cleanupRecoveredUploads().catch(() => {}); }, 60000);
            recoveryRetryTimer.unref?.();
        }
    };
    const cleanupTimer = setInterval(() => {
        cleanupExpiredUploads().catch(() => console.warn('[网盘] 暂存清理失败，请检查数据目录权限'));
        retryCaptions().catch(() => {});
        retryRemoteCleanup().catch(error => console.warn('[网盘] 旧对象清理重试失败：', error.message));
    }, 60000);
    cleanupTimer.unref();
    async function cleanupExpiredUploads() {
        for (const { store, job } of spaces.cleanup()) {
            if (job.progressive && job.pipelineDone) {
                // The runner may still acquire a Telegram message while expiry
                // is detected. Abort and join it before taking a cleanup snapshot;
                // otherwise an in-flight final group can escape that snapshot.
                job.pipelineFailure ||= new Error('UPLOAD_EXPIRED');
                try { operations.fail(job.operationId, job.pipelineFailure); } catch (_) {}
                job.pipelineAbort?.abort(job.pipelineFailure); coreUpload.pipelineWake(job);
                await job.pipelineDone.catch(() => {});
                continue;
            }
            if (job.operationId) operations.fail(job.operationId, new Error('UPLOAD_EXPIRED'));
            const parts = uploadRemoteParts(job);
            if (!parts.length) { await store.abortAsync(job.id); continue; }
            const storage = job.storage || (job.backendId ? auth.backend(job.backendId) : getDefaultBackend(job.channelId));
            try {
                const remote = { name: job.files[0]?.name || '过期上传', channelId: job.channelId || storage.channelId, createdAt: job.createdAt, parts };
                if (job.progressive && typeof telegram.cleanupTemporaryMessages === 'function') await telegram.cleanupTemporaryMessages(storage, remote, { uploadId: job.id, operationId: job.operationId });
                else await telegram.remove(storage, remote);
                log('upload.expired-cleanup-complete', { uploadId: job.id, operationId: job.operationId, parts: parts.length });
                await store.abortAsync(job.id);
            } catch (error) {
                log('upload.expired-cleanup-failed', { uploadId: job.id, operationId: job.operationId, parts: parts.length, error: networkDetails(error) });
                try { await store.preserveForRecoveryAsync(job.id); }
                catch (manifestError) { log('upload.recovery-manifest-failed', { uploadId: job.id, operationId: job.operationId, error: networkDetails(manifestError), details: diskErrorDetails(manifestError) }); }
                queueUploadRecovery({ store, job });
            }
        }
    }
    async function cleanupRecoveredUploads() {
        if (recoveringUploads || closed) return;
        recoveringUploads = true;
        const pending = recoveryBacklog.splice(0);
        try { for (const { store, job } of pending) {
            if (job.progressive && job.recoveryDisposition !== 'rollback') {
                await recoverProgressiveUpload(store, job);
                continue;
            }
            const parts = uploadRemoteParts(job);
            try {
                if (parts.length) {
                    const storage = job.storage || (job.backendId ? auth.backend(job.backendId) : getDefaultBackend(job.channelId));
                    const remote = { name: job.files?.[0]?.name || '未完成上传', channelId: job.channelId || storage.channelId, createdAt: job.createdAt, parts };
                    if (job.progressive && typeof telegram.cleanupTemporaryMessages === 'function') await telegram.cleanupTemporaryMessages(storage, remote, { uploadId: job.id, operationId: job.operationId });
                    else await telegram.remove(storage, remote);
                    log('upload.restart-cleanup-complete', { uploadId: job.id, operationId: job.operationId, parts: parts.length });
                }
                store.discardRecovered(job);
            } catch (error) {
                log('upload.restart-cleanup-failed', { uploadId: job.id, operationId: job.operationId, parts: parts.length, error: networkDetails(error) });
                queueUploadRecovery({ store, job });
            }
        } } finally { recoveringUploads = false; }
    }
    // Include both sides of finalization, deduplicated by message ID. Temporary
    // IDs remain important for cancellation before a logical file is committed.
    function uploadRemoteParts(job) {
        const candidates = [...(job.files || []).flatMap(file => [
            ...(file.chunks || []).flatMap(chunk => [chunk.tempRemote, chunk.remote]),
            ...(file.finalGroups || []).flatMap(group => group.remotes || group.parts || []), file.thumbnail?.remote
        ]), ...(job.pendingRollbackParts || [])].filter(Boolean);
        return [...new Map(candidates.filter(part => part.messageId).map(part => [String(part.messageId), part])).values()];
    }
    async function recoverProgressiveUpload(diskStore, manifest) {
        const operationScope = manifest.operationScope || { userId: manifest.ownerId || manifest.owner?.id, diskSpace: manifest.diskSpace || '' };
        const previous = operations.get(manifest.operationId, operationScope);
        if (previous?.status === 'completed') { diskStore.discardRecovered(manifest); return; }
        if (previous?.cancelRequested || previous?.status === 'cancelled') {
            manifest.recoveryDisposition = 'rollback'; queueUploadRecovery({ store: diskStore, job: manifest }); return;
        }
        let reservation = false;
        try {
            const batch=content.batch(manifest.id);
            if(batch) {
                const items=batch.map(id=>diskStore.get(manifest.ownerId || manifest.owner?.id,id));
                operations.resumeUpload(manifest.operationId,operationScope);
                operations.complete(manifest.operationId,{ok:true,items:items.filter(Boolean).map(uploadResultFile),warnings:[]});
                diskStore.discardRecovered(manifest); return;
            }
            const committed = (manifest.files || []).map(file => diskStore.get(manifest.ownerId || manifest.owner?.id, file.logicalId));
            if (committed.length && committed.every((file, index) => file && file.ownerId === operationScope.userId
                && file.size === manifest.files[index].size && String(file.channelId) === String(manifest.channelId)
                && file.parts.length === manifest.files[index].parts.length
                && file.parts.every((part, partIndex) => part.messageId === manifest.files[index].chunks[partIndex]?.finalRemote?.messageId))) {
                operations.resumeUpload(manifest.operationId, operationScope);
                operations.complete(manifest.operationId, { ok: true, items: committed.map(uploadResultFile), warnings: [] });
                diskStore.discardRecovered(manifest);
                log('upload.progressive-commit-recovered', { uploadId: manifest.id, operationId: manifest.operationId });
                return;
            }
            // Partial browser requests cannot be completed by Node alone. More
            // importantly, an unconfirmed completed POST is not idempotent.
            const chunks = (manifest.files || []).flatMap(file => file.chunks || []);
            const unknown = manifest.recoveryDisposition === 'unknown' || chunks.some(chunk =>
                !chunk.tempRemote && !chunk.remote && (chunk.unknownResult || chunk.attemptIntent || ['pushing', 'awaiting_response', 'push_unknown', 'unknown'].includes(chunk.status)))
                || (manifest.files || []).some(file => (file.finalGroups || []).some(group => (group.intent || group.unknownResult || ['finalizing', 'unknown'].includes(group.status)) && !group.remotes?.length));
            if (unknown) throw new Error('TELEGRAM_UPLOAD_OUTCOME_UNKNOWN');
            if (!manifest.clientDone) throw new Error('UPLOAD_SOURCE_INTERRUPTED');
            contentProof.assertAuthorization(manifest.contentAuthorization);
            if (activeProgressiveUploads.size >= 20) { queueUploadRecovery({ store: diskStore, job: manifest }); return; }
            if (!previous) throw new Error('OPERATION_NOT_FOUND');
            if (manifest.collaborationId) {
                const grant=collaborations.authorizedFresh(manifest.collaborationId,manifest.viewerId || manifest.owner?.id);
                if(!grant || grant.role === 'viewer' || manifest.collaborationVersion && String(grant.grantVersion)!==String(manifest.collaborationVersion)) throw new Error('COLLABORATION_NOT_FOUND');
            }
            activeProgressiveUploads.add(manifest.id); reservation = true;
            const storage = await resolveStorageBackend(manifest.backendId ? auth.backend(manifest.backendId) : getDefaultBackend(manifest.channelId));
            if (!storage?.token || String(storage.channelId) !== String(manifest.channelId)) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
            const job = await diskStore.activateRecoveredUpload(manifest);
            job.storage = storage;
            const req = { diskScope: operationScope, diskUser: job.owner, diskStore,
                get: () => '', collaboration: manifest.collaborationId ? { id: manifest.collaborationId, ...(manifest.collaborationVersion ? {grantVersion:manifest.collaborationVersion}: {}) } : null,
                diskViewerId: manifest.viewerId || job.owner.id };
            if (!operations.resumeUpload(job.operationId, operationScope)) {
                await diskStore.preserveForRecoveryAsync(job.id); throw new Error('OPERATION_NOT_FOUND');
            }
            activeProgressiveUploads.add(job.id);
            job.pipelineDone = new Promise(resolve => { job.pipelineDoneResolve = resolve; });
            operations.run(job.operationId, (update, control) => coreUpload.runProgressiveUpload(req, job, update, control));
            log('upload.progressive-resumed', { uploadId: job.id, operationId: job.operationId });
        } catch (error) {
            if (reservation) activeProgressiveUploads.delete(manifest.id);
            if (previous && !['failed', 'cancelled', 'completed'].includes(previous.status)) operations.fail(manifest.operationId, error);
            log('upload.progressive-recovery-paused', { uploadId: manifest.id, operationId: manifest.operationId, code: diskErrorCode(error) });
            // Keep the manifest and known remote IDs. Do not delete the sole
            // recoverable copy or automatically resend an ambiguous request.
        }
    }
    queueMicrotask(() => {
        const entries = spaces.recoveries(), ids = new Set(entries.map(entry => entry.job.operationId));
        for (const entry of entries) queueUploadRecovery(entry);
        for (const operation of operations.recoveringUploads?.() || []) if (!ids.has(operation.operation_id)) operations.fail(operation.operation_id, new Error('UPLOAD_RECOVERY_MANIFEST_MISSING'));
        cleanupRecoveredUploads().catch(error => console.warn('[网盘] 重启上传回滚失败：', error.message));
    });
    const mutations = new Map();
    let telegramUploadTail = Promise.resolve();
    async function enqueueTelegramUpload(job, work) {
        const previous = telegramUploadTail;
        const queuedAt = Date.now();
        let release;
        const slot = new Promise(resolve => { release = resolve; });
        telegramUploadTail = previous.catch(() => {}).then(() => slot);
        log('telegram.queue-wait', { uploadId: job.id, operationId: job.operationId });
        await previous.catch(() => {});
        log('telegram.queue-start', { uploadId: job.id, operationId: job.operationId, waitedMs: Date.now() - queuedAt });
        try { return await work(); }
        finally { log('telegram.queue-release', { uploadId: job.id, operationId: job.operationId, elapsedMs: Date.now() - queuedAt }); release(); }
    }
    // Serialize index mutations for one logical disk while remote work is pending.
    // Reads and unrelated users/spaces remain independent.
    async function mutate(req, work, diagnostic) {
        const key = JSON.stringify([req.diskScope.userId, req.diskScope.diskSpace]);
        const previous = mutations.get(key) || Promise.resolve();
        const queuedAt = performance.now();
        if (diagnostic) log('metadata.mutation-queued', { ...diagnostic, queuedBehindMutation: mutations.has(key) });
        const pending = previous.catch(() => {}).then(async () => {
            const startedAt = performance.now(), queuedMs = Math.round(startedAt - queuedAt);
            if (diagnostic) log('metadata.mutation-start', { ...diagnostic, queuedMs });
            try { return await work(); }
            finally {
                if (diagnostic) log('metadata.mutation-end', { ...diagnostic, queuedMs, workMs: Math.round(performance.now() - startedAt) });
            }
        });
        mutations.set(key, pending);
        try { return await pending; }
        finally { if (mutations.get(key) === pending) mutations.delete(key); }
    }
    async function syncCaptions(store, scope, files, update) {
        let failed = false;
        for (const file of files) {
            if (file.reviewStatus === 'deleted') continue;
            if(file.contentId) continue;
            try {
                const storage = file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
                await telegram.syncCaption(storage, file, scope, update);
                store.update(scope.userId, file.id, { captionSyncPending: false, captionWarning: '' });
            } catch (_) { failed = true; }
        }
        if (failed) throw new Error('TELEGRAM_CAPTION_SYNC_PENDING');
    }
    async function retryCaptions() {
        if (retryingCaptions || closed) return;
        retryingCaptions = true;
        try {
            if(typeof telegram.call==='function')for(let count=0;count<20 && !closed;count++){
                const task=content.claimCaption();if(!task)break;
                let error;
                try{const physical=task.physical,storage=physical.backendId ? auth.backend(physical.backendId) : getDefaultBackend(physical.channelId);
                    await telegram.call(storage,'editMessageCaption',{chat_id:physical.channelId,message_id:physical.messageId,caption:physical.caption});
                }catch(failure){if(!/message is not modified/i.test(failure.telegramDescription || failure.message || '')){error=failure;log('content.caption-retry',{contentId:task.content_id,error:networkDetails(failure)});}}
                content.finishCaption(task,error);
            }
            for (const { diskSpace, store } of spaces.entries()) {
                for (const saved of store.adminFiles().filter(file => file.captionSyncPending && file.reviewStatus !== 'deleted')) {
                    if (closed) return;
                    const scope = { userId: saved.ownerId, diskSpace };
                    await mutate({ diskScope: scope }, async () => {
                        const current = store.get(scope.userId, saved.id);
                        if (current?.captionSyncPending && current.reviewStatus !== 'deleted') await syncCaptions(store, scope, [current]);
                    }, { type: 'caption-retry', fileId: saved.id, userId: scope.userId, diskSpace }).catch(() => {});
                }
            }
        } finally { retryingCaptions = false; }
    }
    let cleaningRemote = null;
    async function retryRemoteCleanup(contentId = '') {
        while (cleaningRemote) await cleaningRemote;
        if (closed) return;
        const running = Promise.resolve().then(async () => {
            for(let i=0;contentCleanupMode==='execute' && i<30;i++) {
                const task=content.claimCleanup(Date.now(),contentId); if(!task) break;
                let error;
                log('content.cleanup-start',{cleanupId:task.id,contentId:task.content_id,purpose:task.purpose,attempt:task.attempts+1});
                try {
                    const physical=task.physical;
                    const storage=physical.backendId ? auth.backend(physical.backendId) : getDefaultBackend(physical.channelId);
                    if(!content.allowed(physical)) throw new Error('CONTENT_ANCHOR_IN_USE');
                    if(physical.parts.length || physical.thumbnail?.messageId) await enqueueTelegramUpload({id:task.id},()=>task.purpose==='temporary-upload' && telegram.cleanupTemporaryMessages
                        ? telegram.cleanupTemporaryMessages(storage,physical,{finalMessageIds:physical.finalMessageIds || []}) : telegram.remove(storage,physical));
                } catch(failure) { error=failure;if(task.purpose==='temporary-upload' && task.physical.operationId)operations.addWarning?.(task.physical.operationId,'TELEGRAM_TEMP_CLEANUP_PENDING'); log('content.cleanup-retry',{contentId:task.content_id,error:networkDetails(failure)}); }
                content.finishCleanup(task,error);
                if (!error) log('content.cleanup-complete',{cleanupId:task.id,contentId:task.content_id,purpose:task.purpose});
            }
            if (contentId) return;
            for (const { diskSpace, store } of spaces.entries()) for (const saved of store.adminFiles().filter(file => file.pendingRemoteCleanup?.length)) {
                const scope = { userId: saved.ownerId, diskSpace };
                for (const stale of saved.pendingRemoteCleanup) {
                    try {
                        if (stale.parts?.length || stale.messageId || stale.thumbnail?.messageId) {
                            const storage = stale.backendId ? auth.backend(stale.backendId) : getDefaultBackend(stale.channelId);
                            if (stale.progressive && typeof telegram.cleanupTemporaryMessages === 'function') await telegram.cleanupTemporaryMessages(storage, stale, {
                                taskKey: `cleanup-${saved.id}`, operationId: stale.operationId,
                                finalMessageIds: saved.parts.map(part => part.messageId)
                            });
                            else if (stale.progressive && telegram.scheduler) await telegram.scheduler.enqueue(storage, () => telegram.remove(storage, stale), { taskKey: `cleanup-${saved.id}`, priority: 10 });
                            else await enqueueTelegramUpload({ id: `cleanup-${saved.id}` }, () => telegram.remove(storage, stale));
                        }
                        await mutate({ diskScope: scope }, () => {
                            const current = store.get(scope.userId, saved.id);
                            if (current) store.clearPendingRemoteCleanup(scope.userId, current.id, stale.messageId, stale.channelId);
                        });
                    } catch (error) {
                        if (stale.progressive && stale.operationId) operations.addWarning?.(stale.operationId, 'TELEGRAM_TEMP_CLEANUP_PENDING');
                        log(stale.progressive ? 'upload.temporary-cleanup-retry' : 's3.overwrite-cleanup-retry', { fileId: saved.id, messageId: stale.messageId, error: networkDetails(error) });
                    }
                }
            }
        }).finally(() => { if (cleaningRemote === running) cleaningRemote = null; });
        cleaningRemote = running;
        return running;
    }
    async function cleanupDeletedContent(id) {
        if (content.references(id).length) return { status:'shared' };
        await retryRemoteCleanup(id);
        const item=content.resolve(id);
        if (item?.state === 'DELETED') return { status:'completed' };
        if (content.references(id).length) return { status:'shared' };
        log('content.cleanup-pending',{contentId:id,state:item?.state || 'missing',mode:contentCleanupMode});
        return { status:'pending' };
    }
    const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function openRemoteRange(backend, file, start = 0, end = Number(file.size) - 1, signal, diskSpace = '') {
        if (typeof telegram.parts !== 'function' || typeof telegram.readPart !== 'function') {
            const source = await telegram.read(backend, file);
            if (start === 0 && end === Number(file.size) - 1) return source;
            let skipped = 0, emitted = 0;
            async function* sliceLegacy() {
                for await (const chunk of source) {
                    if (signal?.aborted) throw new Error('OPERATION_CANCELLED');
                    if (skipped + chunk.length <= start) { skipped += chunk.length; continue; }
                    const from = Math.max(0, start - skipped), take = Math.min(chunk.length - from, end - start + 1 - emitted);
                    if (take > 0) { emitted += take; yield chunk.subarray(from, from + take); }
                    skipped += chunk.length; if (emitted >= end - start + 1) { source.destroy?.(); break; }
                }
            }
            return Readable.from(sliceLegacy());
        }
        const parts = telegram.parts(file);
        const backendKey = crypto.createHash('sha256').update(String(backend.baseUrl || '') + '\0' + String(backend.token || '')).digest('hex');
        async function* combine() {
            const needed = parts.filter(part => {
                const partStart = Number(part.offset) || 0;
                return partStart + part.size - 1 >= start && partStart <= end;
            });
            for (let index = 0; index < needed.length; index++) {
                signal?.throwIfAborted();
                const part = needed[index];
                const partStart = Number(part.offset) || 0;
                const localStart = Math.max(0, start - partStart), localEnd = Math.min(part.size - 1, end - partStart);
                const block = 1024 * 1024;
                const cacheStart = Math.floor(localStart / block) * block;
                const cacheEnd = Math.min(part.size - 1, Math.ceil((localEnd + 1) / block) * block - 1);
                const key = ['v2', backendKey, part.fileId, Number(part.size), part.sha256 || '', cacheStart, cacheEnd].join(':');
                const source = await partCache.open({
                    key, size: cacheEnd - cacheStart + 1,
                    owner: file.contentProofRead ? undefined : { userId: file.viewerId || file.ownerId, diskSpace },
                    start: localStart - cacheStart, end: localEnd - cacheStart, signal,
                    cancelWhenUnused: file.cancelUnusedCacheFill === true,
                    expectedSha256: cacheStart === 0 && cacheEnd === Number(part.size) - 1 ? String(part.sha256 || '') : '',
                    // Cache fills are shared; only the last departing reader stops upstream.
                    source: cacheSignal => telegram.readPart(backend, part, { start: cacheStart, end: cacheEnd, signal: cacheSignal })
                });
                // Overlap only the next part's small getFile lookup with the
                // current byte stream. Do not start a second file download.
                if (needed[index + 1] && typeof telegram.prefetchPartLocation === 'function')
                    telegram.prefetchPartLocation(backend, needed[index + 1]).catch(() => {});
                for await (const chunk of source) yield chunk;
            }
        }
        return Readable.from(combine());
    }
    async function readRemote(backend, file, start, end, signal, diskSpace) {
        const lease=file.contentId ? content.lease(file.contentId,file.viewerId || file.ownerId || '',crypto.randomUUID(),'read') : '';
        let timer, source, released=false;
        const release=()=>{if(released)return;released=true;clearInterval(timer);if(lease)content.releaseLease(lease);};
        try {
            if(lease) {
                file={...file,...content.leasedPhysical(lease)};
                file.parts=file.parts.map((part,index)=>({...part,logicalFileId:file.id,partIndex:index+1,partCount:file.parts.length,originalSize:file.size}));
                backend=await resolveStorageBackend(file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId),{strict:false});
                timer=setInterval(()=>{try{if(!content.renewLease(lease))source?.destroy(new Error('CONTENT_LEASE_EXPIRED'));}catch(error){source?.destroy(error);}},60000);timer.unref?.();
            }
            try {source=await openRemoteRange(backend,file,start,end,signal,diskSpace);}
            catch(error){if(signal?.aborted || !/TELEGRAM_(?:DOWNLOAD_NETWORK|NETWORK_ERROR|DOWNLOAD_FAILED|RANGE_INVALID|PART_SIZE_MISMATCH|PART_HASH_MISMATCH)/.test(error.message))throw error;await wait(250);source=await openRemoteRange(backend,file,start,end,signal,diskSpace);}
            source.once('close',release);source.once('error',release);source.once('end',release);return source;
        } catch(error) {release();throw error;}
    }
    const parseRange = (header, size) => {
        if (!header) return { start: 0, end: size - 1, partial: false };
        const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
        if (!match || (!match[1] && !match[2])) return null;
        let start, end;
        if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return null; start = Math.max(0, size - suffix); end = size - 1; }
        else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
        if (![start, end].every(Number.isSafeInteger) || start < 0 || start >= size || end < start) return null;
        return { start, end: Math.min(end, size - 1), partial: true };
    };
    async function prepareRemoteResponse(req, res, backend, file, { inline = false, operationId = '', diskSpace = req.diskScope?.diskSpace ?? req.query.disk_space ?? '', cancelUnusedCacheFill = false } = {}) {
        if (!Number(file.size)) {
            res.status(200).set({ 'Accept-Ranges': 'bytes', 'Content-Type': file.type || 'application/octet-stream', 'Content-Length': '0', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}` });
            return { source: Readable.from([]), range: { start: 0, end: -1, partial: false }, abort: new AbortController() };
        }
        const range = parseRange(req.get('Range'), file.size);
        if (!range) { res.status(416).set('Content-Range', `bytes */${file.size}`).end(); return null; }
        backend = await resolveStorageBackend(backend, { strict: false });
        const abort = new AbortController();
        res.on('close', () => { if (!res.writableEnded) abort.abort(); });
        if (res.destroyed) abort.abort();
        const source = await objectStorage.openFile(backend, {...file,viewerId:req.diskViewerId || req.diskUser?.id || file.ownerId,cancelUnusedCacheFill}, range.start, range.end, abort.signal, diskSpace);
        const length = range.end - range.start + 1;
        res.status(range.partial ? 206 : 200);
        res.set('Accept-Ranges', 'bytes');
        res.set('Content-Type', file.type || 'application/octet-stream');
        res.set('Content-Length', String(length));
        if (range.partial) res.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
        res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        if (operationId) res.set('X-Disk-Operation-Id', operationId);
        if (/^-?\d+$/.test(String(backend.channelId || ''))) res.set('X-Drop2Tunnel-Telegram-Chat-Id', String(backend.channelId));
        return { source, range, abort };
    }
    const limiter = () => rateLimit({ windowMs: 60000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'AUTH_RATE_LIMIT' } });
    const failure = (error, req, res, next) => {
        if (res.headersSent) return res.destroy();
        const code = diskErrorCode(error);
        const errorDetails = diskErrorDetails(error);
        errorDetails.requestId ||= req.diskMetadataTiming?.requestId || crypto.randomUUID();
        res.set('X-Disk-Request-Id',errorDetails.requestId);
        res.status(errorStatus(code)).json({ error: code, code, userMessage: diskUserMessage(error), errorDetails });
    };
    const noStore = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };
    browser.use(noStore); external.use(noStore); admin.use(noStore);
    shared.use(noStore);
    shared.use(rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false }));
    shared.use((req, res, next) => { res.set({ 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' }); next(); });
    shared.get('/:token', wrap((req, res) => {
        const started = performance.now();
        const share = shares.resolve(req.params.token);
        const data = shares.contents(share, spaces.get(share.diskSpace), req.query.path || '');
        const elapsedMs = Math.round(performance.now() - started);
        res.set('Server-Timing', `share-metadata;dur=${elapsedMs}`);
        log('share.metadata', { elapsedMs, files: data.files.length, folders: data.folders.length });
        res.json(data);
    }));
    shared.get('/:token/files/:id/download', wrap(async (req, res) => {
        const share = shares.resolve(req.params.token);
        const file = shares.file(share, spaces.get(share.diskSpace), req.params.id);
        const backend = file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
        const remote = await prepareRemoteResponse(req, res, backend, file, { inline: req.query.inline === '1', diskSpace: share.diskSpace, cancelUnusedCacheFill: true });
        if (!remote) return;
        // Recheck revocation after an upstream wait, before releasing any bytes.
        try { shares.resolve(req.params.token); } catch (error) { remote.source.destroy(); throw error; }
        await pipeline(remote.source, res);
    }));
    shared.post('/:token/copy', wrap((req, res) => {
        const origin = req.get('Origin');
        if (origin && origin !== getOrigin(req)) throw new Error('ORIGIN_MISMATCH');
        const user = getIdentity(req);
        if (!user) throw new Error('LOGIN_REQUIRED');
        const share = shares.resolve(req.params.token);
        const result = copyGrantedItem({ kind: 'share', grant: share, ownerId: share.ownerId, diskSpace: share.diskSpace,
            selection: req.body?.selection, targetUser: user, targetSpace: String(req.body?.diskSpace || ''), destinationPath: req.body?.destinationPath || '' });
        res.status(201).json(result);
    }));
    shared.use(failure);
    publicStatic.use(rateLimit({ windowMs: 60000, max: 1200, standardHeaders: true, legacyHeaders: false }));
    publicStatic.use((req, res, next) => {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
            'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' });
        next();
    });
    publicStatic.options('*', (_req, res) => res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS').status(204).end());
    publicStatic.use(wrap(async (req, res) => {
        if (!['GET','HEAD'].includes(req.method)) return res.status(405).end();
        const raw = req.originalUrl.split('?')[0];
        if (!raw.startsWith('/s3pub/')) throw new Error('STATIC_NOT_FOUND');
        const segments = raw.slice('/s3pub/'.length).split('/');
        const token = segments.shift();
        const decoded = segments.map(segment => decodeURIComponent(segment));
        if (decoded.some(segment => !segment || segment === '.' || segment === '..' || /[\\/]/.test(segment))) throw new Error('STATIC_NOT_FOUND');
        const grant = staticResources.resolve(token), filename = decoded.join('/');
        const file = staticResources.file(grant, spaces.get(grant.diskSpace), filename);
        const remaining = Math.min(grant.expiresAt ? Math.max(0, Math.floor((grant.expiresAt - Date.now()) / 1000)) : 31536000,
            staticResources.effectiveCacheSeconds(grant, file));
        if (!remaining) throw new Error('STATIC_NOT_FOUND');
        res.set('Cache-Control', 'public, max-age=' + Math.min(remaining, 31536000));
        if (/^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml)(?:;|$)/i.test(String(file.type || '')))
            res.set('Content-Security-Policy', 'sandbox');
        if (req.method === 'HEAD') return res.status(200).set({ 'Content-Type': file.type || 'application/octet-stream',
            'Content-Length': String(file.size), 'Accept-Ranges': 'bytes' }).end();
        const backend = file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
        const remote = await prepareRemoteResponse(req, res, backend, file, { inline: true, diskSpace: grant.diskSpace });
        if (!remote) return;
        try { staticResources.resolve(token); }
        catch (error) { remote.source.destroy(); throw error; }
        const afterWait = Math.min(grant.expiresAt ? Math.max(0, Math.floor((grant.expiresAt - Date.now()) / 1000)) : 31536000,
            staticResources.effectiveCacheSeconds(grant, file));
        if (!afterWait) { remote.source.destroy(); throw new Error('STATIC_NOT_FOUND'); }
        res.set('Cache-Control', 'public, max-age=' + Math.min(afterWait, 31536000));
        res.removeHeader('X-Drop2Tunnel-Telegram-Chat-Id');
        await pipeline(remote.source, res);
    }));
    publicStatic.use(failure);
    const csrf = (req, res, next) => {
        const origin = req.get('Origin');
        if (origin && origin !== getOrigin(req)) return res.status(403).json({ error: 'ORIGIN_MISMATCH' });
        next();
    };
    browser.use(csrf);

    admin.use(csrf);
    const contentAdmin=createContentAdmin(content);
    admin.get('/content-objects',wrap((req,res)=>res.set('Cache-Control','no-store').json({...contentAdmin.list(req.query),cleanup_mode:contentCleanupMode})));
    admin.get('/content-objects/:id',wrap((req,res)=>res.set('Cache-Control','no-store').json({...contentAdmin.detail(req.params.id),cleanup_mode:contentCleanupMode})));
    admin.get('/content-reference-files',wrap((req,res)=>res.set('Cache-Control','no-store').json(contentAdmin.files(req.query))));
    admin.post('/content-reference-by-upload', wrap(async (req, res) => {
        if (!String(req.get('Content-Type') || '').startsWith('application/octet-stream')) throw new Error('CONTENT_QUERY_INVALID');
        const digest = crypto.createHash('sha256'); let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > LOGICAL_FILE_UPLOAD_LIMIT) throw new Error('CONTENT_QUERY_TOO_LARGE');
            digest.update(chunk);
        }
        const sha256 = digest.digest('hex');
        res.json({ size, sha256, matches: contentAdmin.byHash(sha256, size) });
    }));
    // Explicit administrator action only. Startup/schema migration never reads
    // Telegram to infer a trusted digest or merges historical contents.
    admin.post('/content-objects/:id/verify',wrap((req,res)=>{
        const candidate=content.resolve(req.params.id);
        if(!candidate || candidate.hash_status==='anchor_conflict')throw new Error('CONTENT_NOT_AVAILABLE');
        const ref=content.references(candidate.id)[0];if(!ref)throw new Error('CONTENT_NOT_REFERENCED');
        const file=spaces.get(ref.scope).adminFiles().find(item=>item.id===ref.logical_file_id);
        if(!file)throw new Error('FILE_NOT_FOUND');
        const operation=operations.create({userId:file.ownerId,diskSpace:ref.scope},'content-verify','正在验证历史文件完整内容',file.size);
        operations.run(operation.operation_id,async update=>{
            const backend=file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
            const digest=crypto.createHash('sha256');let bytes=0;
            if(file.size){const source=await readRemote(backend,file,0,file.size-1,undefined,ref.scope);
                for await(const chunk of source){bytes+=chunk.length;digest.update(chunk);update({phase:'content-hashing',processedBytes:bytes,totalBytes:file.size,percent:bytes/file.size*100});}}
            if(bytes!==file.size)throw new Error('CONTENT_SIZE_MISMATCH');
            const sha=digest.digest('hex');content.verifyLegacy(candidate.id,sha,file.size,candidate.current_revision);
            const canonical=content.find(sha,file.size);
            let merged=0;
            if(req.body?.merge===true && canonical && canonical!==candidate.id){
                const existing=content.resolve(canonical),storage=existing.physical.backendId ? auth.backend(existing.physical.backendId) : getDefaultBackend(existing.physical.channelId);
                if(telegram.check)await telegram.check(storage,{...existing.physical,size:existing.size});
                merged=content.mergeVerified(candidate.id,canonical,candidate.current_revision).merged;
                for(const entry of spaces.entries())entry.store.reloadPersistence();
            }
            return {verified:true,contentId:merged?canonical:candidate.id,merged};
        });
        res.status(202).json({operation_id:operation.operation_id});
    }));
    admin.get('/apps', (req, res) => res.json({ apps: auth.apps() }));
    admin.post('/apps', wrap(async (req, res) => res.json(await auth.saveApp(req.body || {}))));
    admin.delete('/apps/:id', (req, res) => { auth.deleteApp(req.params.id); res.json({ ok: true }); });
    function partCacheSelection(input = {}) {
        const scope = String(input.scope || 'all'), userId = String(input.user_id || ''), diskSpace = String(input.disk_space || '');
        if (!['all', 'user', 'partition', 'user-partition'].includes(scope) || (['user', 'user-partition'].includes(scope) && !userId)) throw new Error('INVALID_CACHE_SCOPE');
        return { scope, userId, diskSpace };
    }
    function* legacyPartCacheKeys({ scope, userId, diskSpace: selectedSpace }) {
        // Old cache names contain only a SHA-256 digest. Reconstruct possible
        // MiB-aligned byte windows from logical file records for scoped cleanup.
        if (scope === 'all' || typeof telegram.parts !== 'function') return;
        for (const { diskSpace, store } of spaces.entries()) {
            for (const file of store.adminFiles()) {
                let backend; try { backend = file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId); } catch (_) { continue; }
                if (!backend) continue;
                const backendKey = crypto.createHash('sha256').update(String(backend.baseUrl || '') + '\0' + String(backend.token || '')).digest('hex');
                for (const part of telegram.parts(file)) for (let start = 0; start < part.size; start += 1024 * 1024) {
                    for (let next = start + 1024 * 1024; ; next += 1024 * 1024) {
                        const end = Math.min(part.size - 1, next - 1);
                        yield {key:['v2', backendKey, part.fileId, Number(part.size), part.sha256 || '', start, end].join(':'),owner:{userId:file.ownerId,diskSpace}};
                        if (end === part.size - 1) break;
                    }
                }
            }
        }
    }
    admin.get('/part-cache', wrap(async (req, res) => {
        const selection = partCacheSelection(req.query);
        res.json(await partCache.overview({ ...selection, legacyKeys: legacyPartCacheKeys(selection) }));
    }));
    admin.delete('/part-cache', wrap(async (req, res) => {
        const selection = partCacheSelection(req.body);
        res.json(await partCache.clear({ ...selection, legacyKeys: legacyPartCacheKeys(selection) }));
    }));
    const appLabel = id => {
        if (id === 'system') return '本系统';
        if (id === 'legacy') return '历史数据（来源未知）';
        if (id === 'unassigned') return '尚未使用网盘';
        const app = auth.apps().find(item => item.app_id === id);
        return app?.remark ? `${id}（${app.remark}）` : id;
    };
    const adminUserMap = () => new Map(auth.users().map(user => [user.id, user]));
    const inferSourceAppId = (file, diskSpace, usages = spaces.usages()) => {
        if (file.sourceAppId) return file.sourceAppId;
        const candidates = [...new Set(usages.filter(item => item.userId === file.ownerId && item.diskSpace === diskSpace).map(item => item.appId))];
        return candidates.length === 1 ? candidates[0] : 'legacy';
    };
    admin.get('/storage-overview', (req, res) => {
        const users = adminUserMap(), groups = new Map();
        const add = (appId, userId, diskSpace) => {
            const key = JSON.stringify([appId, userId, diskSpace]);
            if (!groups.has(key)) groups.set(key, { appId, appLabel: appLabel(appId), userId, user: users.get(userId) || { id: userId, name: '历史用户' }, diskSpace, fileCount: 0, size: 0, lastActivity: 0 });
            return groups.get(key);
        };
        const usages = spaces.usages();
        for (const usage of usages) add(usage.appId, usage.userId, usage.diskSpace).lastActivity = usage.lastUsedAt;
        for (const { diskSpace, store } of spaces.entries()) for (const file of store.adminFiles()) {
            const group = add(inferSourceAppId(file, diskSpace, usages), file.ownerId, diskSpace);
            group.fileCount++; group.size += Number(file.size) || 0; group.lastActivity = Math.max(group.lastActivity, Number(file.updatedAt || file.createdAt) || 0);
        }
        const assignedUsers = new Set([...groups.values()].map(group => group.userId));
        for (const user of users.values()) if (!assignedUsers.has(user.id)) add('unassigned', user.id, '');
        const systems = new Map();
        for (const group of groups.values()) {
            if (!systems.has(group.appId)) systems.set(group.appId, { appId: group.appId, label: group.appLabel, users: new Map() });
            const system = systems.get(group.appId);
            if (!system.users.has(group.userId)) system.users.set(group.userId, { ...group.user, userId: group.userId, spaces: [] });
            system.users.get(group.userId).spaces.push({ diskSpace: group.diskSpace, fileCount: group.fileCount, size: group.size, lastActivity: group.lastActivity });
        }
        res.json({ systems: [...systems.values()].map(system => ({ appId: system.appId, label: system.label, users: [...system.users.values()] })) });
    });
    admin.get('/storage-contents', wrap((req, res) => {
        const diskSpace = String(req.query.disk_space || ''), userId = String(req.query.user_id || '');
        if (!userId) throw new Error('USER_NOT_FOUND');
        const result = spaces.get(diskSpace).list(userId, req.query.path || '');
        res.json({ ...result, files: result.files.map(file => ({ ...publicFile(file), sourceAppId: inferSourceAppId(file, diskSpace) })) });
    }));
    admin.get('/storage-search', wrap((req, res) => {
        const q = String(req.query.q || '').trim();
        const offset = Number(req.query.offset || 0), limit = Number(req.query.limit || 50);
        if (!q || q.length > 256 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            throw new Error('CONTENT_QUERY_INVALID');
        const needle = q.toLocaleLowerCase('zh-CN'), users = adminUserMap(), results = [];
        for (const { diskSpace, store: drive } of spaces.entries()) {
            for (const folder of drive.adminDirectories()) {
                if (!folder.path || !folder.name?.toLocaleLowerCase('zh-CN').includes(needle)) continue;
                results.push({ ...folder, kind: 'directory', diskSpace, userId: folder.ownerId,
                    user: users.get(folder.ownerId) || { id: folder.ownerId, name: '历史用户' }, appId: 'system' });
            }
            for (const file of drive.adminFiles()) {
                if (!file.name.toLocaleLowerCase('zh-CN').includes(needle)) continue;
                results.push({ ...publicFile(file), userId: file.ownerId, diskSpace,
                    user: users.get(file.ownerId) || { id: file.ownerId, name: '历史用户' }, appId: inferSourceAppId(file, diskSpace) });
            }
        }
        results.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN') || String(a.userId).localeCompare(String(b.userId)) || String(a.diskSpace).localeCompare(String(b.diskSpace)));
        res.json({ items: results.slice(offset, offset + limit), total: results.length, offset, limit });
    }));
    const adminFile = req => {
        const userId = String(req.query.user_id || req.body?.user_id || ''), diskSpace = String(req.query.disk_space || req.body?.disk_space || '');
        const store = spaces.get(diskSpace), file = store.get(userId, req.params.id);
        if (!file) throw new Error('FILE_NOT_FOUND');
        return { userId, diskSpace, store, file };
    };
    const adminFileBackend = file => file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
    admin.get('/files/:id/technical', wrap((req, res) => {
        const { userId, diskSpace, file } = adminFile(req);
        const contentId = file.contentId || file.deletedContentId || '';
        const backend = file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
        const identity = auth.user(userId);
        res.json({ logicalFile: file, owner: identity ? { id: identity.id, name: identity.name || '', username: identity.username || '',
            telegramId: identity.telegramId || '', provider: identity.provider || '' } : { id: userId }, diskSpace,
            storageBackend: backend ? { id: backend.id || '', channelId: backend.channelId || '', baseUrl: backend.baseUrl || '' } : null,
            content: contentId ? contentAdmin.detail(contentId) : null });
    }));
    admin.get('/files/:id/download', wrap(async (req, res) => {
        const { file } = adminFile(req);
        if (file.reviewStatus === 'deleted') throw new Error('FILE_REMOVED_BY_REVIEW');
        const remote = await prepareRemoteResponse(req, res, adminFileBackend(file), file, { inline: true });
        if (remote) await pipeline(remote.source, res);
    }));
    admin.get('/reviews', (req, res) => {
        const users = adminUserMap(), files = [];
        for (const { diskSpace, store } of spaces.entries()) for (const file of store.adminFiles()) files.push({ ...publicFile(file), userId: file.ownerId, user: users.get(file.ownerId) || { id: file.ownerId, name: '历史用户' }, diskSpace, appId: inferSourceAppId(file, diskSpace) });
        files.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
        res.json({ files: files.slice(0, 50) });
    });
    admin.patch('/reviews/:id', wrap(async (req, res) => {
        const userId = String(req.body?.user_id || ''), diskSpace = String(req.body?.disk_space || ''), action = String(req.body?.action || '');
        const store = spaces.get(diskSpace), file = store.get(userId, req.params.id);
        if (!file) throw new Error('FILE_NOT_FOUND');
        if (action === 'block') return res.json(publicFile(store.setReviewStatus(userId, file.id, 'blocked')));
        if (action === 'unblock') return res.json(publicFile(store.setReviewStatus(userId, file.id, 'active')));
        if (action !== 'delete') throw new Error('REVIEW_ACTION_INVALID');
        assertStaticFileWritable({ userId, diskSpace }, file);
        if (file.reviewStatus !== 'deleted') {
            if(!file.contentId) await telegram.remove(adminFileBackend(file), file);
        }
        const contentId=file.contentId, deleted=store.tombstone(userId, file.id);
        if (contentId) await cleanupDeletedContent(contentId);
        res.json(publicFile(deleted));
    }));
    admin.patch('/directories/review', wrap(async (req, res) => {
        const userId = String(req.body?.user_id || ''), diskSpace = String(req.body?.disk_space || '');
        const folderPath = normalizeTelegramDrivePath(req.body?.path || ''), action = String(req.body?.action || '');
        const store = spaces.get(diskSpace), tree = store.getDirectoryTree(userId, folderPath);
        if (!folderPath || !tree) throw new Error('DIRECTORY_NOT_FOUND');
        if (action === 'block' || action === 'unblock') return res.json(store.setDirectoryReviewStatus(userId, folderPath, action === 'block' ? 'blocked' : 'active'));
        if (action !== 'delete') throw new Error('REVIEW_ACTION_INVALID');
        assertStaticDirectoryWritable({ userId, diskSpace }, store, folderPath);
        for (const file of tree.files) {
            if (file.reviewStatus === 'deleted') continue;
            if(!file.contentId) await telegram.remove(adminFileBackend(file), file);
        }
        const contentIds=new Set(tree.files.map(file=>file.contentId).filter(Boolean));
        const deleted=store.tombstoneDirectory(userId, folderPath);
        for (const id of contentIds) await cleanupDeletedContent(id);
        res.json(deleted);
    }));
    admin.use(failure);

    external.post('/auth/token', limiter(), wrap(async (req, res) => {
        const app = await auth.authenticateApp(req.body?.app_id, req.body?.app_secret);
        const backend = await telegram.validate(req.body?.tg_bot_token, req.body?.tg_channel);
        res.json(auth.issueToken(app, backend, { app_secret: req.body.app_secret }));
    }));
    external.use(wrap((req, res, next) => {
        req.diskApp = auth.access(String(req.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
        next();
    }));
    browser.use('/collaborations', wrap((req, res, next) => {
        const user = getIdentity(req);
        if (!user) throw new Error('LOGIN_REQUIRED');
        const selected = partitions.find(user.id, String(req.get('X-Disk-Space') ?? req.query.disk_space ?? ''));
        req.diskUser = user; req.diskPartition = selected;
        req.diskScope = { userId: user.id, diskSpace: selected.scopeKey };
        req.diskStore = spaces.get(selected.scopeKey);
        next();
    }));
    const collaborationView = (entry, viewerId) => {
        const owned = entry.ownerId === String(viewerId);
        const view = collaborations.publicEntry(entry);
        const role = owned ? 'owner' : view.memberRoles?.[viewerId] || 'editor';
        if (!owned) { delete view.invites; delete view.members; delete view.memberRoles; }
        else view.memberDetails = view.members.map(id => {
            const user = auth.user(id);
            return { id, role: view.memberRoles?.[id] || 'editor', name: user?.name || '', username: user?.username || '', telegramId: user?.telegramId || '', provider: user?.provider || '' };
        });
        return { ...view, owned, role };
    };
    browser.get('/collaborations', (req, res) => {
        collaborations.reloadPersistence();
        res.json({ collaborations: collaborations.accessible(req.diskUser.id).map(entry => collaborationView(collaborations.find(entry.id), req.diskUser.id)) });
    });
    browser.get('/collaborations/invitations/:token/preview', wrap((req, res) => {
        const entry = collaborations.byInvite(req.params.token);
        if (!entry) throw new Error('INVITE_NOT_FOUND');
        const storage = spaces.get(entry.diskSpace);
        const target = entry.kind === 'file' ? storage.get(entry.ownerId, entry.fileId) : storage.getDirectoryTree(entry.ownerId, entry.path);
        if (!target || target.reviewStatus === 'deleted') throw new Error('COLLABORATION_TARGET_NOT_FOUND');
        const owner = auth.user(entry.ownerId);
        res.json({ invitation: { id: entry.id, kind: entry.kind, name: target.name, size: Number(target.size) || 0,
            ...(entry.kind === 'directory' ? { fileCount: target.fileCount, folderCount: target.folderCount } : {}),
            ownerName: owner?.name || owner?.username || '网盘用户', owned: entry.ownerId === req.diskUser.id } });
    }));
    browser.post('/collaborations/invitations', wrap((req, res) => {
        const kind = req.body?.kind;
        if (kind !== 'directory' && kind !== 'file') throw new Error('COLLABORATION_TARGET_INVALID');
        const ownerId = req.diskUser.id, diskSpace = req.diskScope.diskSpace;
        let target;
        if (kind === 'directory') {
            const folderPath = normalizeTelegramDrivePath(req.body?.path || '');
            target = req.diskStore.getDirectory(ownerId, folderPath);
            if (!target) throw new Error('DIRECTORY_NOT_FOUND');
            target = { path: folderPath, name: folderPath.split('/').pop() || '根目录' };
        } else {
            target = req.diskStore.get(ownerId, req.body?.fileId);
            if (!target || target.reviewStatus === 'deleted') throw new Error('FILE_NOT_FOUND');
        }
        const result = persistence.atomic(() => {
            if (kind === 'directory') mounts.assertCanEnableDirectory(ownerId, diskSpace, target.path);
            return collaborations.enable({ ownerId, diskSpace, kind, path: kind === 'file' ? target.folderPath || '' : target.path, fileId: kind === 'file' ? target.id : '', name: target.name });
        }, () => { mounts.reloadPersistence(); collaborations.reloadPersistence(); });
        res.status(201).json({ collaboration: collaborationView(collaborations.find(result.collaboration.id), ownerId), url: `${getOrigin(req)}/disk-collab/${encodeURIComponent(result.invite.token)}` });
    }));
    browser.post('/collaborations/join', wrap((req, res) => {
        const entry = collaborations.join(String(req.body?.token || ''), req.diskUser.id);
        res.json({ collaboration: collaborationView(collaborations.find(entry.id), req.diskUser.id) });
    }));
    browser.get('/collaborations/:collaborationId', wrap((req, res) => {
        const entry = collaborations.authorizedFresh(req.params.collaborationId, req.diskUser.id);
        if (!entry) throw new Error('COLLABORATION_NOT_FOUND');
        res.json({ collaboration: collaborationView(entry, req.diskUser.id) });
    }));
    browser.post('/collaborations/:collaborationId/copy', wrap((req, res) => {
        const entry = collaborations.authorizedFresh(req.params.collaborationId, req.diskUser.id);
        if (!entry) throw new Error('COLLABORATION_NOT_FOUND');
        const result = copyGrantedItem({ kind: 'collaboration', grant: entry, ownerId: entry.ownerId, diskSpace: entry.diskSpace,
            selection: req.body?.selection, targetUser: req.diskUser, targetSpace: String(req.body?.diskSpace || ''), destinationPath: req.body?.destinationPath || '' });
        res.status(201).json(result);
    }));
    browser.delete('/collaborations/:collaborationId/invitations/:inviteId', wrap((req, res) => res.json(collaborations.revokeInvite(req.params.collaborationId, req.params.inviteId, req.diskUser.id, req.diskScope.diskSpace))));
    browser.delete('/collaborations/:collaborationId/members/:memberId', wrap((req, res) => res.json(collaborations.kick(req.params.collaborationId, req.params.memberId, req.diskUser.id, req.diskScope.diskSpace))));
    browser.patch('/collaborations/:collaborationId/members/:memberId', wrap((req, res) => res.json(collaborations.setRole(req.params.collaborationId, req.params.memberId, req.body?.role, req.diskUser.id, req.diskScope.diskSpace))));
    browser.delete('/collaborations/:collaborationId', wrap((req, res) => res.json(collaborations.disable(req.params.collaborationId, req.diskUser.id, req.diskScope.diskSpace))));
    browser.post('/collaborations/:collaborationId/leave', wrap((req, res) => res.json(collaborations.leave(req.params.collaborationId, req.diskUser.id))));
    const collaborationContent = express.Router({ mergeParams: true });
    collaborationContent.use(wrap((req, res, next) => {
        const viewerId = req.diskUser.id;
        const entry = collaborations.authorizedFresh(req.params.collaborationId, viewerId);
        if (!entry) throw new Error('COLLABORATION_NOT_FOUND');
        if (entry.role === 'viewer' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) throw new Error('COLLABORATION_READ_ONLY');
        const user = auth.user(entry.ownerId);
        if (!user) throw new Error('COLLABORATION_NOT_FOUND');
        const storage = spaces.get(entry.diskSpace), root = normalizeTelegramDrivePath(entry.path || '');
        const grantTarget = entry.kind === 'file' ? storage.get(entry.ownerId, entry.fileId) : storage.getDirectory(entry.ownerId, root);
        if (!grantTarget || ['blocked', 'deleted'].includes(grantTarget.reviewStatus)) throw new Error('COLLABORATION_TARGET_NOT_FOUND');
        const within = (value, strict = false) => {
            const candidate = normalizeTelegramDrivePath(value || '');
            if ((strict && candidate === root) || (root && candidate !== root && !candidate.startsWith(root + '/'))) throw diskOperationError('COLLABORATION_OUT_OF_SCOPE', strict && candidate===root ? 'ROOT_PROTECTED' : ['GET','HEAD'].includes(req.method) ? 'PATH_OUTSIDE_GRANT' : 'TARGET_OUTSIDE_GRANT');
            return candidate;
        };
        const file = id => {
            const found = storage.get(entry.ownerId, id);
            if (!found || ['blocked', 'deleted'].includes(found.reviewStatus) || (entry.kind === 'file' ? found.id !== entry.fileId : false)) throw diskOperationError('COLLABORATION_OUT_OF_SCOPE','FILE_OUTSIDE_GRANT');
            if (entry.kind === 'directory') within(found.folderPath || '');
            return found;
        };
        const path = req.path, method = req.method;
        if (method === 'GET' && path === '/list' && entry.kind === 'directory') req.query.path = within(req.query.path || root);
        else if (method === 'GET' && path === '/directories' && entry.kind === 'directory') { /* route returns only directories in this grant */ }
        else if (method === 'GET' && (path === '/tree' || path === '/directories/properties') && entry.kind === 'directory') req.query.path = within(req.query.path || root);
        else if ((/^\/files\/[^/]+(?:\/(?:thumbnail|stream|download))?$/.test(path) && ['GET', 'PATCH', 'DELETE'].includes(method)) || (method === 'POST' && /^\/files\/[^/]+\/repair$/.test(path))) {
            const id = decodeURIComponent(path.split('/')[2]); file(id);
            if (method === 'PATCH') {
                if (entry.kind === 'file' && Object.hasOwn(req.body || {}, 'folderPath')) throw diskOperationError('COLLABORATION_OUT_OF_SCOPE','FILE_OUTSIDE_GRANT');
                if (entry.kind === 'directory' && Object.hasOwn(req.body || {}, 'folderPath')) within(req.body.folderPath);
            }
        }
        else if (entry.kind === 'directory' && method === 'POST' && path === '/directories') within(req.body?.path, true);
        else if (entry.kind === 'directory' && method === 'PATCH' && path === '/directories') { within(req.body?.path, true); within(req.body?.destinationPath || req.body?.path); }
        else if (entry.kind === 'directory' && method === 'DELETE' && path === '/directories') within(req.query.path, true);
        else if (entry.kind === 'directory' && method === 'POST' && path === '/uploads') {
            within(req.body?.folderPath || root);
            for (const incoming of req.body?.files || []) { if (incoming.source_path) throw diskOperationError('COLLABORATION_OUT_OF_SCOPE','UPLOAD_SOURCE_PATH'); if (Object.hasOwn(incoming, 'folderPath')) within(incoming.folderPath); }
            req.body.folderPath ||= root;
            req.body.metadata = { ...(req.body.metadata || {}), collaborationId: entry.id };
        }
        else if (entry.kind === 'directory' && method === 'POST' && path === '/content/preflight') {
            req.body.folderPath=within(req.body?.folderPath || root);
            for(const incoming of req.body?.files || []) {
                if(incoming.source_path)throw diskOperationError('COLLABORATION_OUT_OF_SCOPE','UPLOAD_SOURCE_PATH');
                if(Object.hasOwn(incoming,'folderPath'))within(incoming.folderPath);
            }
        }
        else if (entry.kind === 'directory' && method === 'POST' && ['/content/proof','/content/release'].includes(path)) { /* durable tickets remain viewer/grant/target bound */ }
        else if (entry.kind === 'directory' && /^\/uploads\/[^/]+(?:\/files\/\d+(?:\/thumbnail)?|\/phase|\/finish|\/queue|\/failure)?$/.test(path) && ['GET','PUT','POST','DELETE'].includes(method)) {
            const uploadId = path.split('/')[2], job = storage.upload(uploadId);
            if (!job || job.metadata?.collaborationId !== entry.id || !storage.ownsUpload(entry.ownerId, uploadId)) throw diskOperationError('COLLABORATION_OUT_OF_SCOPE','UPLOAD_OUTSIDE_GRANT');
        }
        else if (method === 'GET' && /^\/uploads\/[^/]+\/progress$/.test(path)) {
            const job = operations.findUpload(decodeURIComponent(path.split('/')[2]), { userId: entry.ownerId, diskSpace: entry.diskSpace });
            if (!job || job.collaborationId !== entry.id) throw diskOperationError('COLLABORATION_OUT_OF_SCOPE','UPLOAD_OUTSIDE_GRANT');
        }
        else if (method === 'GET' && (path === '/operations' || /^\/operations\/[^/]+$/.test(path))) { /* response filters collaboration id */ }
        else if (method === 'GET' && path === '/search' && entry.kind === 'directory') { /* result is restricted to this grant below */ }
        else if (method === 'DELETE' && /^\/operations\/[^/]+$/.test(path)) { /* checked by route */ }
        else throw diskOperationError('COLLABORATION_OUT_OF_SCOPE','ROUTE_OUTSIDE_GRANT');
        req.collaboration = entry; req.diskViewerId = viewerId; req.diskUser = user;
        req.diskScope = { userId: entry.ownerId, diskSpace: entry.diskSpace };
        req.diskStore = storage;
        next();
    }));
    function passkeys(router, externalMode) {
        router.post('/passkeys/:kind/options', limiter(), wrap(async (req, res) => {
            if (!externalMode && isMockRequest(req)) throw new Error('LOCAL_USE_OIDC_MOCK');
            const current = externalMode ? null : getIdentity(req);
            const origin = externalMode ? (req.diskApp.passkeyOrigin || getOrigin(req)) : getOrigin(req);
            const binding = externalMode ? req.diskApp.appId : crypto.randomBytes(32).toString('base64url');
            const result = await auth.passkeyOptions({ kind: req.params.kind, username: req.body?.username, existingUserId: current?.id || '', origin, binding });
            if (!externalMode) res.cookie('disk_passkey_flow', binding, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/telegram/drive/passkeys', maxAge: 300000 });
            res.json(result);
        }));
        router.post('/passkeys/verify', limiter(), wrap(async (req, res) => {
            if (!externalMode && isMockRequest(req)) throw new Error('LOCAL_USE_OIDC_MOCK');
            const binding = externalMode ? req.diskApp.appId : (String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('disk_passkey_flow=')) || '').slice('disk_passkey_flow='.length);
            const current = externalMode ? null : getIdentity(req);
            const identity = await auth.passkeyVerify({ flowId: req.body?.flow_id, response: req.body?.response, binding, existingUserId: current?.id || '' });
            if (!externalMode) { res.clearCookie('disk_passkey_flow', { path: '/api/telegram/drive/passkeys', httpOnly: true, secure: true, sameSite: 'lax' }); setIdentity(req, res, identity); }
            res.json({ identity, user_id: identity.id });
        }));
    }
    passkeys(browser, false); passkeys(external, true);

    browser.use(wrap((req, res, next) => {
        const user = getIdentity(req);
        if (!user) throw new Error('LOGIN_REQUIRED');
        req.diskUser = user; req.diskScope = { userId: user.id, diskSpace: '' }; req.diskStore = defaultStore;
        spaces.track('system', user.id, '');
        const selectedSpace = String(req.get('X-Disk-Space') ?? req.query.disk_space ?? '');
        // Completed partition-deletion jobs must remain pollable after their
        // source partition becomes DELETED. No data route gets this exception.
        const selected = (/^\/operations(?:\/[^/]+)?$/.test(req.path)
            || (req.method === 'GET' && req.path === '/spaces')
            || (req.method === 'POST' && /^\/spaces\/[^/]+\/recover-delete$/.test(req.path)))
            ? partitions.findOperationScope(user.id, selectedSpace)
            : partitions.find(user.id, selectedSpace);
        req.diskPartition = selected;
        req.diskScope.diskSpace = selected.scopeKey;
        req.diskStore = spaces.get(selected.scopeKey);
        spaces.track('system', user.id, selected.scopeKey);
        next();
    }));
    browser.get('/spaces', (req, res) => res.json({ spaces: partitions.list(req.diskUser.id) }));
    browser.post('/spaces', wrap((req, res) => {
        const partition = partitions.create(req.diskUser.id, req.body?.name);
        res.status(201).json({ diskSpace: partition.scopeKey, partition });
    }));
    browser.patch('/spaces/:id', wrap((req, res) => {
        const partition = Object.hasOwn(req.body || {}, 'name')
            ? partitions.rename(req.diskUser.id, req.params.id, req.body.name)
            : partitions.updateSettings(req.diskUser.id, req.params.id, req.body?.settings);
        res.json({ partition });
    }));
    browser.get('/spaces/:id/clone-preview', wrap((req, res) => {
        const ownerId = req.diskUser.id, partition = partitions.find(ownerId, req.params.id);
        const source = spaces.get(partition.scopeKey);
        source.reloadPersistence();
        const files = source.adminFiles().filter(file => file.ownerId === ownerId);
        const directories = source.adminDirectories().filter(folder => folder.ownerId === ownerId);
        const denied = directories.filter(folder => folder.reviewStatus && folder.reviewStatus !== 'active').map(folder => folder.path);
        const allowed = folderPath => !denied.some(parent => folderPath === parent || folderPath.startsWith(parent + '/'));
        const impact = {
            files: files.filter(file => (!file.reviewStatus || file.reviewStatus === 'active') && allowed(file.folderPath || '')).length,
            directories: directories.filter(folder => (!folder.reviewStatus || folder.reviewStatus === 'active') && allowed(folder.path)).length,
            skippedFiles: files.filter(file => (file.reviewStatus && file.reviewStatus !== 'active') || !allowed(file.folderPath || '')).length,
            skippedDirectories: directories.filter(folder => (folder.reviewStatus && folder.reviewStatus !== 'active') || !allowed(folder.path)).length,
            skippedMounts: persistence.load('collaboration_mounts').filter(item => item.ownerId === ownerId && item.diskSpace === partition.scopeKey).length
        };
        res.json({ partition: partitions.publicItem(partition), impact });
    }));
    browser.post('/spaces/:id/clone', wrap((req, res) => {
        const ownerId = req.diskUser.id, sourcePartition = partitions.find(ownerId, req.params.id);
        const displayName = validatePartitionName(req.body?.name || sourcePartition.displayName + ' 副本');
        const source = spaces.get(sourcePartition.scopeKey), targetScope = 'p-' + crypto.randomUUID();
        const target = spaces.get(targetScope);
        const operation = operations.create({ userId: ownerId, diskSpace: sourcePartition.scopeKey },
            'space-clone', `正在复刻分区：${sourcePartition.displayName}`);
        res.status(202).json({ operation_id: operation.operation_id });
        // Respond before the large snapshot transaction starts. The target
        // partition and every Content reference still commit atomically.
        setImmediate(() => operations.run(operation.operation_id, async (update, control) => {
            update({ phase: 'preflight', message: '正在验证待复刻的目录和正文引用', percent: 5 });
            await new Promise(resolve => setImmediate(resolve));
            control.throwIfCancelled();
            const leases = [];
            let partition;
            try {
            update({ phase: 'commit', message: '正在原子写入新分区及内容引用', percent: 20 });
            // Partition visibility, new logical records and Content refs commit
            // together. A crash or failure leaves no half-cloned partition.
            const result = persistence.atomic(() => {
                partitions.find(ownerId, sourcePartition.id);
                source.reloadPersistence();
                const existingFiles = source.adminFiles().filter(file => file.ownerId === ownerId);
                const existingDirectories = source.adminDirectories().filter(folder => folder.ownerId === ownerId);
                if (existingFiles.length > 10000 || existingDirectories.length > 10000) throw new Error('DISK_BATCH_LIMIT');
                const deniedFolders = existingDirectories.filter(folder => folder.reviewStatus && folder.reviewStatus !== 'active').map(folder => folder.path);
                const allowedFolders = existingDirectories.filter(folder => (!folder.reviewStatus || folder.reviewStatus === 'active')
                    && !deniedFolders.some(parent => folder.path === parent || folder.path.startsWith(parent + '/')));
                const allowedFiles = existingFiles.filter(file => (!file.reviewStatus || file.reviewStatus === 'active')
                    && !deniedFolders.some(folder => file.folderPath === folder || file.folderPath.startsWith(folder + '/')));
                const skippedMounts = persistence.load('collaboration_mounts').filter(item => item.ownerId === ownerId
                    && item.diskSpace === sourcePartition.scopeKey).length;
                partition = partitions.createWithin(ownerId, displayName, targetScope);
                for (const folder of allowedFolders.sort((a, b) => a.path.length - b.path.length)) {
                    target.createDirectory(ownerId, folder.path, maxDepth(), folder.sourceAppId || 'system');
                }
                const cloned = [];
                for (const original of allowedFiles) {
                    if (!original.contentId) source.update(ownerId, original.id, {});
                    const file = source.get(ownerId, original.id);
                    if (!file?.contentId) throw new Error('CONTENT_COPY_SOURCE_INVALID');
                    const physical = content.resolve(file.contentId)?.physical;
                    if (!physical) throw new Error('CONTENT_NOT_AVAILABLE');
                    const backend = physical.backendId ? auth.backend(physical.backendId) : getDefaultBackend(physical.channelId);
                    if (!backend) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
                    const lease = content.lease(file.contentId, ownerId, 'space-clone', 'reuse');
                    leases.push(lease);
                    const copy = target.putCopiedObject(req.diskUser, file.folderPath || '', file.name,
                        { ...file, ...physical, contentId: file.contentId, contentLease: lease },
                        physical.parts || [], backend, maxDepth());
                    cloned.push(copy.id);
                }
                return { files: cloned.length, directories: allowedFolders.length,
                    skippedFiles: existingFiles.length - allowedFiles.length,
                    skippedDirectories: existingDirectories.length - allowedFolders.length, skippedMounts };
            }, () => { source.reloadPersistence(); target.reloadPersistence(); partitions.reload(); });
            let usageTrackingPending = false;
            try { spaces.track('system', ownerId, targetScope); }
            catch (error) { usageTrackingPending = true; console.warn('[disk-partition] 复刻后的使用记录待补写', error?.message || String(error)); }
            update({ phase: 'finalizing', message: '新分区已写入，正在完成任务记录', percent: 95 });
            return { partition, ...result, usageTrackingPending };
            } finally { for (const lease of leases) {
                try { content.releaseLease(lease); }
                catch (error) { console.warn('[disk-partition] 内容租约释放待重试', error?.message || String(error)); }
            } }
        }));
    }));
    const partitionImpact = (ownerId, partition, exceptOperationId = '') => {
        const diskSpace = partition.scopeKey, drive = spaces.get(diskSpace);
        drive.reloadPersistence();
        const files = drive.adminFiles().filter(file => file.ownerId === ownerId);
        const directories = drive.adminDirectories().filter(folder => folder.ownerId === ownerId);
        const now = Date.now();
        const activeShares = persistence.load('shares').filter(item => item.ownerId === ownerId
            && item.diskSpace === diskSpace && !item.stoppedAt).length;
        const activeStaticLinks = persistence.load('static_resources').filter(item => item.ownerId === ownerId
            && item.diskSpace === diskSpace && !item.revokedAt && (!item.expiresAt || item.expiresAt > now)).length;
        const activeCollaborations = persistence.load('collaborations').filter(item => item.ownerId === ownerId
            && item.diskSpace === diskSpace && item.active !== false).length;
        const activeTasks = persistence.load('operations').filter(item => item.operation_id !== exceptOperationId && item.userId === ownerId
            && item.diskSpace === diskSpace && !['completed', 'failed', 'cancelled'].includes(item.status)).length;
        const activeLeases = persistence.activeContentLeases(diskSpace, ownerId);
        const s3Credentials = userS3Credentials.list().filter(item => item.userId === ownerId && item.enabled
            && item.bucketMappings?.some(mapping => mapping.diskSpace === diskSpace)).length;
        return { files: files.length, directories: directories.length,
            mounts: mounts.countScope(ownerId, diskSpace), activeShares, activeStaticLinks,
            activeCollaborations, activeTasks, activeLeases, s3Credentials };
    };
    browser.get('/spaces/:id/delete-preview', wrap((req, res) => {
        const partition = partitions.findAny(req.diskUser.id, req.params.id);
        if (partition.isDefault) throw new Error('DISK_DEFAULT_SPACE_DELETE_FORBIDDEN');
        res.json({ partition: partitions.publicItem(partition), impact: partitionImpact(req.diskUser.id, partition) });
    }));
    browser.post('/spaces/:id/recover-delete', wrap((req, res) => {
        const partition = partitions.findAny(req.diskUser.id, req.params.id);
        if (partition.state !== 'DELETING') throw new Error('DISK_SPACE_RECOVERY_NOT_NEEDED');
        const jobs = persistence.load('operations').filter(item => item.userId === req.diskUser.id
            && item.diskSpace === partition.scopeKey && item.type === 'space-delete')
            .sort((a, b) => b.createdAt - a.createdAt);
        if (!jobs.length || !['failed', 'cancelled'].includes(jobs[0].status)
            || jobs.some(item => !['completed', 'failed', 'cancelled'].includes(item.status)))
            throw new Error('DISK_SPACE_RECOVERY_BUSY');
        // A committed removal marks the partition DELETED in the same SQLite
        // transaction. DELETING therefore still has intact native records.
        const recovered = partitions.recoverDeleting(req.diskUser.id, partition.id);
        res.json({ partition: recovered, interruptedOperationId: jobs[0].operation_id });
    }));
    browser.delete('/spaces/:id', wrap((req, res) => {
        if (req.body?.confirm !== true) throw new Error('DISK_SPACE_DELETE_CONFIRM_REQUIRED');
        const ownerId = req.diskUser.id, partition = partitions.findAny(ownerId, req.params.id);
        if (partition.isDefault) throw new Error('DISK_DEFAULT_SPACE_DELETE_FORBIDDEN');
        const diskSpace = partition.scopeKey, drive = spaces.get(diskSpace);
        const impact = partitionImpact(ownerId, partition);
        if (trash.list(ownerId,diskSpace).length) throw new Error('DISK_SPACE_TRASH_NOT_EMPTY');
        if (impact.activeCollaborations) throw new Error('DISK_SPACE_COLLABORATION_ACTIVE');
        if (impact.activeTasks || impact.activeLeases) throw new Error('DISK_SPACE_BUSY');
        drive.assertDirectoryWritable(ownerId, '');
        const operation = operations.create({ userId: ownerId, diskSpace }, 'space-delete',
            `正在删除分区：${partition.displayName}`);
        res.status(202).json({ operation_id: operation.operation_id });
        setImmediate(() => operations.run(operation.operation_id, async (update, control) => {
            update({ phase: 'preflight', message: '正在复核分区影响与活动任务', percent: 5 });
            await new Promise(resolve => setImmediate(resolve));
            control.throwIfCancelled();
            const current = partitionImpact(ownerId, partition, operation.operation_id);
            if (trash.list(ownerId,diskSpace).length) throw new Error('DISK_SPACE_TRASH_NOT_EMPTY');
            if (current.activeCollaborations) throw new Error('DISK_SPACE_COLLABORATION_ACTIVE');
            if (current.activeTasks || current.activeLeases) throw new Error('DISK_SPACE_BUSY');
            drive.assertDirectoryWritable(ownerId, '');
            partitions.markDeleting(ownerId, partition.id);
            try {
                update({ phase: 'commit', message: '正在原子移除本分区的原生记录与挂载指针', percent: 20 });
                const removed = persistence.atomic(() => {
                    if (trash.list(ownerId,diskSpace).length) throw new Error('DISK_SPACE_TRASH_NOT_EMPTY');
                    const latest = partitionImpact(ownerId, partition, operation.operation_id);
                    if (latest.activeCollaborations || latest.activeTasks || latest.activeLeases) throw new Error('DISK_SPACE_BUSY');
                    drive.assertDirectoryWritable(ownerId, '');
                    const state = ['files', 'directories', 'shares', 'static_resources'].map(table =>
                        ({ table, scope: table === 'files' || table === 'directories' ? diskSpace : '',
                            snapshot: persistence.loadWithRevision(table, table === 'files' || table === 'directories' ? diskSpace : '') }));
                    const match = item => item.ownerId === ownerId && item.diskSpace === diskSpace;
                    const changes = state.map(({ table, scope, snapshot }) => ({ table, scope,
                        items: snapshot.items.filter(item => table === 'files' || table === 'directories' ? item.ownerId !== ownerId : !match(item)),
                        keyOf: table === 'directories' ? item => `${item.ownerId}:${item.path}` : item => item.id,
                        base: snapshot.revisions }));
                    persistence.replaceMany(changes);
                    const removedMounts = mounts.removePartition(ownerId, diskSpace).removedMounts;
                    const retired = partitions.retireWithin(ownerId, partition.id);
                    return { partition: retired, removedMounts };
                }, () => { drive.reloadPersistence(); shares.reloadPersistence(); mounts.reloadPersistence();
                    staticResources.list({ userId: ownerId, diskSpace }); partitions.reload(); });
                drive.reloadPersistence(); shares.reloadPersistence(); mounts.reloadPersistence();
                staticResources.list({ userId: ownerId, diskSpace }); partitions.reload();
                // A stale JSON credential cannot access a retired partition.
                // Retire it after SQLite commits so a failed transaction does
                // not disable S3 for an otherwise intact partition.
                let revokedS3Credentials = 0, credentialCleanupPending = false;
                try { revokedS3Credentials = userS3Credentials.retireUserSpace(ownerId, diskSpace); }
                catch (error) { credentialCleanupPending = true; console.warn('[disk-partition] S3 凭证清理待重试', error?.message || String(error)); }
                update({ phase: 'finalizing', message: '分区已删除，正在完成任务记录', percent: 95 });
                return { ...removed, revokedS3Credentials, credentialCleanupPending, impact };
            } catch (error) {
                partitions.markDeleteFailed(ownerId, partition.id);
                throw error;
            }
        }));
    }));
    browser.post('/spaces/transfer', wrap((req, res) => {
        const sourceSpace = req.diskScope.diskSpace,
            targetSpace = partitions.find(req.diskUser.id, req.body?.targetSpace ?? '').scopeKey,
            mode = req.body?.mode;
        if (!['copy', 'move'].includes(mode) || (targetSpace === sourceSpace && mode !== 'copy')) throw new Error('DISK_SPACE_TRANSFER_INVALID');
        const selection = req.body?.items;
        if (!Array.isArray(selection) || !selection.length || selection.length > 100) throw new Error('DISK_SELECTION_INVALID');
        const source = req.diskStore, target = spaces.get(targetSpace), ownerId = req.diskUser.id;
        const root = normalizeTelegramDrivePath(req.body?.destinationPath || '');
        if (!target.getDirectory(ownerId, root)) throw new Error('DIRECTORY_NOT_FOUND');
        const directories = new Map(), files = new Map(), roots = [];
        for (const selected of selection) {
            if (selected?.kind === 'directory') {
                const folder = normalizeTelegramDrivePath(selected.path || '');
                if (targetSpace === sourceSpace && (root === folder || root.startsWith(folder + '/'))) throw new Error('DISK_SPACE_TRANSFER_INVALID');
                if (!folder || roots.some(entry => entry.kind === 'directory' && (folder === entry.path || folder.startsWith(entry.path + '/')))) continue;
                const tree = source.getDirectoryTree(ownerId, folder);
                if (!tree || tree.directories.some(entry => ['blocked', 'deleted'].includes(entry.reviewStatus))) throw new Error('DIRECTORY_NOT_FOUND');
                if (mode === 'move' && (collaborations.protectDirectory(ownerId, sourceSpace, folder)
                    || staticResources.protectDirectory(req.diskScope, source, folder))) throw new Error('STATIC_OR_COLLABORATION_ACTIVE');
                roots.push({ kind: 'directory', path: folder });
                for (const entry of tree.directories) directories.set(entry.path, entry);
                for (const entry of tree.files) files.set(entry.id, entry);
            } else if (selected?.kind === 'file') {
                const file = source.get(ownerId, selected.id);
                if (!file || ['blocked', 'deleted'].includes(file.reviewStatus)) throw new Error('FILE_NOT_FOUND');
                if (mode === 'move' && (collaborations.protectFile(ownerId, sourceSpace, file.id)
                    || staticResources.protectFile(req.diskScope, file))) throw new Error('STATIC_OR_COLLABORATION_ACTIVE');
                roots.push({ kind: 'file', id: file.id }); files.set(file.id, file);
            } else throw new Error('DISK_SELECTION_INVALID');
        }
        if (directories.size > 10000 || files.size > 10000) throw new Error('DISK_BATCH_LIMIT');
        const top = [...directories.keys()].filter(folder => ![...directories.keys()].some(parent => parent !== folder && folder.startsWith(parent + '/')));
        const destination = oldPath => {
            const matched = top.find(folder => oldPath === folder || oldPath.startsWith(folder + '/'));
            return matched ? [root, oldPath.slice(matched.lastIndexOf('/') + 1)].filter(Boolean).join('/') : root;
        };
        const sourceMounts = mounts.list(ownerId, sourceSpace).filter(mount => top.some(folder => mount.parentPath === folder || mount.parentPath.startsWith(folder + '/')));
        const leases = new Map();
        try {
            // Older JSON-era files have a physical Telegram anchor but no
            // shared Content reference. Promote that exact anchor in place;
            // never resend or guess an unverified binary hash.
            if ([...files.values()].some(file => !file.contentId)) {
                persistence.atomic(() => {
                    for (const file of files.values()) if (!file.contentId) source.update(ownerId, file.id, {});
                }, () => source.reloadPersistence());
                for (const id of files.keys()) files.set(id, source.get(ownerId, id));
            }
            for (const file of files.values()) {
                if (!file.contentId) throw new Error('CONTENT_COPY_SOURCE_INVALID');
                leases.set(file.id, content.lease(file.contentId, ownerId, 'space-transfer', 'reuse'));
            }
            const copied = persistence.atomic(() => {
                for (const folder of [...directories.keys()].sort((a, b) => a.length - b.length)) target.createDirectory(ownerId, destination(folder), maxDepth(), 'system');
                const result = [];
                for (const file of files.values()) {
                    const physical = content.resolve(file.contentId)?.physical;
                    if (!physical) throw new Error('CONTENT_NOT_AVAILABLE');
                    const backend = physical.backendId ? auth.backend(physical.backendId) : getDefaultBackend(physical.channelId);
                    if (!backend) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
                    const copy = target.putCopiedObject(req.diskUser, destination(file.folderPath), file.name,
                        { ...file, ...physical, contentId: file.contentId, contentLease: leases.get(file.id) }, physical.parts, backend, maxDepth());
                    result.push({ id: copy.id, name: copy.name, folderPath: copy.folderPath });
                }
                for (const mount of sourceMounts) {
                    const parentPath = destination(mount.parentPath);
                    if (mode === 'copy') mounts.create({ ownerId, diskSpace: targetSpace, parentPath, name: mount.name,
                        collaborationId: mount.collaborationId, drive: target });
                    else mounts.moveAcrossPartition(mount.id, ownerId, sourceSpace, targetSpace, parentPath, target);
                }
                if (mode === 'move') {
                    for (const folder of top) source.removeDirectory(ownerId, folder, true);
                    for (const entry of roots.filter(item => item.kind === 'file')) if (source.get(ownerId, entry.id)) source.remove(ownerId, entry.id);
                }
                return result;
            }, () => { source.reloadPersistence(); target.reloadPersistence(); mounts.reloadPersistence(); });
            res.json({ copied, moved: mode === 'move', targetSpace, destination: root });
        } finally { for (const lease of leases.values()) content.releaseLease(lease); }
    }));
    browser.post('/cross-scope/copy', wrap((req, res) => {
        const result = copyAcrossNamespaces(req.diskUser, req.body, req.diskPartition.id);
        res.status(201).json(result);
    }));
    browser.get('/mounts', wrap((req, res) => res.json({ mounts: mounts.list(req.diskUser.id, req.diskScope.diskSpace,
        Object.hasOwn(req.query, 'parentPath') ? String(req.query.parentPath) : null) })));
    browser.post('/mounts', wrap((req, res) => {
        const created = persistence.atomic(() => mounts.create({ ownerId: req.diskUser.id,
            diskSpace: req.diskScope.diskSpace, parentPath: req.body?.parentPath || '', name: req.body?.name,
            collaborationId: req.body?.collaborationId, drive: req.diskStore }),
        () => { mounts.reloadPersistence(); req.diskStore.reloadPersistence(); });
        res.status(201).json({ mount: created });
    }));
    browser.get('/mounts/:id/resolve', wrap((req, res) => {
        const { mount, grant } = mounts.resolve(req.params.id, req.diskUser.id, req.diskScope.diskSpace);
        res.json({ mount, collaboration: collaborationView(grant, req.diskUser.id) });
    }));
    browser.patch('/mounts/:id', wrap((req, res) => {
        const hasName = Object.hasOwn(req.body || {}, 'name');
        const hasDestination = Object.hasOwn(req.body || {}, 'parentPath') || Object.hasOwn(req.body || {}, 'targetSpace');
        if (hasName === hasDestination) throw new Error('MOUNT_UPDATE_INVALID');
        const targetPartition = hasDestination ? partitions.find(req.diskUser.id, req.body?.targetSpace ?? req.diskPartition.id) : req.diskPartition;
        const targetDrive = spaces.get(targetPartition.scopeKey);
        const updated = persistence.atomic(() => hasName
            ? mounts.rename(req.params.id, req.diskUser.id, req.diskScope.diskSpace, req.body.name, req.diskStore)
            : mounts.moveAcrossPartition(req.params.id, req.diskUser.id, req.diskScope.diskSpace,
                targetPartition.scopeKey, req.body.parentPath || '', targetDrive),
        () => { mounts.reloadPersistence(); req.diskStore.reloadPersistence(); targetDrive.reloadPersistence(); });
        res.json({ mount: updated });
    }));
    browser.delete('/mounts/:id', wrap((req, res) => {
        const removed = persistence.atomic(() => mounts.remove(req.params.id, req.diskUser.id, req.diskScope.diskSpace),
            () => mounts.reloadPersistence());
        res.json(removed);
    }));
    browser.get('/spaces/s3', (req, res) => res.json({ credential: userS3Credentials.userSpace(req.diskUser.id, req.diskScope.diskSpace), endpoint: getOrigin(req).replace(/\/$/, '') + '/S3API', region: 'us-east-1' }));
    browser.post('/spaces/s3', wrap((req, res) => res.status(201).json({ credential: userS3Credentials.enableUserSpace(req.diskUser.id, req.diskScope.diskSpace), endpoint: getOrigin(req).replace(/\/$/, '') + '/S3API', region: 'us-east-1' })));
    browser.post('/spaces/s3/rotate', wrap((req, res) => res.json({ credential: userS3Credentials.rotateUserSpace(req.diskUser.id, req.diskScope.diskSpace), endpoint: getOrigin(req).replace(/\/$/, '') + '/S3API', region: 'us-east-1' })));
    browser.delete('/spaces/s3', wrap((req, res) => res.json({ credential: userS3Credentials.disableUserSpace(req.diskUser.id, req.diskScope.diskSpace) })));
    browser.get('/static-resources', (req, res) => res.json({ links: staticResources.list(req.diskScope) }));
    browser.post('/static-resources', wrap((req, res) => res.status(201).json({ link: staticResources.create(req.diskScope, req.diskStore, req.body || {}) })));
    browser.post('/static-resources/settings', wrap((req, res) => res.status(201).json({ link: staticResources.configureTarget(req.diskScope, req.diskStore, req.body || {}) })));
    browser.post('/static-resources/stop', wrap((req, res) => res.json(staticResources.stopTarget(req.diskScope, req.diskStore, req.body?.item))));
    browser.delete('/static-resources/:id', wrap((req, res) => res.json({ link: staticResources.revoke(req.diskScope, req.params.id) })));
    browser.patch('/static-resources/:id/cache', wrap((req, res) => res.json({ link: staticResources.updateCache(req.diskScope, req.params.id, req.body || {}) })));
    external.use(wrap((req, res, next) => {
        const userId = req.get('X-Disk-User-Id') || req.query.user_id || req.body?.user_id;
        const telegramId = req.query.tg_user_id || req.body?.tg_user_id;
        const user = userId ? auth.user(userId) : (telegramId ? auth.fromTelegram({ id: telegramId }) : null);
        if (!user) throw new Error('USER_NOT_FOUND');
        if (telegramId) defaultStore.migrateOwner(String(telegramId), user.id);
        const partition = partitions.resolveExternal(user.id,
            req.get('X-Disk-Space') ?? req.query.disk_space ?? req.body?.disk_space ?? '', req.diskApp.appId,
            { allowCreate: req.method === 'POST' && (req.path === '/uploads' || req.path === '/directories') });
        const diskSpace = partition.scopeKey;
        req.diskPartition = partition;
        req.diskUser = user; req.diskScope = { userId: user.id, diskSpace }; req.diskStore = spaces.get(diskSpace);
        spaces.track(req.diskApp.appId, user.id, diskSpace);
        next();
    }));
    let coreUpload;
    browser.get('/trash',wrap((req,res)=>res.json({items:trash.list(req.diskUser.id,req.diskScope.diskSpace)})));
    browser.get('/trash/:id',wrap((req,res)=>res.json(trash.contents(req.diskUser.id,req.diskScope.diskSpace,req.params.id,String(req.query.path||'')))));
    browser.post('/trash/:id/restore',wrap((req,res)=>res.json({restored:trash.restore(req.diskUser.id,req.diskScope.diskSpace,req.params.id)})));
    browser.delete('/trash/:id',wrap(async(req,res)=>{
        if(req.query.permanent!=='true')throw new Error('TRASH_PURGE_CONFIRM_REQUIRED');
        const ids=trash.purge(req.diskUser.id,req.diskScope.diskSpace,req.params.id);
        const cleanups=[];for(const id of ids)cleanups.push(await cleanupDeletedContent(id));
        const pending=cleanups.some(item=>item?.status==='pending');
        res.json({ok:true,remoteCleanup:{status:pending?'pending':'completed'},...(pending?{warnings:['TELEGRAM_CONTENT_CLEANUP_PENDING']}:{})});
    }));
    function contents(router) {
        const scope = req => ({ ...req.diskScope, deviceId: /^[a-zA-Z0-9_-]{8,120}$/.test(req.get('X-Disk-Device-Id') || '') ? req.get('X-Disk-Device-Id') : '' });
        const owner = req => req.diskUser.id;
        const uploadJob = req => {
            const id = req.params.uploadId;
            if (store(req).ownsUpload(owner(req), id)) {
                const job = store(req).upload(id);
                if (job.pipelineFailure) throw job.pipelineFailure;
                if (job.pipelineError) throw new Error(job.pipelineError);
                return job;
            }
            const previous = operations.findUpload(id, scope(req));
            if (previous?.errorCode) {
                const error = new Error(previous.errorCode);
                error.errorDetails = previous.errorDetails;
                throw error;
            }
            if (previous?.status === 'cancelled' || previous?.cancelRequested) throw new Error('OPERATION_CANCELLED');
            throw new Error('UPLOAD_NOT_FOUND');
        };
        const store = req => req.diskStore;
        const backend = req => req.diskApp ? req.diskApp.storage : getDefaultBackend();
        const fileBackend = (req, file) => file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
        const getFile = req => { const file = store(req).get(owner(req), req.params.id); if (!file) throw new Error('FILE_NOT_FOUND'); return file; };
        const assertCurrentCollaboration = req => {
            if(!req.collaboration)return;
            const current=collaborations.authorizedFresh(req.collaboration.id,req.diskViewerId);
            if(!current || req.collaboration.role !== 'viewer' && current.role === 'viewer' || req.collaboration.grantVersion!==undefined && String(current.grantVersion)!==String(req.collaboration.grantVersion))throw new Error('COLLABORATION_NOT_FOUND');
        };
        const requireEntity = file => { if (file.reviewStatus === 'deleted') throw new Error('FILE_REMOVED_BY_REVIEW'); return file; };
        const jobResponse = (req, res, type, message, work, { immediateResult = false } = {}) => {
            const job = operations.create(scope(req), type, message);
            const relatedFile = req.params?.id ? store(req).get(owner(req), req.params.id) : null;
            const relatedPath = relatedFile?.folderPath ?? req.body?.path ?? req.query?.path ?? '';
            if (req.diskMetadataTiming) req.diskMetadataTiming.operationId = job.operation_id;
            operations.update(job.operation_id, { folderPath: normalizeTelegramDrivePath(relatedPath), ...(req.collaboration ? { collaborationId: req.collaboration.id } : {}) }, true);
            operations.run(job.operation_id, (update, control) => {
                if (mutations.has(JSON.stringify([req.diskScope.userId, req.diskScope.diskSpace])))
                    update({ phase: 'index-queue', message: '正在等待当前网盘中的修改操作完成' });
                return mutate(req, async () => {
                    control.throwIfCancelled();
                    const result = await work(update, control);
                    control.throwIfCancelled();
                    return result;
                }, { operationId: job.operation_id, requestId: req.diskMetadataTiming?.requestId || '', type,
                    userId: owner(req), diskSpace: req.diskScope.diskSpace || '', folderPath: normalizeTelegramDrivePath(relatedPath) });
            });
            const respond = () => {
                if (res.destroyed) return;
                const completed = immediateResult && operations.get(job.operation_id, scope(req));
                res.status(202).json({ operation_id: job.operation_id,
                    ...(completed?.status === 'completed' ? { status: 'completed', result: completed.result } : {}) });
            };
            // Give local mkdir work one event-loop turn to finish. A queued
            // mutation still returns 202 immediately and retains job polling.
            if (immediateResult) setImmediate(respond); else respond();
        };
        router.get('/users/me', (req, res) => res.json({ identity: req.diskUser, user_id: owner(req) }));
        router.get('/shares', (req, res) => res.json({ shares: shares.list(scope(req)) }));
        router.post('/shares', wrap((req, res) => res.status(201).json(shares.create(scope(req), store(req), req.body?.items))));
        router.delete('/shares/:id', wrap((req, res) => res.json(shares.stop(scope(req), req.params.id))));
        router.get('/operations', (req, res) => res.json({ operations: operations.list(scope(req), String(req.query.ids || '').split(',').slice(0, 100)).filter(job => !req.collaboration || job.collaborationId === req.collaboration.id) }));
        router.get('/operations/:id', wrap((req, res) => {
            const job = operations.get(req.params.id, scope(req));
            if (!job || (req.collaboration && job.collaborationId !== req.collaboration.id)) throw new Error('OPERATION_NOT_FOUND');
            res.json(job);
        }));
        router.delete('/operations/:id', wrap(async (req, res) => {
            if (req.collaboration && operations.get(req.params.id, scope(req))?.collaborationId !== req.collaboration.id) throw new Error('OPERATION_NOT_FOUND');
            const job = await operations.cancel(req.params.id, scope(req));
            if (!job) throw new Error('OPERATION_NOT_FOUND');
            res.json(job);
        }));
        router.get('/list', wrap((req, res) => {
            const result = store(req).list(owner(req), req.query.path || '');
            res.json({ ...result, user_id: owner(req), folders: result.folders.map(folder => ({ ...folder, collaborationId: collaborations.ownedTarget(owner(req), req.diskScope.diskSpace, 'directory', folder.path)?.id || '' })), files: result.files.map(file => ({ ...publicFile(file), collaborationId: collaborations.ownedTarget(owner(req), req.diskScope.diskSpace, 'file', file.id)?.id || '' })),
                ...(router === browser && !req.collaboration ? { mounts: mounts.list(owner(req), req.diskScope.diskSpace, result.path || '') } : {}) });
        }));
        router.get('/search', wrap((req, res) => {
            const root = req.collaboration?.path || '';
            const result = store(req).search(owner(req), req.query.q || '', 500, root);
            const inScope = value => !req.collaboration || !root || value === root || value.startsWith(root + '/');
            const visible = item => !req.collaboration || !['blocked', 'deleted'].includes(item.reviewStatus);
            const folders = result.folders.filter(folder => inScope(folder.path) && visible(folder));
            const files = result.files.filter(file => inScope(file.folderPath || '') && visible(file));
            const mounted = router === browser && !req.collaboration && req.query.include_mounts === '1'
                ? mounts.searchMounted(owner(req), req.diskScope.diskSpace, req.query.q || '', grant => {
                    try {
                        const source = spaces.get(partitions.find(grant.ownerId, grant.diskSpace).scopeKey);
                        source.reloadPersistence();
                        return source;
                    } catch (_) { return null; }
                }) : { results: [], truncated: false, searchedGrants: 0 };
            res.json({ query: String(req.query.q || ''), folders: folders.map(folder => ({ ...folder, collaborationId: collaborations.ownedTarget(owner(req), req.diskScope.diskSpace, 'directory', folder.path)?.id || '' })), files: files.map(file => ({ ...publicFile(file), collaborationId: collaborations.ownedTarget(owner(req), req.diskScope.diskSpace, 'file', file.id)?.id || '' })), mounted: mounted.results, mountedTruncated: mounted.truncated,
                summary: { folderCount: folders.length, fileCount: files.length, mountedCount: mounted.results.length } });
        }));
        router.get('/directories', (req, res) => {
            const root = req.collaboration?.path;
            const directories = store(req).listDirectories(owner(req)).filter(folder => root === undefined || !root || folder.path === root || folder.path.startsWith(root + '/'));
            res.json({ directories });
        });
        router.get('/directories/properties', wrap((req, res) => {
            const folder = store(req).getDirectory(owner(req), req.query.path || '');
            if (!folder) throw new Error('DIRECTORY_NOT_FOUND');
            res.json(folder);
        }));
        router.get('/tree', wrap((req, res) => {
            const tree = store(req).getDirectoryTree(owner(req), req.query.path || '');
            if (!tree) throw new Error('DIRECTORY_NOT_FOUND');
            res.json({ files: tree.files.map(publicFile), directories: tree.directories });
        }));
        router.post('/directories', wrap((req, res) => {
            jobResponse(req, res, 'mkdir', '正在创建目录', async update => {
                update({ phase: 'index-write', message: '正在逐级创建虚拟目录并保存索引' });
                return store(req).createDirectory(owner(req), req.body?.path || '', maxDepth(), req.diskApp?.appId || 'system');
            }, { immediateResult: true });
        }));
        router.patch('/directories', wrap((req, res) => {
            assertStaticDirectoryWritable(scope(req), store(req), req.body?.path);
            jobResponse(req, res, 'move-directory', '正在修改目录', async update => {
                assertStaticDirectoryWritable(scope(req), store(req), req.body?.path);
                update({ phase: 'index-write', message: '正在校验目录树并更新索引' });
                const drive = store(req);
                const result = persistence.atomic(() => {
                    const moved = Object.hasOwn(req.body || {}, 'destinationPath')
                        ? drive.moveDirectory(owner(req), req.body.path, req.body.destinationPath, maxDepth(), req.body.name)
                        : drive.renameDirectory(owner(req), req.body.path, req.body.name, maxDepth());
                    const oldPath = normalizeTelegramDrivePath(req.body.path);
                    const newPath = normalizeTelegramDrivePath(moved.path || moved.directory?.path || '');
                    if (newPath && oldPath !== newPath) {
                        mounts.relocateDirectory(owner(req), req.diskScope.diskSpace, oldPath, newPath);
                        collaborations.relocateDirectory(owner(req), req.diskScope.diskSpace, oldPath, newPath);
                    }
                    return moved;
                }, () => { drive.reloadPersistence(); collaborations.reloadPersistence(); mounts.reloadPersistence(); });
                return result;
            });
        }));
        router.get('/files/:id', wrap((req, res) => res.json(publicFile(getFile(req)))));
        router.get('/files/:id/thumbnail', wrap(async (req, res) => {
            const file = requireEntity(getFile(req));
            const lease=file.contentId ? content.lease(file.contentId,req.diskViewerId || owner(req),'','read') : '';
            try {
            const physical=lease ? content.leasedPhysical(lease) : file, thumbnail = physical.thumbnail;
            if (!thumbnail?.fileId || !Number(thumbnail.size)) throw new Error('FILE_THUMBNAIL_NOT_FOUND');
            const abort = new AbortController();
            res.on('close', () => { if (!res.writableEnded) abort.abort(); });
            res.status(200).set({ 'Content-Type': thumbnail.type || 'image/jpeg', 'Content-Length': String(thumbnail.size), 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name + '.cover.jpg')}` });
            const storage = await resolveStorageBackend(fileBackend(req, physical), { strict: false });
            const source = await telegram.readPart(storage, thumbnail, { start: 0, end: thumbnail.size - 1, signal: abort.signal });
            assertCurrentCollaboration(req);
            await pipeline(source, res);
            } finally {if(lease)content.releaseLease(lease);}
        }));
        router.patch('/files/:id', wrap((req, res) => {
            const file = requireEntity(getFile(req));
            if (Object.hasOwn(req.body || {}, 'name') || Object.hasOwn(req.body || {}, 'folderPath')) assertStaticFileWritable(scope(req), file);
            const originalName = file.name;
            const originalPath = file.folderPath;
            jobResponse(req, res, 'modify-file', '正在修改文件', async update => {
                update({ phase: 'index-write', message: '正在校验文件名称和目标目录' });
                const drive = store(req);
                if (Object.hasOwn(req.body || {}, 'name') || Object.hasOwn(req.body || {}, 'folderPath')) assertStaticFileWritable(scope(req), drive.get(owner(req), file.id));
                const modified = persistence.atomic(() => {
                    const changed = drive.modifyFile(owner(req), file.id, req.body || {}, maxDepth());
                    if (changed.folderPath !== originalPath || changed.name !== originalName) collaborations.relocateFile(owner(req), req.diskScope.diskSpace, file.id, changed.folderPath, changed.name);
                    return changed;
                }, () => { drive.reloadPersistence(); collaborations.reloadPersistence(); });
                if (Object.hasOwn(req.body || {}, 'name') && modified.name !== originalName) await syncCaptions(store(req), scope(req), [modified], update);
                return publicFile(modified);
            });
        }));
        router.delete('/files/:id', wrap((req, res) => {
            const file = getFile(req);
            assertStaticFileWritable(scope(req), file);
            if (collaborations.protectFile(owner(req), req.diskScope.diskSpace, file.id)) throw new Error('COLLABORATION_DISABLE_BEFORE_DELETE');
            jobResponse(req, res, 'delete-file', '正在删除 ' + file.name, async update => {
                assertStaticFileWritable(scope(req), store(req).get(owner(req), file.id));
                if (collaborations.protectFile(owner(req), req.diskScope.diskSpace, file.id)) throw new Error('COLLABORATION_DISABLE_BEFORE_DELETE');
                if (file.reviewStatus === 'deleted') { store(req).remove(owner(req), file.id); return { ok: true, removedPlaceholder: true }; }
                if (!req.diskApp) {
                    update({phase:'recycle',message:'正在移入当前分区回收站：'+file.name});
                    return {ok:true,trashed:trash.archive(owner(req),req.diskScope.diskSpace,{kind:'file',id:file.id})};
                }
                update({ phase: 'telegram-delete', message: '正在删除文件并清理不再共享的 Telegram 消息：' + file.name });
                const remoteCleanup=await objectStorage.deleteFile(scope(req), file);
                return { ok: true, ...(remoteCleanup ? { remoteCleanup } : {}),
                    ...(remoteCleanup?.status==='pending' ? {warnings:['TELEGRAM_CONTENT_CLEANUP_PENDING']} : {}) };
            });
        }));
        router.delete('/directories', wrap((req, res) => {
            const folderPath = normalizeTelegramDrivePath(req.query.path);
            if (!folderPath) throw new Error('ROOT_DELETE_FORBIDDEN');
            assertStaticDirectoryWritable(scope(req), store(req), folderPath);
            if (collaborations.protectDirectory(owner(req), req.diskScope.diskSpace, folderPath)) throw new Error('COLLABORATION_DISABLE_BEFORE_DELETE');
            const tree = store(req).getDirectoryTree(owner(req), folderPath);
            if (!tree) throw new Error('DIRECTORY_NOT_FOUND');
            if (req.query.recursive !== 'true' && (tree.files.length || tree.directories.length > 1 || mounts.countTree(owner(req), req.diskScope.diskSpace, folderPath))) throw new Error('DIRECTORY_NOT_EMPTY');
            jobResponse(req, res, 'delete-directory', '正在删除目录', async update => {
                assertStaticDirectoryWritable(scope(req), store(req), folderPath);
                if (collaborations.protectDirectory(owner(req), req.diskScope.diskSpace, folderPath)) throw new Error('COLLABORATION_DISABLE_BEFORE_DELETE');
                store(req).assertDirectoryWritable(owner(req), folderPath);
                const currentTree = store(req).getDirectoryTree(owner(req), folderPath);
                if (!currentTree) throw new Error('DIRECTORY_NOT_FOUND');
                if (!req.diskApp && currentTree.reviewStatus !== 'deleted') {
                    update({phase:'recycle',message:'正在将整个目录移入当前分区回收站'});
                    return {trashed:trash.archive(owner(req),req.diskScope.diskSpace,{kind:'directory',path:folderPath}),removedFiles:currentTree.files.length,removedDirectories:currentTree.directories.length};
                }
                let count = 0, cleanupPending = false; const failures = [];
                for (const file of currentTree.files) {
                    update({ phase: 'telegram-delete', percent: null, message: '正在删除 ' + (++count) + '/' + tree.files.length + '：' + file.name });
                    try {
                        if (file.reviewStatus !== 'deleted') {
                            const cleanup=await objectStorage.deleteFile(scope(req), file);
                            cleanupPending = cleanup?.status==='pending' || cleanupPending;
                        }
                        else store(req).remove(owner(req), file.id);
                    }
                    catch (_) { failures.push(file.id); }
                }
                if (failures.length) throw new Error('DISK_DELETE_PARTIAL');
                update({ phase: 'index-write', message: '正在清理虚拟目录索引' });
                const removed = persistence.atomic(() => {
                    const result = store(req).removeDirectory(owner(req), folderPath, true);
                    const mountCleanup = mounts.removeTree(owner(req), req.diskScope.diskSpace, folderPath);
                    return { ...result, ...mountCleanup };
                }, () => { store(req).reloadPersistence(); mounts.reloadPersistence(); });
                return { ...removed,
                    ...(cleanupPending ? {warnings:['TELEGRAM_CONTENT_CLEANUP_PENDING']} : {}) };
            });
        }));
        const pipelineWake = job => {
            for (const wake of job.pipelineWaiters || []) wake();
            job.pipelineWaiters?.clear();
        };
        const pipelineWait = (job, timeout = 30000) => new Promise(resolve => {
            job.pipelineWaiters ||= new Set();
            let settled = false;
            const wake = () => { if (settled) return; settled = true; clearTimeout(timer); job.pipelineWaiters.delete(wake); resolve(); };
            const timer = setTimeout(wake, timeout);
            timer.unref?.();
            job.pipelineWaiters.add(wake);
        });
        const physicalPart = (file, fileIndex, chunk) => {
            const count = file.parts.length, width = Math.max(2, String(count).length);
            const suffix = `.part${String(chunk.partIndex).padStart(width, '0')}-of-${String(count).padStart(width, '0')}`;
            return { fileIndex, logicalFileId: file.logicalId, partIndex: chunk.partIndex, partCount: count, originalSize: file.size, offset: chunk.offset, start: 0, end: chunk.size ? chunk.size - 1 : undefined, size: chunk.size, sha256: chunk.sha256 || '', path: chunk.path, type: count === 1 ? file.type : 'application/octet-stream', name: count === 1 ? file.name : file.name.slice(0, Math.max(1, 180 - suffix.length)) + suffix };
        };
        const nextPipelineBatch = job => {
            const batch = []; let bytes = 0;
            outer: for (let fileIndex = 0; fileIndex < job.files.length; fileIndex++) {
                // Albums are for parts of one logical file. Combining unrelated
                // files makes a single slow/lost response fail several files at
                // once, and prevents the first file from being confirmed early.
                if (batch.length && fileIndex !== batch[0].fileIndex) break;
                const file = job.files[fileIndex];
                for (let partIndex = 1; partIndex <= file.parts.length; partIndex++) {
                    const chunk = file.chunks.find(item => item.partIndex === partIndex);
                    if (!chunk || chunk.status === 'receiving') break outer;
                    if (chunk.status === 'uploaded') continue;
                    if (chunk.status !== 'queued') break outer;
                    if (batch.length >= 2 || bytes + chunk.size > MAX_TELEGRAM_PART_SIZE * 2) break outer;
                    batch.push(physicalPart(file, fileIndex, chunk)); bytes += chunk.size;
                }
            }
            return batch;
        };
        const cleanupPipelineRemote = async job => {
            const parts = uploadRemoteParts(job);
            if (!parts.length) return;
            const remote = { name: job.files[0]?.name || '已取消文件', channelId: job.storage.channelId, createdAt: job.createdAt, parts };
            if (job.progressive && typeof telegram.cleanupTemporaryMessages === 'function') await telegram.cleanupTemporaryMessages(job.storage, remote, { uploadId: job.id, operationId: job.operationId });
            else await telegram.remove(job.storage, remote);
        };
        const progressiveRunner = createProgressiveUploadRunner({ telegram, operations, chunkFileCache, log,
            wake: pipelineWake, wait: pipelineWait, rollback: (...args) => rollbackPipelineRemote(...args),
            commit: async (req, job, control) => {
                const result = await mutate(req, async () => {
                    control.throwIfCancelled(); assertCurrentCollaboration(req);
                    if (job.pipelineFailure) throw job.pipelineFailure;
                    store(req).validateUpload(job.id);
                    const sent = store(req).uploadResults(job.id);
                    if (sent.some(item => !item)) throw new Error('TELEGRAM_PARTS_INVALID');
                    job.assertAuthorized?.();
                    const items = store(req).commit(job.id, job.storage.channelId, sent);
                    for (const item of items) log('upload.file-committed', { uploadId: job.id, operationId: job.operationId, fileId: item.id, bytes: item.size });
                    if (!job.backendId) onDefaultUpload(job.storage.requestedChannelId || job.storage.channelId);
                    return { ok: true, items: items.map(uploadResultFile), warnings: [
                        ...sent.map(item => item.captionWarning).filter(Boolean),
                        ...job.files.map(file => file.thumbnail?.warning).filter(Boolean)
                    ] };
                });
                // Cleanup is durable on the newly committed file, so its
                // failure cannot turn a successfully stored batch into failure.
                queueMicrotask(() => retryRemoteCleanup().catch(() => {}));
                return result;
            }
        });
        const runProgressiveUpload = async (req, diskStore, job, update, control) => {
            activeProgressiveUploads.add(job.id);
            try { return await progressiveRunner(req, diskStore, job, update, control); }
            finally {
                activeProgressiveUploads.delete(job.id);
                if (!closed && recoveryBacklog.length) {
                    clearTimeout(recoveryRetryTimer);
                    recoveryRetryTimer = setTimeout(() => { recoveryRetryTimer = null; cleanupRecoveredUploads().catch(() => {}); }, 100);
                    recoveryRetryTimer.unref?.();
                }
            }
        };
        const rollbackPipelineRemote = (job, diskStore, event) => {
            if (job.rollbackState === 'cleaned') return Promise.resolve(true);
            if (job.rollbackPromise) return job.rollbackPromise;
            job.rollbackPromise = (async () => {
                try {
                    await cleanupPipelineRemote(job);
                    job.rollbackState = 'cleaned'; await diskStore.abortAsync(job.id); return true;
                } catch (error) {
                    job.rollbackState = 'pending';
                    try { await diskStore.preserveForRecoveryAsync(job.id); }
                    catch (manifestError) { log('upload.recovery-manifest-failed', { uploadId: job.id, operationId: job.operationId, error: networkDetails(manifestError) }); }
                    queueUploadRecovery({ store: diskStore, job });
                    log(event, { uploadId: job.id, operationId: job.operationId, error: networkDetails(error), retryScheduled: true });
                    return false;
                } finally { job.rollbackPromise = null; }
            })();
            return job.rollbackPromise;
        };
        const runUploadPipeline = async (req, job, update, control) => {
            job.pipelineAbort = new AbortController();
            operations.onCancel(job.operationId, async () => { job.pipelineAbort.abort(); pipelineWake(job); });
            try {
                while (true) {
                    control.throwIfCancelled();
                    if (job.pipelineAbort.signal.aborted) throw new Error('OPERATION_CANCELLED');
                    const state = store(req).uploadQueue(job.id);
                    if (!state) throw new Error('UPLOAD_NOT_FOUND');
                    update({ clientPartsReceived: state.receivedParts, clientPartsTotal: state.totalParts, telegramPartsUploaded: state.uploadedParts, queueParts: state.pendingParts, queueBytes: state.pendingBytes });
                    let batch = nextPipelineBatch(job);
                    const thumbnailIndex = job.files.findIndex(file => file.thumbnail?.status === 'queued' && file.chunks.length === file.parts.length && file.chunks.every(chunk => chunk.status === 'uploaded'));
                    if (job.clientDone && state.uploadedParts === state.totalParts && thumbnailIndex >= 0) {
                        const file = job.files[thumbnailIndex], thumbnail = store(req).markThumbnailUploading(job.id, thumbnailIndex);
                        update({ phase: 'telegram-thumbnail', percent: null, message: `正在上传媒体封面到 Telegram：${file.name}` });
                        try {
                            let remote;
                            try {
                                remote = await enqueueTelegramUpload(job, () => telegram.uploadThumbnail(job.storage, file, thumbnail, { ...scope(req), uploadId: job.id, operationId: job.operationId, signal: job.pipelineAbort.signal,
                                    onProgress: ({ bytes, total, complete }) => update({ telegramThumbnailBytesSent: bytes, telegramThumbnailTotalBytes: total,
                                        message: `${complete ? '封面已发送，等待 Telegram 确认' : '正在上传媒体封面到 Telegram'}：${file.name}` }) }));
                            } catch (error) {
                                control.throwIfCancelled();
                                if (job.pipelineFailure) throw job.pipelineFailure;
                                if (job.pipelineAbort.signal.aborted) throw error;
                                await store(req).failThumbnailAsync(job.id, thumbnailIndex);
                                log('telegram.thumbnail-skipped', { uploadId: job.id, operationId: job.operationId, fileId: file.logicalId, error: networkDetails(error), details: diskErrorDetails(error) });
                                update({ telegramThumbnailBytesSent: null, telegramThumbnailTotalBytes: null, thumbnailWarnings: job.files.filter(item => item.thumbnail?.warning).length,
                                    message: `封面上传失败，继续完成任务：${file.name}` });
                                continue;
                            }
                            // Once Telegram accepted a cover, a persistence failure
                            // still requires normal rollback of its known message.
                            await store(req).markThumbnailUploadedAsync(job.id, thumbnailIndex, remote);
                        } catch (error) { store(req).resetUploadingThumbnail(job.id, thumbnailIndex); throw error; }
                        update({ telegramThumbnailBytesSent: null, telegramThumbnailTotalBytes: null });
                        continue;
                    }
                    if (job.clientDone && state.uploadedParts === state.totalParts) {
                        update({ phase: 'index-write', percent: null, message: 'Telegram 已接收全部分片，正在写入逻辑文件索引' });
                        const result = await mutate(req, async () => {
                            control.throwIfCancelled();
                            if (job.pipelineFailure) throw job.pipelineFailure;
                            if (job.pipelineAbort.signal.aborted) throw new Error('OPERATION_CANCELLED');
                            store(req).validateUpload(job.id);
                            const sent = store(req).uploadResults(job.id);
                            if (sent.some(result => !result)) throw new Error('TELEGRAM_PARTS_INVALID');
                            job.assertAuthorized?.();
                            const items = store(req).commit(job.id, job.storage.channelId, sent);
                            for (const item of items) log('upload.file-committed', { uploadId: job.id, operationId: job.operationId, fileId: item.id, bytes: item.size });
                            if (!job.backendId) onDefaultUpload(job.storage.requestedChannelId || job.storage.channelId);
                            const warnings = [...sent.filter(file => file.captionWarning).map(file => file.captionWarning), ...job.files.map(file => file.thumbnail?.warning).filter(Boolean)];
                            return { ok: true, items: items.map(uploadResultFile), warnings };
                        });
                        queueMicrotask(() => retryRemoteCleanup().catch(() => {}));
                        return result;
                    }
                    if (batch.length === 1 && !job.clientDone) { await pipelineWait(job, 350); batch = nextPipelineBatch(job); }
                    if (!batch.length) { await pipelineWait(job); continue; }
                    for (const part of batch) store(req).markPartUploading(job.id, part.fileIndex, part.partIndex);
                    const totalBytes = job.files.reduce((sum, file) => sum + file.size, 0);
                    const confirmedBytes = job.files.flatMap(file => file.chunks).filter(chunk => chunk.status === 'uploaded').reduce((sum, chunk) => sum + chunk.size, 0);
                    const confirmedProgress = bytes => ({ telegramBytesConfirmed: bytes, telegramBytesSent: bytes, telegramTotalBytes: totalBytes, processedBytes: bytes, totalBytes, percent: totalBytes ? Math.min(99, bytes / totalBytes * 100) : null });
                    update({ phase: 'telegram-queue', message: `服务器 → Telegram · 正在提交 ${batch.length} 个分片`, queueParts: Math.max(0, state.pendingParts - batch.length), telegramThumbnailBytesSent: null, telegramThumbnailTotalBytes: null, ...confirmedProgress(confirmedBytes) });
                    try {
                        let sentBytes = confirmedBytes;
                        const progress = patch => {
                            if (Number.isFinite(patch.telegramBytesSent)) sentBytes = Math.max(confirmedBytes, Math.min(totalBytes, patch.telegramBytesSent));
                            update({ ...patch, telegramBytesConfirmed: confirmedBytes, telegramBytesSent: sentBytes, telegramTotalBytes: totalBytes,
                                processedBytes: sentBytes, totalBytes, percent: totalBytes ? Math.min(99, sentBytes / totalBytes * 100) : null,
                                message: '服务器 → Telegram · ' + patch.message });
                        };
                        const context = { ...scope(req), uploadId: job.id, operationId: job.operationId, totalBytes, confirmedBytes, signal: job.pipelineAbort.signal,
                            onFailure: error => {
                                if (control.cancelled) return;
                                job.pipelineFailure ||= error;
                                job.pipelineError = diskErrorCode(job.pipelineFailure);
                                recordUploadFailure(job, job.pipelineFailure);
                                pipelineWake(job);
                            },
                            onReuseRejected: part => {
                                try { chunkFileCache.remove(job.storage, part); }
                                catch (error) { log('telegram.chunk-cache-write-failed', { uploadId: job.id, operationId: job.operationId, fileId: part.logicalFileId, action: 'remove', error: networkDetails(error) }); }
                            }
                        };
                        const remotes = await enqueueTelegramUpload(job, async () => {
                            const prepared = [];
                            for (const part of batch) {
                                const cached = chunkFileCache.get(job.storage, part);
                                if (!cached) { prepared.push(part); continue; }
                                try {
                                    const checked = await telegram.call(job.storage, 'getFile', { file_id: cached.fileId }, undefined, 0, { uploadId: job.id, operationId: job.operationId, fileId: part.logicalFileId, dedupe: true });
                                    if (checked?.file_size !== undefined && Number(checked.file_size) !== part.size) throw new Error('TELEGRAM_CHUNK_CACHE_MISMATCH');
                                    prepared.push({ ...part, reuseFileId: cached.fileId, reuseFileUniqueId: cached.fileUniqueId });
                                    log('telegram.chunk-reuse-valid', { uploadId: job.id, operationId: job.operationId, fileId: part.logicalFileId, part: part.partIndex, sha256: part.sha256 });
                                } catch (error) {
                                    try { chunkFileCache.remove(job.storage, part); }
                                    catch (cacheError) { log('telegram.chunk-cache-write-failed', { uploadId: job.id, operationId: job.operationId, fileId: part.logicalFileId, action: 'remove', error: networkDetails(cacheError) }); }
                                    prepared.push(part);
                                    log('telegram.chunk-reuse-invalid', { uploadId: job.id, operationId: job.operationId, fileId: part.logicalFileId, part: part.partIndex, sha256: part.sha256, error: networkDetails(error) });
                                }
                            }
                            let uploaded;
                            try {
                                uploaded = typeof telegram.uploadPhysical === 'function'
                                    ? await telegram.uploadPhysical(job.storage, job.files, prepared, progress, context)
                                    : await telegram.upload(job.storage, prepared.map(part => ({ ...job.files[part.fileIndex], name: part.name, size: part.size, path: part.path, chunks: [{ path: part.path, offset: 0, size: part.size }] })), progress, [], context).then(results => results.map((remote, index) => ({ ...remote, fileIndex: prepared[index].fileIndex, logicalFileId: prepared[index].logicalFileId, partIndex: prepared[index].partIndex, partCount: prepared[index].partCount, originalSize: prepared[index].originalSize, size: prepared[index].size, offset: prepared[index].offset })));
                            } catch (error) {
                                // A split album may partially succeed and then fail
                                // to roll itself back. Keep those known messages in
                                // the manifest for the normal rollback/recovery path.
                                if (error.unremovedParts?.length) {
                                    try { await store(req).keepUploadRollbackParts(job.id, error.unremovedParts); }
                                    catch (manifestError) { log('upload.recovery-manifest-failed', { uploadId: job.id, operationId: job.operationId, error: networkDetails(manifestError), details: diskErrorDetails(manifestError) }); }
                                }
                                throw error;
                            }
                            for (const remote of uploaded) {
                                const part = prepared.find(entry => entry.fileIndex === remote.fileIndex && entry.partIndex === remote.partIndex);
                                if (part) {
                                    remote.sha256 = part.sha256 || '';
                                    // The dedupe index is optional. Its failure must never lose
                                    // accepted Telegram message IDs or roll back a valid upload.
                                    try { chunkFileCache.put(job.storage, part, remote); }
                                    catch (cacheError) { log('telegram.chunk-cache-write-failed', { uploadId: job.id, operationId: job.operationId, fileId: part.logicalFileId, action: 'put', error: networkDetails(cacheError) }); }
                                }
                            }
                            return uploaded;
                        });
                        await store(req).markPartsUploaded(job.id, remotes);
                        const acceptedBytes = remotes.reduce((sum, remote) => sum + Number(remote.size || 0), 0);
                        update({ phase: 'telegram-upload', message: `服务器 → Telegram · 已确认 ${state.uploadedParts + remotes.length}/${state.totalParts} 个分片`, telegramPartsUploaded: state.uploadedParts + remotes.length, ...confirmedProgress(confirmedBytes + acceptedBytes) });
                    } catch (error) {
                        store(req).resetUploadingParts(job.id); throw error;
                    }
                    pipelineWake(job);
                }
            } catch (error) {
                job.pipelineFailure ||= error;
                job.pipelineError = diskErrorCode(job.pipelineFailure);
                log('upload.pipeline-failed', { uploadId: job.id, operationId: job.operationId, stage: 'telegram-or-index', error: networkDetails(job.pipelineFailure), details: diskErrorDetails(job.pipelineFailure) });
                try { operations.update(job.operationId, { phase: 'rollback', message: '上传失败，正在回滚已上传消息', errorCode: job.pipelineError, errorDetails: diskErrorDetails(job.pipelineFailure) }, true); }
                catch (diagnosticError) { log('upload.failure-state-write-failed', { uploadId: job.id, operationId: job.operationId, error: networkDetails(diagnosticError) }); }
                if (!control.cancelled) {
                    // Report the original failure before remote cleanup, which
                    // can itself be slow. Browser uploads must stop immediately.
                    recordUploadFailure(job, job.pipelineFailure);
                    await rollbackPipelineRemote(job, store(req), 'upload.failure-cleanup-failed');
                }
                throw job.pipelineFailure;
            } finally {
                if (control.cancelled) {
                    await rollbackPipelineRemote(job, store(req), 'upload.cancel-cleanup-failed');
                }
                pipelineWake(job);
                job.pipelineDoneResolve?.();
            }
        };
        if (router === browser) coreUpload = { runUploadPipeline, runProgressiveUpload: (req, job, update, control) => runProgressiveUpload(req, store(req), job, update, control), pipelineWait, pipelineWake, rollbackPipelineRemote };
        router.post('/content/preflight',rateLimit({windowMs:60000,max:200,standardHeaders:true,legacyHeaders:false}),wrap(async(req,res)=>{
            const files=req.body?.files;
            if(!Array.isArray(files) || !files.length || files.length>100) throw new Error('DISK_BATCH_LIMIT');
            const results=[];
            try {
            for(const file of files){
                if(!Number.isSafeInteger(file?.size) || file.size<0 || file.size>LOGICAL_FILE_UPLOAD_LIMIT)throw new Error('telegram-drive-upload-size-invalid');
                if(typeof file.name!=='string' || !file.name.trim() || file.name.length>180)throw new Error('telegram-drive-name-invalid');
                const folder=normalizeTelegramDrivePath(file.folderPath ?? req.body.folderPath ?? '');
                if(folder.split('/').filter(Boolean).length>maxDepth())throw new Error('telegram-drive-depth-exceeded');
                results.push(await contentProof.preflight(req,file,req.body.folderPath));
            }
            res.json({files:results});
            } catch(error) {
                contentProof.release(req,results.map(result=>result.ticket || result.reuseTicket || result.uploadTicket).filter(Boolean));
                throw error;
            }
        }));
        router.post('/content/proof',rateLimit({windowMs:60000,max:200,standardHeaders:true,legacyHeaders:false}),wrap((req,res)=>res.json(contentProof.prove(req,req.body?.ticket,req.body?.digests))));
        router.post('/content/release',wrap((req,res)=>{contentProof.release(req,req.body?.tickets);res.json({ok:true});}));
        router.post('/uploads', wrap(async (req, res) => {
            const storage = await resolveStorageBackend(backend(req));
            if (!storage?.channelId || !storage?.token) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
            const contentAuthorization=contentProof.authorization(req);
            contentProof.assertAuthorization(contentAuthorization);
            const files = (req.body?.files || []).map(file => {
                if (!file.source_path) return file;
                const parts = String(file.source_path).replace(/\\/g, '/').split('/');
                const name = parts.pop();
                if (!name) throw new Error('SOURCE_PATH_INVALID');
                return { ...file, name, folderPath: normalizeTelegramDrivePath(parts.join('/')) };
            });
            const limit = LOGICAL_FILE_UPLOAD_LIMIT;
            const progressive = req.body?.progressive === true && typeof telegram.pushChunk === 'function' && typeof telegram.finalizeGroups === 'function';
            if (progressive && activeProgressiveUploads.size >= 20) throw new Error('UPLOAD_ACTIVE_LIMIT');
            const job = store(req).begin({ owner: req.diskUser, folderPath: req.body?.folderPath, files, progressive, maxDepth: maxDepth(), uploadLimit: limit, backendId: storage.id || '', channelId: storage.channelId, sourceAppId: req.diskApp?.appId || 'system', metadata: req.body?.metadata || {} });
            job.storage = storage;
            if (progressive) activeProgressiveUploads.add(job.id);
            try {
                for(const [index,file] of files.entries()) {
                    if(file.size===0){job.files[index].emptyContent=true;job.files[index].finalized=true;job.files[index].contentSha256=crypto.createHash('sha256').update('').digest('hex');}
                    const peer=files.findIndex((entry,previous)=>previous<index && file.contentSha256 && entry.contentSha256===file.contentSha256 && entry.size===file.size);
                    if(progressive && peer>=0) { job.files[index].reuseFromIndex=peer; continue; }
                    if(file.reuseTicket) {
                        if(!progressive) throw new Error('CONTENT_REUSE_REQUIRES_PROGRESSIVE');
                        const verified=contentProof.consume(req,file,req.body.folderPath);
                        await store(req).reuseContent(job.id,index,verified.id,verified.lease);
                    } else if(file.uploadTicket) {
                        const claim=contentProof.consumeClaim(req,file,req.body.folderPath);
                        job.files[index].contentCandidateId=claim.id; job.files[index].contentClaimToken=claim.token;
                    }
                }
                const operation = operations.create(scope(req), 'upload', '上传 ' + job.files.length + ' 个文件：' + job.files[0].name, job.files.reduce((sum, file) => sum + file.size, 0));
                job.operationId = operation.operation_id;
                await store(req).setUploadContextAsync(job.id, { operationId: job.operationId, channelId: storage.channelId, operationScope: scope(req),
                    contentAuthorization,
                    ...(req.collaboration ? { collaborationId: req.collaboration.id, collaborationVersion:req.collaboration.grantVersion, viewerId: req.diskViewerId,
                        contentGrant:{id:req.collaboration.id,viewerId:req.diskViewerId,version:req.collaboration.grantVersion} } : {}) });
                operations.update(job.operationId, { uploadId: job.id, progressive, telegramFileCount: files.length, folderPath: job.folderPath || '', ...(req.collaboration ? { collaborationId: req.collaboration.id } : {}) }, true);
            } catch (error) {
                activeProgressiveUploads.delete(job.id);
                log('upload.create-failed', { uploadId: job.id, operationId: job.operationId, error: networkDetails(error), details: diskErrorDetails(error) });
                try { await store(req).abortAsync(job.id); }
                catch (cleanupError) { log('upload.staging-cleanup-failed', { uploadId: job.id, error: networkDetails(cleanupError) }); }
                if (job.operationId) recordUploadFailure(job, error);
                throw error;
            }
            job.pipelineDone = new Promise(resolve => { job.pipelineDoneResolve = resolve; });
            operations.run(job.operationId, (update, control) => job.progressive ? runProgressiveUpload(req, store(req), job, update, control) : runUploadPipeline(req, job, update, control));
            for (const file of job.files) log('upload.created', { uploadId: job.id, operationId: job.operationId, fileId: file.logicalId, bytes: file.size });
            res.status(201).json({ uploadId: job.id, operation_id: job.operationId, progressive: job.progressive, uploadLimit: limit, partSize: MAX_TELEGRAM_PART_SIZE, uploadQueueCheck: true, queue: store(req).uploadQueue(job.id), files: job.files.map(file => ({ logicalFileId: file.logicalId, partCount: file.parts.length, reused:Boolean(file.emptyContent || file.reuseContentId || Number.isInteger(file.reuseFromIndex)) })) });
        }));
        router.get('/uploads/:uploadId/progress', wrap((req, res) => {
            // A single authenticated stream replaces frequent HTTP polls. This
            // reads the in-memory operation snapshot, not SQLite every 250 ms.
            const initial = operations.findUpload(req.params.uploadId, scope(req));
            if (!initial || (req.collaboration && initial.collaborationId !== req.collaboration.id)) throw new Error('UPLOAD_NOT_FOUND');
            res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform',
                'X-Accel-Buffering': 'no', 'Connection': 'keep-alive' });
            res.flushHeaders();
            let previous = '', heartbeat = Date.now(), timer;
            const stop = () => { clearInterval(timer); res.end(); };
            const send = () => {
                const current = operations.get(initial.operation_id, scope(req));
                if (!current) { stop(); return; }
                const serialized = JSON.stringify(current);
                if (serialized !== previous) { res.write(`event: progress\ndata: ${serialized}\n\n`); previous = serialized; }
                else if (Date.now() - heartbeat >= 15000) { res.write(': keepalive\n\n'); heartbeat = Date.now(); }
                if (['completed', 'failed', 'cancelled'].includes(current.status)) stop();
            };
            timer = setInterval(send, 250); timer.unref?.(); res.on('close', () => clearInterval(timer)); send();
        }));
        router.get('/uploads/:uploadId/queue', wrap((req, res) => {
            const job = uploadJob(req), queue = store(req).uploadQueue(job.id);
            res.set('Cache-Control', 'no-store').json({ ready: !job.finishing && queue.pendingParts < 5 && queue.pendingBytes < 100_000_000, queue, retryAfterMs: 1000 });
        }));
        router.put('/uploads/:uploadId/files/:index', wrap(async (req, res) => {
            const job = uploadJob(req);
            if (job.finishing) throw new Error('UPLOAD_IN_PROGRESS');
            // Wait through small queue-status requests in the browser, rather
            // than holding a large PUT open across an upstream proxy timeout.
            const queue = store(req).uploadQueue(job.id);
            if (queue.pendingParts >= 5 || queue.pendingBytes >= 100_000_000) {
                log('browser.backpressure', { uploadId: job.id, operationId: job.operationId, pendingParts: queue.pendingParts, pendingBytes: queue.pendingBytes });
                return res.status(503).set('Retry-After', '1').json({ error: 'UPLOAD_BACKPRESSURE', queue, retryAfterMs: 1000 });
            }
            const file = job.files[Number(req.params.index)];
            if (!file) throw new Error('FILE_NOT_FOUND');
            if (job.progressive && file.parts.length > 1 && !req.get('Content-Range')) throw new Error('UPLOAD_RANGE_REQUIRED');
            const trace = { uploadId: job.id, operationId: job.operationId, fileId: file.logicalId, range: req.get('Content-Range'), contentLength: req.get('Content-Length') };
            const started = Date.now(); let receivedBytes = 0, lastProgressAt = started;
            log('browser.receive-start', trace);
            const heartbeat = setInterval(() => log('browser.receive-progress', { ...trace, receivedBytes, elapsedMs: Date.now() - started, idleMs: Date.now() - lastProgressAt }), 10000);
            heartbeat.unref?.();
            operations.update(job.operationId, { status: 'running', phase: 'client-upload', percent: null, message: '正在接收客户端文件：' + file.name });
            try {
                const received = job.files.reduce((sum, file) => sum + file.received, 0);
                const totalBytes = job.files.filter(file=>!file.reuseContentId && !Number.isInteger(file.reuseFromIndex)).reduce((sum, file) => sum + file.size, 0);
                let lastBytes = received, measuredAt = started, speed = 0;
                const progress = bytes => {
                    receivedBytes = bytes; lastProgressAt = Date.now();
                    const current = job.progressive && req.get('Content-Range') ? job.files.reduce((sum, item) => sum + item.received, 0) : received + bytes;
                    const elapsed = (lastProgressAt - measuredAt) / 1000;
                    if (elapsed >= .2) { const sample = Math.max(0, current - lastBytes) / elapsed; speed = speed ? speed * .7 + sample * .3 : sample; lastBytes = current; measuredAt = lastProgressAt; }
                    operations.update(job.operationId, { phase: 'client-upload', message: '浏览器 → 服务器：' + file.name,
                        clientBytesReceived: current, clientTotalBytes: totalBytes, clientBytesPerSecond: Math.round(speed),
                        clientFileIndex: Number(req.params.index) + 1, clientFileName: file.name,
                        processedBytes: current, totalBytes, percent: totalBytes ? current / totalBytes * 100 : null });
                };
                const result = req.get('Content-Range')
                    ? await store(req).receivePart(job.id, req.params.index, req, req.get('Content-Range'), progress, job.progressive ? { onReady: () => pipelineWake(job) } : undefined)
                    : await store(req).receive(job.id, req.params.index, req, progress);
                res.json({ ...result, queue: store(req).uploadQueue(job.id) });
                pipelineWake(job);
                log('browser.receive-complete', { ...trace, receivedBytes, elapsedMs: Date.now() - started });
            } catch (error) {
                log('browser.receive-failed', { ...trace, receivedBytes, elapsedMs: Date.now() - started, error: networkDetails(error), details: diskErrorDetails(error) });
                job.pipelineFailure ||= error;
                job.pipelineAbort?.abort(); pipelineWake(job);
                await job.pipelineDone?.catch(() => {});
                if (job.rollbackState !== 'pending') {
                    try { await store(req).abortAsync(job.id); }
                    catch (cleanupError) { log('upload.staging-cleanup-failed', { uploadId: job.id, error: networkDetails(cleanupError) }); }
                }
                recordUploadFailure(job, job.pipelineFailure); throw job.pipelineFailure;
            }
            finally { clearInterval(heartbeat); }
        }));
        router.put('/uploads/:uploadId/files/:index/thumbnail', wrap(async (req, res) => {
            const job = uploadJob(req);
            if (job.finishing) throw new Error('UPLOAD_IN_PROGRESS');
            const file = job.files[Number(req.params.index)];
            if (!file) throw new Error('FILE_NOT_FOUND');
            const declaredSize = Number(req.get('X-Disk-Thumbnail-Size') || req.get('Content-Length'));
            const declaredType = String(req.get('Content-Type') || 'image/jpeg');
            log('browser.thumbnail-receive-start', { uploadId: job.id, operationId: job.operationId, fileId: file.logicalId, bytes: declaredSize, type: declaredType });
            const result = await store(req).receiveThumbnail(job.id, req.params.index, req, declaredSize, declaredType);
            pipelineWake(job);
            log('browser.thumbnail-receive-complete', { uploadId: job.id, operationId: job.operationId, fileId: file.logicalId, bytes: result.received });
            res.json(result);
        }));
        router.post('/uploads/:uploadId/phase', wrap((req, res) => {
            const job = uploadJob(req);
            if (job.finishing) throw new Error('UPLOAD_IN_PROGRESS');
            operations.update(job.operationId, { status: 'running', phase: 'source-read', percent: null, message: '正在读取本机文件：' + (job.files[req.body?.index]?.name || '') });
            res.json({ ok: true });
        }));
        router.post('/uploads/:uploadId/failure', wrap((req, res) => {
            // Failure cleanup is distinct from a user choosing Cancel. Preserve
            // the first pipeline cause and let its existing rollback run.
            if (!store(req).ownsUpload(owner(req), req.params.uploadId)) {
                const previous = operations.findUpload(req.params.uploadId, scope(req));
                if (!previous) throw new Error('UPLOAD_NOT_FOUND');
                return res.status(202).json({ operation_id: previous.operation_id, status: previous.status });
            }
            const job = store(req).upload(req.params.uploadId), operation = operations.get(job.operationId, scope(req));
            if (['completed', 'cancelled'].includes(operation?.status)) return res.status(202).json({ operation_id: job.operationId, status: operation.status });
            const error = new Error(req.body?.errorCode === 'UPLOAD_CLIENT_NETWORK_ERROR' ? 'UPLOAD_CLIENT_NETWORK_ERROR' : 'UPLOAD_CLIENT_REQUEST_FAILED');
            error.details = { stage: /^browser-upload(?:\/(?:file-\d{1,3}|phase|queue|finish))?$/.test(req.body?.stage || '') ? req.body.stage : 'browser-upload',
                method: ['GET', 'POST', 'PUT'].includes(req.body?.method) ? req.body.method : '', reason: String(req.body?.reason || '').slice(0, 200) };
            job.pipelineFailure ||= error;
            recordUploadFailure(job, job.pipelineFailure);
            log('browser.upload-failure-reported', { uploadId: job.id, operationId: job.operationId, error: networkDetails(job.pipelineFailure), details: diskErrorDetails(job.pipelineFailure) });
            job.pipelineAbort?.abort(); pipelineWake(job);
            // Respond before Telegram cleanup; rollback/recovery remains owned
            // by the pipeline and is not coupled to this browser connection.
            res.status(202).json({ operation_id: job.operationId, status: 'failed' });
        }));
        router.delete('/uploads/:uploadId', wrap(async (req, res) => {
            if (!store(req).ownsUpload(owner(req), req.params.uploadId)) throw new Error('UPLOAD_NOT_FOUND');
            const job = store(req).upload(req.params.uploadId);
            if (['failed', 'completed'].includes(operations.get(job.operationId, scope(req))?.status)) throw new Error('UPLOAD_NOT_FOUND');
            // Mark intentional cancellation before aborting transport: otherwise
            // its AbortError could make the operation terminal as a network failure.
            await operations.cancel(job.operationId, scope(req));
            job.pipelineAbort?.abort(); pipelineWake(job);
            await job.pipelineDone?.catch(() => {});
            await rollbackPipelineRemote(job, store(req), 'upload.cancel-cleanup-failed');
            log('upload.cancelled', { uploadId: job.id, operationId: job.operationId });
            operations.update(job.operationId, { status: 'cancelled', phase: 'cancelled', message: '客户端已取消暂存上传' }, true);
            res.json({ ok: true });
        }));
        router.post('/uploads/:uploadId/finish', wrap(async (req, res) => {
            if (!store(req).ownsUpload(owner(req), req.params.uploadId)) {
                const previous = operations.findUpload(req.params.uploadId, scope(req));
                if (previous) return res.status(202).json({ operation_id: previous.operation_id });
                throw new Error('UPLOAD_NOT_FOUND');
            }
            const job = store(req).finish(req.params.uploadId);
            if (job.progressive) await store(req).markClientDone(job.id);
            else { job.clientDone = true; job.finishing = true; }
            pipelineWake(job);
            log('upload.handoff', { uploadId: job.id, operationId: job.operationId, files: job.files.length, bytes: job.files.reduce((sum, file) => sum + file.size, 0) });
            res.status(202).json({ operation_id: job.operationId });
        }));
        router.get('/files/:id/check', wrap((req, res) => {
            const file = requireEntity(getFile(req));
            jobResponse(req, res, 'check', '正在检测文件', async update => {
                update({ phase: 'telegram-check', message: '正在向 Telegram 检查文件有效性' });
                try {
                    if (typeof telegram.check === 'function') await telegram.check(fileBackend(req, file), file);
                    else await telegram.call(fileBackend(req, file), 'getFile', { file_id: file.fileId });
                    if(file.contentId) content.setHealth(file.contentId,file.physicalRevision,true);
                    else store(req).update(owner(req), file.id, { lastCheckedAt: Date.now() });
                    return { valid: true };
                }
                catch (error) { if(file.contentId)content.setHealth(file.contentId,file.physicalRevision,false,diskErrorCode(error));return { valid: false }; }
            });
        }));
        router.get('/files/:id/download', wrap(async (req, res) => {
            const file = requireEntity(getFile(req));
            const operation = operations.create(scope(req), 'read', '正在请求 Telegram：' + file.name, file.size);
            const id = operation.operation_id;
            operations.update(id, { status: 'running', phase: 'telegram-request', folderPath: file.folderPath || '' }, true);
            try {
                const remote = await prepareRemoteResponse(req, res, fileBackend(req, file), file, { operationId: id });
                if (!remote) return operations.fail(id, new Error('RANGE_NOT_SATISFIABLE'));
                assertCurrentCollaboration(req);
                let bytes = 0;
                const meter = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; operations.update(id, { phase: 'download', message: '正在读取文件：' + file.name, processedBytes: bytes, totalBytes: remote.range.end - remote.range.start + 1, percent: file.size ? Math.min(100, bytes / (remote.range.end - remote.range.start + 1) * 100) : null }); callback(null, chunk); } });
                await pipeline(remote.source, meter, res);
                operations.complete(id, { id: file.id });
            } catch (error) { operations.fail(id, error); throw error; }
        }));
        router.get('/files/:id/stream', wrap(async (req, res) => {
            const file = requireEntity(getFile(req));
            const remote = await prepareRemoteResponse(req, res, fileBackend(req, file), file, { inline: true, cancelUnusedCacheFill: req.query.purpose === 'web-import' });
            if (remote) { assertCurrentCollaboration(req); await pipeline(remote.source, res); }
        }));
        router.post('/files/:id/repair', wrap(async (req, res) => {
            const file = requireEntity(getFile(req));
            assertStaticFileWritable(scope(req), file);
            const storage = await resolveStorageBackend(backend(req));
            if (!storage?.token || !storage?.channelId) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
            const replacement = Boolean(req.collaboration);
            const incomingSize = Number(req.get('X-Disk-File-Size') || req.get('X-Drop2Tunnel-File-Size'));
            if (!Number.isSafeInteger(incomingSize) || incomingSize < 0 || incomingSize > LOGICAL_FILE_UPLOAD_LIMIT || (!replacement && incomingSize !== file.size)) throw new Error('REPAIR_SIZE_INVALID');
            const incomingType = replacement ? String(req.get('X-Disk-File-Type') || file.type || 'application/octet-stream').slice(0, 120) : file.type;
            const operation = operations.create(scope(req), 'repair', replacement ? '正在替换协同文件' : '正在接收本机修复副本', incomingSize);
            operations.update(operation.operation_id, { folderPath: file.folderPath || '', ...(req.collaboration ? { collaborationId: req.collaboration.id } : {}) }, true);
            const job = store(req).begin({ owner: req.diskUser, folderPath: '', files: [{ name: crypto.randomUUID(), type: incomingType, size: incomingSize }], maxDepth: maxDepth(), uploadLimit: LOGICAL_FILE_UPLOAD_LIMIT });
            try { await store(req).receive(job.id, 0, req); }
            catch (error) { store(req).abort(job.id); operations.fail(operation.operation_id, error); throw error; }
            operations.run(operation.operation_id, update => mutate(req, async () => {
                try {
                    if (!store(req).get(owner(req), file.id)) throw new Error('FILE_NOT_FOUND');
                    const before = { ...file, parts: (file.parts || []).map(part => ({ ...part })), thumbnail: file.thumbnail ? { ...file.thumbnail } : null };
                    const actualSha=await store(req).verifyContentHash(job.id,0);
                    if(!replacement && file.contentId) {
                        let expected=file.contentSha256;
                        if(!expected) {
                            const digest=crypto.createHash('sha256');let count=0;
                            const source=await readRemote(fileBackend(req,file),file,0,file.size-1,undefined,req.diskScope.diskSpace);
                            for await(const bytes of source){count+=bytes.length;digest.update(bytes);}
                            if(count!==file.size)throw new Error('CONTENT_SIZE_MISMATCH'); expected=digest.digest('hex');
                            content.verifyLegacy(file.contentId,expected,file.size,file.physicalRevision);
                        }
                        if(actualSha!==expected)throw new Error('CONTENT_REPAIR_HASH_MISMATCH');
                    }
                    const [remote] = incomingSize===0 ? [{parts:[],fileId:'',fileUniqueId:'',messageId:0,mediaGroupId:'',thumbnail:null}]
                        : await enqueueTelegramUpload({ id: job.id, operationId: operation.operation_id }, () => telegram.upload(storage, [{ ...job.files[0], chunks: undefined, logicalId: file.id, name: !replacement && file.contentId ? content.resolve(file.contentId).original_name : file.name, contentCandidateId:!replacement && file.contentId ? file.contentId : job.files[0].contentCandidateId, physicalRevision:!replacement ? file.physicalRevision+1 : 1, folderPath: file.folderPath }], update, [], scope(req)));
                    let attached=false;
                    try {
                    const previous = { fileId: file.fileId, fileUniqueId: file.fileUniqueId, messageId: file.messageId, mediaGroupId: file.mediaGroupId, parts: file.parts || [] };
                    assertCurrentCollaboration(req);
                    const current=store(req).get(owner(req),file.id);
                    if(current?.contentId!==before.contentId || current?.logicalContentVersion!==before.logicalContentVersion || current?.physicalRevision!==before.physicalRevision)throw new Error('CONTENT_WRITE_CONFLICT');
                    store(req).update(owner(req), file.id, { ...remote, ...(replacement ? { size: incomingSize, type: incomingType, thumbnail: null,
                        contentGrant:{id:req.collaboration.id,viewerId:req.diskViewerId,version:req.collaboration.grantVersion} } : {}), contentAuthorization:contentProof.authorization(req), expectedContentId:before.contentId,expectedContentVersion:before.logicalContentVersion,expectedPhysicalRevision:before.physicalRevision, contentSha256:actualSha, contentPhysicalRepair:!replacement, channelId: storage.channelId, backendId: storage.id || '', repairedAt: Date.now(), fileIdHistory: [...(file.fileIdHistory || []), previous] });
                    attached=true;
                    if (replacement && !before.contentId) await telegram.remove(fileBackend(req, before), before).catch(error => log('collaboration.replace-cleanup-failed', { fileId: file.id, error: networkDetails(error) }));
                    return { ok: true };
                    } catch(error){if(!attached)content.enqueue({...remote,size:incomingSize,channelId:storage.channelId,backendId:storage.id || '',createdAt:Date.now()},'failed-repair');throw error;}
                } finally { store(req).abort(job.id); }
            }));
            res.status(202).json({ operation_id: operation.operation_id });
        }));
    }
    contents(collaborationContent);
    browser.use('/collaboration-scope/:collaborationId', collaborationContent);
    contents(browser); contents(external);
    async function uploadObjectStream({ mapping, owner, info, input, size, contentType, expectedSha256, expectedMd5, metadata, replaceId, signal }) {
        const diskSpace = String(mapping.diskSpace || '');
        const diskStore = spaces.get(diskSpace);
        if (replaceId) assertStaticFileWritable({ userId: owner.id, diskSpace }, diskStore.get(owner.id, replaceId));
        const storage = await resolveStorageBackend(mapping.backendId ? auth.backend(mapping.backendId) : getDefaultBackend());
        if (!storage?.token || !storage?.channelId) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
        const reusable=expectedSha256 && expectedSha256!=='UNSIGNED-PAYLOAD' ? content.find(expectedSha256.toLowerCase(),size) : null;
        if(reusable) {
            const candidate=content.resolve(reusable),physical=candidate.physical;
            const sourceBackend=physical.backendId ? auth.backend(physical.backendId) : getDefaultBackend(physical.channelId);
            if(String(sourceBackend?.token)===String(storage.token) && String(sourceBackend?.baseUrl || '')===String(storage.baseUrl || '')) {
                let lease;
                try { lease=content.lease(reusable,owner.id,'s3-put','verified-input'); }
                catch (error) {
                    if (error.message !== 'CONTENT_NOT_AVAILABLE') throw error;
                    return uploadObjectStream({mapping,owner,info,input,size,contentType,expectedSha256,expectedMd5,metadata,replaceId,signal});
                }
                let leaseFailure;
                const heartbeat=setInterval(()=>{
                    try {if(!content.renewLease(lease))throw new Error('CONTENT_LEASE_EXPIRED');}
                    catch(error){leaseFailure=error;input.destroy?.(error);}
                },60000);heartbeat.unref?.();
                let dir;
                try {
                    dir=await fsp.mkdtemp(path.join(dataDir,'s3-content-'));const target=path.join(dir,'input');
                    const sha=crypto.createHash('sha256'),md5=crypto.createHash('md5');let bytes=0;
                    const meter=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>size)return done(new Error('EntityTooLarge'));sha.update(chunk);md5.update(chunk);done(null,chunk);}});
                    await pipeline(input,meter,fs.createWriteStream(target),...(signal ? [{signal}] : []));
                    if(leaseFailure)throw leaseFailure;
                    if(bytes!==size)throw new Error('IncompleteBody');
                    if(sha.digest('hex')!==expectedSha256.toLowerCase())throw new Error('XAmzContentSHA256Mismatch');
                    const s3ETag=md5.digest('hex');if(expectedMd5 && expectedMd5!==Buffer.from(s3ETag,'hex').toString('base64'))throw new Error('BadDigest');
                    if(telegram.check)try{await telegram.check(sourceBackend,{...physical,size});}catch(error){
                        content.setHealth(reusable,candidate.current_revision,false,'TELEGRAM_SOURCE_INVALID');
                        return await uploadObjectStream({mapping,owner,info,input:fs.createReadStream(target),size,contentType,expectedSha256,expectedMd5,metadata,replaceId,signal});
                    }
                    const source={...physical,size,type:contentType,metadata:{...metadata,s3ETag},contentId:reusable,contentLease:lease,contentSha256:expectedSha256.toLowerCase()};
                    mapping.assertAuthorized?.();
                    return diskStore.putCopiedObject(owner,info.folderPath,info.name,source,physical.parts,sourceBackend,maxDepth(),replaceId);
                } finally {clearInterval(heartbeat);content.releaseLease(lease);if(dir)await fsp.rm(dir,{recursive:true,force:true});}
            }
        }
        const req = { diskScope: { userId: owner.id, diskSpace }, diskStore, diskUser: owner,
            diskApp: { appId: 's3', storage }, get: () => '' };
        const job = diskStore.begin({ owner, folderPath: info.folderPath, files: [{ name: info.name, type: contentType, size }], maxDepth: maxDepth(), uploadLimit: LOGICAL_FILE_UPLOAD_LIMIT,
            backendId: storage.id || '', channelId: storage.channelId, sourceAppId: 's3', metadata, replaceId });
        job.storage = storage;
        job.assertAuthorized = mapping.assertAuthorized;
        try {
            const operation = operations.create(req.diskScope, 'upload', `S3 上传：${info.key}`, size);
            job.operationId = operation.operation_id;
            await diskStore.setUploadContextAsync(job.id, { operationId: job.operationId, channelId: storage.channelId });
        } catch (error) {
            try { await diskStore.abortAsync(job.id); }
            catch (cleanupError) { log('upload.staging-cleanup-failed', { uploadId: job.id, error: networkDetails(cleanupError) }); }
            if (job.operationId) recordUploadFailure(job, error);
            throw error;
        }
        job.pipelineDone = new Promise(resolve => { job.pipelineDoneResolve = resolve; });
        const control = { cancelled: false, throwIfCancelled() { if (signal?.aborted) throw new Error('OPERATION_CANCELLED'); } };
        const running = Promise.resolve().then(() => coreUpload.runUploadPipeline(req, job, patch => operations.update(job.operationId, patch), control))
            .then(result => { operations.complete(job.operationId, result); return result; }, error => { operations.fail(job.operationId, error); throw error; });
        running.catch(() => {});
        // A PUT request is one continuous stream, but the existing browser pipeline
        // accepts exact 20 MB Content-Range parts. This adapter keeps at most one
        // incoming network chunk plus one part on disk while Telegram consumes it.
        const iterator = input[Symbol.asyncIterator]();
        let carry = Buffer.alloc(0), received = 0;
        const md5 = crypto.createHash('md5'), sha = crypto.createHash('sha256');
        async function* bytesForPart(wanted) {
            let left = wanted;
            while (left) {
                if (signal?.aborted) throw new Error('OPERATION_CANCELLED');
                if (!carry.length) {
                    const next = await iterator.next();
                    if (next.done) throw new Error('IncompleteBody');
                    carry = Buffer.from(next.value);
                    if (!carry.length) continue;
                }
                const take = Math.min(left, carry.length), chunk = carry.subarray(0, take);
                carry = carry.subarray(take); left -= take; received += take;
                md5.update(chunk); sha.update(chunk); yield chunk;
            }
        }
        try {
            for (const part of job.files[0].parts) {
                while (true) {
                    if (job.pipelineError) throw job.pipelineFailure || new Error(job.pipelineError);
                    const state = diskStore.uploadQueue(job.id);
                    if (!state) throw new Error('UPLOAD_NOT_FOUND');
                    if (state.pendingParts < 5 && state.pendingBytes < 100_000_000) break;
                    await coreUpload.pipelineWait(job);
                }
                await diskStore.receivePart(job.id, 0, Readable.from(bytesForPart(part.size)), `bytes ${part.byteStart}-${part.byteEnd}/${size}`);
                coreUpload.pipelineWake(job);
            }
            if (carry.length || !(await iterator.next()).done) throw new Error('EntityTooLarge');
            if (received !== size) throw new Error('IncompleteBody');
            const actualSha = sha.digest('hex');
            if (expectedSha256 && expectedSha256 !== 'UNSIGNED-PAYLOAD' && actualSha !== expectedSha256.toLowerCase()) throw new Error('XAmzContentSHA256Mismatch');
            const s3ETag = md5.digest('hex');
            if (expectedMd5 && expectedMd5 !== Buffer.from(s3ETag, 'hex').toString('base64')) throw new Error('BadDigest');
            job.metadata = { ...metadata, s3ETag };
            job.files[0].contentSha256=actualSha;
            job.clientDone = true; job.finishing = true; coreUpload.pipelineWake(job);
            await running;
            return diskStore.adminFiles().find(file => file.ownerId === owner.id && file.folderPath === info.folderPath && file.name === info.name);
        } catch (error) {
            job.pipelineFailure ||= error;
            job.pipelineAbort?.abort(); coreUpload.pipelineWake(job);
            await running.catch(() => {});
            if (job.rollbackState !== 'pending') {
                try { await diskStore.abortAsync(job.id); }
                catch (cleanupError) { log('upload.staging-cleanup-failed', { uploadId: job.id, error: networkDetails(cleanupError) }); }
            }
            const original = job.pipelineFailure || error;
            recordUploadFailure(job, original);
            throw original;
        }
    }
    objectStorage = createObjectStorage({ spaces, auth, telegram, getDefaultBackend, openRange: readRemote,
        uploadStream: uploadObjectStream, queueTelegram: enqueueTelegramUpload, onContentDelete: cleanupDeletedContent,
        protectFile: (userId, diskSpace, id) => collaborations.protectFile(userId, diskSpace, id)
            || staticResources.protectFile({ userId, diskSpace }, spaces.get(diskSpace).get(userId, id)),
        protectDirectory: (userId, diskSpace, folder) => staticResources.protectDirectory({ userId, diskSpace }, spaces.get(diskSpace), folder), maxDepth });
    browser.use(failure); external.use(failure);
    return { browser, external, admin, shared, publicStatic, spaces, objectStorage, retryCaptions, retryRemoteCleanup, metadataTiming,
        revokeContentSession: req => contentProof.revokeSession(req),
        close() { closed = true; clearInterval(cleanupTimer); if (recoveryRetryTimer) clearTimeout(recoveryRetryTimer); } };
}
module.exports = { createDiskAPI, createDiskSpaces, publicFile };
