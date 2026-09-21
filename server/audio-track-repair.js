'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 2;
const labels = {
    'audio-repair-no-audio': '原文件没有音轨，无法生成音轨修正版',
    'audio-repair-source-changed': '原文件已变更或被清理，请重新操作',
    'audio-repair-invalid': '修正版校验失败，原文件及已有修正版均已保留',
    'audio-repair-timeout': '音轨修正超时，原文件及已有修正版均已保留',
    'audio-repair-not-ready': '请先完成抓取并保留服务端原文件',
    'audio-repair-cache-missing': '修正版缓存不存在或已失效，请重新生成'
};
function fingerprint(file) {
    const stat = fs.statSync(file.path);
    return crypto.createHash('sha256').update(JSON.stringify([VERSION, file.path, stat.size, stat.mtimeMs])).digest('hex');
}
function repairPlan(probe, input, output) {
    const streams = probe.streams || [];
    const audio = streams.filter(stream => stream.codec_type === 'audio');
    if (!audio.length) throw new Error('audio-repair-no-audio');
    const video = streams.filter(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const extension = video.length ? '.mp4' : '.m4a';
    // Use FFmpeg's normal decode/encode and stream selection, exactly as
    // `ffmpeg -i INPUT.mp4 OUTPUT.mp4` for yt-dlp --download-sections results.
    const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', input, output + extension];
    return { args, extension, audioCount: 1, videoCount: video.length ? 1 : 0 };
}
function createAudioTrackRepair({ probe, run }) {
    const jobs = new Map();
    const jobHistory = new Map();
    let queue = Promise.resolve();
    const JOB_TTL = 6 * 60 * 60 * 1000;
    const manifestPath = directory => path.join(directory, 'audio-track-repair', 'current.json');
    function previousOutput(directory) {
        try {
            const record = JSON.parse(fs.readFileSync(manifestPath(directory), 'utf8'));
            return /^[a-f0-9-]+\.(mp4|mkv|m4a)$/.test(record.file) ? path.join(directory, 'audio-track-repair', record.file) : null;
        } catch (_) { return null; }
    }
    function cached(file, directory) {
        try {
            const record = JSON.parse(fs.readFileSync(manifestPath(directory), 'utf8'));
            if (record.fingerprint !== fingerprint(file) || path.basename(record.file) !== record.file) return null;
            const outputPath = path.join(directory, 'audio-track-repair', record.file);
            if (!fs.statSync(outputPath).isFile() || fs.statSync(outputPath).size !== record.size) return null;
            return { path: outputPath, name: record.name, reused: true };
        } catch (_) { return null; }
    }
    async function generate(file, directory) {
        const key = fingerprint(file), sourceProbe = await probe(file.path);
        const cacheDir = path.join(directory, 'audio-track-repair');
        const stem = crypto.randomUUID();
        const plan = repairPlan(sourceProbe, file.path, path.join(cacheDir, stem));
        const outputPath = path.join(cacheDir, stem + plan.extension);
        fs.mkdirSync(cacheDir, { recursive: true });
        const oldPath = previousOutput(directory);
        const temporaryManifest = path.join(cacheDir, stem + '.json');
        try {
            await run(plan.args);
            const result = await probe(outputPath), streams = result.streams || [];
            const audioCount = streams.filter(stream => stream.codec_type === 'audio').length;
            const videoCount = streams.filter(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic).length;
            const size = fs.statSync(outputPath).size;
            if (!size || audioCount !== plan.audioCount || videoCount !== plan.videoCount) throw new Error('audio-repair-invalid');
            if (fingerprint(file) !== key) throw new Error('audio-repair-source-changed');
            const name = path.parse(file.name || path.basename(file.path)).name + '-音轨修正版' + plan.extension;
            fs.writeFileSync(temporaryManifest, JSON.stringify({ fingerprint: key, file: path.basename(outputPath), name, size, createdAt: Date.now() }));
            fs.renameSync(temporaryManifest, manifestPath(directory));
            if (oldPath) { try { fs.unlinkSync(oldPath); } catch (_) {} }
            return { path: outputPath, name, reused: false };
        } catch (error) {
            for (const target of [outputPath, temporaryManifest]) { try { fs.unlinkSync(target); } catch (_) {} }
            throw error;
        }
    }
    function pruneJobs() {
        const cutoff = Date.now() - JOB_TTL;
        for (const [id, job] of jobHistory) {
            if (job.finishedAt && job.finishedAt < cutoff) jobHistory.delete(id);
        }
    }
    function publicJob(job) {
        return {
            jobId:job.id,
            status:job.status,
            queuedAt:job.queuedAt,
            startedAt:job.startedAt || 0,
            finishedAt:job.finishedAt || 0,
            reused:Boolean(job.result?.reused),
            name:job.result?.name || '',
            error:job.error || ''
        };
    }
    function completedJob(result, directory) {
        const job = {
            id:crypto.randomUUID(), directory:path.resolve(directory), status:'completed',
            queuedAt:Date.now(), startedAt:Date.now(), finishedAt:Date.now(), result
        };
        jobHistory.set(job.id, job);
        return job;
    }
    function enqueue(file, directory, { force = false } = {}) {
        pruneJobs();
        const jobKey = path.resolve(directory);
        if (jobs.has(jobKey)) return publicJob(jobs.get(jobKey));
        if (!force) {
            const existing = cached(file, directory);
            if (existing) return publicJob(completedJob(existing, directory));
        }
        const job = {
            id:crypto.randomUUID(), directory:jobKey, status:'queued', queuedAt:Date.now(),
            startedAt:0, finishedAt:0, result:null, error:'', promise:null
        };
        jobHistory.set(job.id, job);
        jobs.set(jobKey, job);
        job.promise = queue.then(async () => {
            job.status = 'processing';
            job.startedAt = Date.now();
            try {
                job.result = await generate(file, directory);
                job.status = 'completed';
            } catch (error) {
                job.status = 'failed';
                job.error = error?.message || String(error);
            } finally {
                job.finishedAt = Date.now();
                jobs.delete(jobKey);
            }
            return job;
        });
        queue = job.promise.then(() => undefined, () => undefined);
        return publicJob(job);
    }
    function getStatus(file, directory, jobId) {
        pruneJobs();
        const resolvedDirectory = path.resolve(directory);
        const job = jobHistory.get(String(jobId || ''));
        if (job && job.directory === resolvedDirectory) return publicJob(job);
        const existing = cached(file, directory);
        return existing ? publicJob(completedJob(existing, directory)) : null;
    }
    return {
        cached,
        enqueue,
        getStatus,
        async prepare(file, directory, options = {}) {
            const submitted = enqueue(file, directory, options);
            const job = jobHistory.get(submitted.jobId);
            if (job?.promise) await job.promise;
            if (job?.status === 'failed') throw new Error(job.error);
            if (job?.result) return job.result;
            const existing = cached(file, directory);
            if (existing) return existing;
            throw new Error('audio-repair-cache-missing');
        }
    };
}
function registerAudioTrackRepairRoutes(app, { root, service, requireAuth, repair, sanitizeError }) {
    const getSource = id => {
        const task = service.get(id), file = service.getFile(id), directory = service.getTaskDirectory(id);
        if (task?.status !== 'completed' || !file || !directory) throw new Error('audio-repair-not-ready');
        return { file, directory };
    };
    const responseFor = (taskId, job) => ({
        ...job,
        statusUrl:root + '/tasks/' + encodeURIComponent(taskId) + '/audio-repair/status?jobId=' + encodeURIComponent(job.jobId),
        downloadUrl:root + '/tasks/' + encodeURIComponent(taskId) + '/audio-repair/file'
    });
    app.post(root + '/tasks/:taskId/audio-repair', requireAuth, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            const { file, directory } = getSource(req.params.taskId);
            const job = repair.enqueue(file, directory, { force: req.body?.force === true });
            res.status(job.status === 'completed' ? 200 : 202).json(responseFor(req.params.taskId, job));
        } catch (error) { res.status(400).json({ error: labels[error.message] || sanitizeError(error) }); }
    });
    app.get(root + '/tasks/:taskId/audio-repair/status', requireAuth, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            const { file, directory } = getSource(req.params.taskId);
            const job = repair.getStatus(file, directory, req.query.jobId);
            if (!job) return res.status(404).json({ error:'音轨修正任务不存在或服务器已重启，请重新提交' });
            const payload = responseFor(req.params.taskId, job);
            if (job.status === 'failed') payload.error = labels[job.error] || sanitizeError(new Error(job.error));
            res.json(payload);
        } catch (error) { res.status(400).json({ error: labels[error.message] || sanitizeError(error) }); }
    });
    app.get(root + '/tasks/:taskId/audio-repair/file', requireAuth, (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        try {
            const { file, directory } = getSource(req.params.taskId), result = repair.cached(file, directory);
            if (!result) throw new Error('audio-repair-cache-missing');
            res.download(result.path, result.name);
        } catch (error) { res.status(404).json({ error: labels[error.message] || sanitizeError(error) }); }
    });
}
module.exports = { createAudioTrackRepair, registerAudioTrackRepairRoutes, repairPlan };
