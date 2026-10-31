'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const {chromium}=require(process.argv[2]||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('./support/streaming-console-fixture.cjs');
(async()=>{
 const f=await createFixture();let browser;
 try{
  const actor={deviceId:'viewer-261031-2',userId:null,logins:[]},secret=actor.deviceId.repeat(3);f.streaming.service.register(actor.deviceId,secret,'Viewer layout');
  const station=f.streaming.service.create(actor,{name:'长标题观看台 · 检查封面与多行标题底部对齐',creationId:'viewer-261031-2'});
  await f.streaming.service.edit(station.id,actor,{configVersion:1,loop:true,items:Array.from({length:30},(_,i)=>({id:'program-'+i,stay:300,source:{kind:'tunnel',sessionId:'fixture-tunnel',messageId:'image-record',fileId:'image-asset',accessGrant:'fixture-proof'}}))});
  f.streaming.service.visibility(station.id,actor,{visibility:'public',version:f.streaming.service.station(station.id).playback.version});
  f.app.get('/viewer-261031-2',(_req,res)=>res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/themes-legacy.css"><link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/streaming-console.css"><link rel="stylesheet" href="/client/themes.css"><script src="/client/streaming-player.js"></script><script src="/client/streaming-console.js"></script></head><body data-theme="lumen"><script>
  localStorage.setItem('streaming:${actor.deviceId}:key',${JSON.stringify(secret)});localStorage.setItem('streaming:${actor.deviceId}:ui',JSON.stringify({view:'watch',stationId:${JSON.stringify(station.id)},scroll:{},drafts:{}}));
  StreamingConsole.init({deviceId:()=>${JSON.stringify(actor.deviceId)},deviceName:()=> 'Viewer layout',devices:()=>[],tunnels:async()=>[{sessionId:'fixture-tunnel',accessGrant:'fixture-proof'}],toast:()=>{},home:()=>{}});StreamingConsole.open();
  </script></body></html>`));
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1280,height:900},hasTouch:true}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
  await page.goto(f.base+'/viewer-261031-2');await page.locator('.sc-watch-item').first().waitFor();await page.waitForFunction(()=>document.querySelector('.sc-play-status')?.dataset.status==='reading');
  const output=[];fs.mkdirSync(path.resolve('.npm-cache/viewer-261031-2'),{recursive:true});
  for(const [width,height] of [[1280,900],[768,900],[390,844],[320,568],[600,400]]){
   await page.setViewportSize({width,height});await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,150)));
   const geometry=await page.evaluate(()=>{
    const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
    return{cover:rect('.sc-viewer-cover-small'),title:rect('.sc-viewer-title'),volume:rect('.sc-volume-control'),background:rect('.sc-background-toggle'),stage:rect('.sc-player'),clip:rect('.sc-main'),playlist:rect('.sc-watch-grid>aside'),large:document.querySelectorAll('.sc-viewer-page>.sc-viewer-cover').length,inside:document.querySelector('.sc-local-controls')===document.querySelector('.sc-background-toggle').closest('.sc-local-controls')};
   });
   assert.equal(geometry.large,0,'no independent wide cover');assert.equal(geometry.cover.w,44);assert.ok(Math.abs(geometry.cover.bottom-geometry.title.bottom)<1,JSON.stringify({width,height,...geometry}));assert.equal(geometry.inside,width<=767);
   if(width<=767){
    assert.ok(geometry.background.x>=geometry.volume.right-1&&Math.abs(geometry.background.y-geometry.volume.y)<12,'background toggle follows the volume control '+JSON.stringify({width,height,...geometry}));
    await page.locator('.sc-main').evaluate(node=>node.scrollTop=99999);await page.evaluate(()=>new Promise(requestAnimationFrame));
    const scrolled=await page.evaluate(()=>{const a=document.querySelector('.sc-player').getBoundingClientRect(),b=document.querySelector('.sc-main').getBoundingClientRect(),p=document.querySelector('.sc-watch-grid>aside').getBoundingClientRect();return{top:a.top,bottom:a.bottom,clipTop:b.top,clipBottom:b.bottom,playlist:p.height};});
    assert.ok(scrolled.top>=scrolled.clipTop-1&&scrolled.top<=scrolled.clipTop+2,'outer scrolling stops at the player top '+JSON.stringify({width,height,...scrolled}));
    assert.ok(scrolled.bottom<=scrolled.clipBottom+1,'the complete player stays inside the viewport '+JSON.stringify({width,height,...scrolled}));assert.ok(scrolled.playlist>=70,JSON.stringify({width,height,...scrolled}));
    await page.locator('.sc-watch-grid>aside').evaluate(node=>node.scrollTop=node.scrollHeight);assert.ok(await page.locator('.sc-watch-item').last().evaluate(node=>{const r=node.getBoundingClientRect(),p=node.parentElement.getBoundingClientRect();return r.bottom<=p.bottom+1&&r.bottom>=p.top;}),'last program remains reachable');
   }
   output.push({width,height,geometry});
  }
  await page.setViewportSize({width:320,height:568});
  await page.evaluate(()=>{document.querySelector('.sc-volume-control').firstChild.textContent='Local volume';document.querySelector('.sc-background-toggle').firstChild.textContent='Background playback';});
  assert.ok(await page.locator('.sc-local-controls').evaluate(node=>{const a=node.querySelector('.sc-volume-control').getBoundingClientRect(),b=node.querySelector('.sc-background-toggle').getBoundingClientRect(),c=node.getBoundingClientRect();return node.scrollWidth<=node.clientWidth&&b.left>=a.right-1&&b.right<=c.right+1&&Math.abs(a.y-b.y)<12;}),'long English preferences stay together without horizontal overflow');
  await page.setViewportSize({width:390,height:844});await page.locator('.sc-background-toggle input').uncheck();assert.equal(await page.evaluate(()=>localStorage.getItem('streaming-background-playback')),'off');
  await page.locator('[data-sc-minimize]').click();await page.waitForFunction(()=>document.querySelector('.sc-play-status')?.textContent.includes('后台播放已关闭'));await page.evaluate(()=>StreamingConsole.open());
  await page.locator('.sc-background-toggle input').check();await page.locator('.sc-window-only').click();
  assert.equal(await page.locator('.sc-background-toggle').isVisible(),true);assert.ok(await page.locator('.sc-stage').evaluate(node=>node.getBoundingClientRect().height>innerHeight*.65),'fullscreen stage must use the fullscreen area rather than the ordinary viewer height limit');await page.locator('.sc-exit-fullscreen').click();
  await page.screenshot({path:path.resolve('.npm-cache/viewer-261031-2/viewer-mobile.png')});
  await page.evaluate(()=>{globalThis.retainedPlayer=document.querySelector('.sc-player');globalThis.retainedBackground=document.querySelector('.sc-background-toggle input');});
  const commands=[];page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/control'))commands.push(request.url());});
  await page.getByRole('button',{name:'操控串流台',exact:true}).click();await page.getByRole('button',{name:'以观众视角查看',exact:true}).waitFor();
  for(const width of [390,1280]){
   await page.setViewportSize({width,height:844});
   assert.ok(await page.locator('.sc-background-toggle').evaluate(node=>node.parentElement.matches('.sc-local-controls')),'controller background toggle stays in the control bar at '+width);
   await page.locator('.sc-background-toggle input').uncheck();assert.equal(await page.evaluate(()=>localStorage.getItem('streaming-background-playback')),'off');await page.locator('.sc-background-toggle input').check();
   await page.locator('.sc-window-only').click();
   assert.ok(await page.locator('.sc-background-toggle').evaluate(node=>{const a=node.getBoundingClientRect(),b=node.parentElement.getBoundingClientRect();return parseFloat(getComputedStyle(node).fontSize)>=11&&a.width>40&&a.left>=b.left-1&&a.right<=b.right+1&&a.bottom<=b.bottom+1;}),'controller fullscreen checkbox remains readable within its control bar');
   await page.locator('.sc-exit-fullscreen').click();
  }
  await page.getByRole('button',{name:'以观众视角查看',exact:true}).click();await page.locator('.sc-viewer-page .sc-watch-item').first().waitFor();
  assert.equal(await page.locator('.sc-global-controls').count(),0,'audience view does not retain global control buttons');
  assert.ok(await page.evaluate(()=>document.querySelector('.sc-player')===retainedPlayer&&document.querySelector('.sc-background-toggle input')===retainedBackground),'switching perspective reuses the player and its checkbox');assert.deepEqual(commands,[],'view changes do not issue playback commands');
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'返回列表',exact:true}).click();await page.getByRole('button',{name:'+ 创建',exact:true}).click();await page.locator('.sc-expand-basic').waitFor();
  assert.equal(await page.locator('.sc-expand-basic>svg').count(),1);await page.locator('.sc-expand-basic').click();assert.equal(await page.locator('.sc-basic-expanded').count(),1);
  for(const theme of ['lumen','orbit','classic','atelier','social']){
   await page.evaluate(theme=>document.body.dataset.theme=theme,theme);await page.locator('.sc-collapse-basic').scrollIntoViewIfNeeded();
   await page.screenshot({path:path.resolve('.npm-cache/viewer-261031-2/collapse-'+theme+'.png')});
  }
  await page.getByRole('button',{name:'收起',exact:true}).click();assert.equal(await page.locator('.sc-basic-expanded').count(),0);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASS',cases:output}));
 }finally{await browser?.close();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
