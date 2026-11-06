'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('./support/pending-save-261012-fixture.cjs');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),consoleSource=fs.readFileSync(path.join(__dirname,'../client/streaming-console.js'),'utf8');
const section=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
let f,browser;
before(async()=>{
    f=await createFixture();browser=await chromium.launch({channel:'chrome',headless:true});
    f.app.get('/cache-feedback',(req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><body><div id="resourceBrowserLayer"></div><output id="toast"></output>
    <script src="/client/i18n-catalog.js"></script><script src="/client/i18n.js"></script><script>
    const state={sessionId:'isolated',socket:{connected:true}},files=new Map(),editorAssetRequests=new Map(),serverAssetRecoveries={promises:new Map()};
    window.scanResources=[];window.requests=[];const getSessionResourceInventory=async()=>{const values=window.scanResources;window.scanResources=[];return values;};
    const getFromStore=async(_,id)=>files.get(id),saveToStore=async(_,file)=>files.set(file.id,file),hasCompleteFileCache=file=>Boolean(file?.data);
    const fileAssetTransfer={desiredAssets:new Map(),hasDownloadWork:()=>false,request:async(id)=>{requests.push(id);fileAssetTransfer.desiredAssets.set(id,true);}};
    const renderMountsInResourceBrowser=async()=>{},initResourceBrowserCapsuleDrag=()=>{},closeResourceBrowser=()=>{},minimizeResourceBrowser=()=>{},restoreResourceBrowser=()=>{},mountLocalDirectory=()=>{},mountLocalFiles=()=>{},historyLog=()=>{},formatFileSize=value=>value+' B',showFileMessagePlaceholder=()=>{},refreshFileMessage=async()=>{};
    const showAppToast=text=>document.getElementById('toast').textContent=text;
    ${section(app,'const resourceCacheRestores =','async function deleteUnreferencedResource(')}
    ${section(app,'function createResourceBrowserButton(','async function saveMountedFiles(')}
    ${section(app,'async function showResourceBrowser(','async function publishHistoryMessage(')}
    showResourceBrowser();</script>`));
    f.app.get('/source-gesture',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body>
    <aside id="list" style="margin:40px"><p class="sc-watch-item sc-source-item" data-item-id="item" style="padding:24px;border:1px solid"><button id="switch">切换节目</button><span>隧道节目文件.txt</span></p></aside>
    <script>const global=window,error=e=>{throw e};window.opened=0;window.switched=0;document.getElementById('switch').onclick=()=>switched++;
    const programSource=async()=>{opened++;const dialog=document.createElement('div');dialog.className='sc-dialog';dialog.style='position:fixed;inset:0;background:#0004';dialog.innerHTML='<section style="padding:40px;margin:150px 20px;background:white">节目来源<button>关闭</button></section>';dialog.querySelector('button').onclick=()=>dialog.remove();document.body.append(dialog);};
    ${section(consoleSource,'    function bindProgramSources(', '    let listRequest =')}
    window.dispose=bindProgramSources(document.getElementById('list'),()=>({items:[{id:'item',sourceKind:'tunnel'}],configVersion:1}),()=>true);
    </script>`));
    f.app.get('/webpage-labels',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/web-workshop.css"><body><article id="record"><div class="message-bubble file-message"><div class="file-info"><div class="file-name">网页名称</div></div></div></article>
    <script src="/client/i18n-catalog.js"></script><script src="/client/i18n.js"></script><script>
    const state={deviceId:'local'},escapeHtml=value=>String(value).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])),canEditWebZip=file=>file.creatorDeviceId===state.deviceId||file.webZipEditors?.includes(state.deviceId);
    ${section(app,'function formatWebZipText(','function webZipNewTabBadge(')}
    ${section(app,'function showWebZipEditDialog(','async function publishWebZipUpdate(')}
    ${section(app,'function renderFileMessageActions(','let activeFileDetailsMessageId')}
    window.file={id:'zip',name:'page.html.zip',creatorDeviceId:'ae403d44-ca99-420d-b19d-3b7ffbdc3600',creatorDeviceName:'💻 设备-3600',ownerDeviceId:'local',webZip:true,webZipPendingSync:{state:'pending',sessionId:'A',messageId:'source'}};
    renderFileMessageActions(document.getElementById('record'),file,{hasLocalData:true});showWebZipEditDialog(file);
    </script>`));
});
after(async()=>{await browser?.close();await f?.close();});
test('real i18n shows different, numeric feedback for no missing cache, new requests and existing requests',async()=>{
    const page=await browser.newPage();page.setDefaultTimeout(4000);try{
        await page.goto(f.base+'/cache-feedback');const button=page.getByRole('button',{name:'一键获取缺失缓存',exact:true});await button.click();
        const empty=await page.locator('#toast').textContent();assert.match(empty,/没有缺失缓存|无需获取/);assert.doesNotMatch(empty,/\{\d+\}/);
        await page.evaluate(()=>{window.scanResources=[{id:'one'},{id:'two'}];});await button.click();
        const requested=await page.locator('#toast').textContent();assert.notEqual(requested,empty);assert.doesNotMatch(requested,/\{\d+\}/);assert.match(requested,/2/);assert.deepEqual(await page.evaluate(()=>requests),['one','two']);
        await page.evaluate(()=>{window.scanResources=[{id:'one'},{id:'two'}];});await button.click();assert.match(await page.locator('#toast').textContent(),/已有|已有任务/);assert.deepEqual(await page.evaluate(()=>requests),['one','two']);
        await page.evaluate(()=>{TunnelI18n.setLanguage('en');window.scanResources=[{id:'three'}];});await page.locator('.resource-browser-controls button').nth(2).click();assert.doesNotMatch(await page.locator('#toast').textContent(),/\{\d+\}/);assert.match(await page.locator('#toast').textContent(),/Found 1 missing caches/);
    }finally{await page.close();}
});
test('right click on any part of a source row opens its dialog and a retargeted touch menu is cancelled',async()=>{
    const context=await browser.newContext({hasTouch:true,viewport:{width:1000,height:800}}),page=await context.newPage();page.setDefaultTimeout(3000);try{
        await page.goto(f.base+'/source-gesture');await page.locator('#switch').click();assert.equal(await page.evaluate(()=>switched),1,'normal button clicks still switch programmes');
        await page.locator('#switch').click({button:'right'});assert.equal(await page.locator('.sc-dialog').count(),1,'the programme button is part of the row');
        await page.locator('.sc-dialog button').click();
        const row=page.locator('.sc-watch-item span');await row.dispatchEvent('pointerdown',{pointerType:'touch',pointerId:1,isPrimary:true,clientX:160,clientY:80});await page.locator('.sc-dialog').waitFor();
        const cancelled=await page.locator('.sc-dialog').evaluate(node=>!node.dispatchEvent(new PointerEvent('contextmenu',{pointerType:'touch',bubbles:true,cancelable:true,pointerId:1})));
        assert.equal(cancelled,true,'opening a modal must not let the same long press open a native menu on that modal');
        await page.locator('#list').dispatchEvent('pointerup',{pointerType:'touch',pointerId:1});assert.equal(await page.evaluate(()=>opened),2);
        await page.evaluate(()=>{dispose();document.querySelector('.sc-dialog').remove();});
        assert.equal(await page.locator('body').evaluate(node=>node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))),true,'unrelated native menus remain available after cleanup');
    }finally{await context.close();}
});
test('webpage creator semantics and pending sync survive a cache refresh; own creations hide the creator label',async()=>{
    const page=await browser.newPage();page.setDefaultTimeout(3000);try{
        await page.goto(f.base+'/webpage-labels');assert.match(await page.locator('.web-zip-edit-dialog p').textContent(),/该网页由“💻 设备-3600”创建，本设备还没有编辑权限/);
        assert.equal(await page.getByRole('button',{name:'向创建者申请编辑权限',exact:true}).count(),1);assert.match(await page.locator('#record').textContent(),/由 设备3600 创建.*待同步到原网页/);
        await page.evaluate(()=>renderFileMessageActions(document.getElementById('record'),{id:'zip',name:'page.html.zip'},{hasLocalData:true}));assert.equal(await page.locator('.web-zip-record-meta').count(),1);assert.match(await page.locator('#record').textContent(),/由 设备3600 创建/);
        await page.locator('.web-zip-dialog-close').click();await page.evaluate(()=>{state.deviceId=file.creatorDeviceId;renderFileMessageActions(document.getElementById('record'),file,{hasLocalData:true});});
        assert.doesNotMatch(await page.locator('#record').textContent(),/由 设备3600 创建/);assert.equal(await page.locator('.web-zip-sync-pending').count(),1);
        await page.evaluate(()=>{delete file.webZipPendingSync;renderFileMessageActions(document.getElementById('record'),file,{hasLocalData:true});});assert.equal(await page.locator('.web-zip-record-meta').count(),0);
    }finally{await page.close();}
});
test('a native touch menu arriving before the hold timer still arms suppression on the new dialog',async()=>{
    const page=await browser.newPage({hasTouch:true});page.setDefaultTimeout(3000);try{
        await page.goto(f.base+'/source-gesture');const name=page.locator('.sc-watch-item span');
        await name.dispatchEvent('pointerdown',{pointerType:'touch',pointerId:19,isPrimary:true});
        await name.dispatchEvent('contextmenu',{pointerType:'touch',pointerId:19,bubbles:true,cancelable:true});await page.locator('.sc-dialog').waitFor();
        assert.equal(await page.locator('.sc-dialog').evaluate(node=>node.dispatchEvent(new PointerEvent('contextmenu',{pointerType:'touch',pointerId:19,bubbles:true,cancelable:true}))),false);
        await page.locator('body').dispatchEvent('pointerup',{pointerType:'touch',pointerId:19});assert.equal(await page.evaluate(()=>opened),1);
    }finally{await page.close();}
});
