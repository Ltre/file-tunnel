'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { createAudioTrackRepair, registerAudioTrackRepairRoutes, repairPlan, createProgressReader } = require('../server/audio-track-repair');
const mediaProbe = { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }, { index: 1, codec_type: 'audio', codec_name: 'aac' }] };
function setup(t, dependencies = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-track-repair-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = { path: path.join(directory, 'original.mp4'), name: '原文件.mp4' };
    fs.writeFileSync(file.path, 'original');
    let count = 0;
    const repair = createAudioTrackRepair({ probe: async () => mediaProbe, run: async args => { count++; fs.writeFileSync(args.at(-1), 'corrected'); }, ...dependencies });
    return { directory, file, repair, count: () => count };
}
test('修正版另存、重启后复用；勾选重新修正和原文件变化才再次生成', async t => {
    const { directory, file, repair, count } = setup(t);
    const first = await repair.prepare(file, directory);
    assert.notEqual(first.path, file.path); assert.equal(first.reused, false);
    assert.equal(fs.readFileSync(file.path, 'utf8'), 'original');
    assert.equal((await repair.prepare(file, directory)).reused, true); assert.equal(count(), 1);
    const restarted = createAudioTrackRepair({ probe: () => { throw Error('must reuse'); }, run: () => { throw Error('must reuse'); } });
    assert.equal((await restarted.prepare(file, directory)).path, first.path);
    const second = await repair.prepare(file, directory, { force: true });
    assert.equal(count(), 2); assert.notEqual(second.path, first.path); assert.equal(fs.existsSync(first.path), false);
    fs.appendFileSync(file.path, '-changed');
    assert.equal(repair.cached(file, directory), null);
    assert.equal((await repair.prepare(file, directory)).reused, false); assert.equal(count(), 3);
    assert.equal(fs.existsSync(second.path), false);
});
test('同一任务并发请求共享修正过程，失败重修保留原版及已有修正版', async t => {
    let calls = 0;
    const fixture = setup(t, { run: async args => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); if (calls > 1) throw Error('ffmpeg-failed'); fs.writeFileSync(args.at(-1), 'corrected'); } });
    const results = await Promise.all([fixture.repair.prepare(fixture.file, fixture.directory), fixture.repair.prepare(fixture.file, fixture.directory)]);
    assert.equal(calls, 1); assert.equal(results[0].path, results[1].path);
    await assert.rejects(fixture.repair.prepare(fixture.file, fixture.directory, { force: true }), /ffmpeg-failed/);
    assert.equal(fixture.repair.cached(fixture.file, fixture.directory).path, results[0].path);
    assert.equal(fs.readFileSync(fixture.file.path, 'utf8'), 'original');
    assert.equal(fs.readdirSync(path.dirname(results[0].path)).length, 2);
});
test('旧版复制视频的修正版缓存失效，重新编码成功后替换旧修正版并保留原版', async t => {
    const { directory, file, repair, count } = setup(t);
    const previous = await repair.prepare(file, directory);
    const manifestPath = path.join(directory, 'audio-track-repair', 'current.json');
    const record = JSON.parse(fs.readFileSync(manifestPath)), stat = fs.statSync(file.path);
    record.fingerprint = require('node:crypto').createHash('sha256').update(JSON.stringify([1, file.path, stat.size, stat.mtimeMs])).digest('hex');
    fs.writeFileSync(manifestPath, JSON.stringify(record));
    assert.equal(repair.cached(file, directory), null);
    const next = await repair.prepare(file, directory);
    assert.equal(next.reused, false); assert.notEqual(next.path, previous.path); assert.equal(count(), 2);
    assert.equal(fs.existsSync(previous.path), false); assert.equal(fs.readFileSync(file.path, 'utf8'), 'original');
});
test('offset 修正版使用普通 ffmpeg 重新编码完整音视频，输出 MP4，无音轨拒绝', () => {
    const plan = repairPlan(mediaProbe, 'input.mp4', 'output');
    assert.equal(plan.extension, '.mp4');
    assert.deepEqual(plan.args, ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'input.mp4', '-progress', 'pipe:2', '-nostats', 'output.mp4']);
    assert.throws(() => repairPlan({ streams: [mediaProbe.streams[0]] }, 'i', 'o'), /no-audio/);
    assert.equal(repairPlan({ streams: [{ ...mediaProbe.streams[0], codec_name: 'vp9' }, mediaProbe.streams[1]] }, 'i', 'o').extension, '.mp4');
    assert.equal(repairPlan({ streams: [mediaProbe.streams[1]] }, 'i', 'o').extension, '.m4a');
});
test('ffmpeg 进度输出转换为可轮询的百分比、时间、速度和帧数', () => {
    const updates = [], read = createProgressReader(20, update => updates.push(update));
    read('frame=12\nout_time_us=5000000\nspeed=1.5x\nprogress=continue\n');
    assert.deepEqual(updates.at(-1), {
        durationSeconds:20, outTimeSeconds:5, speed:'1.5x', frame:12, progress:25
    });
    read('out_time_ms=18000000\nprogress=continue\n');
    assert.equal(updates.at(-1).progress, 90);
    assert.equal(updates.at(-1).outTimeSeconds, 18);
});
test('两个后台的准备和下载接口均需管理身份，拒绝未完成及无有效缓存任务', async t => {
    const express = require('express'), fixture = setup(t), app = express(); app.use(express.json());
    let ready = true;
    const service = { get: () => ({ status: ready ? 'completed' : 'downloading' }), getFile: () => fixture.file, getTaskDirectory: () => fixture.directory };
    for (const root of ['/api/sns-dl', '/api/youtube-premium']) registerAudioTrackRepairRoutes(app, {
        root, service, repair: fixture.repair, requireAuth: (req, res, next) => req.headers['x-test-auth'] === '1' ? next() : res.sendStatus(401), sanitizeError: error => error.message
    });
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const root of ['/api/sns-dl', '/api/youtube-premium']) {
        const url = base + root + '/tasks/test/audio-repair';
        assert.equal((await fetch(url, { method: 'POST' })).status, 401);
        assert.equal((await fetch(url + '/file')).status, 401);
        const options = { method: 'POST', headers: { 'x-test-auth': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ force:true }) };
        ready = false; assert.equal((await fetch(url, options)).status, 400); ready = true;
        const response = await fetch(url, options); assert.equal(response.status, 202);
        const submitted = await response.json();
        assert.equal(submitted.status, 'queued'); assert.match(submitted.jobId, /^[0-9a-f-]+$/);
        let data = submitted;
        for (let attempt = 0; attempt < 20 && data.status !== 'completed'; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 5));
            const statusResponse = await fetch(base + submitted.statusUrl, { headers: { 'x-test-auth': '1' } });
            assert.equal(statusResponse.status, 200); data = await statusResponse.json();
        }
        assert.equal(data.status, 'completed');
        const download = await fetch(base + data.downloadUrl, { headers: { 'x-test-auth': '1' } });
        assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/);
        assert.equal(await download.text(), 'corrected');
    }
});
test('实际修正版与 ffmpeg -i INPUT.mp4 OUTPUT.mp4 输出一致，保留视频音频和原版', async t => {
    const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg', ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
    if (spawnSync(ffmpeg, ['-version']).status !== 0 || spawnSync(ffprobe, ['-version']).status !== 0) return t.skip('ffmpeg/ffprobe 未安装');
    const fixture = setup(t);
    const invoke = args => execFileSync(ffmpeg, args, { timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    invoke(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=2', '-itsoffset', '0.35', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=1.6', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-c:a', 'aac', fixture.file.path]);
    const original = fs.readFileSync(fixture.file.path);
    const probe = async file => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 30000, windowsHide: true }));
    const repair = createAudioTrackRepair({ probe, run: async args => invoke(args) });
    const baseline = path.join(fixture.directory, 'baseline.mp4');
    invoke(['-y', '-i', fixture.file.path, baseline]);
    const result = await repair.prepare(fixture.file, fixture.directory), corrected = await probe(result.path);
    assert.deepEqual(corrected.streams.map(stream => stream.codec_type), ['video', 'audio']);
    assert.deepEqual(fs.readFileSync(result.path), fs.readFileSync(baseline));
    assert.deepEqual(fs.readFileSync(fixture.file.path), original);
});
