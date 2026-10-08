'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { Readable } = require('stream');
const { openDiskRepository } = require('./disk-repository');

const CACHE_SCHEMA = '2';

function createDiskPartCache({ dataDir, maxBytes = Number(process.env.TELEGRAM_PART_CACHE_BYTES) || 10 * 1024 * 1024 * 1024, ttlMs = 2 * 24 * 60 * 60 * 1000 } = {}) {
    const root = path.join(dataDir, 'telegram-part-cache');
    const inflight = new Map();
    const preparing = new Map();
    const readers = new Map();
    fs.mkdirSync(root, { recursive: true });
    const schemaPath = path.join(root, '.schema');
    let schema = '';
    try { schema = fs.readFileSync(schemaPath, 'utf8').trim(); } catch (_) {}
    if (schema !== CACHE_SCHEMA) {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (entry.isFile() && /\.(?:part|tmp)$/.test(entry.name)) fs.rmSync(path.join(root, entry.name), { force: true });
        }
        fs.writeFileSync(schemaPath, CACHE_SCHEMA + '\n');
    } else {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.tmp')) fs.rmSync(path.join(root, entry.name), { force: true });
    }
    const digest = key => crypto.createHash('sha256').update(String(key)).digest('hex');
    const repository = openDiskRepository(dataDir);
    let ownerState = repository.loadWithRevision('cache_owners');
    const owners = Object.fromEntries(ownerState.items.map(item => [item.id, item.scopes]));
    const saveOwners = () => {
        try { repository.replaceMany([{ table:'cache_owners', items:Object.entries(owners).map(([id, scopes]) => ({ id, scopes })), keyOf:item => item.id, base:ownerState.revisions }]); }
        catch (error) {
            ownerState = repository.loadWithRevision('cache_owners');
            for (const id of Object.keys(owners)) delete owners[id];
            Object.assign(owners, Object.fromEntries(ownerState.items.map(item => [item.id, item.scopes])));
            throw error;
        }
    };
    function registerOwner(key, owner) {
        if (!owner?.userId) return;
        const id = digest(key), scope = { userId: String(owner.userId), diskSpace: String(owner.diskSpace || '') };
        const scopes = owners[id] || [];
        if (!scopes.some(item => item.userId === scope.userId && item.diskSpace === scope.diskSpace)) { owners[id] = [...scopes, scope]; saveOwners(); }
    }
    const matchesScope = (owner, scope, userId, diskSpace) =>
        (scope === 'partition' || owner.userId === userId) && (scope === 'user' || owner.diskSpace === diskSpace);
    function selectedIds(scope, userId, diskSpace, entries, legacyKeys) {
        if (scope === 'all') return null;
        const selected = new Set(Object.entries(owners).filter(([, scopes]) => scopes.some(owner =>
            matchesScope(owner, scope, userId, diskSpace))).map(([id]) => id));
        const available = new Set(entries.filter(item => item.isFile() && /^[a-f0-9]{64}\.(part|tmp)$/.test(item.name)).map(item => item.name.slice(0, 64)));
        let changed=false;
        if (available.size) for (const entry of legacyKeys || []) {
            const id=digest(typeof entry==='string' ? entry : entry.key);if(!available.has(id))continue;
            if(typeof entry==='string'){selected.add(id);continue;}
            const owner=entry.owner,scopes=owners[id] || [];
            if(!scopes.some(item=>item.userId===owner.userId && item.diskSpace===owner.diskSpace)){owners[id]=[...scopes,owner];changed=true;}
            if(matchesScope(owner,scope,userId,diskSpace))selected.add(id);
        }
        if(changed)saveOwners();
        return selected;
    }
    async function clear({ scope = 'all', userId = '', diskSpace = '', legacyKeys = [] } = {}) {
        const entries = await fsp.readdir(root, { withFileTypes: true });
        const selected = selectedIds(scope, userId, diskSpace, entries, legacyKeys);
        let removedFiles = 0, removedBytes = 0, busyFiles = 0, failedFiles = 0;
        for (const item of entries) {
            if (!item.isFile() || !/^[a-f0-9]{64}\.(part|tmp)$/.test(item.name)) continue;
            const id = item.name.slice(0, 64);
            if (selected && !selected.has(id)) continue;
            if (inflight.has(id) || preparing.has(id) || readers.has(id)) { busyFiles++; continue; }
            if (scope !== 'all' && owners[id]?.length) {
                const remaining = owners[id].filter(owner => !matchesScope(owner, scope, userId, diskSpace));
                if (remaining.length) { owners[id] = remaining; continue; }
            }
            const target = path.join(root, item.name);
            try { const stat = await fsp.stat(target); await fsp.unlink(target); removedFiles++; removedBytes += stat.size; delete owners[id]; }
            catch (error) { if (error.code !== 'ENOENT') failedFiles++; }
        }
        saveOwners();
        return { removedFiles, removedBytes, busyFiles, failedFiles };
    }
    async function overview({ scope = 'all', userId = '', diskSpace = '', legacyKeys = [] } = {}) {
        const entries = await fsp.readdir(root, { withFileTypes: true });
        const selected = selectedIds(scope, userId, diskSpace, entries, legacyKeys);
        let files = 0, bytes = 0;
        for (const item of entries) {
            if (!item.isFile() || !/^[a-f0-9]{64}\.(part|tmp)$/.test(item.name)) continue;
            if (selected && !selected.has(item.name.slice(0, 64))) continue;
            const stat = await fsp.stat(path.join(root, item.name)).catch(() => null);
            if (stat) { files++; bytes += stat.size; }
        }
        const active = selected ? [...inflight.keys()].filter(id => selected.has(id)).length : inflight.size;
        return { directory: '.tunnel-data/telegram-part-cache', files, bytes, inflight: active };
    }
    const notify = entry => { for (const resolve of entry.waiters.splice(0)) resolve(); };
    const wait = entry => new Promise(resolve => entry.waiters.push(resolve));
    async function prune() {
        const entries = (await fsp.readdir(root, { withFileTypes: true })).filter(item => item.isFile() && item.name.endsWith('.part'));
        const rows = await Promise.all(entries.map(async item => ({ path: path.join(root, item.name), stat: await fsp.stat(path.join(root, item.name)) })));
        rows.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
        let total = 0, now = Date.now();
        for (const row of rows) {
            total += row.stat.size;
            const id = path.basename(row.path).slice(0, 64);
            if (!inflight.has(id) && !readers.has(id) && (now - row.stat.mtimeMs > ttlMs || total > maxBytes)) {
                await fsp.unlink(row.path).catch(() => {}); delete owners[id];
            }
        }
        const available = new Set((await fsp.readdir(root, { withFileTypes: true }))
            .filter(item => item.isFile() && /^[a-f0-9]{64}\.(?:part|tmp)$/.test(item.name))
            .map(item => item.name.slice(0, 64)));
        for (const id of Object.keys(owners)) {
            if (!available.has(id) && !inflight.has(id) && !preparing.has(id) && !readers.has(id)) delete owners[id];
        }
        saveOwners();
    }
    async function ensure(key, size, source, expectedSha256 = '') {
        const id = digest(key);
        if (inflight.has(id)) {
            const entry = inflight.get(id);
            // A new reader must not inherit a cancelled producer or race its cleanup.
            if (entry.controller.signal.aborted) {
                await entry.ready.catch(() => {});
                return ensure(key, size, source, expectedSha256);
            }
            return entry;
        }
        if (preparing.has(id)) return preparing.get(id);
        const pending = prepare(id, size, source, expectedSha256);
        preparing.set(id, pending);
        try { return await pending; }
        finally { preparing.delete(id); }
    }
    async function prepare(id, size, source, expectedSha256) {
        const target = path.join(root, id + '.part');
        const existing = await fsp.stat(target).catch(() => null);
        if (existing?.size === size && Date.now() - existing.mtimeMs < ttlMs) { fsp.utimes(target, new Date(), new Date()).catch(() => {}); return { target, written: size, done: true, waiters: [] }; }
        if (existing) await fsp.unlink(target).catch(() => {});
        if (inflight.has(id)) return inflight.get(id);
        const temporary = path.join(root, id + '.tmp');
        await fsp.unlink(temporary).catch(() => {});
        let opened, openFailed;
        const entry = { target, temporary, written: 0, done: false, error: null, waiters: [], ready: null, controller: new AbortController(), opened: new Promise((resolve, reject) => { opened = resolve; openFailed = reject; }) };
        entry.opened.catch(() => {});
        entry.ready = (async () => {
            let output, upstream;
            try {
                output = fs.createWriteStream(temporary, { flags: 'wx' });
                await once(output, 'open');
                opened();
                entry.controller.signal.throwIfAborted();
                upstream = await source(entry.controller.signal);
                entry.controller.signal.throwIfAborted();
                const stop = () => upstream.destroy?.(new Error('OPERATION_CANCELLED'));
                entry.controller.signal.addEventListener('abort', stop, { once: true });
                const hash = expectedSha256 ? crypto.createHash('sha256') : null;
                for await (const chunk of upstream) {
                    entry.controller.signal.throwIfAborted();
                    if (!output.write(chunk)) await once(output, 'drain');
                    hash?.update(chunk);
                    entry.written += chunk.length; notify(entry);
                    if (entry.written > size) throw new Error('TELEGRAM_PART_SIZE_MISMATCH');
                }
                output.end(); await once(output, 'close');
                entry.controller.signal.throwIfAborted();
                if (entry.written !== size) throw new Error('TELEGRAM_PART_SIZE_MISMATCH');
                if (hash && hash.digest('hex') !== expectedSha256) throw new Error('TELEGRAM_PART_HASH_MISMATCH');
                await fsp.rename(temporary, target); entry.done = true; notify(entry);
                prune().catch(() => {});
            } catch (error) {
                openFailed(error);
                upstream?.destroy?.();
                const closed = output && !output.closed ? once(output, 'close').catch(() => {}) : null;
                output?.destroy(); entry.error = error; entry.done = true; notify(entry);
                await closed;
                await fsp.unlink(temporary).catch(() => {}); throw error;
            } finally { inflight.delete(id); }
        })();
        entry.ready.catch(() => {});
        inflight.set(id, entry); return entry;
    }
    async function open({ key, size, source, start = 0, end = size - 1, signal, expectedSha256 = '', owner, cancelWhenUnused = false }) {
        signal?.throwIfAborted();
        registerOwner(key, owner);
        const id = digest(key); readers.set(id, (readers.get(id) || 0) + 1);
        let released = false, entry, stream;
        const stopUnused = () => {
            if (!readers.has(id) && entry && !entry.done && !entry.retainWhenUnused) {
                entry.controller.abort(new Error('OPERATION_CANCELLED'));
                notify(entry);
            }
        };
        const release = () => {
            if (released) return;
            released = true;
            signal?.removeEventListener('abort', onAbort);
            const count = readers.get(id) - 1;
            if (count > 0) readers.set(id, count); else readers.delete(id);
            stopUnused();
        };
        const onAbort = () => { release(); notify(entry || { waiters: [] }); stream?.destroy(new Error('OPERATION_CANCELLED')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        const attach = value => { stream = value; stream.once('close', release); return stream; };
        try {
        entry = await ensure(key, size, source, expectedSha256);
        // Existing player/seek reads retain their background fill. Share downloads
        // opt into cancellation, without stopping a fill shared with those reads.
        if (!cancelWhenUnused && !signal?.aborted) entry.retainWhenUnused = true;
        stopUnused();
        signal?.throwIfAborted();
        const filename = entry.done && !entry.error ? entry.target : entry.temporary;
        if (entry.done && !entry.error) return attach(fs.createReadStream(filename, { start, end, signal }));
        await entry.opened;
        signal?.throwIfAborted();
        async function* growingFile() {
            const handle = await fsp.open(filename, 'r'); let position = start;
            try {
                while (position <= end) {
                    if (signal?.aborted) throw new Error('OPERATION_CANCELLED');
                    if (entry.error) throw entry.error;
                    const available = Math.min(end + 1, entry.written) - position;
                    if (available <= 0) { if (entry.done) break; await wait(entry); continue; }
                    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, available));
                    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
                    if (!bytesRead) { await wait(entry); continue; }
                    position += bytesRead; yield buffer.subarray(0, bytesRead);
                }
                if (position !== end + 1) throw entry.error || new Error('TELEGRAM_PART_SIZE_MISMATCH');
                // Bytes can become readable just before the producer closes and
                // validates the file. Do not report a successful stream until
                // the full-window size/hash checks have also succeeded.
                await entry.ready;
                if (entry.error) throw entry.error;
            } finally { await handle.close(); }
        }
        return attach(Readable.from(growingFile()));
        } catch (error) { release(); throw error; }
    }
    prune().catch(() => {});
    return { open, prune, clear, overview, inflightCount() { return inflight.size; } };
}
module.exports = { createDiskPartCache };
