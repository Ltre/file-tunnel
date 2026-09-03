'use strict';
// Browser transport for the standalone drive. The UI and integrations share jobs.
(function () {
    const base = '/api/telegram/drive';
    const listeners = new Set();
    let jobs = [], polling = null, generation = 0, enabled = false, lastRefresh = 0;
    const waiting = new Map();
    const active = job => ['queued', 'running'].includes(job.status);
    const emit = () => listeners.forEach(listener => listener(jobs));
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
    async function request(url, options) {
        const data = await raw(url, options);
        return data.operation_id && !data.uploadId ? wait(data.operation_id) : data;
    }
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    function start() { enabled = true; refresh(); }
    function stop() {
        enabled = false; generation++; jobs = [];
        for (const handlers of waiting.values()) handlers.reject(new Error('LOGIN_REQUIRED'));
        waiting.clear(); emit();
    }
    // One batched poll for all jobs; idle home pages do not keep polling every second.
    setInterval(() => {
        const interval = waiting.size || jobs.some(active) ? 2400 : 60000;
        if (enabled && Date.now() - lastRefresh >= interval) refresh();
    }, 800);
    async function upload(files, folderPath, read = file => file, metadata = {}) {
        if (!files.length || files.length > 100) throw new Error('DISK_BATCH_LIMIT');
        const job = await raw('/uploads', json('POST', { folderPath, metadata, files: files.map(file => ({ name: file.name, type: file.type, size: file.size })) }));
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
            const result = await request('/uploads/' + job.uploadId + '/finish', { method: 'POST' });
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
    async function read(item, { signal } = {}) {
        const cached = await window.TelegramDriveCache?.get(item.id).catch(() => null);
        if (cached?.blob && cached.blob.size === item.size) return cached.blob;
        start();
        const response = await fetch(base + '/files/' + encodeURIComponent(item.id) + '/download', { credentials: 'same-origin', cache: 'no-store', signal });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'DISK_READ_FAILED');
        const blob = await response.blob();
        await window.TelegramDriveCache?.put(item.id, { blob, name: item.name, type: item.type }).catch(() => {});
        refresh(); return blob;
    }
    window.DiskClient = { raw, request, json, upload, read, wait, start, stop, refresh, subscribe(listener) { listeners.add(listener); listener(jobs); return () => listeners.delete(listener); } };
})();
