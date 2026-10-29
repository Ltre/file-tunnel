'use strict';
// Read-only business-code audit on synthetic data. Reports retained bytes;
// deliberately does not change the app or try to crash a browser.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.argv[2]||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('../support/streaming-console-fixture.cjs');
const code=fs.readFileSync(path.resolve('app.js'),'utf8');
const section=(a,b)=>{const start=code.indexOf(a),end=code.indexOf(b,start);if(start<0||end<0)throw Error('Missing audit seam: '+a);return code.slice(start,end);};
(async()=>{
 const f=await createFixture();let browser;
 try{
  f.app.get('/memory-audit',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><h1>Isolated memory audit</h1><script>
   const bytes=512*1024,count=65,fileObjectUrls=new Map(),liveUrls=new Map(),mediaPosterQueue=[],mediaPosterQueuedIds=new Set();
   let mediaPosterQueueRunning=true,clock=100000,presenceReleased=false;const pendingPresence=[];
   const state={sessionId:'synthetic',socket:{connected:true}},timers=[];
   Date.now=()=>clock;window.setInterval=run=>{timers.push(run);return timers.length;};
   const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
   URL.createObjectURL=blob=>{const url=create(blob);liveUrls.set(url,blob.size);return url;};
   URL.revokeObjectURL=url=>{liveUrls.delete(url);revoke(url);};
   const make=id=>({id,name:id+'.mp4',type:'video/mp4',size:bytes,data:new ArrayBuffer(bytes),isFileAsset:true,sessionId:'synthetic'});
   const getFromStore=async(_store,id)=>make(id),getAllFromStore=async()=>{
    const files=Array.from({length:count},(_,i)=>make('file-'+i));
    files[0]={id:'external',name:'external.mp4',size:bytes,type:'video/mp4',externalFileHandle:{queryPermission:async()=> 'granted',getFile:async()=>{
     if(!presenceReleased)await new Promise(resolve=>pendingPresence.push(resolve));return new File([new Uint8Array(bytes)],'external.mp4',{type:'video/mp4'});
    }}};return files;
   };
   const hasCompleteFileCache=()=>true,hideCompletedFileReceiveProgress=()=>{},getExternalFileSourceState=()=>({}),
    getCachedMediaPosterOrQueue=()=>'',preserveChatScroll=run=>run(),refreshCollectionMessagesForFile=async()=>{},
    refreshCollectionPreviewCardForFile=async()=>{},refreshActiveFilePreviewForFile=async()=>{},
    shouldGenerateMediaPoster=()=>true,historyLog=()=>{},confirmServerAssetCache=()=>{};
   const fileAssetTransfer={announce:async()=>{},resumePending(){}};
   ${section('async function materializeExternalFileRecord(','\nfunction initFileAssetTransfer(')}
   ${section('async function refreshFileMessage(','\nasync function refreshCollectionMessagesForFile(')}
   ${section('function enqueueMediaPosterCache(','\nfunction getCachedMediaPosterOrQueue(')}
   ${section('async function announceStoredFileAssets(','\nasync function handleFileAssetDiscovery(')}
   window.auditRefresh=async()=>{for(let i=0;i<count;i++)await refreshFileMessage('file-'+i);return {urls:fileObjectUrls.size,blobBytes:[...liveUrls.values()].reduce((a,b)=>a+b,0),visibleMedia:document.querySelectorAll('video,img').length};};
   window.auditQueue=()=>{for(let i=0;i<count;i++)enqueueMediaPosterCache('queue-'+i,make('queue-'+i));return {queued:mediaPosterQueue.length,retainedBufferBytes:mediaPosterQueue.reduce((n,t)=>n+(t.fileInfo.data?.byteLength||0),0)};};
   window.auditPresence=async()=>{window.presenceFlights=[announceStoredFileAssets(),announceStoredFileAssets()];for(let i=0;i<3;i++)await new Promise(resolve=>queueMicrotask(resolve));return {inflightLists:pendingPresence.length,cachedBuffersPerList:count-1,bytesPerList:bytes*(count-1),blocking:'controlled delay in external handle.getFile()'};};
   window.auditRelease=async()=>{presenceReleased=true;pendingPresence.splice(0).forEach(resolve=>resolve());await Promise.all(window.presenceFlights||[]);mediaPosterQueue.length=0;mediaPosterQueuedIds.clear();for(const url of fileObjectUrls.values())URL.revokeObjectURL(url);fileObjectUrls.clear();};
  </script>`));
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(f.base+'/memory-audit');
  const cdp=await page.context().newCDPSession(page),report={fixtureFiles:65,bytesPerFile:512*1024};
  report.before=await cdp.send('Runtime.getHeapUsage');
  report.refresh=await page.evaluate(()=>auditRefresh());
  report.repeatRefresh=await page.evaluate(()=>auditRefresh());
  await cdp.send('HeapProfiler.collectGarbage');report.afterRefresh=await cdp.send('Runtime.getHeapUsage');
  report.queue=await page.evaluate(()=>auditQueue());
  await cdp.send('HeapProfiler.collectGarbage');report.afterQueue=await cdp.send('Runtime.getHeapUsage');
  report.presence=await page.evaluate(()=>auditPresence());
  await cdp.send('HeapProfiler.collectGarbage');
  report.retained=await cdp.send('Runtime.getHeapUsage');await page.evaluate(()=>auditRelease());await cdp.send('HeapProfiler.collectGarbage');
  report.afterRelease=await cdp.send('Runtime.getHeapUsage');report.errors=errors;
  const out=path.resolve('.npm-cache/memory-audit-261029-4.json');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  if(errors.length)throw Error(errors.join('; '));
 }finally{await browser?.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
