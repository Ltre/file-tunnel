'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ACTIVE_STATUSES = new Set(['queued', 'parsing', 'downloading', 'merging']);
const ALLOWED_PLATFORMS = new Set(['tiktok', 'facebook', 'instagram', 'threads', 'line', 'twitter', 'x']);
const HOST_PLATFORMS = Object.freeze({
    'tiktok.com': 'tiktok',
    'www.tiktok.com': 'tiktok',
    'm.tiktok.com': 'tiktok',
    'vm.tiktok.com': 'tiktok',
    'vt.tiktok.com': 'tiktok',
    'facebook.com': 'facebook',
    'www.facebook.com': 'facebook',
    'm.facebook.com': 'facebook',
    'fb.watch': 'facebook',
    'instagram.com': 'instagram',
    'www.instagram.com': 'instagram',
    'threads.com': 'threads',
    'www.threads.com': 'threads',
    'threads.net': 'threads',
    'www.threads.net': 'threads',
    'line.me': 'line',
    'www.line.me': 'line',
    'twitter.com': 'twitter',
    'www.twitter.com': 'twitter',
    'mobile.twitter.com': 'twitter',
    'x.com': 'x',
    'www.x.com': 'x',
    'mobile.x.com': 'x'
});

function writeJsonAtomic(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
    try {
        fs.renameSync(temporaryPath, filePath);
    } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        fs.copyFileSync(temporaryPath, filePath);
        try { fs.unlinkSync(temporaryPath); } catch (_) {}
    }
}

function normalizeSnsDownloadUrl(rawValue) {
    let parsed;
    try { parsed = new URL(String(rawValue || '').trim()); } catch (_) { throw new Error('sns-download-url-required'); }
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const platform = HOST_PLATFORMS[hostname];
    if (!['http:', 'https:'].includes(parsed.protocol) || !ALLOWED_PLATFORMS.has(platform)) {
        throw new Error('sns-download-url-required');
    }
    for (const key of [...parsed.searchParams.keys()]) {
        if (key === 'fbclid' || key === 'igshid' || key === 's' || key === 't' || key.startsWith('utm_')) {
            parsed.searchParams.delete(key);
        }
    }
    parsed.hash = '';
    return { url: parsed.href, platform };
}

