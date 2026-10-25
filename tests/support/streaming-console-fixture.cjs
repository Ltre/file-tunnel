'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createFixture: driveFixture } = require('./pending-save-261012-fixture.cjs');
const { createStreamingDisk } = require('../../server/streaming-disk');
const { createStreamingSources } = require('../../server/streaming-sources');
const { createStreamingTunnels } = require('../../server/streaming-tunnels');
const { registerStreamingConsole } = require('../../server/streaming-http');
const { createDiskPartitions } = require('../../server/disk-partitions');
async function createFixture({ media = false } = {}) {
    const f = await driveFixture(), root = path.resolve(__dirname, '../..');
    const records = [ { id: 'image-record', type: 'file', fileInfo: { id: 'image-asset', name: '隧道图片.png', type: 'image/png',
        size: 68, data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVioAAAAASUVORK5CYII=' } },
        { id: 'text-record', type: 'text', text: '隧道正文\n这是一个独立静态节目。' } ];
    const session = { devices: new Map([['device-A', {}], ['device-B', {}]]), fileAssets: new Map() };
    const tunnel = createStreamingTunnels({ session: () => session, messages: () => records,
        admitted: (s, _d, grant) => s === 'fixture-tunnel' && grant === 'fixture-proof', capability: () => true,
        publish: (_s, _session, message) => records.push(message) });
    const disk = createStreamingDisk({ objects: f.api.objectStorage, identity: req => f.sessions.identity(req),
        partitions: createDiskPartitions({ dataDir: f.dataDir, spaces: f.api.spaces }) });
    const sources = createStreamingSources({ disk, tunnel });
    const streaming = registerStreamingConsole(f.app, { dataDir: f.dataDir, identity: req => f.sessions.identity(req), proofs: req => f.sessions.proofs(req),
        user: id => f.auth.user(id), loginRevoked: hash => f.repository.content.sessionRevoked(hash),
        origin: req => req.protocol + '://' + req.get('host'), visibleDevices: () => ['device-A', 'device-B'], sources, tunnel });
    tunnel.bind(streaming.service);
    const fixtureOwner = { deviceId: 'fixture-inviter', userId: null, logins: [] };
    streaming.service.register(fixtureOwner.deviceId, 'fixture-inviter-key'.repeat(3), '隔离邀请设备');
    const invitedStation = streaming.service.create(fixtureOwner, { name: '原地邀请验收台', creationId: 'fixture-invite-station' });
    await streaming.service.edit(invitedStation.id, fixtureOwner, { configVersion: invitedStation.configVersion, loop: true, countdown: 'edge',
        items: [{ id: 'fixture-invite-image', stay: 10, source: { kind: 'tunnel', sessionId: 'fixture-tunnel', messageId: 'image-record', fileId: 'image-asset', accessGrant: 'fixture-proof' } }] });
    streaming.service.visibility(invitedStation.id, fixtureOwner, { visibility: 'public', version: streaming.service.station(invitedStation.id).playback.version });
    const fixtureInvite = streaming.service.invitation(invitedStation.id, fixtureOwner, {});
    records.push({ id: 'fixture-newlines', type: 'markdown', markdown: '第一行\n第二行\n第三行', timestamp: Date.now(), sender: 'device-A', sessionId: 'fixture-tunnel' });
    records.push({ id: 'fixture-picture', type: 'markdown', markdown: '# 引用图片验收\n\n![隧道图片](tunnel-blob:fixture-tunnel/image-record/image-asset)', timestamp: Date.now(), sender: 'device-A', sessionId: 'fixture-tunnel' });
    f.app.post('/fixture-markdown-edit/:id', require('express').json(), (req, res) => {
        const index = records.findIndex(item => item.id === req.params.id);
        if (index < 0) return res.status(404).json({ ok: false });
        const result = require('../../server/markdown-records').editMarkdownRecord(records[index], { ...req.body, deviceId: 'markdown-browser-device', deviceName: 'Markdown 验收设备', maxBytes: 200000 });
        if (result.ok) records[index] = result.message; res.json(result);
    });
    f.app.get('/fixture-account/:id', (req, res) => { f.sessions.set(req, res, f.auth.user(req.params.id)); res.redirect('/console'); });
    f.app.post('/fixture-logout/:id', (req, res) => { f.sessions.remove(req, res, req.params.id, request => f.api.revokeContentSession(request)); res.json({ ok: true }); });
    f.app.get('/api/stream-fixture', (_req, res) => res.json({ records }));
    // Targeted UI harness: real Markdown/console adapters with an explicit,
    // isolated tunnel grant. It never joins a production tunnel or reads data.
    f.app.get('/markdown-check', (req, res) => res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/client/streaming-console.css"></head><body><button id="sendMarkdownBtn">编写 Markdown 消息</button><label>原页面未保存输入<input id="fixture-preserved-input" value="仍在编辑"></label><div id="fixture-rich" contenteditable="true"><h2>转换标题</h2><p>原始<strong>加粗</strong><br>第二行</p><ul><li>列表项</li></ul></div><button id="fixture-convert">转换副本并发送 Markdown</button><div id="records"></div><p id="fixture-status"></p>
        <script src="/client/vendor/web-markdown/marked-18.0.14.umd.js"></script><script src="/client/vendor/web-markdown/purify-3.4.16.min.js"></script>
        <script src="/client/folder-archive.js"></script><script src="/client/tunnel-markdown.js"></script><script src="/client/streaming-player.js"></script><script src="/client/streaming-console.js"></script><script src="/client/streaming-app-adapter.js"></script>
        <script>const fixtureDevice='markdown-browser-device';localStorage.setItem('deviceId',fixtureDevice);
        window.DiskClient={getAccount:()=>''};
        const fixtureRequest=StreamingConsole.request;StreamingConsole.request=async(...args)=>{if(args[0]==='/blob-preview'&&${req.query.delay === '1'})await new Promise(resolve=>setTimeout(resolve,3000));return fixtureRequest(...args);};
        StreamingConsole.init(StreamingAppAdapter.create({state:{deviceId:fixtureDevice,deviceName:'Markdown 验收设备',sessionId:'fixture-tunnel',devices:new Map(),contacts:new Map()},
            listSessions:async()=>[{sessionId:'fixture-tunnel',shortCode:'ABCDE',remark:'隔离隧道'}],authorization:()=>({grant:'fixture-proof',deviceId:fixtureDevice}),home:()=>{},toast:text=>document.getElementById('fixture-status').textContent=text,
            message:async id=>(await (await fetch('/api/stream-fixture')).json()).records.find(item=>item.id===id),
            editMarkdown:async(message,content,baseVersion)=>{const result=await (await fetch('/fixture-markdown-edit/'+message.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content,baseVersion})})).json();if(result.ok)renderFixtureMarkdown(result.message);return result;},
            receiveMessage:renderFixtureMarkdown}));
        function renderFixtureMarkdown(message){const article=document.getElementById('record-'+message.id)||document.createElement('article');article.id='record-'+message.id;article.replaceChildren();document.getElementById('records').append(article);TunnelMarkdown.mount(article,message);const trigger=document.createElement('button');trigger.textContent='☰';trigger.setAttribute('aria-label','记录操作');const menu=document.createElement('div');menu.hidden=true;menu.append(...TunnelMarkdown.menuActions(message));for(const [title,create] of [["创建串流台",true],["添加到串流台",false]]){const action=document.createElement("button");action.textContent=title;action.onclick=()=>StreamingConsole.importRecord(message,create);menu.append(action);}trigger.onclick=()=>menu.hidden=!menu.hidden;article.append(trigger,menu);article.onclick=event=>{if(!event.target.closest('button,a,input'))TunnelMarkdown.preview(message);};}
        for(const message of [${JSON.stringify(records.find(item => item.id === 'fixture-newlines'))},${JSON.stringify(records.find(item => item.id === 'fixture-picture'))},{id:'fixture-link',type:'markdown',purpose:'stream-invitation',markdown:'[打开邀请](/?stream_invite=${fixtureInvite.token})'}])renderFixtureMarkdown(message);
        document.getElementById('fixture-convert').onclick=async()=>{const editor=document.getElementById('fixture-rich'),before=editor.innerHTML;await StreamingConsole.sendMarkdown(TunnelMarkdown.fromHtml(before,'fixture-tunnel'));document.getElementById('fixture-status').textContent=editor.innerHTML===before?'原富文本未改变':'原富文本被改变';};
        </script></body></html>`));
    const png = Buffer.from(records[0].fileInfo.data.split(',')[1], 'base64'); records[0].fileInfo.size = png.length;
    const sourceFiles = [ { name: '网盘图片.png', type: 'image/png', body: png }, { name: '说明.txt', type: 'text/plain', body: Buffer.from('网盘文件放送\n离线续播测试。') },
        { name: '说明.md', type: 'text/markdown', body: Buffer.from('# Markdown 节目\n\n![隧道图片](tunnel-blob:fixture-tunnel/image-record/image-asset)\n\n<script>alert("unsafe")</script>') } ];
    if (media) {
        const { execute } = require('../../server/media-library/processing');
        const ffmpeg = process.env.TEST_FFMPEG || 'D:/GreenApps/ffmpeg/5.1.2/bin/ffmpeg.exe', file = path.join(f.dataDir, 'synthetic.mp4');
        await execute(ffmpeg, ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=25:duration=6','-f','lavfi','-i','sine=frequency=440:duration=6','-c:v','libx264','-c:a','aac','-y',file]);
        sourceFiles.push({ name: '合成视频.mp4', type: 'video/mp4', body: fs.readFileSync(file) });
        const audio = path.join(f.dataDir, 'synthetic.wav');
        await execute(ffmpeg, ['-v','error','-f','lavfi','-i','sine=frequency=660:duration=5','-y',audio]);
        sourceFiles.push({ name: '合成音频.wav', type: 'audio/wav', body: fs.readFileSync(audio) });
    }
    for (const source of sourceFiles) await f.api.objectStorage.put({ userId: 'alice', diskSpace: '' }, source.name,
        Readable.from([source.body]), { size: source.body.length, contentType: source.type });
    f.app.get('/runtime-config.js', (_req, res) => res.type('js').send('window.TUNNEL_CONFIG={};'));
    f.app.get('/app.js', (_req, res) => res.sendFile(path.join(root, 'app.js')));
    f.app.get('/socket.io/socket.io.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/socket.io/client-dist/socket.io.js')));
    f.app.get('/service-worker.js', (_req, res) => res.status(404).end());
    f.app.get('/streaming-layout-check', (_req, res) => {
        const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
        const controls = appSource.slice(appSource.indexOf('function normalizeControlCenterOrder('), appSource.indexOf('function showTunnelRemarkDialog('));
        const html = fs.readFileSync(path.join(root, 'pages/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
        res.type('html').send(html.replace('</body>', `<div id="markdown-layout"></div><script src="/client/vendor/web-markdown/marked-18.0.14.umd.js"></script><script src="/client/vendor/web-markdown/purify-3.4.16.min.js"></script>
            <script src="/client/tunnel-markdown.js"></script><script src="/client/streaming-console.js"></script><script src="/client/streaming-player.js"></script>
            <script>const state={sessionId:'fixture-tunnel'},getAllFromStore=async()=>[{sessionId:'fixture-tunnel',shortCode:'ABCDE',remark:'隔离隧道'}],escapeHtml=String,normalizeLocalShortCode=String,historyLog=()=>{},hasActiveTransferTasks=()=>false;
            ${controls}
            document.getElementById('tunnelStartupLoading').hidden=true;document.getElementById('appShell').hidden=false;document.getElementById('sessionLanding').hidden=true;document.getElementById('connectionHeaderMenu').hidden=true;
            document.querySelector('.mobile-workspace-button[data-mobile-view="chat"]').onclick=()=>showJoinedSessionSwitcher();
            StreamingConsole.init({deviceId:()=> 'layout-fixture-device',deviceName:()=> '布局验收',devices:()=>[],tunnels:async()=>[],toast:()=>{},home:()=>{}});
            for(const n of [10,11]){const row=document.createElement('article');row.dataset.lines=n;document.getElementById('markdown-layout').append(row);TunnelMarkdown.mount(row,{id:'lines-'+n,type:'markdown',markdown:Array.from({length:n},(_,i)=>'第 '+(i+1)+' 行').join('\\n')});}
            </script></body>`));
    });
    f.app.get('/mobile-check', (_req, res) => res.type('html').send('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#ddd"><iframe title="390像素串流布局验收" src="/fixture-account/alice" style="width:390px;height:844px;border:0;background:white"></iframe></body></html>'));
    f.app.get('/fixture-bootstrap.js', (_req, res) => res.type('js').send(`
        window.__fixtureErrors=[];window.addEventListener('error',event=>window.__fixtureErrors.push(event.message));
        window.addEventListener('unhandledrejection',event=>window.__fixtureErrors.push(String(event.reason)));
        const samples=${JSON.stringify(sourceFiles.filter(file => !file.name.endsWith('.md')).map(file => ({ name: '本机-' + file.name, type: file.type, base64: file.body.toString('base64') })))};
        window.showOpenFilePicker=async()=>samples.map(sample=>({queryPermission:async()=> 'granted',getFile:async()=>new File([Uint8Array.from(atob(sample.base64),c=>c.charCodeAt(0))],sample.name,{type:sample.type})}));
        document.addEventListener('DOMContentLoaded',()=>{const launch=document.createElement('button');launch.id='fixture-open-console';launch.textContent='打开隔离串流验收';launch.style='position:fixed;bottom:10px;left:10px;z-index:17999';launch.onclick=()=>StreamingConsole.open();document.body.append(launch);});
    `));
    f.app.get(['/console', '/'], (_req, res) => res.type('html').send(fs.readFileSync(path.join(root, 'pages/index.html'), 'utf8')
        .replace('<head>', '<head><script src="/fixture-bootstrap.js"></script>')));
    return { ...f, sources, streaming, records, sourceFiles,
        async close() { streaming.close(); await f.close(); } };
}
module.exports = { createFixture };
if (require.main === module) createFixture({ media: true }).then(f => {
    console.log(JSON.stringify({ base: f.base, dataDir: f.dataDir, browser: f.base + '/console?stream=fixture-unused' }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => f.close().then(() => process.exit()));
}).catch(error => { console.error(error); process.exit(1); });
