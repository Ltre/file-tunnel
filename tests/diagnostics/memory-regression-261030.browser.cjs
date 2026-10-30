'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {chromium}=require(process.argv[2]||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('../support/streaming-console-fixture.cjs');
const code=fs.readFileSync(path.resolve('app.js'),'utf8'),section=(a,b)=>code.slice(code.indexOf(a),code.indexOf(b,code.indexOf(a)));
(async()=>{const f=await createFixture();let browser;
 try{
  f.app.get('/memory-regression',(_req,res)=>res.type('html').send(`<!doctype html><script>
   const fileObjectUrls=new Map(),liveUrls=new Map(),mediaPosterQueue=[],mediaPosterQueuedIds=new Set();let mediaPosterQueueRunning=true;
   const make=id=>({id,name:id+'.mp4',type:'video/mp4',size:524288,data:new ArrayBuffer(524288)}),getFromStore=async(_s,id)=>make(id);
   const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);liveUrls.set(url,blob.size);return url;};
   const hasCompleteFileCache=()=>true,hideCompletedFileReceiveProgress=()=>{},getExternalFileSourceState=()=>({}),getCachedMediaPosterOrQueue=()=>'',preserveChatScroll=fn=>fn(),refreshCollectionMessagesForFile=async()=>{},refreshCollectionPreviewCardForFile=async()=>{},refreshActiveFilePreviewForFile=async()=>{},shouldGenerateMediaPoster=()=>true;
   ${section('async function refreshFileMessage(','\nasync function refreshCollectionMessagesForFile(')}
   ${section('function enqueueMediaPosterCache(','\nfunction getCachedMediaPosterOrQueue(')}
   async function audit(){for(let i=0;i<65;i++){await refreshFileMessage('v'+i);enqueueMediaPosterCache('q'+i,make('q'+i));}return {urls:fileObjectUrls.size,blobBytes:[...liveUrls.values()].reduce((a,b)=>a+b,0),queued:mediaPosterQueue.length,queuedBytes:mediaPosterQueue.reduce((n,t)=>n+(t.fileInfo.data?.byteLength||0),0)};}
  </script>`));
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();await page.goto(f.base+'/memory-regression');
  const cdp=await page.context().newCDPSession(page),result=await page.evaluate(()=>audit());await cdp.send('HeapProfiler.collectGarbage');
  const retained=await cdp.send('Runtime.getHeapUsage');assert.deepEqual(result,{urls:0,blobBytes:0,queued:65,queuedBytes:0});
  const report={fixtureFiles:65,bytesPerFile:524288,result,retained};fs.writeFileSync(path.resolve('.npm-cache/memory-regression-261030.json'),JSON.stringify(report,null,2));console.log('PASS',JSON.stringify(report));
 }finally{await browser?.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
