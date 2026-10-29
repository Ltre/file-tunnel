'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const bundled=path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const {chromium}=require(process.argv[2]||process.env.TEST_PLAYWRIGHT||(fs.existsSync(bundled)?bundled:'playwright'));
const {createFixture}=require('./support/streaming-console-fixture.cjs');
const code=(process.env.PREVIEW_RECEIPT_BASELINE==='1'
    ?require('node:child_process').execFileSync('git',['show','HEAD:app.js'],{encoding:'utf8'})
    :fs.readFileSync(path.join(__dirname,'../app.js'),'utf8')).replace(/\r\n/g,'\n');
const section=(a,b)=>code.slice(code.indexOf(a),code.indexOf(b,code.indexOf(a)));

test('完整缓存回执不能撤销尚未首读的预览URL；退出后回收，导航与音乐仍引用时保留', {timeout:60000}, async()=>{
 const f=await createFixture({media:true});let browser;
 try{
  const source=f.sourceFiles.find(s=>s.type==='video/mp4');
  f.app.get('/receipt-video',(_req,res)=>res.type(source.type).send(source.body));
  f.app.get('/receipt-preview',(_req,res)=>res.type('html').send(`<!doctype html><h1 id="filePreviewTitle"></h1><div id="filePreviewViewer" class="active"><div id="filePreviewContent"></div></div><div id="mediaFullscreenViewer"></div><script>
  const state={sessionId:'793caf11-964c-448b-a7b9-738204e29f90'},fileObjectUrls=new Map(),files=new Map(),serverAssetRecoveries={metadata:new Map()},retiredFileObjectUrls=new Map();
  let fileObjectUrlCleanupObserver=null,fileObjectUrlCleanupFrame=0,filePreviewLoadVersion=0,mediaFullscreenItems=[];
  const musicPlayer={queue:[],audio:null,tempAudio:null,overlay:null};
  let activeFilePreviewMode='',activeCollectionPreviewMessageId='',activeFilePreviewFileId='',activeFilePreviewMessageId='',activeFilePreviewOwnerDeviceId='',activeFilePreviewCanFullscreen=false,activeFilePreviewMediaType='',activeFilePreviewStoredFile=null,activeFilePreviewObjectUrl='',filePreviewReturnCollectionMessageId='';
  const targetId='835c3546-9e35-4951-99dd-b777b91849cd';
  let receiptAtFirstRead=false,receiptFlight,releaseRefresh;window.revoked=[];
  const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.revoked.push(url);revoke(url);};
  const cssEscape=CSS.escape;
  const setFilePreviewContentStage=()=>document.getElementById('filePreviewContent'),setFilePreviewTitle=name=>document.getElementById('filePreviewTitle').textContent=name;
  const renderFilePreviewLoading=node=>node.replaceChildren(),setFilePreviewFullscreenButton=()=>{},setFilePreviewLightShareButton=()=>{},setFilePreviewMusicButton=()=>{},setFilePreviewRemoteButton=()=>{},openFilePreviewHistory=()=>{};
  const materializeCachedFileRecord=async value=>value,getFromStore=async(_store,id)=>files.get(id),saveToStore=async(_store,value)=>files.set(value.id,value);
  const getExternalFileSourceState=()=>({}),syncExternalFileSourceUi=async()=>({});
  const hasCompleteFileCache=(file,info)=>file?.data?.byteLength===(info?.size||file?.size);
  const isPreviewableFileType=type=>/^(image|audio|video)\\//.test(type),isVisualPreviewableType=isPreviewableFileType,isFullscreenPreviewableType=isPreviewableFileType;
  const fitPreviewMediaElement=media=>{media.muted=true;if(receiptAtFirstRead){receiptAtFirstRead=false;receiptFlight=callbacks.onReceived(files.get(targetId));}};
  const getCachedMediaPosterOrQueue=file=>file.videoPoster,renderSingleFilePreviewActions=async()=>{},updateFilePreviewNavigationControls=async()=>{},historyLog=()=>{};
  const hideCompletedFileReceiveProgress=()=>{},clearFileMessageAvailability=()=>{},clearServerAssetRecoveryStage=()=>{},notifyMusicLibraryAssetAvailable=()=>{},confirmServerAssetCache=()=>{},refreshOpenSnsMediaClientStates=()=>{};
  const refreshFileMessage=()=>new Promise(resolve=>{releaseRefresh=resolve;});
  ${section(code.includes('function isStoredFileUrlInUse(')?'function isStoredFileUrlInUse(':'function getStoredFileUrl(','\nfunction isInlineDocument(')}
  const callbacks={${section('        onReceived: async (asset) => {',',\n        onUnavailable: (fileId, reason) => {')}};
  ${section('async function openFilePreviewForInfo(','\nasync function openFileRecord(')}
  window.ready=(async()=>{const data=await(await fetch('/receipt-video')).arrayBuffer();files.set(targetId,{id:targetId,name:'synthetic.mp4',type:'video/mp4',size:data.byteLength,data,videoPoster:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVioAAAAASUVORK5CYII=',backupSourceSessionId:'7099a4c9-fa99-405a-937d-a2906bc19e07',serverAssetUrl:'/api/telegram/drive/files/fixture-synthetic/stream'});})();
  window.probe=async inject=>{receiptAtFirstRead=inject;await openFilePreviewForInfo(files.get(targetId),{messageId:'4e891035-3f10-4b78-8fce-9733e59a441f'});const video=document.querySelector('video');
   let message='';try{await video.play();}catch(cause){message=cause.message;}await new Promise(resolve=>setTimeout(resolve,100));
   return {error:video.error?.code||0,ready:video.readyState,poster:!!video.poster,paused:video.paused,message,urlRevoked:window.revoked.includes(video.src),retired:retiredFileObjectUrls.size};};
  window.finishReceipt=async()=>{releaseRefresh?.();await receiptFlight;};
  window.frames=async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);};
  </script>`));
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage(),errors=[];page.on('pageerror',cause=>errors.push(cause.message));await page.goto(f.base+'/receipt-preview');await page.evaluate(()=>window.ready);
  const control=await page.evaluate(()=>window.probe(false));assert.equal(control.error,0,JSON.stringify(control));
  const result=await page.evaluate(()=>window.probe(true));
  assert.equal(result.error,0,JSON.stringify(result));assert.equal(result.paused,false,JSON.stringify(result));assert.equal(result.poster,true);assert.equal(result.urlRevoked,false);
  await page.evaluate(()=>window.finishReceipt());
  await page.evaluate(async()=>{
      const url=activeFilePreviewObjectUrl;mediaFullscreenItems=[{url}];document.getElementById('mediaFullscreenViewer').classList.add('active');
      activeFilePreviewObjectUrl='';document.getElementById('filePreviewContent').replaceChildren();await window.frames();
  });
  assert.equal(await page.evaluate(()=>retiredFileObjectUrls.size),1,'全屏导航仍持有的URL不能被回收');
  await page.evaluate(async()=>{document.getElementById('mediaFullscreenViewer').classList.remove('active');await window.frames();});
  assert.deepEqual(await page.evaluate(()=>({count:retiredFileObjectUrls.size,observing:!!fileObjectUrlCleanupObserver})),{count:0,observing:false});
  await page.evaluate(async()=>{
      const url=getStoredFileUrl(targetId,files.get(targetId));musicPlayer.queue=[{url}];releaseStoredFileUrl(targetId,{preserveInUse:true});await window.frames();
  });
  assert.equal(await page.evaluate(()=>retiredFileObjectUrls.size),1,'音乐队列引用应保留');
  await page.evaluate(async()=>{releaseStoredFileUrl(targetId);await window.frames();});
  assert.equal(await page.evaluate(()=>retiredFileObjectUrls.size),0,'显式清理仍立即撤销退役地址');
  await page.evaluate(async()=>{musicPlayer.queue=[];for(let i=0;i<30;i++){getStoredFileUrl(targetId,files.get(targetId));releaseStoredFileUrl(targetId,{preserveInUse:true});}await window.frames();});
  assert.deepEqual(await page.evaluate(()=>({count:retiredFileObjectUrls.size,observing:!!fileObjectUrlCleanupObserver})),{count:0,observing:false},'无引用的重复回执不得积累地址或观察器');
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await f.close();}
});
