'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'app.js'),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
let server,browser,base;
before(async()=>{
 const app=express();app.use('/client',express.static(path.join(root,'client')));app.use('/prototypes',express.static(path.join(root,'prompts/resources/UI-261107-Control-Center')));
 app.get('/backup',(_q,res)=>res.sendFile(path.join(root,'pages/system-backup.html')));
 app.get('/',(_q,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
 ${['index','themes-legacy','themes','themes-blamen','themes-lusns','notification-center'].map(n=>'<link rel="stylesheet" href="/client/'+n+'.css">').join('')}
 <button id="open">打开</button><button id="leaveTunnelBtn">离开一</button><button id="leaveTunnelPanelBtn">离开二</button>
 <div id="transferProgress"><div id="progressDrawerSummary"></div><div id="progressList"></div></div><div id="filePreviewContent" class="file-preview-content">预览</div>
 <script src="/client/notification-center.js"></script><script>
 const state={sessionId:'A'};window.left=0;window.located=[];window.acted=[];
 const getAllFromStore=async()=>Array.from({length:16},(_,i)=>({sessionId:i?'T'+i:'A',shortCode:'ABCDE',remark:'隔离隧道 '+i}));
 const escapeHtml=v=>String(v).replace(/[&<>"']/g,'_'),normalizeLocalShortCode=v=>v||'',hasActiveTransferTasks=()=>false,historyLog=()=>{};
 const locateProgressFile=key=>located.push(key),cycleTheme=()=>{},progressElementId=id=>'progress-'+id,getProgressBaseFileId=id=>id;
 const progressDrawerCollapsed=false,progressDrawerIgnoreItemClicksUntil=0,setProgressDrawerCollapsed=()=>{};
 ${section('const PROGRESS_ACTIVITY_RANK =','function hasActiveTransferTasks(')}
 ${section('function showProgress(','function locateProgressFile(')}
 ${section('function normalizeControlCenterOrder(','function showTunnelRemarkDialog(')}
 NotificationCenter.init({deviceId:()=> 'isolated',onAction:async(item,action)=>{acted.push([item.id,action]);if(window.actionFailure)throw Error('fixture failure');}});
 document.getElementById('open').onclick=showJoinedSessionSwitcher;
 for(const id of ['leaveTunnelBtn','leaveTunnelPanelBtn'])document.getElementById(id).onclick=()=>window.left++;
 initControlCenterShortcuts();
 window.tasks=()=>{for(let i=0;i<28;i++)showProgress('task'+i,'测试文件 '+i+'.zip',i===2?0:31,'P2P',{route:i===1?'sending-p2p':i===2?'queued':'p2p'});};
 </script>`));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));});
test('261108: simultaneous drawer and control-center rendering preserves real receiver bytes, request count and completion',async()=>{
 const results=[];
 for(const open of [false,true]){
  const page=await browser.newPage({viewport:{width:1600,height:1000}});try{
   await page.goto(base);await page.evaluate(()=>localStorage.setItem('drop2tunnel.language','ja'));for(const file of ['i18n-catalog','i18n','file-assets'])await page.addScriptTag({url:base+'/client/'+file+'.js'});
   const result=await page.evaluate(async open=>{
    if(open)await showJoinedSessionSwitcher();
    const cache=new Map(),assets=Array.from({length:32},(_,n)=>({id:n.toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000',name:n+'.bin',type:'application/octet-stream',size:16384+n,isAsset:true}));
    let transfer,requests=0,received=0,bytes=0,finish;const finished=new Promise(resolve=>finish=resolve),started=performance.now();
    const socket={connected:true,emit(event,data){if(event!=='file-asset-request')return;requests++;setTimeout(async()=>{const asset=assets.find(item=>item.id===data.assetId),attemptId=data.requestId+'-relay-full';const ack=await transfer.handleRelayStart({asset,from:'provider',attemptId,requestId:data.requestId});if(!ack.ok)throw Error(ack.reason);const body=new Uint8Array(asset.size);body.fill(Number.parseInt(asset.id.slice(0,8),16));await transfer.handleRelayChunk({assetId:asset.id,from:'provider',attemptId,chunk:body.buffer});await transfer.handleRelayComplete({assetId:asset.id,from:'provider',attemptId});},2);}};
    transfer=new FileAssetTransfer({getSessionId:()=> 'A',getSocket:()=>socket,load:async id=>cache.get(id),store:async file=>{cache.set(file.id,file);bytes+=file.data.byteLength;},log(){},onUnavailable(_id,reason){throw Error(reason);},onProgress:(id,name,progress,transport)=>showProgress(id,name,progress,transport,{route:transport}),onReceived(){if(++received===assets.length)finish();}});
    for(const asset of assets)await transfer.request(asset.id,'provider',asset);await finished;await new Promise(requestAnimationFrame);
    for(const asset of assets){const body=new Uint8Array(cache.get(asset.id).data);if(body.some(value=>value!==Number.parseInt(asset.id.slice(0,8),16)))throw Error('incorrect bytes');}
    clearInterval(transfer.requestWatchdogTimer);return {open,requests,received,bytes,pending:transfer.desiredAssets.size,elapsedMs:Math.round(performance.now()-started),drawer:document.querySelector('#progressList').children.length,panel:document.querySelector('[data-control-progress-list]')?.children.length||0};
   },open);results.push(result);assert.equal(result.requests,32);assert.equal(result.received,32);assert.equal(result.pending,0);assert.equal(result.drawer,32);if(open)assert.equal(result.panel,32);
  }finally{await page.close();}
 }
 assert.equal(results[0].bytes,results[1].bytes);fs.writeFileSync(path.join(root,'.npm-cache/control-center-transfer-261108.json'),JSON.stringify(results,null,2));
});
test('seven themes have equal wide columns, live scrollable progress and unread actions without marking messages read',async()=>{
 const page=await browser.newPage({viewport:{width:1600,height:1000}});try{
 await page.goto(base);await page.evaluate(()=>{tasks();NotificationCenter.add({id:'request',type:'web-zip-edit-request',title:'网页编辑申请',body:'设备申请编辑网页'});});
 for(const theme of ['lumen','orbit','classic','atelier','social','blamen','lusns']){
  await page.evaluate(theme=>document.body.dataset.theme=theme,theme);await page.locator('#open').click();
  await page.locator('.control-center').waitFor();
  const geometry=await page.evaluate(()=>{const box=s=>document.querySelector(s).getBoundingClientRect(),a=box('.control-center-live'),b=box('.control-center-tools'),p=document.querySelector('[data-control-progress-list]');return{a:a.width,b:b.width,rightTop:b.top,leftTop:a.top,scroll:p.scrollHeight>p.clientHeight,count:p.children.length,unread:NotificationCenter.list().filter(x=>!x.read).length,bg:getComputedStyle(document.getElementById('filePreviewContent')).backgroundColor};});
  assert.ok(Math.abs(geometry.a-460)<2,theme+JSON.stringify(geometry));assert.equal(geometry.a,geometry.b);assert.equal(geometry.leftTop,geometry.rightTop);assert.equal(geometry.scroll,true);assert.equal(geometry.count,28);assert.equal(geometry.unread,1);
  assert.equal(await page.locator('[data-control-tile="magnet"]').evaluate(node=>getComputedStyle(node).whiteSpace),'nowrap');
  assert.equal(await page.locator('[data-control-tile="theme"]').evaluate(node=>getComputedStyle(node).fontSize),'24px');
  assert.equal(await page.locator('.control-center [data-notification-count]').textContent(),'1');
  if(theme==='orbit')assert.equal(geometry.bg,'rgb(32, 39, 57)');
  assert.match(await page.locator('[data-control-progress-summary]').textContent(),/28.*进行中.*准备|28.*进行中.*等待/);
  await page.locator('[data-control-progress-list]').evaluate(node=>node.scrollTop=180);await page.evaluate(()=>updateProgress('task1',77,'P2P',{route:'sending-p2p'}));
  await page.waitForFunction(()=>document.querySelector('[data-control-progress-list] [data-progress-key="task1"] .progress-text').textContent.includes('77%'));
  assert.equal(await page.locator('[data-control-progress-list]').evaluate(node=>node.scrollTop),180);
  await page.waitForTimeout(1100);assert.equal(await page.locator('[data-control-progress-list]').evaluate(node=>node.scrollTop),180);
  await page.keyboard.press('Escape');await page.locator('.control-center').waitFor({state:'detached'});
 }
 await page.locator('#open').click();await page.locator('[data-control-unread-list] [data-notification-action="approve"]').click();
 await page.waitForFunction(()=>NotificationCenter.list()[0].read);assert.deepEqual(await page.evaluate(()=>acted),[['request','approve']]);
 await page.evaluate(()=>NotificationCenter.add({id:'later',title:'新通知'}));await page.getByRole('button',{name:'打开通知中心 ›'}).click();
 assert.equal(await page.locator('#notificationCenter').isVisible(),true);assert.equal(await page.evaluate(()=>NotificationCenter.list().every(x=>x.read)),true);
 }finally{await page.close();}
});

test('wide geometry and tunnel card colors match all seven SVGs without legacy modal styling',async()=>{
 const page=await browser.newPage({viewport:{width:1600,height:1000}}),folder=path.join(root,'.npm-cache/control-center-261107');fs.mkdirSync(folder,{recursive:true});
 try{for(const theme of ['Lumen','Orbit','Classic','Atelier','Social','Blamen','Lusns']){
  const svg=fs.readFileSync(path.join(root,'prompts/resources/UI-261107-Control-Center',theme,'control-center.svg'),'utf8');
  const value=(re)=>{const result=svg.match(re);assert.ok(result,'prototype field '+re);return result[1];};
  const expected={panel:value(/x="298" y="85"[^>]+fill="([^"]+)"/),soft:value(/\.subtle\{fill:([^;]+);/),line:value(/\.subtle\{[^}]+stroke:([^}]+)\}/),selected:value(/x="824" y="470"[^>]+fill="([^"]+)"/),selectedLine:value(/x="824" y="470"[^>]+stroke="([^"]+)"/),scroll:value(/x="824" y="431"[^>]+fill="([^"]+)"/)};
  await page.goto(base+'/prototypes/'+theme+'/control-center.svg');await page.screenshot({path:path.join(folder,theme+'-prototype.png')});
  for(const view of ['drag-order','transfer-progress-states']){await page.goto(base+'/prototypes/'+theme+'/'+view+'.svg');await page.screenshot({path:path.join(folder,theme+'-'+view+'.png')});}
  await page.goto(base);await page.evaluate(theme=>{document.body.dataset.theme=theme;tasks();NotificationCenter.add({id:'invitation',type:'stream-invitation',title:'串流邀请',body:'小陈邀请你观看串流台「周末放映」'});},theme.toLowerCase());await page.locator('#open').click();
  const actual=await page.evaluate(expected=>{
   const rect=s=>{const {x,y,width,height}=document.querySelector(s).getBoundingClientRect();return{x,y,width,height};},style=s=>getComputedStyle(document.querySelector(s)),rgb=color=>{const node=document.createElement('i');node.style.color=color;document.body.append(node);const result=getComputedStyle(node).color;node.remove();return result;};
   return {shell:rect('.control-center'),left:rect('.control-center-progress'),unread:rect('.control-center-notifications'),right:rect('.control-center-tools'),tile:rect('[data-control-tile="refresh"]'),lastRow:rect('[data-control-side="before"]>:nth-child(11)'),up:rect('[data-scroll="-1"]'),first:rect('.session-switch-item'),down:rect('[data-scroll="1"]'),colors:{panel:style('.control-center').backgroundColor,soft:style('.session-switch-item:not(.is-current)').backgroundColor,line:style('.session-switch-item:not(.is-current)').borderTopColor,selected:style('.session-switch-item.is-current').backgroundColor,selectedLine:style('.session-switch-item.is-current').borderTopColor,scroll:style('[data-scroll="-1"]').backgroundColor},expected:Object.fromEntries(Object.entries(expected).map(([key,color])=>[key,rgb(color)])),radius:style('.session-switch-item').borderRadius,shadow:style('.session-switch-item.is-current').boxShadow,panelBg:style('[data-control-panel]').backgroundColor};
  },expected);
  for(const [key,want] of Object.entries({shell:{x:298,y:85,width:1004,height:830},left:{x:318,y:170,width:460,height:296},unread:{x:318,y:482,width:460,height:409},right:{x:802,y:170,width:460,height:721},tile:{x:873,y:190,width:54,height:48},lastRow:{x:939,y:310,width:54,height:48},up:{x:824,y:431,width:416,height:27},first:{x:824,y:470,height:56},down:{x:824,y:854,width:416,height:25}}))for(const [axis,target]of Object.entries(want))assert.ok(Math.abs(actual[key][axis]-target)<=1,theme+' '+key+'.'+axis+': '+JSON.stringify(actual));
  assert.deepEqual(actual.colors,actual.expected,theme);assert.equal(actual.radius,'11px');assert.equal(actual.shadow,'none');assert.equal(actual.panelBg,'rgba(0, 0, 0, 0)');
  await page.screenshot({path:path.join(folder,theme+'-actual.png')});
 }}finally{await page.close();}
});
test('Ctrl double tap excludes shortcuts and repeated keys; right click and touch hold never activate leave',async()=>{
 const page=await browser.newPage();try{
 await page.goto(base);await page.keyboard.press('Control');await page.keyboard.press('Control');await page.locator('.control-center').waitFor();await page.keyboard.press('Escape');
 await page.keyboard.press('Control+a');await page.keyboard.press('Control');assert.equal(await page.locator('.control-center').count(),0);
 await page.keyboard.press('Control+b');
 for(const id of ['leaveTunnelBtn','leaveTunnelPanelBtn']){
  await page.locator('#'+id).click({button:'right'});await page.locator('.control-center').waitFor();assert.equal(await page.evaluate(()=>left),0);await page.keyboard.press('Escape');
  await page.locator('#'+id).evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);});
  await page.locator('#'+id).dispatchEvent('pointerdown',{pointerType:'touch',pointerId:1,isPrimary:true,button:0,clientX:20,clientY:20});
  await page.waitForTimeout(id==='leaveTunnelBtn'?1850:560);await page.locator('.control-center').waitFor();
  assert.equal(await page.evaluate(()=>window.getSelection().toString()),'');
  assert.equal(await page.locator('.control-center').evaluate(node=>!node.dispatchEvent(new Event('selectstart',{bubbles:true,cancelable:true}))),true,'long hold consumes native text selection');
  assert.equal(await page.locator('.control-center').evaluate(node=>!node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))),true,'retargeted touch menu is prevented');
  await page.locator('#'+id).dispatchEvent('pointerup',{pointerType:'touch',pointerId:1,isPrimary:true});await page.locator('#'+id).dispatchEvent('click');
  assert.equal(await page.evaluate(()=>left),0);await page.keyboard.press('Escape');await page.waitForTimeout(850);assert.equal(await page.locator('body').evaluate(node=>node.classList.contains('control-center-touch-opening')),false);
 }
 await page.locator('#leaveTunnelBtn').click();assert.equal(await page.evaluate(()=>left),1);
 await page.locator('#leaveTunnelPanelBtn').dispatchEvent('pointerdown',{pointerType:'touch',pointerId:2,isPrimary:true,button:0,clientX:10,clientY:10});
 await page.locator('#leaveTunnelPanelBtn').dispatchEvent('pointermove',{pointerType:'touch',pointerId:2,isPrimary:true,clientX:40,clientY:80});await page.waitForTimeout(540);assert.equal(await page.locator('.control-center').count(),0);
 }finally{await page.close();}
});
test('drag follows the pointer, displaces tiles and stays above the tunnel panel; narrow order and layout remain usable',async()=>{
 const page=await browser.newPage({viewport:{width:1600,height:1000}});try{
 await page.goto(base);await page.locator('#open').click();const first=page.locator('[data-control-tile="refresh"]'),next=page.locator('[data-control-tile="magnet"]');
 const a=await first.boundingBox(),b=await next.boundingBox();await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
 await page.mouse.move(a.x+a.width/2+(b.x-a.x-a.width)-2,a.y+a.height/2);
 assert.equal(await page.locator('[data-control-side="before"]>[data-control-tile]').first().getAttribute('data-control-tile'),'magnet','neighbor gives way before the dragged edge touches it');
 await page.mouse.move(b.x+b.width/2+3,b.y+b.height/2,{steps:5});
 assert.equal(await page.locator('.control-center-drag-ghost').count(),1);await page.waitForTimeout(220);
 assert.equal(await page.locator('[data-control-side="before"]>[data-control-tile]').first().getAttribute('data-control-tile'),'magnet');
 const panel=await page.locator('[data-control-panel]').boundingBox();await page.mouse.move(panel.x+20,panel.y+80,{steps:4});
 const ghost=await page.locator('.control-center-drag-ghost').boundingBox(),grid=await page.locator('[data-control-side="before"]').boundingBox();assert.ok(ghost.y+ghost.height<=grid.y+grid.height+1);
 await page.mouse.up();assert.equal(await page.locator('[data-control-side="after"]>*').count(),0);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('.control-center-live').isVisible(),false);assert.ok((await page.locator('.control-center').boundingBox()).width<=390);
 await page.locator('#closeSessionSwitcher').click();await page.locator('#open').click();assert.equal(await page.locator('[data-control-tile]').count(),13);
 }finally{await page.close();}
});

test('a real touch hold drags the magnet tile without wrapping its ghost or opening its action',async()=>{
 const page=await browser.newPage({viewport:{width:1600,height:1000},hasTouch:true});try{
  await page.goto(base);await page.locator('#open').click();const box=await page.locator('[data-control-tile="magnet"]').boundingBox();
  const cdp=await page.context().newCDPSession(page),point={x:box.x+box.width/2,y:box.y+box.height/2};
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await page.waitForTimeout(560);
  assert.equal(await page.locator('.control-center-drag-ghost').evaluate(node=>getComputedStyle(node).whiteSpace),'nowrap');
  assert.equal(await page.locator('.control-center-drag-ghost').evaluate(node=>getComputedStyle(node).fontSize),'20px');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x+45,y:point.y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.equal(await page.locator('.control-center-drag-ghost').count(),0);assert.equal(await page.locator('.control-center').count(),1);
  assert.deepEqual(await page.locator('[data-control-side="before"]>[data-control-tile]').evaluateAll(nodes=>nodes.slice(0,3).map(node=>node.dataset.controlTile)),['refresh','theme','magnet']);
 }finally{await page.close();}
});
test('backup retry immediately acknowledges acceptance and a delayed old poll cannot restore the failed status',async()=>{
 const page=await browser.newPage();let release;const gate=new Promise(r=>release=r);let reads=0,retried=false;
 const job={id:'isolated-job',mode:'full',folder:'1-20261107',createdAt:Date.now(),status:'failed',error:'TELEGRAM_504',completedFiles:1,totalFiles:3,completedBytes:1,totalBytes:3};
 const snapshot=()=>({config:{full:null,core:null},users:[],active:retried?job.id:'',jobs:[{...job,status:retried?'uploading':'failed',error:retried?'':job.error,completedFiles:retried?2:1}]});
 try{
 await page.route('**/api/system-backup/**',async route=>{
  if(route.request().url().endsWith('/retry')){retried=true;return route.fulfill({json:{...job,status:'uploading',error:''}});}
  if(route.request().url().endsWith('/state')){const value=snapshot();if(++reads===2)await gate;return route.fulfill({json:value});}
  return route.fulfill({json:{}});
 });
 await page.goto(base+'/backup');await page.getByRole('button',{name:'重试',exact:true}).waitFor();await page.locator('#sb-refresh').click();
 await page.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(()=>document.getElementById('sb-notice').textContent.includes('重试已接受'));
 assert.match(await page.locator('.sb-status').textContent(),/正在保存/);release();await page.waitForTimeout(200);assert.match(await page.locator('.sb-status').textContent(),/正在保存/);
 assert.match(await page.locator('[data-row="count"]').textContent(),/2 \/ 3/);assert.equal(await page.getByRole('button',{name:'取消备份',exact:true}).count(),1);
 }finally{release();await page.close();}
});

test('unread actions survive rerenders without duplicate submission or marking a newer notification read',async()=>{
 const page=await browser.newPage();try{
  await page.goto(base);await page.evaluate(()=>{window.actionCalls=0;NotificationCenter.init({deviceId:()=> 'isolated',onAction:()=>{actionCalls++;return new Promise(resolve=>window.finishAction=resolve);}});NotificationCenter.add({id:'request',type:'web-zip-edit-request',title:'申请',body:'第一版'});});
  await page.locator('#open').click();await page.locator('[data-notification-action="approve"]').click();
  await page.evaluate(()=>NotificationCenter.add({id:'other',title:'其它消息'}));
  assert.equal(await page.locator('[data-notification-id="request"]').getAttribute('inert'),'');
  await page.locator('[data-notification-action="reject"]').dispatchEvent('click');assert.equal(await page.evaluate(()=>actionCalls),1);
  await page.evaluate(()=>{NotificationCenter.add({id:'request',type:'web-zip-edit-request',title:'申请',body:'新版本'});finishAction();});
  await page.waitForFunction(()=>!document.querySelector('[data-notification-id="request"]').inert);
  assert.equal(await page.evaluate(()=>NotificationCenter.list().find(x=>x.id==='request').read),false);
 }finally{await page.close();}
});

test('an accepted real server backup continues after the initiating page closes',async()=>{
 const fixture=await require('./support/data-backup-261027-fixture.cjs').create();let release,entered;
 const gate=new Promise(resolve=>release=resolve),entering=new Promise(resolve=>entered=resolve),put=fixture.api.objectStorage.put.bind(fixture.api.objectStorage);let blocked=false;
 fixture.api.objectStorage.put=async(...args)=>{if(!blocked && args[3]?.size>0){blocked=true;entered();await gate;}return put(...args);};
 const page=await browser.newPage();try{
  await page.goto(fixture.base+'/system-backup');
  const accepted=await page.evaluate(async()=>{const response=await fetch('/api/system-backup/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'core',requestId:'closed-page-backup-261107'})});return{status:response.status,job:await response.json()};});
  assert.equal(accepted.status,202);await entering;await page.close();assert.equal(fixture.backup.state().active,accepted.job.id);
  release();await fixture.backup.wait();const done=fixture.backup.state().jobs[0];assert.equal(done.status,'completed',done.error);assert.equal(done.completedFiles,done.totalFiles);
 }finally{release();await page.close();await fixture.close();}
});
