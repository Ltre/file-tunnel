'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('./support/pending-save-261012-fixture.cjs');
const {createUpstreamExits}=require('../server/upstream-exits'),{registerUpstreamExitRoutes}=require('../server/upstream-exit-routes');
let fixture,browser,exits;const root=path.resolve(__dirname,'..');
before(async()=>{fixture=await createFixture({i18n:true});exits=createUpstreamExits({dataDir:fixture.dataDir,log:()=>{}});registerUpstreamExitRoutes(fixture.app,{exits,root,requireAuth:(_r,_s,next)=>next()});browser=await chromium.launch({channel:'chrome',headless:true});});
after(async()=>{await browser?.close();await exits?.close();await fixture?.close();});
for(const [view,api,index,label]of [['sns-dl','sns-dl',0,'删除记录'],['youtube-premium-dl','youtube-premium',1,'完全删除']])test(view+': named outlet history remains expanded after reload, deletion feedback waits for the server and slides only on success',{timeout:25000},async t=>{
 const page=await browser.newPage();t.after(()=>page.close());page.on('dialog',dialog=>dialog.accept());let deleted=false,fail=true,release;
 const task={...fixture.tasks[index],networkRoute:{locked:true,selected:{id:'opaque-node-id',name:'最终节点'},attempts:[{name:'最初节点',status:'failed',error:'fixture failure'},{name:'最终节点',status:'success'}]}};
 await page.route('**/api/'+api+'/tasks?*',route=>route.fulfill({json:{tasks:deleted?[]:[task],ids:deleted?[]:[task.id],page:1,pages:1,pageSize:10,total:deleted?0:1}}));
 await page.route('**/api/'+api+'/tasks/'+task.id,async route=>{if(route.request().method()!=='DELETE')return route.fulfill({json:task});await new Promise(resolve=>release=resolve);if(fail)return route.fulfill({status:503,json:{error:'fixture deletion refused'}});deleted=true;return route.fulfill({json:{ok:true}});});
 await page.goto(fixture.base+'/'+view);const card=page.locator('article.task'),history=card.locator('[data-network-route]');await history.waitFor();assert.equal(await history.getAttribute('open'),null);await history.locator('summary').click();await page.waitForTimeout(20);
 assert.match(await history.innerText(),/最初尝试：最初节点/);assert.match(await history.innerText(),/最终采用：最终节点/);assert.doesNotMatch(await history.innerText(),/opaque-node-id/);
 const order=await card.evaluate(card=>{const route=card.querySelector('[data-network-route]'),meta=route.previousElementSibling;return{afterMeta:Boolean(meta?.querySelector('span')),completed:meta?.textContent.includes('完成：')};});assert.equal(order.afterMeta,true);assert.equal(order.completed,true);
 await page.waitForTimeout(2700);assert.notEqual(await history.getAttribute('open'),null);
 const remove=card.getByRole('button',{name:label,exact:true});await remove.click();await card.locator('button[aria-busy=true] .task-loading-spinner').waitFor();assert.equal(await card.count(),1);release();await card.locator('button[aria-busy=true]').waitFor({state:'detached'});assert.equal(await card.count(),1);
 fail=false;await card.getByRole('button',{name:label,exact:true}).click();await card.locator('.task-loading-spinner').waitFor();const animated=page.waitForFunction(()=>Array.from(document.getAnimations()).some(animation=>animation.effect?.target?.matches('article.task')));release();await animated;await card.waitFor({state:'detached'});assert.equal(deleted,true);
});
test('actual task result rendering translates both terminal states in all languages while keeping the task title raw',{timeout:25000},async t=>{
 const page=await browser.newPage();t.after(()=>page.close());page.setDefaultTimeout(6000);await page.request.post(fixture.base+'/fixture-login',{form:{id:'alice'}});
 await page.route('**/api/telegram/drive/operations?*',route=>route.fulfill({json:{operations:['completed','failed'].map((status,index)=>({operation_id:'result-'+index,type:'copy',status,message:index?'操作失败':'操作完成',title:'操作完成.txt',phase:status,percent:100,createdAt:Date.now(),updatedAt:Date.now(),finishedAt:Date.now()}))}}));
 await page.goto(fixture.base+'/disk');await page.waitForFunction(()=>window.DiskUI&&window.TunnelI18n?.initialized);await page.evaluate(()=>{DiskUI.open().catch(error=>window.openError=error.message);});await page.waitForSelector('#diskTaskList .disk-task-row',{state:'attached'});
 for(const [language]of await page.evaluate(()=>TunnelI18n.languages)){await page.evaluate(language=>TunnelI18n.setLanguage(language),language);await page.waitForTimeout(35);
  for(const [index,source]of ['操作完成','操作失败'].entries()){const row=page.locator('#diskTaskList .disk-task-row').filter({has:page.locator('strong>span').filter({hasText:await page.evaluate(source=>TunnelI18n.t(source),source)})});assert.ok(await row.count()>=1,language+source);}
  assert.deepEqual(await page.locator('#diskTaskList strong>span[data-i18n-raw]').allTextContents(),['操作完成.txt · ','操作完成.txt · ']);
 }
});
test('random ordering arrows are disabled with the not-allowed cursor',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());await page.goto(fixture.base+'/upstream-exits');await page.getByText('上游服务出口设置',{exact:true}).click();await page.locator('#serviceSettings select').nth(1).selectOption('random');await page.locator('#serviceSettings label.check input').check();const arrows=page.locator('.exit-order button');await arrows.first().waitFor();for(const button of await arrows.all()){assert.equal(await button.isDisabled(),true);assert.equal(await button.evaluate(node=>getComputedStyle(node).cursor),'not-allowed');}
});
