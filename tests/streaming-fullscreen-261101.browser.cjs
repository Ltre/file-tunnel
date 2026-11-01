'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.argv[2]||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('./support/streaming-console-fixture.cjs');
(async()=>{
 const f=await createFixture({media:true});let browser;
 try{
  const file=f.sourceFiles.find(file=>file.type==='video/mp4');
  f.app.get('/fullscreen-video.mp4',(_req,res)=>res.type('video/mp4').send(file.body));
  f.app.get('/fullscreen-check',(_req,res)=>res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/streaming-console.css"><link rel="stylesheet" href="/client/themes.css"><script src="/client/streaming-player.js"></script></head><body><div class="sc-overlay"><main class="sc-page"></main></div><script>
  const controlling=new URL(location.href).searchParams.has('control');document.querySelector('main').classList.toggle('sc-viewer-page',!controlling);
  const snapshot={id:'fullscreen-check',visibility:'public',loop:true,configVersion:1,serverTime:1,manageable:controlling,items:[{id:'video',kind:'video',name:'Synthetic video',duration:120,start:0}],playback:{itemId:'video',position:0,status:'playing',version:1}};
  window.player=StreamingPlayer.create({stationId:snapshot.id,watchId:'fullscreen-watch',onSeek:controlling?async()=>{}:undefined,request:async route=>route.endsWith('/ticket')?{url:'/fullscreen-video.mp4',expiresAt:Date.now()+600000,size:0,type:'video/mp4'}:{},subscribe:()=>()=>{}});
  document.querySelector('main').append(player.element);player.element.querySelector('.sc-local-controls').append(player.element.querySelector('.sc-background-toggle'));player.apply(snapshot);
  </script></body></html>`));
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});page.setDefaultTimeout(10000);const errors=[],failures=[];page.on('pageerror',e=>errors.push(e.message));
  for(const control of [false,true]){
   await page.goto(f.base+'/fullscreen-check'+(control?'?control=1':''));await page.locator('.sc-media>video').waitFor();
   await page.locator('.sc-window-only').click();
   if(await page.locator('.sc-local-pause').isVisible())failures.push('fullscreen controls start visible');
   await page.locator('.sc-stage').tap();assert.equal(await page.locator('.sc-local-pause').isVisible(),true,'touch reveals controls');
   await page.locator('.sc-rotate-fullscreen').click();
   for(const theme of ['classic','lumen','orbit']){
    await page.evaluate(theme=>document.body.dataset.theme=theme,theme);
    const geometry=await page.evaluate(()=>{const host=document.querySelector('.sc-player'),stage=host.querySelector('.sc-stage'),video=host.querySelector('video');return{host:host.clientHeight,stage:stage.clientHeight,video:video.clientHeight,rotated:host.classList.contains('sc-fullscreen-rotated')};});
    assert.equal(geometry.rotated,true);if(!(geometry.stage>=geometry.host-1&&geometry.video>=geometry.host-1))failures.push('rotated video does not fill the full player height '+JSON.stringify({control,theme,...geometry}));
   }
   await page.waitForTimeout(3250);if(await page.locator('.sc-local-pause').isVisible())failures.push('controls did not hide after three seconds');
   await page.mouse.move(100,100);assert.equal(await page.locator('.sc-local-pause').isVisible(),true,'mouse movement reveals controls');
   const sound=page.locator('.sc-sound-toggle');await sound.click();assert.equal(await page.locator('.sc-media>video').evaluate(video=>video.muted),true,'revealed mute remains functional');
   await page.locator('.sc-exit-fullscreen').click();assert.equal(await page.locator('.sc-local-pause').isVisible(),true,'normal controls are restored on exit');
   await page.evaluate(()=>player.close());assert.equal(await page.locator('.sc-player').count(),0);
  }
  assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);console.log('PASS viewer/controller fullscreen: full-height video, default hidden controls, touch/mouse reveal, three-second hide, mute and exit');
 }finally{await browser?.close();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
