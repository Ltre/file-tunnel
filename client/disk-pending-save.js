(function attachDiskPendingSave(global) {
    'use strict';
    const DB_NAME = 'Drop2TunnelPendingDiskSaves';
    const STORE = 'records';
    const adapters = new Map();
    const active = new Map();
    const recordLocks = new Map();
    const receiptChecks = new Map();
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
    const liveRecord = record => !['cancelled', 'superseded'].includes(record.status);

    async function receiptInfo(record, route) {
        const target = record.target;
        if (!target?.accountId || typeof target.diskSpace !== 'string') throw new Error('PENDING_SAVE_RECEIPT_UNCONFIRMED');
        const query = target.diskSpace ? (route.includes('?') ? '&' : '?') + 'disk_space=' + encodeURIComponent(target.diskSpace) : '';
        const controller = global.AbortController ? new global.AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
        try {
            const response = await global.fetch('/api/telegram/drive' + route + query, { cache:'no-store', credentials:'same-origin',
                headers:{ 'X-Disk-Account':target.accountId }, ...(controller ? { signal:controller.signal } : {}) });
            const data = await response.json().catch(() => null);
            if (controller?.signal.aborted) throw Error('PENDING_SAVE_LOOKUP_TIMEOUT');
            if (!response.ok) throw Object.assign(Error(data?.error || 'PENDING_SAVE_RECEIPT_UNCONFIRMED'), { status:response.status });
            return data;
        } catch (error) { if (controller?.signal.aborted) throw Error('PENDING_SAVE_LOOKUP_TIMEOUT'); throw error; }
        finally { if (timer !== null) clearTimeout(timer); }
    }
    async function inspectSaved(record, { force = false } = {}) {
        const key = JSON.stringify([record.id, record.updatedAt, record.target, record.result]);
        const cached = receiptChecks.get(key);
        if (cached?.promise || !force && cached && Date.now() - cached.at < 15000) return cached.promise || cached.value;
        const entry = { at:Date.now() };
        entry.promise = (async () => {
            try {
                let ids = (record.result?.items || []).map(item => item?.id).filter(Boolean);
                if (!ids.length) {
                    const found = await receiptInfo(record, '/pending-saves/' + encodeURIComponent(record.serverTransferId || record.id));
                    ids = (found.result?.items || []).map(item => item?.id).filter(Boolean);
                    if (!ids.length) throw Error('PENDING_SAVE_RECEIPT_UNCONFIRMED');
                }
                const files = [];
                for (const id of ids) {
                    const data = await receiptInfo(record, '/files/' + encodeURIComponent(id)), file = data?.file || data;
                    if (!file || file.id !== id || typeof file.folderPath !== 'string') throw Error('PENDING_SAVE_RECEIPT_UNCONFIRMED');
                    if (file.folderPath !== record.target.path) return { state:'moved', files:[file] };
                    files.push(file);
                }
                return { state:'saved', files };
            } catch (error) {
                const state = ['FILE_NOT_FOUND','DISK_SPACE_NOT_FOUND'].includes(error.message) ? 'missing'
                    : error.status === 401 || error.message === 'LOGIN_REQUIRED' ? 'login-required' : 'unknown';
                return { state, error:error.message };
            }
        })().then(value => { entry.value=value; entry.at=Date.now(); delete entry.promise; return value; });
        receiptChecks.set(key, entry);
        if (receiptChecks.size > 200) receiptChecks.delete(receiptChecks.keys().next().value);
        return entry.promise;
    }
    async function taskStatus({ source, task, force = false }) {
        const record = (await list()).find(record => record.source === source && record.task.id === String(task.id) && record.version === versionOf(task) && liveRecord(record));
        return record?.status === 'completed' ? { record, ...await inspectSaved(record, { force }) } : { record, state:record?.status || 'new' };
    }
    function describeTarget(record) {
        const target = record.target || {};
        return [target.accountName ? target.accountName + ' (' + target.accountId + ')' : target.accountId,
            target.partitionName || target.diskSpace || target.partitionId, '/' + (target.path || '')].filter(Boolean).join(' · ');
    }
    function decorateButton(button, { source, task }) {
        const t = value => global.TunnelI18n?.t(value) || value;
        taskStatus({ source, task }).then(result => {
            if (button.isConnected === false) return;
            const completed = result.record?.status === 'completed' && !['missing','moved'].includes(result.state);
            button.textContent = t(completed ? '已转存到网盘' : '转存到网盘');
            button.title = completed ? describeTarget(result.record) : result.error || '';
        }).catch(() => { if (button.isConnected !== false) button.title = t('转存记录读取失败，请点击重试'); });
    }

    function lockRecord(id, operation) {
        if (global.navigator?.locks) return global.navigator.locks.request('disk-pending-resume:' + id, operation);
        // Older browsers still serialize cancellation and resume in this page.
        // Cross-page publication remains guarded by the server's unique ID.
        const result = (recordLocks.get(id) || Promise.resolve()).then(operation);
        const tail = result.then(() => {}, () => {});
        recordLocks.set(id, tail);
        tail.then(() => { if (recordLocks.get(id) === tail) recordLocks.delete(id); });
        return result;
    }

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
    async function putPending(record) {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE, 'readwrite'), store = transaction.objectStore(STORE), request = store.getAll();
            let selected;
            request.onsuccess = () => {
                selected = request.result.find(item => item.source === record.source && item.task.id === record.task.id && item.version === record.version && liveRecord(item));
                if (!selected) { selected = record; store.put(record); }
            };
            transaction.oncomplete = () => resolve(selected);
            transaction.onerror = transaction.onabort = () => reject(transaction.error || Error('待转存记录保存失败'));
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
        const controller = global.AbortController ? new global.AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
        try {
            const response = await global.fetch(root + '/tasks/' + encodeURIComponent(record.task.id), { cache: 'no-store', credentials: 'same-origin', ...(controller ? { signal: controller.signal } : {}) });
            if ([401, 403].includes(response.status)) throw new Error('后台登录已失效，请登录后台后继续转存；待转存记录及缓存已保留');
            if (response.status === 404) throw new Error('来源任务已删除，无法确认当前版本；待转存缓存已保留，请检查来源任务');
            if (!response.ok) throw new Error('无法核验来源任务版本：HTTP ' + response.status + '；待转存记录已保留');
            const data = await response.json().catch(() => null), task = data?.task || data;
            if (controller?.signal.aborted) throw new Error('SOURCE_CHECK_TIMEOUT');
            if (!task?.id || String(task.id) !== record.task.id || versionOf(task) !== record.version) throw new Error('来源任务版本已变化，不会用新正文替换旧缓存；请取消旧待转存记录，再从后台重新发起');
            return task;
        } catch (error) { if (controller?.signal.aborted) throw new Error('来源任务核验超时，待转存记录已保留，请重试'); throw error; }
        finally { if (timer !== null) clearTimeout(timer); }
    }
    async function prepare({ source, task, cache, ensureCache, onStatus = () => {} }) {
        if (!sourceTypes.has(source) || !task?.id || !Number(task.completedAt) || !Number.isSafeInteger(Number(task.outputFileSize)) || Number(task.outputFileSize) <= 0) {
            throw new Error('仅可转存已完成且文件信息完整的任务，请刷新后台任务记录');
        }
        const prepareOne = async () => {
            const version = versionOf(task);
            const existing = (await list()).find(record => record.source === source && record.task.id === String(task.id) && record.version === version && liveRecord(record));
            cache ||= cacheFor(source);
            adapters.set(source, cache);
            if (existing) {
                if (existing.status === 'preparing') return lockRecord(existing.id, async () => {
                    const latest = await get(existing.id);
                    if (latest.status !== 'preparing') return latest;
                    await verifySource(latest);
                    const pinned = await cache.pin(latest.task, latest.id);
                    latest.file = { name: pinned.name, size: pinned.size, type: pinned.type };
                    latest.cache = { taskId: pinned.id, version: pinned.version };
                    latest.status = 'pending'; latest.updatedAt = Date.now(); await put(latest);
                    return latest;
                });
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
            return lockRecord(record.id, async () => { try {
                if ((await get(record.id))?.status === 'cancelled') throw new Error('待转存记录已取消，未建立缓存引用');
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
            return record; });
        };
        return global.navigator?.locks ? global.navigator.locks.request('disk-pending-prepare:' + source + ':' + task?.id, prepareOne) : prepareOne();
    }
    async function prepareServer({ source, task }) {
        if (!sourceTypes.has(source) || !task?.id || !Number(task.completedAt) || !Number.isSafeInteger(Number(task.outputFileSize)) || Number(task.outputFileSize) <= 0) {
            throw new Error('仅可转存已完成且文件信息完整的任务，请刷新后台任务记录');
        }
        const operation = async () => {
            const version = versionOf(task);
            let existing = (await list()).find(record => record.source === source && record.task.id === String(task.id) && record.version === version && liveRecord(record));
            if (existing?.status === 'completed') {
                const verified = await inspectSaved(existing, { force:true });
                if (['missing','moved'].includes(verified.state)) { await update(existing.id, { status:'superseded', error:verified.state }); existing=null; }
            }
            if (existing && (existing.transferMode === 'server' || ['completed', 'uploading', 'verification-required'].includes(existing.status))) return existing;
            const current = await verifySource({ source, task: { ...task, id: String(task.id) }, version });
            if (!current.hasFile || current.status !== 'completed') throw new Error('服务端成品已清理或不可用，请重新抓取后转存');
            if (existing) return lockRecord(existing.id, async () => {
                const latest = await get(existing.id);
                if (['completed', 'uploading', 'verification-required'].includes(latest.status)) return latest;
                const upgraded = { ...latest, transferMode: 'server', serverTransferId: uuid(), legacyCachePin: true, status: 'pending', updatedAt: Date.now() };
                delete upgraded.cache;
                await put(upgraded);
                return upgraded;
            });
            return putPending({ id: uuid(), source, version, transferMode: 'server',
                task: { id: String(task.id), completedAt: Number(task.completedAt), outputFileSize: Number(task.outputFileSize), outputFileName: String(task.outputFileName || task.title || 'downloaded-file') },
                sourceInfo: safeSource(task), file: { name: String(task.outputFileName || 'downloaded-file'), size: Number(task.outputFileSize), type: 'application/octet-stream' },
                status: 'pending', target: null, createdAt: Date.now(), updatedAt: Date.now() });
        };
        return global.navigator?.locks ? global.navigator.locks.request('disk-pending-prepare:' + source + ':' + task.id, operation) : operation();
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
        // Let the source adapter validate the pinned version and read bytes in
        // one IDB request; legacy ArrayBuffers must not be loaded twice.
        const cache = cacheFor(record.source);
        const blob = await cache.getBlob(record.task, { pendingId: record.id });
        if (!blob || blob.size !== record.file.size) throw new Error('待转存文件缓存不完整，请补充缓存后继续');
        return blob;
    }
    async function complete(id, result) {
        const record = await update(id, { status: 'completed', completedAt: Date.now(), result, error: '' });
        if (record.transferMode !== 'server' || record.legacyCachePin) await cacheFor(record.source).unpin(record.task.id, record.id);
        return record;
    }
    async function cancel(id, verifier) {
        const operation = () => cancelUnlocked(id, verifier);
        return lockRecord(id, operation);
    }
    async function cancelUnlocked(id, verifier) {
        let record = await get(id);
        if (!record) return null;
        if (record.status === 'completed') return record;
        if (['uploading', 'verification-required'].includes(record.status)) {
            const found = verifier ? await verifier(record) : null;
            if (found?.status === 'completed') return complete(id, found.result);
            if (!['failed', 'missing'].includes(found?.status) || found.retryable !== true) {
                throw new Error('上传结果尚未确认或仍在处理，待转存记录及缓存已保留，请稍后核验');
            }
            record = await update(id, { status: 'failed' });
        }
        const next = await update(id, { status: 'cancelled' });
        if (record.transferMode !== 'server' || record.legacyCachePin) await cacheFor(record.source).unpin(record.task.id, id);
        return next;
    }
    async function resume(id, hooks) {
        if (active.has(id)) return active.get(id);
        const stage = message => { try { Promise.resolve(hooks.onStage?.(message)).catch(() => {}); } catch (_) {} };
        stage('正在读取待转存记录…');
        const execute = async () => {
            let record = await get(id);
            if (!record) throw new Error('待转存记录不在此浏览器中，请在原浏览器打开网盘');
            if (record.status === 'superseded') return resume((await prepareServer({ source:record.source, task:record.task })).id, hooks);
            if (record.status === 'completed') {
                stage('正在核验已保存的网盘文件…');
                const verified = await (hooks.verifySaved ? hooks.verifySaved(record) : inspectSaved(record, { force:true }));
                if (verified.state === 'cancelled') return record;
                if (['missing','moved'].includes(verified.state)) {
                    await update(record.id, { status:'superseded', error:verified.state });
                    return resume((await prepareServer({ source:record.source, task:record.task })).id, hooks);
                }
                if (verified.state !== 'saved') throw Error(verified.error || 'PENDING_SAVE_RECEIPT_UNCONFIRMED');
                record = await update(record.id, { result:{ ...record.result, items:verified.files } });
                if (record.transferMode !== 'server' || record.legacyCachePin) await cacheFor(record.source).unpin(record.task.id, record.id);
                await hooks.onCompleted?.(record); return record;
            }
            if (record.status === 'cancelled') throw new Error('这条待转存记录已取消，请回后台重新发起');
            if (record.status === 'preparing' && !hooks.transferServer) throw new Error('上次缓存引用准备未完成，请在后台重新发起转存');
            if (['uploading', 'verification-required'].includes(record.status)) {
                stage('正在核验上次转存结果，不会重复提交…');
                if (!hooks.lookup) throw new Error('上次上传结果尚未确认，请核验网盘任务后继续，未重复上传');
                const found = await hooks.lookup(record);
                if (found?.status === 'completed') { await complete(id, found.result); return execute(); }
                if (found?.status !== 'missing' && !(found?.status === 'failed' && found.retryable === true)) {
                    await hooks.onStatus?.('上次转存仍在处理，请等待或在任务列表查看结果'); return record;
                }
                record = await update(id, { status: 'failed' });
            }
            // Migrate old metadata only after any previous upload outcome is known.
            if (record.transferMode !== 'server' && hooks.transferServer) {
                stage('正在核验旧待转存记录的服务端成品…');
                const current = await verifySource(record);
                if (!current.hasFile || current.status !== 'completed') throw new Error('服务端成品已清理或不可用，请重新抓取后转存');
                const upgraded = { ...record, transferMode: 'server', serverTransferId: uuid(), legacyCachePin: true, status: 'pending', updatedAt: Date.now() };
                delete upgraded.cache;
                await put(upgraded);
                record = upgraded;
            }
            const blob = record.transferMode === 'server' ? null : await getBlob(record);
            stage(record.target ? '正在核验原转存账号…' : '请选择转存目标账号');
            const account = await hooks.chooseAccount(record);
            if (!account) return record;
            stage(record.target ? '正在复用原目标目录…' : '正在读取转存目标分区和目录…');
            let target = await hooks.chooseTarget(record, account);
            if (!target) return record;
            target = { ...target, accountName:target.accountName || account.name || account.username || account.id };
            if (!target.accountId || !target.partitionId || typeof target.path !== 'string') throw new Error('请选择有效的账号、分区和目标目录');
            stage('正在核验目标目录和来源版本…');
            await hooks.verifyTarget?.(record, target);
            await verifySource(record);
            stage('请确认转存目标');
            if (!await hooks.confirm(record, target)) return record;
            record = await update(id, { status: 'uploading', target, attemptedAt: Date.now(), error: '' });
            stage('正在转存，详细进度请查看网盘任务');
            try {
                // UI refresh is auxiliary; it must not prevent the transfer itself.
                try { await hooks.onStarted?.(record); } catch (_) {}
                const result = record.transferMode === 'server'
                    ? await hooks.transferServer(record, target)
                    : await hooks.upload(record, blob, target, { pendingSaveId: id, sourceInfo: record.sourceInfo });
                if (!result?.items?.length || result.items.some(item => !item?.id)) throw Error('PENDING_SAVE_RECEIPT_UNCONFIRMED');
                record = await complete(id, result);
            } catch (error) {
                if ((await get(id))?.status !== 'completed') await update(id, { status: 'verification-required', error: String(error.message || error).slice(0, 1000) });
                throw error;
            }
            await hooks.onCompleted?.(record);
            return record;
        };
        // A page can hold the lock while its account/directory dialog is open.
        // Reopening the same ID must not wait invisibly behind that page.
        const attempt = global.navigator?.locks
            ? global.navigator.locks.request('disk-pending-resume:' + id, { ifAvailable: true }, async lock => {
                if (lock) return execute();
                await hooks.onStatus?.('此待转存正在另一个页面中处理或等待选择，请回到该页面继续；关闭该页面后可在此重试。');
                return get(id);
            })
            : lockRecord(id, execute);
        const promise = attempt.finally(() => active.delete(id));
        active.set(id, promise);
        return promise;
    }
    global.DiskPendingSave = { prepare, prepareServer, open, get, list, update, getBlob, complete, cancel, resume, verifySource, inspectSaved, taskStatus, describeTarget, decorateButton, isActive: id => active.has(id), _test: { versionOf, safeSource, cacheFor } };
})(window);
