'use strict';
// Isolated browser fixture: no production data, credentials or Telegram calls.
const express = require('express'), path = require('node:path'), fs = require('node:fs');
const { createFixture } = require('./media-library-fixture.cjs');
const { createMediaRoutes } = require('../../server/media-library/routes');
const { createMediaProcessing, execute } = require('../../server/media-library/processing');
const { registerAdminLayout } = require('../../server/admin-layout');
const { createTelegramForwardJobs } = require('../../server/telegram-forward-jobs');
(async () => {
    const ffmpeg = process.env.TEST_FFMPEG || 'D:/GreenApps/ffmpeg/5.1.2/bin/ffmpeg.exe';
    const f = createFixture({ processing: createMediaProcessing({ ffmpeg, ffprobe: path.join(path.dirname(ffmpeg), 'ffprobe.exe') }) });
    const video = path.join(f.dataDir, 'source.mp4');
    await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=4', '-c:v', 'libx264', '-y', video]);
    const imported = f.service.createImport({ kind: 'disk', ...f.put(fs.readFileSync(video), { name: '隔离测试视频.mp4' }) }, { id: 'alice' });
    await f.service.pump(); f.service.createSession(imported.id, '工作片段进度验证');
    const app = express(), root = path.resolve(__dirname, '../..'); app.use(express.json());
    const requireAuth = (req, res, next) => (req.headers.cookie || '').includes('fixture_261014=1') ? next() : res.sendStatus(401);
    app.get('/fixture-login', (_req, res) => res.cookie('fixture_261014', '1', { httpOnly: true }).redirect('/admin'));
    registerAdminLayout(app, { root, requireAuth });
    app.get('/media-library', requireAuth, (_req, res) => res.sendFile(path.join(root, 'pages/media-library.html')));
    app.get('/sns-dl', requireAuth, (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/telegram-target-forward.css"><body style="font:15px system-ui;padding:24px;background:#eef4fa;color:#234"><h2>隔离测试 · 多目标转发</h2><button id="other-action" onclick="this.textContent='其它操作已响应'">其它操作</button><div id="task"></div><script src="/client/telegram-target-forward.js"></script><script>document.getElementById('task').append(TelegramTargetForward.create({id:'fixture',status:'completed'},'/api/sns-dl',async(url,options)=>{const r=await fetch(url,options);if(!r.ok)throw Error('请求失败');return r.json()}));</script>`));
    app.get('/api/telegram-forward-targets', requireAuth, (_req, res) => res.json({ targets: ['@first_fixture', '-100123'] }));
    const queue = createTelegramForwardJobs({ dataDir: f.dataDir, validate: (_source, _task, input) => ({ targets: input.targets, fingerprint: 'fixture' }),
        send: async (_source, _task, input) => { for (let index = 1; index <= 10; index++) { await new Promise(done => setTimeout(done, 650)); input.onProgress({ phase: 'upload', detail: '隔离模拟发送正文', progress: index * 9, sentBytes: index, totalBytes: 10 }); } return { messageId: 77 }; } });
    app.post('/api/sns-dl/tasks/:taskId/telegram-forward', requireAuth, (req, res) => res.status(202).json({ job: queue.create('sns', req.params.taskId, req.body) }));
    app.get('/api/telegram-forward-jobs', requireAuth, (req, res) => res.json({ jobs: queue.list(req.query.source, req.query.taskId) }));
    app.use('/api/media-library', createMediaRoutes({ service: f.service, disk: f.disk, downloads: f.downloads, identity: () => ({ id: 'alice' }), requireAuth, origin: req => 'http://' + req.get('Host') }));
    app.get('/api/admin/sessions', requireAuth, (_req, res) => res.json({ sessions: [] }));
    app.use('/client', express.static(path.join(root, 'client')));
    const server = app.listen(0, '127.0.0.1'); await new Promise(done => server.once('listening', done));
    console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port + '/fixture-login' }));
    const timer = setInterval(() => f.service.pump(), 500);
    const close = async () => { clearInterval(timer); queue.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); await f.close(); process.exit(); };
    process.on('SIGINT', close); process.on('SIGTERM', close);
})().catch(error => { console.error(error); process.exit(1); });
