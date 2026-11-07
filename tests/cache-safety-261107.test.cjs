'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));

test('a failed read before a metadata update cannot overwrite an existing complete file body',async()=>{
 const files=new Map([['ready',{id:'ready',size:4,data:new ArrayBuffer(4)}]]),context={state:{db:{_isMemory:true}},memoryStorage:new Map([['files',files]]),
  getFromStore:async()=>{throw Error('cache read failed');},hasCompleteFileCache:()=>false};
 vm.runInNewContext(section('async function saveToStore(','async function getFromStore('),context);
 await assert.rejects(context.saveToStore('files',{id:'ready',size:4,name:'metadata'}),/cache read failed/);
 assert.equal(files.get('ready').data.byteLength,4);
});

test('removing a locally unreferenced resource preserves references in another tunnel and fails closed on read errors',async()=>{
 let deleted=0,alerts=0;const context={Set,findReferencedFileIds:async()=>new Set(['shared']),alert:()=>alerts++,confirm:()=>true,deleteFromStore:async()=>deleted++};
 vm.runInNewContext(section('async function deleteUnreferencedResource(','function createResourceBrowserButton('),context);
 await context.deleteUnreferencedResource({id:'shared',references:[]});assert.equal(deleted,0);assert.equal(alerts,1);
 context.findReferencedFileIds=async()=>{throw Error('references unavailable');};
 await assert.rejects(context.deleteUnreferencedResource({id:'shared',references:[]}),/references unavailable/);assert.equal(deleted,0);
});
test('automatic cache cleanup stops and requeues when the reference scan fails',async()=>{
 const deleted=[],pending=new Set(['still-referenced']);
 const context={Set,Array,Promise,Error,fileCacheCleanupRunning:false,pendingFileCacheCleanupIds:pending,
  getAllFromStore:async()=>{throw Error('database temporarily unavailable');},getFromStore:async()=>null,
  document:{getElementById:()=>null},fileAssetTransfer:{cancel(){}},cleanupProgressForDeletedFile(){},deleteCacheStoreReference:async()=>{},
  deleteFromStore:async(_s,id)=>deleted.push(id),removeMusicTrackFromQueue(){},releaseStoredFileUrl(){},historyLog(){},scheduleFileCacheCleanup(){},navigator:{},sleep:async()=>{}};
 vm.runInNewContext(section('async function findReferencedFileIds(','async function findGarbageFileCaches(')+section('async function processPendingFileCacheCleanup(','async function deleteFileFromCollection('),context);
 await assert.rejects(context.processPendingFileCacheCleanup(),/database temporarily unavailable/);
 assert.deepEqual(deleted,[]);assert.equal(pending.has('still-referenced'),true);
});
test('a failed editor reference read also prevents orphan deletion',async()=>{
 const context={Set,Promise,document:{getElementById:()=>null},getAllFromStore:async()=>[],getFromStore:async()=>{throw Error('editor read failed');}};
 vm.runInNewContext(section('async function findReferencedFileIds(','function extractAssetIds('),context);
 await assert.rejects(context.findReferencedFileIds(new Set(['image'])),/editor read failed/);
});
test('garbage cleanup preserves another tunnel reference and rechecks a partial cache that completed after the dialog opened',async()=>{
 const deleted=[],current=new Map([['shared',{id:'shared',sessionId:'A',size:3,data:new ArrayBuffer(3)}],['completed',{id:'completed',size:3,data:new ArrayBuffer(3)}],['orphan',{id:'orphan'}]]);
 const context={Set,Promise,window:{},fileAssetTransfer:{cancel(){}},findReferencedFileIds:async()=>new Set(['shared','completed']),getCurrentSessionFileInventory:async()=>[...current.values()],
  deleteCacheStoreReference:async()=>{},deleteFromStore:async(_s,id)=>deleted.push(id),releaseStoredFileUrl(){},historyLog(){}};
 vm.runInNewContext(section('async function clearGarbageFileCaches(','async function showGarbageCleanupDialog('),context);
 await context.clearGarbageFileCaches([{id:'shared'},{id:'completed',isPartial:true},{id:'orphan'}]);assert.deepEqual(deleted,['orphan']);
});
test('editor presence reads the body-free inventory and announces only complete editor assets',async()=>{
 const announced=[],state={sessionId:'A'};
 const context={state,console,historyLog(){},announceEditorAsset:file=>announced.push(file.id),
  getAllFromStore:async()=>{throw Error('full cache bodies must not be loaded for presence');},
  getCurrentSessionFileInventory:async()=>[{id:'video',_inventoryDataSize:2**30},{id:'image',isEditorAsset:true,_inventoryDataSize:4,size:4},{id:'partial',isEditorAsset:true,_inventoryDataSize:1,size:4}],
  hasCompleteFileInventoryCache:file=>file._inventoryDataSize===file.size};
 vm.runInNewContext(section('async function announceStoredEditorAssets(','function setEditorAssetUnavailable('),context);
 await context.announceStoredEditorAssets();assert.deepEqual(announced,['image']);
});
