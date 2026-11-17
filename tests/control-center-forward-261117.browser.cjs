'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'app.js'),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
let server,browser,base;
before(async()=>{
 const app=express();app.use('/client',express.static(path.join(root,'client')));
 app.get('/',(_q,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
 ${['index','themes-legacy','themes','themes-blamen','themes-lusns'].map(n=>'<link rel="stylesheet" href="/client/'+n+'.css">').join('')}
 <button id="open">打开</button><button id="forward">转发</button><button id="magnetCacheBtn" onclick="window.tileActions++">磁链</button><script>
 const state={sessionId:'A'};window.tileActions=0;
 const getAllFromStore=async()=>Array.from({length:3},(_,i)=>({sessionId:i?'T'+i:'A',shortCode:'ABCDE',remark:'隔离隧道 '+i}));
 const escapeHtml=v=>String(v).replace(/[&<>"']/g,'_'),normalizeLocalShortCode=v=>v||'',hasActiveTransferTasks=()=>false,historyLog=()=>{},cycleTheme=()=>{},updateProgressDrawerSummary=()=>{};
 ${section('function normalizeControlCenterOrder(','function showTunnelRemarkDialog(')}
 ${section('function showForwardHistoryProgress(','async function cloneForwardFileInfo(')}
 document.getElementById('open').onclick=showJoinedSessionSwitcher;
 document.getElementById('forward').onclick=()=>window.progress=showForwardHistoryProgress([{id:'record-1',text:'隔离转发记录'}],new Set());
 </script>`));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));});
async function touch(page){const cdp=await page.context().newCDPSession(page);return async(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});}
const center=box=>({x:box.x+box.width/2,y:box.y+box.height/2});

test('narrow real touch movement starts tile drag and displaces the nearest tile before contact',async()=>{
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});try{
  await page.goto(base);await page.locator('#open').click();const send=await touch(page);
  const a=await page.locator('[data-control-tile="refresh"]').boundingBox(),b=await page.locator('[data-control-tile="magnet"]').boundingBox(),point=center(a);
  await send('touchStart',point.x,point.y);
  await send('touchMove',point.x+(b.x-a.x-a.width)-2,point.y);
  await page.waitForTimeout(40);
  assert.equal(await page.locator('.control-center-drag-ghost').count(),1,'moving a finger should start dragging without requiring an immobile hold');
  assert.equal(await page.locator('[data-control-side="before"]>[data-control-tile]').first().getAttribute('data-control-tile'),'magnet','the nearest tile yields before contact');
  await send('touchEnd');await page.waitForTimeout(20);
  assert.equal(await page.locator('.control-center-drag-ghost').count(),0);assert.equal(await page.locator('.control-center').count(),1);assert.equal(await page.evaluate(()=>tileActions),0);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.tunnelControlCenterOrder));assert.deepEqual(saved.slice(0,2),['magnet','refresh']);
 }finally{await page.close();}
});

test('narrow real touch crosses below the tunnel panel, retains its pointer and saves the lower position',async()=>{
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});try{
  await page.goto(base);await page.locator('#open').click();const send=await touch(page),a=center(await page.locator('[data-control-tile="magnet"]').boundingBox());
  await send('touchStart',a.x,a.y);await page.waitForTimeout(550);
  const panel=await page.locator('[data-control-panel]').boundingBox();
  for(let y=a.y+20;y<panel.y+panel.height+30;y+=20)await send('touchMove',a.x,y);
  await send('touchMove',a.x,panel.y+panel.height+30);
  await page.waitForTimeout(220);
  assert.equal(await page.locator('[data-control-side="after"]>[data-control-tile="magnet"]').count(),1);
  assert.equal(await page.locator('.control-center-drag-ghost').count(),1,'reparenting the active tile must not end the touch');
  await send('touchEnd');await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>tileActions),0);
  await page.locator('#closeSessionSwitcher').click();await page.waitForFunction(()=>!history.state?.controlCenter);await page.locator('#open').click();
  assert.equal(await page.locator('[data-control-side="after"]>[data-control-tile="magnet"]').count(),1,'the lower tile placement survives reopening');
 }finally{await page.close();}
});

test('forward results dismiss by backdrop and Back while detached progress continues to update',async()=>{
 const page=await browser.newPage({viewport:{width:390,height:844}});try{
  await page.goto(base);await page.locator('#forward').click();
  await page.locator('.history-forward-results').click({position:{x:2,y:2}});
  assert.equal(await page.locator('.history-forward-results').count(),0);
  await page.waitForFunction(()=>!history.state?.forwardHistoryDialog);
  await page.evaluate(()=>{progress.setState('record-1','confirmed');progress.finish('已完成');});
  await page.locator('#forward').click();await page.goBack();
  assert.equal(await page.locator('.history-forward-results').count(),0);assert.equal(await page.locator('#forward').isVisible(),true);
 }finally{await page.close();}
});

test('forward row clicks stay open, and button/Escape consume their own history above control center',async()=>{
 const page=await browser.newPage({viewport:{width:390,height:844}});try{
  await page.goto(base);await page.locator('#open').click();
  for(const method of ['button','Escape','Back']){
   await page.evaluate(()=>document.getElementById('forward').click());await page.locator('.history-forward-row').click();assert.equal(await page.locator('.history-forward-results').count(),1);
   if(method==='button')await page.locator('.history-forward-dialog button').click();else if(method==='Escape')await page.keyboard.press('Escape');else await page.goBack();
   await page.waitForFunction(()=>!document.querySelector('.history-forward-results')&&!history.state?.forwardHistoryDialog);
   assert.equal(await page.locator('.control-center').count(),1,'only the upper forwarding dialog closes');
  }
  await page.goBack();assert.equal(await page.locator('.control-center').count(),0);
 }finally{await page.close();}
});
