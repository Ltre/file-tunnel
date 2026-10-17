'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
function createMediaCache({ dataDir, database, now = Date.now }) {
    const defaults = { segments: { root: path.join(dataDir, 'cache', 'video-segments'), maxBytes: 10 * 1024 ** 3, ttlDays: 7 },
        candidates: { root: path.join(dataDir, 'cache', 'media-candidates'), maxBytes: 5 * 1024 ** 3, ttlDays: 30 } };
    const leases = new Map(), releases = new Set();
    function validate(input = defaults) {
        const output = {};
        for (const kind of ['segments', 'candidates']) {
            const value = input[kind] || defaults[kind], root = path.resolve(dataDir, String(value.root || defaults[kind].root));
            if (root === path.parse(root).root || root === path.resolve(dataDir)) throw Error('MEDIA_CACHE_PATH_INVALID');
            if (!Number.isSafeInteger(Number(value.maxBytes)) || value.maxBytes < 1024 ** 2 || value.maxBytes > 20 * 1024 ** 4
                || !Number.isFinite(Number(value.ttlDays)) || value.ttlDays <= 0 || value.ttlDays > 3650) throw Error('MEDIA_CACHE_POLICY_INVALID');
            output[kind] = { root, maxBytes: Number(value.maxBytes), ttlDays: Number(value.ttlDays) };
        }
        if (output.segments.root === output.candidates.root) throw Error('MEDIA_CACHE_PATH_CONFLICT'); return output;
    }
    function directory(policy) {
        // Always own a dedicated subdirectory, even when the administrator
        // chooses an external prefix. Cleanup never walks/removes that prefix.
        const root = path.join(policy.root, 'drop2tunnel-media-library'); fs.mkdirSync(root, { recursive: true }); return fs.realpathSync(root);
    }
    function used(record) {
        return database.matching('cache', record.scope, 'kind', record.kind).filter(c => c.id !== record.id && c.status !== 'cleared')
            .reduce((sum, c) => sum + (c.status === 'reserved' ? c.reservedBytes || 0 : c.size || 0), 0);
    }
    function reserve(scope, id, bytes, policy) {
        return database.atomic(() => {
            const record = database.get('cache', id, scope);
            if (!Number.isSafeInteger(bytes) || bytes < 0 || used(record) + bytes > policy.maxBytes) throw Error('MEDIA_CACHE_CAPACITY_EXCEEDED');
            return database.patch('cache', id, scope, { reservedBytes: bytes });
        });
    }
    function allocate(scope, kind, policy, id = crypto.randomUUID(), extension = '', expectedBytes = 0) {
        const root = directory(policy), name = crypto.randomUUID() + extension;
        const record = database.atomic(() => {
            const created = database.create('cache', scope, { kind, root, name, status: 'reserved', size: 0, pid: process.pid, usedAt: now(), expiresAt: now() + policy.ttlDays * 86400000 }, id);
            return reserve(scope, created.id, expectedBytes, policy);
        });
        return { record, path: path.join(root, name) };
    }
    function filename(record) {
        if (!record || !/^[a-f0-9-]{36}(?:\.[a-z0-9]{1,10})?$/.test(record.name) || path.basename(record.root) !== 'drop2tunnel-media-library') throw Error('MEDIA_CACHE_RECORD_INVALID');
        const file = path.resolve(record.root, record.name);
        if (path.dirname(file) !== path.resolve(record.root)) throw Error('MEDIA_CACHE_RECORD_INVALID');
        if (fs.existsSync(record.root) && fs.realpathSync(record.root) !== record.root) throw Error('MEDIA_CACHE_RECORD_INVALID');
        if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile())) throw Error('MEDIA_CACHE_RECORD_INVALID');
        return file;
    }
    function commit(scope, id, policy) {
        const record = database.get('cache', id, scope), file = filename(record), stat = fs.statSync(file);
        if (!stat.size) throw Error('MEDIA_CACHE_EMPTY');
        return database.atomic(() => { reserve(scope, id, stat.size, policy);
            return database.patch('cache', id, scope, { status: 'ready', size: stat.size, reservedBytes: 0, usedAt: now() }); });
    }
    function acquire(scope, id) { return database.atomic(() => {
        const record = database.get('cache', id, scope); if (!record || record.status !== 'ready' || !fs.existsSync(filename(record))) throw Error('MEDIA_CACHE_CLEARED');
        const token = crypto.randomUUID(); leases.set(id, (leases.get(id) || 0) + 1);
        const refresh = () => database.patch('cache', id, scope, current => ({ ...current, usedAt: now(),
            leases: [...(current.leases || []).filter(l => l.token !== token && l.until > now()), { token, until: now() + 60000 }] }));
        refresh(); const timer = setInterval(refresh, 20000); timer.unref?.(); let released = false;
        const release = () => { if (released) return; released = true; clearInterval(timer); releases.delete(release);
            leases.set(id, Math.max(0, (leases.get(id) || 0) - 1));
            database.patch('cache', id, scope, current => ({ ...current, leases: (current.leases || []).filter(l => l.token !== token) })); };
        releases.add(release); return { record, path: filename(record), release };
    }); }
    function assertDiscardable(scope, id) {
        const record = database.get('cache', id, scope);
        if (record && (leases.get(id) || record.leases?.some(l => l.until > now()))) throw Error('MEDIA_CACHE_IN_USE');
    }
    function discard(scope, id) { return database.atomic(() => {
        const record = database.get('cache', id, scope); if (!record) return;
        if (record.status === 'cleared') return;
        assertDiscardable(scope, id);
        try { fs.unlinkSync(filename(record)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        return database.patch('cache', id, scope, { status: 'cleared', size: 0, reservedBytes: 0 });
    }); }
    function cleanup(scope, policies, pinned = new Set(), force = false) {
        let removed = 0;
        const records = database.list('cache', scope, { limit: 10000 }).filter(c => c.status !== 'cleared').sort((a, b) => a.usedAt - b.usedAt);
        for (const kind of ['segments', 'candidates']) {
            let used = records.filter(c => c.kind === kind).reduce((n, c) => n + c.size, 0);
            for (const item of records.filter(c => c.kind === kind)) {
                if (leases.get(item.id) || pinned.has(item.id) || item.leases?.some(l => l.until > now())) continue;
                if (item.status === 'reserved') { try { process.kill(item.pid, 0); continue; } catch (error) { if (error.code !== 'ESRCH') continue; } }
                if (force || item.expiresAt < now() || used > policies[kind].maxBytes || item.status === 'reserved' && item.createdAt < now() - 86400000) {
                    try { if (!discard(scope, item.id)) continue; } catch (error) { if (error.message === 'MEDIA_CACHE_IN_USE') continue; throw error; }
                    used -= item.size; removed++;
                }
            }
        }
        return removed;
    }
    function check(policies) {
        return Object.entries(policies).map(([kind, policy]) => {
            const root = directory(policy), file = path.join(root, crypto.randomUUID() + '.test');
            fs.writeFileSync(file, 'ok', { flag: 'wx' }); fs.unlinkSync(file);
            const stat = fs.statfsSync(root); return { kind, root, availableBytes: Number(stat.bavail) * Number(stat.bsize) };
        });
    }
    return { defaults, validate, allocate, reserve, filename, commit, acquire, assertDiscardable, discard, cleanup, check, close() { [...releases].forEach(release => release()); } };
}
module.exports = { createMediaCache };
