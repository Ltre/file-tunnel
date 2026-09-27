'use strict';
const crypto = require('crypto');
const { openDiskRepository } = require('./disk-repository');

function createDiskChunkFileCache({ dataDir }) {
    const repository = openDiskRepository(dataDir);
    let state = repository.loadWithRevision('chunk_ids');
    const data = { entries: Object.fromEntries(state.items.map(item => [item.key, item.value])) };
    const backendKey = backend => crypto.createHash('sha256').update(String(backend?.baseUrl || 'https://api.telegram.org') + '\0' + String(backend?.token || '')).digest('hex');
    const key = (backend, part) => `${backendKey(backend)}:${String(part?.sha256 || '')}:${Number(part?.size) || 0}`;
    const persist = () => {
        try { repository.replaceMany([{ table:'chunk_ids', items:Object.entries(data.entries).map(([key, value]) => ({ key, value })), keyOf:item => item.key, base:state.revisions }]); }
        catch (error) {
            state = repository.loadWithRevision('chunk_ids');
            data.entries = Object.fromEntries(state.items.map(item => [item.key, item.value]));
            throw error;
        }
    };
    return {
        get(backend, part) {
            if (!/^[a-f0-9]{64}$/.test(String(part?.sha256 || ''))) return null;
            const value = data.entries[key(backend, part)];
            return value?.fileId ? { ...value } : null;
        },
        put(backend, part, remote) {
            if (!/^[a-f0-9]{64}$/.test(String(part?.sha256 || '')) || !remote?.fileId) return;
            data.entries[key(backend, part)] = { fileId: String(remote.fileId), fileUniqueId: String(remote.fileUniqueId || ''), size: Number(part.size) || 0, updatedAt: Date.now() };
            persist();
        },
        remove(backend, part) {
            const entryKey = key(backend, part);
            if (!data.entries[entryKey]) return;
            delete data.entries[entryKey]; persist();
        }
    };
}

module.exports = { createDiskChunkFileCache };
