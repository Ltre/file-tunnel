'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
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
    const extension = video.length ? (video.every(stream => ['h264', 'hevc', 'av1', 'mpeg4'].includes(stream.codec_name)) ? '.mp4' : '.mkv') : '.m4a';
    const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-i', input];
    for (const stream of [...video, ...audio]) args.push('-map', `0:${stream.index}`);
    args.push('-map_metadata', '0', '-map_chapters', '0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-af', 'aresample=async=1000:first_pts=0');
    if (extension !== '.mkv') args.push('-movflags', '+faststart');
    args.push(output + extension);
    return { args, extension, audioCount: audio.length, videoCount: video.length };
}
function createAudioTrackRepair({ probe, run }) {
    const jobs = new Map();
    let queue = Promise.resolve();
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
    return {
        cached,
        prepare(file, directory, { force = false } = {}) {
            const jobKey = path.resolve(directory);
            if (jobs.has(jobKey)) return jobs.get(jobKey);
            if (!force) { const existing = cached(file, directory); if (existing) return Promise.resolve(existing); }
            const job = queue.then(() => generate(file, directory)).finally(() => jobs.delete(jobKey));
            jobs.set(jobKey, job);
            queue = job.catch(() => {});
            return job;
        }
    };
}
function registerAudioTrackRepairRoutes(app, { root, service, requireAuth, repair, sanitizeError }) {
    const getSource = id => {
        const task = service.get(id), file = service.getFile(id), directory = service.getTaskDirectory(id);
        if (task?.status !== 'completed' || !file || !directory) throw new Error('audio-repair-not-ready');
        return { file, directory };
    };
    app.post(root + '/tasks/:taskId/audio-repair', requireAuth, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            const { file, directory } = getSource(req.params.taskId);
            const result = await repair.prepare(file, directory, { force: req.body?.force === true });
            res.json({ reused: result.reused, name: result.name, downloadUrl: root + '/tasks/' + encodeURIComponent(req.params.taskId) + '/audio-repair/file' });
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
