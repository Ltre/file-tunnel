'use strict';
// Consumer-side adapter over the existing object-storage contract. The drive
// API and storage implementation do not import or know about stations.
function createStreamingDisk({ objects, partitions, identity }) {
    const requestIndexes = new WeakMap();
    const missing = () => { throw new Error('STREAM_SOURCE_DELETED'); };
    function locate(source, indexes) {
        const partition = partitions.find(source.userId, source.diskSpace || '');
        const scope = { userId: source.userId, diskSpace: partition.scopeKey };
        let object = source.key && objects.stat?.(scope, source.key);
        if (!object || object.file?.id !== source.fileId) {
            const scopeKey = JSON.stringify(scope); let index = indexes?.get(scopeKey);
            if (!index) { index = new Map(objects.list(scope).filter(value => value.kind === 'file').map(value => [value.file?.id, value])); indexes?.set(scopeKey, index); }
            object = index.get(source.fileId);
        }
        if (!object || ['blocked', 'deleted'].includes(object.file.reviewStatus)) missing();
        return { scope, object };
    }
    return {
        resolve(req, input) {
            const selected = Object.create(req);
            selected.headers = { ...req.headers, 'x-disk-account': String(input.accountId || '') };
            selected.query = { ...req.query }; delete selected.query.disk_account;
            const user = identity(selected);
            if (!user) throw new Error('LOGIN_REQUIRED');
            const source = { kind: 'disk', userId: user.id, diskSpace: String(input.diskSpace || ''), fileId: String(input.fileId || '') };
            let indexes = requestIndexes.get(req); if (!indexes) { indexes = new Map(); requestIndexes.set(req, indexes); }
            const { object } = locate(source, indexes);
            source.key = object.key;
            return { source, name: object.file.name, type: object.type, size: object.size };
        },
        stat(source) {
            const { object } = locate(source);
            return { name: object.file.name, type: object.type, size: object.size };
        },
        async read(source, start, end, signal) {
            const { scope, object } = locate(source);
            const result = await objects.open(scope, object.key, `bytes=${start}-${end}`, signal);
            try { locate(source); } catch (error) { result.stream.destroy(); throw error; }
            return result.stream;
        }
    };
}
module.exports = { createStreamingDisk };
