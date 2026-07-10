(function attachDrop2TunnelCacheStore(global) {
    const OPFS_MIN_SIZE = 16 * 1024 * 1024;
    const CACHE_WORKER_TIMEOUT_MS = 12000;
    const CACHE_WORKER_WRITE_TIMEOUT_MS = 5000;

    function dataSize(data) {
        if (!data) return 0;
        if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
        if (data instanceof ArrayBuffer) return data.byteLength;
        if (ArrayBuffer.isView(data)) return data.byteLength;
        return 0;
    }

    function toArrayBuffer(data) {
        if (data instanceof ArrayBuffer) return Promise.resolve(data);
        if (ArrayBuffer.isView(data)) {
            return Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        }
        if (typeof Blob !== 'undefined' && data instanceof Blob) return data.arrayBuffer();
        return Promise.reject(new Error('invalid-cache-chunk'));
    }

    function sliceArrayBuffer(data, start, end) {
        if (data instanceof ArrayBuffer) return data.slice(start, end);
        if (ArrayBuffer.isView(data)) {
            return data.buffer.slice(data.byteOffset + start, data.byteOffset + end);
        }
        if (typeof Blob !== 'undefined' && data instanceof Blob) return data.slice(start, end).arrayBuffer();
        return Promise.reject(new Error('invalid-cache-source'));
    }

    class MemoryTempDriver {
        constructor(file, driver = 'memory-temp') {
            this.file = file;
            this.driver = driver;
            this.chunks = new Map();
            this.receivedSize = 0;
        }

        async writeChunk(chunk, offset = this.receivedSize) {
            const buffer = await toArrayBuffer(chunk);
            const safeOffset = Number(offset);
            if (!Number.isFinite(safeOffset) || safeOffset < 0) throw new Error('invalid-cache-write-offset');
            this.chunks.set(safeOffset, buffer);
            this.receivedSize = Math.max(this.receivedSize, safeOffset + buffer.byteLength);
            return { driver: this.driver, written: this.receivedSize };
        }

        async commit() {
            const merged = new Uint8Array(this.receivedSize);
            let cursor = 0;
            Array.from(this.chunks.entries())
                .sort((a, b) => a[0] - b[0])
                .forEach(([offset, chunk]) => {
                    if (offset > cursor) throw new Error('cache-write-gap');
                    if (offset < cursor) throw new Error('cache-write-overlap');
                    merged.set(new Uint8Array(chunk), offset);
                    cursor = offset + chunk.byteLength;
                });
            this.chunks.clear();
            return {
                data: merged.buffer,
                cacheStoreRef: null,
                cacheStorage: 'indexeddb'
            };
        }

        async abort() {
            this.chunks.clear();
            this.receivedSize = 0;
        }
    }

    class IndexedDbBlobDriver extends MemoryTempDriver {
        constructor(file) {
            super(file, 'indexeddb-blob');
        }
    }

    class OpfsCacheDriver {
        constructor(store, file, transferId) {
            this.store = store;
            this.file = file;
            this.transferId = transferId;
            this.driver = 'opfs';
            this.receivedSize = 0;
        }

        async writeChunk(chunk, offset) {
            const buffer = await toArrayBuffer(chunk);
            await this.store.callWorker('write', {
                transferId: this.transferId,
                offset,
                chunk: buffer
            }, [buffer], CACHE_WORKER_WRITE_TIMEOUT_MS);
            this.receivedSize = Math.max(this.receivedSize, offset + buffer.byteLength);
            return { driver: this.driver, written: this.receivedSize };
        }

        async commit() {
            const result = await this.store.callWorker('commit', { transferId: this.transferId });
            return {
                data: undefined,
                cacheStoreRef: result.ref,
                cacheStorage: 'opfs'
            };
        }

        async abort() {
            await this.store.callWorker('abort', { transferId: this.transferId }).catch(() => {});
        }
    }

    class Drop2TunnelCacheStore {
        constructor(options = {}) {
            this.log = typeof options.log === 'function' ? options.log : () => {};
            this.worker = null;
            this.workerReady = false;
            this.pending = new Map();
            this.writers = new Map();
            this.sequence = 0;
        }

        async init() {
            if (!global.Worker || !navigator.storage?.getDirectory) {
                this.log('cache-store-opfs-skipped', { reason: 'worker-or-opfs-unavailable' });
                return this;
            }
            try {
                this.worker = new Worker('/client/cache-store-worker.js');
                this.worker.onmessage = event => this.handleWorkerMessage(event.data || {});
                await this.callWorker('probe', {}, []);
                this.workerReady = true;
                this.log('cache-store-opfs-ready', { minSize: OPFS_MIN_SIZE });
            } catch (err) {
                this.workerReady = false;
                if (this.worker) this.worker.terminate();
                this.worker = null;
                this.log('cache-store-opfs-unavailable', { error: err.message });
            }
            return this;
        }

        handleWorkerMessage(message) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.ok === false) pending.reject(new Error(message.error || 'cache-worker-failed'));
            else pending.resolve(message);
        }

        callWorker(type, payload = {}, transfer = [], timeoutMs = CACHE_WORKER_TIMEOUT_MS) {
            if (!this.worker) return Promise.reject(new Error('cache-worker-unavailable'));
            const id = ++this.sequence;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    if (!this.pending.has(id)) return;
                    this.pending.delete(id);
                    this.log('cache-worker-timeout', { type, timeoutMs });
                    reject(new Error(`cache-worker-timeout:${type}`));
                }, timeoutMs);
                this.pending.set(id, {
                    resolve: value => {
                        clearTimeout(timer);
                        resolve(value);
                    },
                    reject: err => {
                        clearTimeout(timer);
                        reject(err);
                    }
                });
                try {
                    this.worker.postMessage({ id, type, ...payload }, transfer);
                } catch (err) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(err);
                }
            });
        }

        shouldUseOpfs(file) {
            return this.workerReady && Number(file?.size) >= OPFS_MIN_SIZE;
        }

        async createWriter(file) {
            if (!file?.id) throw new Error('cache-file-id-required');
            if (!this.shouldUseOpfs(file)) return new IndexedDbBlobDriver(file);
            const transferId = `${file.id || 'file'}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            await this.callWorker('start', {
                transferId,
                fileId: file.id,
                size: Number(file.size) || 0
            });
            return new OpfsCacheDriver(this, file, transferId);
        }

        async ensureWriter(fileId, file = {}) {
            if (!fileId) throw new Error('cache-file-id-required');
            const existing = this.writers.get(fileId);
            if (existing) return existing;
            const writer = await this.createWriter({ ...file, id: fileId });
            this.writers.set(fileId, writer);
            return writer;
        }

        async beginWrite(file) {
            if (!file?.id) throw new Error('cache-file-id-required');
            await this.abort(file.id).catch(() => {});
            const writer = await this.createWriter(file);
            this.writers.set(file.id, writer);
            return {
                driver: writer.driver,
                writeChunk: (chunk, offset) => this.writeChunk(file.id, offset, chunk, file),
                commit: () => this.commit(file.id),
                abort: () => this.abort(file.id)
            };
        }

        async writeChunk(fileId, offset, chunk, file = {}) {
            const writer = await this.ensureWriter(fileId, file);
            return writer.writeChunk(chunk, offset);
        }

        async commit(fileId) {
            const writer = this.writers.get(fileId);
            if (!writer) throw new Error('cache-write-session-missing');
            try {
                return await writer.commit();
            } finally {
                this.writers.delete(fileId);
            }
        }

        async abort(fileId) {
            const writer = this.writers.get(fileId);
            if (!writer) return false;
            this.writers.delete(fileId);
            await writer.abort();
            return true;
        }

        hasComplete(record, fileInfo = null) {
            const size = dataSize(record?.data);
            const expected = Number(fileInfo?.size ?? record?.size);
            if (size > 0) return !Number.isFinite(expected) || expected <= 0 || size === expected;
            return this.isCompleteReference(record, fileInfo);
        }

        isCompleteReference(record, fileInfo = null) {
            const ref = record?.cacheStoreRef;
            if (!ref?.complete) return false;
            const expected = Number(fileInfo?.size ?? record?.size);
            return !Number.isFinite(expected) || expected <= 0 || Number(ref.size) === expected;
        }

        async readRange(record, start = 0, end = null) {
            const sourceSize = dataSize(record?.data) || Number(record?.cacheStoreRef?.size) || Number(record?.size) || 0;
            const safeStart = Math.max(0, Number(start) || 0);
            const safeEnd = end == null ? sourceSize : Math.min(sourceSize, Math.max(safeStart, Number(end) || 0));
            if (dataSize(record?.data) > 0) return sliceArrayBuffer(record.data, safeStart, safeEnd);
            if (record?.cacheStoreRef?.driver !== 'opfs') throw new Error('cache-range-source-missing');
            const result = await this.callWorker('readRange', {
                path: record.cacheStoreRef.path,
                start: safeStart,
                end: safeEnd
            });
            return result.data;
        }

        async materialize(record) {
            if (!record || dataSize(record.data) > 0 || !this.isCompleteReference(record, record)) return record;
            if (record.cacheStoreRef?.driver !== 'opfs') return record;
            const result = await this.callWorker('read', { path: record.cacheStoreRef.path });
            return {
                ...record,
                data: result.data,
                cacheStoreMaterializedAt: Date.now()
            };
        }

        async deleteReference(record) {
            if (record?.cacheStoreRef?.driver !== 'opfs' || !record.cacheStoreRef.path) return false;
            await this.callWorker('delete', { path: record.cacheStoreRef.path });
            return true;
        }
    }

    global.createDrop2TunnelCacheStore = async function createDrop2TunnelCacheStore(options) {
        const store = new Drop2TunnelCacheStore(options);
        return store.init();
    };
})(window);
