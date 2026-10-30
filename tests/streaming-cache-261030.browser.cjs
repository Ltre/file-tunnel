'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.argv[2]||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
 const script=fs.readFileSync(path.join(__dirname,'../client/streaming-cache.js'));
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/cache.js'?'application/javascript':'text/html');res.end(req.url==='/cache.js'?script:'<!doctype html><script src="/cache.js"></script>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(async()=>{
   const bytes=new Uint8Array(2*1048576+33);bytes.fill(37);const file=new File([bytes],'source.bin',{type:'application/octet-stream'});
   await StreamingCache.source('owner','file',file,'station-a');await StreamingCache.updateStation('owner','station-b',['file']);
   const incoming=new Uint8Array(1048576);incoming.fill(19);
   await StreamingCache.retainViewer('viewer',{key:'identity',size:1048576,type:'image/jpeg'},{stationId:'watch',itemId:'image',sourceKind:'disk',name:'view.jpg'},0,incoming.buffer);
  });
  await page.reload();
  const restored=await page.evaluate(async()=>{
   const blob=await StreamingCache.local('owner',{fileId:'file',name:'source.bin',size:2*1048576+33});
   const viewer=await StreamingCache.viewer('viewer',{key:'identity',size:1048576},3,8);
   return {size:blob?.size,end:[...new Uint8Array(await blob.slice(-3).arrayBuffer())],viewer:[...new Uint8Array(await viewer.arrayBuffer())]};
  });assert.equal(restored.size,2*1048576+33);assert.deepEqual(restored.end,[37,37,37]);assert.deepEqual(restored.viewer,[19,19,19,19,19,19]);
  const cleanup=await page.evaluate(async()=>{
   const garbage=await StreamingCache.garbage();await StreamingCache.clearViewer(garbage.map(x=>x.key));
   const descriptor={fileId:'file',name:'source.bin',size:2*1048576+33};
   const before=Boolean(await StreamingCache.local('owner',descriptor));await StreamingCache.updateStation('owner','station-a',[]);
   const shared=Boolean(await StreamingCache.local('owner',descriptor));await StreamingCache.updateStation('owner','station-b',[]);
   return {count:garbage.length,before,shared,deleted:!(await StreamingCache.local('owner',descriptor)),viewer:await StreamingCache.viewer('viewer',{key:'identity',size:1048576},0,1)};
  });assert.deepEqual(cleanup,{count:1,before:true,shared:true,deleted:true,viewer:null});
  console.log('PASS IndexedDB bytes survive reload, ranges reuse cached blocks, viewer cleanup protects source and shared station references');
  const edges=await page.evaluate(async()=>{
   const meta={key:'unaligned',size:1048576+65536,type:'video/mp4'},relation={stationId:'station',itemId:'movie',sourceKind:'local',name:'movie.mp4'};
   await StreamingCache.retainViewer('alice',meta,relation,0,new Uint8Array(65536).fill(7).buffer);
   await StreamingCache.retainViewer('alice',meta,relation,65536,new Uint8Array(1048576).fill(9).buffer);
   const seam=await StreamingCache.viewer('alice',meta,65533,65538);
   const isolated=await StreamingCache.viewer('bob',meta,0,3);
   const file=new File([new Uint8Array(2097152).fill(11)],'shared.bin');
   await Promise.all([StreamingCache.source('owner','shared',file,'A'),StreamingCache.source('owner','shared',file,'B')]);
   const original=IDBObjectStore.prototype.get;let blocks=0;
   IDBObjectStore.prototype.get=function(...args){if(this.name==='blocks')blocks++;return original.apply(this,args);};
   const range=await StreamingCache.local('owner',{fileId:'shared',name:'shared.bin',size:file.size},{start:1048576,end:1048580});
   IDBObjectStore.prototype.get=original;
   try {await StreamingCache.source('owner','shared',{name:file.name,type:file.type,size:file.size,slice(start,end){return start?{arrayBuffer:async()=>{throw Error('interrupted');}}:file.slice(start,end);}},'A');}catch(_){}
   const old=await StreamingCache.local('owner',{fileId:'shared',name:'shared.bin',size:file.size},{start:0,end:3});
   await StreamingCache.updateStation('owner','A',[]);const kept=Boolean(await StreamingCache.local('owner',{fileId:'shared',name:'shared.bin',size:file.size},{start:0,end:1}));
   await StreamingCache.updateStation('owner','B',[]);await StreamingCache.clearViewer((await StreamingCache.garbage()).map(x=>x.key));
   const residue=await new Promise((resolve,reject)=>{const open=indexedDB.open('drop2tunnel-streaming-cache');open.onsuccess=()=>{const db=open.result,tx=db.transaction('blocks'),q=tx.objectStore('blocks').count();q.onsuccess=()=>{db.close();resolve(q.result);};};open.onerror=()=>reject(open.error);});
   return {seam:[...new Uint8Array(await seam.arrayBuffer())],isolated,blocks,range:range.size,old:[...new Uint8Array(await old.arrayBuffer())],kept,residue};
  });
  assert.deepEqual(edges,{seam:[7,7,7,9,9,9],isolated:null,blocks:1,range:5,old:[11,11,11,11],kept:true,residue:0});
  console.log('PASS unaligned SW ranges, actor isolation, bounded source reads, interrupted overwrite, concurrent source generations leave no orphan blocks');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
