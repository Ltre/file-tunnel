'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { Readable } = require('stream');

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
    const ownerIndexPath = path.join(root, '.owners.json');
    let owners = {};
    try { owners = JSON.parse(fs.readFileSync(ownerIndexPath, 'utf8')); } catch (_) {}
    const saveOwners = () => { fs.writeFileSync(ownerIndexPath + '.tmp', JSON.stringify(owners)); fs.renameSync(ownerIndexPath + '.tmp', ownerIndexPath); };
    function registerOwner(key, owner) {
        if (!owner?.userId) return;
        const id = digest(key), scope = { userId: String(owner.userId), diskSpace: String(owner.diskSpace || '') };
        const scopes = owners[id] || [];
        if (!scopes.some(item => item.userId === scope.userId && item.diskSpace === scope.diskSpace)) { owners[id] = [...scopes, scope]; saveOwners(); }
    }
    function selectedIds(scope, userId, diskSpace, entries, legacyKeys) {
        if (scope === 'all') return null;
        const selected = new Set(Object.entries(owners).filter(([, scopes]) => scopes.some(owner =>
            (scope === 'partition' || owner.userId === userId) && (scope === 'user' || owner.diskSpace === diskSpace))).map(([id]) => id));
        const available = new Set(entries.filter(item => item.isFile() && /^[a-f0-9]{64}\.(part|tmp)$/.test(item.name)).map(item => item.name.slice(0, 64)));
        if (available.size) for (const key of legacyKeys || []) { const id = digest(key); if (available.has(id)) selected.add(id); }
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
        saveOwners();
    }
    async function ensure(key, size, source, expectedSha256 = '') {
        const id = digest(key);
        if (inflight.has(id)) return inflight.get(id);
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
        const entry = { target, temporary, written: 0, done: false, error: null, waiters: [], ready: null, opened: new Promise((resolve, reject) => { opened = resolve; openFailed = reject; }) };
        entry.opened.catch(() => {});
        entry.ready = (async () => {
            let output;
            try {
                output = fs.createWriteStream(temporary, { flags: 'wx' });
                await once(output, 'open');
                opened();
                const upstream = await source();
                const hash = expectedSha256 ? crypto.createHash('sha256') : null;
                for await (const chunk of upstream) {
                    if (!output.write(chunk)) await once(output, 'drain');
                    hash?.update(chunk);
                    entry.written += chunk.length; notify(entry);
                    if (entry.written > size) throw new Error('TELEGRAM_PART_SIZE_MISMATCH');
                }
                output.end(); await once(output, 'close');
                if (entry.written !== size) throw new Error('TELEGRAM_PART_SIZE_MISMATCH');
                if (hash && hash.digest('hex') !== expectedSha256) throw new Error('TELEGRAM_PART_HASH_MISMATCH');
                await fsp.rename(temporary, target); entry.done = true; notify(entry);
                prune().catch(() => {});
            } catch (error) {
                openFailed(error);
                output?.destroy(); entry.error = error; entry.done = true; notify(entry);
                await fsp.unlink(temporary).catch(() => {}); throw error;
            } finally { inflight.delete(id); }
        })();
        entry.ready.catch(() => {});
        inflight.set(id, entry); return entry;
    }
    async function open({ key, size, source, start = 0, end = size - 1, signal, expectedSha256 = '', owner }) {
        registerOwner(key, owner);
        const id = digest(key); readers.set(id, (readers.get(id) || 0) + 1);
        const release = () => { const count = readers.get(id) - 1; if (count > 0) readers.set(id, count); else readers.delete(id); };
        const attach = stream => { stream.once('close', release); return stream; };
        try {
        const entry = await ensure(key, size, source, expectedSha256);
        const filename = entry.done && !entry.error ? entry.target : entry.temporary;
        if (entry.done && !entry.error) return attach(fs.createReadStream(filename, { start, end }));
        await entry.opened;
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
