'use strict';
const mime = require('mime-types');

function createDownloadTaskSource({ services, isAdmin }) {
    return (req, input = {}) => {
        if (!isAdmin(req)) throw new Error('TASK_SAVE_ADMIN_AUTH_REQUIRED');
        const service = ['sns', 'youtube'].includes(input.source) && services[input.source];
        if (!service || typeof input.taskId !== 'string' || input.taskId.length > 100) throw new Error('TASK_SAVE_SOURCE_UNAVAILABLE');
        const task = service.get(input.taskId);
        if (!task || task.status !== 'completed' || !task.hasFile) throw new Error('TASK_SAVE_SOURCE_UNAVAILABLE');
        const version = `${Number(task.completedAt) || 0}-${Number(task.outputFileSize) || 0}`;
        if (!Number(task.completedAt) || !Number.isSafeInteger(task.outputFileSize) || task.outputFileSize <= 0 || input.version !== version) {
            throw new Error('TASK_SAVE_VERSION_CONFLICT');
        }
        const file = service.getFile(input.taskId);
        if (!file) throw new Error('TASK_SAVE_SOURCE_UNAVAILABLE');
        let url = '';
        try {
            const parsed = new URL(task.url || task.sourceUrl || '');
            if (['https:', 'http:'].includes(parsed.protocol)) {
                url = parsed.origin + parsed.pathname;
                if (parsed.searchParams.has('v')) url += '?v=' + encodeURIComponent(parsed.searchParams.get('v'));
            }
        } catch (_) {}
        return { path: file.path, name: file.name, size: task.outputFileSize, version, type: mime.lookup(file.name) || 'application/octet-stream',
            sourceInfo: { title: String(task.title || '').slice(0, 1000), url, platform: String(task.platform || '').slice(0, 40), remark: String(task.remark || '').slice(0, 5000) } };
    };
}
module.exports = { createDownloadTaskSource };
