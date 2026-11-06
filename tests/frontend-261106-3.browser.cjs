'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),appSource=fs.readFileSync(path.join(root,'app.js'),'utf8'),index=fs.readFileSync(path.join(root,'pages/index.html'),'utf8');
const section=(start,end)=>appSource.slice(appSource.indexOf(start),appSource.indexOf(end,appSource.indexOf(start)));
let server,browser,base;
before(async()=>{
 const app=express();app.use('/client',express.static(path.join(root,'client')));
 app.get('/text',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/client/index.css"><button id="open">编辑</button><script>
 const state={sessionId:'tunnel'},message={id:'record',type:'text',sessionId:'tunnel',text:'开头\\n\\n  结尾 😀'};window.payloads=[];window.fail=false;
 const getFromStore=async()=>message,escapeHtml=value=>String(value).replace(/[&<>"']/g,'_'),RECORD_REMARK_MAX_LENGTH=1000,showAppToast=()=>{};
 const applyHistoryMessageUpdate=async value=>Object.assign(message,value);
 state.socket={connected:true,timeout:()=>({emit:(_event,data,ack)=>{payloads.push(data);ack(null,window.fail?{ok:false,error:'text-conflict'}:{ok:true,message:{...message,text:data.text}});}})};
 ${section('async function editTransferRecordText(','async function editTransferRecordRemark(')}
 ${section('let transferRecordEditorBack = null;','async function chooseForwardTargetSession(')}
 window.backgroundPops=0;window.addEventListener('popstate',()=>backgroundPops++);document.getElementById('open').onclick=()=>editTransferRecordText('record');</script>`));
 app.get('/notifications',(_req,res)=>res.type('html').send(`<!doctype html><link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/notification-center.css">${index.match(/<button class="connection-header-menu-btn"[\s\S]*?<\/button>/)[0]}<button id="notificationCenterBtn">通知中心<span data-notification-count hidden></span></button><script src="/client/notification-center.js"></script><script>NotificationCenter.init({deviceId:()=> 'isolated'});</script>`));
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));});
test('text editor focuses the end, supports fullscreen and confirms dirty cancel/back before discarding',async()=>{
 const page=await browser.newPage({viewport:{width:900,height:700}});try{
 await page.goto(base+'/text');await page.locator('#open').click();const edit=page.locator('textarea');await edit.waitFor();
 await page.waitForFunction(()=>document.activeElement===document.querySelector('textarea'));
 assert.equal(await edit.evaluate(node=>node.selectionStart),await edit.evaluate(node=>node.value.length));
 await page.getByRole('button',{name:'全屏编辑',exact:true}).click();
 const box=await page.locator('.record-remark-editor').boundingBox();assert.ok(box.width>=890&&box.height>=690);
 await page.getByRole('button',{name:'退出全屏编辑',exact:true}).click();
 await edit.fill('改动\n\n内容\n\n');await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.getByRole('alertdialog').waitFor();await page.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(await edit.inputValue(),'改动\n\n内容\n\n');
 await page.goBack();await page.getByRole('alertdialog').waitFor();await page.getByRole('button',{name:'放弃',exact:true}).click();
 await page.locator('textarea').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>payloads.length),0);
 }finally{await page.close();}
});
test('saving from the dirty-close prompt trims ending blank lines and failed saves keep the editor',async()=>{
 const page=await browser.newPage();try{
 await page.goto(base+'/text');await page.locator('#open').click();await page.locator('textarea').fill('  第一行\n\n第二行  \n\n');await page.evaluate(()=>window.fail=true);
 await page.keyboard.press('Escape');await page.getByRole('alertdialog').waitFor();await page.getByRole('alertdialog').getByRole('button',{name:'保存',exact:true}).click();
 await page.locator('.record-edit-status').waitFor();assert.equal(await page.locator('textarea').inputValue(),'  第一行\n\n第二行  \n\n');
 await page.evaluate(()=>window.fail=false);await page.locator('.record-remark-editor').getByRole('button',{name:'保存',exact:true}).click();await page.locator('textarea').waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>payloads.at(-1).text),'  第一行\n\n第二行  ');
 await page.waitForFunction(()=>!history.state?.transferTextEditor);assert.equal(await page.evaluate(()=>backgroundPops),0,'consuming the editor entry must not close an underlying page or preview');
 }finally{await page.close();}
});
test('unread notifications decorate the actual connection-menu button and clear on reading',async()=>{
 const page=await browser.newPage();try{
 await page.goto(base+'/notifications');await page.evaluate(()=>NotificationCenter.add({id:'new',title:'新的通知'}));
 assert.equal(await page.locator('#connectionHeaderMenuBtn [data-notification-dot]').isVisible(),true);
 assert.equal(await page.locator('#notificationCenterBtn [data-notification-count]').textContent(),'1');
 await page.evaluate(()=>NotificationCenter.open());assert.equal(await page.locator('#connectionHeaderMenuBtn [data-notification-dot]').isVisible(),false);
 }finally{await page.close();}
});
