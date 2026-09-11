'use strict';
// Browser transport for the standalone drive. The UI and integrations share jobs.
(function () {
    const base = '/api/telegram/drive';
    const listeners = new Set();
    const localUploads = new Map();
    const uploadSession = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    let deviceId = uploadSession;
    try { deviceId = localStorage.getItem('disk-device-id') || uploadSession; localStorage.setItem('disk-device-id', deviceId); } catch (_) {}
    const pendingReads = new Map();
    const uploadControllers = new Map();
    const readControllers = new Map();
    const hiddenLoadingOperations = new Set();
    const newAbortController = () => typeof AbortController === 'function' ? new AbortController() : { signal: { aborted: false, addEventListener() {} }, abort() { this.signal.aborted = true; } };
    const abortError = () => { const error = new Error('OPERATION_CANCELLED'); error.name = 'AbortError'; return error; };
    const cacheChanged = () => { if (typeof CustomEvent !== 'undefined') window.dispatchEvent?.(new CustomEvent('disk-cache-changed')); };
    let uploadSequence = 0;
    let jobs = [], polling = null, generation = 0, enabled = false, lastRefresh = 0;
    const waiting = new Map();
    const activities = new Set(), activityListeners = new Set();
    const emitActivities = () => activityListeners.forEach(listener => listener([...activities]));
    async function withActivity(message, run) {
        const activity = { message, operationId: '' };
        activities.add(activity); emitActivities();
        const update = values => { Object.assign(activity, values); emitActivities(); };
        try { return await run(update); }
        finally { activities.delete(activity); emitActivities(); }
    }
    const active = job => ['queued', 'running'].includes(job.status);
    const visibleJobs = () => [...localUploads.values()].filter(job => !jobs.some(remote => remote.operation_id === job.operation_id && (job.status !== 'failed' || !active(remote))))
        .concat(jobs.filter(job => localUploads.get(job.operation_id)?.status !== 'failed' || !active(job)));
    const emit = () => listeners.forEach(listener => listener(visibleJobs()));
    async function raw(url, options = {}) {
        const method = String(options.method || 'GET').toUpperCase();
        const response = await fetch(url.startsWith('/api/') ? url : base + url, { credentials: 'same-origin', cache: method === 'GET' ? 'no-store' : 'no-cache', ...options, headers: { ...options.headers, 'X-Disk-Device-Id': deviceId } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) { const error = new Error(data.error || 'DISK_REQUEST_FAILED'); Object.assign(error, data); error.status = response.status; throw error; }
        return data;
    }
    async function refresh(force = false) {
        if (!enabled) return;
        if (polling) return polling;
        if (!force && Date.now() - lastRefresh < 1800) return;
        const current = generation; lastRefresh = Date.now();
        polling = raw('/operations?ids=' + encodeURIComponent([...waiting.keys()].join(','))).then(data => {
            if (current !== generation) return;
            jobs = data.operations;
            for (const job of jobs) if (!active(job)) hiddenLoadingOperations.delete(job.operation_id);
            for (const id of localUploads.keys()) if (jobs.some(job => job.operation_id === id && !active(job))) localUploads.delete(id);
            for (const [id, handlers] of waiting) {
                const job = jobs.find(item => item.operation_id === id);
                if (!job || active(job)) continue;
                waiting.delete(id);
                if (job.status === 'completed') handlers.resolve(job.result);
                else { const error = new Error(job.status === 'cancelled' ? 'OPERATION_CANCELLED' : (job.errorCode || 'DISK_OPERATION_FAILED')); error.partialItems = job.result?.partialItems; handlers.reject(error); }
            }
            emit();
        }).catch(error => {
            if (error.message === 'LOGIN_REQUIRED') stop();
        }).finally(() => { polling = null; });
        return polling;
    }
    async function wait(id) {
        enabled = true;
        if (waiting.has(id)) return waiting.get(id).promise;
        const pending = {};
        pending.promise = new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
        waiting.set(id, pending); refresh(true); return pending.promise;
    }
    async function performRequest(url, options, update) {
        const data = await raw(url, options);
        if (data.operation_id) update?.({ operationId: data.operation_id });
        return data.operation_id && !data.uploadId ? wait(data.operation_id) : data;
    }
    function request(url, options = {}) {
        const method = String(options.method || 'GET').toUpperCase();
        let body = {}; try { body = JSON.parse(options.body || '{}'); } catch (_) {}
        const target = url.includes('/directories') ? '目录' : '文件';
        const message = url.includes('/shares') ? (method === 'DELETE' ? '正在停止分享' : method === 'POST' ? '正在创建分享' : '正在加载分享列表')
            : method === 'DELETE' ? '正在删除' + target
            : method === 'PATCH' ? ('folderPath' in body || 'destinationPath' in body ? '正在移动' : '正在重命名') + target
            : url.endsWith('/check') ? '正在检测文件可用性'
            : url.endsWith('/repair') ? '正在修复文件'
            : method === 'POST' && target === '目录' ? '正在创建目录'
            : url.includes('/list') ? '正在加载文件列表' : '正在读取网盘信息';
        return withActivity(message, update => performRequest(url, options, update));
    }
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    function start() { enabled = true; refresh(); }
    function stop() {
        enabled = false; generation++; jobs = []; localUploads.clear();
        for (const handlers of waiting.values()) handlers.reject(new Error('LOGIN_REQUIRED'));
        waiting.clear(); emit();
    }
    // One batched poll for all jobs; idle home pages do not keep polling every second.
    setInterval(() => {
        const interval = waiting.size || jobs.some(active) ? 2400 : 60000;
        if (enabled && Date.now() - lastRefresh >= interval) refresh();
    }, 800);
    function upload(files, folderPath, read = file => file, metadata = {}) {
        return withActivity('正在上传 ' + files.length + ' 个文件', async update => {
            // Also keep failures before the server can create a task (offline/HTTP errors).
            const pending = { operation_id: 'local-upload-' + uploadSession + '-' + ++uploadSequence, type: 'upload', status: 'queued', phase: 'preparing', message: '正在准备上传', title: '上传 ' + files.length + ' 个文件', percent: null };
            const controller = newAbortController();
            const current = generation;
            localUploads.set(pending.operation_id, pending); uploadControllers.set(pending.operation_id, controller); emit(); update({ operationId: pending.operation_id });
            try {
                return await uploadFiles(files, folderPath, read, metadata, values => {
                    if (current !== generation) throw new Error('LOGIN_REQUIRED');
                    if (values.operationId && values.operationId !== pending.operation_id) {
                        localUploads.delete(pending.operation_id); uploadControllers.delete(pending.operation_id);
                        pending.operation_id = values.operationId; localUploads.set(pending.operation_id, pending); uploadControllers.set(pending.operation_id, controller);
                    }
                    update(values); emit();
                }, controller.signal);
            } catch (error) {
                if (current === generation && !jobs.some(job => job.operation_id === pending.operation_id && !active(job))) {
                    const cancelled = error.name === 'AbortError' || error.message === 'OPERATION_CANCELLED';
                    Object.assign(pending, { status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? 'cancelled' : 'failed', message: cancelled ? '用户已取消任务' : '上传请求失败', errorCode: cancelled ? '' : error.message });
                    localUploads.set(pending.operation_id, pending);
                }
                throw error;
            } finally {
                uploadControllers.delete(pending.operation_id);
                if (pending.status !== 'failed') localUploads.delete(pending.operation_id);
                emit();
            }
        });
    }
    const withSignal = (options, signal) => ({ ...options, signal });
    const delay = (ms, signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
    });
    const inferredType = file => {
        if (file.type) return file.type;
        const ext = String(file.name || '').toLowerCase().split('.').pop();
        return ({ mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime', m4v:'video/mp4', mp3:'audio/mpeg', m4a:'audio/mp4', aac:'audio/aac', ogg:'audio/ogg', opus:'audio/ogg', wav:'audio/wav', flac:'audio/flac', jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', avif:'image/avif', svg:'image/svg+xml', pdf:'application/pdf', txt:'text/plain' })[ext] || 'application/octet-stream';
    };
    async function uploadFiles(files, folderPath, read, metadata, update, signal) {
        if (!files.length || files.length > 100) throw new Error('DISK_BATCH_LIMIT');
        const plannedPartSize = 20_000_000;
        const plannedFiles = files.map(file => ({
            name: file.name, type: inferredType(file), size: file.size,
            parts: Array.from({ length: Math.max(1, Math.ceil(file.size / plannedPartSize)) }, (_, index) => {
                const byteStart = index * plannedPartSize, size = Math.min(plannedPartSize, file.size - byteStart);
                return { index: index + 1, byteStart, byteEnd: byteStart + size - 1, size };
            }),
            mediaIndex: String(file.type || '').startsWith('video/') ? { mode: 'unavailable', reason: 'container-parser-unavailable' } : undefined
        }));
        const job = await raw('/uploads', withSignal(json('POST', { folderPath, metadata, files: plannedFiles }), signal));
        update({ operationId: job.operation_id });
        start();
        const blobs = [];
        try {
            for (let index = 0; index < files.length; index++) {
                await raw('/uploads/' + job.uploadId + '/phase', withSignal(json('POST', { index }), signal));
                await refresh();
                const blob = await read(files[index]);
                if (signal.aborted) throw abortError();
                blobs.push(blob);
                const url = '/uploads/' + job.uploadId + '/files/' + index;
                if (!blob.size) await raw(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob, signal });
                for (const part of plannedFiles[index].parts) {
                    const offset = part.byteStart, end = part.byteEnd + 1;
                    while (true) {
                        try { await raw(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}` }, body: blob.slice(offset, end), signal }); break; }
                        catch (error) {
                            if (error.message !== 'UPLOAD_BACKPRESSURE') throw error;
                            update({ message: '服务器上传队列已满，等待 Telegram 消费后继续', queueParts: error.queue?.pendingParts, queueBytes: error.queue?.pendingBytes });
                            await delay(Math.max(250, Number(error.retryAfterMs) || 500), signal);
                            await refresh(true);
                        }
                    }
                }
            }
            const result = await performRequest('/uploads/' + job.uploadId + '/finish', { method: 'POST', signal }, update);
            // Keep repair copies, even when the uploaded object originated outside this UI.
            for (let index = 0; index < result.items.length; index++) {
                await window.TelegramDriveCache?.put(result.items[index].id, { blob: blobs[index], name: files[index].name, type: files[index].type }).catch(() => {});
            }
            return result;
        } catch (error) {
            for (let index = 0; index < (error.partialItems?.length || 0); index++) {
                await window.TelegramDriveCache?.put(error.partialItems[index].id, { blob: blobs[index], name: files[index].name, type: files[index].type }).catch(() => {});
            }
            await raw('/uploads/' + job.uploadId, { method: 'DELETE' }).catch(() => {});
            throw error;
        } finally { refresh(); }
    }
    async function read(item, options = {}) {
        const controller = newAbortController();
        const signal = options.signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function' ? AbortSignal.any([options.signal, controller.signal]) : (options.signal || controller.signal);
        let operationId = '';
        if (!pendingReads.has(item.id)) pendingReads.set(item.id, new Set());
        pendingReads.get(item.id).add(controller); cacheChanged();
        const run = update => readFile(item, { ...options, signal }, values => {
            if (values.operationId && values.operationId !== operationId) { if (operationId) readControllers.delete(operationId); operationId = values.operationId; readControllers.set(operationId, controller); }
            if (options.silentLoading && values.operationId) hiddenLoadingOperations.add(values.operationId);
            update(values);
        });
        try { return options.silentLoading ? await run(() => {}) : await withActivity('正在打开文件：' + item.name, run); }
        finally { if (operationId) readControllers.delete(operationId); const readers = pendingReads.get(item.id); readers?.delete(controller); if (!readers?.size) pendingReads.delete(item.id); cacheChanged(); }
    }
    async function readFile(item, { signal }, update) {
        const cached = await window.TelegramDriveCache?.get(item.id).catch(() => null);
        if (cached?.blob && cached.blob.size === item.size) return cached.blob;
        start();
        const response = await fetch(base + '/files/' + encodeURIComponent(item.id) + '/download', { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Disk-Device-Id': deviceId }, signal });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'DISK_READ_FAILED');
        update({ operationId: response.headers?.get('X-Disk-Operation-Id') || '', message: '正在接收文件：' + item.name });
        const blob = await response.blob();
        await window.TelegramDriveCache?.put(item.id, { blob, name: item.name, type: item.type }).catch(() => {});
        refresh(); return blob;
    }
    async function cancelOperation(id) {
        uploadControllers.get(id)?.abort();
        readControllers.get(id)?.abort();
        if (!String(id).startsWith('local-upload-')) await raw('/operations/' + encodeURIComponent(id), { method: 'DELETE' });
        refresh(true); return true;
    }
    function cancelRead(id) {
        const readers = pendingReads.get(id); if (!readers?.size) return false;
        for (const controller of readers) controller.abort();
        return true;
    }
    const streamUrl = item => base + '/files/' + encodeURIComponent(item.id) + '/stream';
    window.DiskClient = { raw, request, json, upload, read, wait, start, stop, refresh, withActivity, cancelOperation, cancelRead, streamUrl,
        isCaching(id) { return pendingReads.has(id); },
        isLoadingHidden(id) { return hiddenLoadingOperations.has(id); },
        subscribeActivity(listener) { activityListeners.add(listener); listener([...activities]); return () => activityListeners.delete(listener); },
        subscribe(listener) { listeners.add(listener); listener(visibleJobs()); return () => listeners.delete(listener); } };
})();
