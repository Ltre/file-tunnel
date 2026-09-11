'use strict';
const crypto = require('crypto');
const path = require('path');
const { readJson, writeJson } = require('./disk-data');

function createDiskChunkFileCache({ dataDir }) {
    const file = path.join(dataDir, 'telegram-chunk-file-ids.json');
    let data = readJson(file, { version: 1, entries: {} });
    if (!data || data.version !== 1 || typeof data.entries !== 'object') data = { version: 1, entries: {} };
    const backendKey = backend => crypto.createHash('sha256').update(String(backend?.baseUrl || 'https://api.telegram.org') + '\0' + String(backend?.token || '')).digest('hex');
    const key = (backend, part) => `${backendKey(backend)}:${String(part?.sha256 || '')}:${Number(part?.size) || 0}`;
    const persist = () => writeJson(file, data);
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
