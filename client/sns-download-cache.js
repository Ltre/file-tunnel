(function attachSnsDownloadBrowserCache(global) {
    const DB_NAME = 'Drop2TunnelSnsDownloadCache';
    const STORE_NAME = 'files';

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

    class SnsDownloadBrowserCache {
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
                const store = transaction.objectStore(STORE_NAME);
                const current = store.get(record.id);
                current.onsuccess = () => {
                    if (current.result?.pendingTransferPins?.length) {
                        transaction.abort();
                        reject(new Error('该缓存仍被待转存记录使用，请先完成或取消网盘转存后再更新缓存。'));
                        return;
                    }
                    store.put({ ...record, pendingTransferPins: current.result?.pendingTransferPins || [] });
                };
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error || new Error('browser-cache-write-failed'));
                transaction.onabort = () => reject(transaction.error || new Error('browser-cache-write-aborted'));
            });
        }

        async getAllRecords() {
            const db = await this.openDatabase();
            return new Promise((resolve, reject) => {
                const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll();
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error || new Error('browser-cache-list-failed'));
            });
        }

        async deleteRecord(record) {
            if (global.navigator?.locks) return global.navigator.locks.request('disk-pending-cache:' + DB_NAME + ':' + record?.id, () => this.deleteRecordUnlocked(record));
            return this.deleteRecordUnlocked(record);
        }

        async deleteRecordUnlocked(record) {
            if (!record) return;
            const cacheStore = await this.cacheStorePromise;
            const db = await this.openDatabase();
            await new Promise((resolve, reject) => {
                const transaction = db.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const current = store.get(record.id);
                current.onsuccess = () => {
                    if (current.result?.pendingTransferPins?.length) {
                        transaction.abort();
                        reject(new Error('该缓存正在用于待转存到网盘的记录，请先完成或取消转存；缓存已保留。'));
                        return;
                    }
                    store.delete(record.id);
                };
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error || new Error('browser-cache-delete-failed'));
                transaction.onabort = () => reject(transaction.error || new Error('browser-cache-delete-aborted'));
            });
            if (record.cacheStoreRef) await cacheStore?.deleteReference(record).catch(() => {});
        }

        async pin(task, pendingId) {
            if (global.navigator?.locks) return global.navigator.locks.request('disk-pending-cache:' + DB_NAME + ':' + task.id, () => this.pinUnlocked(task, pendingId));
            return this.pinUnlocked(task, pendingId);
        }

        async pinUnlocked(task, pendingId) {
            const cacheStore = await this.cacheStorePromise;
            const db = await this.openDatabase();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.get(task.id);
                let pinned;
                request.onsuccess = () => {
                    pinned = request.result;
                    if (pinned?.version !== taskVersion(task) || !cacheStore?.hasComplete(pinned, { size: Number(task.outputFileSize) || 0 })) {
                        transaction.abort(); reject(new Error('缓存缺失、文件不完整或版本已变化，请重新缓存后转存。')); return;
                    }
                    pinned.pendingTransferPins = [...new Set([...(pinned.pendingTransferPins || []), pendingId])];
                    store.put(pinned);
                };
                transaction.oncomplete = () => resolve({ id: pinned.id, version: pinned.version, name: pinned.name, size: pinned.size, type: pinned.type });
                transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('待转存缓存引用保存失败'));
            });
        }

        async unpin(taskId, pendingId) {
            const db = await this.openDatabase();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.get(taskId);
                request.onsuccess = () => { if (request.result) store.put({ ...request.result, pendingTransferPins: (request.result.pendingTransferPins || []).filter(id => id !== pendingId) }); };
                transaction.oncomplete = () => resolve();
                transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('待转存缓存引用释放失败'));
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
            if (cacheStore?.hasComplete(record, { size: Number(task.outputFileSize) || 0 })) return { status: 'cached' };
            await this.deleteRecord(record);
            return { status: 'missing' };
        }

        cancelAutomatic(taskId) { this.automaticControllers?.get(taskId)?.abort(); }
        async store(task, options = {}) {
            if(!options.automatic){if(global.navigator?.locks)return global.navigator.locks.request('disk-pending-cache:' + DB_NAME + ':' + task.id,()=>this.storeUnlocked(task));return this.storeUnlocked(task);}
            const controller=new AbortController();this.automaticControllers ||= new Map();
            let timer,checking=false;
            const check=async()=>{if(checking||controller.signal.aborted)return;checking=true;try{const response=await fetch(task.downloadUrl.replace(/\/file(?:\?.*)?$/,''),{cache:'no-store',credentials:'same-origin',signal:controller.signal});if(!response.ok)throw Error('无法核验自动缓存设置');const current=await response.json();if(current.autoCacheEnabled===false)controller.abort();}finally{checking=false;}};
            if(options.automatic){this.automaticControllers.set(task.id,controller);try{await check();controller.signal.throwIfAborted();}catch(error){this.automaticControllers.delete(task.id);throw error;}controller.signal.throwIfAborted();timer=setInterval(()=>check().catch(()=>{}),1000);}
            try { const run=()=>{controller.signal.throwIfAborted();return this.storeUnlocked(task,{signal:controller.signal,automatic:true,beforeCommit:check});};
                if (global.navigator?.locks) return await global.navigator.locks.request('disk-pending-cache:' + DB_NAME + ':' + task.id, run);
                return await run();
            }catch(error){try{await check();}catch(_){}if(controller.signal.aborted)throw new DOMException('已停止自动缓存到浏览器','AbortError');throw error;}finally{clearInterval(timer);if(this.automaticControllers.get(task.id)===controller)this.automaticControllers.delete(task.id);}
        }

        async storeUnlocked(task, options = {}) {
            if (!task?.downloadUrl) throw new Error('browser-cache-source-missing');
            const cacheStore = await this.cacheStorePromise;
            const pinned = await this.getRecord(task.id);
            if (pinned?.pendingTransferPins?.length) {
                if (pinned.version === taskVersion(task) && cacheStore?.hasComplete(pinned, { size: Number(task.outputFileSize) || 0 })) return { status: 'cached' };
                throw new Error('该任务的旧版本缓存仍用于待转存，请先完成或取消网盘转存后再缓存新版本。');
            }
            if (!cacheStore?.beginWrite) throw new Error('browser-cache-store-unavailable');
            const response = await fetch(task.downloadUrl, { cache: 'no-store', credentials: 'same-origin', signal: options.signal, headers: options.automatic?{'X-Task-Auto-Cache':'1'}:{} });
            if (response.status === 401) throw new Error('browser-cache-auth-required');
            if (!response.ok) throw new Error(`browser-cache-http-${response.status}`);
            const expected = Number(task.outputFileSize) || Number(response.headers.get('Content-Length')) || 0;
            const version = taskVersion(task);
            const writer = await cacheStore.beginWrite({
                id: `sns-download-${task.id}-${version}`,
                name: task.outputFileName || 'sns-media',
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
                await options.beforeCommit?.(); options.signal?.throwIfAborted();
                committed = await writer.commit();
                const storedSize = dataSize(committed.data) || Number(committed.cacheStoreRef?.size) || 0;
                if (expected && storedSize !== expected) throw new Error(`browser-cache-size-mismatch:${storedSize}/${expected}`);
                const previous = await this.getRecord(task.id);
                const record = {
                    id: task.id, version, name: task.outputFileName || 'sns-media',
                    type: response.headers.get('Content-Type') || 'application/octet-stream',
                    size: storedSize, data: committed.data ? new Blob([committed.data], { type: response.headers.get('Content-Type') || 'application/octet-stream' }) : undefined, cacheStoreRef: committed.cacheStoreRef || null,
                    cacheStorage: committed.cacheStorage || 'indexeddb', cachedAt: Date.now()
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

        async cleanupOrphans(validTaskIds) {
            const valid = new Set((Array.isArray(validTaskIds) ? validTaskIds : []).map(String));
            const records = await this.getAllRecords();
            const orphans = records.filter(record => !valid.has(String(record.id)));
            const removable = orphans.filter(record => !record.pendingTransferPins?.length);
            for (const record of removable) await this.deleteRecord(record);
            return removable.length;
        }

        async getBlob(task, { pendingId = '' } = {}) {
            const record = await this.getRecord(task.id);
            if (pendingId && !record?.pendingTransferPins?.includes(pendingId)) return null;
            const cacheStore = await this.cacheStorePromise;
            if (record?.version !== taskVersion(task) || !cacheStore?.hasComplete(record, { size: task.outputFileSize })) return null;
            if (record.cacheStoreRef?.driver === 'opfs' && global.navigator?.storage?.getDirectory) {
                const root = await global.navigator.storage.getDirectory();
                const directory = await root.getDirectoryHandle('drop2tunnel-file-cache');
                const file = await (await directory.getFileHandle(record.cacheStoreRef.path)).getFile();
                return file.size === record.size ? file : null;
            }
            const materialized = dataSize(record.data) ? record : await cacheStore.materialize(record);
            if (!dataSize(materialized?.data)) return null;
            return materialized.data instanceof Blob
                ? materialized.data
                : new Blob([materialized.data], { type: record.type || 'application/octet-stream' });
        }
    }

    global.createSnsDownloadBrowserCache = options => new SnsDownloadBrowserCache(options);
})(window);
