'use strict';
const express = require('express'), fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { timestamp } = require('./processing');
const messages = {
    MEDIA_SETUP_REQUIRED: '请先配置工作区和正式收藏网盘位置。', MEDIA_WORKSPACE_FIRST: '请先授权工作区账号，再设置正式收藏位置。',
    MEDIA_LOCATION_OVERLAP: '工作区与正式收藏不能使用同一账号同一分区中的相同目录，请分别选择位置。',
    MEDIA_LOCATION_NOT_AUTHORIZED: '请用已经登录的目标网盘账号授权这个位置，不能直接填写其它用户 ID。', MEDIA_SOURCE_NOT_AUTHORIZED: '读取来源需要该网盘账号的有效登录。',
    MEDIA_AUTHORIZATION_REVOKED: '本子系统的网盘访问授权已撤销，请重新授权原位置。', MEDIA_ACCOUNT_UNAVAILABLE: '关联的网盘账号已不存在。',
    MEDIA_DIRECTORY_UNAVAILABLE: '所选原生目录不存在或已被限制，请重新选择目录。', MEDIA_BACKEND_CHANGED: '存储后端或频道已变更，请核对后重新授权，未改写到其它位置。',
    MEDIA_SOURCE_CHANGED: '来源媒体版本已改变，原记录保留；请重新导入当前版本。', MEDIA_SOURCE_UNAVAILABLE: '来源已删除、进入回收站或被限制，原日志和收藏记录保留。',
    MEDIA_DOWNLOAD_PRODUCT_UNAVAILABLE: '下载任务尚未完成或服务端成品已清理，请在原下载页面查看。', MEDIA_IMPORT_NOT_READY: '资源尚未导入就绪，请查看导入任务。',
    MEDIA_WRITE_PENDING: '先前网盘写入结果尚未确认，暂不重复转存；请查看网盘上传恢复任务，清理完成后再重试。', MEDIA_OUTPUT_NAME_CONFLICT: '目标已有其它文件占用了本次成果名称，未覆盖该文件。',
    MEDIA_CACHE_CAPACITY_EXCEEDED: '本地缓存容量不足，请清理未使用缓存或调大容量。', MEDIA_CACHE_CLEARED: '候选缓存已清理，提取日志仍保留；请重新提取。',
    MEDIA_CACHE_IN_USE: '缓存仍被执行任务使用，暂不能清理。', MEDIA_FRAME_TIME_UNCONFIRMED: '无法确认实际解码帧时刻，本次画面未标记为成功。',
    MEDIA_RANGE_INVALID: '时间范围为空、倒置或超出视频时长，请检查起止时刻。', MEDIA_TIME_INVALID: '时间格式应为秒、分:秒或时:分:秒，可含毫秒。',
    MEDIA_COUNT_LIMIT: '这组等间隔参数会生成超过 500 张图片，请缩小范围或增大间隔。', MEDIA_COUNT_INVALID: '每批随机提取数量应为 1～500。',
    MEDIA_INTERVAL_INVALID: '时间间隔至少 10 毫秒；随机模式可以留空，不会自动改为等间隔模式。',
    MEDIA_OUTPUT_DURATION_MISMATCH: '处理后的实际时长与指定范围不符，未接受该成果。', MEDIA_AV_TIMELINE_MISMATCH: '音视频时间线差异超出允许范围，未接受该成果。',
    MEDIA_DECODE_FAILED: '媒体解码或转码失败，请检查源文件是否损坏及 FFmpeg 支持情况。', MEDIA_OUTPUT_INVALID: '媒体缺少必需轨道或有效时长，未标记成功。',
    MEDIA_ENTITY_ALIAS_CONFLICT: '同类型人物、组织或标签已有这个名称或别名，请复用现有记录。', MEDIA_VERSION_CONFLICT: '记录已被其它操作更新，请刷新后重新修改。',
    MEDIA_SESSION_BUSY: '此会话仍有执行中的任务，请先取消或等任务完成。', MEDIA_FILE_SIZE_INVALID: '文件为空、超出网盘单文件上限或本地缓存容量。',
    MEDIA_CONFIG_BUSY: '工作区仍有未完成导入或处理任务，请先完成或取消，再切换工作区账号。', MEDIA_CANCELLED: '任务已取消，已确认的网盘成果和收藏不会被误删。',
    MEDIA_JOB_NOT_RETRYABLE: '该任务仍在执行或已经完成，不能重复重试。', MEDIA_EXTERNAL_FILE_PROTECTED: '这是外部网盘文件引用，本子系统不会删除其原文件。',
    MEDIA_TASK_LINK_INVALID: '下载任务与本次导入来源不符或关联凭据失效，未绑定其它任务。', MEDIA_TASK_ALREADY_BOUND: '该导入记录已经关联另一个任务，未重复绑定。',
    MEDIA_UPLOAD_INTERRUPTED: '本地文件尚未完整到达服务器时服务中断，请重新上传。', MEDIA_TIMESTAMP_DISCONTINUITY: '媒体解码时间戳发生倒退，未接受此成果，请检查来源或使用精确重编码裁切。'
};
function readable(code) { return messages[code] || '操作未完成，请查看系统状态中的任务详情，核对资源、授权和媒体工具。'; }
function createMediaRoutes({ service, disk, downloads, identity, requireAuth, origin }) {
    const router = express.Router(); router.use(requireAuth);
    router.use((req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        if (!['GET', 'HEAD'].includes(req.method) && req.get('Origin') && req.get('Origin') !== origin(req)) return res.status(403).json({ error: 'ORIGIN_MISMATCH', message: '请求来源不符合本站地址。' });
        next();
    });
    const wrap = run => (req, res, next) => Promise.resolve().then(() => run(req, res)).catch(next);
    const validId = value => /^[a-zA-Z0-9_-]{1,100}$/.test(value);
    router.param('id', (req, res, next, id) => validId(id) ? next() : res.status(422).json({ error: 'MEDIA_RECORD_INVALID' }));
    router.get('/config', (req, res) => res.json({ config: service.config(), defaults: service.cache.defaults }));
    router.put('/config/:purpose', wrap((req, res) => res.json(service.configureLocation(req.params.purpose, req.body, identity(req)))));
    router.put('/cache-policies', wrap((req, res) => res.json(service.setCachePolicies(req.body))));
    router.post('/check', wrap(async (req, res) => res.json(await service.check())));
    router.delete('/grants/:id', wrap((req, res) => res.json(service.revoke(req.params.id))));
    router.get('/locations', wrap((req, res) => { const actor = identity(req); if (!actor) throw Error('MEDIA_LOCATION_NOT_AUTHORIZED');
        res.json({ user: actor, partitions: disk.partitions(actor.id), directories: disk.directories(actor.id, req.query.disk_space || '') }); }));
    router.get('/download-tasks/:kind', wrap((req, res) => { const source = downloads[req.params.kind]; if (!source) throw Error('MEDIA_IMPORT_KIND_INVALID'); res.json(source.list(req.query.page, 25)); }));
    router.get('/state', wrap((req, res) => {
        const config = service.config(), scope = service.scope();
        if (!scope) return res.json({ config, imports: [], sessions: [], results: [], collections: [], entities: [], relations: [], jobs: [], caches: [], events: [] });
        const snapshot = new Map();
        const present = (record, kind) => { try { service.authorizeRead(record, kind, snapshot); disk.file(record.file, snapshot); return true; } catch (_) { return false; } };
        const results = service.list('result').map(r => { const { pixels, ...out } = r; const c = service.db.get('cache', r.cacheId, scope); return { ...out, cacheReady: c?.status === 'ready' && fs.existsSync(service.cache.filename(c)) }; });
        res.json({ config, imports: service.list('import').map(r => { const { bindToken, probe, ...out } = r; return { ...out, message: r.error ? readable(r.error) : '', available: r.file ? present(r) : false }; }), sessions: service.list('session'), batches: service.list('batch'), results,
            collections: service.list('collection').map(r => ({ ...r, available: r.state === 'ready' && present(r, 'collection') })), entities: service.list('entity'), relations: service.list('relation'),
            jobs: service.list('job').map(j => ({ ...j, message: j.error ? readable(j.error) : '' })), caches: service.list('cache'), events: service.list('event').slice(0, 200) });
    }));
    router.post('/imports', wrap((req, res) => res.status(202).json(service.createImport(req.body, identity(req)))));
    router.post('/links', wrap((req, res) => res.json(service.createLink(req.body))));
    router.post('/imports/:id/attach', wrap((req, res) => res.json(service.attachTask(req.params.id, req.body.kind, req.body.taskId, req.body.token))));
    router.post('/imports/:id/cancel', wrap((req, res) => res.json(service.cancelImport(req.params.id))));
    router.post('/imports/:id/retry', wrap((req, res) => res.json(service.retryImport(req.params.id))));
    router.post('/uploads', wrap(async (req, res) => {
        const abort = new AbortController(); req.once('aborted', () => abort.abort()); res.once('close', () => { if (!res.writableFinished) abort.abort(); });
        res.status(202).json(await service.receive({ size: req.get('X-Media-Size'), name: decodeURIComponent(req.get('X-Media-Name') || ''), type: req.get('X-Media-Type') }, req, identity(req), abort.signal));
    }));
    router.post('/references', wrap(async (req, res) => {
        const abort = new AbortController(); req.once('aborted', () => abort.abort());
        res.once('close', () => { if (!res.writableFinished) abort.abort(); });
        res.status(202).json(await service.receiveReference({ size: req.get('X-Media-Size'), name: decodeURIComponent(req.get('X-Media-Name') || '') }, req, abort.signal));
    }));
    router.post('/sessions', wrap((req, res) => res.status(201).json(service.createSession(req.body.importId, req.body.name))));
    router.delete('/sessions/:id', wrap((req, res) => res.json(service.removeSession(req.params.id))));
    router.post('/sessions/:id/extract', wrap((req, res) => res.status(202).json(service.extract(req.params.id, req.body))));
    router.post('/sessions/:id/clip', wrap((req, res) => res.status(202).json(service.clip(req.params.id, { ...req.body, start: timestamp(req.body.start), end: timestamp(req.body.end) }))));
    router.post('/sessions/:id/segment', wrap((req, res) => res.status(202).json(service.clip(req.params.id, { ...req.body, start: timestamp(req.body.start), end: timestamp(req.body.end) }, true))));
    router.post('/results/:id/collect', wrap((req, res) => res.status(202).json(service.collect(req.params.id, req.body))));
    router.post('/imports/:id/collect', wrap((req, res) => res.status(202).json(service.collectImport(req.params.id, req.body))));
    router.post('/results/:id/compare', wrap((req, res) => res.json({ matches: service.compare(req.params.id, req.body) })));
    router.patch('/imports/:id', wrap((req, res) => res.json(service.renew(req.params.id, Number(req.body.days || 365)))));
    router.post('/entities', wrap((req, res) => res.status(201).json(service.entity(req.body))));
    router.patch('/entities/:id', wrap((req, res) => res.json(service.entity(req.body, req.params.id))));
    router.put('/collections/:id/entities', wrap((req, res) => res.json(service.associate(req.params.id, req.body.entities))));
    router.delete('/collections/:id', wrap(async (req, res) => res.json(await service.removeCollection(req.params.id, req.body.deleteFile === true))));
    router.post('/relations', wrap((req, res) => res.status(201).json(service.relate(req.body))));
    router.post('/jobs/:id/cancel', wrap((req, res) => res.json(service.cancel(req.params.id))));
    router.post('/jobs/:id/retry', wrap((req, res) => res.json(service.retry(req.params.id))));
    router.post('/cleanup', wrap(async (req, res) => res.json(await service.cleanup(req.body.all === true))));
    router.get('/files/:id', wrap(async (req, res) => {
        const type = req.query.kind || 'import'; if (!['import', 'collection'].includes(type)) throw Error('MEDIA_RECORD_INVALID');
        const record = service.get(type, req.params.id); if (record.state !== 'ready') throw Error('MEDIA_IMPORT_NOT_READY');
        service.authorizeRead(record, type);
        const abort = new AbortController(); res.once('close', () => { if (!res.writableFinished) abort.abort(); });
        const opened = await disk.open(record.file, req.get('Range'), abort.signal);
        res.status(opened.range.partial ? 206 : 200).set({ 'Content-Type': opened.object.type, 'Content-Length': String(opened.range.end - opened.range.start + 1), 'Accept-Ranges': 'bytes',
            ...(opened.range.partial ? { 'Content-Range': `bytes ${opened.range.start}-${opened.range.end}/${opened.object.size}` } : {}) });
        await pipeline(opened.stream, res, { signal: abort.signal });
    }));
    router.get('/cache/:id', wrap(async (req, res) => {
        const lease = service.cache.acquire(service.scope(), req.params.id); res.once('close', () => lease.release());
        res.sendFile(lease.path);
    }));
    router.get('/imports/:id/frame-neighbor', wrap(async (req, res) => {
        const resource = service.get('import', req.params.id), time = timestamp(req.query.time);
        if (!Number.isFinite(resource.duration) || time > resource.duration + .001) throw Error('MEDIA_RANGE_INVALID');
        const abort = new AbortController(); res.once('close', () => { if (!res.writableFinished) abort.abort(); });
        const input = await service.sourceInput(resource, abort.signal, { start: Math.max(0, time - 2), end: Math.min(resource.duration, time + 2) });
        try { const values = await service.processing.frameNeighbors(input.url, time - input.offset, input.probe, abort.signal);
            const positions = [...new Set(values.map(n => n + input.offset))].sort((a, b) => a - b);
            const current = positions.findLastIndex(n => n <= time + .000001);
            const previous = current > 0 ? positions[current - 1] : null, nextIndex = current + 1;
            const next = positions[nextIndex] ?? null;
            // Seek inside the presentation interval, rather than exactly at
            // its floating-point boundary, so the browser displays that frame.
            const seekTime = index => positions[index] + (positions[index + 1] === undefined ? .000001 : (positions[index + 1] - positions[index]) / 2);
            res.json({ previous, next, previousSeekTime: previous === null ? null : seekTime(current - 1), nextSeekTime: next === null ? null : seekTime(nextIndex) }); }
        finally { input.close(); }
    }));
    router.use((error, req, res, next) => {
        if (res.headersSent) { res.destroy(); return; }
        const code = /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message) ? error.message : 'MEDIA_PROCESS_FAILED';
        res.status(/NOT_FOUND/.test(code) ? 404 : /AUTHORIZ|UNAVAILABLE/.test(code) ? 403 : 422).json({ error: code, message: readable(code) });
    });
    return router;
}
module.exports = { createMediaRoutes, readable };
