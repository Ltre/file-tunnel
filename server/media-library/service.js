'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { createMediaDatabase } = require('./database');
const { createMediaCache } = require('./cache');
const { createLoopbackSource } = require('./disk-adapter');
const { createMediaProcessing, sampleTimes, durationOf, similarity } = require('./processing');
const { clipName } = require('./clip-name');
const nameOf = value => String(value || '资源').replace(/[\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 145) || '资源';
function createMediaLibrary({ dataDir, disk, downloads, processing = createMediaProcessing(), now = Date.now, autoStart = true }) {
    const db = createMediaDatabase(dataDir, now), cache = createMediaCache({ dataDir, database: db, now });
    const boot = crypto.randomUUID(), controllers = new Map(), receivers = new Set(); let busy = false, closed = false, closePromise, timer, lastCleanup = now();
    const config = () => db.get('config', 'media-config', 'system');
    const scope = () => config()?.workspace?.userId || '';
    const requireConfig = () => { if (closed) throw Error('MEDIA_SERVICE_STOPPING'); const value = config(); if (!value?.workspace || !value?.collection) throw Error('MEDIA_SETUP_REQUIRED'); return value; };
    const item = (kind, id, tenant = scope()) => { const value = db.get(kind, id, tenant); if (!value) throw Error('MEDIA_RECORD_NOT_FOUND'); return value; };
    function grant(id, purpose, snapshot) {
        const value = item('grant', id); if (value.revokedAt || purpose && value.purpose !== purpose) throw Error('MEDIA_AUTHORIZATION_REVOKED');
        disk.checkLocation(value.location, snapshot); return value;
    }
    function configureLocation(purpose, value, actor) {
        if (!['workspace', 'collection'].includes(purpose)) throw Error('MEDIA_LOCATION_INVALID');
        const location = disk.location(value, actor), old = config();
        if (old?.workspace && purpose === 'workspace' && old.workspace.userId !== location.userId
            && (receivers.size || db.list('job', old.workspace.userId, { limit: 10000 }).some(j => ['queued', 'running'].includes(j.state))
                || db.list('import', old.workspace.userId, { limit: 10000 }).some(r => ['receiving', 'waiting-download', 'awaiting-task'].includes(r.state)))) throw Error('MEDIA_CONFIG_BUSY');
        if (purpose === 'collection' && !old?.workspace) throw Error('MEDIA_WORKSPACE_FIRST');
        if (purpose === 'collection' && location.userId === old.workspace.userId && location.diskSpace === old.workspace.diskSpace && location.path === old.workspace.path) throw Error('MEDIA_LOCATION_OVERLAP');
        const tenant = purpose === 'workspace' ? location.userId : old.workspace.userId;
        return db.atomic(() => {
            // Explicit reauthorization of the same account/partition/folder
            // renews its earlier grants, while another location never redirects
            // existing sources or pending writes.
            for (const earlier of db.matching('grant', tenant, 'purpose', purpose)) {
                if (earlier.location.userId === location.userId && earlier.location.diskSpace === location.diskSpace && earlier.location.path === location.path)
                    db.patch('grant', earlier.id, tenant, { location, revokedAt: 0, authorizedAt: now() });
            }
            const authorization = db.create('grant', tenant, { purpose, location, authorizedAt: now(), revokedAt: 0 });
            const patch = { [purpose]: { ...location, grantId: authorization.id }, caches: old?.caches || cache.validate(), initialized: true };
            if (!old) return db.create('config', 'system', patch, 'media-config');
            // Switching workspace identity does not silently reuse another
            // tenant's collection authorization or existing jobs.
            if (purpose === 'workspace' && old.workspace.userId !== tenant) patch.collection = null;
            return db.patch('config', 'media-config', 'system', patch);
        });
    }
    function setCachePolicies(input) {
        const policies = cache.validate(input); cache.check(policies);
        const old = config(); if (!old) throw Error('MEDIA_SETUP_REQUIRED');
        return db.patch('config', old.id, 'system', { caches: policies });
    }
    function queue(type, context, id = crypto.randomUUID()) {
        return db.create('job', scope(), { type, context, state: 'queued', progress: 0, error: '', attempts: 0, cancelled: false }, id);
    }
    function createImport(input, actor) {
        const settings = requireConfig(); grant(settings.workspace.grantId, 'workspace');
        const kind = String(input.kind), service = downloads[kind];
        let source, sourceKey;
        if (kind === 'disk') {
            if (!actor || actor.id !== String(input.userId)) throw Error('MEDIA_SOURCE_NOT_AUTHORIZED');
            const current = disk.file(input); source = { userId: actor.id, diskSpace: input.diskSpace || '', partitionId: input.partitionId,
                fileId: input.fileId, fingerprint: current.fingerprint, name: current.item.name, size: current.item.size, type: current.item.type,
                userName: actor.name || actor.username || actor.id, partitionName: current.partition?.displayName || input.diskSpace || '默认分区', path: current.item.folderPath || '' };
            sourceKey = 'disk:' + actor.id + ':' + source.diskSpace + ':' + source.fileId + ':' + source.fingerprint;
        } else if (service) {
            const task = service.get(input.taskId); if (!task) throw Error('MEDIA_DOWNLOAD_NOT_FOUND');
            source = { kind, taskId: task.id, url: task.url, version: `${task.completedAt || 0}-${task.outputFileSize || 0}` };
            sourceKey = kind + ':' + task.id;
        } else throw Error('MEDIA_IMPORT_KIND_INVALID');
        return db.atomic(() => {
            const existing = db.matching('import', scope(), 'sourceKey', sourceKey)[0]; if (existing) return existing;
            const record = db.create('import', scope(), { sourceKey, source, kind, name: source.name || nameOf(service?.get(input.taskId)?.title),
                state: kind === 'disk' ? 'queued' : 'waiting-download', managed: kind !== 'disk', location: settings.workspace });
            if (kind === 'disk') queue('import', { importId: record.id }); return record;
        });
    }
    function createLink(input) {
        const settings = requireConfig(); grant(settings.workspace.grantId, 'workspace');
        const url = new URL(String(input.url)); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 4000) throw Error('MEDIA_SOURCE_URL_INVALID');
        const kind = /(^|\.)(youtube\.com|youtu\.be)$/.test(url.hostname) ? 'youtube' : 'sns';
        const sourceKey = 'link:' + crypto.createHash('sha256').update(kind + url.href).digest('hex');
        return db.atomic(() => {
            let record = db.matching('import', scope(), 'sourceKey', sourceKey)[0];
            if (record?.state === 'ready') return { record, url: '/media-library' };
            if (record && ['cancelled', 'expired'].includes(record.state)) record = db.patch('import', record.id, scope(), { state: 'awaiting-task', source: { kind, url: url.href }, bindToken: crypto.randomBytes(24).toString('base64url') });
            if (!record) record = db.create('import', scope(), { kind, name: url.hostname, sourceKey, source: { kind, url: url.href }, state: 'awaiting-task', managed: true,
                bindToken: crypto.randomBytes(24).toString('base64url'), location: settings.workspace });
            return { record, url: `/${kind === 'youtube' ? 'youtube-premium-dl' : 'sns-dl'}?media_import=${record.id}&media_bind=${record.bindToken}&url=${encodeURIComponent(url.href)}` };
        });
    }
    function attachTask(id, kind, taskId, token) {
        return db.atomic(() => {
            const record = item('import', id), task = downloads[kind]?.get(taskId);
            if (record.kind !== kind || record.bindToken !== token || !task || task.url !== record.source.url) throw Error('MEDIA_TASK_LINK_INVALID');
            if (record.source.taskId && record.source.taskId !== task.id) throw Error('MEDIA_TASK_ALREADY_BOUND');
            return db.patch('import', id, scope(), { state: record.state === 'ready' ? 'ready' : 'waiting-download', source: { ...record.source, taskId: task.id, version: `${task.completedAt || 0}-${task.outputFileSize || 0}` } });
        });
    }
    async function guardReceive(signal, work) {
        const controller = new AbortController(); receivers.add(controller);
        try { return await work(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal); } finally { receivers.delete(controller); }
    }
    async function receive(input, body, actor, signal) { return guardReceive(signal, combined => receiveBody(input, body, actor, combined)); }
    async function receiveBody(input, body, actor, signal) {
        const settings = requireConfig(); grant(settings.workspace.grantId, 'workspace');
        if (!actor || actor.id !== settings.workspace.userId) throw Error('MEDIA_UPLOAD_ACCOUNT_INVALID');
        const size = Number(input.size); if (!Number.isSafeInteger(size) || size < 1 || size > 2000 * 1024 ** 2 || size > settings.caches.candidates.maxBytes) throw Error('MEDIA_FILE_SIZE_INVALID');
        const record = db.create('import', scope(), { kind: 'local', name: nameOf(input.name), type: String(input.type || '').slice(0, 120), size,
            sourceKey: 'local:' + crypto.randomUUID(), state: 'receiving', receivingPid: process.pid, managed: true, location: settings.workspace });
        let allocated;
        try { allocated = cache.allocate(scope(), 'candidates', settings.caches.candidates, undefined, '.' + (path.extname(record.name).slice(1).replace(/[^a-z0-9]/ig, '').slice(0, 10) || 'bin'), size); }
        catch (error) { db.patch('import', record.id, record.scope, { state: 'import-failed', error: error.message }); throw error; }
        db.patch('import', record.id, record.scope, { source: { cacheId: allocated.record.id } });
        let received = 0; const digest = crypto.createHash('sha256');
        try {
            await pipeline(body, new Transform({ transform(chunk, encoding, done) { received += chunk.length; digest.update(chunk);
                if (received > size) return done(Error('MEDIA_UPLOAD_SIZE_MISMATCH')); done(null, chunk); } }), fs.createWriteStream(allocated.path, { flags: 'wx' }), { signal });
            if (received !== size) throw Error('MEDIA_UPLOAD_SIZE_MISMATCH'); cache.commit(scope(), allocated.record.id, settings.caches.candidates);
            const updated = db.atomic(() => { const value = db.patch('import', record.id, scope(), { state: 'queued', source: { cacheId: allocated.record.id, sha256: digest.digest('hex') } }); queue('import', { importId: record.id }); return value; });
            return updated;
        } catch (error) { cache.discard(scope(), allocated.record.id); db.patch('import', record.id, scope(), {
            state: signal?.aborted ? 'cancelled' : 'import-failed', error: signal?.aborted ? 'MEDIA_CANCELLED' : 'MEDIA_UPLOAD_INTERRUPTED' }); throw error; }
    }
    async function sourceInput(resource, signal, range) {
        if (resource.state !== 'ready') throw Error('MEDIA_IMPORT_NOT_READY');
        if (resource.managed) grant(resource.location.grantId, 'workspace');
        disk.file(resource.file);
        const segment = range?.cacheId ? db.get('cache', range.cacheId, resource.scope)
            : range && !range.original && db.list('cache', resource.scope).find(c => c.kind === 'segments' && c.status === 'ready' && c.precise
                && c.sourceFingerprint === resource.file.fingerprint && c.start <= range.start && c.end >= range.end && (!range.audio || c.audio));
        if (range?.cacheId && (!segment || segment.kind !== 'segments' || segment.status !== 'ready' || !segment.precise
            || segment.sourceFingerprint !== resource.file.fingerprint)) throw Error('MEDIA_SEGMENT_SOURCE_INVALID');
        if (segment) {
            const lease = cache.acquire(resource.scope, segment.id);
            try { return { url: lease.path, offset: segment.start, probe: await processing.probe(lease.path, signal), close: () => lease.release() }; }
            catch (error) { lease.release(); throw error; }
        }
        const loopback = await createLoopbackSource((range, readSignal) => {
            disk.file(resource.file); return disk.open(resource.file, range, readSignal);
        }, signal); return { ...loopback, offset: 0, probe: resource.probe };
    }
    async function processImport(job, signal) {
        const record = item('import', job.context.importId, job.scope), currentConfig = requireConfig();
        if (record.state === 'ready') return record;
        let reference, lease;
        try {
            db.patch('import', record.id, job.scope, { state: 'transferring', error: '' });
            if (record.kind === 'disk') reference = record.source;
            else {
                const authorization = grant(record.location.grantId, 'workspace'); let localPath, name = record.name;
                if (record.kind === 'local') { lease = cache.acquire(job.scope, record.source.cacheId); localPath = lease.path; }
                else {
                    const service = downloads[record.kind], task = service.get(record.source.taskId), file = service.getFile(record.source.taskId);
                    if (task?.status !== 'completed' || !file) throw Error('MEDIA_DOWNLOAD_PRODUCT_UNAVAILABLE');
                    const version = `${task.completedAt}-${task.outputFileSize}`;
                    if (record.source.version && record.source.version !== '0-0' && record.source.version !== version) throw Error('MEDIA_SOURCE_CHANGED');
                    db.patch('import', record.id, job.scope, { source: { ...record.source, version } }); localPath = file.path; name = nameOf(file.name); record.name = name;
                }
                reference = await disk.write(authorization.location, localPath, `${record.id.slice(0, 8)}-${name}`, record.id, () => grant(record.location.grantId, 'workspace'), signal);
            }
            const temporary = await createLoopbackSource((range, readSignal) => disk.open(reference, range, readSignal), signal);
            let probe, signature;
            try { probe = await processing.probe(temporary.url, signal);
                if (reference.type?.startsWith('image/') || !durationOf(probe)) signature = await processing.signature(temporary.url, signal); }
            finally { temporary.close(); }
            const isVideo = probe.streams?.some(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
            if (!isVideo) throw Error('MEDIA_TYPE_UNSUPPORTED');
            return db.patch('import', record.id, job.scope, { state: 'ready', file: reference, probe, signature, name: record.name, duration: durationOf(probe), importedAt: now(),
                expiresAt: record.managed ? now() + 365 * 86400000 : 0, error: '' });
        } finally { lease?.release(); }
    }
    function createSession(importId, name) {
        const resource = item('import', importId); if (resource.state !== 'ready' || !resource.duration) throw Error('MEDIA_VIDEO_REQUIRED');
        disk.file(resource.file); return db.create('session', scope(), { importId, name: nameOf(name || '提取会话'), state: 'active' });
    }
    function extract(sessionId, parameters) {
        const session = item('session', sessionId); if (session.state !== 'active') throw Error('MEDIA_SESSION_REMOVED');
        const resource = item('import', session.importId), times = sampleTimes(parameters, resource.duration);
        return db.atomic(() => { const previous = db.matching('batch', scope(), 'sessionId', sessionId);
            const ordinal = Math.max(previous.length, ...previous.map(value => value.ordinal || 0)) + 1;
            const batch = db.create('batch', scope(), { sessionId, importId: resource.id, ordinal, parameters, times, state: 'queued', actualCount: 0 });
            return { batch, job: queue('frames', { batchId: batch.id }) }; });
    }
    async function processFrames(job, signal, progress) {
        const batch = item('batch', job.context.batchId), session = item('session', batch.sessionId);
        const resource = item('import', session.importId), settings = requireConfig();
        db.patch('batch', batch.id, job.scope, { state: 'running', error: '' });
        progress(0, { phase: 'source', detail: '正在读取源视频并准备取帧', framesDone: 0, framesTotal: batch.times.length });
        const source = await sourceInput(resource, signal, { start: Math.min(...batch.times), end: Math.max(...batch.times) });
        try {
            for (let index = 0; index < batch.times.length; index++) {
                if (signal.aborted) throw Error('MEDIA_CANCELLED');
                progress(Math.floor(index / batch.times.length * 99), { phase: 'extracting', detail: `正在提取第 ${index + 1}/${batch.times.length} 帧 · 目标时刻 ${batch.times[index].toFixed(3)} 秒`, framesDone: index, framesTotal: batch.times.length });
                const id = batch.id + '-' + index;
                const existing = db.get('result', id, job.scope), oldCache = existing && db.get('cache', existing.cacheId, job.scope);
                if (!existing || oldCache?.status !== 'ready' || !fs.existsSync(cache.filename(oldCache))) {
                    const output = cache.allocate(job.scope, 'candidates', settings.caches.candidates, undefined, '.jpg');
                    try {
                        const signature = await processing.frame(source.url, batch.times[index] - source.offset, output.path, source.probe, signal);
                        signature.actualMs += Math.round(source.offset * 1000); signature.requestedMs = Math.round(batch.times[index] * 1000);
                        cache.commit(job.scope, output.record.id, settings.caches.candidates);
                        const duplicates = db.frameDuplicates(job.scope, resource.id, signature.actualMs).filter(id => id !== existing?.id);
                        const payload = { sessionId: session.id, batchId: batch.id, importId: resource.id, kind: 'image', cacheId: output.record.id,
                            ...signature, extractedAt: now(), duplicateIds: duplicates, savedId: existing?.savedId || '' };
                        if (existing) db.patch('result', id, job.scope, payload); else db.create('result', job.scope, payload, id);
                    } catch (error) { cache.discard(job.scope, output.record.id); throw error; }
                }
                db.patch('batch', batch.id, job.scope, { actualCount: index + 1 });
                progress(Math.round((index + 1) / batch.times.length * 99), { phase: 'extracting', detail: `已提取 ${index + 1}/${batch.times.length} 帧`, framesDone: index + 1, framesTotal: batch.times.length });
            }
            return db.patch('batch', batch.id, job.scope, { state: 'completed', actualCount: batch.times.length, error: '' });
        } finally { source.close(); }
    }
    function clip(sessionId, input, segment = false) {
        const session = item('session', sessionId), resource = item('import', session.importId);
        const start = Number(input.start), end = Number(input.end); if (!(start >= 0 && end > start && end <= resource.duration)) throw Error('MEDIA_RANGE_INVALID');
        if (segment && end - start > 3600) throw Error('MEDIA_SEGMENT_LIMIT');
        return queue(segment ? 'segment' : 'clip', { sessionId, importId: resource.id, start, end, audio: input.audio !== false, precise: input.precise !== false });
    }
    async function processClip(job, signal, progress) {
        progress(1, { phase: 'preparing', detail: '正在检查来源、授权及可复用片段' });
        const input = job.context, resource = item('import', input.importId), settings = requireConfig();
        const cacheKind = job.type === 'segment' ? 'segments' : 'candidates';
        const prior = db.get('result', job.id, job.scope), priorCache = prior && db.get('cache', prior.cacheId, job.scope);
        if (prior && priorCache?.status === 'ready' && fs.existsSync(cache.filename(priorCache))) return prior;
        const reusable = job.type === 'segment' && db.list('cache', job.scope).find(c => c.kind === 'segments' && c.status === 'ready'
            && c.sourceFingerprint === resource.file.fingerprint && c.start === input.start && c.end === input.end && c.audio === input.audio && c.precise === input.precise);
        if (reusable) { const lease = cache.acquire(job.scope, reusable.id); lease.release(); return { cacheId: reusable.id }; }
        const allocated = cache.allocate(job.scope, cacheKind, settings.caches[cacheKind], undefined, '.mp4');
        let source, capacityError;
        const meter = setInterval(() => { try { if (fs.existsSync(allocated.path)) cache.reserve(job.scope, allocated.record.id, fs.statSync(allocated.path).size, settings.caches[cacheKind]); }
            catch (error) { capacityError = error; controllers.get(job.id)?.abort(); } }, 250); meter.unref?.();
        try {
            progress(3, { phase: 'source', detail: '正在读取源视频，准备截取区间' });
            source = await sourceInput(resource, signal, job.type === 'clip' ? input : undefined);
            let outputTail = '';
            const stages = { transcoding: [5, '正在截取并编码视频和音轨'], validating: [82, '正在校验片段时长及音画轨道'], decoding: [87, '正在完整解码检查输出片段'], timeline: [96, '正在检查帧时间及音画同步'] };
            const quality = await processing.cut(source.url, input.start - source.offset, input.end - source.offset, allocated.path, { ...input, sourceProbe: source.probe, signal,
                onStage: phase => { const stage = stages[phase]; if (stage) progress(stage[0], { phase, detail: stage[1] }); },
                onOutput: text => { outputTail = (outputTail + text).slice(-8192); const found = [...outputTail.matchAll(/out_time_us=(\d+)/g)].at(-1);
                    if (found) progress(Math.min(81, 5 + Number(found[1]) / 1e6 / (input.end - input.start) * 76),
                        { phase: 'transcoding', detail: '正在截取并编码视频和音轨', processedSeconds: Number(found[1]) / 1e6, durationSeconds: input.end - input.start }); } });
            progress(99, { phase: 'committing', detail: '正在确认并保存完整工作片段' });
            cache.commit(job.scope, allocated.record.id, settings.caches[cacheKind]);
            db.patch('cache', allocated.record.id, job.scope, { sourceFingerprint: resource.file.fingerprint, start: input.start, end: input.end, audio: input.audio, precise: input.precise, importId: resource.id });
            if (job.type === 'segment') return { cacheId: allocated.record.id, quality };
            const payload = { sessionId: input.sessionId, importId: resource.id, kind: 'clip', cacheId: allocated.record.id,
                startMs: Math.round(input.start * 1000), endMs: Math.round(input.end * 1000), quality, savedId: prior?.savedId || '', extractedAt: now() };
            return prior ? db.patch('result', prior.id, job.scope, payload) : db.create('result', job.scope, payload, job.id);
        } catch (error) { cache.discard(job.scope, allocated.record.id); throw capacityError || error; }
        finally { clearInterval(meter); source?.close(); }
    }
    function collect(resultId, input = {}) {
        const resource = item('result', resultId), settings = requireConfig(); grant(settings.collection.grantId, 'collection');
        return db.atomic(() => {
            const existing = db.matching('collection', scope(), 'resultId', resource.id)[0];
            if (existing && existing.state !== 'deleted') {
                if (['failed', 'cancelled'].includes(existing.state)) {
                    const job = db.list('job', scope()).find(j => j.type === 'collect' && j.context.collectionId === existing.id);
                    if (job && ['failed', 'cancelled', 'interrupted'].includes(job.state)) retry(job.id);
                }
                return item('collection', existing.id);
            }
            if (existing) { const value = db.patch('collection', existing.id, scope(), { state: 'queued', location: settings.collection }); queue('collect', { collectionId: value.id }); return value; }
            const value = db.create('collection', scope(), { resultId, clipNamed:resource.kind==='clip', name: resource.kind==='clip'?clipName(item('session',resource.sessionId),resource):nameOf(input.name || '画面'), kind: resource.kind,
                importId: resource.importId, state: 'queued', location: settings.collection, entities: [], source: { ...resource } });
            queue('collect', { collectionId: value.id }); return value;
        });
    }
    function collectImport(importId, input = {}) { return db.atomic(() => {
        const resource = item('import', importId), settings = requireConfig(); if (resource.state !== 'ready') throw Error('MEDIA_IMPORT_NOT_READY');
        const existing = db.matching('collection', scope(), 'importId', importId).find(c => c.wholeSource && Boolean(c.external) === Boolean(input.external && !resource.managed) && c.state !== 'deleted');
        if (existing) return existing;
        if (input.external === true && !resource.managed) {
            disk.file(resource.file); return db.create('collection', scope(), { name: nameOf(input.name || resource.name), kind: resource.file.type?.startsWith('image/') ? 'image' : 'video',
                importId, wholeSource: true, state: 'ready', file: resource.file, external: true, entities: [], source: { ...resource.source, ...resource.signature } });
        }
        grant(settings.collection.grantId, 'collection');
        return db.atomic(() => { const record = db.create('collection', scope(), { name: nameOf(input.name || resource.name), kind: resource.file.type?.startsWith('image/') ? 'image' : 'video',
            importId, wholeSource: true, state: 'queued', location: settings.collection, entities: [], source: { ...resource.source, ...resource.signature } }); queue('collect', { collectionId: record.id }); return record; });
    }); }
    async function processCollection(job, signal, progress) {
        const record = item('collection', job.context.collectionId); if (record.state === 'ready') return record;
        const authorization = grant(record.location.grantId, 'collection'); let lease, transient;
        try {
            db.patch('collection', record.id, job.scope, { state: 'transferring', error: '' }); let localPath, name;
            progress(0, { phase: 'preparing', detail: '正在确认收藏目录权限与本地正文' });
            if(record.compressionId){const variant=item('compression',record.compressionId);lease=cache.acquire(job.scope,variant.cacheId);localPath=lease.path;name=record.name+'.mkv';}
            else if (record.resultId) { const candidate = item('result', record.resultId); lease = cache.acquire(job.scope, candidate.cacheId); localPath = lease.path; name = record.name + (candidate.kind === 'image' ? '.jpg' : '.mp4'); }
            else {
                const source = item('import', record.importId); name = nameOf(source.name);
                const opened = await disk.open(source.file, undefined, signal);
                try { transient = cache.allocate(job.scope, 'candidates', requireConfig().caches.candidates, undefined, '', opened.object.size); }
                catch (error) { opened.stream.destroy(); throw error; }
                let received = 0;
                await pipeline(opened.stream, new Transform({ transform(chunk, enc, done) { received += chunk.length;
                    done(received > opened.object.size ? Error('MEDIA_UPLOAD_SIZE_MISMATCH') : null, chunk); } }), fs.createWriteStream(transient.path), { signal });
                if (received !== opened.object.size) throw Error('MEDIA_UPLOAD_SIZE_MISMATCH'); localPath = transient.path;
            }
            const file = await disk.write(authorization.location, localPath, record.clipNamed ? name : record.id.slice(0, 8) + '-' + name, record.id, () => grant(record.location.grantId, 'collection'), signal, patch => {
                const details = {};
                for (const key of ['phase','detail','processedBytes','totalBytes','telegramBytesSent','telegramBytesConfirmed']) if (patch[key] !== undefined) details[key] = patch[key];
                progress(Number.isFinite(patch.percent) ? Math.max(0, Math.min(99, patch.percent)) : 0, details);
            });
            return db.atomic(() => { const value = db.patch('collection', record.id, job.scope, { state: 'ready', file, collectedAt: now(), error: '' });
                if (record.resultId) db.patch('result', record.resultId, job.scope, { savedId: record.id }); if(record.compressionId)db.patch('compression',record.compressionId,job.scope,{savedId:record.id});return value; });
        } finally { lease?.release(); if (transient) cache.discard(job.scope, transient.record.id); }
    }
    function remark(kind,id,input){const record=item(kind,id);if(kind==='result'&&record.kind!=='clip')throw Error('MEDIA_RECORD_INVALID');if(typeof input.remark!=='string'||input.remark.length>65535)throw Error('MEDIA_REMARK_INVALID');return db.patch(kind,id,scope(),{remark:input.remark},input.version);}
    function compressionDetails(record,tenant=scope()){const versions=db.matching('compression',tenant,'resultId',record.resultId).sort((a,b)=>(a.completedAt||a.createdAt)-(b.completedAt||b.createdAt)||a.id.localeCompare(b.id));return {...record,ordinal:record.ordinal||versions.findIndex(v=>v.id===record.id)+1};}
    function collectCompression(id){return db.atomic(()=>{const variant=compressionDetails(item('compression',id)),result=item('result',variant.resultId),settings=requireConfig();
        const existing=db.matching('collection',scope(),'compressionId',id).find(c=>c.state!=='deleted');if(existing){if(['failed','cancelled','interrupted'].includes(existing.state)){const lease=cache.acquire(scope(),variant.cacheId);lease.release();queue('collect',{collectionId:existing.id,cacheId:variant.cacheId});return db.patch('collection',existing.id,scope(),{state:'queued',error:''});}return existing;}
        const lease=cache.acquire(scope(),variant.cacheId);lease.release();
        const name=require('./clip-name').compressionName(item('session',result.sessionId),result,variant);
        const record=db.create('collection',scope(),{compressionId:id,clipNamed:true,name,kind:'clip',importId:result.importId,state:'queued',location:settings.collection,entities:[],source:{...variant}});
        queue('collect',{collectionId:record.id,cacheId:variant.cacheId});return record;});}
    function reserveCompressionOrdinals(resultId, tenant) {
        const versions = db.matching('compression', tenant, 'resultId', resultId), jobs = db.matching('job', tenant, 'type', 'transcode').filter(job => job.context.resultId === resultId);
        const versionNumbers = new Map(versions.map(version => [version.id, compressionDetails(version, tenant).ordinal]));
        let ordinal = Math.max(0, ...versionNumbers.values(), ...jobs.map(job => job.context.ordinal || 0));
        for (const job of jobs) if (!job.context.ordinal) db.patch('job', job.id, tenant, { context: { ...job.context, ordinal: versionNumbers.get(job.id) || ++ordinal } });
        return ordinal;
    }
    function transcode(resultId,input={}){const result=item('result',resultId);if(result.kind!=='clip')throw Error('MEDIA_RECORD_INVALID');
        const params={crf:input.crf===undefined||input.crf===''?28:Number(input.crf),preset:String(input.preset||'')};
        for(const axis of ['width','height']){params[axis]=input[axis]===''||input[axis]==null?null:Number(input[axis]);if(params[axis]!==null&&(!Number.isInteger(params[axis])||params[axis]<2||params[axis]>16384||params[axis]%2))throw Error('MEDIA_TRANSCODE_PARAMETERS_INVALID');}
        if(!Number.isFinite(params.crf)||params.crf<0||params.crf>51||!['','ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow','placebo'].includes(params.preset))throw Error('MEDIA_TRANSCODE_PARAMETERS_INVALID');
        const lease=cache.acquire(scope(),result.cacheId);lease.release();
        return db.atomic(() => {
            const ordinal = reserveCompressionOrdinals(resultId, scope()) + 1;
            return queue('transcode',{resultId,sessionId:result.sessionId,importId:result.importId,cacheId:result.cacheId,ordinal,params});
        });}
    async function processTranscode(job,signal,progress){const result=item('result',job.context.resultId),settings=requireConfig();
        if (!job.context.ordinal) { db.atomic(() => reserveCompressionOrdinals(result.id, job.scope)); job = db.get('job', job.id, job.scope); }
        const existing=db.get('compression',job.id,job.scope);if(existing){const c=db.get('cache',existing.cacheId,job.scope),t=db.get('cache',existing.thumbnailCacheId,job.scope);if(c?.status==='ready'&&t?.status==='ready'&&fs.existsSync(cache.filename(c))&&fs.existsSync(cache.filename(t)))return existing;}
        const lease=cache.acquire(job.scope,job.context.cacheId);let output,thumb,meter,capacityError;
        try { output=cache.allocate(job.scope,'candidates',settings.caches.candidates,undefined,'.mkv');thumb=cache.allocate(job.scope,'candidates',settings.caches.candidates,undefined,'.jpg');
        meter=setInterval(()=>{try{if(fs.existsSync(output.path))cache.reserve(job.scope,output.record.id,fs.statSync(output.path).size,settings.caches.candidates);}catch(error){capacityError=error;controllers.get(job.id)?.abort();}},250);meter.unref?.();
        progress(1,{phase:'transcoding',detail:'正在压缩视频，音轨保持复制'});const probe=await processing.probe(lease.path,signal);let tail='';
            const quality=await processing.compress(lease.path,output.path,{...job.context.params,signal,duration:(result.endMs-result.startMs)/1000,audio:probe.streams.some(s=>s.codec_type==='audio'),onOutput:text=>{tail=(tail+text).slice(-8192);const value=[...tail.matchAll(/out_time_us=(\d+)/g)].at(-1);if(value)progress(Math.min(94,Number(value[1])/1000/(result.endMs-result.startMs)*94),{phase:'transcoding',detail:'正在执行 libx265 压缩转码'});}});
            progress(96,{phase:'thumbnail',detail:'正在生成缩略图并确认转码结果'});await processing.thumbnail(output.path,thumb.path,signal);cache.commit(job.scope,output.record.id,settings.caches.candidates);cache.commit(job.scope,thumb.record.id,settings.caches.candidates);
            const sourceVideo=probe.streams.find(s=>s.codec_type==='video')||{},sourceAudio=probe.streams.find(s=>s.codec_type==='audio')||{};
            const sourceInfo={bytes:lease.record.size,width:sourceVideo.width,height:sourceVideo.height,videoCodec:sourceVideo.codec_name,videoBitRate:Number(sourceVideo.bit_rate)||null,audioCodec:sourceAudio.codec_name,audioBitRate:Number(sourceAudio.bit_rate)||null,duration:Number(probe.format?.duration)||null};
            return db.atomic(()=>{const versions=db.matching('compression',job.scope,'resultId',result.id),ordinal=Math.max(versions.length,...versions.map(v=>v.ordinal||0))+1;
            const prior=db.get('compression',job.id,job.scope),payload={resultId:result.id,sessionId:result.sessionId,ordinal:prior?.ordinal||job.context.ordinal||ordinal,cacheId:output.record.id,thumbnailCacheId:thumb.record.id,params:job.context.params,quality,sourceInfo,sourceBytes:lease.record.size,completedAt:now()};
            return prior?db.patch('compression',job.id,job.scope,payload):db.create('compression',job.scope,payload,job.id);});
        }catch(error){if(output)cache.discard(job.scope,output.record.id);if(thumb)cache.discard(job.scope,thumb.record.id);throw capacityError||error;}finally{clearInterval(meter);lease.release();}}
    function compare(resultId, input) {
        const source = item('result', resultId); if (source.kind !== 'image') throw Error('MEDIA_IMAGE_REQUIRED');
        if (input.threshold !== undefined && (!Number.isFinite(Number(input.threshold)) || Number(input.threshold) < 0 || Number(input.threshold) > 100)) throw Error('MEDIA_COMPARISON_INVALID');
        let targets = db.list('result', scope(), { limit: 10000 }).filter(r => r.kind === 'image' && r.id !== source.id);
        if (input.against === 'session') targets = targets.filter(r => r.sessionId === source.sessionId);
        else if (input.against === 'video') targets = targets.filter(r => r.importId === source.importId);
        else if (input.against === 'collection') targets = db.list('collection', scope(), { limit: 10000 }).filter(c => c.kind === 'image' && c.state === 'ready' && c.source?.dHash)
            .map(c => ({ ...c.source, id: c.id, collectionId: c.id, kind: 'image' }));
        else if (input.against === 'references') targets = targets.filter(r => r.reference);
        else throw Error('MEDIA_COMPARISON_INVALID');
        const matches = targets.map(r => ({ id: r.id, collectionId: r.collectionId, actualMs: r.actualMs, cacheId: r.cacheId,
            cacheReady: r.cacheId && db.get('cache', r.cacheId, scope())?.status === 'ready', ...similarity(source, r) }))
            .filter(m => m.exact || m.hashScore >= Number(input.threshold ?? 80)).sort((a, b) => b.score - a.score).slice(0, 100);
        db.patch('result', source.id, scope(), { comparisons: { against: input.against, matches, comparedAt: now() } }); return matches;
    }
    function entity(input, id) { return db.atomic(() => {
        if (!['person', 'organization', 'tag'].includes(input.entityKind)) throw Error('MEDIA_ENTITY_KIND_INVALID');
        if (!String(input.name || '').trim()) throw Error('MEDIA_ENTITY_NAME_REQUIRED');
        const name = nameOf(input.name), aliases = [...new Set((Array.isArray(input.aliases) ? input.aliases : []).map(nameOf))].slice(0, 30);
        const normalize = value => value.normalize('NFC').toLocaleLowerCase();
        const duplicate = db.list('entity', scope(), { limit: 10000 }).find(e => e.id !== id && e.entityKind === input.entityKind
            && [e.name, ...e.aliases].some(value => [name, ...aliases].some(n => normalize(n) === normalize(value))));
        if (duplicate) throw Error('MEDIA_ENTITY_ALIAS_CONFLICT');
        const data = { name, normalizedName: normalize(name), aliases, entityKind: input.entityKind, description: String(input.description || '').slice(0, 2000), color: /^#[a-f0-9]{6}$/i.test(input.color || '') ? input.color : '#246bfe' };
        return id ? db.patch('entity', id, scope(), data, input.version) : db.create('entity', scope(), data);
    }); }
    function associate(collectionId, ids) {
        if (!Array.isArray(ids) || ids.length > 100) throw Error('MEDIA_ENTITY_LIST_INVALID');
        const entities = [...new Set(ids)]; entities.forEach(id => item('entity', id)); return db.patch('collection', collectionId, scope(), { entities });
    }
    function relate(input) {
        const person = item('entity', input.personId), organization = item('entity', input.organizationId);
        if (person.entityKind !== 'person' || organization.entityKind !== 'organization' || input.from && !Number.isFinite(Date.parse(input.from)) || input.to && !Number.isFinite(Date.parse(input.to))
            || input.from && input.to && Date.parse(input.from) > Date.parse(input.to)) throw Error('MEDIA_RELATION_INVALID');
        return db.create('relation', scope(), { personId: person.id, organizationId: organization.id, from: input.from || '', to: input.to || '', note: String(input.note || '').slice(0, 500) });
    }
    function pinned() {
        const ids = new Set();
        for (const resource of db.list('import', scope(), { limit: 10000 })) if (resource.source?.cacheId && !['ready', 'expired', 'cancelled'].includes(resource.state)) ids.add(resource.source.cacheId);
        for (const job of [...db.matching('job', scope(), 'state', 'queued'), ...db.matching('job', scope(), 'state', 'running')]) {
            if (job.context.cacheId) ids.add(job.context.cacheId);
            if (job.context.batchId) for (const result of db.matching('result', scope(), 'batchId', job.context.batchId)) ids.add(result.cacheId);
            if (job.context.collectionId) { const collection = db.get('collection', job.context.collectionId, scope()), result = collection?.resultId && db.get('result', collection.resultId, scope()); if (result) ids.add(result.cacheId); }
        }
        return ids;
    }
    async function cleanup(force = false) {
        const settings = requireConfig(); const removed = cache.cleanup(scope(), settings.caches, pinned(), force);
        const busySources = new Set(db.list('job', scope(), { limit: 10000 }).filter(j => ['queued', 'running'].includes(j.state)).flatMap(j => [j.context.importId,
            j.context.batchId && db.get('batch', j.context.batchId, scope())?.importId, j.context.collectionId && db.get('collection', j.context.collectionId, scope())?.importId]).filter(Boolean));
        let expired = 0;
        for (const resource of db.list('import', scope(), { limit: 10000 }).filter(r => r.managed && r.state === 'ready' && r.expiresAt < now() && !busySources.has(r.id))) {
            grant(resource.location.grantId, 'workspace'); await disk.remove(resource.file, resource.id, () => grant(resource.location.grantId, 'workspace'));
            db.patch('import', resource.id, scope(), { state: 'expired', expiredAt: now() }); expired++;
        }
        db.event(scope(), `缓存清理：${removed} 个本地缓存、${expired} 个过期工作区来源；正式收藏保留`); return { removed, expired };
    }
    function cancel(id) {
        const job = item('job', id); if (!['queued', 'running'].includes(job.state)) return job;
        controllers.get(id)?.abort(); return db.atomic(() => {
            if (job.state === 'queued') {
                if (job.type === 'import') db.patch('import', job.context.importId, scope(), { state: 'cancelled' });
                if (job.context.collectionId) db.patch('collection', job.context.collectionId, scope(), { state: 'cancelled' });
                if (job.context.batchId) db.patch('batch', job.context.batchId, scope(), { state: 'cancelled' });
            }
            return db.patch('job', id, scope(), { cancelled: true, ...(job.state === 'queued' ? { state: 'cancelled' } : {}) });
        });
    }
    function retry(id) {
        const job = item('job', id); if (!['failed', 'cancelled', 'interrupted'].includes(job.state)) throw Error('MEDIA_JOB_NOT_RETRYABLE');
        return db.atomic(() => {
            if (job.context.batchId) db.patch('batch', job.context.batchId, scope(), { state: 'queued', error: '' });
            if (job.context.collectionId) {
                const record = item('collection', job.context.collectionId);
                if (record.state !== 'ready') db.patch('collection', record.id, scope(), { state: 'queued', error: '' });
            }
            return db.patch('job', id, scope(), { state: 'queued', cancelled: false, error: '', progress: 0 });
        });
    }
    function watchDownloads() {
        for (const record of db.matching('import', scope(), 'state', 'waiting-download')) {
            const task = downloads[record.kind]?.get(record.source.taskId);
            if (!task || ['failed', 'cancelled', 'cleared'].includes(task.status)) db.patch('import', record.id, scope(), { state: 'download-failed', error: task?.error || '来源下载任务不存在或未完成' });
            else if (task.status === 'completed') db.atomic(() => { if (item('import', record.id).state !== 'waiting-download') return; db.patch('import', record.id, scope(), { state: 'queued' }); queue('import', { importId: record.id }); });
        }
    }
    async function pump() {
        if (busy || closed || !scope()) return; busy = true;
        try {
            watchDownloads();
            if (now() - lastCleanup > 15 * 60000 && !db.list('job', scope()).some(j => j.state === 'running')) {
                lastCleanup = now(); try { await cleanup(); } catch (error) { db.event(scope(), '自动清理暂停：' + (/^[A-Z_]+$/.test(error.message) ? error.message : '请检查缓存权限'), 'warn'); }
            }
            const job = db.atomic(() => {
                if (db.matching('job', scope(), 'state', 'running').length) return null;
                const candidate = db.matching('job', scope(), 'state', 'queued')[0];
                return candidate ? db.patch('job', candidate.id, candidate.scope, { state: 'running', worker: boot, pid: process.pid, heartbeat: now(), attempts: candidate.attempts + 1 }) : null;
            });
            if (!job) return;
            const controller = new AbortController(); controllers.set(job.id, controller); let lastProgress = 0;
            let lastPhase = '';
            const progress = (value, details = {}) => { if (now() - lastProgress > 200 || value >= 99 || details.phase && details.phase !== lastPhase) {
                lastProgress = now(); lastPhase = details.phase || lastPhase;
                db.patch('job', job.id, job.scope, current => ({ ...current, ...details, progress: Math.max(current.progress || 0, Math.floor(value)), heartbeat: now() })); } };
            const beat = setInterval(() => { const value = item('job', job.id, job.scope); if (value.cancelled) controller.abort(); else db.patch('job', job.id, job.scope, { heartbeat: now() }); }, 2000); beat.unref?.();
            try {
                let result;
                if (job.type === 'import') result = await processImport(job, controller.signal);
                else if (job.type === 'frames') result = await processFrames(job, controller.signal, progress);
                else if (job.type === 'clip' || job.type === 'segment') result = await processClip(job, controller.signal, progress);
                else if (job.type === 'collect') result = await processCollection(job, controller.signal, progress);
                else if (job.type === 'transcode') result = await processTranscode(job, controller.signal, progress);
                else if (job.type === 'reference') {
                    const lease = cache.acquire(job.scope, job.context.cacheId);
                    try { const previous = db.get('result', job.id, job.scope); if (previous) result = previous; else { const signature = await processing.signature(lease.path, controller.signal); result = db.create('result', job.scope, { reference: true, name: job.context.name,
                        kind: 'image', cacheId: job.context.cacheId, sha256: crypto.createHash('sha256').update(fs.readFileSync(lease.path)).digest('hex'), ...signature, extractedAt: now() }, job.id); }
                    }
                    finally { lease.release(); }
                }
                else throw Error('MEDIA_JOB_TYPE_INVALID');
                db.patch('job', job.id, job.scope, { state: 'completed', progress: 100, result, completedAt: now() }); db.event(job.scope, '任务完成：' + job.type, 'info', job.id);
            } catch (error) {
                const code = /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message) ? error.message : 'MEDIA_PROCESS_FAILED';
                db.patch('job', job.id, job.scope, { state: controller.signal.aborted ? 'cancelled' : 'failed', error: code, completedAt: now() });
                if (job.type === 'import') db.patch('import', job.context.importId, job.scope, { state: item('import', job.context.importId).state === 'cancelled' ? 'cancelled' : 'import-failed', error: code });
                if (job.context.collectionId) db.patch('collection', job.context.collectionId, job.scope, { state: controller.signal.aborted ? 'cancelled' : 'failed', error: code });
                if (job.context.batchId) db.patch('batch', job.context.batchId, job.scope, { state: controller.signal.aborted ? 'cancelled' : 'failed', error: code,
                    actualCount: db.matching('result', job.scope, 'batchId', job.context.batchId).length });
                db.event(job.scope, '任务未完成：' + code, 'error', job.id);
            } finally { clearInterval(beat); controllers.delete(job.id); }
        } finally { busy = false; }
    }
    // Resume only work from a dead process. A live foreign worker retains its
    // durable claim; stale heartbeats alone do not authorize duplicate uploads.
    for (const tenant of db.scopes()) for (const job of db.matching('job', tenant, 'state', 'running')) {
        let alive = true; try { process.kill(job.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
        if (!alive) db.patch('job', job.id, tenant, { state: job.cancelled ? 'cancelled' : 'queued', error: 'MEDIA_RESTART_RECOVERY' });
    }
    for (const tenant of db.scopes()) for (const record of db.matching('import', tenant, 'state', 'receiving')) {
        let alive = false; try { if (record.receivingPid) { process.kill(record.receivingPid, 0); alive = true; } } catch (_) {}
        if (!alive) db.patch('import', record.id, tenant, { state: 'import-failed', error: 'MEDIA_UPLOAD_INTERRUPTED' });
    }
    if (autoStart) { timer = setInterval(() => pump().catch(() => {}), 2000); timer.unref?.(); }
    return { db, cache, processing, config, scope, grant, configureLocation, setCachePolicies, createImport, createLink, attachTask, receive, createSession, extract, clip,
        collect, collectImport, collectCompression, compressionDetails, compare, entity, associate, relate, cleanup, cancel, retry, pump, sourceInput, remark, transcode,
        authorizeRead(record, kind = 'import', snapshot) { if (kind === 'import' && record.managed) grant(record.location.grantId, 'workspace', snapshot); else if (kind === 'collection' && !record.external) grant(record.location.grantId, 'collection', snapshot); },
        retryImport(id) { return db.atomic(() => {
            const record = item('import', id); if (!['download-failed', 'import-failed', 'cancelled'].includes(record.state)) throw Error('MEDIA_JOB_NOT_RETRYABLE');
            const jobs = db.matching('job', scope(), 'type', 'import').filter(j => j.context.importId === id);
            const active = jobs.find(j => ['queued', 'running'].includes(j.state)); if (active) return record;
            if (jobs.length) { retry(jobs.at(-1).id); return db.patch('import', id, scope(), { state: 'queued', error: '' }); }
            if (!record.source?.taskId) throw Error('MEDIA_DOWNLOAD_PRODUCT_UNAVAILABLE');
            return db.patch('import', id, scope(), { state: 'waiting-download', error: '' });
        }); },
        list: kind => db.list(kind, scope(), { limit: 10000 }), get: item,
        renew(id, days = 365) { if (!Number.isInteger(days) || days < 1 || days > 3650) throw Error('MEDIA_TTL_INVALID'); const resource = item('import', id); if (!resource.managed) throw Error('MEDIA_EXTERNAL_FILE_PROTECTED'); return db.patch('import', id, scope(), { expiresAt: now() + days * 86400000 }); },
        async check() { const settings = requireConfig(); grant(settings.workspace.grantId, 'workspace'); grant(settings.collection.grantId, 'collection'); const tool = await processing.probeVersion?.(); return { caches: cache.check(settings.caches), tool, database: db.path }; },
        revoke(id) { return db.atomic(() => {
            const selected = item('grant', id);
            for (const authorization of db.matching('grant', scope(), 'purpose', selected.purpose)) {
                if (authorization.location.userId === selected.location.userId && authorization.location.diskSpace === selected.location.diskSpace && authorization.location.path === selected.location.path)
                    db.patch('grant', authorization.id, scope(), { revokedAt: now() });
            }
            return item('grant', id);
        }); },
        async receiveReference(input, body, signal) { return guardReceive(signal, async combined => {
            const settings = requireConfig(), size = Number(input.size); if (!Number.isSafeInteger(size) || size < 1 || size > 20 * 1024 ** 2) throw Error('MEDIA_FILE_SIZE_INVALID');
            const output = cache.allocate(scope(), 'candidates', settings.caches.candidates, undefined, '', size); let received = 0;
            try { await pipeline(body, new Transform({ transform(chunk, enc, done) { received += chunk.length; done(received > size ? Error('MEDIA_UPLOAD_SIZE_MISMATCH') : null, chunk); } }), fs.createWriteStream(output.path, { flags: 'wx' }), { signal: combined });
                if (received !== size) throw Error('MEDIA_UPLOAD_SIZE_MISMATCH'); cache.commit(scope(), output.record.id, settings.caches.candidates);
                return queue('reference', { cacheId: output.record.id, name: nameOf(input.name) });
            } catch (error) { cache.discard(scope(), output.record.id); throw error; }
        }); },
        cancelImport(id) { const record = item('import', id); if (record.state === 'ready') throw Error('MEDIA_IMPORT_ALREADY_READY');
            for (const job of db.list('job', scope()).filter(j => j.context.importId === id && ['queued', 'running'].includes(j.state))) cancel(job.id);
            return db.patch('import', id, scope(), { state: 'cancelled' }); },
        async removeCollection(id, deleteFile = false) { const record = item('collection', id);
            if (['queued', 'transferring'].includes(record.state)) throw Error('MEDIA_COLLECTION_BUSY');
            if (deleteFile && record.external) throw Error('MEDIA_EXTERNAL_FILE_PROTECTED');
            if (deleteFile && record.file) await disk.remove(record.file, record.id, () => grant(record.location.grantId, 'collection'));
            return db.atomic(() => { const value = db.patch('collection', id, scope(), { state: 'deleted', deletedAt: now() }); if (record.resultId) db.patch('result', record.resultId, scope(), { savedId: '' }); return value; }); },
        removeSession(id) { const record = item('session', id); const jobs = db.list('job', scope()).filter(j => ['queued', 'running'].includes(j.state) && (j.context.sessionId === id || db.get('batch', j.context.batchId || '', scope())?.sessionId === id)); if (jobs.length) throw Error('MEDIA_SESSION_BUSY'); return db.patch('session', record.id, scope(), { state: 'deleted' }); },
        close() { return closePromise ||= (async () => { closed = true; clearInterval(timer); controllers.forEach(c => c.abort()); receivers.forEach(c => c.abort()); while (busy || receivers.size) await new Promise(resolve => setTimeout(resolve, 20)); cache.close(); db.close(); })(); } };
}
module.exports = { createMediaLibrary, nameOf };
