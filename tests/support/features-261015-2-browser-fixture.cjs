'use strict';
// Actual drive cookies/UI and media UI; temporary data and synthetic video only.
const fs = require('node:fs'), path = require('node:path');
const { createFixture: createDisk } = require('./pending-save-261012-fixture.cjs');
const { createFixture: createMedia } = require('./media-library-fixture.cjs');
const { createMediaRoutes } = require('../../server/media-library/routes');
const { createMediaProcessing, execute } = require('../../server/media-library/processing');
let disk, media;
(async () => {
    disk = await createDisk(); const root = path.resolve(__dirname, '../..');
    const ffmpeg = process.env.TEST_FFMPEG || 'D:/GreenApps/ffmpeg/5.1.2/bin/ffmpeg.exe';
    media = createMedia({ processing: createMediaProcessing({ ffmpeg, ffprobe: path.join(path.dirname(ffmpeg), 'ffprobe.exe') }) });
    const input = path.join(media.dataDir, 'fixture.mp4');
    await execute(ffmpeg, ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=25:duration=4','-c:v','libx264','-y',input]);
    const s = media.service, resource = s.createImport({ kind: 'disk', ...media.put(fs.readFileSync(input), { name: '浏览器验收.mp4' }) }, { id: 'alice' }); await s.pump();
    const session = s.createSession(resource.id, '紧凑 Clip 列表验收');
    for (const start of [0,1,2]) { s.clip(session.id, { start, end: start + 1 }); await s.pump(); }
    const clip = s.list('result')[0]; s.transcode(clip.id, { width: 160, height: 90, crf: 28, preset: 'ultrafast' }); await s.pump();
    const originalWrite = media.disk.write;
    media.disk.write = async (...args) => {
        for (const percent of [5,25,55,80,99]) {
            args[6]?.({ percent, phase: 'upload', detail: '隔离模拟：正在提交正文到网盘', totalBytes: 10000, telegramBytesSent: percent * 100, telegramBytesConfirmed: Math.max(0, percent - 15) * 100 });
            await new Promise(resolve => setTimeout(resolve, 1300));
        }
        return originalWrite(...args);
    };
    disk.app.get('/media-library', (_req,res) => res.sendFile(path.join(root,'pages/media-library.html')));
    disk.app.use('/api/media-library', createMediaRoutes({ service: s, disk: media.disk, downloads: media.downloads, identity: () => ({ id: 'alice' }), requireAuth: (_req,_res,next) => next(), origin: req => 'http://' + req.get('Host') }));
    const file = disk.store.adminFiles().find(value => value.ownerId === 'alice');
    console.log(JSON.stringify({ media: disk.base + '/media-library', disk: disk.base + '/disk?' + new URLSearchParams({ disk_account: 'alice', disk_space: '', disk_path: '甲目录', disk_file: file.id }) + '#fixture-tunnel', dataDirs: [disk.dataDir,media.dataDir] }));
    const timer = setInterval(() => s.pump(), 500);
    process.once('SIGINT', async () => { clearInterval(timer); await media.close(); await disk.close(); process.exit(); });
})().catch(async error => { console.error(error); await media?.close(); await disk?.close(); process.exit(1); });
