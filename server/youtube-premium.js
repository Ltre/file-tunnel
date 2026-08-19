'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUNNING_STATUSES = new Set(['queued', 'parsing', 'downloading', 'merging', 'metadata']);

function extractYoutubeMetadataYear(value) {
    const text = String(value || '').trim();
    const compactDate = text.match(/^((?:19|20)\d{2})(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/);
    if (compactDate) return compactDate[1];
    return text.match(/(?:^|\D)((?:19|20)\d{2})(?=$|\D)/)?.[1] || '';
}

function resolveYoutubePremiumMediaType(detectedMediaType, selection, forceMusic = false) {
    if (forceMusic === true) return 'song';
    const selectedFormats = Array.isArray(selection?.formats) ? selection.formats : [];
    if (selectedFormats.some(format => format?.kind === 'video' || format?.kind === 'video_audio')) return 'video';
    return detectedMediaType === 'song' ? 'song' : 'video';
}

function normalizeYtDlpFormats(formats = []) {
    return (Array.isArray(formats) ? formats : []).flatMap(format => {
        const id = String(format?.format_id || '').trim();
        if (!id) return [];
        const videoCodec = String(format.vcodec || 'none');
        const audioCodec = String(format.acodec || 'none');
        const hasVideo = videoCodec !== 'none';
        const hasAudio = audioCodec !== 'none';
        return [{
            id,
            kind: hasVideo && hasAudio ? 'video_audio' : (hasVideo ? 'video' : (hasAudio ? 'audio' : 'other')),
            ext: String(format.ext || ''),
            protocol: String(format.protocol || ''),
            resolution: String(format.resolution || (format.width && format.height ? `${format.width}x${format.height}` : '')),
            width: Number(format.width) || 0,
            height: Number(format.height) || 0,
            fps: Number(format.fps) || 0,
            videoCodec,
            videoBitrate: Number(format.vbr) || 0,
            audioCodec,
            audioBitrate: Number(format.abr) || 0,
            sampleRate: Number(format.asr) || 0,
            totalBitrate: Number(format.tbr) || 0,
            fileSize: Number(format.filesize || format.filesize_approx) || 0,
            dynamicRange: String(format.dynamic_range || ''),
            language: String(format.language || ''),
            note: String(format.format_note || format.format || '').slice(0, 300)
        }];
    });
}

function getSelectedFormatIds(meta = {}) {
    const ids = [];
    const visit = value => {
        if (!value) return;
        if (Array.isArray(value)) return value.forEach(visit);
        if (typeof value !== 'object') return;
        if (Array.isArray(value.requested_formats)) visit(value.requested_formats);
        else if (value.format_id) ids.push(...String(value.format_id).split('+').map(id => id.trim()).filter(Boolean));
    };
    visit(meta.requested_formats);
    visit(meta.requested_downloads);
    if (!ids.length && meta.format_id) ids.push(...String(meta.format_id).split('+').map(id => id.trim()).filter(Boolean));
    return [...new Set(ids)];
}

function getPreferredMusicAudioFormat(formats = []) {
    const audio = (Array.isArray(formats) ? formats : []).filter(format => format.kind === 'audio');
    const sortByQuality = items => items.sort((a, b) =>
        (b.audioBitrate || b.totalBitrate) - (a.audioBitrate || a.totalBitrate) ||
        b.sampleRate - a.sampleRate || b.totalBitrate - a.totalBitrate || b.fileSize - a.fileSize
    );
    const m4a = sortByQuality(audio.filter(format => format.ext.toLowerCase() === 'm4a'))[0];
    const opus = sortByQuality(audio.filter(format => /opus/i.test(format.audioCodec)))[0];
    return (m4a && (m4a.audioBitrate || m4a.totalBitrate) > 136 ? m4a : opus || m4a || sortByQuality(audio)[0]) || null;
}

function getPreferredPremiumVideoFormat(formats = []) {
    const videos = (Array.isArray(formats) ? formats : []).filter(format => format.kind === 'video');
    const shortSide = format => format.width && format.height
        ? Math.min(format.width, format.height)
        : (format.height || format.width || 0);
    const best = items => items.sort((a, b) =>
        shortSide(b) - shortSide(a) || (b.videoBitrate || b.totalBitrate) - (a.videoBitrate || a.totalBitrate) ||
        b.fps - a.fps || b.fileSize - a.fileSize
    )[0];
    const resolutions = [...new Set(videos.map(shortSide).filter(value => value > 0 && value <= 1440))]
        .sort((a, b) => b - a);
    for (const resolution of resolutions) {
        const atResolution = videos.filter(format => shortSide(format) === resolution);
        const av1 = best(atResolution.filter(format => /^av0?1/i.test(format.videoCodec)));
        if (av1) return av1;
        const vp9 = best(atResolution.filter(format => /^vp0?9/i.test(format.videoCodec)));
        if (vp9) return vp9;
        const avc = best(atResolution.filter(format => /^(?:avc1|h264)/i.test(format.videoCodec)));
        if (avc) return avc;
    }
    return best(videos.filter(format => shortSide(format) <= 1440)) || null;
}

function validateFormatSelection(formats, selectedFormatIds, mediaType, forceMusic = false) {
    const byId = new Map((Array.isArray(formats) ? formats : []).map(format => [String(format.id), format]));
    const ids = [...new Set((Array.isArray(selectedFormatIds) ? selectedFormatIds : [])
        .map(id => String(id || '').trim()).filter(Boolean))];
    if (!ids.length || ids.length > 2) throw new Error('custom-format-count-invalid');
    const selected = ids.map(id => {
        const format = byId.get(id);
        if (!format) throw new Error('custom-format-not-found');
        return format;
    });

    if (selected.length === 1) {
        if (!['video', 'audio', 'video_audio'].includes(selected[0].kind)) throw new Error('custom-single-format-invalid');
    } else {
        const video = selected.find(format => format.kind === 'video');
        const audio = selected.find(format => format.kind === 'audio');
        if (!video || !audio) throw new Error('custom-video-format-conflict');
        selected.splice(0, selected.length, video, audio);
        ids.splice(0, ids.length, video.id, audio.id);
    }
    if (forceMusic && (selected.length !== 1 || selected[0].kind !== 'audio')) {
        throw new Error('custom-music-format-invalid');
    }

    const video = selected.find(format => format.kind === 'video' || format.kind === 'video_audio');
    const audio = selected.find(format => format.kind === 'audio' || format.kind === 'video_audio');
    const mp4Compatible = (!video || /^(?:avc1|av01|h26[45])/i.test(video.videoCodec)) &&
        (!audio || /^(?:mp4a|aac)/i.test(audio.audioCodec));
    const outputContainer = mediaType === 'song' && selected.length === 1 && selected[0].kind === 'audio'
        ? 'm4a'
        : (selected.length === 1 ? (selected[0].ext || 'mp4') : (mp4Compatible ? 'mp4' : 'mkv'));
    return {
        ids,
        formats: selected,
        formatSelector: ids.join('+'),
        outputContainer,
        summary: {
            finalFormat: ids.join(' + '),
            video: video ? [video.height ? `${video.height}p` : video.resolution, video.videoCodec].filter(Boolean).join(' / ') : '',
            audio: audio ? [audio.audioCodec, audio.audioBitrate ? `${Math.round(audio.audioBitrate)}kbps` : ''].filter(Boolean).join(' / ') : '',
            output: outputContainer.toUpperCase()
        }
    };
}

function writeJsonAtomic(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    try {
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        fs.copyFileSync(tempPath, filePath);
        try { fs.unlinkSync(tempPath); } catch (_) {}
    }
}

function createYoutubePremiumService({ dataDir, analyze, download, sanitizeError = error => error?.message || 'download-failed', concurrency = 1 }) {
    const tasksPath = path.join(dataDir, 'youtube-premium-tasks.json');
    const outputDir = path.join(dataDir, 'youtube-premium-downloads');
    const tasks = new Map();
    const queue = [];
    const controllers = new Map();
    const interruptedTaskIds = [];
    let active = 0;

    try {
        const stored = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
        const now = Date.now();
        let changed = false;
        for (const task of Array.isArray(stored) ? stored : []) {
            if (!task?.id) continue;
            if (RUNNING_STATUSES.has(task.status)) {
                task.status = 'queued';
                task.progress = { percent: 0 };
                task.error = '';
                task.completedAt = 0;
                task.updatedAt = now;
                interruptedTaskIds.push(task.id);
                changed = true;
            }
            tasks.set(task.id, task);
        }
        if (changed) writeJsonAtomic(tasksPath, [...tasks.values()]);
    } catch (_) {}

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
        return {
            id: task.id,
            url: task.url,
            title: task.title || '',
            cover: task.coverPath || (task.cover && !RUNNING_STATUSES.has(task.status))
                ? `/api/youtube-premium/tasks/${encodeURIComponent(task.id)}/cover`
                : '',
            mode: task.mode,
            asMusic: task.asMusic === true,
            downloadSections: task.downloadSections || '',
            selectedFormatIds: task.selectedFormatIds || [],
            formatSummary: task.formatSummary || null,
            mediaType: task.mediaType || '',
            remark: task.remark || '',
            tags: Array.isArray(task.tags) ? task.tags : [],
            songMetadata: task.songMetadata || null,
            songMetadataEditedAt: Number(task.songMetadataEditedAt) || 0,
            telegramShare: task.telegramShare || null,
            status: task.status,
            progress: task.progress || { percent: 0 },
            outputFileName: task.outputFileName || '',
            outputFileSize: Number(task.outputFileSize) || 0,
            error: task.error || '',
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            completedAt: task.completedAt || 0,
            hasFile,
            downloadUrl: hasFile ? `/api/youtube-premium/tasks/${encodeURIComponent(task.id)}/file` : '',
            previewUrl: hasFile ? `/api/youtube-premium/tasks/${encodeURIComponent(task.id)}/file?inline=1` : ''
        };
    };

    async function run(task) {
        const controller = new AbortController();
        controllers.set(task.id, controller);
        const taskDir = path.join(outputDir, task.id);
        try {
            update(task, { status: 'parsing', error: '', progress: { percent: 0 } });
            const analysis = await analyze(task.url, {
                includeFormats: task.mode === 'custom',
                selectedFormatIds: task.selectedFormatIds,
                forceMusic: task.asMusic === true,
                signal: controller.signal
            });
            if (task.songMetadataOverride && analysis.songMetadata) {
                analysis.songMetadata = { ...analysis.songMetadata, ...task.songMetadataOverride };
            }
            update(task, {
                title: analysis.title,
                cover: analysis.cover,
                mediaType: analysis.mediaType,
                selectedFormatIds: analysis.selection.ids,
                formatSummary: analysis.selection.summary,
                referenceInfo: task.referenceInfo || analysis.referenceInfo || null,
                status: 'downloading'
            });
            fs.mkdirSync(taskDir, { recursive: true });
            const result = await download({
                task: { ...task },
                analysis,
                taskDir,
                signal: controller.signal,
                onProgress(progress) {
                    try { update(task, { progress: { ...(task.progress || {}), ...progress } }); } catch (_) {}
                },
                onStage(status) {
                    if (!['downloading', 'merging', 'metadata'].includes(status)) return;
                    try { update(task, { status }); } catch (_) {}
                }
            });
            update(task, {
                status: 'completed',
                progress: { ...(task.progress || {}), percent: 100, etaText: '' },
                outputPath: result.outputPath,
                coverPath: result.coverPath || '',
                outputFileName: result.outputFileName,
                outputFileSize: Number(result.outputFileSize) || 0,
                songMetadata: result.songMetadata || null,
                title: result.title || task.title,
                completedAt: Date.now(),
                error: ''
            });
        } catch (error) {
            fs.rmSync(taskDir, { recursive: true, force: true });
            const cancelled = controller.signal.aborted || error?.message === 'download-cancelled';
            update(task, {
                status: cancelled ? 'cancelled' : 'failed',
                error: cancelled ? '' : String(sanitizeError(error) || '下载失败').slice(0, 500),
                completedAt: Date.now()
            });
        } finally {
            controllers.delete(task.id);
        }
    }

    function pump() {
        while (active < Math.max(1, Number(concurrency) || 1) && queue.length) {
            const task = getTask(queue.shift());
            if (!task || task.status !== 'queued') continue;
            active += 1;
            run(task).catch(() => {}).finally(() => {
                active -= 1;
                pump();
            });
        }
    }

    if (interruptedTaskIds.length) {
        queue.push(...interruptedTaskIds);
        setImmediate(pump);
    }

    return {
        outputDir,
        create(input = {}) {
            const mode = input.mode === 'custom' ? 'custom' : 'default';
            const url = String(input.url || '').trim().slice(0, 2048);
            let parsed;
            try { parsed = new URL(url); } catch (_) { throw new Error('youtube-url-required'); }
            if (!['http:', 'https:'].includes(parsed.protocol) ||
                !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(parsed.hostname.toLowerCase())) {
                throw new Error('youtube-url-required');
            }
            const selectedFormatIds = mode === 'custom'
                ? [...new Set((Array.isArray(input.selectedFormatIds) ? input.selectedFormatIds : []).map(String).map(id => id.trim()).filter(Boolean))]
                : [];
            if (mode === 'custom' && !selectedFormatIds.length) throw new Error('custom-format-required');
            if (selectedFormatIds.length > 2) throw new Error('custom-format-count-invalid');
            const downloadSections = String(input.downloadSections || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 500);
            const now = Date.now();
            const task = {
                id: crypto.randomUUID(), url, title: '', cover: '', mode, asMusic: input.asMusic === true, downloadSections, selectedFormatIds,
                mediaType: '', status: 'queued', progress: { percent: 0 }, outputFileName: '',
                outputFileSize: 0, outputPath: '', coverPath: '', error: '', createdAt: now,
                updatedAt: now, completedAt: 0, remark: '', tags: [], songMetadata: null,
                songMetadataOverride: null, songMetadataEditedAt: 0, referenceInfo: null,
                telegramShare: null
            };
            tasks.set(task.id, task);
            persist();
            queue.push(task.id);
            pump();
            return publicTask(task);
        },
        list(page = 1, pageSize = 10) {
            const size = Math.max(1, Math.min(50, Math.trunc(Number(pageSize) || 10)));
            const sorted = [...tasks.values()].sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
            const total = sorted.length;
            const pages = Math.max(1, Math.ceil(total / size));
            const current = Math.max(1, Math.min(pages, Math.trunc(Number(page) || 1)));
            return {
                page: current, pageSize: size, pages, total,
                ids: sorted.map(task => task.id),
                tasks: sorted.slice((current - 1) * size, current * size).map(publicTask)
            };
        },
        get(id) {
            const task = getTask(id);
            return task ? publicTask(task) : null;
        },
        cancel(id) {
            const task = getTask(id);
            if (!task) return null;
            if (!RUNNING_STATUSES.has(task.status)) return publicTask(task);
            const controller = controllers.get(task.id);
            if (controller) controller.abort();
            else update(task, { status: 'cancelled', completedAt: Date.now(), error: '' });
            return publicTask(task);
        },
        clear(id) {
            const task = getTask(id);
            if (!task) return null;
            if (RUNNING_STATUSES.has(task.status)) throw new Error('youtube-premium-task-active');
            fs.rmSync(path.join(outputDir, task.id), { recursive: true, force: true });
            return publicTask(update(task, {
                status: 'cleared', progress: { percent: 0 }, outputPath: '', coverPath: '',
                error: '', telegramShare: null
            }));
        },
        retry(id) {
            const task = getTask(id);
            if (!task) return null;
            if (RUNNING_STATUSES.has(task.status)) throw new Error('youtube-premium-task-active');
            fs.rmSync(path.join(outputDir, task.id), { recursive: true, force: true });
            update(task, {
                status: 'queued', progress: { percent: 0 }, outputPath: '', coverPath: '',
                outputFileName: '', outputFileSize: 0, error: '', completedAt: 0, telegramShare: null
            });
            queue.push(task.id);
            pump();
            return publicTask(task);
        },
        remove(id) {
            const task = getTask(id);
            if (!task) return false;
            if (RUNNING_STATUSES.has(task.status)) throw new Error('youtube-premium-task-active');
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
            if (!task) return null;
            return publicTask(update(task, { coverPath: String(coverPath || '') }));
        },
        setReferenceInfo(id, referenceInfo) {
            const task = getTask(id);
            if (!task) return null;
            return publicTask(update(task, { referenceInfo: referenceInfo || null }));
        },
        getReferenceInfo(id) {
            return getTask(id)?.referenceInfo || null;
        },
        setTelegramShare(id, share) {
            const task = getTask(id);
            if (!task) return null;
            return publicTask(update(task, { telegramShare: share || null }));
        },
        getTelegramShare(id) {
            return getTask(id)?.telegramShare || null;
        },
        setSongMetadata(id, metadata, output = {}) {
            const task = getTask(id);
            if (!task) return null;
            return publicTask(update(task, {
                songMetadata: metadata,
                songMetadataOverride: metadata,
                songMetadataEditedAt: Date.now(),
                outputPath: output.outputPath || task.outputPath,
                outputFileName: output.outputFileName || task.outputFileName,
                outputFileSize: Number(output.outputFileSize) || task.outputFileSize,
                completedAt: Date.now()
            }));
        },
        getTaskDirectory(id) {
            return getTask(id) ? path.join(outputDir, String(id)) : null;
        },
        getFile(id, kind = 'output') {
            const task = getTask(id);
            const filePath = kind === 'cover' ? task?.coverPath : task?.outputPath;
            if (!task || !filePath || !fs.existsSync(filePath)) return null;
            const relative = path.relative(outputDir, path.resolve(filePath));
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
            return { path: path.resolve(filePath), name: kind === 'cover' ? path.basename(filePath) : task.outputFileName };
        }
    };
}

module.exports = {
    createYoutubePremiumService,
    extractYoutubeMetadataYear,
    getPreferredMusicAudioFormat,
    getPreferredPremiumVideoFormat,
    getSelectedFormatIds,
    normalizeYtDlpFormats,
    resolveYoutubePremiumMediaType,
    validateFormatSelection
};
