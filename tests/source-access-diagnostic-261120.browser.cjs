'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),appSource=fs.readFileSync(path.join(root,'app.js'),'utf8');
const start=appSource.indexOf('function recordSourceAccessFailure('),end=appSource.indexOf('function requestSessionHistory(',start);
test('source denial diagnostics survive real log serialization, search and export with correlation fields and no file bodies or credentials',async t=>{
 const app=express();app.use('/client',express.static(path.join(root,'client')));
 app.get('/',(_req,res)=>res.type('html').send('<!doctype html><meta charset="utf-8"><script src="/client/browser-logs.js"></script><script>'+appSource.slice(start,end)+'</script>'));
 const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));t.after(()=>{http.closeAllConnections();return new Promise(resolve=>http.close(resolve));});
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.goto('http://127.0.0.1:'+http.address().port);
 const result=await page.evaluate(async()=>{
  window.state={sessionId:'target-B',deviceId:'viewer',socket:{id:'socket',connected:true},messages:[]};
  state.db=await new Promise(resolve=>{const request=indexedDB.open('diagnostic-file-fixture',1);request.onupgradeneeded=()=>request.result.createObjectStore('files',{keyPath:'id'});request.onsuccess=()=>resolve(request.result);});
  await new Promise(resolve=>{const tx=state.db.transaction('files','readwrite');tx.objectStore('files').put({id:'file',data:new Uint8Array(1024*1024).buffer});tx.oncomplete=resolve;});
  const file={id:'file',name:'copy.bin',size:1024*1024,type:'application/octet-stream',backupSourceSessionId:'private-A',forwardedToSessionId:'target-B',recordMessageId:'record',data:'BODY_MUST_NOT_APPEAR',forwardedSourceGrant:'PROOF_MUST_NOT_APPEAR'};
  state.messages=[{id:'record',type:'file',sender:'holder',fileInfo:file,content:'BODY_MUST_NOT_APPEAR'}];
  window.fileAssetTransfer={requestedMetadata:new Map([['file',file]]),requestIds:new Map([['file','request']]),desiredAssets:new Map([['file','holder']]),activeDownloads:new Set(['file']),downloadQueue:[],transfers:new Map(),multiSourceTransfers:new Map()};
  window.savedTunnelGrant=()=> 'PROOF_MUST_NOT_APPEAR';BrowserLogs.setContext(()=>({sessionId:state.sessionId,deviceId:state.deviceId}));
  const original=IDBObjectStore.prototype.get;IDBObjectStore.prototype.get=function(...args){if(this.name==='files')throw Error('Diagnostics must not read file bodies');return original.apply(this,args);};
  try{
   recordSourceAccessFailure({code:'FILE_SOURCE_ACCESS_DENIED',diagnostic:{marker:'CAONIMA-GPT',event:'file-asset-discovery',time:123,requestId:'request',assetId:'file',recordMessageId:'record',currentSessionId:'target-B',sourceSessionId:'private-A',sourceAuthorized:false,sourceAccessGrant:'PROOF_MUST_NOT_APPEAR',records:[{recordId:'record',fileId:'file',backupSourceSessionId:'private-A'}]}});
   // Wait for the real readonly key request, not a synthetic file read.
   for(let n=0;n<100;n++){await new Promise(resolve=>setTimeout(resolve,5));await BrowserLogs.flush();if((await BrowserLogs.query({kind:'error',keyword:'client-cache-key'})).length)break;}
   const rows=await BrowserLogs.query({kind:'error',keyword:'CAONIMA-GPT'}),exported=await(await BrowserLogs.exportLogs({kind:'error',keyword:'CAONIMA-GPT'})).text();
   return{rows,exported};
  }finally{IDBObjectStore.prototype.get=original;state.db.close();}
 });
 assert.ok(result.rows.length>=6);assert.ok(result.rows.every(row=>row.message.includes('CAONIMA-GPT')&&row.message.includes('request')));
 for(const key of ['file-asset-discovery','currentSessionId','sourceSessionId','private-A','record','client-cache-key','client-request-metadata'])assert.ok(result.exported.includes(key),key);
 assert.doesNotMatch(result.exported,/BODY_MUST_NOT_APPEAR|PROOF_MUST_NOT_APPEAR|diagnostic-incomplete/);
});