function createSnsDownloadService({
    dataDir,
    analyze,
    download,
    sanitizeError = error => String(error?.message || 'sns-download-failed'),
    concurrency = 1,
    onLog = () => {}
}) {
    if (!dataDir || typeof analyze !== 'function' || typeof download !== 'function') {
        throw new Error('sns-download-service-options-invalid');
    }
    const tasksPath = path.join(dataDir, 'sns-download-tasks.json');
    const outputDir = path.join(dataDir, 'sns-downloads');
    const tasks = new Map();
    const queue = [];
    const controllers = new Map();
    let active = 0;

    const emitLog = (task, message, details = {}, level = 'info') => {
        try {
            onLog({
                taskId: String(task?.id || ''),
                platform: String(task?.platform || 'sns'),
                elapsedMs: Math.max(0, Date.now() - (Number(task?.createdAt) || Date.now())),
                level,
                message: String(message || ''),
                details: details && typeof details === 'object' ? details : { value: details }
            });
        } catch (_) {}
    };
    const persist = () => writeJsonAtomic(tasksPath, [...tasks.values()]);
    const getTask = id => tasks.get(String(id || '')) || null;
    const update = (task, patch) => {
        Object.assign(task, patch, { updatedAt: Date.now() });
        tasks.set(task.id, task);
        persist();
        return task;
    };
    const publicTask = task => {
        const hasFile = Boolean(task.outputPath && fs.existsSync(task.outputPath));
        const hasCover = Boolean(
            (task.coverPath && fs.existsSync(task.coverPath)) ||
            (task.cover && !ACTIVE_STATUSES.has(task.status))
        );
        const taskPath = `/api/sns-dl/tasks/${encodeURIComponent(task.id)}`;
        return {
            id: task.id,
            url: task.url,
            platform: task.platform || '',
            title: task.title || '',
            cover: hasCover ? `${taskPath}/cover` : '',
            mode: task.mode,
            downloadSections: task.downloadSections || '',
            selectedFormatIds: task.selectedFormatIds || [],
            formatSummary: task.formatSummary || null,
            mediaType: task.mediaType || '',
            referenceInfo: task.referenceInfo || null,
            remark: task.remark || '',
            tags: Array.isArray(task.tags) ? task.tags : [],
            status: task.status,
            progress: task.progress || { percent: 0 },
            outputFileName: task.outputFileName || '',
            outputFileSize: Number(task.outputFileSize) || 0,
            error: task.error || '',
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            completedAt: task.completedAt || 0,
            hasFile,
            downloadUrl: hasFile ? `${taskPath}/file` : '',
            previewUrl: hasFile ? `${taskPath}/file?inline=1` : ''
        };
    };

    try {
        const stored = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
        const now = Date.now();
        let changed = false;
        for (const task of Array.isArray(stored) ? stored : []) {
            if (!task?.id) continue;
            if (ACTIVE_STATUSES.has(task.status)) {
                task.status = 'queued';
                task.progress = { percent: 0 };
                task.error = '';
                task.completedAt = 0;
                task.updatedAt = now;
                queue.push(task.id);
                changed = true;
            }
            tasks.set(task.id, task);
        }
        if (changed) persist();
    } catch (_) {}

    async function run(task) {
        const controller = new AbortController();
        const taskDir = path.join(outputDir, task.id);
        const progressLog = { percent: -1, at: 0 };
        controllers.set(task.id, controller);
        try {
            update(task, { status: 'parsing', progress: { percent: 0 }, error: '' });
            emitLog(task, '开始解析 SNS 页面与媒体格式', { sourceUrl: task.url, mode: task.mode });
            const analysis = await analyze(task.url, {
                includeFormats: task.mode === 'custom',
                selectedFormatIds: task.selectedFormatIds,
                signal: controller.signal,
                onDetail(entry = {}) {
                    emitLog(task, entry.message || 'SNS 解析细节', entry.details || {}, entry.level || 'info');
                }
            });
            if (!analysis?.selection?.formatSelector) throw new Error('sns-download-media-unavailable');
            update(task, {
                platform: analysis.platform || task.platform,
                title: analysis.title || task.title,
                cover: analysis.cover || '',
                mediaType: analysis.mediaType || '',
                selectedFormatIds: analysis.selection.ids || [],
                formatSummary: analysis.selection.summary || null,
                referenceInfo: analysis.referenceInfo || null,
                status: 'downloading'
            });
            emitLog(task, 'SNS 信息解析完成', {
                title: analysis.title || '',
                platform: analysis.platform || task.platform,
                extractor: analysis.referenceInfo?.extractor || '',
                mediaType: analysis.mediaType || '',
                selectedFormatIds: analysis.selection.ids || [],
                listedFormats: Array.isArray(analysis.formats) ? analysis.formats.length : 0
            });
            fs.mkdirSync(taskDir, { recursive: true });
            const result = await download({
                task: { ...task }, analysis, taskDir, signal: controller.signal,
                onProgress(progress = {}) {
                    try { update(task, { progress: { ...(task.progress || {}), ...progress } }); } catch (_) {}
                    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
                    const now = Date.now();
                    if (progressLog.percent < 0 || percent >= 99.9 || percent - progressLog.percent >= 5 || now - progressLog.at >= 5000) {
                        progressLog.percent = percent;
                        progressLog.at = now;
                        emitLog(task, '下载进度', {
                            percent: Number(percent.toFixed(1)),
                            downloaded: progress.downloadedText || '', total: progress.totalText || '',
                            speed: progress.speedText || '', eta: progress.etaText || ''
                        });
                    }
                },
                onStage(status) {
                    if (!['downloading', 'merging'].includes(status)) return;
                    if (task.status !== status) {
                        update(task, { status });
                        emitLog(task, '处理阶段变化', { status });
                    }
                },
                onDetail(entry = {}) {
                    emitLog(task, entry.message || 'SNS 下载细节', entry.details || {}, entry.level || 'info');
                }
            });
            update(task, {
                status: 'completed',
                progress: { ...(task.progress || {}), percent: 100, etaText: '' },
                outputPath: result.outputPath,
                coverPath: result.coverPath || '',
                outputFileName: result.outputFileName,
                outputFileSize: Number(result.outputFileSize) || 0,
                title: result.title || task.title,
                completedAt: Date.now(),
                error: ''
            });
            emitLog(task, 'SNS 下载任务完成', {
                outputFileName: result.outputFileName || '',
                outputFileSize: Number(result.outputFileSize) || 0
            });
        } catch (error) {
            fs.rmSync(taskDir, { recursive: true, force: true });
            const cancelled = controller.signal.aborted || error?.message === 'download-cancelled';
            const safeError = cancelled ? '' : String(sanitizeError(error)).slice(0, 500);
            update(task, { status: cancelled ? 'cancelled' : 'failed', error: safeError, completedAt: Date.now() });
            emitLog(task, cancelled ? 'SNS 下载任务已取消' : 'SNS 下载任务失败', { error: safeError }, cancelled ? 'warn' : 'error');
        } finally {
            controllers.delete(task.id);
        }
    }

    function pump() {
        while (active < Math.max(1, Number(concurrency) || 1) && queue.length) {
            const task = getTask(queue.shift());
            if (!task || task.status !== 'queued') continue;
            active += 1;
            run(task).catch(() => {}).finally(() => { active -= 1; pump(); });
        }
    }
    if (queue.length) setImmediate(pump);

    return {
        outputDir,
        create(input = {}) {
            const normalized = normalizeSnsDownloadUrl(input.url);
            const mode = input.mode === 'custom' ? 'custom' : 'default';
            const selectedFormatIds = mode === 'custom'
                ? [...new Set((Array.isArray(input.selectedFormatIds) ? input.selectedFormatIds : [])
                    .map(value => String(value || '').trim()).filter(Boolean))]
                : [];
            if (mode === 'custom' && !selectedFormatIds.length) throw new Error('custom-format-required');
            if (selectedFormatIds.length > 2) throw new Error('custom-format-count-invalid');
            const now = Date.now();
            const task = {
                id: crypto.randomUUID(), url: normalized.url, platform: normalized.platform,
                title: '', cover: '', mode,
                downloadSections: String(input.downloadSections || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 500),
                selectedFormatIds, formatSummary: null, mediaType: '', referenceInfo: null,
                status: 'queued', progress: { percent: 0 }, outputPath: '', coverPath: '',
                outputFileName: '', outputFileSize: 0, error: '', remark: '', tags: [],
                createdAt: now, updatedAt: now, completedAt: 0
            };
            tasks.set(task.id, task);
            persist();
            queue.push(task.id);
            emitLog(task, '任务已创建并进入独立 SNS 队列', { sourceUrl: task.url, mode, queuePosition: queue.length });
            pump();
            return publicTask(task);
        },
        list(page = 1, pageSize = 10) {
            const size = Math.max(1, Math.min(50, Math.trunc(Number(pageSize) || 10)));
            const sorted = [...tasks.values()].sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
            const total = sorted.length;
            const pages = Math.max(1, Math.ceil(total / size));
            const current = Math.max(1, Math.min(pages, Math.trunc(Number(page) || 1)));
            return {
                page: current, pageSize: size, pages, total, ids: sorted.map(task => task.id),
                tasks: sorted.slice((current - 1) * size, current * size).map(publicTask)
            };
        },
        get(id) { const task = getTask(id); return task ? publicTask(task) : null; },
        cancel(id) {
            const task = getTask(id);
            if (!task) return null;
            if (!ACTIVE_STATUSES.has(task.status)) return publicTask(task);
            const controller = controllers.get(task.id);
            if (controller) controller.abort();
            else update(task, { status: 'cancelled', completedAt: Date.now(), error: '' });
            return publicTask(task);
        },
        clear(id) {
            const task = getTask(id);
            if (!task) return null;
            if (ACTIVE_STATUSES.has(task.status)) throw new Error('sns-download-task-active');
            fs.rmSync(path.join(outputDir, task.id), { recursive: true, force: true });
            return publicTask(update(task, {
                status: 'cleared', progress: { percent: 0 }, outputPath: '', coverPath: '', error: ''
            }));
        },
        retry(id) {
            const task = getTask(id);
            if (!task) return null;
            if (ACTIVE_STATUSES.has(task.status)) throw new Error('sns-download-task-active');
            fs.rmSync(path.join(outputDir, task.id), { recursive: true, force: true });
            update(task, {
                status: 'queued', progress: { percent: 0 }, outputPath: '', coverPath: '',
                outputFileName: '', outputFileSize: 0, error: '', completedAt: 0
            });
            queue.push(task.id);
            pump();
            return publicTask(task);
        },
        remove(id) {
            const task = getTask(id);
            if (!task) return false;
            if (ACTIVE_STATUSES.has(task.status)) throw new Error('sns-download-task-active');
            fs.rmSync(path.join(outputDir, task.id), { recursive: true, force: true });
            tasks.delete(task.id);
            persist();
            return true;
        },
        updateDetails(id, input = {}) {
            const task = getTask(id);
            if (!task) return null;
            const remark = String(input.remark ?? task.remark ?? '').slice(0, 4000);
            const tags = [...new Set((Array.isArray(input.tags) ? input.tags : task.tags || [])
                .map(tag => String(tag || '').trim().slice(0, 80)).filter(Boolean))].slice(0, 100);
            return publicTask(update(task, { remark, tags }));
        },
        setCoverPath(id, coverPath) {
            const task = getTask(id);
            return task ? publicTask(update(task, { coverPath: String(coverPath || '') })) : null;
        },
        getTaskDirectory(id) { return getTask(id) ? path.join(outputDir, String(id)) : null; },
        getFile(id, kind = 'output') {
            const task = getTask(id);
            const filePath = kind === 'cover' ? task?.coverPath : task?.outputPath;
            if (!task || !filePath || !fs.existsSync(filePath)) return null;
            const resolved = path.resolve(filePath);
            const relative = path.relative(outputDir, resolved);
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
            return { path: resolved, name: kind === 'cover' ? path.basename(resolved) : task.outputFileName };
        }
    };
}

module.exports = { ALLOWED_PLATFORMS, HOST_PLATFORMS, createSnsDownloadService, normalizeSnsDownloadUrl };
