'use strict';
// Real preview DOM, production fullscreen/gesture functions and CSS; all media
// comes from an isolated synthetic fixture, with injected slow cache reads.
const assert = require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const { createFixture } = require('./support/streaming-console-fixture.cjs');
const root=path.resolve(__dirname,'..'), source=fs.readFileSync(path.join(root,'app.js'),'utf8');
const block=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));

async function run(){
    const f=await createFixture({media:true}); let browser;
    try {
        const video=f.sourceFiles.find(file=>file.type==='video/mp4');
        f.app.get('/preview-video-261029',(_req,res)=>res.type(video.type).send(video.body));
        const functions=[
            block('function getPreviewMediaNaturalSize(', '\nfunction renderFilePreviewLoading('),
            block('function shouldIgnorePreviewGestureTarget(', '\nfunction renderFileMetadataPreview('),
            block('async function getFullscreenPreviewItems(', '\nfunction getRemotePreviewFullscreenState('),
            block('async function openActivePreviewFullscreen(', '\nasync function getCollectionPreviewNavigationFiles('),
            block('function navigateMediaFullscreen(', '\nasync function locateMediaFullscreenRecord('),
            block("    document.getElementById('filePreviewViewer')?.addEventListener('pointerdown'", "    document.getElementById('mediaFullscreenCloseBtn')")
        ].join('\n');
        const html=fs.readFileSync(path.join(root,'pages/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
        f.app.get('/preview-check-261029',(_req,res)=>res.type('html').send(html.replace('</body>',`<script>
            document.getElementById('tunnelStartupLoading').remove();
            const state={sessionId:'isolated-tunnel'},fileObjectUrls=new Map();
            const activeFilePreviewStoredFile={id:'current',name:'合成视频.mp4',type:'video/mp4',data:new Blob(['synthetic'])};
            const activeFilePreviewFileId='current',activeFilePreviewCanFullscreen=true,activeFilePreviewMediaType='video/mp4',activeFilePreviewMessageId='current-record',activeCollectionPreviewMessageId='',activeFilePreviewObjectUrl='/preview-video-261029';
            let mediaFullscreenItems=[],mediaFullscreenIndex=0,mediaFullscreenLoadVersion=0,mediaFullscreenHistoryOpen=false,mediaFullscreenMovedMedia=null,mediaFullscreenMovedParent=null,mediaFullscreenMovedNextSibling=null,mediaFullscreenMovedPlaceholder=null;
            let mediaFullscreenZoom={scale:1,x:0,y:0},mediaFullscreenPointerStart=null,mediaFullscreenGesture={pointers:new Map(),pinch:false},mediaFullscreenMousePan=null,mediaFullscreenSuppressClickUntil=0,filePreviewPointerStart=null;
            let activeRemotePreviewControl=null,suppressNextFilePreviewPopstate=false;
            const MEDIA_FULLSCREEN_HISTORY_KEY='fixture-fullscreen';
            const historyLog=()=>{},getCachedMediaPosterOrQueue=()=>'',isFullscreenPreviewableType=type=>/^(video|audio|image)\\//.test(type);
            const hasCompleteFileCache=file=>Boolean(file?.data),getStoredFileUrl=()=>'/preview-video-261029';
            const compareHistoryMessages=(a,b)=>a.timestamp-b.timestamp,getCollectionFiles=message=>message?.collection?.files||[];
            const navigateFilePreview=async delta=>window.navigated=delta,closeFilePreview=()=>window.closed=true;
            let reads=0; window.cacheReads=()=>reads;
            const getFromStore=async(_store,id)=>{reads++;await new Promise(resolve=>setTimeout(resolve,20));return id==='missing'?null:activeFilePreviewStoredFile;};
            const getCurrentSessionMessages=async()=>[{id:'current-record',type:'file',timestamp:0,fileInfo:{id:'current',name:'合成视频.mp4',type:'video/mp4'}},...Array.from({length:100},(_,i)=>({id:'record-'+i,type:'file',timestamp:i+1,fileInfo:{id:'other-'+i,name:'其它'+i+'.mp4',type:'video/mp4'}}))];
            const viewer=document.getElementById('filePreviewViewer'),content=document.getElementById('filePreviewContent');
            window.gestureEvents=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])viewer.addEventListener(type,event=>window.gestureEvents.push({type,target:event.target.tagName,x:event.clientX,y:event.clientY,primary:event.isPrimary}),true);
            viewer.classList.add('active');content.classList.add('preview-media-stage');
            const media=document.createElement('video');media.src='/preview-video-261029';media.controls=true;media.muted=true;media.playsInline=true;media.dataset.previewFileId='current';content.append(media);window.previewMedia=media;
            ${functions}
            document.getElementById('filePreviewFullscreenBtn').hidden=false;
            document.getElementById('filePreviewFullscreenBtn').onclick=()=>{window.openStarted=performance.now();openActivePreviewFullscreen().then(()=>window.openElapsed=performance.now()-window.openStarted);};
            document.getElementById('mediaFullscreenCloseBtn').onclick=()=>closeMediaFullscreen({forceClose:true});
            window.fixtureReady=true;
        </script></body>`)));
        browser=await chromium.launch({channel:'chrome',headless:true});
        const results=[];
        for(const width of [1366,1024]){
            const context=await browser.newContext({viewport:{width,height:900},hasTouch:true});
            const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
            await page.goto(f.base+'/preview-check-261029');await page.waitForFunction(()=>window.fixtureReady);
            await page.locator('#filePreviewContent video').waitFor();await page.waitForFunction(()=>window.previewMedia.readyState>=1);
            await page.locator('#filePreviewFullscreenBtn').click();
            await page.waitForFunction(()=>Number.isFinite(window.openElapsed));
            const opened=await page.evaluate(()=>({elapsed:window.openElapsed,reads:cacheReads(),same:document.querySelector('#mediaFullscreenContent video')===window.previewMedia}));
            assert.ok(opened.elapsed<200,JSON.stringify(opened));assert.ok(opened.reads<10,JSON.stringify(opened));assert.equal(opened.same,true);
            await page.waitForFunction(()=>mediaFullscreenItems.length===101);
            await page.evaluate(()=>{navigateMediaFullscreen(1);window.nextId=mediaFullscreenItems[mediaFullscreenIndex].fileInfo.id;});
            assert.equal(await page.evaluate(()=>window.nextId),'other-0');
            await page.locator('#mediaFullscreenCloseBtn').click();
            const box=await page.locator('#filePreviewContent video').boundingBox(),cdp=await context.newCDPSession(page);
            const x=box.x+box.width/2,y=box.y+Math.min(box.height/2,150);
            await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
            for(const step of [10,20,30,40]){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-step,id:1}]});await page.evaluate(()=>new Promise(requestAnimationFrame));}
            assert.equal(await page.locator('#mediaFullscreenViewer').evaluate(node=>node.classList.contains('active')),true,'应在40px明确上划后进入全屏 '+JSON.stringify(await page.evaluate(()=>window.gestureEvents)));
            await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
            assert.equal(await page.locator('#mediaFullscreenViewer').evaluate(node=>node.classList.contains('active')),true,'同一次上划的抬手不能关闭刚打开的全屏');
            assert.deepEqual(errors,[]);results.push({width,opened,upSwipe:true});await context.close();
        }
        console.log(JSON.stringify({status:'PASS',cases:results}));
    }finally{await browser?.close();await f.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
