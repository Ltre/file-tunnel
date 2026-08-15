(function attachYoutubePremiumBrowserCache(global) {
    const DB_NAME = 'Drop2TunnelYoutubePremiumCache';
    const STORE_NAME = 'files';
    const FILE_ID_PREFIX = 'youtube-premium-';

    function taskVersion(task) {
        return `${Number(task?.completedAt) || 0}-${Number(task?.outputFileSize) || 0}`;
    }

    function dataSize(data) {
        if (!data) return 0;
        if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
        if (data instanceof ArrayBuffer) return data.byteLength;
        if (ArrayBuffer.isView(data)) return data.byteLength;
        return 0;
    }

    class YoutubePremiumBrowserCache {
        constructor(options = {}) {
            this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
            this.dbPromise = null;
            this.cacheStorePromise = global.createDrop2TunnelCacheStore
                ? global.createDrop2TunnelCacheStore({ log: () => {} })
                : Promise.resolve(null);
        }

        openDatabase() {
            if (!global.indexedDB) return Promise.reject(new Error('browser-cache-indexeddb-unavailable'));
            if (!this.dbPromise) {
                this.dbPromise = new Promise((resolve, reject) => {
                    const request = indexedDB.open(DB_NAME, 1);
                    request.onupgradeneeded = () => {
                        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                            request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
                        }
                    };
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error || new Error('browser-cache-open-failed'));
                });
            }
            return this.dbPromise;
        }

        async getRecord(taskId) {
            const db = await this.openDatabase();
            return new Promise((resolve, reject) => {
                const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(taskId);
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => reject(request.error || new Error('browser-cache-read-failed'));
            });
        }

        async writeRecord(record) {
            const db = await this.openDatabase();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(STORE_NAME, 'readwrite');
                transaction.objectStore(STORE_NAME).put(record);
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error || new Error('browser-cache-write-failed'));
                transaction.onabort = () => reject(transaction.error || new Error('browser-cache-write-aborted'));
            });
        }

        async deleteRecord(record) {
            if (!record) return;
            const cacheStore = await this.cacheStorePromise;
            if (record.cacheStoreRef) await cacheStore?.deleteReference(record).catch(() => {});
            const db = await this.openDatabase();
            await new Promise((resolve, reject) => {
                const transaction = db.transaction(STORE_NAME, 'readwrite');
                transaction.objectStore(STORE_NAME).delete(record.id);
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error || new Error('browser-cache-delete-failed'));
                transaction.onabort = () => reject(transaction.error || new Error('browser-cache-delete-aborted'));
            });
        }

        async inspect(task) {
            const record = await this.getRecord(task.id);
            if (!record) return { status: 'missing' };
            if (record.version !== taskVersion(task)) {
                await this.deleteRecord(record);
                return { status: 'missing' };
            }
            if (record.status === 'cleared') return { status: 'cleared' };
            const cacheStore = await this.cacheStorePromise;
            if (cacheStore?.hasComplete(record, { size: Number(task.outputFileSize) || 0 })) {
                return { status: 'cached' };
            }
            await this.deleteRecord(record);
            return { status: 'missing' };
        }

        async store(task) {
            if (!task?.downloadUrl) throw new Error('browser-cache-source-missing');
            const cacheStore = await this.cacheStorePromise;
            if (!cacheStore?.beginWrite) throw new Error('browser-cache-store-unavailable');
            const response = await fetch(task.downloadUrl, { cache: 'no-store', credentials: 'same-origin' });
            if (response.status === 401) throw new Error('browser-cache-auth-required');
            if (!response.ok) throw new Error(`browser-cache-http-${response.status}`);

            const expected = Number(task.outputFileSize) || Number(response.headers.get('Content-Length')) || 0;
            const version = taskVersion(task);
            const writer = await cacheStore.beginWrite({
                id: `${FILE_ID_PREFIX}${task.id}-${version}`,
                name: task.outputFileName || 'youtube-premium-file',
                type: response.headers.get('Content-Type') || 'application/octet-stream',
                size: expected
            });
            let received = 0;
            let committed = null;
            try {
                if (response.body?.getReader) {
                    const reader = response.body.getReader();
                    while (true) {
                        const result = await reader.read();
                        if (result.done) break;
                        await writer.writeChunk(result.value, received);
                        received += result.value.byteLength;
                        this.onProgress(task.id, expected ? received / expected * 100 : 0);
                    }
                } else {
                    const data = await response.arrayBuffer();
                    await writer.writeChunk(data, 0);
                    received = data.byteLength;
                }
                if (expected && received !== expected) throw new Error(`browser-cache-size-mismatch:${received}/${expected}`);
                committed = await writer.commit();
                const storedSize = dataSize(committed.data) || Number(committed.cacheStoreRef?.size) || 0;
                if (expected && storedSize !== expected) throw new Error(`browser-cache-size-mismatch:${storedSize}/${expected}`);

                const previous = await this.getRecord(task.id);
                const record = {
                    id: task.id,
                    version,
                    name: task.outputFileName || 'youtube-premium-file',
                    type: response.headers.get('Content-Type') || 'application/octet-stream',
                    size: storedSize,
                    data: committed.data,
                    cacheStoreRef: committed.cacheStoreRef || null,
                    cacheStorage: committed.cacheStorage || 'indexeddb',
                    cachedAt: Date.now()
                };
                await this.writeRecord(record);
                if (previous?.cacheStoreRef?.path !== record.cacheStoreRef?.path) {
                    await cacheStore.deleteReference(previous).catch(() => {});
                }
                this.onProgress(task.id, 100);
                return { status: 'cached' };
            } catch (error) {
                if (!committed) await writer.abort().catch(() => {});
                else if (committed.cacheStoreRef) await cacheStore.deleteReference(committed).catch(() => {});
                throw error;
            }
        }

        async clear(task) {
            await this.deleteRecord(await this.getRecord(task.id));
            await this.writeRecord({ id: task.id, version: taskVersion(task), status: 'cleared', clearedAt: Date.now() });
            return { status: 'cleared' };
        }

        async getBlob(task) {
            const record = await this.getRecord(task.id);
            const cacheStore = await this.cacheStorePromise;
            if (record?.version !== taskVersion(task) || !cacheStore?.hasComplete(record, { size: task.outputFileSize })) {
                return null;
            }
            const materialized = dataSize(record.data) ? record : await cacheStore.materialize(record);
            if (!dataSize(materialized?.data)) return null;
            return materialized.data instanceof Blob
                ? materialized.data
                : new Blob([materialized.data], { type: record.type || 'application/octet-stream' });
        }
    }

    global.createYoutubePremiumBrowserCache = options => new YoutubePremiumBrowserCache(options);
})(window);
