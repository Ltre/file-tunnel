'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..');let browser,server,base;
before(async()=>{
 const app=express();app.use('/client',express.static(path.join(root,'client')));
 app.get('/upstream',(_req,res)=>res.sendFile(path.join(root,'pages/upstream-exits.html')));
 app.get('/workshop',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><script defer src="/client/i18n-bootstrap.js"></script><script defer src="/client/i18n.js"></script><script defer src="/client/web-workshop.js"></script><body></body>`));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));});
test('candidate checkboxes start empty, survive tabs/save/reload, and only selected candidates expose sorting buttons',async()=>{
 const nodes=['A','B','C'].map(id=>({id,name:'Node '+id,server:'fixture.invalid',port:443,revision:1,hasPassword:true}));
 const services=['telegram','youtube'].map(id=>({id,configured:false,defaultExit:'direct',mode:'ordered',order:[],includeDirect:false,revision:0}));
 const page=await browser.newPage({viewport:{width:1200,height:850}});try{
  await page.route('**/api/upstream-exits**',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(request.method()==='PUT'){
    const service=services.find(item=>url.pathname.endsWith('/'+item.id));Object.assign(service,request.postDataJSON(),{configured:true,revision:service.revision+1});return route.fulfill({json:service});
   }
   return route.fulfill({json:{nodes,services,runtimes:[]}});
  });
  await page.goto(base+'/upstream');await page.locator('#service-tab-telegram').waitFor({state:'attached'});await page.locator('details').nth(1).evaluate(n=>n.open=true);
  assert.equal(await page.locator('.exit-order input:checked').count(),0);assert.equal(await page.locator('.exit-order button:visible').count(),0);
  await page.locator('[data-exit-id="C"]').check();await page.locator('[data-exit-id="A"]').check();
  assert.equal(await page.locator('.exit-order button:visible').count(),4);
  await page.getByRole('button',{name:'Node C上移',exact:true}).click();
  await page.locator('#service-tab-youtube').click();assert.equal(await page.locator('.exit-order input:checked').count(),0);
  await page.locator('#service-tab-telegram').click();assert.equal(await page.locator('.exit-order input:checked').count(),2);
  await page.locator('#serviceSettings select').nth(1).selectOption('random');assert.equal(await page.getByRole('button',{name:'Node A上移',exact:true}).evaluate(n=>getComputedStyle(n).cursor),'not-allowed');
  await page.getByRole('button',{name:'保存此服务设置'}).click();await page.waitForFunction(()=>document.querySelector('#upstreamStatus').textContent.includes('已保存'));
  assert.deepEqual(services[0].order,['C','A']);assert.equal(services[1].order.length,0);
  await page.reload();await page.locator('#service-tab-telegram').waitFor({state:'attached'});await page.locator('details').nth(1).evaluate(n=>n.open=true);
  assert.equal(await page.locator('.exit-order input:checked').count(),2);await page.locator('[data-exit-id="A"]').uncheck();assert.equal(await page.locator('.exit-order button:visible').count(),2);
 }finally{await page.close();}
});
test('workshop draft labels translate in all supported languages while names, tunnel codes and file counts remain intact',async()=>{
 const c={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'client/i18n-catalog.js'),'utf8'),c);const catalog=c.window.Drop2TunnelI18nCatalog;
 const page=await browser.newPage({locale:'en-US'});try{
  await page.goto(base+'/workshop');await page.waitForFunction(()=>window.TunnelI18n?.initialized&&window.WebWorkshop);
  await page.evaluate(async()=>{
   WebWorkshop.init({sourceTunnelLabels:async()=>({draft:'来源隧道：ZL5GS'})});
   const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('TunnelWebWorkshop',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
   await new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put({id:'draft',name:'发布',updatedAt:Date.now(),sourceMessageId:'record',sourceSessionId:'session',files:[{path:'index.html',type:'text/html',data:new Uint8Array([65])},{path:'asset.txt',type:'text/plain',data:new Uint8Array([66])}]});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();WebWorkshop.open();
  });
  await page.locator('[data-draft-id="draft"]').waitFor();
  for(const [language]of c.window.Drop2TunnelI18nConfig.languages){
   await page.evaluate(async language=>{await TunnelI18n.setLanguage(language);WebWorkshop.open();},language);
   const expected=key=>language==='zh-Hans'?key:catalog[key][language];
   await page.waitForFunction(text=>document.querySelector('[data-action="publish"]')?.textContent===text,expected('发布'));
   assert.equal(await page.locator('[data-action="source"]').innerText(),'🔗 '+expected('原记录'),language);
   assert.ok((await page.locator('[data-draft-id="draft"] small').innerText()).includes(expected('来源隧道：{0}').replace('{0}','ZL5GS')),language);
   assert.ok((await page.locator('[data-draft-id="draft"] small').innerText()).includes(expected('{0} 个文件').replace('{0}','2')),language);
   assert.equal(await page.locator('.web-draft-title>strong').innerText(),'发布','authored name must not be translated');
  }
 }finally{await page.close();}
});
