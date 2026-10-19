'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const express=require('express'),{rateLimit}=require('express-rate-limit'),{createTunnelAccess}=require('../server/tunnel-access'),premium=require('../server/youtube-premium'),{createYoutubePremiumService}=premium;
const read=file=>fs.readFileSync(file,'utf8'),slice=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dr2t-261019-'));t.after(()=>{const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('dr2t-261019-'));fs.rmSync(target,{recursive:true,force:true});});return dir;}

test('QR join credentials fit in 50 characters and retain tunnel, rotation and restart checks',t=>{
    const dir=directory(t),gate=createTunnelAccess(dir),id=crypto.randomUUID(),token=gate.issueJoin(id,'OLD51');
    assert.ok(token.length<=50,'QR credentials must not repeat the session identifier and revision in a JSON envelope');
    assert.equal(createTunnelAccess(dir).verifyJoin(token,id,'OLD51'),true);assert.equal(gate.verifyJoin(token,id,'NEW51'),false);assert.equal(gate.verifyJoin(token,crypto.randomUUID(),'OLD51'),false);assert.equal(gate.verifyJoin(token+'x',id,'OLD51'),false);
    const key=fs.readFileSync(path.join(dir,'.tunnel-access.key'),'utf8').trim(),sign=value=>crypto.createHmac('sha256',key).update(value).digest('base64url');
    const payload=Buffer.from(JSON.stringify({purpose:'join',sessionId:id,revision:sign('join-revision\0'+id+'\0OLD51')})).toString('base64url'),legacy=payload+'.'+sign(payload);
    assert.equal(gate.verifyJoin(legacy,id,'OLD51'),true);assert.equal(gate.verifyJoin(legacy,id,'NEW51'),false);t.diagnostic(`credential length: ${legacy.length} -> ${token.length}`);
});

test('a preferred handwritten selector reaches the worker without consulting checkbox IDs',async t=>{
    const dataDir=directory(t);let analyzed;const selector='bestvideo[height<=1080]+bestaudio/best';
    const service=createYoutubePremiumService({dataDir,analyze:async(_url,options)=>{analyzed=options;return {title:'Fixture',mediaType:'video',selection:{ids:['137','140'],formats:[{kind:'video'},{kind:'audio'}],formatSelector:options.manualFormat,summary:{}}};},download:async({taskDir})=>{fs.mkdirSync(taskDir,{recursive:true});const outputPath=path.join(taskDir,'video.mp4');fs.writeFileSync(outputPath,'fixture');return {outputPath,outputFileName:'video.mp4',outputFileSize:7};}});
    const task=service.create({url:'https://www.youtube.com/watch?v=fixture',mode:'custom',manualFormat:selector,useManualFormat:true,selectedFormatIds:['stale','ignored','third']});
    for(let n=0;n<100&&!['completed','failed'].includes(service.get(task.id).status);n++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(service.get(task.id).status,'completed');assert.equal(analyzed.manualFormat,selector);assert.deepEqual(analyzed.selectedFormatIds,[]);assert.equal(service.get(task.id).manualFormat,selector);
    assert.throws(()=>service.create({url:'https://youtu.be/fixture',mode:'custom',manualFormat:selector,useManualFormat:false,selectedFormatIds:[]}),/custom-format-required/);
    assert.throws(()=>service.create({url:'https://youtu.be/fixture',mode:'custom',manualFormat:'137\n140',useManualFormat:true}),/custom-manual-format-invalid/);
});

test('a task accepted before a failed list refresh is reported as created, never as creation failure',async()=>{
    const notice={textContent:''};let submissions=0;const context=vm.createContext({urlInput:{value:'https://youtu.be/fixture'},mode:()=> 'default',selectedFormats:()=>[],analysis:null,analysisInputUrl:'',updateSelectionSummary:()=>true,selectedMusicCutNeedsOffsetWarning:()=>false,startBtn:{disabled:false},notice,asMusicInput:{checked:false},downloadSectionsInput:{value:''},preDownloadRemarkInput:{value:''},manualFormatInput:{value:''},useManualFormatInput:{checked:false},activeManualFormat:()=>'',api:async()=>{submissions++;return {id:'accepted'};},window:{},loadTasks:async()=>{throw Error('请求过于频繁，请稍后再试');},taskList:{children:[]},page:1});
    vm.runInContext(slice(read('pages/youtube-premium-dl.html'),'async function startDownload()','function taskButton('),context);await context.startDownload();
    assert.equal(submissions,1);assert.match(notice.textContent,/任务已创建/);assert.doesNotMatch(notice.textContent,/^创建失败/);assert.equal(context.startBtn.disabled,false);
});

test('local polling limits reject before any upstream work and identify the server as the source',async t=>{
    const context=vm.createContext({rateLimit:options=>options,normalizeLanguageCode:value=>value,translateTelegramText:value=>value});
    vm.runInContext(slice(read('server.js'),'const RATE_LIMIT = {','const snsDownloadRateLimit =')+';this.config=RATE_LIMIT;this.premium=youtubePremiumRateLimit;',context);
    assert.equal(context.config.max,1000);assert.equal(context.premium.max,60);
    const app=express(),limiter=rateLimit({...context.config,max:3});let upstream=0;app.use(limiter);app.get('/api/youtube-premium/tasks',(_req,res)=>res.json({tasks:[]}));app.post('/api/youtube-premium/tasks',(_req,res)=>{upstream++;res.status(202).json({id:'task'});});
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));const base='http://127.0.0.1:'+server.address().port;
    for(let n=0;n<3;n++)assert.equal((await fetch(base+'/api/youtube-premium/tasks')).status,200);
    const response=await fetch(base+'/api/youtube-premium/tasks',{method:'POST'});assert.equal(response.status,429);const data=await response.json();assert.equal(data.source,'server');assert.equal(data.code,'LOCAL_REQUEST_RATE_LIMIT');assert.equal(upstream,0);
    assert.ok(data.retryAfterSeconds>0);let dedicated;context.premium.handler({headers:{},rateLimit:{resetTime:new Date(Date.now()+1500)}},{status(){return this;},json:value=>{dedicated=value;}},null,{statusCode:429,windowMs:900000});assert.equal(dedicated.source,'server');assert.equal(dedicated.code,'YOUTUBE_PREMIUM_RATE_LIMIT');assert.ok(dedicated.retryAfterSeconds<=2);
});

