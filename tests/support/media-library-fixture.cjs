'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), { Readable } = require('node:stream');
const { createMediaLibrary } = require('../../server/media-library/service');
function createFixture(options = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr2t-media-library-')); let time = Date.now(), writes = 0, failAfterWrite = false, openCount = 0;
    const files = new Map(), removed = [], tasks = new Map(), unavailable = new Set();
    const location = { userId: 'alice', diskSpace: '', partitionId: 'default', partitionName: '默认分区', path: 'work', channelId: '-1001' };
    function file(ref) { const value = files.get(ref.fileId); if (!value || unavailable.has(ref.fileId) || value.ref.userId !== ref.userId || value.ref.diskSpace !== ref.diskSpace) throw Error('MEDIA_SOURCE_UNAVAILABLE');
        if (ref.fingerprint && ref.fingerprint !== value.ref.fingerprint) throw Error('MEDIA_SOURCE_CHANGED'); return { item: { ...value.ref, id: value.ref.fileId }, fingerprint: value.ref.fingerprint }; }
    function put(body, details = {}) { const fileId = crypto.randomUUID(), bytes = Buffer.from(body), ref = { ...location, fileId, name: 'video.mp4', size: bytes.length, type: 'video/mp4', fingerprint: crypto.createHash('sha256').update(bytes).digest('hex'), ...details };
        files.set(fileId, { ref, bytes }); return ref; }
    const disk = { location(value, actor) { if (actor?.id !== value.userId) throw Error('MEDIA_LOCATION_NOT_AUTHORIZED'); return { ...location, ...value }; }, checkLocation(value) { if (unavailable.has(value.path)) throw Error('MEDIA_DIRECTORY_UNAVAILABLE'); }, file,
        async open(ref, header, signal) { file(ref); if (signal?.aborted) throw Error('MEDIA_CANCELLED'); openCount++; const record = files.get(ref.fileId);
            const m = /bytes=(\d+)-(\d*)/.exec(header || ''), start = m ? Number(m[1]) : 0, end = m?.[2] ? Number(m[2]) : record.bytes.length - 1;
            const stream = Readable.from([record.bytes.subarray(start, end + 1)]); signal?.addEventListener('abort', () => stream.destroy(), { once: true });
            return { object: { size: record.bytes.length, type: record.ref.type }, range: { start, end, partial: !!m }, stream }; },
        async ensureDirectory(loc,relative,authorized,signal){authorized();if(signal?.aborted)throw Error('MEDIA_CANCELLED');return {...loc,path:[loc.path,relative].filter(Boolean).join('/')};},
        async write(loc, localPath, name, producer, authorized, signal) { authorized(); if (signal?.aborted) throw Error('MEDIA_CANCELLED');
            const existing = [...files.values()].find(f => f.producer === producer); if (existing) return existing.ref;
            writes++; const ref = put(fs.readFileSync(localPath), { ...loc, name }); files.get(ref.fileId).producer = producer;
            if (failAfterWrite) { failAfterWrite = false; throw Error('MEDIA_WRITE_UNCONFIRMED'); } return ref; },
        async remove(ref, producer, authorized) { authorized(); file(ref); if (files.get(ref.fileId).producer !== producer) throw Error('MEDIA_EXTERNAL_FILE_PROTECTED'); files.delete(ref.fileId); removed.push(ref.fileId); },
        partitions: () => [{ id: 'default', scopeKey: '', name: '默认分区' }], directories: () => [{ path: 'work', name: 'work' }, { path: 'collection', name: 'collection' }] };
    const downloads = { sns: { get: id => tasks.get(id), getFile: id => { const task = tasks.get(id); return task?.status === 'completed' ? { path: task.path, name: 'download.mp4' } : null; }, list: () => ({ tasks: [...tasks.values()], page: 1, pages: 1 }) } }; downloads.youtube = downloads.sns;
    const probe = { format: { duration: '4', start_time: '0' }, streams: [{ codec_type: 'video', codec_name: 'h264', duration: '4' }, { codec_type: 'audio', codec_name: 'aac', duration: '4' }] };
    const signature = { dHash: 'ffffffffffffffff', pixels: Buffer.alloc(1024, 80).toString('base64') };
    const processing = { async probe(url) { if (url.startsWith('http:')) { const response = await fetch(url); if (!response.ok) throw Error('MEDIA_DECODE_FAILED'); await response.arrayBuffer(); } return probe; },
        probeVersion: async () => ['fixture'], signature: async () => signature,
        async frame(url, requested, output, sourceProbe, signal) { if (signal?.aborted) throw Error('MEDIA_CANCELLED'); fs.writeFileSync(output, 'image'); return { ...signature, sha256: 'aa', actualMs: Math.ceil(requested * 25) / 25 * 1000, requestedMs: requested * 1000 }; },
        async cut(url, start, end, output, settings) { if (settings.signal?.aborted) throw Error('MEDIA_CANCELLED'); fs.writeFileSync(output, 'clip'); return { precise: settings.precise, duration: end - start }; }, frameNeighbors: async () => [.32, .4, .48] };
    const service = createMediaLibrary({ dataDir, disk, downloads, processing: options.processing || processing, autoStart: false, now: () => time });
    function configure() { service.configureLocation('workspace', { ...location }, { id: 'alice' }); service.configureLocation('collection', { ...location, path: 'collection' }, { id: 'alice' }); }
    configure();
    return { service, disk, downloads, dataDir, files, tasks, removed, unavailable, put, location, get writes() { return writes; }, get openCount() { return openCount; },
        failAfterWrite() { failAfterWrite = true; }, advance(ms) { time += ms; }, async close() { await service.close(); if (!dataDir.startsWith(path.join(os.tmpdir(), 'dr2t-media-library-'))) throw Error('unsafe cleanup'); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
module.exports = { createFixture };
