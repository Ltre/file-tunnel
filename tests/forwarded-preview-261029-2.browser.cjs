'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createFixture } = require('./support/streaming-console-fixture.cjs');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const block = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const bundledPlaywright = path.join(require('node:os').homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const playwright = process.argv[2] || process.env.TEST_PLAYWRIGHT || (fs.existsSync(bundledPlaywright) ? bundledPlaywright : 'playwright');

test('同一视频在A/B预览，取消离开页面或进入bfcache后，poster和媒体内容均仍可读取', { timeout: 60000 }, async () => {
    const f = await createFixture({ media: true }); let browser;
    try {
        const fixture = f.sourceFiles.find(item => item.type === 'video/mp4');
        f.app.get('/forwarded-preview-media', (_req, res) => res.type(fixture.type).send(fixture.body));
        const preview = block('async function openFilePreviewForInfo(', '\nasync function openFileRecord(');
        const url = block('function getStoredFileUrl(', '\nfunction isInlineDocument(');
        const unload = source.match(/window\.addEventListener\('(?:beforeunload|pagehide)',[\s\S]*?\n\}\);/)[0];
        f.app.get('/forwarded-preview-check', (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8">
            <h1 id="filePreviewTitle"></h1><div id="filePreviewViewer"><div id="filePreviewContent"></div></div>
            <script>
            const state={sessionId:'A'},fileObjectUrls=new Map(),editorAssetUrls=new Map(),files=new Map(),retiredFileObjectUrls=new Map();
            let fileObjectUrlCleanupObserver=null,fileObjectUrlCleanupFrame=0,filePreviewLoadVersion=0;
            let activeFilePreviewMode='',activeCollectionPreviewMessageId='',activeFilePreviewFileId='',activeFilePreviewMessageId='',
                activeFilePreviewOwnerDeviceId='',activeFilePreviewCanFullscreen=false,activeFilePreviewMediaType='',activeFilePreviewStoredFile=null,
                activeFilePreviewObjectUrl='',filePreviewReturnCollectionMessageId='';
            const setFilePreviewContentStage=()=>document.getElementById('filePreviewContent');
            const setFilePreviewTitle=name=>document.getElementById('filePreviewTitle').textContent=name;
            const renderFilePreviewLoading=content=>content.replaceChildren();
            const setFilePreviewFullscreenButton=()=>{},setFilePreviewLightShareButton=()=>{},setFilePreviewMusicButton=()=>{},setFilePreviewRemoteButton=()=>{};
            const openFilePreviewHistory=()=>{},materializeCachedFileRecord=async file=>file,getFromStore=async(_store,id)=>files.get(id);
            const getExternalFileSourceState=()=>({}),syncExternalFileSourceUi=async()=>({});
            const hasCompleteFileCache=(file,info)=>file?.data?.byteLength===info.size;
            const isPreviewableFileType=type=>/^(image|audio|video)\\//.test(type),isVisualPreviewableType=isPreviewableFileType,isFullscreenPreviewableType=isPreviewableFileType;
            const fitPreviewMediaElement=media=>{media.muted=true;};
            const getCachedMediaPosterOrQueue=file=>file.videoPoster;
            const renderSingleFilePreviewActions=async()=>{},updateFilePreviewNavigationControls=async()=>{},historyLog=()=>{};
            ${url}\n${preview}\n${unload}
            window.openVideo=async id=>{state.sessionId=id;const file=files.get(id);await openFilePreviewForInfo(file,{messageId:'record-'+id});
                const video=document.querySelector('#filePreviewContent video');
                try{await video.play();await new Promise(resolve=>requestAnimationFrame(resolve));return {id,poster:!!video.poster,error:video.error?.code||0,ready:video.readyState,paused:video.paused};}
                catch(error){return {id,poster:!!video?.poster,error:video?.error?.code||0,message:error.message};}};
            window.ready=(async()=>{const data=await(await fetch('/forwarded-preview-media')).arrayBuffer();
                const poster='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVioAAAAASUVORK5CYII=';
                for(const id of ['A','B'])files.set(id,{id,name:'合成视频.mp4',type:'video/mp4',size:data.byteLength,data,videoPoster:poster});})();
            </script>`));
        const { chromium } = require(playwright); browser = await chromium.launch({ channel: 'chrome', headless: true, args:['--autoplay-policy=no-user-gesture-required'] });
        const page = await browser.newPage(); await page.goto(f.base + '/forwarded-preview-check'); await page.evaluate(() => window.ready);
        for (let i=0;i<4;i++) for (const id of ['A','B']) {
            const state = await page.evaluate(id => window.openVideo(id), id);
            assert.equal(state.error,0,JSON.stringify(state)); assert.equal(state.paused,false,JSON.stringify(state));
        }
        // beforeunload runs even when a user cancels navigation. The document,
        // IndexedDB and cached preview map then stay alive; the media must too.
        await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable:true })));
        const state = await page.evaluate(() => window.openVideo('B'));
        assert.equal(state.error,0,JSON.stringify(state)); assert.equal(state.paused,false,JSON.stringify(state));
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted:true })));
        const restored = await page.evaluate(() => window.openVideo('A'));
        assert.equal(restored.error,0,JSON.stringify(restored)); assert.equal(restored.paused,false,JSON.stringify(restored));
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted:false })));
        assert.equal(await page.evaluate(() => fileObjectUrls.size),0, '真正离开后清理URL登记');
    } finally { await browser?.close(); await f.close(); }
});
