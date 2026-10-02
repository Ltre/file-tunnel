'use strict';
const crypto = require('crypto');
const { openDiskRepository } = require('./disk-repository');
const { diskErrorCode, diskErrorDetails } = require('./disk-errors');
function createDiskOperations({ dataDir, now = Date.now }) {
    const repository = openDiskRepository(dataDir);
    let state = repository.loadWithRevision('operations');
    const jobs = new Map(state.items.map(item => [item.operation_id, item]));
    const reloadPersistence = () => {
        state = repository.loadWithRevision('operations');
        jobs.clear();
        for (const item of state.items) jobs.set(item.operation_id, item);
    };
    const executing = new Set();
    const cancelHandlers = new Map();
    let timer;
    const terminal = job => ['completed', 'failed', 'cancelled'].includes(job.status);
    function save() {
        clearTimeout(timer); timer = null;
        const sorted = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
        const retained = sorted.filter((job, index) => !terminal(job) || index < 1000);
        try { repository.replaceMany([{ table:'operations', items:retained, keyOf:item => item.operation_id, base:state.revisions }]); }
        catch (error) { reloadPersistence(); throw error; }
        const ids = new Set(retained.map(job => job.operation_id));
        for (const id of jobs.keys()) if (!ids.has(id)) jobs.delete(id);
    }
    for (const job of jobs.values()) if (!terminal(job)) Object.assign(job, { status: 'failed', phase: 'interrupted', errorCode: 'SERVER_RESTARTED', message: '服务已重启，请重新执行此操作', finishedAt: now() });
    if (jobs.size) save();
    const view = job => job ? structuredClone(job) : null;
    const owns = (job, scope) => job && job.userId === scope.userId && job.diskSpace === (scope.diskSpace || '') && (job.type !== 'read' || (Boolean(job.deviceId) && job.deviceId === scope.deviceId));
    const api = {
        create(scope, type, message, totalBytes = 0) {
            const job = { operation_id: crypto.randomUUID(), userId: scope.userId, diskSpace: scope.diskSpace || '', type, status: 'queued', phase: 'queued', percent: null, processedBytes: 0, totalBytes, message, errorCode: '', errorMessage: '', createdAt: now(), startedAt: 0, finishedAt: 0 };
            job.title = message; job.updatedAt = now();
            if (type === 'read') job.deviceId = scope.deviceId || '';
            jobs.set(job.operation_id, job); save(); return view(job);
        },
        get(id, scope) { const job = jobs.get(id); return owns(job, scope) ? view(job) : null; },
        findUpload(uploadId, scope) { return view([...jobs.values()].find(job => job.uploadId === uploadId && owns(job, scope))); },
        list(scope, requested = []) {
            const wanted = new Set(requested);
            return [...jobs.values()].filter(job => owns(job, scope)).sort((a,b) => b.createdAt-a.createdAt)
                .filter((job, index) => !terminal(job) || wanted.has(job.operation_id) || index < 100)
                .map(job => { const copy = view(job); if (!wanted.has(job.operation_id)) delete copy.result; return copy; });
        },
        update(id, patch, immediate = false) {
            const job = jobs.get(id); if (!job || terminal(job)) return view(job);
            // Browser PUT progress can arrive after the Telegram pipeline has
            // already started. Keep its byte counter, but never let it replace
            // the Telegram phase or the confirmed remote progress.
            if (job.type === 'upload' && job.telegramStarted && ['client-upload', 'source-read'].includes(patch.phase)) {
                patch = { ...patch };
                for (const key of ['phase', 'message', 'percent', 'processedBytes', 'totalBytes']) delete patch[key];
            }
            if (job.type === 'upload' && patch.phase === 'telegram-queue') job.telegramStarted = true;
            if (patch.phase && patch.phase !== job.phase && patch.phase === 'telegram-queue') job.lastMeasuredPercent = 0;
            Object.assign(job, patch);
            job.updatedAt = now();
            if (Number.isFinite(patch.percent)) job.lastMeasuredPercent = Math.max(job.lastMeasuredPercent || 0, Math.min(100, patch.percent));
            if (job.status === 'running' && !job.startedAt) job.startedAt = now();
            if (terminal(job)) job.finishedAt = now();
            if (immediate || terminal(job)) save();
            else if (!timer) {
                timer = setTimeout(() => {
                    try { save(); }
                    catch (error) { console.warn('[disk-operations] 后台进度持久化失败', error?.message || String(error)); }
                }, 500);
                timer.unref?.();
            }
            return view(job);
        },
        complete(id, result) { const job = jobs.get(id); return api.update(id, { status: 'completed', phase: 'completed', percent: 100, processedBytes: job?.totalBytes || 0, message: '操作完成', result,
            ...(Array.isArray(result?.warnings) && result.warnings.length ? { warnings: result.warnings } : {}) }, true); },
        fail(id, error) {
            const errorDetails = diskErrorDetails(error);
            const uncertainUpload = error?.message === 'TELEGRAM_NETWORK_ERROR' && errorDetails.causeCode === 'UND_ERR_HEADERS_TIMEOUT';
            const errorMessage = uncertainUpload ? '等待 Telegram 或代理响应头超时；发送结果未确认，请先核对频道消息再重试'
                : errorDetails.telegramDescription || '操作失败，请检查错误码后重试';
            return api.update(id, { status: 'failed', phase: 'failed', errorCode: diskErrorCode(error), errorMessage, message: '操作失败', errorDetails }, true);
        },
        run(id, work) {
            const job = jobs.get(id);
            if (!job || terminal(job) || executing.has(id)) return false;
            executing.add(id);
            api.update(id, { status: 'running', phase: 'starting' }, true);
            const control = { get cancelled() { return Boolean(jobs.get(id)?.cancelRequested); }, throwIfCancelled() { if (jobs.get(id)?.cancelRequested) throw new Error('OPERATION_CANCELLED'); } };
            Promise.resolve().then(() => work((patch) => api.update(id, patch), control)).then(result => api.complete(id, result), error => error?.message === 'OPERATION_CANCELLED' ? api.update(id, { status: 'cancelled', phase: 'cancelled', message: '用户已取消任务' }, true) : api.fail(id, error))
                .catch(error => { console.warn('[disk-operations] 任务结束状态持久化失败', { operationId: id, code: diskErrorCode(error) }); })
                .finally(() => { executing.delete(id); cancelHandlers.delete(id); });
            return true;
        },
        onCancel(id, handler) { if (jobs.has(id) && typeof handler === 'function') cancelHandlers.set(id, handler); },
        async cancel(id, scope) {
            const job = jobs.get(id);
            if (!owns(job, scope)) return null;
            if (terminal(job)) return view(job);
            job.cancelRequested = true; job.message = '正在取消任务'; job.updatedAt = now(); save();
            await cancelHandlers.get(id)?.();
            return api.update(id, { status: 'cancelled', phase: 'cancelled', message: '用户已取消任务' }, true);
        },
        flush: save
    };
    return api;
}
module.exports = { createDiskOperations };
