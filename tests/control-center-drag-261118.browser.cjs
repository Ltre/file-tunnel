'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'app.js'),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
let server,browser,base;
before(async()=>{
 const app=express();app.use('/client',express.static(path.join(root,'client')));
 app.get('/editor',(_q,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8">
 <script defer src="/client/i18n-bootstrap.js"></script><script defer src="/client/i18n.js"></script><body><script>
 const state={deviceId:'owner'},canEditWebZip=()=>true,escapeHtml=String,formatWebZipText=text=>window.TunnelI18n?.t(text)||text;
 ${section('function showWebZipEditDialog(','async function publishWebZipUpdate(')}
 </script></body>`));
 app.get('/',(_q,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
 ${['index','themes-legacy','themes','themes-blamen','themes-lusns'].map(n=>'<link rel="stylesheet" href="/client/'+n+'.css">').join('')}
 <button id="open">打开</button><button id="magnetCacheBtn" onclick="window.tileActions++">磁链</button><script>
 const state={sessionId:'A'};window.tileActions=0;
 const getAllFromStore=async()=>Array.from({length:15},(_,i)=>({sessionId:i?'T'+i:'A',shortCode:'ABCDE',remark:'隔离隧道 '+i}));
 const escapeHtml=v=>String(v).replace(/[&<>"']/g,'_'),normalizeLocalShortCode=v=>v||'',hasActiveTransferTasks=()=>false,historyLog=()=>{},cycleTheme=()=>{},updateProgressDrawerSummary=()=>{};
 ${section('function normalizeControlCenterOrder(','function showTunnelRemarkDialog(')}
 document.getElementById('open').onclick=showJoinedSessionSwitcher;
 </script>`));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));});
async function touch(page){const cdp=await page.context().newCDPSession(page);return async(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});}
const center=box=>({x:box.x+box.width/2,y:box.y+box.height/2});

test('a slowly advancing finger does not repeatedly swap back into the slot it has just left',async()=>{
 const page=await browser.newPage({viewport:{width:424,height:854},hasTouch:true});try{
  await page.goto(base);await page.locator('#open').click();await page.waitForTimeout(250);
  const send=await touch(page),start=center(await page.locator('[data-control-tile="refresh"]').boundingBox()),target=center(await page.locator('[data-control-tile="magnet"]').boundingBox()),orders=[];
  await send('touchStart',start.x,start.y);await page.waitForTimeout(550);
  for(let dx=10;dx<=target.x-start.x;dx+=10){await send('touchMove',start.x+dx,start.y);await page.waitForTimeout(45);orders.push(await page.locator('[data-control-side="before"]').evaluate(n=>[...n.children].slice(0,2).map(n=>n.dataset.controlTile).join(',')));}
  const folder=path.join(root,'.npm-cache/261119-control-center');fs.mkdirSync(folder,{recursive:true});await page.screenshot({path:path.join(folder,'narrow-drag.png')});
  await send('touchEnd');assert.ok(orders.length>2);assert.ok(orders.every(order=>order==='magnet,refresh'),'forward motion must not undo the previous insertion: '+JSON.stringify(orders));
 }finally{await page.close();}
});

test('narrow drag keeps unrelated tiles mounted and small finger tremors do not reverse a settled insertion',async()=>{
 const page=await browser.newPage({viewport:{width:424,height:854},hasTouch:true});try{
  await page.goto(base);await page.locator('#open').click();await page.waitForTimeout(250);
  await page.evaluate(()=>{
   window.detachedTiles=[];window.dragOrders=[];
   new MutationObserver(records=>{for(const record of records)for(const node of record.removedNodes)if(node.dataset?.controlTile)detachedTiles.push(node.dataset.controlTile);dragOrders.push([...document.querySelectorAll('[data-control-tile]')].map(n=>n.dataset.controlTile).join(','));}).observe(document.querySelector('[data-control-side="before"]'),{childList:true});
  });
  const send=await touch(page),start=center(await page.locator('[data-control-tile="refresh"]').boundingBox()),target=center(await page.locator('[data-control-tile="magnet"]').boundingBox());
  await send('touchStart',start.x,start.y);await page.waitForTimeout(550);await send('touchMove',target.x,target.y);await page.waitForTimeout(220);
  const settled=await page.locator('[data-control-side="before"]').evaluate(n=>[...n.children].map(n=>n.dataset.controlTile));
  for(const dx of [-5,5,-5,5,-5,5]){await send('touchMove',target.x+dx,target.y);await page.waitForTimeout(40);}
  const result=await page.evaluate(()=>({detached:detachedTiles,orders:dragOrders,order:[...document.querySelector('[data-control-side="before"]').children].map(n=>n.dataset.controlTile)}));
  await send('touchEnd');
  assert.equal(result.detached.includes('account'),false,'unrelated tiles must not be detached on each insertion: '+JSON.stringify(result));
  assert.deepEqual(result.order,settled,'small movements within the occupied slot must not swap neighboring tiles back and forth');
 }finally{await page.close();}
});

