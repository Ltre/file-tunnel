'use strict';
const crypto = require('crypto');
const { openDiskRepository } = require('./disk-repository');
const { MAX_TELEGRAM_PART_SIZE } = require('./disk-limits');

function createDiskChunkFileCache({ dataDir }) {
    const repository = openDiskRepository(dataDir);
    let state = repository.loadWithRevision('chunk_ids');
    const data = { entries: Object.fromEntries(state.items.map(item => [item.key, item.value])) };
    const backendKey = backend => crypto.createHash('sha256').update(String(backend?.baseUrl || 'https://api.telegram.org') + '\0' + String(backend?.token || '')).digest('hex');
    const validPart = part => /^[a-f0-9]{64}$/.test(String(part?.sha256 || ''))
        && Number.isSafeInteger(part?.size) && part.size > 0 && part.size <= MAX_TELEGRAM_PART_SIZE;
    const key = (backend, part) => `${backendKey(backend)}:${part.sha256}:${part.size}`;
    const reload = () => {
        state = repository.loadWithRevision('chunk_ids');
        data.entries = Object.fromEntries(state.items.map(item => [item.key, item.value]));
    };
    const persist = () => {
        try { repository.replaceMany([{ table:'chunk_ids', items:Object.entries(data.entries).map(([key, value]) => ({ key, value })), keyOf:item => item.key, base:state.revisions }]); }
        catch (error) {
            reload();
            throw error;
        }
    };
    return {
        get(backend, part) {
            if (!validPart(part)) return null;
            // Another cache instance can replace or invalidate the same mapping.
            reload();
            const value = data.entries[key(backend, part)];
            return typeof value?.fileId === 'string' && value.fileId.length > 0 && value.size === part.size ? { ...value } : null;
        },
        put(backend, part, remote) {
            if (!validPart(part) || typeof remote?.fileId !== 'string' || !remote.fileId
                || remote.size !== undefined && remote.size !== part.size) return;
            reload();
            data.entries[key(backend, part)] = { fileId: remote.fileId, fileUniqueId: String(remote.fileUniqueId || ''), size: part.size, updatedAt: Date.now() };
            persist();
        },
        remove(backend, part) {
            if (!validPart(part)) return;
            reload();
            const entryKey = key(backend, part);
            if (!data.entries[entryKey]) return;
            delete data.entries[entryKey]; persist();
        }
    };
}

module.exports = { createDiskChunkFileCache };
