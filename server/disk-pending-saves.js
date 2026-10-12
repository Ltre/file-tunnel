'use strict';
const crypto = require('node:crypto');
const processBootId = crypto.randomUUID();
const processStartedAt = Date.now() - process.uptime() * 1000;
const processExists = pid => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
function createDiskPendingSaves(repository) {
    const validate = id => {
        if (!/^[a-f0-9-]{36}$/i.test(String(id || ''))) throw new Error('PENDING_SAVE_INVALID');
        return id;
    };
    const read = (userId, id) => repository.load('pending_saves', userId).find(item => item.id === validate(id)) || null;
    const get = (userId, id) => {
        const item = read(userId, id);
        // Before attach(), no pipeline may start and no recoverable operation
        // context has been written. A previous process's bare reservation is
        // therefore safe to retry; elapsed time alone is never proof of failure.
        const previousProcessGone = item && Number.isSafeInteger(item.processId) && item.processId > 0
            && (item.processId === process.pid ? item.createdAt < processStartedAt && item.bootId !== processBootId : !processExists(item.processId));
        if (item?.state === 'reserved' && !item.operationId && previousProcessGone) {
            item.safeRetry = true; item.state = 'failed';
        }
        return item;
    };
    const write = (userId, item) => repository.replace('pending_saves', [
        ...repository.load('pending_saves', userId).filter(old => old.id !== item.id), item
    ], value => value.id, userId);
    const patch = (userId, id, values, expected = {}) => repository.atomic(() => {
        const item = get(userId, id);
        if (!item) return;
        if (expected.uploadId && item.uploadId !== expected.uploadId || expected.attemptId && item.attemptId !== expected.attemptId) return;
        if (item.state === 'completed' && values.state !== 'completed') return;
        Object.assign(item, values, { updatedAt: Date.now() }); write(userId, item);
    });
    return {
        get,
        reserve(userId, id, diskSpace, folderPath, files) {
            validate(id);
            if (!Array.isArray(files) || files.length !== 1 || !files[0] || typeof files[0].name !== 'string') throw new Error('PENDING_SAVE_INVALID');
            const signature = crypto.createHash('sha256').update(JSON.stringify({ diskSpace, folderPath,
                files: files.map(file => ({ name: file.name, size: file.size, type: file.type || '', sha256: file.contentSha256 || '' })) })).digest('hex');
            return repository.atomic(() => {
                const old = get(userId, id);
                if (old && old.signature !== signature) throw new Error('PENDING_SAVE_TARGET_CONFLICT');
                if (old && !old.safeRetry) throw new Error('PENDING_SAVE_ALREADY_STARTED');
                const item = { id, ownerId: userId, diskSpace, folderPath, signature,
                    state: 'reserved', safeRetry: false, attemptId: crypto.randomUUID(), bootId: processBootId, processId: process.pid,
                    createdAt: old?.createdAt || Date.now(), updatedAt: Date.now() };
                write(userId, item); return item;
            });
        },
        attach(userId, id, job, expected = {}) { patch(userId, id, { state: 'uploading', uploadId: job.id, operationId: job.operationId }, expected); },
        complete(userId, id, items, expected = {}) { patch(userId, id, { state: 'completed', safeRetry: false, fileIds: items.map(item => item.id) }, expected); },
        safeFailure(userId, id, expected = {}) { patch(userId, id, { state: 'failed', safeRetry: true }, expected); }
    };
}
module.exports = { createDiskPendingSaves };
