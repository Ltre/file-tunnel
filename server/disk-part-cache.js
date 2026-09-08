'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { Readable } = require('stream');

function createDiskPartCache({ dataDir, maxBytes = Number(process.env.TELEGRAM_PART_CACHE_BYTES) || 10 * 1024 * 1024 * 1024, ttlMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    const root = path.join(dataDir, 'telegram-part-cache');
    const inflight = new Map();
    const preparing = new Map();
    fs.mkdirSync(root, { recursive: true });
    const digest = key => crypto.createHash('sha256').update(String(key)).digest('hex');
    const notify = entry => { for (const resolve of entry.waiters.splice(0)) resolve(); };
    const wait = entry => new Promise(resolve => entry.waiters.push(resolve));
    async function prune() {
        const entries = (await fsp.readdir(root, { withFileTypes: true })).filter(item => item.isFile() && item.name.endsWith('.part'));
        const rows = await Promise.all(entries.map(async item => ({ path: path.join(root, item.name), stat: await fsp.stat(path.join(root, item.name)) })));
        rows.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
        let total = 0, now = Date.now();
        for (const row of rows) {
            total += row.stat.size;
            if (now - row.stat.mtimeMs > ttlMs || total > maxBytes) await fsp.unlink(row.path).catch(() => {});
        }
    }
    async function ensure(key, size, source) {
        const id = digest(key);
        if (inflight.has(id)) return inflight.get(id);
        if (preparing.has(id)) return preparing.get(id);
        const pending = prepare(id, size, source);
        preparing.set(id, pending);
        try { return await pending; }
        finally { preparing.delete(id); }
    }
    async function prepare(id, size, source) {
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
                for await (const chunk of upstream) {
                    if (!output.write(chunk)) await once(output, 'drain');
                    entry.written += chunk.length; notify(entry);
                    if (entry.written > size) throw new Error('TELEGRAM_PART_SIZE_MISMATCH');
                }
                output.end(); await once(output, 'close');
                if (entry.written !== size) throw new Error('TELEGRAM_PART_SIZE_MISMATCH');
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
    async function open({ key, size, source, start = 0, end = size - 1, signal }) {
        const entry = await ensure(key, size, source);
        const filename = entry.done && !entry.error ? entry.target : entry.temporary;
        if (entry.done && !entry.error) return fs.createReadStream(filename, { start, end });
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
            } finally { await handle.close(); }
        }
        return Readable.from(growingFile());
    }
    prune().catch(() => {});
    return { open, prune, inflightCount() { return inflight.size; } };
}
module.exports = { createDiskPartCache };
