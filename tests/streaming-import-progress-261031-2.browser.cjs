'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.argv[2]||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('./support/streaming-console-fixture.cjs');
(async()=>{
 const f=await createFixture();let browser;
 try{
  const device='import-progress-device',secret=device.repeat(3),actor={deviceId:device,userId:null,logins:[]};f.streaming.service.register(device,secret,'Import progress');
  const station=f.streaming.service.create(actor,{name:'本机文件加载测试',creationId:'import-progress'});
  f.app.get('/import-progress-261031',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/streaming-console.css"><link rel="stylesheet" href="/client/themes.css"><script src="/client/streaming-cache.js"></script><script src="/client/streaming-player.js"></script><script src="/client/streaming-console.js"></script><body data-theme="lumen"><script>
   window.showOpenFilePicker=undefined;window.cacheEvents=[];window.failCache=false;
   const source=StreamingCache.source;StreamingCache.source=async(...args)=>{cacheEvents.push({name:args[2].name,phase:'waiting'});await new Promise(resolve=>window.releaseCache=resolve);if(failCache){failCache=false;throw Error('isolated write failure');}const start=performance.now();await source(...args);cacheEvents.push({name:args[2].name,phase:'saved',ms:performance.now()-start});};
   localStorage.setItem('streaming:${device}:key',${JSON.stringify(secret)});
   localStorage.setItem('streaming:${device}:station:${station.id}',JSON.stringify({name:'本机文件加载测试',configVersion:1,items:[],loop:true,countdown:'bottom-right'}));
   localStorage.setItem('streaming:${device}:ui',JSON.stringify({view:'import',stationId:${JSON.stringify(station.id)},scroll:{},drafts:{}}));
   StreamingConsole.init({deviceId:()=>${JSON.stringify(device)},deviceName:()=> 'Import progress',devices:()=>[],tunnels:async()=>[],toast:()=>{},home:()=>{}});StreamingConsole.open();
  </script>`));
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1100,height:780}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.base+'/import-progress-261031');await page.getByRole('button',{name:'选择本机文件',exact:true}).waitFor();
  const select=async files=>{const choice=page.waitForEvent('filechooser');await page.getByRole('button',{name:'选择本机文件',exact:true}).click();await(await choice).setFiles(files);};
  const files=['alpha.txt','beta.txt'].map(name=>({name,mimeType:'text/plain',buffer:Buffer.alloc(2*1048576,65)}));
  await select(files);await page.waitForFunction(()=>cacheEvents.length===1);
  const busy=page.locator('.sc-import-busy');assert.equal(await busy.isVisible(),true,'cache writing must have a visible centered processing status');
  assert.match(await busy.textContent(),/保存.*浏览器缓存/);assert.match(await busy.textContent(),/1\s*\/\s*2.*alpha.txt/);
  const geometry=await busy.evaluate(node=>{const box=node.querySelector('.sc-import-busy-card').getBoundingClientRect(),clip=document.querySelector('.sc-main').getBoundingClientRect();return {x:Math.abs(box.x+box.width/2-clip.x-clip.width/2),y:Math.abs(box.y+box.height/2-clip.y-clip.height/2)};});assert.ok(geometry.x<3&&geometry.y<3,JSON.stringify(geometry));
  await page.locator('[data-sc-minimize]').click();await page.evaluate(()=>StreamingConsole.open());assert.equal(await busy.isVisible(),true,'minimizing/restoring must retain processing feedback');
  await page.evaluate(()=>releaseCache());await page.waitForFunction(()=>cacheEvents.some(x=>x.name==='beta.txt'&&x.phase==='waiting'));assert.match(await busy.textContent(),/2\s*\/\s*2.*beta.txt/);
  await page.evaluate(()=>releaseCache());await page.locator('.sc-candidate').first().waitFor();assert.equal(await page.locator('.sc-candidate').count(),2);assert.equal(await busy.count(),0);
  await page.evaluate(()=>failCache=true);await select([{name:'failure.txt',mimeType:'text/plain',buffer:Buffer.from('failure')}]);await busy.waitFor();await page.evaluate(()=>releaseCache());await page.waitForFunction(()=>!document.querySelector('.sc-import-busy'));assert.equal(await page.locator('.sc-candidate').count(),2,'a failed cache write keeps previous selections');assert.equal(await page.getByRole('button',{name:'选择本机文件',exact:true}).isEnabled(),true);
  await page.evaluate(()=>{window.showOpenFilePicker=async()=>[{name:'handle.txt',async getFile(){window.handleWaiting=true;await new Promise(resolve=>window.releaseHandle=resolve);return new File(['handle bytes'],'handle.txt',{type:'text/plain'});}}];});
  await page.getByRole('button',{name:'选择本机文件',exact:true}).click();await page.waitForFunction(()=>window.handleWaiting);assert.match(await busy.textContent(),/读取.*handle.txt/);
  await page.evaluate(()=>releaseHandle());await page.waitForFunction(()=>cacheEvents.some(x=>x.name==='handle.txt'&&x.phase==='waiting'));assert.match(await busy.textContent(),/保存.*浏览器缓存/);await page.evaluate(()=>releaseCache());await page.waitForFunction(()=>!document.querySelector('.sc-import-busy'));assert.equal(await page.locator('.sc-candidate').count(),3);
  await page.evaluate(()=>window.showOpenFilePicker=undefined);await select([{name:'late.txt',mimeType:'text/plain',buffer:Buffer.from('late bytes')}]);await busy.waitFor();
  await page.locator('[data-sc-view="discover"]').click();await page.locator('.sc-station-list').waitFor();assert.equal(await busy.isVisible(),false,'a pending import must not cover another console page');await page.evaluate(()=>releaseCache());await page.waitForFunction(()=>!document.querySelector('.sc-import-busy'));assert.equal(await page.locator('.sc-import-page').count(),0,'late completion cannot reopen the old importer');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASS',cases:'real source cache, per-file stages, centered status, minimize/restore, failure cleanup',cacheWrites:await page.evaluate(()=>cacheEvents.filter(e=>e.phase==='saved'))}));
 }finally{await browser?.close();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