test('manual analysis probes the literal selector and validates its resolved tracks without falling back to defaults',async()=>{
    const formats=[{format_id:'137',ext:'mp4',vcodec:'avc1',acodec:'none',height:1080},{format_id:'248',ext:'webm',vcodec:'vp9',acodec:'none',height:720},{format_id:'140',ext:'m4a',vcodec:'none',acodec:'mp4a',abr:128}],calls=[],selector='bestvideo[height<=720]+bestaudio/best';
    const context=vm.createContext({...premium,URL,parseSupportedSocialUrl:raw=>({platform:'youtube',parsed:new URL(raw)}),isYouTubePlaylistOnly:()=>false,requireYoutubePremiumCookies:()=>'/synthetic-cookie',sanitizeString:value=>String(value),classifySnsMedia:()=> 'video',getYtDlpAudioFormatSelector:()=> 'bestaudio',getYtDlpFormatSelector:()=> 'default-video',runYtDlpJson:async(_url,options)=>{calls.push(options);return {id:'fixture',title:'Fixture',formats,requested_formats:[formats[1],formats[2]]};},normalizeArtistValue:()=>'',buildYoutubeReferenceInfo:()=>({}),recordExternalDependencyEvent(){}});
    const analyze=vm.runInContext(slice(read('server.js'),'async function analyzeYoutubePremiumUrl(','function moveYoutubePremiumOutput(')+';analyzeYoutubePremiumUrl',context);
    const analysis=await analyze('https://youtu.be/fixture',{manualFormat:selector,selectedFormatIds:['137']});assert.equal(calls.length,2);assert.equal(calls[1].formatSelector,selector);assert.equal(calls[1].formatSelectionFallback,false);assert.equal(calls[1].allowIgnoreNoFormatsFallback,false);assert.deepEqual(Array.from(analysis.selection.ids),['248','140']);assert.equal(analysis.selection.formatSelector,selector);
});

test('manual format controls preserve checkbox choices and only bypass them when both conditions hold',()=>{
    const chosen=[{id:'137'},{id:'140'}];let queries=0,scheduled=0,cleared=0;
    const context=vm.createContext({mode:()=> 'custom',manualFormatInput:{value:'137+140'},useManualFormatInput:{checked:false},formatList:{querySelectorAll:()=>{queries++;return chosen.map(item=>({value:item.id}));}},analysis:{formats:chosen},analysisInputUrl:'fixture',urlInput:{value:'fixture'},analyzeTimer:7,clearTimeout:()=>cleared++,updateSelectionSummary(){},scheduleAnalyze:()=>scheduled++});
    const page=read('pages/youtube-premium-dl.html');
    vm.runInContext(slice(page,'function activeManualFormat()','function selectedMusicCutNeedsOffsetWarning(')+slice(page,'function onManualFormatChange()','manualFormatInput.addEventListener('),context);
    assert.equal(context.selectedFormats().length,2);assert.equal(queries,1);context.onManualFormatChange();assert.equal(scheduled,0);
    context.useManualFormatInput.checked=true;assert.equal(context.selectedFormats().length,0);assert.equal(queries,1);context.onManualFormatChange();assert.equal(scheduled,0);
    context.manualFormatInput.value='  ';assert.equal(context.selectedFormats().length,2);assert.equal(queries,2);context.onManualFormatChange();assert.equal(scheduled,0);
    context.analysis=null;context.onManualFormatChange();assert.equal(scheduled,1);assert.equal(cleared,4);
});

