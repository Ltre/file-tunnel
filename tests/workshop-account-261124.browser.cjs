'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..');
async function fixture(t){const app=express();app.use('/client',express.static(path.join(root,'client')));const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});const browser=await chromium.launch({channel:'chrome',headless:true});t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});return{app,page:await browser.newPage(),url:'http://127.0.0.1:'+server.address().port};}
test('网页工坊：最小化后刷新仍可从顶栏打开，权限刷新不能制造无效入口',{timeout:20000},async t=>{
    const f=await fixture(t),source=fs.readFileSync(path.join(root,'app.js'),'utf8');
    const access=source.slice(source.indexOf('let webZipPublishAllowed='),source.indexOf('async function signWebZipArchive('));
    const start=source.indexOf("    document.getElementById('topbarWorkshopBtn')?.addEventListener('click',"),end=source.indexOf('\n    });',start)+8,click=source.slice(start,end);
    f.app.get('/api/telegram/web-zip/access',(_req,res)=>res.json({allowed:true}));
    f.app.get('/fixture',(_req,res)=>res.type('html').send('<!doctype html><meta charset="utf-8"><button id="webWorkshopBtn">workshop</button><button id="topbarWorkshopBtn" hidden>🌐</button><script src="/client/web-workshop.js"></script><script>const state={sessionId:"test",deviceId:"device",socket:null};window.DiskClient={getAccount:()=>"account"};'+access+';WebWorkshop.init({canPublish:()=>webZipPublishAllowed});'+click+';webWorkshopBtn.onclick=()=>WebWorkshop.open();refreshWebZipAccess();</script>'));
    await f.page.goto(f.url+'/fixture');await f.page.waitForFunction(()=>!webWorkshopBtn.hidden);
    assert.equal(await f.page.locator('#topbarWorkshopBtn').isHidden(),true);
    await f.page.locator('#webWorkshopBtn').click();await f.page.locator('#webWorkshop').waitFor({state:'visible'});
    await f.page.locator('[data-web-minimize]').click();await f.page.locator('#topbarWorkshopBtn').waitFor({state:'visible'});
    await f.page.reload();await f.page.locator('#topbarWorkshopBtn').waitFor({state:'visible'});await f.page.locator('#topbarWorkshopBtn').click();
    await f.page.locator('#webWorkshop .web-workshop-content').waitFor({state:'visible'});
    await f.page.waitForFunction(()=>document.querySelector('.web-workshop-content').childNodes.length>0);
    assert.equal(await f.page.locator('#topbarWorkshopBtn').isHidden(),true);
    await f.page.locator('[data-web-close]').click();await f.page.reload();assert.equal(await f.page.locator('#topbarWorkshopBtn').isHidden(),true);
});
test('旧网页编辑授权确实拒绝时切回申请入口，账号证明失败不误改文件权限',{timeout:20000},async t=>{
    const f=await fixture(t),source=fs.readFileSync(path.join(root,'app.js'),'utf8');
    const pageErrors=[];f.page.on('pageerror',error=>pageErrors.push(error.message));
    const credential=source.slice(source.indexOf('async function requestWebZipEditCredential('),source.indexOf('function renderWebZipRecordLabels('));
    const dialog=source.slice(source.indexOf('function showWebZipEditDialog('),source.indexOf('async function publishWebZipUpdate('));
    f.app.get('/fixture',(_req,res)=>res.type('html').send('<!doctype html><meta charset="utf-8"><body><script>window.alerts=[];window.alert=value=>alerts.push(value);window.DiskClient={getAccount:()=>"account"};let webZipPublishAllowed=true;const webZipApprovalRequired=new Set(),webZipApprovalKey=id=>JSON.stringify([state.sessionId,state.deviceId,id]);window.failure={ok:false,error:"WEB_ZIP_EDIT_DENIED",reason:"NOT_IN_EDITOR_LIST",requiresApproval:true};const state={sessionId:"tunnel",deviceId:"editor",socket:{connected:true,timeout(){return this},emit(name,data,ack){ack(null,failure)}}};const requireWebZipSocketAuth=async()=>({socket:state.socket,sessionId:state.sessionId,deviceId:state.deviceId,accountId:"account"});const formatWebZipText=(text,...values)=>text.replace(/\\{(\\d+)\\}/g,(_,i)=>values[i]),escapeHtml=text=>text;const canEditWebZip=()=>true;const rememberWebZipEditCredential=()=>{};const getWebZipBlob=()=>{throw Error("UNEXPECTED_BYTES_READ")};'+credential+dialog+';window.openEditor=()=>showWebZipEditDialog({id:"file",creatorDeviceId:"creator",name:"old.html.zip"},{messageId:"record"});openEditor();</script>'));
    await f.page.goto(f.url+'/fixture');assert.equal(await f.page.locator('[data-web-zip-action="edit"]').count(),1,pageErrors.join('\n'));await f.page.locator('[data-web-zip-action="edit"]').click();
    await f.page.waitForFunction(()=>alerts.length>0);assert.equal(await f.page.locator('[data-web-zip-action="request"]').count(),1,await f.page.evaluate(()=>alerts.join('\n')));
    await f.page.locator('[data-web-zip-action="request"]').waitFor({state:'visible'});assert.equal(await f.page.locator('[data-web-zip-action="edit"]').count(),0);
    assert.match(await f.page.evaluate(()=>alerts[0]),/NOT_IN_EDITOR_LIST/);
    await f.page.reload();await f.page.evaluate(()=>{failure={ok:false,error:'WEB_ZIP_EDIT_DENIED'};});await f.page.locator('[data-web-zip-action="edit"]').click();
    assert.equal(await f.page.locator('[data-web-zip-action="edit"]').count(),1);assert.equal(await f.page.locator('[data-web-zip-action="request"]').count(),0);
});
test('账号中心：Telegram ID 预填、保留输入、用户名重复提示及已有用户名只读',{timeout:20000},async t=>{
    const f=await fixture(t);f.app.get('/fixture',(_req,res)=>res.type('html').send('<!doctype html><meta charset="utf-8"><p id="identity"></p><p id="status"></p><p id="domainWarning"></p><label id="usernameField"><input id="username"></label><button id="add">add</button><div id="keys"></div><script>window.accountData={identity:{id:"unified-id",telegramId:"123456789",username:"",name:"TG"},passkeys:[],origins:[]};window.calls=[];window.DiskClient={setAccount(){},getAccount:()=>"unified-id",raw:async()=>accountData};window.PasskeyClient={t:x=>x,register:async options=>{calls.push(options);throw Error("USERNAME_EXISTS")}};window.PasskeyView={render(){}};</script><script src="/client/account-center.js"></script>'));
    await f.page.goto(f.url+'/fixture?disk_account=unified-id');await f.page.waitForFunction(()=>!add.disabled);
    assert.equal(await f.page.locator('#username').inputValue(),'123456789');await f.page.locator('#username').fill('chosen-name');await f.page.locator('#add').click();
    await f.page.getByText('用户名已被使用，请填写其他用户名',{exact:true}).waitFor();assert.equal(await f.page.locator('#username').inputValue(),'chosen-name');
    assert.equal(await f.page.evaluate(()=>calls[0].username),'chosen-name');assert.equal(await f.page.evaluate(()=>calls[0].addAccount),false);
    await f.page.addInitScript(()=>{window.fixedUsername='existing_name';});
    await f.page.route('**/client/account-center.js',async route=>{await f.page.evaluate(()=>{accountData.identity.username='existing_name';});await route.continue();});
    await f.page.reload();await f.page.waitForFunction(()=>!add.disabled);assert.equal(await f.page.locator('#username').inputValue(),'existing_name');assert.equal(await f.page.locator('#username').getAttribute('readonly'),'');
});
