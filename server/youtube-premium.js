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

function normalizePositiveOrdinal(value) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) && number > 0 ? String(number) : '';
}

function normalizeYoutubeMusicLookupText(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, ' ')
        .trim();
}

function finalizeYoutubeMusicTrackNumber(meta = {}, derivedTrackNumber = '') {
    return normalizePositiveOrdinal(meta.track_number) || normalizePositiveOrdinal(derivedTrackNumber) || '1';
}

function findYoutubeMusicTrackPosition(meta = {}, playlistEntries = []) {
    if (!Array.isArray(playlistEntries) || !playlistEntries.length) return '';
    const wantedId = String(meta.id || '').trim();
    if (wantedId) {
        const index = playlistEntries.findIndex(entry => {
            const entryId = String(entry?.id || '').trim();
            if (entryId && entryId === wantedId) return true;
            return [entry?.url, entry?.webpage_url, entry?.original_url]
                .filter(Boolean)
                .some(value => String(value).includes(wantedId));
        });
        if (index >= 0) return String(index + 1);
    }

    // Some flat-playlist responses may omit video IDs. Only use title matching when it
    // resolves to one unique entry; duplicate song names in the same album are otherwise
    // too risky to guess.
    const wantedTitle = normalizeYoutubeMusicLookupText(meta.track || meta.title || meta.fulltitle);
    if (!wantedTitle) return '';
    const titleMatches = playlistEntries
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => normalizeYoutubeMusicLookupText(entry?.track || entry?.title || entry?.fulltitle) === wantedTitle);
    return titleMatches.length === 1 ? String(titleMatches[0].index + 1) : '';
}

function rankYoutubeMusicAlbumCandidates(meta = {}, entries = []) {
    const album = normalizeYoutubeMusicLookupText(meta.album || meta.playlist_title);
    const artist = normalizeYoutubeMusicLookupText(
        meta.album_artist || (Array.isArray(meta.album_artists) ? meta.album_artists.join(' ') : meta.album_artists) ||
        (Array.isArray(meta.artists) ? meta.artists.join(' ') : meta.artist)
    );
    return (Array.isArray(entries) ? entries : [])
        .map((entry, index) => {
            const title = normalizeYoutubeMusicLookupText(entry?.album || entry?.title || entry?.playlist_title);
            const entryArtist = normalizeYoutubeMusicLookupText(
                entry?.album_artist || (Array.isArray(entry?.album_artists) ? entry.album_artists.join(' ') : entry?.album_artists) ||
                (Array.isArray(entry?.artists) ? entry.artists.join(' ') : entry?.artist) || entry?.channel || entry?.uploader
            );
            let score = 0;
            if (album && title === album) score += 100;
            else if (album && title && (title.includes(album) || album.includes(title))) score += 45;
            if (artist && entryArtist === artist) score += 30;
            else if (artist && entryArtist && (entryArtist.includes(artist) || artist.includes(entryArtist))) score += 12;
            return { entry, index, score };
        })
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map(item => item.entry);
}

function getYoutubeAlbumPlaylistId(meta = {}, sourceUrl = '') {
    let sourceListId = '';
    try {
        sourceListId = new URL(String(sourceUrl || '')).searchParams.get('list') || '';
    } catch (_) {}
    const playlistId = String(meta.playlist_id || sourceListId || '').trim();
    return /^OLAK5uy_/i.test(playlistId) ? playlistId : '';
}

