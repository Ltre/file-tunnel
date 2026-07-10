(function () {
    const sessions = new Map();
    let rootPromise = null;

    function safeName(value) {
        return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 160) || `cache-${Date.now()}`;
    }

    async function getCacheDirectory() {
        if (!navigator.storage?.getDirectory) {
            throw new Error('opfs-unavailable');
        }
        if (!rootPromise) {
            rootPromise = navigator.storage.getDirectory()
                .then(root => root.getDirectoryHandle('drop2tunnel-file-cache', { create: true }));
        }
        return rootPromise;
    }

    async function removeEntryIfExists(directory, name) {
        try {
            await directory.removeEntry(name);
        } catch (err) {
            if (err?.name !== 'NotFoundError') throw err;
        }
    }

    async function handleProbe() {
        const directory = await getCacheDirectory();
        const name = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
        const handle = await directory.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(new Uint8Array([1, 2, 3]));
        await writable.close();
        await removeEntryIfExists(directory, name);
        return { ok: true, driver: 'opfs' };
    }

    async function handleStart(message) {
        const directory = await getCacheDirectory();
        const fileId = safeName(message.fileId);
        const name = `${fileId}.bin`;
        await removeEntryIfExists(directory, name);
        const handle = await directory.getFileHandle(name, { create: true });
        const writable = await handle.createWritable({ keepExistingData: false });
        sessions.set(message.transferId, {
            fileId,
            name,
            handle,
            writable,
            size: Number(message.size) || 0,
            written: 0
        });
        return { ok: true, driver: 'opfs' };
    }

    async function handleWrite(message) {
        const session = sessions.get(message.transferId);
        if (!session) throw new Error('cache-write-session-missing');
        const chunk = message.chunk;
        const offset = Number(message.offset);
        if (!Number.isFinite(offset) || offset < 0) throw new Error('invalid-cache-write-offset');
        await session.writable.write({ type: 'write', position: offset, data: chunk });
        session.written = Math.max(session.written, offset + (chunk?.byteLength || chunk?.size || 0));
        return { ok: true, written: session.written };
    }

    async function handleCommit(message) {
        const session = sessions.get(message.transferId);
        if (!session) throw new Error('cache-commit-session-missing');
        sessions.delete(message.transferId);
        await session.writable.close();
        const file = await session.handle.getFile();
        if (session.size > 0 && file.size !== session.size) {
            await removeEntryIfExists(await getCacheDirectory(), session.name);
            throw new Error(`cache-size-mismatch:${file.size}/${session.size}`);
        }
        return {
            ok: true,
            ref: {
                driver: 'opfs',
                path: session.name,
                size: file.size,
                complete: true,
                committedAt: Date.now()
            }
        };
    }

    async function handleAbort(message) {
        const session = sessions.get(message.transferId);
        if (session) {
            sessions.delete(message.transferId);
            try {
                if (typeof session.writable.abort === 'function') await session.writable.abort();
                else await session.writable.close();
            } catch (_) {}
            await removeEntryIfExists(await getCacheDirectory(), session.name);
        }
        return { ok: true };
    }

    async function handleRead(message) {
        const directory = await getCacheDirectory();
        const name = safeName(message.path);
        const handle = await directory.getFileHandle(name);
        const file = await handle.getFile();
        return { ok: true, data: await file.arrayBuffer(), size: file.size };
    }

    async function handleReadRange(message) {
        const directory = await getCacheDirectory();
        const name = safeName(message.path);
        const handle = await directory.getFileHandle(name);
        const file = await handle.getFile();
        const start = Math.max(0, Number(message.start) || 0);
        const end = Math.min(file.size, Math.max(start, Number(message.end) || file.size));
        return { ok: true, data: await file.slice(start, end).arrayBuffer(), size: file.size, start, end };
    }

    async function handleDelete(message) {
        const directory = await getCacheDirectory();
        await removeEntryIfExists(directory, safeName(message.path));
        return { ok: true };
    }

    const handlers = {
        probe: handleProbe,
        start: handleStart,
        write: handleWrite,
        commit: handleCommit,
        abort: handleAbort,
        read: handleRead,
        readRange: handleReadRange,
        delete: handleDelete
    };

    self.onmessage = event => {
        const message = event.data || {};
        const handler = handlers[message.type];
        if (!handler) {
            self.postMessage({ id: message.id, ok: false, error: 'unknown-cache-command' });
            return;
        }
        Promise.resolve()
            .then(() => handler(message))
            .then(result => self.postMessage({ id: message.id, ok: true, ...result }))
            .catch(err => self.postMessage({ id: message.id, ok: false, error: err?.message || String(err) }));
    };
})();
