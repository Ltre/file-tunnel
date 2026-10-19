'use strict';
const fs = require('node:fs'), http = require('node:http'), crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { createDiskPartitions } = require('../disk-partitions');
const { normalizeTelegramDrivePath } = require('../telegram-drive');
function createMediaDiskAdapter({ dataDir, diskAPI, auth, backend }) {
    const partitions = createDiskPartitions({ dataDir, spaces: diskAPI.spaces });
    const storeFor = (location, snapshot) => {
        const key = JSON.stringify([location.userId, location.partitionId || location.diskSpace || '']);
        if (snapshot?.has(key)) return snapshot.get(key);
        if (!auth.user(location.userId)) throw Error('MEDIA_ACCOUNT_UNAVAILABLE');
        const partition = partitions.find(location.userId, location.partitionId || location.diskSpace || '');
        const store = diskAPI.spaces.get(partition.scopeKey); store.reloadPersistence();
        const result = { store, partition }; snapshot?.set(key, result); return result;
    };
    function location(value, actor) {
        if (!actor || String(value.userId) !== actor.id) throw Error('MEDIA_LOCATION_NOT_AUTHORIZED');
        const { store, partition } = storeFor(value), folder = normalizeTelegramDrivePath(String(value.path || '').replace(/^\//, ''));
        for (let parent = folder; parent; parent = parent.split('/').slice(0, -1).join('/')) {
            const item = store.getDirectoryRecord(actor.id, parent); if (!item || ['blocked', 'deleted'].includes(item.reviewStatus)) throw Error('MEDIA_DIRECTORY_UNAVAILABLE');
        }
        diskAPI.objectStorage.assertWritable({ userId: actor.id, diskSpace: partition.scopeKey }, folder);
        const configured = backend(); if (!configured?.token || !configured.channelId) throw Error('MEDIA_BACKEND_UNAVAILABLE');
        return { userId: actor.id, userName: actor.name || actor.username || actor.id, partitionId: partition.id, diskSpace: partition.scopeKey,
            partitionName: partition.displayName, path: folder, backendId: configured.id || '', channelId: String(configured.channelId) };
    }
    function checkLocation(value, snapshot) {
        const { store, partition } = storeFor(value, snapshot);
        if (partition.scopeKey !== value.diskSpace) throw Error('MEDIA_PARTITION_CHANGED');
        for (let parent = value.path;; parent = parent.split('/').slice(0, -1).join('/')) {
            const item = store.getDirectoryRecord(value.userId, parent);
            if (!item || ['blocked', 'deleted'].includes(item.reviewStatus)) throw Error('MEDIA_DIRECTORY_UNAVAILABLE');
            if (!parent) break;
        }
        const storage = value.backendId ? auth.backend(value.backendId) : backend();
        if (!storage?.token || String(storage.channelId) !== value.channelId) throw Error('MEDIA_BACKEND_CHANGED');
        diskAPI.objectStorage.assertWritable({ userId: value.userId, diskSpace: value.diskSpace }, value.path);
        return { store, partition };
    }
    function file(reference, snapshot) {
        const { store, partition } = storeFor(reference, snapshot), item = store.get(reference.userId, reference.fileId);
        if (!item || item.trashId || ['blocked', 'deleted'].includes(item.reviewStatus)) throw Error('MEDIA_SOURCE_UNAVAILABLE');
        for (let parent = item.folderPath; parent; parent = parent.split('/').slice(0, -1).join('/')) {
            const directory = store.getDirectoryRecord(reference.userId, parent);
            if (!directory || ['blocked', 'deleted'].includes(directory.reviewStatus)) throw Error('MEDIA_SOURCE_UNAVAILABLE');
        }
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify([item.id, item.contentId, item.contentSha256, item.size,
            (item.parts || []).map(p => [p.sha256, p.fileUniqueId, p.size])])).digest('hex');
        if (reference.fingerprint && reference.fingerprint !== fingerprint) throw Error('MEDIA_SOURCE_CHANGED');
        return { item, partition, fingerprint, key: [item.folderPath, item.name].filter(Boolean).join('/') };
    }
    async function open(reference, range, signal) {
        const current = file(reference), mapping = { userId: reference.userId, diskSpace: reference.diskSpace };
        const opened = await diskAPI.objectStorage.open(mapping, current.key, range, signal);
        return { ...opened, current };
    }
    async function ensureDirectory(root, relative, assertAuthorized, signal) {
        const normalized=normalizeTelegramDrivePath(relative);if(!normalized||normalized!==relative)throw Error('MEDIA_LOCATION_INVALID');
        assertAuthorized();let {store}=checkLocation(root),destination=root;
        for(const segment of normalized.split('/')){
            signal?.throwIfAborted();assertAuthorized();checkLocation(destination);
            const child={...root,path:[destination.path,segment].filter(Boolean).join('/')};
            diskAPI.objectStorage.assertWritable({userId:root.userId,diskSpace:root.diskSpace},child.path);
            if(!store.getDirectoryRecord(root.userId,child.path))await diskAPI.objectStorage.put({userId:root.userId,diskSpace:root.diskSpace,sourceAppId:'media-library',assertAuthorized:()=>{assertAuthorized();checkLocation(destination);}},child.path+'/',Readable.from([]),{size:0,signal});
            checkLocation(child);destination=child;
        }
        return destination;
    }
    async function write(location, localPath, name, producerId, assertAuthorized, signal, onProgress) {
        assertAuthorized(); const { store } = checkLocation(location);
        const key = [location.path, name].filter(Boolean).join('/'), mapping = { userId: location.userId, diskSpace: location.diskSpace, sourceAppId: 'media-library',
            backendId: location.backendId, assertAuthorized: () => { assertAuthorized(); checkLocation(location); } };
        const existing = diskAPI.objectStorage.stat(mapping, key);
        if (existing) {
            if (existing.file?.metadata?.mediaProducerId !== producerId) throw Error('MEDIA_OUTPUT_NAME_CONFLICT');
            return { ...location, fileId: existing.file.id, name: existing.file.name, size: existing.file.size, type: existing.file.type, ...file({ ...location, fileId: existing.file.id }) };
        }
        const staging = pathForStaging(location.diskSpace);
        if (fs.existsSync(staging)) for (const entry of fs.readdirSync(staging, { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
            const manifest = require('node:path').join(staging, entry.name, 'upload-manifest.json');
            if (!fs.existsSync(manifest)) continue;
            try { if (JSON.parse(fs.readFileSync(manifest, 'utf8')).metadata?.mediaProducerId === producerId) throw Error('MEDIA_WRITE_PENDING'); }
            catch (error) { if (error.message === 'MEDIA_WRITE_PENDING') throw error; }
        }
        const stat = fs.statSync(localPath); if (!stat.isFile() || !stat.size || stat.size > diskAPI.objectStorage.limit) throw Error('MEDIA_FILE_SIZE_INVALID');
        const extension = name.split('.').at(-1).toLowerCase();
        const type = ({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', mkv: 'video/x-matroska' })[extension] || 'application/octet-stream';
        const hash = crypto.createHash('sha256');
        onProgress?.({ percent: 0, phase: 'hashing', detail: '正在校验本地文件正文', totalBytes: stat.size });
        for await (const chunk of fs.createReadStream(localPath, { signal })) hash.update(chunk);
        onProgress?.({ percent: 0, phase: 'upload', detail: '正在提交正文并等待 Telegram 确认', totalBytes: stat.size });
        await diskAPI.objectStorage.put(mapping, key, fs.createReadStream(localPath), { size: stat.size, contentType: type, expectedSha256: hash.digest('hex'), metadata: { mediaProducerId: producerId, mediaSubsystem: 'media-library' }, signal, onProgress });
        onProgress?.({ percent: 99, phase: 'committing', detail: '正文已确认，正在确认网盘文件引用', totalBytes: stat.size });
        assertAuthorized(); const output = diskAPI.objectStorage.stat(mapping, key);
        if (!output || output.file.metadata?.mediaProducerId !== producerId) throw Error('MEDIA_WRITE_UNCONFIRMED');
        return { ...location, fileId: output.file.id, name: output.file.name, size: output.size, type, fingerprint: file({ ...location, fileId: output.file.id }).fingerprint };
    }
    function pathForStaging(space) {
        const path = require('node:path');
        return path.join(space ? path.join(dataDir, 'disk-spaces', crypto.createHash('sha256').update(space).digest('hex')) : dataDir, 'telegram-drive-staging');
    }
    async function remove(reference, producerId, assertAuthorized) {
        assertAuthorized(); const current = file(reference);
        if (current.item.metadata?.mediaProducerId !== producerId) throw Error('MEDIA_EXTERNAL_FILE_PROTECTED');
        await diskAPI.objectStorage.remove({ userId: reference.userId, diskSpace: reference.diskSpace }, current.key);
    }
    return { location, checkLocation, file, open, ensureDirectory, write, remove,
        directories(userId, space) { const { store } = storeFor({ userId, diskSpace: space }); return store.listDirectories(userId).filter(d => !['blocked', 'deleted'].includes(d.reviewStatus)); },
        partitions: userId => partitions.list(userId) };
}
// FFmpeg only receives a short-lived loopback URL. No external host, browser
// cookie, S3 secret or credential is embedded in its command line.
async function createLoopbackSource(read, signal) {
    const token = crypto.randomBytes(24).toString('hex'), controllers = new Set();
    const server = http.createServer(async (req, res) => {
        if (req.url !== '/' + token || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404).end(); return; }
        const abort = new AbortController(); controllers.add(abort);
        const close = () => { if (!res.writableFinished) abort.abort(); controllers.delete(abort); }; res.once('close', close);
        try {
            const data = await read(req.headers.range, abort.signal);
            const { range, object, stream } = data;
            res.writeHead(range.partial ? 206 : 200, { 'Content-Type': object.type || 'application/octet-stream', 'Accept-Ranges': 'bytes',
                'Content-Length': range.end - range.start + 1, ...(range.partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${object.size}` } : {}) });
            if (req.method === 'HEAD') { stream.destroy(); res.end(); } else await pipeline(stream, res, { signal: abort.signal });
        } catch (_) { if (!res.headersSent) res.writeHead(404).end(); else res.destroy(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}/${token}`; let closed = false;
    const close = () => { if (closed) return; closed = true; controllers.forEach(c => c.abort()); server.closeAllConnections(); server.close(); };
    if (signal?.aborted) { close(); throw Error('MEDIA_CANCELLED'); }
    signal?.addEventListener('abort', close, { once: true });
    return { url, close() { signal?.removeEventListener('abort', close); close(); } };
}
module.exports = { createMediaDiskAdapter, createLoopbackSource };
