'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const code=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function part(a,b){return code.slice(code.indexOf(a),code.indexOf(b,code.indexOf(a)));}
test('invisible cached video refresh does not retain its full body in an object URL',async()=>{
 const urls=new Map(),context={Blob,URL:{createObjectURL:()=>{urls.set('blob:x',1);return 'blob:x';}},fileObjectUrls:new Map(),
  getFromStore:async()=>({id:'video',data:new ArrayBuffer(1024),size:1024,type:'video/mp4'}),hasCompleteFileCache:()=>true,
  hideCompletedFileReceiveProgress(){},getExternalFileSourceState:()=>({}),getCachedMediaPosterOrQueue:()=>'',document:{querySelectorAll:()=>[]},
  preserveChatScroll:fn=>fn(),refreshCollectionMessagesForFile:async()=>{},refreshCollectionPreviewCardForFile:async()=>{},refreshActiveFilePreviewForFile:async()=>{}};
 vm.createContext(context);vm.runInContext(part('async function refreshFileMessage(','\nasync function refreshCollectionMessagesForFile(')+';globalThis.run=refreshFileMessage;',context);
 await context.run('video');assert.equal(urls.size,0);
});
test('pending poster tasks retain only metadata, never whole cached payloads',()=>{
 const context={mediaPosterQueue:[],mediaPosterQueuedIds:new Set(),mediaPosterQueueRunning:true,shouldGenerateMediaPoster:()=>true};vm.createContext(context);
 vm.runInContext(part('function enqueueMediaPosterCache(','\nfunction getCachedMediaPosterOrQueue(')+';globalThis.run=enqueueMediaPosterCache;',context);
 context.run('video',{id:'video',type:'video/mp4',name:'v.mp4',size:1024,data:new ArrayBuffer(1024),videoPoster:'poster',externalFileHandle:{}});
 assert.equal(context.mediaPosterQueue.length,1);assert.equal(context.mediaPosterQueue[0].fileInfo.data,undefined);
 assert.equal(context.mediaPosterQueue[0].fileInfo.externalFileHandle,undefined);
});
test('overlapping presence refreshes share a metadata scan and never materialize complete bodies',async()=>{
 let release,scans=0,wholeReads=0;const announced=[];
 const external={id:'external',sessionId:'A',name:'large.mp4',size:1024,isFileAsset:true,externalFileHandle:{queryPermission:async()=> 'granted',getFile:()=>new Promise(resolve=>{release=()=>resolve({name:'large.mp4',size:1024});})}};
 const context={state:{sessionId:'A'},fileAssetTransfer:{announce:async f=>announced.push(f),resumePending(){}},
  getCurrentSessionFileInventory:async()=>{scans++;return [external,{id:'cached',sessionId:'A',isFileAsset:true,_inventoryDataSize:1024,size:1024}];},
  hasCompleteFileInventoryCache:f=>f._inventoryDataSize===f.size,getFromStore:()=>{wholeReads++;throw Error('unnecessary whole-body read');},historyLog(){},confirmServerAssetCache(){}};
 vm.createContext(context);vm.runInContext(part('let storedFileAssetAnnounceFlight','\nasync function handleFileAssetDiscovery(')+';globalThis.run=announceStoredFileAssets;',context);
 const a=context.run(),b=context.run();await new Promise(setImmediate);assert.equal(scans,1);release();await Promise.all([a,b]);assert.equal(wholeReads,0);assert.equal(announced.length,2);
});
