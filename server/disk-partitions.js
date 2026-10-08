'use strict';

const crypto = require('node:crypto');
const { openDiskRepository } = require('./disk-repository');

const ACTIVE = 'ACTIVE';
const normalizeName = value => String(value || '').normalize('NFC').toLocaleLowerCase('zh-CN');
function validateName(value) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 100
        || /[\\/<>:"|?*\u0000-\u001f\u007f]/.test(value)) throw new Error('DISK_SPACE_INVALID');
    return value.normalize('NFC');
}

// A partition's scopeKey is immutable. Existing diskSpace values remain valid
// internal keys, while new partitions receive opaque keys that cannot reconnect
// to the storage directory of a previously removed, identically named space.
function createDiskPartitions({ dataDir, spaces, s3Credentials }) {
    const repository = openDiskRepository(dataDir);
    const seeded = new Set();
    const read = () => repository.loadWithRevision('partitions');
    const active = item => item.state === ACTIVE;
    const publicItem = item => ({ id: item.id, partitionId: item.id, scopeKey: item.scopeKey,
        diskSpace: item.scopeKey, name: item.displayName, displayName: item.displayName,
        isDefault: Boolean(item.isDefault), state: item.state, settings: structuredClone(item.settings || { version: 1 }),
        createdAt: item.createdAt, updatedAt: item.updatedAt });
    const commit = (state, items) => repository.replaceMany([{ table: 'partitions', items,
        keyOf: item => item.id, base: state.revisions }]);
    const knownScopes = userId => {
        const scopes = new Set(spaces.forUser(userId));
        for (const table of ['space_usage', 'shares', 'collaborations', 'static_resources', 'operations']) {
            for (const item of repository.load(table)) {
                if ((item.userId || item.ownerId) === userId && typeof item.diskSpace === 'string') scopes.add(item.diskSpace);
            }
        }
        for (const credential of s3Credentials?.list?.() || []) {
            if (credential.userId === userId) for (const mapping of credential.bucketMappings || []) scopes.add(mapping.diskSpace || '');
        }
        scopes.add('');
        return scopes;
    };
    function ensureUser(userId) {
        if (seeded.has(userId)) return;
        repository.atomic(() => {
            const state = read(), items = state.items;
            const occupied = new Set(items.filter(item => item.ownerId === userId).map(item => item.scopeKey));
            let changed = false;
            for (const scopeKey of knownScopes(userId)) {
                if (occupied.has(scopeKey)) continue;
                let displayName = scopeKey || '默认分区';
                if (items.some(item => item.ownerId === userId && active(item)
                    && normalizeName(item.displayName) === normalizeName(displayName))) {
                    displayName = `${displayName} (${crypto.randomUUID().slice(0, 8)})`;
                }
                const now = Date.now();
                items.push({ id: crypto.randomUUID(), ownerId: userId, scopeKey, displayName,
                    isDefault: scopeKey === '', state: ACTIVE, settings: { version: 1 },
                    createdAt: now, updatedAt: now });
                occupied.add(scopeKey); changed = true;
            }
            if (changed) commit(state, items);
        });
        seeded.add(userId);
    }
    function find(ownerId, idOrScope) {
        ensureUser(ownerId);
        const key = String(idOrScope ?? '');
        const item = read().items.find(entry => entry.ownerId === ownerId && active(entry)
            && (entry.id === key || entry.scopeKey === key));
        if (!item) throw new Error('DISK_SPACE_NOT_FOUND');
        return item;
    }
    function findAny(ownerId, id) {
        ensureUser(ownerId);
        const item = read().items.find(entry => entry.ownerId === ownerId && entry.id === id && entry.state !== 'DELETED');
        if (!item) throw new Error('DISK_SPACE_NOT_FOUND');
        return item;
    }
    function mutate(ownerId, id, work) {
        ensureUser(ownerId);
        return repository.atomic(() => {
            const state = read(), items = state.items;
            const item = items.find(entry => entry.ownerId === ownerId && entry.id === id && active(entry));
            if (!item) throw new Error('DISK_SPACE_NOT_FOUND');
            const result = work(item, items);
            item.updatedAt = Date.now();
            commit(state, items);
            return result === undefined ? publicItem(item) : result;
        });
    }
    function createWithin(ownerId, value, scopeKey = 'p-' + crypto.randomUUID()) {
        ensureUser(ownerId);
        const displayName = validateName(value);
        const state = read(), items = state.items;
        if (items.some(item => item.ownerId === ownerId && item.state !== 'DELETED'
            && normalizeName(item.displayName) === normalizeName(displayName))) throw new Error('DISK_SPACE_EXISTS');
        if (items.some(item => item.ownerId === ownerId && item.scopeKey === scopeKey)) throw new Error('DISK_SPACE_EXISTS');
        const now = Date.now(), item = { id: crypto.randomUUID(), ownerId,
            scopeKey, displayName, isDefault: false, state: ACTIVE,
            settings: { version: 1 }, createdAt: now, updatedAt: now };
        items.push(item); commit(state, items); return publicItem(item);
    }
    return {
        ensureUser,
        find,
        findAny,
        findOperationScope(ownerId, idOrScope) {
            ensureUser(ownerId);
            const key = String(idOrScope ?? '');
            const item = read().items.find(entry => entry.ownerId === ownerId
                && (entry.id === key || entry.scopeKey === key));
            if (!item) throw new Error('DISK_SPACE_NOT_FOUND');
            return item;
        },
        list(ownerId) { ensureUser(ownerId); return read().items.filter(item => item.ownerId === ownerId && item.state !== 'DELETED')
            .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt - b.createdAt).map(publicItem); },
        createWithin,
        resolveExternal(ownerId, scopeOrId, appId = 'system', { allowCreate = false } = {}) {
            try { return find(ownerId, scopeOrId); }
            catch (error) { if (error.message !== 'DISK_SPACE_NOT_FOUND') throw error; }
            if (!allowCreate) throw new Error('DISK_SPACE_NOT_FOUND');
            const scopeKey = String(scopeOrId ?? '');
            if (!scopeKey || scopeKey.length > 100 || /[\u0000-\u001f\u007f]/.test(scopeKey)
                || /^[a-f0-9-]{36}$/i.test(scopeKey)) throw new Error('DISK_SPACE_NOT_FOUND');
            const existing = read().items.find(item => item.ownerId === ownerId && item.scopeKey === scopeKey);
            if (existing) throw new Error('DISK_SPACE_NOT_FOUND'); // never reactivate a retired scope
            const partition = repository.atomic(() => {
                const state = read(), items = state.items;
                if (items.some(item => item.ownerId === ownerId && item.scopeKey === scopeKey)) throw new Error('DISK_SPACE_NOT_FOUND');
                const now = Date.now();
                let displayName = scopeKey;
                if (items.some(item => item.ownerId === ownerId && active(item)
                    && normalizeName(item.displayName) === normalizeName(displayName))) displayName += ` (${crypto.randomUUID().slice(0, 8)})`;
                const item = { id: crypto.randomUUID(), ownerId, scopeKey, displayName,
                    isDefault: false, state: ACTIVE, settings: { version: 1 }, createdAt: now, updatedAt: now };
                items.push(item); commit(state, items); return item;
            });
            spaces.get(scopeKey);
            spaces.track(appId, ownerId, scopeKey);
            return partition;
        },
        create(ownerId, value) {
            const result = repository.atomic(() => createWithin(ownerId, value));
            // This is an explicit creation path. Read/authorization never calls
            // the legacy get() that materializes unknown scopes.
            spaces.get(result.scopeKey);
            spaces.track('system', ownerId, result.scopeKey);
            return result;
        },
        rename(ownerId, id, value) {
            const displayName = validateName(value);
            return mutate(ownerId, id, (item, items) => {
                if (items.some(other => other.id !== item.id && other.ownerId === ownerId && active(other)
                    && normalizeName(other.displayName) === normalizeName(displayName))) throw new Error('DISK_SPACE_EXISTS');
                item.displayName = displayName;
            });
        },
        updateSettings(ownerId, id, value) {
            // Product settings have no confirmed user-editable keys yet. Keep
            // a versioned, bounded envelope without accepting arbitrary tokens.
            if (!value || typeof value !== 'object' || Array.isArray(value)
                || Object.keys(value).some(key => key !== 'version') || value.version !== 1)
                throw new Error('DISK_SPACE_SETTINGS_INVALID');
            return mutate(ownerId, id, item => { item.settings = { version: 1 }; });
        },
        markDeleting(ownerId, id) {
            ensureUser(ownerId);
            return repository.atomic(() => {
                const state = read(), items = state.items;
                const item = items.find(entry => entry.ownerId === ownerId && entry.id === id
                    && ['ACTIVE', 'DELETE_FAILED'].includes(entry.state));
                if (!item) throw new Error('DISK_SPACE_NOT_FOUND');
                if (item.isDefault) throw new Error('DISK_DEFAULT_SPACE_DELETE_FORBIDDEN');
                item.state = 'DELETING'; item.updatedAt = Date.now(); commit(state, items);
                return publicItem(item);
            });
        },
        markDeleteFailed(ownerId, id) {
            return repository.atomic(() => {
                const state = read(), items = state.items;
                const item = items.find(entry => entry.ownerId === ownerId && entry.id === id && entry.state === 'DELETING');
                if (!item) return null;
                // The delete transaction rolled back and S3 retirement has
                // not run, so restore normal access for a safe explicit retry.
                item.state = ACTIVE; item.updatedAt = Date.now(); commit(state, items);
                return publicItem(item);
            });
        },
        recoverDeleting(ownerId, id) {
            ensureUser(ownerId);
            return repository.atomic(() => {
                const state = read(), items = state.items;
                const item = items.find(entry => entry.ownerId === ownerId && entry.id === id && entry.state === 'DELETING');
                if (!item || item.isDefault) throw new Error('DISK_SPACE_NOT_FOUND');
                item.state = ACTIVE; item.updatedAt = Date.now(); commit(state, items);
                return publicItem(item);
            });
        },
        retireWithin(ownerId, id) {
            const state = read(), items = state.items;
            const item = items.find(entry => entry.ownerId === ownerId && entry.id === id && entry.state === 'DELETING');
            if (!item || item.isDefault) throw new Error('DISK_SPACE_NOT_FOUND');
            item.state = 'DELETED'; item.updatedAt = Date.now(); commit(state, items);
            return publicItem(item);
        },
        publicItem,
        reload() { seeded.clear(); }
    };
}

module.exports = { createDiskPartitions, validateName };
