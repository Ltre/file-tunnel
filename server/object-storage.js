'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { normalizeTelegramDrivePath } = require('./telegram-drive');
const { MAX_TELEGRAM_PART_SIZE } = require('./disk-limits');

const UPLOAD_LIMIT = 2000 * 1024 * 1024;
function objectKey(key) {
    if (typeof key !== 'string' || !key || Buffer.byteLength(key, 'utf8') > 1024 || key.startsWith('/') || key.includes('\\') || /[\u0000-\u001f]/.test(key)) throw new Error('InvalidObjectName');
    const folder = key.endsWith('/');
    const value = folder ? key.slice(0, -1) : key;
    if (!value || value.split('/').length > (folder ? 20 : 21)) throw new Error('InvalidObjectName');
    const parts = value.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part !== part.trim())) throw new Error('InvalidObjectName');
    const folderPath = parts.slice(0, -1).join('/'), name = parts.at(-1);
    try {
        if ((folderPath && normalizeTelegramDrivePath(folderPath) !== folderPath) || (folder && normalizeTelegramDrivePath(value) !== value)
            || !folder && (name.length > 180 || /[\/:*?"<>|\u0000-\u001f]/.test(name))) throw new Error('InvalidObjectName');
    } catch (_) { throw new Error('InvalidObjectName'); }
    return { key, folder, folderPath, name, path: value };
}
function parseByteRange(header, size) {
    if (!header) return { start: 0, end: size - 1, partial: false };
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header));
    if (!match || (!match[1] && !match[2]) || size === 0) throw new Error('InvalidRange');
    let start, end;
    if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error('InvalidRange'); start = Math.max(0, size - suffix); end = size - 1; }
    else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
    if (![start, end].every(Number.isSafeInteger) || start < 0 || start >= size || end < start) throw new Error('InvalidRange');
    return { start, end: Math.min(end, size - 1), partial: true };
}
function createObjectStorage({ spaces, auth, telegram, getDefaultBackend, openRange, uploadStream, queueTelegram, onContentDelete = async () => {}, protectFile = () => false, protectDirectory = () => false, maxDepth = () => 20 }) {
    const scopeOf = mapping => ({ userId: String(mapping.userId), diskSpace: String(mapping.diskSpace || '') });
    const storeOf = mapping => spaces.get(scopeOf(mapping).diskSpace);
    const backendOf = file => file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
    const uploadBackend = mapping => mapping.backendId ? auth.backend(mapping.backendId) : getDefaultBackend();
    function stat(mapping, key) {
        const info = objectKey(key), store = storeOf(mapping), userId = scopeOf(mapping).userId;
        if (info.folder) {
            const directory = store.listDirectories(userId).find(item => item.path === info.path && item.s3Marker);
            if (!directory) return null;
            return { kind: 'marker', key, size: 0, type: 'application/x-directory', updatedAt: directory.s3Marker.updatedAt || directory.updatedAt, etag: directory.s3Marker.metadata?.s3ETag || crypto.createHash('md5').update('').digest('hex'), directory };
        }
        const file = store.adminFiles().find(item => item.ownerId === userId && item.folderPath === info.folderPath && item.name === info.name && item.reviewStatus !== 'deleted');
        if (!file) return null;
        return { kind: 'file', key, size: file.size, type: file.type || 'application/octet-stream', updatedAt: file.updatedAt || file.createdAt, etag: file.metadata?.s3ETag || crypto.createHash('md5').update(JSON.stringify(file.parts || [])).digest('hex'), file };
    }
    function list(mapping) {
        const store = storeOf(mapping), ownerId = scopeOf(mapping).userId;
        const files = store.adminFiles().filter(item => item.ownerId === ownerId && item.reviewStatus !== 'deleted').map(item => ({ kind: 'file', key: [item.folderPath, item.name].filter(Boolean).join('/'), size: item.size, type: item.type, updatedAt: item.updatedAt || item.createdAt, etag: item.metadata?.s3ETag || crypto.createHash('md5').update(JSON.stringify(item.parts || [])).digest('hex'), file: item }));
        const directories = store.listDirectories(ownerId);
        const markers = directories.filter(item => item.s3Marker).map(item => ({ kind: 'marker', key: item.path + '/', size: 0, type: 'application/x-directory', updatedAt: item.s3Marker.updatedAt || item.updatedAt, etag: item.s3Marker.metadata?.s3ETag || crypto.createHash('md5').update('').digest('hex'), directory: item }));
        const virtual = directories.filter(item => !item.s3Marker).map(item => ({ kind: 'virtual-directory', key: item.path + '/', size: 0 }));
        return [...files, ...markers, ...virtual].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    }
    async function open(mapping, key, rangeHeader, signal) {
        const object = stat(mapping, key);
        if (!object) throw new Error('NoSuchKey');
        const range = parseByteRange(rangeHeader, object.size);
        if (!object.size) return { object, range, stream: Readable.from([]) };
        const stream = await openFile(backendOf(object.file), object.file, range.start, range.end, signal, scopeOf(mapping).diskSpace);
        return { object, range, stream };
    }
    const openFile = (backend, file, start, end, signal, diskSpace) => openRange(backend, file, start, end, signal, diskSpace);
    async function cleanupReplaced(mapping, object) {
        // The disk API's retry worker owns remote cleanup after the durable index switch.
        return object;
    }
    async function put(mapping, key, input, { size, contentType = 'application/octet-stream', expectedSha256 = '', expectedMd5 = '', metadata = {}, signal } = {}) {
        mapping.assertAuthorized?.();
        const info = objectKey(key), current = stat(mapping, key), store = storeOf(mapping), owner = auth.user(scopeOf(mapping).userId);
        if (!owner) throw new Error('AccessDenied');
        if (!Number.isSafeInteger(size) || size < 0 || size > UPLOAD_LIMIT) throw new Error('EntityTooLarge');
        if (info.folder && size !== 0) throw new Error('InvalidObjectName');
        if (info.folder && protectDirectory(owner.id, scopeOf(mapping).diskSpace, info.path)) throw new Error('AccessDenied');
        if (current?.file && protectFile(owner.id, scopeOf(mapping).diskSpace, current.file.id)) throw new Error('AccessDenied');
        if (size === 0) {
            for await (const chunk of input) if (chunk.length) throw new Error('IncompleteBody');
            const digest = crypto.createHash('sha256').update('').digest('hex');
            if (expectedSha256 && expectedSha256 !== 'UNSIGNED-PAYLOAD' && expectedSha256 !== digest) throw new Error('XAmzContentSHA256Mismatch');
            const s3ETag = crypto.createHash('md5').update('').digest('hex');
            if (expectedMd5 && expectedMd5 !== Buffer.from(s3ETag, 'hex').toString('base64')) throw new Error('BadDigest');
            mapping.assertAuthorized?.();
            if (info.folder) store.setFolderMarker(owner.id, info.path, { ...metadata, s3ETag }, maxDepth());
            else store.putMetadataObject(owner, info.folderPath, info.name, contentType, { ...metadata, s3ETag }, maxDepth(), current?.file?.id || '');
            return cleanupReplaced(mapping, stat(mapping, key));
        }
        if (info.folder) throw new Error('InvalidObjectName');
        await uploadStream({ mapping, owner, key, info, input, size, contentType, expectedSha256, expectedMd5, metadata, replaceId: current?.file?.id || '', signal });
        return cleanupReplaced(mapping, stat(mapping, key));
    }
    async function deleteFile(mapping, file) {
        const store = storeOf(mapping), scope = scopeOf(mapping);
        if (protectFile(scope.userId, scope.diskSpace, file.id)) throw new Error('AccessDenied');
        if(file.contentId) {
            store.remove(scope.userId,file.id);
            return onContentDelete(file.contentId);
        }
        for (const stale of file.pendingRemoteCleanup || []) {
            if (stale.parts?.length || stale.messageId || stale.thumbnail?.messageId) await queueTelegram({ id: `delete-${file.id}` }, () => telegram.remove(backendOf(stale), stale));
        }
        if (file.parts?.length || file.messageId || file.thumbnail?.messageId) await queueTelegram({ id: `delete-${file.id}` }, () => telegram.remove(backendOf(file), file));
        store.remove(scope.userId, file.id);
    }
    async function remove(mapping, key) {
        const object = stat(mapping, key);
        if (!object) return;
        const store = storeOf(mapping), scope = scopeOf(mapping);
        if (object.kind === 'marker') { if (protectDirectory(scope.userId, scope.diskSpace, object.directory.path)) throw new Error('AccessDenied'); store.clearFolderMarker(scope.userId, object.directory.path); return; }
        await deleteFile(mapping, object.file);
    }
    async function copy(fromMapping, fromKey, toMapping, toKey) {
        fromMapping.assertAuthorized?.(); toMapping.assertAuthorized?.();
        const source = stat(fromMapping, fromKey);
        if (!source) throw new Error('NoSuchKey');
        const target = objectKey(toKey);
        if (source.kind === 'marker') {
            if (!target.folder) throw new Error('InvalidObjectName');
            return put(toMapping, toKey, Readable.from([]), { size: 0, contentType: source.type, metadata: source.directory.s3Marker.metadata || {} });
        }
        if (target.folder) throw new Error('InvalidObjectName');
        const fromBackend = backendOf(source.file), toBackend = uploadBackend(toMapping);
        const sameBackend = String(fromBackend.token) === String(toBackend.token) && String(fromBackend.baseUrl || '') === String(toBackend.baseUrl || '');
        if (!sameBackend) {
            const opened = await open(fromMapping, fromKey);
            return put(toMapping, toKey, opened.stream, { size: source.size, contentType: source.type, metadata: source.file.metadata || {} });
        }
        if (!source.size) return put(toMapping, toKey, Readable.from([]), { size: 0, contentType: source.type, metadata: source.file.metadata || {} });
        const store = storeOf(toMapping), owner = auth.user(scopeOf(toMapping).userId), current = stat(toMapping, toKey);
        if (!owner) throw new Error('AccessDenied');
        if (current?.file && protectFile(owner.id, scopeOf(toMapping).diskSpace, current.file.id)) throw new Error('AccessDenied');
        const logicalId = current?.file?.id || crypto.randomUUID();
        if(source.file.contentId) {
            // S3 credentials already authorize the source object. This is a
            // reference transaction, not a Telegram file_id resend.
            if(scopeOf(fromMapping).userId !== scopeOf(toMapping).userId) throw new Error('AccessDenied');
            fromMapping.assertAuthorized?.(); toMapping.assertAuthorized?.();
            return store.putCopiedObject(owner,target.folderPath,target.name,source.file,source.file.parts,fromBackend,maxDepth(),current?.file?.id || '',logicalId);
        }
        const physical = (source.file.parts || []).map((part, index) => ({ fileIndex: 0, logicalFileId: logicalId, partIndex: index + 1, partCount: source.file.parts.length, originalSize: source.size, offset: part.offset, size: part.size, sha256: part.sha256, reuseFileId: part.fileId, reuseFileUniqueId: part.fileUniqueId, name: target.name, type: source.type }));
        const remotes = await queueTelegram({ id: crypto.randomUUID() }, async () => {
            for (const part of physical) await telegram.call(toBackend, 'getFile', { file_id: part.reuseFileId });
            return telegram.uploadPhysical(toBackend, [{ name: target.name, size: source.size, type: source.type, folderPath: target.folderPath, logicalId: physical[0].logicalFileId }], physical, () => {}, { userId: owner.id, diskSpace: scopeOf(toMapping).diskSpace });
        });
        try { fromMapping.assertAuthorized?.(); toMapping.assertAuthorized?.(); return store.putCopiedObject(owner, target.folderPath, target.name, source.file, remotes, toBackend, maxDepth(), current?.file?.id || '', logicalId); }
        catch (error) { await telegram.remove(toBackend, { name: target.name, channelId: toBackend.channelId, createdAt: Date.now(), parts: remotes }).catch(() => {}); throw error; }
    }
    return { stat, list, open, openFile, put, remove, deleteFile, copy, keyInfo: objectKey, parseByteRange, limit: UPLOAD_LIMIT, partSize: MAX_TELEGRAM_PART_SIZE };
}
module.exports = { createObjectStorage, objectKey, parseByteRange };
