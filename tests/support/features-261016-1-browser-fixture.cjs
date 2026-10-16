'use strict';
// Isolated local browser acceptance: synthetic video and temporary media data.
const express = require('express'), fs = require('node:fs'), path = require('node:path');
const { createFixture } = require('./media-library-fixture.cjs');
const { createMediaRoutes } = require('../../server/media-library/routes');
const { createMediaProcessing, execute } = require('../../server/media-library/processing');
let fixture, server;
(async () => {
    const root = path.resolve(__dirname, '../..'), ffmpeg = process.env.TEST_FFMPEG || 'D:/GreenApps/ffmpeg/5.1.2/bin/ffmpeg.exe';
    const engine = createMediaProcessing({ ffmpeg, ffprobe: path.join(path.dirname(ffmpeg), 'ffprobe.exe') });
    const compress = engine.compress, frame = engine.frame;
    engine.compress = async (...args) => { await new Promise(resolve => setTimeout(resolve, 5000)); return compress(...args); };
    engine.frame = async (...args) => { await new Promise(resolve => setTimeout(resolve, 350)); return frame(...args); };
    fixture = createFixture({ processing: engine }); const s = fixture.service;
    const input = path.join(fixture.dataDir, 'source.mp4');
    await execute(ffmpeg, ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=25:duration=4','-c:v','libx264','-y',input]);
    const source = s.createImport({ kind: 'disk', ...fixture.put(fs.readFileSync(input), { name: '截图与压缩验收.mp4' }) }, { id: 'alice' }); await s.pump();
    const session = s.createSession(source.id, '截图批次与压缩版本验收');
    for (const ranges of ['2-3','0-1']) { s.extract(session.id, { mode: 'interval', ranges, intervalMs: 500 }); await s.pump(); }
    const clip = s.clip(session.id, { start: 0, end: 2 }); await s.pump(); s.transcode(clip.id, { width: 160, height: 90, crf: 28, preset: 'ultrafast' }); await s.pump();
    const app = express(); app.use(express.json()); app.get('/media-library', (_req,res) => res.sendFile(path.join(root,'pages/media-library.html')));
    app.use('/api/media-library', createMediaRoutes({ service: s, disk: fixture.disk, downloads: fixture.downloads, identity: () => ({ id: 'alice' }), requireAuth: (_req,_res,next) => next(), origin: req => 'http://' + req.get('Host') }));
    app.use('/client', express.static(path.join(root,'client')));
    server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
    console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port + '/media-library', dataDir: fixture.dataDir }));
    const timer = setInterval(() => s.pump(), 500);
    process.once('SIGINT', async () => { clearInterval(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fixture.close(); process.exit(); });
})().catch(async error => { console.error(error); server?.closeAllConnections(); server?.close(); await fixture?.close(); process.exit(1); });
