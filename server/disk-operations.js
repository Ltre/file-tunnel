'use strict';
const crypto = require('crypto');
const path = require('path');
const { readJson, writeJson } = require('./disk-data');
function createDiskOperations({ dataDir, now = Date.now }) {
    const file = path.join(dataDir, 'disk-operations.json');
    const jobs = new Map(readJson(file, []).map(item => [item.operation_id, item]));
    const executing = new Set();
    let timer;
    const terminal = job => ['completed', 'failed', 'cancelled'].includes(job.status);
    function save() {
        clearTimeout(timer); timer = null;
        const sorted = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
        const retained = sorted.filter((job, index) => !terminal(job) || index < 1000);
        writeJson(file, retained);
        const ids = new Set(retained.map(job => job.operation_id));
        for (const id of jobs.keys()) if (!ids.has(id)) jobs.delete(id);
    }
    for (const job of jobs.values()) if (!terminal(job)) Object.assign(job, { status: 'failed', phase: 'interrupted', errorCode: 'SERVER_RESTARTED', message: '服务已重启，请重新执行此操作', finishedAt: now() });
    if (jobs.size) save();
    const view = job => job ? structuredClone(job) : null;
    const owns = (job, scope) => job && job.userId === scope.userId && job.diskSpace === (scope.diskSpace || '');
    const api = {
        create(scope, type, message, totalBytes = 0) {
            const job = { operation_id: crypto.randomUUID(), userId: scope.userId, diskSpace: scope.diskSpace || '', type, status: 'queued', phase: 'queued', percent: null, processedBytes: 0, totalBytes, message, errorCode: '', errorMessage: '', createdAt: now(), startedAt: 0, finishedAt: 0 };
            job.title = message; job.updatedAt = now();
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
            Object.assign(job, patch);
            job.updatedAt = now();
            if (Number.isFinite(patch.percent)) job.lastMeasuredPercent = Math.max(job.lastMeasuredPercent || 0, Math.min(100, patch.percent));
            if (job.status === 'running' && !job.startedAt) job.startedAt = now();
            if (terminal(job)) job.finishedAt = now();
            if (immediate || terminal(job)) save();
            else if (!timer) { timer = setTimeout(save, 500); timer.unref?.(); }
            return view(job);
        },
        complete(id, result) { const job = jobs.get(id); return api.update(id, { status: 'completed', phase: 'completed', percent: 100, processedBytes: job?.totalBytes || 0, message: '操作完成', result }, true); },
        fail(id, error) { return api.update(id, { status: 'failed', phase: 'failed', errorCode: String(error?.code || error?.message || 'DISK_OPERATION_FAILED').replace(/https?:\/\/\S+|bot\d+:[\w-]+/g, '[redacted]'), errorMessage: '操作失败，请检查错误码后重试', message: '操作失败' }, true); },
        run(id, work) {
            const job = jobs.get(id);
            if (!job || terminal(job) || executing.has(id)) return false;
            executing.add(id);
            api.update(id, { status: 'running', phase: 'starting' }, true);
            Promise.resolve().then(() => work((patch) => api.update(id, patch))).then(result => api.complete(id, result), error => api.fail(id, error)).finally(() => executing.delete(id));
            return true;
        },
        flush: save
    };
    return api;
}
module.exports = { createDiskOperations };