function resolveYoutubeMusicOrdinalMetadata(meta = {}, sourceUrl = '', playlistEntries = []) {
    const albumPlaylistId = getYoutubeAlbumPlaylistId(meta, sourceUrl);
    let trackNumber = normalizePositiveOrdinal(meta.track_number);
    if (!trackNumber && albumPlaylistId) {
        trackNumber = normalizePositiveOrdinal(meta.playlist_index);
        if (!trackNumber) {
            try {
                trackNumber = normalizePositiveOrdinal(new URL(String(sourceUrl || '')).searchParams.get('index'));
            } catch (_) {}
        }
        if (!trackNumber && meta.id && Array.isArray(playlistEntries)) {
            trackNumber = findYoutubeMusicTrackPosition(meta, playlistEntries);
        }
    }
    return {
        trackNumber,
        discNumber: normalizePositiveOrdinal(meta.disc_number) || '1',
        albumPlaylistId
    };
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

function createYoutubePremiumService({
    dataDir,
    analyze,
    download,
    sanitizeError = error => error?.message || 'download-failed',
    concurrency = 1,
    onLog = () => {}
}) {
    const tasksPath = path.join(dataDir, 'youtube-premium-tasks.json');
    const outputDir = path.join(dataDir, 'youtube-premium-downloads');
    const tasks = new Map();
    const queue = [];
    const controllers = new Map();
    const interruptedTaskIds = [];
    let active = 0;

    const emitLog = (task, message, details = {}, level = 'info') => {
        try {
            onLog({
                taskId: String(task?.id || ''),
                createdAt: Number(task?.createdAt) || Date.now(),
                elapsedMs: Math.max(0, Date.now() - (Number(task?.createdAt) || Date.now())),
                level,
                message: String(message || ''),
                details: details && typeof details === 'object' ? details : { value: details }
            });
        } catch (_) {
            // Console/reporting failures must never change the download task result.
        }
    };

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
        const progressLog = { lastPercent: -1, lastAt: 0 };
        try {
            emitLog(task, '任务开始执行', {
                mode: task.mode,
                asMusic: task.asMusic === true,
                selectedFormatIds: task.selectedFormatIds || [],
                downloadSections: task.downloadSections || '完整媒体',
                queueRemaining: queue.length,
                active,
                concurrency: Math.max(1, Number(concurrency) || 1)
            });
            update(task, { status: 'parsing', error: '', progress: { percent: 0 } });
            emitLog(task, '开始解析 YouTube 页面与媒体格式', { sourceUrl: task.url });
            const analysis = await analyze(task.url, {
                includeFormats: task.mode === 'custom',
                selectedFormatIds: task.selectedFormatIds,
                forceMusic: task.asMusic === true,
                signal: controller.signal,
                onDetail(entry = {}) {
                    emitLog(task, entry.message || 'YouTube 解析细节', entry.details || {}, entry.level || 'info');
                }
            });
            if (task.songMetadataOverride && analysis.songMetadata) {
                analysis.songMetadata = { ...analysis.songMetadata, ...task.songMetadataOverride };
                emitLog(task, '已应用用户编辑过的歌曲元信息', {
                    fields: Object.keys(task.songMetadataOverride).filter(key => task.songMetadataOverride[key] !== '')
                });
            }
            emitLog(task, 'YouTube 信息解析完成', {
                title: analysis.title || '',
                youtubeVideoId: analysis.youtubeVideoId || '',
                mediaType: analysis.mediaType || '',
                durationSeconds: Number(analysis.duration) || 0,
                selectedFormatIds: analysis.selection?.ids || [],
                formatSelector: analysis.selection?.formatSelector || '',
                outputContainer: analysis.selection?.outputContainer || '',
                selectedFormats: analysis.selection?.summary || null,
                listedFormats: Array.isArray(analysis.formats) ? analysis.formats.length : 0,
                hasCover: Boolean(analysis.cover),
                hasSongMetadata: Boolean(analysis.songMetadata)
            });
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
            emitLog(task, '开始下载并处理媒体', {
                taskDir,
                mediaType: analysis.mediaType,
                selectedFormatIds: analysis.selection?.ids || [],
                formatSelector: analysis.selection?.formatSelector || '',
                outputContainer: analysis.selection?.outputContainer || '',
                downloadSections: task.downloadSections || '完整媒体'
            });
            const result = await download({
                task: { ...task },
                analysis,
                taskDir,
                signal: controller.signal,
                onProgress(progress) {
                    try { update(task, { progress: { ...(task.progress || {}), ...progress } }); } catch (_) {}
                    const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 0));
                    const now = Date.now();
                    if (progressLog.lastPercent < 0 || percent >= 99.9 || percent - progressLog.lastPercent >= 5 || now - progressLog.lastAt >= 5000) {
                        progressLog.lastPercent = percent;
                        progressLog.lastAt = now;
                        emitLog(task, '下载进度', {
                            percent: Number(percent.toFixed(1)),
                            downloaded: progress?.downloadedText || '',
                            total: progress?.totalText || '',
                            speed: progress?.speedText || '',
                            eta: progress?.etaText || ''
                        });
                    }
                },
                onStage(status) {
                    if (!['downloading', 'merging', 'metadata'].includes(status)) return;
                    const previousStatus = task.status;
                    try { update(task, { status }); } catch (_) {}
                    if (status !== previousStatus) {
                        const labels = { downloading: '下载媒体数据', merging: '合并音视频轨', metadata: '处理封面与写入歌曲元信息' };
                        emitLog(task, '处理阶段变化', { status, label: labels[status] || status });
                    }
                },
                onDetail(entry = {}) {
                    emitLog(task, entry.message || '下载处理细节', entry.details || {}, entry.level || 'info');
                }
            });
            emitLog(task, '下载处理流程已返回成品', {
                outputPath: result.outputPath || '',
                coverPath: result.coverPath || '',
                outputFileName: result.outputFileName || '',
                outputFileSize: Number(result.outputFileSize) || 0,
                title: result.title || task.title || '',
                hasSongMetadata: Boolean(result.songMetadata)
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
            emitLog(task, '任务完成', {
                outputFileName: result.outputFileName || '',
                outputFileSize: Number(result.outputFileSize) || 0,
                elapsedSeconds: Number(((Date.now() - task.createdAt) / 1000).toFixed(1))
            });
        } catch (error) {
            fs.rmSync(taskDir, { recursive: true, force: true });
            const cancelled = controller.signal.aborted || error?.message === 'download-cancelled';
            const safeError = cancelled ? '' : String(sanitizeError(error) || '下载失败').slice(0, 500);
            const statusBeforeFailure = task.status;
            update(task, {
                status: cancelled ? 'cancelled' : 'failed',
                error: safeError,
                completedAt: Date.now()
            });
            emitLog(task, cancelled ? '任务已取消' : '任务失败', {
                statusBeforeFailure,
                error: safeError,
                elapsedSeconds: Number(((Date.now() - task.createdAt) / 1000).toFixed(1))
            }, cancelled ? 'warn' : 'error');
        } finally {
            controllers.delete(task.id);
            emitLog(task, '任务执行槽已释放', { status: task.status, activeBeforeRelease: active });
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
        for (const taskId of interruptedTaskIds) {
            const task = getTask(taskId);
            if (task) emitLog(task, '服务重启后恢复未完成任务到队列', { queuePosition: queue.indexOf(taskId) + 1 }, 'warn');
        }
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
            emitLog(task, '任务已创建并进入队列', {
                sourceUrl: url,
                mode,
                asMusic: task.asMusic,
                selectedFormatIds,
                downloadSections: downloadSections || '完整媒体',
                queuePosition: queue.length
            });
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
            emitLog(task, '收到取消任务请求', { status: task.status, running: Boolean(controller) }, 'warn');
            if (controller) controller.abort();
            else {
                update(task, { status: 'cancelled', completedAt: Date.now(), error: '' });
                emitLog(task, '排队任务已取消', {}, 'warn');
            }
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
            emitLog(task, '任务已重新加入队列', { queuePosition: queue.length }, 'warn');
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
    finalizeYoutubeMusicTrackNumber,
    findYoutubeMusicTrackPosition,
    normalizeYoutubeMusicLookupText,
    rankYoutubeMusicAlbumCandidates,
    resolveYoutubeMusicOrdinalMetadata,
    getPreferredMusicAudioFormat,
    getPreferredPremiumVideoFormat,
    getSelectedFormatIds,
    normalizeYtDlpFormats,
    resolveYoutubePremiumMediaType,
    validateFormatSelection
};
