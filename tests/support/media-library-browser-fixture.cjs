'use strict';
const path = require('node:path'), fs = require('node:fs'), express = require('express');
const { createFixture } = require('./media-library-fixture.cjs'), { createMediaRoutes } = require('../../server/media-library/routes'), { createMediaProcessing, execute } = require('../../server/media-library/processing');
(async () => {
    const ffmpeg = process.env.TEST_FFMPEG || 'D:/GreenApps/ffmpeg/5.1.2/bin/ffmpeg.exe', ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe.exe');
    const engine = createMediaProcessing({ ffmpeg, ffprobe }), f = createFixture({ processing: engine }), root = path.resolve(__dirname, '../..');
    const video = path.join(f.dataDir, 'sample.mp4'); await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-y', video]);
    const reference = f.put(fs.readFileSync(video), { name: '可变片段测试.mp4', path: 'work', type: 'video/mp4' });
    const imported = f.service.createImport({ kind: 'disk', ...reference }, { id: 'alice' }); await f.service.pump(); const session = f.service.createSession(imported.id, '画面与 Clip 测试');
    if (process.env.TEST_FRAME_SCENARIOS === '1') {
        for (const [name, filters, origin] of [['非零原点与 B 帧', [], '2'], ['可变帧率与长 GOP', ['-vf', "select='not(mod(n,2))+not(mod(n,5))'", '-fps_mode', 'vfr'], '0']]) {
            const target = path.join(f.dataDir, origin + '-scenario.mp4');
            await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=20', ...filters,
                '-c:v', 'libx264', '-preset', 'fast', '-g', '500', '-keyint_min', '500', '-sc_threshold', '0', '-output_ts_offset', origin, '-y', target]);
            const source = f.service.createImport({ kind: 'disk', ...f.put(fs.readFileSync(target), { name, type: 'video/mp4' }) }, { id: 'alice' });
            await f.service.pump(); f.service.createSession(source.id, name);
        }
    }
    f.service.extract(session.id, { mode: 'interval', ranges: '0-2', intervalMs: 500 }); await f.service.pump();
    const person = f.service.entity({ entityKind: 'person', name: '测试人物', aliases: ['テスト'] }), org = f.service.entity({ entityKind: 'organization', name: '测试组织' });
    f.service.relate({ personId: person.id, organizationId: org.id, from: '2025-01-01' });
    const collection = f.service.collect(f.service.list('result')[0].id); await f.service.pump(); f.service.associate(collection.id, [person.id, org.id]);
    if(process.env.TEST_FEATURE_261017_4==='1'){
        f.service.extract(session.id,{mode:'random',count:24});await f.service.pump();
        for(const start of [0,1,2]){f.service.clip(session.id,{start,end:start+1});await f.service.pump();}
        f.service.removeResult(f.service.list('result').find(result=>result.kind==='clip').id);
    }
    const app = express(), requireAuth = (req, res, next) => (req.headers.cookie || '').includes('fixture_media=1') ? next() : res.status(401).json({ error: 'AUTH_REQUIRED' });
    app.use(express.json()); app.get('/fixture-login', (req, res) => res.cookie('fixture_media', '1', { httpOnly: true }).redirect('/media-library'));
    app.get('/media-library', requireAuth, (req, res) => res.sendFile(path.join(root, 'pages/media-library.html')));
    app.get('/api/media-library/help', requireAuth, (req, res) => res.type('text/markdown').sendFile(path.join(root, 'docs/media-library.md')));
    app.use('/api/media-library', createMediaRoutes({ service: f.service, disk: f.disk, downloads: f.downloads, identity: () => ({ id: 'alice', name: '测试用户' }), requireAuth, origin: req => `http://${req.get('Host')}` }));
    app.get('/api/telegram/drive/accounts', requireAuth, (req, res) => res.json({ accounts: [{ identity: { id: 'alice', name: '测试用户' } }] }));
    app.get('/api/telegram/drive/list', requireAuth, (req, res) => res.json({ files: [...f.files.values()].map(x => ({ ...x.ref, id: x.ref.fileId })) }));
    app.use('/client', express.static(path.join(root, 'client')));
    const server = app.listen(Number(process.env.TEST_FIXTURE_PORT) || 0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/fixture-login`, isolatedDataDir: f.dataDir }));
    const timer = setInterval(() => f.service.pump(), 500);
    const close = async () => { clearInterval(timer); server.closeAllConnections(); await new Promise(r => server.close(r)); await f.close(); process.exit(); };
    process.on('SIGINT', close); process.on('SIGTERM', close);
})().catch(error => { console.error(error); process.exit(1); });
