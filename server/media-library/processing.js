'use strict';
const fs = require('node:fs'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
function timestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    const text = String(value).trim();
    if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(text)) throw Error('MEDIA_TIME_INVALID');
    const parts = text.split(':').map(Number);
    if (parts.slice(1).some(n => n >= 60)) throw Error('MEDIA_TIME_INVALID');
    return parts.reduce((sum, n) => sum * 60 + n, 0);
}
function ranges(value, duration) {
    if (!(duration > 0) || !Number.isFinite(duration)) throw Error('MEDIA_DURATION_INVALID');
    const input = String(value || '').trim();
    const intervals = input ? input.split(',').map(part => {
        const ends = part.trim().split('-'); if (ends.length !== 2) throw Error('MEDIA_RANGE_INVALID');
        const start = timestamp(ends[0]), end = timestamp(ends[1]);
        if (start >= end || end > duration + 0.001) throw Error('MEDIA_RANGE_INVALID');
        return [start, Math.min(end, duration)];
    }) : [[0, duration]];
    const result = [];
    for (const item of intervals.sort((a, b) => a[0] - b[0])) {
        const previous = result.at(-1); if (previous && item[0] <= previous[1]) previous[1] = Math.max(previous[1], item[1]); else result.push(item);
    }
    if (result.length > 50) throw Error('MEDIA_RANGE_LIMIT'); return result;
}
function sampleTimes(input, duration, random = () => crypto.randomInt(0, 1000000000) / 1000000000) {
    const intervals = ranges(input.ranges, duration), count = Number(input.count ?? 24);
    if (!Number.isInteger(count) || count < 1 || count > 500) throw Error('MEDIA_COUNT_INVALID');
    const step = Number(input.intervalMs || input.minIntervalMs || 0) / 1000;
    if (input.mode === 'interval') {
        if (!(step >= .01)) throw Error('MEDIA_INTERVAL_INVALID');
        const total = intervals.reduce((n, [start, end]) => n + Math.ceil((end - start) / step), 0);
        if (total > 500) throw Error('MEDIA_COUNT_LIMIT');
        return intervals.flatMap(([start, end]) => Array.from({ length: Math.ceil((end - start) / step) }, (_, n) => start + step * n));
    }
    if (input.mode !== 'random') throw Error('MEDIA_MODE_INVALID');
    if (step && (step < .01 || !Number.isFinite(step))) throw Error('MEDIA_INTERVAL_INVALID');
    // Draw without replacement from bounded millisecond positions; optional
    // granularity limits spacing without turning random mode into interval mode.
    const granularity = step || .001;
    const slots = intervals.map(([start, end]) => ({ start, count: Math.max(0, Math.ceil((end - start) / granularity)) }));
    const total = slots.reduce((n, item) => n + item.count, 0), wanted = Math.min(count, total), picked = new Set();
    for (let n = total - wanted; n < total; n++) {
        const index = Math.min(n, Math.floor(random() * (n + 1))); picked.add(picked.has(index) ? n : index);
    }
    return [...picked].map(index => { for (const item of slots) { if (index < item.count) return item.start + index * granularity; index -= item.count; } }).sort((a, b) => a - b);
}
function execute(command, args, { signal, maxBytes = 4 * 1024 * 1024, timeoutMs = 30 * 60000, onOutput, onStdout, collectStdout = true } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = [], stderr = '', size = 0, failure, killTimer;
        const stop = error => { failure ||= error; child.kill(); killTimer ||= setTimeout(() => child.kill('SIGKILL'), 3000); killTimer.unref?.(); };
        const abort = () => stop(Error('MEDIA_CANCELLED'));
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
        const timer = setTimeout(() => stop(Error('MEDIA_PROCESS_TIMEOUT')), timeoutMs); timer.unref?.();
        const finish = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
        child.stdout.on('data', chunk => { try { onStdout?.(String(chunk)); } catch (error) { stop(error); }
            if (collectStdout) { size += chunk.length; if (size > maxBytes) stop(Error('MEDIA_PROCESS_OUTPUT_LIMIT')); else out.push(chunk); } });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); onOutput?.(String(chunk)); });
        child.once('error', error => { finish(); reject(error); });
        child.once('close', code => { finish(); failure ? reject(failure) : code !== 0 ? reject(Error('MEDIA_DECODE_FAILED')) : resolve({ stdout: Buffer.concat(out), stderr }); });
    });
}
function durationOf(probe) {
    const videoDuration = Number(videoOf(probe)?.duration);
    if (videoDuration > 0) return videoDuration;
    let container = Number(probe.format?.duration) || 0;
    // MOV and Matroska can report the end timestamp including a positive
    // timeline origin. MPEG-TS reports a span, so must not use this adjustment.
    const origin = Number(probe.format?.start_time) || 0;
    if (origin > 0 && container > origin && /(?:matroska|webm|mov|mp4)/.test(probe.format?.format_name || '')) container -= origin;
    return Math.max(0, container, ...(probe.streams || []).map(s => Number(s.duration) || 0));
}
function videoOf(probe) { return (probe.streams || []).find(s => s.codec_type === 'video' && !s.disposition?.attached_pic); }
function validateMedia(probe, { expectedDuration, audio, video = true, precise = true } = {}) {
    const streams = (probe.streams || []).filter(s => s.codec_type === 'audio' || s.codec_type === 'video' && !s.disposition?.attached_pic);
    if (video && !videoOf(probe) || audio && !streams.some(s => s.codec_type === 'audio') || !durationOf(probe)) throw Error('MEDIA_OUTPUT_INVALID');
    const tolerance = Math.max(.15, Number(videoOf(probe)?.avg_frame_rate?.split('/')[1]) / Number(videoOf(probe)?.avg_frame_rate?.split('/')[0]) * 3 || 0);
    if (precise && expectedDuration && Math.abs(durationOf(probe) - expectedDuration) > tolerance) throw Error('MEDIA_OUTPUT_DURATION_MISMATCH');
    const starts = streams.map(s => Number(s.start_time)).filter(Number.isFinite), ends = streams.filter(s => Number(s.duration) > 0).map(s => (Number(s.start_time) || 0) + Number(s.duration));
    if (precise && starts.length > 1 && Math.max(...starts) - Math.min(...starts) > tolerance || ends.length > 1 && Math.max(...ends) - Math.min(...ends) > tolerance) throw Error('MEDIA_AV_TIMELINE_MISMATCH');
    return { duration: durationOf(probe), tolerance, streams: streams.map(s => ({ codec: s.codec_name, type: s.codec_type, start: s.start_time, duration: s.duration })) };
}
function similarity(left, right) {
    if (left.sha256 && left.sha256 === right.sha256) return { exact: true, score: 100, hashScore: 100 };
    const a = BigInt('0x' + left.dHash), b = BigInt('0x' + right.dHash); let xor = a ^ b, different = 0;
    while (xor) { different++; xor &= xor - 1n; }
    const pixelsA = Buffer.from(left.pixels, 'base64'), pixelsB = Buffer.from(right.pixels, 'base64');
    const difference = pixelsA.reduce((sum, n, index) => sum + Math.abs(n - pixelsB[index]), 0) / pixelsA.length;
    return { exact: false, hashScore: Math.round((1 - different / 64) * 100), score: Math.round((1 - difference / 255) * 100) };
}
function createMediaProcessing({ ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', run = execute } = {}) {
    const common = ['-nostdin', '-hide_banner', '-threads', '1', '-filter_threads', '1'];
    const localInput = input => /^http:\/\/127\.0\.0\.1:\d+\//.test(input) ? ['-http_proxy', ''] : [];
    async function probe(input, signal) { const out = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', ...localInput(input), input], { signal }); return JSON.parse(out.stdout.toString()); }
    async function signature(input, signal) {
        const small = await run(ffmpeg, [...common, '-loglevel', 'error', ...localInput(input), '-i', input, '-frames:v', '1', '-vf', 'scale=9:8,format=gray', '-f', 'rawvideo', 'pipe:1'], { signal });
        const pixels = await run(ffmpeg, [...common, '-loglevel', 'error', ...localInput(input), '-i', input, '-frames:v', '1', '-vf', 'scale=32:32,format=gray', '-f', 'rawvideo', 'pipe:1'], { signal });
        if (small.stdout.length !== 72 || pixels.stdout.length !== 1024) throw Error('MEDIA_IMAGE_INVALID');
        let hash = 0n; for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) hash = (hash << 1n) | BigInt(small.stdout[row * 9 + col] > small.stdout[row * 9 + col + 1]);
        return { dHash: hash.toString(16).padStart(16, '0'), pixels: pixels.stdout.toString('base64') };
    }
    async function frame(input, requested, output, sourceProbe, signal) {
        const start = Number(sourceProbe.format?.start_time) || 0;
        const value = await run(ffmpeg, [...common, '-loglevel', 'info', '-copyts', '-ss', String(requested), ...localInput(input), '-i', input,
            '-map', '0:v:0', '-vf', 'showinfo', '-frames:v', '1', '-threads', '1', '-fps_mode', 'passthrough', '-q:v', '2', '-y', output], { signal });
        const match = /\bn:\s*0\s+pts:.*?pts_time:\s*([\d.e+-]+)/.exec(value.stderr);
        if (!match || !fs.existsSync(output) || !fs.statSync(output).size) throw Error('MEDIA_FRAME_TIME_UNCONFIRMED');
        const actual = Number(match[1]) - start;
        if (!Number.isFinite(actual) || actual < -.001) throw Error('MEDIA_FRAME_TIME_UNCONFIRMED');
        return { actualMs: Math.round(actual * 1000), requestedMs: Math.round(requested * 1000),
            sha256: crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex'), ...await signature(output, signal) };
    }
    async function cut(input, start, end, output, { audio = true, precise = true, signal, sourceProbe, onOutput } = {}) {
        if (!(start >= 0 && end > start && end <= durationOf(sourceProbe) + .001)) throw Error('MEDIA_RANGE_INVALID');
        const hasAudio = audio && sourceProbe.streams.some(s => s.codec_type === 'audio');
        const args = [...common, '-loglevel', 'error', '-ss', String(start), ...localInput(input), '-i', input, '-t', String(end - start), '-map', '0:v:0', '-threads', '1'];
        if (hasAudio) args.push('-map', '0:a:0'); else args.push('-an');
        if (precise) args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-vf', 'setpts=PTS-STARTPTS');
        else args.push('-c:v', 'copy');
        if (hasAudio) args.push(...(precise ? ['-c:a', 'aac', '-b:a', '192k', '-af', 'aresample=async=1:first_pts=0'] : ['-c:a', 'copy']));
        args.push('-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-progress', 'pipe:2', '-y', output);
        await run(ffmpeg, args, { signal, onOutput });
        const result = await probe(output, signal); const quality = validateMedia(result, { expectedDuration: end - start, audio: hasAudio, precise });
        await run(ffmpeg, [...common, '-v', 'error', '-xerror', '-i', output, '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : []), '-f', 'null', '-'], { signal });
        const packets = await timeline(output, signal); validatePacketBounds(packets, result, quality.tolerance);
        return { ...quality, packets, precise, qualityNotice: precise ? '重新编码精确裁切，保留高画质；仍可能受源质量影响' : '快速流复制：切点允许调整，实际时长以校验结果为准', start, end };
    }
    async function frameNeighbors(input, time, sourceProbe, signal) {
        const start = Math.max(0, time - 3), offset = Number(sourceProbe.format?.start_time) || 0;
        const out = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${start + offset}%+6`, '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', ...localInput(input), input], { signal, maxBytes: 2 * 1024 * 1024 });
        return (JSON.parse(out.stdout.toString()).frames || []).map(f => Number(f.best_effort_timestamp_time) - offset).filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
    }
    async function timeline(input, signal) {
        // Stream packet timestamps without an unbounded full-video JSON copy.
        // DTS accommodates normal reordered B frames, unlike PTS.
        const tracks = new Map(); let partial = '';
        const parse = line => { if (!line.trim()) return; const fields = Object.fromEntries(line.split('|').map(p => p.split('=')));
            const id = Number(fields.stream_index), dts = Number(fields.dts_time); if (!Number.isFinite(id) || !Number.isFinite(dts)) return;
            const prior = tracks.get(id); if (prior && dts < prior.last - .001) throw Error('MEDIA_TIMESTAMP_DISCONTINUITY');
            const pts = Number(fields.pts_time), present = Number.isFinite(pts) ? pts : dts, end = present + (Number(fields.duration_time) || 0);
            tracks.set(id, { first: prior?.first ?? dts, last: dts, start: Math.min(prior?.start ?? present, present), end: Math.max(prior?.end ?? end, end), packets: (prior?.packets || 0) + 1 }); };
        await run(ffprobe, ['-v', 'error', '-show_packets', '-show_entries', 'packet=stream_index,dts_time,pts_time,duration_time', '-of', 'compact=p=0', input], { signal, collectStdout: false,
            onStdout(chunk) { partial += chunk; const lines = partial.split('\n'); partial = lines.pop(); if (partial.length > 8192) throw Error('MEDIA_PROCESS_OUTPUT_LIMIT'); lines.forEach(parse); } });
        parse(partial); return [...tracks].map(([stream, values]) => ({ stream, ...values }));
    }
    function validatePacketBounds(packets, probe, tolerance) {
        const indices = (probe.streams || []).filter(s => ['audio', 'video'].includes(s.codec_type) && !s.disposition?.attached_pic).map(s => s.index);
        const tracks = packets.filter(p => indices.includes(p.stream));
        if (!tracks.length || tracks.length < indices.length) throw Error('MEDIA_OUTPUT_INVALID');
        if (tracks.length > 1 && (Math.max(...tracks.map(p => p.start)) - Math.min(...tracks.map(p => p.start)) > tolerance
            || Math.max(...tracks.map(p => p.end)) - Math.min(...tracks.map(p => p.end)) > tolerance)) throw Error('MEDIA_AV_TIMELINE_MISMATCH');
    }
    return { probe, signature, frame, cut, frameNeighbors,
        async probeVersion() { const versions = await Promise.all([run(ffmpeg, ['-version']), run(ffprobe, ['-version'])]); return versions.map(value => value.stdout.toString().split('\n')[0]); },
        async verify(input, options) { const info = await probe(input, options?.signal), value = validateMedia(info, options); await run(ffmpeg, [...common, '-v', 'error', '-xerror', '-i', input, '-f', 'null', '-'], { signal: options?.signal });
            const packets = await timeline(input, options?.signal); validatePacketBounds(packets, info, value.tolerance); return { ...value, packets }; } };
}
module.exports = { timestamp, ranges, sampleTimes, execute, durationOf, validateMedia, similarity, createMediaProcessing };
