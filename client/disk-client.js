'use strict';
// Browser transport for the standalone drive. The UI and integrations share jobs.
(function () {
    const base = '/api/telegram/drive';
    const listeners = new Set();
    const localUploads = new Map();
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
        const response = await fetch(url.startsWith('/api/') ? url : base + url, { credentials: 'same-origin', cache: method === 'GET' ? 'no-store' : 'no-cache', ...options });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'DISK_REQUEST_FAILED');
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
            for (const id of localUploads.keys()) if (jobs.some(job => job.operation_id === id && !active(job))) localUploads.delete(id);
            for (const [id, handlers] of waiting) {
                const job = jobs.find(item => item.operation_id === id);
                if (!job || active(job)) continue;
                waiting.delete(id);
                if (job.status === 'completed') handlers.resolve(job.result);
                else { const error = new Error(job.errorCode || 'DISK_OPERATION_FAILED'); error.partialItems = job.result?.partialItems; handlers.reject(error); }
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
            const pending = { operation_id: 'local-upload-' + ++uploadSequence, type: 'upload', status: 'queued', phase: 'preparing', message: '正在准备上传', title: '上传 ' + files.length + ' 个文件', percent: null };
            const current = generation;
            localUploads.set(pending.operation_id, pending); emit(); update({ operationId: pending.operation_id });
            try {
                return await uploadFiles(files, folderPath, read, metadata, values => {
                    if (current !== generation) throw new Error('LOGIN_REQUIRED');
                    if (values.operationId) { localUploads.delete(pending.operation_id); pending.operation_id = values.operationId; localUploads.set(pending.operation_id, pending); }
                    update(values); emit();
                });
            } catch (error) {
                if (current === generation && !jobs.some(job => job.operation_id === pending.operation_id && !active(job))) {
                    Object.assign(pending, { status: 'failed', phase: 'failed', message: '上传请求失败', errorCode: error.message });
                    localUploads.set(pending.operation_id, pending);
                }
                throw error;
            } finally {
                if (pending.status !== 'failed') localUploads.delete(pending.operation_id);
                emit();
            }
        });
    }
    async function uploadFiles(files, folderPath, read, metadata, update) {
        if (!files.length || files.length > 100) throw new Error('DISK_BATCH_LIMIT');
        const job = await raw('/uploads', json('POST', { folderPath, metadata, files: files.map(file => ({ name: file.name, type: file.type, size: file.size })) }));
        update({ operationId: job.operation_id });
        start();
        const blobs = [];
        try {
            for (let index = 0; index < files.length; index++) {
                await raw('/uploads/' + job.uploadId + '/phase', json('POST', { index }));
                await refresh();
                const blob = await read(files[index]);
                blobs.push(blob);
                await raw('/uploads/' + job.uploadId + '/files/' + index, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
            }
            const result = await performRequest('/uploads/' + job.uploadId + '/finish', { method: 'POST' }, update);
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
    function read(item, options = {}) {
        return withActivity('正在打开文件：' + item.name, update => readFile(item, options, update));
    }
    async function readFile(item, { signal }, update) {
        const cached = await window.TelegramDriveCache?.get(item.id).catch(() => null);
        if (cached?.blob && cached.blob.size === item.size) return cached.blob;
        start();
        const response = await fetch(base + '/files/' + encodeURIComponent(item.id) + '/download', { credentials: 'same-origin', cache: 'no-store', signal });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'DISK_READ_FAILED');
        update({ operationId: response.headers?.get('X-Disk-Operation-Id') || '', message: '正在接收文件：' + item.name });
        const blob = await response.blob();
        await window.TelegramDriveCache?.put(item.id, { blob, name: item.name, type: item.type }).catch(() => {});
        refresh(); return blob;
    }
    window.DiskClient = { raw, request, json, upload, read, wait, start, stop, refresh, withActivity,
        subscribeActivity(listener) { activityListeners.add(listener); listener([...activities]); return () => activityListeners.delete(listener); },
        subscribe(listener) { listeners.add(listener); listener(visibleJobs()); return () => listeners.delete(listener); } };
})();
