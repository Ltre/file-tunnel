'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'../..'),code=fs.readFileSync(path.join(root,'app.js'),'utf8'),part=(a,b)=>code.slice(code.indexOf(a),code.indexOf(b,code.indexOf(a)));
(async()=>{let browser,server;try{
 const app=express();app.get('/',(_q,res)=>res.type('html').send(`<!doctype html><script>
  const state={sessionId:'isolated'},hasCompleteFileCache=()=>false,getBinaryDataSize=data=>data?.byteLength||data?.size||0;let announced=0;
  const announceEditorAsset=()=>announced++,historyLog=()=>{};
  const getAllFromStore=()=>new Promise((resolve,reject)=>{const request=state.db.transaction('files').objectStore('files').index('sessionId').getAll(IDBKeyRange.only(state.sessionId));request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  ${part('async function getCurrentSessionFiles(','function getResourceFileKind(').split('async function getCurrentSessionFileInventory()')[0]}
  ${part('async function getCurrentSessionFileInventory(','function getResourceFileKind(').split('\nfunction ')[0]}
  ${part('async function announceStoredEditorAssets(','function setEditorAssetUnavailable(')}
  window.ready=(async()=>{
   const request=indexedDB.open('inventory-261107',1);request.onupgradeneeded=()=>request.result.createObjectStore('files',{keyPath:'id'}).createIndex('sessionId','sessionId');
   state.db=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
   await new Promise((resolve,reject)=>{const tx=state.db.transaction('files','readwrite'),store=tx.objectStore('files');
    for(let i=0;i<8;i++)store.put({id:'video-'+i,sessionId:'isolated',name:'large.mp4',type:'video/mp4',size:4194304,data:new ArrayBuffer(4194304)});
    store.put({id:'image',sessionId:'isolated',name:'image.png',type:'image/png',size:65536,isEditorAsset:true,data:new ArrayBuffer(65536)});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
   });
  })();
  window.oldScan=async()=>{window.auditRows=await getAllFromStore();return auditRows.reduce((n,file)=>n+getBinaryDataSize(file.data),0);};
  window.newScan=async()=>{window.auditRows=await getCurrentSessionFileInventory();await announceStoredEditorAssets();return{rows:auditRows.length,bodyBytes:auditRows.reduce((n,file)=>n+getBinaryDataSize(file.data),0),representedBytes:auditRows.reduce((n,file)=>n+file._inventoryDataSize,0),announced};};
 </script>`));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(()=>ready);
 const cdp=await page.context().newCDPSession(page);await cdp.send('HeapProfiler.collectGarbage');const initial=await cdp.send('Runtime.getHeapUsage');
 const fullReadBytes=await page.evaluate(()=>oldScan());await cdp.send('HeapProfiler.collectGarbage');const oldRetained=await cdp.send('Runtime.getHeapUsage');
 await page.evaluate(()=>{window.auditRows=null;});await cdp.send('HeapProfiler.collectGarbage');
 const inventory=await page.evaluate(()=>newScan());await cdp.send('HeapProfiler.collectGarbage');const newRetained=await cdp.send('Runtime.getHeapUsage');
 assert.equal(fullReadBytes,8*4194304+65536);assert.deepEqual(inventory,{rows:9,bodyBytes:0,representedBytes:fullReadBytes,announced:1});
 assert.ok(oldRetained.backingStorageSize-newRetained.backingStorageSize>=32*1024*1024,JSON.stringify({oldRetained,newRetained}));
 const report={fixture:'8 × 4 MiB cached videos + 64 KiB editor image in real IndexedDB',initial,fullReadBytes,oldRetained,inventory,newRetained};
 fs.mkdirSync(path.join(root,'.npm-cache'),{recursive:true});fs.writeFileSync(path.join(root,'.npm-cache/memory-inventory-261107.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await browser?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
