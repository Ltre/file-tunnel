'use strict';
// Isolated UI proof: production pages and handlers, synthetic media and local credentials.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm'),express=require('express');
const {createTunnelAccess}=require('../../server/tunnel-access'),{createYoutubePremiumService,normalizeYtDlpFormats,validateFormatSelection}=require('../../server/youtube-premium');
const root=path.resolve(__dirname,'../..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'dr2t-ui-261019-')),app=express();app.use(express.json());
const source=()=>fs.readFileSync(path.join(root,'app.js'),'utf8'),slice=(text,start,end)=>text.slice(text.indexOf(start),text.indexOf(end,text.indexOf(start)));
const sessionId=crypto.randomUUID(),deviceId=crypto.randomUUID(),gate=createTunnelAccess(dataDir),grant=gate.issue(sessionId,deviceId),code='NEW51';
const formats=normalizeYtDlpFormats([{format_id:'137',ext:'mp4',height:1080,vcodec:'avc1',acodec:'none'},{format_id:'140',ext:'m4a',vcodec:'none',acodec:'mp4a',abr:128},{format_id:'248',ext:'webm',height:720,vcodec:'vp9',acodec:'none'}]);
let simulateLimit=false,limitUntil=0;
const service=createYoutubePremiumService({dataDir,analyze:async(_url,options)=>({title:'隔离媒体任务',mediaType:'video',selection:{...validateFormatSelection(formats,['137','140'],'video'),formatSelector:options.manualFormat||'137+140'}}),download:async({taskDir})=>{fs.mkdirSync(taskDir,{recursive:true});const outputPath=path.join(taskDir,'fixture.mp4');fs.writeFileSync(outputPath,'synthetic');return {outputPath,outputFileName:'fixture.mp4',outputFileSize:9};}});
app.get('/chat',(_req,res)=>{const html=fs.readFileSync(path.join(root,'pages/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>','<script src="/client/qrcode-1.0.0.min.js"></script><script src="/chat-fixture.js"></script></body>');res.type('html').send(html);});
app.get('/chat-fixture.js',(_req,res)=>res.type('js').send(`
const state={sessionId:${JSON.stringify(sessionId)},deviceId:${JSON.stringify(deviceId)},deviceName:'隔离设备'};
const savedTunnelGrant=()=>${JSON.stringify(grant)},historyLog=()=>{},requireTunnelPermission=()=>true,generateId=()=>crypto.randomUUID(),nextHistoryTimestamp=()=>Date.now();
function renderQRCodeFallback(container,text){container.textContent=text;}
async function publishHistoryMessage(message){const row=document.createElement('div');row.style.cssText='white-space:pre-wrap;margin:12px;padding:12px;background:#eef4ff;border-radius:12px';row.textContent=message.text;document.getElementById('chatMessages').append(row);}
${slice(source(),'let tunnelQRCodeRevision = 0;','// ==================== 光媒分享 / 接收')}
${slice(source(),'function updateTextInputHeight()','// ==================== 协同编辑')}
document.getElementById('tunnelStartupLoading')?.remove();document.getElementById('sessionLanding').hidden=true;document.getElementById('appShell').hidden=false;
const input=document.getElementById('textInput');input.addEventListener('input',updateTextInputHeight);input.addEventListener('keydown',handleTextInputKeydown);document.getElementById('sendTextBtn').onclick=sendText;window.addEventListener('resize',updateTextInputHeight);updateTextInputHeight();generateQRCode();
`));
app.post('/api/tunnel-join-links',(req,res)=>gate.verify(req.body.grant,req.body.sessionId,req.body.deviceId)?res.json({joinToken:gate.issueJoin(sessionId,code)}):res.sendStatus(403));
app.get('/premium',(_req,res)=>res.type('html').send(fs.readFileSync(path.join(root,'pages/youtube-premium-dl.html'),'utf8').replace('<head>','<head><script>localStorage.setItem("youtubePremiumCacheFiles","0")</script>').replace('</body>','<aside style="position:fixed;right:12px;bottom:12px;z-index:10000;padding:12px;background:#eaf2ff;border:1px solid #678"><label><input id="fixture-limit" type="checkbox">创建成功后模拟列表限流</label></aside><script>document.getElementById("fixture-limit").onchange=event=>fetch("/fixture-limit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:event.target.checked})})</script></body>')));
app.post('/fixture-limit',(req,res)=>{simulateLimit=req.body.enabled===true;res.json({ok:true});});
app.get('/api/youtube-premium/setup-status',(_req,res)=>res.json({youtubePremiumCookie:{configured:true},telegramBotToken:{configured:true},telegramSongShareChannels:{base:true,pro:true,ultimate:true}}));
app.post('/api/youtube-premium/formats',(_req,res)=>res.json({title:'隔离视频',mediaType:'video',formats,selection:validateFormatSelection(formats,['137','140'],'video')}));
app.get('/api/youtube-premium/tasks',(_req,res)=>Date.now()<limitUntil?res.status(429).json({error:'请求过于频繁，请稍后再试',code:'LOCAL_REQUEST_RATE_LIMIT',source:'server',retryAfterSeconds:5}):res.json(service.list(1,20)));
app.post('/api/youtube-premium/tasks',(req,res)=>{try{const task=service.create(req.body);if(simulateLimit)limitUntil=Date.now()+5000;res.status(202).json(task);}catch(error){res.status(422).json({error:error.message});}});
app.get('/api/youtube-premium/tasks/:id', (req,res)=>res.json(service.get(req.params.id)));
app.use('/client',express.static(path.join(root,'client')));app.use('/prompts/resources/icons',express.static(path.join(root,'prompts/resources/icons')));
const server=app.listen(Number(process.env.TEST_FIXTURE_PORT)||0,'127.0.0.1',()=>console.log(JSON.stringify({base:'http://127.0.0.1:'+server.address().port,isolatedDataDir:dataDir})));
function close(){server.closeAllConnections();server.close(()=>{const target=path.resolve(dataDir);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('dr2t-ui-261019-'))throw Error('unsafe fixture cleanup');fs.rmSync(target,{recursive:true,force:true});process.exit();});}
process.on('SIGINT',close);process.on('SIGTERM',close);
