'use strict';
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { mediaKind } = require('./streaming-console');
const MAX_CHUNK = 1024 * 1024;
const REF = /tunnel-blob:([\w-]+)\/([\w.-]+)\/([\w.-]+)/g;
const sourceError = code => Object.assign(new Error(code), { code });

// Bounded, ephemeral demand relay. Requests exist only while an HTTP reader is
// waiting. No file data or retention reference is written to the station store.
function createStreamingBroker({ now = Date.now, timeout = 15000, hedgeMs = 100 } = {}) {
    const clients = new Map(), pending = new Map();
    function poll(deviceId, signal, providerId = 'legacy') {
        if (!/^[\w-]{1,128}$/.test(providerId)) throw sourceError('STREAM_PROVIDER_INVALID');
        for (const [key, value] of clients) if (now() - value.seenAt >= 45000) { value.wake?.([]); clients.delete(key); }
        const key = deviceId + ':' + providerId; let client = clients.get(key);
        if (!client) {
            if (clients.size >= 10000 || [...clients.values()].filter(value => value.deviceId === deviceId).length >= 8) throw sourceError('STREAM_PROVIDER_BUSY');
            client = { deviceId, seenAt: now(), queue: [], wake: null }; clients.set(key, client);
        }
        client.seenAt = now();
        if (client.queue.length) return Promise.resolve(client.queue.splice(0, 4));
        // A reconnected provider replaces its previous long poll.
        client.wake?.([]);
        return new Promise(resolve => {
            const finish = result => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); if (client.wake === finish) client.wake = null; resolve(result); };
            const aborted = () => { const current = client.wake === finish; finish([]); if (current) clients.delete(key); };
            const timer = setTimeout(() => finish([]), 20000); timer.unref?.();
            client.wake = finish; signal?.addEventListener('abort', aborted, { once: true });
            if (signal?.aborted) finish([]);
        });
    }
    function online(deviceId) { return [...clients.values()].some(client => client.deviceId === deviceId && now() - client.seenAt < 45000); }
    async function read(source, devices, start, end, signal) {
        if (end - start + 1 > MAX_CHUNK) throw sourceError('STREAM_RANGE_INVALID');
        const permitted = new Set(devices), active = [...clients.entries()].filter(([, client]) => permitted.has(client.deviceId) && now() - client.seenAt < 45000).map(([key]) => key);
        if (!active.length) throw sourceError('STREAM_PROVIDER_OFFLINE');
        const cancel = new AbortController(), combined = signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal;
        let cursor = 0;
        const ask = providerKey => {
            const client = clients.get(providerKey), deviceId = client?.deviceId;
            if (!client) throw sourceError('STREAM_PROVIDER_OFFLINE');
            if (combined.aborted) throw sourceError('STREAM_READ_CANCELLED');
            if (pending.size >= 32 || [...pending.values()].filter(v => v.deviceId === deviceId).length >= 4) throw sourceError('STREAM_PROVIDER_BUSY');
            return new Promise((resolve, reject) => {
                    const requestId = crypto.randomUUID();
                    const cleanup = () => { clearTimeout(timer); combined.removeEventListener('abort', abort); pending.delete(requestId); client.queue = client.queue.filter(v => v.requestId !== requestId); };
                    const finish = (error, value) => { cleanup(); error ? reject(error) : resolve(Readable.from(value)); };
                    const abort = () => finish(sourceError('STREAM_READ_CANCELLED'));
                    const timer = setTimeout(() => finish(sourceError('STREAM_PROVIDER_TIMEOUT')), timeout); timer.unref?.();
                    pending.set(requestId, { deviceId, size: end - start + 1, finish });
                    client.queue.push({ requestId, source, start, end });
                    combined.addEventListener('abort', abort, { once: true });
                    if (client.wake) client.wake(client.queue.splice(0, 4));
            });
        };
        // Two bounded candidates avoid waiting 15 seconds for a silent first
        // provider. Losing requests are cancelled; no media copy is retained.
        const worker = async (_value, workerIndex) => {
            if (workerIndex) await new Promise(resolve => {
                const finish = () => { clearTimeout(timer); combined.removeEventListener('abort', finish); resolve(); };
                const timer = setTimeout(finish, hedgeMs); timer.unref?.(); combined.addEventListener('abort', finish, { once: true }); if (combined.aborted) finish();
            });
            let last;
            while (cursor < active.length && !combined.aborted) { const deviceId = active[cursor++]; try { return await ask(deviceId); } catch (error) { last = error; } }
            throw last || sourceError('STREAM_SOURCE_MISSING');
        };
        try { return await Promise.any(Array.from({ length: Math.min(2, active.length) }, worker)); }
        catch (error) { throw error.errors?.find(value => value.message !== 'STREAM_READ_CANCELLED') || sourceError('STREAM_READ_CANCELLED'); }
        finally { cancel.abort(); }
    }
    function provide(deviceId, requestId, buffer, error) {
        const request = pending.get(requestId);
        if (!request || request.deviceId !== deviceId) throw sourceError('STREAM_REQUEST_EXPIRED');
        if (!error && (!Buffer.isBuffer(buffer) || buffer.length !== request.size)) throw sourceError('STREAM_RANGE_INVALID');
        request.finish(error ? sourceError(error === 'missing' ? 'STREAM_SOURCE_MISSING' : 'STREAM_PROVIDER_UNAVAILABLE') : null, buffer);
    }
    function close() { clients.forEach(client => client.wake?.([])); [...pending.values()].forEach(request => request.finish(sourceError('STREAM_READ_CANCELLED'))); }
    return { poll, read, provide, online, close };
}
function createStreamingSources({ disk, tunnel, broker = createStreamingBroker() }) {
    function stat(source) {
        if (source.kind === 'disk') return disk.stat(source);
        if (source.kind === 'tunnel') return tunnel.stat(source);
        if (source.kind === 'local') return source;
        throw sourceError('STREAM_SOURCE_INVALID');
    }
    async function read(source, start, end, signal, sourceDeviceId) {
        const metadata = stat(source);
        if (start < 0 || end >= metadata.size) throw sourceError('STREAM_RANGE_INVALID');
        if (source.kind === 'disk') return disk.read(source, start, end, signal);
        if (metadata.inline) return Readable.from(metadata.inline.subarray(start, end + 1));
        return broker.read(source, source.kind === 'local' ? [sourceDeviceId || source.deviceId]
            : [sourceDeviceId, ...tunnel.providers(source)].filter(Boolean), start, end, signal);
    }
    async function text(source, sourceDeviceId) {
        const metadata = stat(source);
        if (metadata.size > 2 * MAX_CHUNK) throw sourceError('STREAM_DOCUMENT_TOO_LARGE');
        const chunks = [];
        for (let start = 0; start < metadata.size; start += MAX_CHUNK) {
            const stream = await read(source, start, Math.min(metadata.size - 1, start + MAX_CHUNK - 1), undefined, sourceDeviceId);
            for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString('utf8');
    }
    async function resolve(input, actor, req, allowAnyFile = false) {
        let resolved;
        if (input.kind === 'disk') resolved = disk.resolve(req, input);
        else if (input.kind === 'tunnel') resolved = tunnel.resolve(input, actor);
        else if (input.kind === 'local') {
            if (!/^[\w-]{1,128}$/.test(input.fileId || '') || !Number.isSafeInteger(input.size) || input.size < 0 || input.size > 8 * 1024 ** 3) throw sourceError('STREAM_SOURCE_INVALID');
            resolved = { source: { kind: 'local', deviceId: actor.deviceId, fileId: input.fileId,
                name: String(input.name || '').slice(0, 255), type: String(input.type || '').slice(0, 100), size: input.size },
                name: input.name, type: input.type, size: input.size };
        } else throw sourceError('STREAM_SOURCE_INVALID');
        let kind; try { kind = mediaKind(resolved.name, resolved.type); } catch (error) { if (!allowAnyFile) throw error; kind = 'file'; }
        if (kind === 'markdown') {
            const body = await text(resolved.source, actor.deviceId);
            const references = [];
            for (const match of body.matchAll(REF)) {
                if (references.some(ref => ref.url === match[0])) continue;
                if (references.length >= 100) throw sourceError('STREAM_REFERENCE_LIMIT');
                try {
                    const ref = tunnel.resolve({ kind: 'tunnel', sessionId: match[1], messageId: match[2], fileId: match[3],
                        accessGrant: input.tunnelGrants?.[match[1]] }, actor);
                    references.push({ id: crypto.randomUUID(), url: match[0], source: ref.source });
                } catch (_) { /* An unreadable reference does not invalidate the readable Markdown document. */ }
            }
            resolved.references = references;
        }
        return resolved;
    }
    return { resolve, stat, read, text, broker, MAX_CHUNK };
}
module.exports = { createStreamingSources, createStreamingBroker, MAX_CHUNK };
