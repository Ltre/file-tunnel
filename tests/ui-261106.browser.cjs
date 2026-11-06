'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('./support/streaming-console-fixture.cjs');
let f,browser;
const appSource=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const section=(a,b)=>appSource.slice(appSource.indexOf(a),appSource.indexOf(b,appSource.indexOf(a)));
before(async()=>{
    f=await createFixture({media:true});browser=await chromium.launch({channel:'chrome',headless:true});
    f.app.get('/folder-261106',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/client/disk-directory-picker.css"><link rel="stylesheet" href="/client/themes.css"><body data-theme="orbit"><section style="margin:40px;padding:24px;background:var(--ui-panel);color:var(--ui-ink)"><h2>选择保存到网盘的目录</h2><div id="body"></div></section><script src="/client/disk-directory-picker.js"></script><script>DiskDirectoryPicker.choose({initialPath:'文档',loadDirectories:async()=>({directories:[{path:'文档',name:'文档'},{path:'图片',name:'图片'}]}),openDialog:({body})=>{document.getElementById('body').append(...body);return new Promise(()=>{});}});</script>`));
    f.app.get('/workshop-261106',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/client/web-workshop.css"><body><script src="/client/folder-archive.js"></script><script src="/client/web-workshop.js"></script><script>WebWorkshop.init({deviceId:()=> 'isolated',publishNew:async file=>{window.publishedName=file.name;return 'published';}});WebWorkshop.open();</script>`));
    f.app.get('/resources-261106',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/themes.css"><body data-theme="orbit"><div id="resourceBrowserLayer" class="resource-browser-layer" hidden></div><output id="toast"></output><script>
    const state={sessionId:'isolated',socket:{connected:true}},getSessionResourceInventory=async()=>[],renderMountsInResourceBrowser=async()=>{},initResourceBrowserCapsuleDrag=()=>{},closeResourceBrowser=()=>{},minimizeResourceBrowser=()=>{},restoreResourceBrowser=()=>{},mountLocalDirectory=()=>{},mountLocalFiles=()=>{},historyLog=()=>{};
    const showAppToast=text=>document.getElementById('toast').textContent=text,formatFileSize=value=>value+' B';
    ${section('const resourceCacheRestores =','async function deleteUnreferencedResource(')}
    ${section('function createResourceBrowserButton(','async function saveMountedFiles(')}
    ${section('async function showResourceBrowser(','async function publishHistoryMessage(')}
    showResourceBrowser();</script>`));
});
after(async()=>{await browser?.close();await f?.close();});
for(const [name,api] of [['sns-dl','sns-dl'],['youtube-premium-dl','youtube-premium']])test(name+' uses mouse right click or a single touch hold, never a mouse left hold',async()=>{
    const page=await browser.newPage({hasTouch:true});page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
    try{
        await page.route('**/api/'+api+'/tasks?*',route=>route.fulfill({json:{tasks:[{id:'section',url:'https://x.com/example/status/1',status:'completed',createdAt:Date.now(),downloadSections:'00:00-00:09'}],total:1,page:1,pages:1,pageSize:10,ids:['section']}}));
        await page.goto(f.base+'/'+name);const tab=page.locator('.download-form-tabs button[data-draft-id]').first(),tabs=page.locator('.download-form-tabs');
        await tab.hover();await page.mouse.down();await page.waitForTimeout(650);await page.mouse.up();assert.equal(await tabs.evaluate(n=>n.classList.contains('is-selecting')),false);
        await tab.click({button:'right'});await page.locator('.download-form-tabs.is-selecting').waitFor();assert.equal(await page.getByRole('button',{name:'复制表单',exact:true}).isVisible(),false);
        await page.getByRole('button',{name:'取消表单多选'}).click();
        await tab.dispatchEvent('pointerdown',{pointerType:'touch',pointerId:10,isPrimary:true,button:0});
        await tab.dispatchEvent('pointerdown',{pointerType:'touch',pointerId:11,isPrimary:false,button:0});
        await page.waitForTimeout(650);assert.equal(await tabs.evaluate(n=>n.classList.contains('is-selecting')),false);
        await tab.dispatchEvent('pointerup',{pointerType:'touch',pointerId:10});await tab.dispatchEvent('pointerup',{pointerType:'touch',pointerId:11});
        await tab.dispatchEvent('pointerdown',{pointerType:'touch',pointerId:12,isPrimary:true,button:0});await page.locator('.download-form-tabs.is-selecting').waitFor();
        await tabs.dispatchEvent('contextmenu',{pointerType:'touch',pointerId:12});await tabs.dispatchEvent('pointerup',{pointerType:'touch',pointerId:12});
        assert.equal(await tabs.locator('[data-draft-id][aria-pressed="true"]').count(),1);
        if(name==='sns-dl')assert.match(await page.locator('[data-task-id="section"] .details').textContent(),/指定片段：00:00-00:09/);
        assert.deepEqual(errors,[]);
    }finally{await page.close();}
});
test('Orbit directory selection has its own fill and visible outline, distinct from hover',async()=>{
    const page=await browser.newPage();page.setDefaultTimeout(7000);try{
        await page.goto(f.base+'/folder-261106');const selected=page.locator('.disk-folder-target.selected');await selected.waitFor();
        assert.equal(await selected.getAttribute('data-folder-path'),'文档');const style=await selected.evaluate(n=>({color:getComputedStyle(n).color,bg:getComputedStyle(n).backgroundImage,shadow:getComputedStyle(n).boxShadow}));
        assert.equal(style.color,'rgb(255, 255, 255)');assert.match(style.bg,/linear-gradient/);assert.match(style.shadow,/2px/);
        const other=page.locator('[data-folder-path="图片"]');await other.hover();assert.notEqual(await other.evaluate(n=>getComputedStyle(n).backgroundImage),style.bg);
        await page.screenshot({path:'.npm-cache/261106-orbit-directory.png'});
        await page.evaluate(()=>document.body.dataset.theme='lumen');assert.equal(await selected.evaluate(n=>getComputedStyle(n).backgroundImage),'none');
    }finally{await page.close();}
});
test('workshop accepts and displays bare names but publishes the actual html.zip archive',async()=>{
    const page=await browser.newPage();page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));try{
        await page.goto(f.base+'/workshop-261106');await page.getByRole('button',{name:'＋ 创建网页'}).waitFor();
        await page.evaluate(()=>WebWorkshop.createDraft({name:'示例.html.zip'}));const input=page.locator('[data-web-package-name]');assert.equal(await input.inputValue(),'示例');
        await input.fill('新的网页');await input.blur();assert.equal(await input.inputValue(),'新的网页');
        await page.locator('[data-editor-action="publish"]').click();await page.waitForFunction(()=>window.publishedName);
        assert.equal(await page.evaluate(()=>window.publishedName),'新的网页.html.zip');
        await page.addScriptTag({content:section('function getFileDisplayName(','function webZipNewTabBadge(')});
        assert.deepEqual(await page.evaluate(()=>['示例.html.zip','大写.HTML.ZIP','other.zip'].map(name=>getFileDisplayName({name}))),['示例','大写','other.zip']);
        assert.deepEqual(errors,[]);
    }finally{await page.close();}
});
test('resource browser bulk action stays visible and in the viewport on desktop, tablet and phone',async()=>{
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));try{
        await page.goto(f.base+'/resources-261106');const button=page.getByRole('button',{name:'一键获取缺失缓存',exact:true});await button.waitFor();
        for(const width of [1440,1024,820,390]){
            await page.setViewportSize({width,height:800});
            const bad=await page.locator('.resource-browser-controls').evaluate(node=>[...node.children].filter(n=>{const r=n.getBoundingClientRect();return r.left<0||r.right>innerWidth+1;}).map(n=>n.textContent));
            assert.deepEqual(bad,[],String(width));
        }
        await button.click();assert.match(await page.locator('#toast').textContent(),/没有缺失缓存.*无需获取/);assert.equal(await button.isEnabled(),true);assert.deepEqual(errors,[]);
    }finally{await page.close();}
});
test('miniature follows real portrait/landscape images, video metadata and fallback text across programme changes',async()=>{
    const page=await browser.newPage({viewport:{width:1280,height:800}});page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const actor={deviceId:'mini-261106',userId:null,logins:[]},secret=actor.deviceId.repeat(3);f.streaming.service.register(actor.deviceId,secret,'比例回归');
    try{
        await page.goto(f.base+'/resources-261106');
        const media=[];
        for(const [id,name,w,h]of[['portrait','竖图.png',180,320],['landscape','横图.png',640,240]]){
            const data=await page.evaluate(([w,h])=>{const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const c=canvas.getContext('2d');c.fillStyle='#6688cc';c.fillRect(0,0,w,h);return canvas.toDataURL('image/png').split(',')[1];},[w,h]);
            media.push({id,name,type:'image/png',body:Buffer.from(data,'base64')});
        }
        for(const [id,name]of[['video','合成视频.mp4'],['audio','合成音频.wav'],['text','说明.txt']])media.push({id,...f.sourceFiles.find(file=>file.name===name)});
        for(const file of media)f.records.push({id:file.id+'-261106',type:'file',fileInfo:{id:file.id+'-asset-261106',name:file.name,type:file.type,size:file.body.length,data:'data:'+file.type+';base64,'+file.body.toString('base64')}});
        const station=f.streaming.service.create(actor,{name:'小窗比例',creationId:'mini-261106'});
        await f.streaming.service.edit(station.id,actor,{configVersion:1,loop:true,items:media.map(({id})=>({id,stay:120,...(id==='video'?{duration:6}:id==='audio'?{duration:5}:{}),source:{kind:'tunnel',sessionId:'fixture-tunnel',messageId:id+'-261106',fileId:id+'-asset-261106',accessGrant:'fixture-proof'}}))});
        f.streaming.service.visibility(station.id,actor,{visibility:'public',version:f.streaming.service.station(station.id).playback.version});
        f.app.get('/mini-261106',(req,res)=>{f.sessions.set(req,res,f.auth.user('alice'));res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/streaming-console.css"><body><script src="/client/disk-client.js"></script><script src="/client/streaming-player.js"></script><script src="/client/streaming-console.js"></script><script>localStorage.setItem('streaming:${actor.deviceId}:key',${JSON.stringify(secret)});localStorage.setItem('streaming:${actor.deviceId}:ui',JSON.stringify({view:'watch',stationId:'${station.id}',scroll:{},drafts:{}}));StreamingConsole.init({deviceId:()=> '${actor.deviceId}',deviceName:()=> '比例回归',devices:()=>[],tunnels:async()=>[],toast:()=>{},home:()=>{}});StreamingConsole.open();</script>`);});
        await page.goto(f.base+'/mini-261106');await page.waitForFunction(()=>document.querySelector('.sc-media>img')?.naturalHeight===320);
        await page.getByRole('button',{name:'小窗播',exact:true}).click();const mini=page.locator('.sc-mini-window');
        for(const [id,ratio,selector]of[['portrait',180/320,'img'],['landscape',640/240,'img'],['video',16/9,'video'],['audio',16/9,'audio'],['text',16/9,'.sc-document']]){
            f.streaming.service.control(station.id,actor,{action:'select',itemId:id,version:f.streaming.service.station(station.id).playback.version});
            await page.waitForFunction(({ratio,selector})=>{const mini=document.querySelector('.sc-mini-window'),box=mini?.getBoundingClientRect();return mini?.querySelector('.sc-media>'+selector)&&box&&Math.abs(box.width/box.height-ratio)<.02;},{ratio,selector});
            const box=await mini.boundingBox();assert.ok(box.height<=401&&box.x>=0&&box.y>=0&&box.x+box.width<=1281,JSON.stringify({id,box}));
        }
        await page.screenshot({path:'.npm-cache/261106-mini-fallback.png'});assert.deepEqual(errors,[]);
    }finally{await page.close();}
});
