'use strict';
// A progress update must not move an old job ahead of a newly created job.
(function (root) {
    const timestamp = value => {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) return numeric;
        const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
        return Number.isFinite(parsed) ? parsed : 0;
    };
    const time = job => Math.max(timestamp(job?.createdAt), timestamp(job?.startedAt), timestamp(job?.finishedAt));
    const compare = (a, b) => time(b) - time(a)
        || timestamp(b?.createdAt) - timestamp(a?.createdAt)
        || String(a?.operation_id || '').localeCompare(String(b?.operation_id || ''));
    const sort = jobs => [...jobs].sort(compare);
    const api = { time, compare, sort };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DiskOperationOrder = api;
})(typeof globalThis === 'object' ? globalThis : this);
