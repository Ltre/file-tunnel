'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('./support/streaming-console-fixture.cjs');
test('station list, claim confirmation, editor shortcut and relocated release use the real APIs',async()=>{
 const f=await createFixture();let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1366,height:900}});
  await context.request.get(f.base+'/fixture-account/alice');
  const device='device-A',secret=device.repeat(8),headers={'X-Stream-Device':device,'X-Stream-Key':secret,'X-Disk-Account':'alice'};
  await context.request.post(f.base+'/api/streaming/devices',{data:{deviceId:device,key:secret,name:'Management fixture'}});
  const station=await(await context.request.post(f.base+'/api/streaming/stations',{headers,data:{name:'Owned station',creationId:'manage-owned'}})).json();
  const save=await context.request.put(f.base+'/api/streaming/stations/'+station.id,{headers,data:{configVersion:1,items:[{id:'program',stay:10,source:{kind:'tunnel',sessionId:'fixture-tunnel',messageId:'image-record',fileId:'image-asset',accessGrant:'fixture-proof'}}]}});assert.equal(save.ok(),true,await save.text());
  const anonymous=f.streaming.service.create({deviceId:device,userId:null,logins:[]},{name:'Unowned station',creationId:'manage-unowned'});
  const editorConfig=await(await context.request.get(f.base+'/api/streaming/stations/'+station.id+'/edit-config',{headers})).json();
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(f.base+'/disk');await page.waitForFunction(()=>!!window.DiskUI);
  for(const script of ['streaming-cache','streaming-player','streaming-console'])await page.addScriptTag({url:f.base+'/client/'+script+'.js'});
  await page.evaluate(async({device,secret,id,editorConfig})=>{
   DiskClient.setAccount('alice');localStorage.setItem('streaming:'+device+':key',secret);localStorage.setItem('streaming:'+device+':ui',JSON.stringify({view:'local',stationId:id,scroll:{},drafts:{}}));localStorage.setItem('streaming:'+device+':station:'+id,JSON.stringify(editorConfig));
   StreamingConsole.init({deviceId:()=>device,deviceName:()=> 'Management fixture',tunnels:async()=>[{sessionId:'fixture-tunnel',shortCode:'ABCDE',accessGrant:'fixture-proof'}],devices:()=>[],home:()=>{},toast:()=>{}});await StreamingConsole.whenReady();StreamingConsole.open();
  },{device,secret,id:station.id,editorConfig});
  const row=id=>page.locator('.sc-station-row[data-station-id="'+id+'"]');await row(station.id).waitFor();assert.equal(await page.getByRole('button',{name:'切换归属账号',exact:true}).count(),0);
  let claims=0;page.on('request',req=>{if(req.url().endsWith('/'+anonymous.id+'/ownership')&&req.method()==='POST')claims++;});
  page.once('dialog',dialog=>dialog.dismiss());await row(anonymous.id).getByRole('button',{name:'认领',exact:true}).click();assert.equal(claims,0);assert.equal(f.streaming.service.station(anonymous.id).ownerId,null);
  page.once('dialog',dialog=>dialog.accept());await row(anonymous.id).getByRole('button',{name:'认领',exact:true}).click();await page.waitForFunction(id=>!document.querySelector('[data-station-id="'+id+'"]')?.textContent.includes('无归属'),anonymous.id);assert.equal(claims,1);assert.equal(f.streaming.service.station(anonymous.id).ownerId,'alice');
  await row(station.id).getByRole('button',{name:'编辑节目单',exact:true}).click();const shortcut=page.locator('.sc-editor-title').getByRole('button',{name:'⇥ 前往操控此串流台',exact:true});await shortcut.waitFor();
  const title=await page.locator('.sc-editor-title').boundingBox(),button=await shortcut.boundingBox();assert.ok(Math.abs(title.x+title.width-button.x-button.width)<2);
  await shortcut.click();const release=page.locator('.sc-page > .sc-actions').getByRole('button',{name:'放弃归属',exact:true});await release.waitFor();
  await page.locator('.sc-page > .sc-actions').getByRole('button',{name:'邀请与可见性',exact:true}).click();await page.locator('.sc-page > h1').filter({hasText:'邀请与可见性'}).waitFor();assert.equal(await page.getByRole('button',{name:'放弃归属',exact:true}).count(),0);
  await page.getByRole('button',{name:'返回操控',exact:true}).click();await release.waitFor();page.once('dialog',dialog=>dialog.dismiss());await release.click();assert.equal(f.streaming.service.station(station.id).ownerId,'alice');
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await f.close();}
});
