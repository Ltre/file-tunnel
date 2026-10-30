'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(process.argv[2]||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
(async()=>{
 const app=express(),source=read('app.js');
 app.get('/client/theme-preference.js',(_req,res)=>setTimeout(()=>res.type('js').send(read('client/theme-preference.js')),600));
 app.use('/client',express.static(path.join(root,'client')));
 app.get('/downloadList',(_req,res)=>res.type('html').send(read('pages/downloadList.html')));
 const functions=source.slice(source.indexOf('function openDownloadCacheOverlay('),source.indexOf('async function exitTunnelAndClearCache('));
 app.get('/check',(_req,res)=>res.type('html').send(read('pages/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('</body>',`<script>${functions}
 document.getElementById('tunnelStartupLoading').remove();document.body.dataset.theme=localStorage.getItem('uiTheme');document.getElementById('magnetCacheBtn').onclick=openDownloadCacheOverlay;document.getElementById('closeDownloadCacheOverlayBtn').onclick=closeDownloadCacheOverlay;document.getElementById('tunnelTopbar').hidden=false;</script></body>`)));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});const results=[];
  for(const theme of ['orbit','lumen','classic']){
   const context=await browser.newContext({viewport:{width:1280,height:900}});
   await context.addInitScript(theme=>{localStorage.setItem('uiTheme',theme);window.paintSamples=[];function sample(){if(document.body){const style=getComputedStyle(document.body);paintSamples.push({theme:document.body.dataset.theme||'',color:style.backgroundColor});}if(paintSamples.length<100)requestAnimationFrame(sample);}requestAnimationFrame(sample);},theme);
   const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/check');
   for(let cycle=0;cycle<2;cycle++){
    await page.locator('#magnetCacheBtn').click();const background=await page.locator('#downloadCacheFrame').evaluate(n=>({background:getComputedStyle(n).backgroundColor,scheme:getComputedStyle(n).colorScheme}));
    const frame=await page.locator('#downloadCacheFrame').contentFrame();await frame.locator('main').waitFor();await frame.locator('body').evaluate(()=>new Promise(resolve=>setTimeout(resolve,650)));
    const samples=await frame.locator('body').evaluate(()=>window.paintSamples.filter(s=>s.color!=='rgba(0, 0, 0, 0)'));
    results.push({theme,cycle,background,first:samples[0],count:samples.length});
    if(theme==='orbit'){
     assert.equal(background.background,'rgb(17, 20, 29)',JSON.stringify(results.at(-1)));
     assert.ok(samples.length>0&&samples.every(value=>value.theme==='orbit'&&value.color==='rgb(17, 20, 29)'),JSON.stringify(results.at(-1)));
    }else if(theme==='lumen')assert.ok(samples.length>0&&samples.every(value=>value.theme==='lumen'),JSON.stringify(results.at(-1)));
    else assert.ok(samples.every(value=>!value.theme),'classic keeps its standalone appearance');
    await page.locator('#closeDownloadCacheOverlayBtn').click();
   }
   await context.close();
  }
  console.log(JSON.stringify({status:'PASS',results}));
 }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
