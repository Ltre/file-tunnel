'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('./support/disk-oidc-261012-fixture.cjs');
test('an isolated login window and an unclosable app-return tab still deliver the signed login receipt to the original page',{timeout:20000},async t=>{
 const f=await createFixture({isolateOpener:true});t.after(()=>f.close());const source=fs.readFileSync(path.join(__dirname,'../client/disk-ui.js'),'utf8'),code=source.slice(source.indexOf('function startTelegramDriveLogin('),source.indexOf('\nlet diskExporter'));
 for(const name of ['i18n-catalog.js','i18n.js'])f.app.get('/client/'+name,(_req,res)=>res.type('js').send(fs.readFileSync(path.join(__dirname,'../client',name),'utf8')));
 f.app.get('/fixture-app-return',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><button id="login">登录</button><div id="telegramDriveAuth"></div><output id="result"></output><script>
 let telegramDriveOidcPopup=null,telegramDriveLoginTarget=null,telegramDriveOidcPollGeneration=0,telegramDriveLoginAttempt='',telegramDrivePendingSaveId='';
 window.errors=[];window.toasts=[];window.authenticated='';window.proxyClosedSeen=false;
 window.DiskClient={raw:async(route)=>{const response=await fetch('/api/telegram/drive'+route);return response.json();},getAccount:()=>window.authenticated};
 const switchTelegramDriveAccount=async id=>{window.authenticated=id;},renderTelegramDrive=async()=>{},historyLog=()=>{},showAppToast=value=>window.toasts.push(value);window.alert=value=>window.errors.push(value);
 ${code}
 setInterval(()=>{if(telegramDriveOidcPopup?.closed)window.proxyClosedSeen=true;},10);
 window.addEventListener('message',handleTelegramDriveOidcPopupMessage);window.addEventListener('focus',resumeTelegramDriveOidcLogin);document.addEventListener('visibilitychange',resumeTelegramDriveOidcLogin);document.getElementById('login').onclick=()=>startTelegramDriveLogin();
 </script>`));f.app.get('/fixture-blank',(_req,res)=>res.send('<p>Independent browser tab</p>'));
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const context=await browser.newContext({locale:'en-US'}),original=await context.newPage();
 await original.goto(f.base+'/fixture-app-return#preserve-current-tunnel');const [popup]=await Promise.all([original.waitForEvent('popup'),original.locator('#login').click()]);
 await popup.waitForURL('**/api/telegram/drive/oidc/mock?*');await original.waitForFunction(()=>window.proxyClosedSeen);
 // Authorization in an external app is not instantaneous. Let the original
 // page observe the isolated WindowProxy before the callback arrives.
 await original.waitForTimeout(2750);
 const state=new URL(popup.url()).searchParams.get('state');
 const authorized=await context.request.post(f.base+'/api/telegram/drive/oidc/mock/authorize',{form:{state,telegramUserId:'999000002'},maxRedirects:0});assert.equal(authorized.status(),303);
 const callback=await context.newPage();await callback.goto(f.base+'/fixture-blank');await callback.goto(new URL(authorized.headers().location,f.base).href);
 assert.equal((await(await context.request.get(f.base+'/api/telegram/drive/me')).json()).identity.id,'fixture-999000002','server login is established before the original page receives its result');
 await original.waitForFunction(()=>window.authenticated==='fixture-999000002',null,{timeout:7000});
 assert.equal(original.url(),f.base+'/fixture-app-return#preserve-current-tunnel');assert.deepEqual(await original.evaluate(()=>window.errors),[]);
 assert.equal(callback.isClosed(),false);assert.equal(await callback.evaluate(()=>window.opener),null);
 await callback.waitForTimeout(600);assert.equal((await callback.locator('#telegramOidcPopupStatus').textContent()).includes('已通知原页面'),false);
 assert.equal(await callback.locator('html').getAttribute('lang'),'en');
 assert.equal(await callback.locator('#telegramOidcReturn').textContent(),await callback.evaluate(()=>TunnelI18n.t('返回首页')));assert.equal(await callback.locator('#telegramOidcReturn').getAttribute('href'),f.base+'/');
 await callback.getByRole('button',{name:'Close window',exact:true}).click();await callback.waitForFunction(()=>document.getElementById('telegramOidcPopupStatus').textContent.startsWith('The browser cannot close'));assert.equal(callback.isClosed(),false);
 assert.match(await callback.locator('#telegramOidcPopupStatus').textContent(),/original page|manually/);
 assert.equal((await(await context.request.get(f.base+'/api/telegram/drive/me')).json()).identity.id,'fixture-999000002');
});
