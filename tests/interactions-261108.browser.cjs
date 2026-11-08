'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),appCode=fs.readFileSync(path.join(root,'app.js'),'utf8');
const section=(a,b)=>appCode.slice(appCode.indexOf(a),appCode.indexOf(b,appCode.indexOf(a)));
let browser,server,base;
before(async()=>{const app=express();app.use('/client',express.static(path.join(root,'client')));app.get('/entry',(_q,res)=>res.sendFile(path.join(root,'pages/tunnel-entry.html')));app.get('/video-transcode',(_q,res)=>res.sendFile(path.join(root,'pages/video-transcode.html')));app.get('/api/telegram/drive/uploads/:id/progress',(_q,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.write(': connected\n\n');});app.get('/api/telegram/drive/list',(_q,res)=>res.json({path:'folder',files:[]}));server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({channel:'chrome',headless:true});});
after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
test('a fresh desktop route does not move IME input into the second cell; ordinary typing and paste still work',async()=>{
    const context=await browser.newContext(),page=await context.newPage();try{
        await page.goto(base+'/entry?leave=1');await page.locator('#sessionLanding').waitFor();
        const values=await page.evaluate(()=>{const first=document.querySelector('#tunnelCodeInputs input');first.focus();first.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));first.value='a';first.dispatchEvent(new InputEvent('input',{data:'a',isComposing:true,bubbles:true}));const stayed=document.activeElement===first;document.activeElement.dispatchEvent(new CompositionEvent('compositionend',{data:'A',bubbles:true}));first.dispatchEvent(new InputEvent('input',{data:'A',bubbles:true}));return {stayed,values:[...document.querySelectorAll('#tunnelCodeInputs input')].map(node=>node.value)};});
        assert.equal(values.stayed,true);assert.deepEqual(values.values,['A','','','','']);
        await page.locator('#tunnelCodeInputs input').nth(1).pressSequentially('b');assert.equal(await page.locator('#tunnelCodeInputs input').nth(1).inputValue(),'B');
        await page.reload();await page.locator('#tunnelCodeInputs input').first().pressSequentially('x');await page.waitForTimeout(20);assert.deepEqual(await page.locator('#tunnelCodeInputs input').evaluateAll(nodes=>nodes.map(node=>node.value)),['X','','','','']);
        await page.locator('#tunnelCodeInputs input').first().evaluate(node=>{const data=new DataTransfer();data.setData('text/plain','aB3d');node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});assert.deepEqual(await page.locator('#tunnelCodeInputs input').evaluateAll(nodes=>nodes.map(node=>node.value)),['A','B','3','D','']);
    }finally{await context.close();}
});
test('history Shift selection includes both endpoints in either direction and Escape exits without navigation',async()=>{
    const page=await browser.newPage();try{
        await page.goto(base+'/entry?leave=1');await page.setContent('<main><div id="chatMessages">'+Array.from({length:25},(_,n)=>`<article class="message" data-message-id="r${n}" style="height:24px"><span>${n}</span></article>`).join('')+'</div><div id="historySelectionActions" hidden></div></main>');
        await page.addScriptTag({content:`const state={sessionId:'test'},releaseChatScrollAnchorPinByUser=()=>{};${section('const selectedHistoryIds =','async function toggleTransferRecordFavorite(')}initHistoryRecordSelection();window.addEventListener('popstate',event=>historySelectionNavigation.back(event.state));`});
        await page.locator('[data-message-id="r3"]').click({button:'right'});await page.locator('[data-message-id="r20"]').click({modifiers:['Shift']});
        assert.equal(await page.locator('.history-selected').count(),18);
        await page.keyboard.press('Escape');assert.equal(await page.locator('#historySelectionActions').isHidden(),true);assert.equal(await page.locator('.history-selected').count(),0);
        await page.waitForTimeout(60);await page.locator('[data-message-id="r20"]').click({button:'right'});await page.locator('[data-message-id="r3"]').click({modifiers:['Shift']});assert.equal(await page.locator('.history-selected').count(),18);
    }finally{await page.close();}
});
test('Orbit file metadata card uses theme background rather than white',async()=>{
    const page=await browser.newPage();try{await page.setContent('<body data-theme="orbit"><div id="filePreviewContent"><div class="file-preview-metadata">file.doc</div></div>');for(const name of ['index','themes'])await page.addStyleTag({path:path.join(root,'client/'+name+'.css')});assert.equal(await page.locator('.file-preview-metadata').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(26, 31, 45)');}finally{await page.close();}
});
test('transcode logs open at their latest line and preserve a reader who scrolled upward during refresh',async()=>{
    const page=await browser.newPage();try{
        await page.route('**/api/video-transcode/**',route=>route.fulfill({json:route.request().url().endsWith('/tasks')?{tasks:[{id:'t1',fileName:'video.mp4',status:'running',createdAt:1,logs:Array.from({length:20},(_,n)=>'line '+n+' details')}]}:route.request().url().endsWith('/profiles')?{profiles:[]}:{totalBytes:0}}));
        await page.goto(base+'/video-transcode');await page.locator('summary').filter({hasText:'FFmpeg 输出'}).click();const log=page.locator('.task pre');
        assert.equal((await log.textContent()).split('\n').length,20,'each FFmpeg log entry must render as its own line');
        await page.waitForFunction(()=>{const node=document.querySelector('.task pre');return node.scrollTop>0&&node.scrollHeight-node.clientHeight-node.scrollTop<2;});
        await log.evaluate(node=>node.scrollTop=10);await page.getByRole('button',{name:'刷新任务',exact:true}).click();await page.waitForTimeout(80);assert.equal(await log.evaluate(node=>node.scrollTop),10);
        // A polling response can replace a just-opened details element before
        // its queued toggle event or first animation frame has run.
        await page.reload();await page.locator('.task summary').waitFor();
        await page.evaluate(()=>{const details=document.querySelector('.task details');details.open=true;renderTasks();});
        await page.waitForTimeout(80);assert.ok(await log.evaluate(node=>node.scrollHeight-node.clientHeight-node.scrollTop<2),'opening during a poll still starts at the tail');
    }finally{await page.close();}
});
test('upload progress streams leave HTTP/1 connections available for an immediate directory read',async()=>{
    const page=await browser.newPage();try{
        await page.goto(base+'/entry?leave=1');const source=fs.readFileSync(path.join(root,'client/disk-client.js'),'utf8').replace('    window.DiskClient = {','    window.subscribeProgressFixture=subscribeUploadProgress;\n    window.DiskClient = {');await page.addScriptTag({content:source});
        const loaded=await page.evaluate(async()=>{window.streamCleanup=[];for(let n=0;n<8;n++)streamCleanup.push(subscribeProgressFixture({progressive:true,operation_id:'job-'+n,uploadId:'upload-'+n}));await new Promise(resolve=>setTimeout(resolve,250));return Promise.race([fetch('/api/telegram/drive/list?path=folder').then(response=>response.ok),new Promise(resolve=>setTimeout(()=>resolve(false),700))]);});
        assert.equal(loaded,true,'SSE progress must not occupy every browser connection until uploads finish');
    }finally{await page.evaluate(()=>window.streamCleanup?.forEach(close=>close())).catch(()=>{});await page.close();}
});
