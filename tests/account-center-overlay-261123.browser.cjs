'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const express=require('express'),{chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
async function fixture(t,viewport){
    const app=express(),root=path.resolve(__dirname,'..'),requests=[];let server,browser,remark='original';
    t.after(async()=>{await browser?.close();if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
    app.use(express.json());app.use('/client',express.static(path.join(root,'client')));
    app.get('/client/simplewebauthn.js',(_req,res)=>res.sendFile(require('../server/browser-assets').resolvePasskeyBrowserAsset(root)));
    app.get('/account-center',(_req,res)=>res.sendFile(path.join(root,'pages/account-center.html')));
    app.get('/api/telegram/drive/passkeys',(req,res)=>{requests.push({method:req.method,account:req.get('X-Disk-Account')});res.json({identity:{id:req.get('X-Disk-Account'),username:'Alice'},passkeys:[{id:'key-1',rpID:'example.test',remark,createdAt:12345,lastUsedAt:null}],origins:[]});});
    app.patch('/api/telegram/drive/passkeys/key-1',(req,res)=>{requests.push({method:req.method,account:req.get('X-Disk-Account')});remark=req.body.remark;res.json({ok:true});});
    app.get('/fixture',(_req,res)=>res.type('html').send('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/client/account-ui.css"><script src="/client/account-ui.js"></script><button id="accounts">accounts</button><textarea id="draft">unsaved tunnel text</textarea><script>window.focused="alice";window.cancelled=0;window.open=()=>{throw Error("UNEXPECTED_NEW_TAB")};accounts.onclick=()=>AccountUI.open({currentAccount:()=>window.focused,load:async()=>({accounts:[{identity:{id:"alice",name:"Alice"}},{identity:{id:"bob",name:"Bob"}}],status:{}}),select:async()=>{throw Error("UNEXPECTED_ACCOUNT_SWITCH")},renderSignIn(){},cancelSignIn(){window.cancelled++}});</script>'));
    server=http.createServer(app);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-proxy-server']});const context=await browser.newContext({locale:'zh-CN',viewport});
    const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/fixture');
    return {page,context,requests};
}
for(const viewport of [{width:1365,height:850},{width:390,height:844}])test(`账号中心当前视口全屏、原页面及账号保留 ${viewport.width}`,{timeout:30000},async t=>{
    const {page,context,requests}=await fixture(t,viewport),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.locator('#accounts').click();await page.getByText('管理当前账号',{exact:true}).click();
    const dialog=page.locator('dialog.account-center-overlay'),frame=page.frameLocator('.account-center-overlay iframe');
    await frame.locator('#identity').getByText('alice',{exact:false}).waitFor();
    assert.deepEqual(await dialog.boundingBox(),{x:0,y:0,width:viewport.width,height:viewport.height});
    assert.equal(context.pages().length,1);assert.ok(page.url().endsWith('/fixture'));assert.equal(await page.locator('#draft').inputValue(),'unsaved tunnel text');
    assert.equal(await page.evaluate(()=>AccountUI.isOpen()),true);assert.equal(await page.evaluate(()=>window.cancelled),0);
    await page.evaluate(()=>{window.focused='bob';window.postMessage({type:'account-center-close'},location.origin);});
    assert.equal(await dialog.count(),1,'非 iframe 的消息不能关闭账号中心');
    await frame.getByText('修改备注',{exact:true}).click();await frame.locator('dialog input').fill('captured alice');await frame.locator('dialog').getByText('保存',{exact:true}).click();await frame.getByText('captured alice',{exact:true}).waitFor();
    assert.equal(requests.find(item=>item.method==='PATCH')?.account,'alice','父页焦点改变后仍操作入口捕获的账号');
    await frame.getByText('修改备注',{exact:true}).click();await frame.locator('dialog input').press('Escape');await frame.locator('dialog').waitFor({state:'detached'});assert.equal(await dialog.count(),1,'内层备注对话框先处理 Escape');
    await page.goBack();await dialog.waitFor({state:'detached'});assert.equal(await page.evaluate(()=>AccountUI.isOpen()),true);assert.equal(await page.evaluate(()=>window.cancelled),0);
    assert.equal(await page.evaluate(()=>document.body.style.overflow),'');await page.goBack();await page.waitForFunction(()=>!AccountUI.isOpen());assert.equal(await page.evaluate(()=>window.cancelled),1);
    assert.deepEqual(errors,[]);
});
test('账号中心关闭按钮、iframe 返回入口及 Escape 均保留底层账号对话框',{timeout:30000},async t=>{
    const {page}=await fixture(t,{width:430,height:900});await page.locator('#accounts').click();
    for(const mode of ['button','link','escape']){
        await page.getByText('管理当前账号',{exact:true}).click();const frame=page.frameLocator('.account-center-overlay iframe');await frame.locator('#identity').getByText('alice',{exact:false}).waitFor();
        if(mode==='button')await page.locator('.account-center-close').click();else if(mode==='link')await frame.locator('a').getByText('关闭',{exact:true}).click();else await frame.locator('#add').press('Escape');
        await page.locator('dialog.account-center-overlay').waitFor({state:'detached'});await page.waitForFunction(()=>!history.state?.globalAccountCenter);
        assert.equal(await page.evaluate(()=>AccountUI.isOpen()),true);assert.equal(await page.evaluate(()=>window.cancelled),0);
    }
    await page.goBack();await page.waitForFunction(()=>!AccountUI.isOpen());
});