test('a held finger at the upper edge keeps scrolling until a lower tile reaches the first row',async()=>{
 const page=await browser.newPage({viewport:{width:320,height:420},hasTouch:true});try{
  await page.goto(base);await page.evaluate(()=>localStorage.setItem('tunnelControlCenterOrder',JSON.stringify([...normalizeControlCenterOrder([]).filter(id=>!['account','tunnels'].includes(id)),'tunnels','account'])));await page.locator('#open').click();
  await page.locator('[data-control-tile="account"]').scrollIntoViewIfNeeded();
  const beforeScroll=await page.locator('.control-center').evaluate(n=>n.scrollTop);assert.ok(beforeScroll>0);
  const send=await touch(page),p=center(await page.locator('[data-control-tile="account"]').boundingBox());
  await send('touchStart',p.x,p.y);await page.waitForTimeout(550);
  const box=await page.locator('.control-center').boundingBox();await send('touchMove',p.x,box.y+16);
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('.control-center').evaluate(n=>n.scrollTop),0,'edge drag must keep scrolling without further pointermove events');
  const firstTile=page.locator('[data-control-side="before"]>[data-control-tile]').first();
  if(await firstTile.getAttribute('data-control-tile')!=='account'){
   const first=await firstTile.boundingBox();await send('touchMove',first.x+first.width/2,first.y+first.height/2);
  }
  assert.equal(await page.locator('.control-center-drag-ghost').count(),1,'scrolling and reordering retain the touch');await send('touchEnd');
  assert.equal(await page.locator('[data-control-side="before"]>[data-control-tile]').first().getAttribute('data-control-tile'),'account',JSON.stringify(await page.evaluate(()=>({order:[...document.querySelectorAll('[data-control-side="before"]>[data-control-tile]')].map(n=>n.dataset.controlTile),positions:[...document.querySelectorAll('[data-control-tile]')].slice(0,4).map(n=>[n.dataset.controlTile,n.getBoundingClientRect().toJSON()])}))));
  await page.locator('#closeSessionSwitcher').click();await page.waitForFunction(()=>!history.state?.controlCenter);await page.locator('#open').click();
  assert.equal(await page.locator('[data-control-side="before"]>[data-control-tile]').first().getAttribute('data-control-tile'),'account');
 }finally{await page.close();}
});

test('long hold and drag across tunnel text never selects overlay text, then ordinary tile taps still work',async()=>{
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});try{
  await page.goto(base);await page.locator('#open').click();await page.waitForTimeout(900);
  assert.equal(await page.locator('.session-switch-item strong').first().evaluate(n=>getComputedStyle(n).userSelect),'none','selection suppression must cover the panel after the temporary opening class expires');
  const send=await touch(page),p=center(await page.locator('[data-control-tile="magnet"]').boundingBox());
  await send('touchStart',p.x,p.y);await page.waitForTimeout(600);
  const panel=await page.locator('[data-control-panel]').boundingBox();await send('touchMove',panel.x+30,panel.y+80);await page.waitForTimeout(250);await send('touchEnd');
  assert.equal(await page.evaluate(()=>getSelection().toString()),'');assert.equal(await page.evaluate(()=>tileActions),0);
  await page.waitForTimeout(750);await page.locator('[data-control-tile="magnet"]').tap();
  assert.equal(await page.evaluate(()=>tileActions),1);assert.equal(await page.locator('.control-center-overlay').count(),0);
 }finally{await page.close();}
});

test('a diagonal drag inserts into the first row and survives repeated reorderings without pointer cancellation',async()=>{
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});try{
  await page.goto(base);await page.locator('#open').click();const send=await touch(page);
  for(const id of ['account','music','workshop']){
   const p=center(await page.locator('[data-control-tile="'+id+'"]').boundingBox()),first=await page.locator('[data-control-side="before"]>[data-control-tile]').first().boundingBox();
   await send('touchStart',p.x,p.y);await page.waitForTimeout(540);
   const target=center(first);for(let i=1;i<=6;i++)await send('touchMove',p.x+(target.x-p.x)*i/6,p.y+(target.y-p.y)*i/6);
   await page.waitForTimeout(200);assert.equal(await page.locator('.control-center-drag-ghost').count(),1);
   await send('touchEnd');assert.equal(await page.locator('[data-control-side="before"]>[data-control-tile]').first().getAttribute('data-control-tile'),id);
   assert.equal(await page.evaluate(()=>getSelection().toString()),'');await page.waitForTimeout(200);
  }
 }finally{await page.close();}
});

test('the actual webpage edit dialog translates its draft action after each supported language switch',async()=>{
 const vm=require('node:vm'),context={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'client/i18n-catalog.js'),'utf8'),context);
 const expected=context.window.Drop2TunnelI18nCatalog['转入草稿箱编辑'];
 const page=await browser.newPage({locale:'en-US'});try{
  await page.goto(base+'/editor');await page.waitForFunction(()=>window.TunnelI18n?.initialized);
  for(const [language]of context.window.Drop2TunnelI18nConfig.languages){
   await page.evaluate(async language=>{await TunnelI18n.setLanguage(language);showWebZipEditDialog({id:'fixture-file',creatorDeviceId:'owner'},{messageId:'fixture-record'});},language);
   await page.waitForFunction(text=>document.querySelector('[data-web-zip-action="edit"]')?.textContent===text,language==='zh-Hans'?'转入草稿箱编辑':expected[language]);
   assert.equal(await page.locator('[data-web-zip-action="edit"]').textContent(),language==='zh-Hans'?'转入草稿箱编辑':expected[language],language);
  }
 }finally{await page.close();}
});
