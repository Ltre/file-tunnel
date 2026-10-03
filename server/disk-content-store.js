'use strict';

const crypto = require('crypto');
const { openDiskRepository } = require('./disk-repository');

function manifestSha256(file) {
    const parts = Array.isArray(file?.parts) ? [...file.parts].sort((a, b) => Number(a.partIndex) - Number(b.partIndex)) : [];
    const hash = crypto.createHash('sha256');
    hash.update('Drop2TunnelLogicalV1\0');
    hash.update(String(Number(file?.size) || 0));
    hash.update('\0');
    for (const part of parts) {
        hash.update(String(Number(part.size) || 0));
        hash.update(':');
        hash.update(String(part.sha256 || ''));
        hash.update(';');
    }
    return hash.digest('hex');
}

function createDiskContentStore({ dataDir }) {
    const repository = openDiskRepository(dataDir);
    const load = () => repository.loadWithRevision('contents', '');
    const all = () => load().items;

    function get(id) {
        if (!id) return null;
        return all().find(item => item.id === String(id)) || null;
    }

    function put(item) {
        if (!item?.id) throw new Error('CONTENT_OBJECT_INVALID');
        // Reload immediately before replacing the global content table so stores
        // for different disk spaces merge rather than overwrite each other.
        const state = load();
        const items = state.items.filter(existing => existing.id !== item.id);
        items.push(item);
        repository.replaceMany([{ table:'contents', scope:'', items, keyOf:entry => entry.id, base:state.revisions }]);
        return structuredClone(item);
    }

    function remove(id) {
        const state = load();
        if (!state.items.some(item => item.id === String(id))) return false;
        repository.replaceMany([{ table:'contents', scope:'', items:state.items.filter(item => item.id !== String(id)), keyOf:entry => entry.id, base:state.revisions }]);
        return true;
    }

    function fromLogicalFile(file, { id = crypto.randomUUID(), now = Date.now() } = {}) {
        const parts = (Array.isArray(file?.parts) ? file.parts : []).map((part, index, all) => ({
            fileId:String(part.fileId || ''), fileUniqueId:String(part.fileUniqueId || ''),
            messageId:Number(part.messageId) || 0, messageDate:Number(part.messageDate) || now,
            mediaType:String(part.mediaType || 'document'), mediaGroupId:String(part.mediaGroupId || ''),
            partIndex:Number(part.partIndex) || index + 1, partCount:Number(part.partCount) || all.length,
            originalSize:Number(part.originalSize) || Number(file.size) || 0,
            offset:Number(part.offset) || 0, size:Number(part.size) || 0, sha256:String(part.sha256 || '')
        }));
        return {
            id:String(id),
            contentSha256:'',
            manifestSha256:manifestSha256({ size:file.size, parts }),
            size:Number(file.size) || 0,
            originalName:String(file.name || ''),
            originalMimeType:String(file.type || 'application/octet-stream'),
            physicalRevision:1,
            backendId:String(file.backendId || ''),
            channelId:String(file.channelId || ''),
            parts,
            thumbnail:file.thumbnail ? structuredClone(file.thumbnail) : null,
            mediaIndex:file.mediaIndex ? structuredClone(file.mediaIndex) : { mode:'unavailable' },
            state:'READY',
            healthStatus:'',
            lastCheckedAt:Number(file.lastCheckedAt) || 0,
            repairedAt:0,
            lastPhysicalError:'',
            cleanupState:'',
            cleanupAttempts:0,
            cleanupError:'',
            createdAt:Number(file.createdAt) || now,
            updatedAt:now
        };
    }

    function resolve(file) {
        if (!file) return null;
        const shared = file.contentId ? get(file.contentId) : null;
        if (shared) return shared;
        // Compatibility view only; old Logical Files remain readable until
        // migration/backfill creates a durable Content Object.
        return { ...fromLogicalFile(file, { id:'legacy:' + file.id, now:Number(file.updatedAt) || Date.now() }), state:'LEGACY', durable:false };
    }

    return { all, get, put, remove, resolve, fromLogicalFile, manifestSha256 };
}

module.exports = { createDiskContentStore, manifestSha256 };
