'use strict';
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

// Metadata only: never log URLs, cookies, bodies or media transfer payloads.
function createDiskMetadataTiming(log, { slowMs = 500, now = () => performance.now() } = {}) {
    return (req, res, next) => {
        const route = String(req.path || '').match(/\/(me|list|search|tree|directories(?:\/properties)?|collaborations)$/)?.[1];
        if (!route || !['GET', 'POST'].includes(req.method)) return next();
        const trace = { requestId: crypto.randomUUID(), route, startedAt: now() };
        req.diskMetadataTiming = trace;
        const json = res.json;
        res.json = function (data) {
            if (!this.headersSent) {
                this.set('X-Disk-Request-Id', trace.requestId);
                this.append('Server-Timing', `disk-metadata;dur=${Math.max(0, now() - trace.startedAt).toFixed(1)}`);
            }
            return json.call(this, data);
        };
        let recorded = false;
        const record = () => {
            if (recorded) return;
            recorded = true;
            const serverMs = Math.max(0, Math.round(now() - trace.startedAt));
            if (serverMs < slowMs && req.method !== 'POST' && res.statusCode < 400) return;
            log('metadata.request', { requestId: trace.requestId, operationId: trace.operationId || '', method: req.method, route,
                userId: req.diskScope?.userId || '', diskSpace: req.diskScope?.diskSpace || '', serverMs, status: res.statusCode,
                aborted: !res.writableFinished });
        };
        res.once('finish', record);
        res.once('close', record);
        next();
    };
}
module.exports = { createDiskMetadataTiming };
