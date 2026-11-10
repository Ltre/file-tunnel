'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('./support/streaming-console-fixture.cjs');

test('the full frontend streaming console translates the real navigation in all sixteen languages',{timeout:30000},async t=>{
 const f=await createFixture();t.after(()=>f.close());const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({locale:'en-US'});page.setDefaultTimeout(5000);await page.goto(f.base+'/disk');await page.waitForFunction(()=>!!window.DiskUI);
 for(const name of ['i18n-catalog','i18n','streaming-cache','streaming-player','streaming-console'])await page.addScriptTag({url:f.base+'/client/'+name+'.js'});
 await page.evaluate(async()=>{StreamingConsole.init({deviceId:()=> 'i18n-fixture-device',deviceName:()=> '设置',devices:()=>[],tunnels:async()=>[],home:()=>{},toast:()=>{}});await StreamingConsole.whenReady();StreamingConsole.open();});
 await page.waitForSelector('.sc-nav [data-sc-view="discover"]');
 for(const [language]of await page.evaluate(()=>TunnelI18n.languages)){
  await page.evaluate(language=>TunnelI18n.setLanguage(language),language);
  for(const [view,key]of [['discover','发现'],['local','我创建的'],['bookmarks','我收藏的']]){
   assert.equal(await page.locator('.sc-nav [data-sc-view="'+view+'"]').textContent(),await page.evaluate(key=>TunnelI18n.t(key),key),language+':'+view);
  }
 }
});
