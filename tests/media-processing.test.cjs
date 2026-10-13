'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { timestamp, ranges, sampleTimes, createMediaProcessing, execute, validateMedia, durationOf } = require('../server/media-library/processing');
const { sectionDuration, verifyDownloadedSection } = require('../server/media-section-quality');
const ffmpeg = process.env.TEST_FFMPEG || (fs.existsSync('D:/GreenApps/ffmpeg/5.1.2/bin/ffmpeg.exe') ? 'D:/GreenApps/ffmpeg/5.1.2/bin/ffmpeg.exe' : 'ffmpeg');
const ffprobe = process.env.TEST_FFPROBE || path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
test('multiple ranges merge, random sampling is bounded, malformed times fail', () => {
    assert.equal(timestamp('01:02:03.125'), 3723.125); assert.throws(() => timestamp('0:99'), /MEDIA_TIME_INVALID/);
    assert.deepEqual(ranges('1-3,2-4,5-6', 10), [[1, 4], [5, 6]]);
    assert.throws(() => ranges('4-1', 10), /MEDIA_RANGE_INVALID/);
    const times = sampleTimes({ mode: 'random', count: 24, ranges: '0-0.003' }, 2, () => 0); assert.equal(new Set(times).size, 3); assert.equal(times.length, 3);
    assert.deepEqual(sampleTimes({ mode: 'interval', intervalMs: 500, ranges: '1-3' }, 10), [1, 1.5, 2, 2.5]);
    assert.throws(() => sampleTimes({ mode: 'interval', intervalMs: 10 }, 10), /MEDIA_COUNT_LIMIT/);
    assert.equal(sectionDuration('*00:01:02.500-00:01:04'), 1.5); assert.equal(sectionDuration('*1-inf'), undefined);
});
test('validation rejects track tails and absent audio instead of accepting successful process exit', () => {
    assert.throws(() => validateMedia({ streams: [{ codec_type: 'video', duration: '5', avg_frame_rate: '25/1' }, { codec_type: 'audio', duration: '10' }] }, { audio: true }), /MEDIA_AV_TIMELINE_MISMATCH/);
    assert.throws(() => validateMedia({ streams: [{ codec_type: 'video', duration: '5' }] }, { audio: true }), /MEDIA_OUTPUT_INVALID/);
});
test('real FFmpeg AVC, AV1/Opus and HEVC cuts, VFR neighbors and actual frame timestamps', { timeout: 120000 }, async t => {
    try { await execute(ffmpeg, ['-version']); } catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg is not installed'); return; } throw error; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr2t-media-processing-')); t.after(() => { if (!dir.startsWith(path.join(os.tmpdir(), 'dr2t-media-processing-'))) throw Error('unsafe cleanup'); fs.rmSync(dir, { recursive: true, force: true }); });
    const engine = createMediaProcessing({ ffmpeg, ffprobe });
    let lastCutError; const cut = engine.cut; engine.cut = async (...args) => { try { return await cut(...args); } catch (error) { lastCutError = error; throw error; } };
    const encoders = (await execute(ffmpeg, ['-encoders'])).stdout.toString();
    for (const [encoder, audio] of [['libx264', 'aac'], ['libaom-av1', 'libopus'], ['libx265', 'aac']]) {
        if (!encoders.includes(encoder) || !encoders.includes(audio)) { t.diagnostic(encoder + '/' + audio + ' unavailable'); continue; }
        const input = path.join(dir, encoder + '.mkv'), output = path.join(dir, encoder + '-cut.mp4');
        await execute(ffmpeg, ['-v', 'error', '-threads', '1', '-filter_threads', '1', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
            '-vf', "select='not(mod(n,2))+not(mod(n,5))'", '-fps_mode', 'vfr', '-c:v', encoder, ...(encoder === 'libaom-av1' ? ['-cpu-used', '8'] : encoder === 'libx265' ? ['-x265-params', 'pools=1:frame-threads=1'] : ['-preset', 'ultrafast']), '-c:a', audio, '-output_ts_offset', '2', '-y', input]);
        const probe = await engine.probe(input), frame = await engine.frame(input, .37, path.join(dir, encoder + '.jpg'), probe);
        assert.ok(Math.abs(durationOf(probe) - 3) < .08, 'timeline origin must not inflate source duration: ' + JSON.stringify(probe.format));
        const neighbors = await engine.frameNeighbors(input, .37, probe);
        assert.ok(neighbors.some(n => Math.abs(n * 1000 - frame.actualMs) < 2), `${encoder}: actual frame ${frame.actualMs} not in actual PTS list ${neighbors}`);
        assert.notEqual(frame.actualMs, frame.requestedMs); assert.ok(frame.actualMs >= 370 && frame.actualMs < 650, encoder + ': seeking wrong timeline');
        const result = await engine.cut(input, .37, 1.81, output, { audio: true, precise: true, sourceProbe: probe });
        assert.ok(Math.abs(result.duration - 1.44) <= result.tolerance, `${encoder}: wrong output duration ${result.duration}`);
        await verifyDownloadedSection(output, '*0-1.44', { ffmpeg, ffprobe });
        const silent = await engine.cut(input, .4, 1.6, path.join(dir, encoder + '-silent.mp4'), { audio: false, sourceProbe: probe }); assert.equal(silent.streams.length, 1);
        if (encoder === 'libx264') {
            const bad = path.join(dir, 'mismatched-matroska.mkv');
            await execute(ffmpeg, ['-v', 'error', '-i', input, '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'pcm_s16le', '-y', bad]);
            await assert.rejects(verifyDownloadedSection(bad, '*0-6', { ffmpeg, ffprobe }), /MEDIA_AV_TIMELINE_MISMATCH/);
            const f = require('./support/media-library-fixture.cjs').createFixture({ processing: engine });
            try { const ref = f.put(fs.readFileSync(input), { name: 'sample.mkv' }), source = f.service.createImport({ kind: 'disk', ...ref }, { id: 'alice' });
                await f.service.pump(); const session = f.service.createSession(source.id, 'Real integrated FFmpeg');
                const job = f.service.clip(session.id, { start: .37, end: 1.81 }); await f.service.pump();
                assert.equal(f.service.get('job', job.id).state, 'completed', String(lastCutError?.stack || JSON.stringify(f.service.get('job', job.id))));
            } finally { await f.close(); }
        }
    }
});
