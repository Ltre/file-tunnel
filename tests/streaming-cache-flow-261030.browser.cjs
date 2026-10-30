'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.argv[2]||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('./support/streaming-console-fixture.cjs');
(async()=>{
 const f=await createFixture();let browser;
 try{
  const device='cache-flow-owner',secret=device.repeat(3),actor={deviceId:device,userId:null,logins:[]};f.streaming.service.register(device,secret,'Cache source');
  const station=f.streaming.service.create(actor,{name:'Persistent source',creationId:'cache-flow'});
  f.app.get('/cache-flow',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/client/streaming-console.css">
   <script src="/client/streaming-cache.js"></script><script src="/client/streaming-player.js"></script><script src="/client/streaming-console.js"></script>
   <body><script>showOpenFilePicker=undefined;localStorage.setItem('streaming:${device}:key',${JSON.stringify(secret)});
   if(!localStorage.getItem('streaming:${device}:ui'))localStorage.setItem('streaming:${device}:ui',JSON.stringify({view:'edit',stationId:${JSON.stringify(station.id)},scroll:{},drafts:{}}));
   if(!localStorage.getItem('streaming:${device}:station:${station.id}'))localStorage.setItem('streaming:${device}:station:${station.id}',JSON.stringify({name:'Persistent source',configVersion:1,items:[],loop:true,countdown:'bottom-right'}));
   StreamingConsole.init({deviceId:()=>${JSON.stringify(device)},deviceName:()=> 'Cache source',devices:()=>[],tunnels:async()=>[],toast:()=>{},home:()=>{}});StreamingConsole.open();</script>`));
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();page.setDefaultTimeout(12000);
  const bodies=[];page.on('request',request=>{if(/\/api\/streaming\/media\//.test(request.url()))bodies.push(request.url());});
  await page.route('**/api/streaming/provider-work/**',route=>route.abort());await page.goto(f.base+'/cache-flow');
  await page.getByRole('button',{name:'导入',exact:true}).click();
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVioAAAAASUVORK5CYII=','base64');
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'选择本机文件',exact:true}).click();await (await chooser).setFiles([{name:'persisted.png',mimeType:'image/png',buffer:image}]);
  await page.locator('.sc-candidate').waitFor();await page.locator('.sc-import-actions').getByRole('button',{name:'导入',exact:true}).click();
  let saves=0;await page.route('**/api/streaming/stations/'+station.id,async route=>{
   if(route.request().method()!=='PUT')return route.continue();saves++;if(saves===1){await route.fetch();return route.abort('connectionreset');}return route.continue();
  });
  await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('button',{name:'上线',exact:true}).click();assert.equal(saves,1,'committed save with a lost reply must not be repeated');await page.getByRole('button',{name:'公开',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='邀请与可见性');await page.evaluate(()=>window.dispatchEvent(new PopStateEvent('popstate')));
  await page.waitForFunction(()=>document.querySelector('.sc-media>img')?.naturalWidth>0);
  await page.reload();await page.waitForFunction(()=>document.querySelector('.sc-media>img')?.naturalWidth>0);
  assert.equal(bodies.length,0,'reloaded creator must play its persisted file without uploading to itself');
  const snapshot=await page.evaluate(async([device,id])=>{const cfg=JSON.parse(localStorage.getItem('streaming:'+device+':station:'+id));return {items:cfg.items.length,garbage:(await StreamingCache.garbage()).length};},[device,station.id]);
  assert.deepEqual(snapshot,{items:1,garbage:0});
  console.log('PASS actual importer persists source bytes; save, publish and page reload play locally with no provider upload/media body route');
 }finally{await browser?.close();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
