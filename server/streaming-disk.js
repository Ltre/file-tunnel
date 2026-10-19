'use strict';
// Consumer-side adapter over the existing object-storage contract. The drive
// API and storage implementation do not import or know about stations.
function createStreamingDisk({ objects, partitions, identity }) {
    const missing = () => { throw new Error('STREAM_SOURCE_DELETED'); };
    function locate(source) {
        const partition = partitions.find(source.userId, source.diskSpace || '');
        const scope = { userId: source.userId, diskSpace: partition.scopeKey };
        let object = source.key && objects.stat?.(scope, source.key);
        if (!object || object.file?.id !== source.fileId) object = objects.list(scope).find(value => value.kind === 'file' && value.file?.id === source.fileId);
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
            const { object } = locate(source);
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
