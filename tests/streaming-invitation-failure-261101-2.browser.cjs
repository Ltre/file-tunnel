'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),fs=require('node:fs');
const {chromium}=require(process.argv[2]||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('./support/streaming-console-fixture.cjs');
(async()=>{
 const f=await createFixture();let browser;
 try{
  const owner={deviceId:'device-A',userId:null,logins:[]},viewer='device-B',secret=viewer.repeat(6),service=f.streaming.service;
  service.register(owner.deviceId,owner.deviceId.repeat(6),'Invitation failure owner');service.register(viewer,secret,'Invitation failure viewer');
  const old=service.create(owner,{name:'此前停留的台',creationId:'previous-station'}),target=service.create(owner,{name:'本次受邀的台',creationId:'invited-station'});
  for(const station of [old,target]){await service.edit(station.id,owner,{configVersion:1,loop:true,items:[{id:'fixture-item',stay:30,source:{kind:'tunnel',sessionId:'fixture-tunnel',messageId:'image-record',fileId:'image-asset',accessGrant:'fixture-proof'}}]});service.visibility(station.id,owner,{visibility:'public',version:service.station(station.id).playback.version});}
  const expired=service.invitation(target.id,owner,{}),revoked=service.invitation(target.id,owner,{deviceId:viewer}),valid=service.invitation(target.id,owner,{});
  service.station(target.id).invites.find(invite=>invite.id===expired.id).expiresAt=Date.now()-1000;service.revoke(target.id,owner,revoked.id);
  f.app.get('/invitation-failure-check',(_req,res)=>res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/streaming-console.css"><link rel="stylesheet" href="/client/themes.css"><script src="/client/streaming-player.js"></script><script src="/client/streaming-console.js"></script></head><body data-theme="orbit"><script>
  localStorage.setItem('streaming:${viewer}:key',${JSON.stringify(secret)});localStorage.setItem('streaming:${viewer}:ui',JSON.stringify({view:'watch',stationId:${JSON.stringify(old.id)},scroll:{},drafts:{}}));
  StreamingConsole.init({deviceId:()=>${JSON.stringify(viewer)},deviceName:()=> 'Invitation failure viewer',devices:()=>[],tunnels:async()=>[],toast:()=>{},home:()=>{}});
  </script></body></html>`));
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[],failures=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
  for(const [token,code] of [[expired.token,'STREAM_INVITE_EXPIRED'],[revoked.token,'STREAM_INVITE_REVOKED'],['missing-invitation','STREAM_INVITE_INVALID']]){
   const response=page.waitForResponse(response=>response.url().includes('/invitations/')&&response.request().method()==='POST');
   await page.goto(f.base+'/invitation-failure-check?stream_invite='+token);await response;await page.waitForTimeout(150);
   const actual=await page.evaluate(()=>({page:!!document.querySelector('.sc-invitation-unavailable'),banner:!document.querySelector('.sc-banner')?.hidden,body:document.querySelector('#streamingConsole .sc-page')?.textContent||''}));
   if(!actual.page||actual.banner||actual.body.includes('此前停留的台')||!actual.body.includes(code))failures.push({code,...actual});
  }
  await page.goto(f.base+'/invitation-failure-check?stream_invite='+valid.token);await page.getByRole('heading',{name:/本次受邀的台/}).waitFor();assert.equal(await page.locator('.sc-invitation-unavailable').count(),0,'a valid invitation still opens its own station');
  let release,arrived;const waiting=new Promise(resolve=>arrived=resolve),gate=new Promise(resolve=>release=resolve);
  await page.route('**/api/streaming/invitations/'+expired.token,async route=>{arrived();await gate;await route.continue();});
  const pending=page.evaluate(token=>StreamingConsole.openInvitation(token),expired.token);await waiting;
  if(await page.getByRole('heading',{name:/本次受邀的台/}).count())failures.push('the previous station remained visible while checking an unrelated invitation');
  await page.locator('[data-sc-view="local"]').click();release();await pending;await page.unroute('**/api/streaming/invitations/'+expired.token);
  if(!await page.locator('[data-sc-view="local"]').evaluate(node=>node.classList.contains('selected')))failures.push('a late invitation response replaced a newer navigation');
  if(await page.locator('.sc-banner').isVisible())failures.push('a stale invitation failure appeared above another page');
  let releaseValid,validArrived;const validWaiting=new Promise(resolve=>validArrived=resolve),validGate=new Promise(resolve=>releaseValid=resolve);
  await page.route('**/api/streaming/invitations/'+valid.token,async route=>{validArrived();await validGate;await route.continue();});
  const validPending=page.evaluate(token=>StreamingConsole.openInvitation(token),valid.token);await validWaiting;await page.locator('[data-sc-view="discover"]').click();releaseValid();await validPending;await page.unroute('**/api/streaming/invitations/'+valid.token);
  assert.ok(await page.locator('[data-sc-view="discover"]').evaluate(node=>node.classList.contains('selected')),'a late successful invitation also respects newer navigation');
  await page.route('**/api/streaming/invitations/'+valid.token,route=>route.abort('failed'));
  await page.evaluate(token=>StreamingConsole.openInvitation(token),valid.token);assert.doesNotMatch(await page.locator('#streamingConsole .sc-page').innerText(),/邀请已失效|邀请已过期/,'a connection error must not be described as an expired invitation');
  await page.unroute('**/api/streaming/invitations/'+valid.token);await page.getByRole('button',{name:'重试',exact:true}).click();await page.getByRole('heading',{name:/本次受邀的台/}).waitFor();
  await page.evaluate(token=>StreamingConsole.openInvitation(token),expired.token);await page.locator('.sc-invitation-unavailable').waitFor();
  const output=path.resolve('.npm-cache/invite-failure-261101-2');fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'orbit-invalid-desktop.png')});
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.body.dataset.theme='lumen');await page.screenshot({path:path.join(output,'lumen-invalid-mobile.png')});
  assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);console.log('PASS invalid/expired/revoked invitations replace the prior station; valid invitations, pending navigation and transient failures remain isolated');
 }finally{await browser?.close();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
