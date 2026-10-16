'use strict';
// UI-only fixture: actual page styles and components, synthetic forwarding history.
const express = require('express'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname,'../..'), app = express();
app.get('/history/:source', (req,res) => {
    const source = req.params.source === 'sns' ? 'sns-dl' : 'youtube-premium-dl';
    const page = fs.readFileSync(path.join(root,'pages',source+'.html'),'utf8'), style = page.match(/<style>[\s\S]*?<\/style>/)[0];
    res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${style}<link rel="stylesheet" href="/client/telegram-target-forward.css"><body><main class="page shell"><h1>${source} 历史目标布局验收</h1><div id="taskList"><article><div id="fixture-target"></div></article></div></main><script src="/client/telegram-target-forward.js"></script><script>document.getElementById('fixture-target').append(TelegramTargetForward.create({id:'fixture-task',status:'completed',hasFile:true},'/api/${source}',async url=>url.includes('/telegram-forward-targets')?{targets:Array.from({length:10},(_,i)=>({target:'@target_'+(i+1),remark:'测试目标 '+(i+1)}))}:{jobs:[]}));</script>`);
});
app.get('/workshop', (_req,res) => {
    let html = fs.readFileSync(path.join(root,'pages/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
    html = html.replace('</body>','<button id="fixture-workshop" style="position:fixed;top:15px;left:15px;z-index:30000">创建预览验收草稿</button>'+['/client/folder-archive.js','/client/web-zip-runtime.js','/client/web-workshop.js','/fixture-setup.js'].map(src=>`<script src="${src}"></script>`).join('')+'</body>');
    res.type('html').send(html);
});
app.get('/fixture-setup.js', (_req,res) => res.type('js').send(`document.getElementById('tunnelStartupLoading')?.remove();WebWorkshop.init({deviceId:()=> 'fixture',toast:console.log});document.getElementById('fixture-workshop').onclick=async event=>{event.target.disabled=true;try{await WebWorkshop.createDraft({name:'入口与当前文件区分验收',files:[{path:'index.html',type:'text/html',data:new TextEncoder().encode('<h1>ZIP 的默认入口</h1>')},{path:'说明/',type:'application/x-directory',data:new Uint8Array()}]});WebWorkshop.open();event.target.hidden=true;}finally{event.target.disabled=false;}};`));
app.get('/service-worker.js', (_req,res) => res.sendFile(path.join(root,'service-worker.js')));
app.use('/client',express.static(path.join(root,'client')));
app.get(['/','/index.html'], (_req,res) => res.send('<!doctype html><title>隔离预览验收</title>'));
app.get('/manifest.webmanifest', (_req,res) => res.sendFile(path.join(root,'manifest.webmanifest')));
app.get('/tunnel-icon.svg', (_req,res) => res.sendFile(path.join(root,'tunnel-icon.svg')));
const server = app.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({base:'http://127.0.0.1:'+server.address().port})));
process.once('SIGINT',()=>{server.closeAllConnections();server.close(()=>process.exit());});