test('an unavailable manual format fails in the real yt-dlp runner without silently dropping its selector',async()=>{
    const {EventEmitter}=require('node:events'),commands=[];
    const context=vm.createContext({...premium,URL,process:{env:{}},setTimeout,clearTimeout,fs:{existsSync:()=>false},YT_DLP_CACHE_DIR:'/synthetic-cache',parseSupportedSocialUrl:raw=>({platform:'youtube',parsed:new URL(raw)}),isYouTubePlaylistOnly:()=>false,requireYoutubePremiumCookies:()=>'/synthetic-cookie',sanitizeString:value=>String(value),classifySnsMedia:()=> 'video',getYtDlpAudioFormatSelector:()=> 'bestaudio',getYtDlpFormatSelector:()=> 'default-video',getYtDlpDependencyId:()=> 'youtube-yt-dlp',getYtDlpRemoteComponentArgs:()=>[],getYtDlpFfmpegArgs:()=>[],getYtDlpInvocation:args=>({command:'synthetic-yt-dlp',args}),getSnsCookieFileForUrl:()=>'',copyYtDlpCookies:args=>({args,cleanup(){}}),buildYtDlpEnv:()=>({}),getYtDlpFailureMessage:(stderr,fallback)=>stderr||fallback,getSocialPlatform:()=> 'youtube',recordExternalDependencyEvent(){},spawn(_command,args){
        commands.push(args);const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdout.setEncoding=child.stderr.setEncoding=()=>{};
        setImmediate(()=>{if(args.includes('-f')){child.stderr.emit('data','Requested format is not available');child.emit('close',1);}else{child.stdout.emit('data',JSON.stringify({id:'fixture',formats:[]}));child.emit('close',0);}});return child;
    }});
    const server=read('server.js');vm.runInContext(slice(server,'function runYtDlpJson(','function getYtDlpRemoteComponentArgs('),context);
    const analyze=vm.runInContext(slice(server,'async function analyzeYoutubePremiumUrl(','function moveYoutubePremiumOutput(')+';analyzeYoutubePremiumUrl',context);
    await assert.rejects(()=>analyze('https://youtu.be/fixture',{manualFormat:'unavailable-manual-format'}),/Requested format is not available/);
    assert.equal(commands.length,2);assert.equal(commands[1][commands[1].indexOf('-f')+1],'unavailable-manual-format');assert.ok(!commands[1].includes('--ignore-no-formats-error'));
});

test('chat input grows to four lines, shrinks, and keeps IME and multiline key input out of the send path',()=>{
    const input={style:{},scrollHeight:38},sent=[];let touch=false;
    const context=vm.createContext({document:{getElementById:()=>input},window:{matchMedia:()=>({matches:touch})},getComputedStyle:()=>({lineHeight:'24px',fontSize:'16px',paddingTop:'7px',paddingBottom:'7px',borderTopWidth:'2px',borderBottomWidth:'2px'}),sendText:()=>sent.push('send')});
    vm.runInContext(slice(read('app.js'),'function updateTextInputHeight()','async function sendText()'),context);
    context.updateTextInputHeight();assert.equal(input.style.height,'42px');input.scrollHeight=200;context.updateTextInputHeight();assert.equal(input.style.height,'114px');assert.equal(input.style.overflowY,'auto');input.scrollHeight=38;context.updateTextInputHeight();assert.equal(input.style.height,'42px');assert.equal(input.style.overflowY,'hidden');
    const key=extra=>({key:'Enter',preventDefault(){this.prevented=true;},...extra});for(const event of [key({isComposing:true}),key({keyCode:229}),key({shiftKey:true})]){context.handleTextInputKeydown(event);assert.equal(event.prevented,undefined);}assert.equal(sent.length,0);
    const enter=key({});context.handleTextInputKeydown(enter);assert.equal(sent.length,1);assert.equal(enter.prevented,true);touch=true;context.handleTextInputKeydown(key({}));assert.equal(sent.length,1);context.handleTextInputKeydown(key({ctrlKey:true}));assert.equal(sent.length,2);
});
