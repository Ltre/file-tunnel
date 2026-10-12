(function attachDiskPendingSave(global) {
    'use strict';
    const DB_NAME = 'Drop2TunnelPendingDiskSaves';
    const STORE = 'records';
    const adapters = new Map();
    const active = new Map();
    let database;
    const versionOf = task => `${Number(task?.completedAt) || 0}-${Number(task?.outputFileSize) || 0}`;
    const sourceTypes = new Set(['sns', 'youtube']);
    const uuid = () => {
        if (global.crypto?.randomUUID) return global.crypto.randomUUID();
        const bytes = new Uint8Array(16);
        if (global.crypto?.getRandomValues) global.crypto.getRandomValues(bytes);
        else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
        bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    };
    const validId = id => /^[-a-zA-Z0-9_]{8,100}$/.test(String(id || ''));

    function openDatabase() {
        if (!global.indexedDB) return Promise.reject(new Error('当前浏览器不支持持久待转存记录'));
        if (!database) database = new Promise((resolve, reject) => {
            const request = global.indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => { database = null; reject(request.error || new Error('待转存数据库打开失败')); };
        });
        return database;
    }
    async function get(id) {
        if (!validId(id)) throw new Error('待转存记录标识无效');
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const request = db.transaction(STORE).objectStore(STORE).get(id);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('待转存记录读取失败'));
        });
    }
    async function list() {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const request = db.transaction(STORE).objectStore(STORE).getAll();
            request.onsuccess = () => resolve((request.result || []).sort((a, b) => b.createdAt - a.createdAt));
            request.onerror = () => reject(request.error || new Error('待转存记录读取失败'));
        });
    }
    async function put(record) {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE, 'readwrite');
            transaction.objectStore(STORE).put(record);
            transaction.oncomplete = () => resolve(record);
            transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('待转存记录保存失败'));
        });
    }
    async function update(id, changes) {
        const allowed = ['status', 'target', 'operationId', 'result', 'error', 'attemptedAt', 'completedAt'];
        const safe = Object.fromEntries(Object.entries(changes || {}).filter(([key]) => allowed.includes(key)));
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE, 'readwrite');
            const store = transaction.objectStore(STORE), request = store.get(id);
            let next;
            request.onsuccess = () => {
                if (!request.result) { transaction.abort(); reject(new Error('待转存记录不存在，请从后台重新发起')); return; }
                next = { ...request.result, ...safe, updatedAt: Date.now() };
                store.put(next);
            };
            transaction.oncomplete = () => resolve(next);
            transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('待转存记录保存失败'));
        });
    }
    function cacheFor(source) {
        if (!sourceTypes.has(source)) throw new Error('待转存来源无效');
        if (!adapters.has(source)) {
            const factory = source === 'sns' ? global.createSnsDownloadBrowserCache : global.createYoutubePremiumBrowserCache;
            if (!factory) throw new Error('来源缓存组件尚未加载，请刷新页面');
            adapters.set(source, factory());
        }
        return adapters.get(source);
    }
    function safeSource(task) {
        let url = '';
        try {
            const parsed = new URL(task.url || task.sourceUrl || '');
            if (['https:', 'http:'].includes(parsed.protocol)) {
                url = parsed.origin + parsed.pathname;
                if (parsed.searchParams.has('v')) url += '?v=' + encodeURIComponent(parsed.searchParams.get('v'));
            }
        } catch (_) {}
        return { title: String(task.title || '').slice(0, 1000), url, platform: String(task.platform || '').slice(0, 40), remark: String(task.remark || '').slice(0, 5000) };
    }
    async function verifySource(record) {
        const root = record.source === 'sns' ? '/api/sns-dl' : '/api/youtube-premium';
        const response = await global.fetch(root + '/tasks/' + encodeURIComponent(record.task.id), { cache: 'no-store', credentials: 'same-origin' });
        if ([401, 403].includes(response.status)) throw new Error('后台登录已失效，请登录后台后继续转存；待转存记录及缓存已保留');
        if (response.status === 404) throw new Error('来源任务已删除，无法确认当前版本；待转存缓存已保留，请检查来源任务');
        if (!response.ok) throw new Error('无法核验来源任务版本：HTTP ' + response.status + '；待转存记录已保留');
        const data = await response.json().catch(() => null), task = data?.task || data;
        if (!task?.id || String(task.id) !== record.task.id || versionOf(task) !== record.version) throw new Error('来源任务版本已变化，不会用新正文替换旧缓存；请取消旧待转存记录，再从后台重新发起');
        return task;
    }
    async function prepare({ source, task, cache, ensureCache, onStatus = () => {} }) {
        if (!sourceTypes.has(source) || !task?.id || !Number(task.completedAt) || !Number.isSafeInteger(Number(task.outputFileSize)) || Number(task.outputFileSize) <= 0) {
            throw new Error('仅可转存已完成且文件信息完整的任务，请刷新后台任务记录');
        }
        const prepareOne = async () => {
            const version = versionOf(task);
            const existing = (await list()).find(record => record.source === source && record.task.id === String(task.id) && record.version === version && record.status !== 'cancelled');
            cache ||= cacheFor(source);
            adapters.set(source, cache);
            if (existing) {
                if (existing.status === 'preparing') {
                    await verifySource(existing);
                    const pinned = await cache.pin(existing.task, existing.id);
                    existing.file = { name: pinned.name, size: pinned.size, type: pinned.type };
                    existing.cache = { taskId: pinned.id, version: pinned.version };
                    existing.status = 'pending'; existing.updatedAt = Date.now(); await put(existing);
                }
                return existing;
            }
            await verifySource({ source, task: { ...task, id: String(task.id) }, version });
            onStatus('正在检查浏览器缓存…');
            let state = await cache.inspect(task);
            if (state.status !== 'cached') {
                if (!task.hasFile || !task.downloadUrl) throw new Error('浏览器缓存缺失且服务端成品不可用，无法转存；请重新抓取或补齐缓存');
                const approved = ensureCache ? await ensureCache(task) : global.confirm?.('该成品尚未完整缓存到浏览器。现在补充缓存并继续转存到网盘？');
                if (!approved) return null;
                onStatus('正在补充浏览器缓存…');
                await cache.store(task);
                state = await cache.inspect(task);
                if (state.status !== 'cached') throw new Error('缓存未完整保存，请重试后转存');
            }
            const record = { id: uuid(), source, version,
                task: { id: String(task.id), completedAt: Number(task.completedAt), outputFileSize: Number(task.outputFileSize), outputFileName: String(task.outputFileName || task.title || 'downloaded-file') },
                sourceInfo: safeSource(task), file: { name: String(task.outputFileName || 'downloaded-file'), size: Number(task.outputFileSize), type: 'application/octet-stream' },
                status: 'preparing', target: null, createdAt: Date.now(), updatedAt: Date.now() };
            await put(record);
            try {
                const pinned = await cache.pin(task, record.id);
                record.file = { name: pinned.name, size: pinned.size, type: pinned.type };
                record.cache = { taskId: pinned.id, version: pinned.version };
                record.status = 'pending';
                await put(record);
            } catch (error) {
                await update(record.id, { status: 'cancelled', error: error.message }).catch(() => {});
                await cache.unpin(task.id, record.id).catch(() => {});
                throw error;
            }
            return record;
        };
        return global.navigator?.locks ? global.navigator.locks.request('disk-pending-prepare:' + source + ':' + task?.id, prepareOne) : prepareOne();
    }
    function open(record) {
        if (!validId(record?.id)) throw new Error('待转存记录标识无效');
        const url = '/disk?pendingSave=' + encodeURIComponent(record.id);
        const tab = global.open?.(url, '_blank', 'noopener');
        // Some browsers return null with noopener even when the tab did open;
        // expose a regular link to the caller rather than creating a second tab.
        return { id: record.id, url, tab };
    }
    async function getBlob(record) {
        if (record.version !== versionOf(record.task)) throw new Error('待转存任务版本无效，请重新发起');
        const cache = cacheFor(record.source), cached = await cache.getRecord(record.task.id);
        if (cached?.version !== record.version || !cached.pendingTransferPins?.includes(record.id)) throw new Error('待转存缓存引用已失效，请回后台检查缓存');
        const blob = await cache.getBlob(record.task);
        if (!blob || blob.size !== record.file.size) throw new Error('待转存文件缓存不完整，请补充缓存后继续');
        return blob;
    }
    async function complete(id, result) {
        const record = await update(id, { status: 'completed', completedAt: Date.now(), result, error: '' });
        await cacheFor(record.source).unpin(record.task.id, record.id);
        return record;
    }
    async function cancel(id) {
        const operation = () => cancelUnlocked(id);
        return global.navigator?.locks ? global.navigator.locks.request('disk-pending-resume:' + id, operation) : operation();
    }
    async function cancelUnlocked(id) {
        const record = await get(id);
        if (!record) return null;
        if (record.status === 'completed') return record;
        if (['uploading', 'verification-required'].includes(record.status)) throw new Error('上传结果尚未确认，请先核验任务结果后再取消待转存记录');
        const next = await update(id, { status: 'cancelled' });
        await cacheFor(record.source).unpin(record.task.id, id);
        return next;
    }
    async function resume(id, hooks) {
        if (active.has(id)) return active.get(id);
        const execute = async () => {
            let record = await get(id);
            if (!record) throw new Error('待转存记录不在此浏览器中，请在原浏览器打开网盘');
            if (record.status === 'completed') { await cacheFor(record.source).unpin(record.task.id, record.id); await hooks.onCompleted?.(record); return record; }
            if (record.status === 'cancelled') throw new Error('这条待转存记录已取消，请回后台重新发起');
            if (record.status === 'preparing') throw new Error('上次缓存引用准备未完成，请在后台重新发起转存');
            if (['uploading', 'verification-required'].includes(record.status)) {
                if (!hooks.lookup) throw new Error('上次上传结果尚未确认，请核验网盘任务后继续，未重复上传');
                const found = await hooks.lookup(record);
                if (found?.status === 'completed') { record = await complete(id, found.result); await hooks.onCompleted?.(record); return record; }
                if (found?.status !== 'missing' && !(found?.status === 'failed' && found.retryable === true)) {
                    await hooks.onStatus?.('上次转存仍在处理，请等待或在任务列表查看结果'); return record;
                }
                record = await update(id, { status: 'failed' });
            }
            const blob = await getBlob(record);
            const account = await hooks.chooseAccount(record);
            if (!account) return record;
            const target = await hooks.chooseTarget(record, account);
            if (!target) return record;
            if (!target.accountId || !target.partitionId || typeof target.path !== 'string') throw new Error('请选择有效的账号、分区和目标目录');
            await hooks.verifyTarget?.(record, target);
            await verifySource(record);
            if (!await hooks.confirm(record, target)) return record;
            record = await update(id, { status: 'uploading', target, attemptedAt: Date.now(), error: '' });
            try {
                const result = await hooks.upload(record, blob, target, { pendingSaveId: id, sourceInfo: record.sourceInfo });
                record = await complete(id, result);
            } catch (error) {
                if ((await get(id))?.status !== 'completed') await update(id, { status: 'verification-required', error: String(error.message || error).slice(0, 1000) });
                throw error;
            }
            await hooks.onCompleted?.(record);
            return record;
        };
        const promise = (global.navigator?.locks ? global.navigator.locks.request('disk-pending-resume:' + id, execute) : execute()).finally(() => active.delete(id));
        active.set(id, promise);
        return promise;
    }
    global.DiskPendingSave = { prepare, open, get, list, update, getBlob, complete, cancel, resume, verifySource, _test: { versionOf, safeSource, cacheFor } };
})(window);
