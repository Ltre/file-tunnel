'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));

test('real share and embedded collaboration pages follow the central preference without rewriting names, paths or prompt defaults',{timeout:30000},async t=>{
 const root=path.resolve(__dirname,'..'),app=express(),writes=[];let missing=false;
 app.use('/client',express.static(path.join(root,'client')));
 app.get('/',(_req,res)=>res.type('html').send('<!doctype html><meta charset="utf-8"><style>iframe{display:block;width:1000px;height:700px;border:0}</style><script defer src="/client/i18n-catalog.js"></script><script defer src="/client/i18n.js"></script><iframe id="collaboration" src="/disk-collab/view/fixture?embedded=1&disk_account=fixture"></iframe><iframe id="share" src="/disk-share/fixture"></iframe>'));
 app.get('/disk-collab/view/fixture',(_req,res)=>res.sendFile(path.join(root,'pages/disk-collaboration.html')));app.get('/disk-share/fixture',(_req,res)=>res.sendFile(path.join(root,'pages/disk-share.html')));
 const file={id:'fixture-file',name:'设置',type:'text/plain',size:6},folder={kind:'directory',name:'名称',path:'设置/名称'},grant={id:'fixture',name:'设置',path:'设置',kind:'directory',role:'editor',owned:false};
 app.get('/api/telegram/disk-shares/fixture',(_req,res)=>res.json({title:'设置',files:[file],folders:[folder]}));
 app.get('/api/telegram/disk-shares/fixture/files/fixture-file/download',(_req,res)=>res.type('text/plain').send('设置'));
 app.use('/api/telegram/drive',express.json(),(req,res)=>{
  if(req.method!=='GET'){writes.push({path:req.path,body:req.body});return res.json({});}
  if(req.path==='/me')return res.json({identity:{id:'fixture'},accounts:[{identity:{id:'fixture'}}]});
  if(req.path==='/collaborations/fixture')return missing?res.status(404).json({error:'COLLABORATION_NOT_FOUND'}):res.json({collaboration:grant});
  if(req.path.endsWith('/list'))return res.json({files:[file],folders:[folder]});
  return res.json({operations:[]});
 });
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage({locale:'en-US'}),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));await page.goto('http://127.0.0.1:'+server.address().port);
 const collab=page.frames().find(frame=>frame.url().includes('/disk-collab/')),share=page.frames().find(frame=>frame.url().includes('/disk-share/'));
 await collab.waitForSelector('.row');await share.waitForSelector('.disk-public-name');
 assert.ok((await collab.locator('#title').textContent()).startsWith('Telegram Drive · '));assert.equal(await share.locator('#shareTitle').textContent(),'设置');
 for(const [language]of await page.evaluate(()=>TunnelI18n.languages)){
  await page.evaluate(language=>TunnelI18n.setLanguage(language),language);
  for(const frame of [collab,share])await frame.waitForFunction(language=>document.documentElement.lang===language,language,{timeout:2000});
  assert.deepEqual(await collab.locator('.row .name').allTextContents(),['名称','设置']);assert.equal(await collab.locator('#breadcrumbs button').first().textContent(),'设置');
  assert.deepEqual(await share.locator('.disk-public-name').allTextContents(),['📁 名称','📄 设置']);
  assert.equal(await share.locator('#shareBreadcrumbs button').first().textContent(),await share.evaluate(()=>TunnelI18n.t('根目录')));
  assert.equal(await collab.locator('.row').last().locator('.actions button').last().textContent(),await collab.evaluate(()=>TunnelI18n.t('删除')));
 }
 await page.evaluate(()=>TunnelI18n.setLanguage('ja'));await collab.waitForFunction(()=>document.documentElement.lang==='ja');
 const promptCaption=await collab.evaluate(()=>TunnelI18n.t('新的名称')),rename=await collab.evaluate(()=>TunnelI18n.t('改名'));
 const dialogPromise=page.waitForEvent('dialog'),click=collab.locator('.row').last().getByRole('button',{name:rename,exact:true}).click();
 const dialog=await dialogPromise;assert.equal(dialog.message(),promptCaption);assert.equal(dialog.defaultValue(),'设置');await dialog.dismiss();await click;
 await share.locator('.disk-public-name').last().click();await share.waitForFunction(()=>!document.getElementById('sharePreview').hidden);
 assert.equal(await share.locator('#sharePreviewName').textContent(),'设置');assert.equal(await share.locator('#sharePreviewBody pre').textContent(),'设置');
 grant.role='viewer';await collab.goto(collab.url());await collab.waitForSelector('.row');await page.evaluate(()=>TunnelI18n.setLanguage('en'));await collab.waitForFunction(()=>document.documentElement.lang==='en');
 assert.equal(await collab.locator('#title').textContent(),'Telegram Drive · Collaborative viewing (read-only): 设置');
 assert.equal(await collab.getByRole('button',{name:'Rename',exact:true}).count(),0,'translation does not change viewer permissions');
 missing=true;await collab.goto(collab.url());await collab.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Cannot open collaborative editing:'));
 assert.match(await collab.locator('#status').textContent(),/\[COLLABORATION_NOT_FOUND\]/);assert.equal(/\p{Script=Han}/u.test(await collab.locator('#status').textContent()),false,'typed UI error explanations translate while their API error code remains intact');
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
});
