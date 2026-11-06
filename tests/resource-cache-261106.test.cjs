'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const code=source.slice(source.indexOf('const resourceCacheRestores ='),source.indexOf('async function deleteUnreferencedResource('));
function fixture(resources,extra={}) {
    const files=new Map(),calls=[],desiredAssets=new Map(),editor=new Map(),logs=[];
    const state={sessionId:'A',socket:{connected:true}};
    const context={state,Map,Set,Promise,Error,window:{},document:{getElementById:()=>null},
        getSessionResourceInventory:async()=>resources,getFromStore:async(_,id)=>files.get(id),
        saveToStore:async(_,file)=>files.set(file.id,file),hasCompleteFileCache:file=>!!file?.data,
        hydrateEditorAssets:async()=>{},refreshFileMessage:async()=>{},showFileMessagePlaceholder(){},
        editorAssetRequests:editor,serverAssetRecoveries:{promises:new Map()},
        requestEditorAsset:id=>{editor.set(id,true);calls.push(id);},historyLog:(...args)=>logs.push(args),
        requestServerAssetWithPeerPreference(){throw Error('bulk restore must use peers, not start an HTTP fallback');},
        fileAssetTransfer:{desiredAssets,hasDownloadWork:()=>false,request:async(id,owner,metadata,options)=>{calls.push(id);desiredAssets.set(id,owner);assert.equal(options.force,false);assert.equal(metadata.sessionId,'A');}},...extra};
    vm.runInNewContext(code+';globalThis.restore=restoreResourceCache;globalThis.batch=requestMissingResourceCaches;',context);
    return {context,state,files,calls,desiredAssets,editor,logs};
}
test('missing cache scan deduplicates files, active work and simultaneous button presses; cached content is untouched',async()=>{
    const resources=[{id:'ready',hasReadableLocalSource:true},{id:'peer'},{id:'peer'},{id:'active'},{id:'editor',isEditorAsset:true},{id:'server',serverAssetUrl:'/api/file'}];
    const f=fixture(resources);f.desiredAssets.set('active','owner');
    const first=f.context.batch();assert.equal(f.context.batch(),first);
    const result=await first;
    assert.deepEqual(f.calls,['peer','editor','server']);assert.equal(result.requested,3);assert.equal(result.pending,1);
    await f.context.batch();assert.deepEqual(f.calls,['peer','editor','server'],'a second scan must not restart pending work');
    assert.equal(f.files.has('ready'),false);assert.equal(f.files.get('server').serverAssetUrl,'/api/file');
});
test('individual and bulk restores share a lock before asynchronous storage reads finish',async()=>{
    let release;const gate=new Promise(resolve=>release=resolve);
    let started=0;
    const f=fixture([{id:'same'}],{getFromStore:async()=>{await gate;return null;},fileAssetTransfer:{request:async(_id,_owner,_metadata,options)=>{assert.equal(options.force,true);started++;}}});
    const individual=f.context.restore({id:'same'});const batch=f.context.batch();
    release();await Promise.all([individual,batch]);assert.equal(started,1);
});
test('late storage completions cannot request or write a missing cache into a different tunnel',async()=>{
    let release;const gate=new Promise(resolve=>release=resolve);
    const f=fixture([{id:'old'}],{getFromStore:async()=>{await gate;return null;}});
    const result=f.context.batch();await new Promise(resolve=>setImmediate(resolve));f.state.sessionId='B';release();
    assert.equal((await result).stopped,true);assert.deepEqual(f.calls,[]);assert.equal(f.files.size,0);
});
test('one broken cache does not block other requests and a completed local copy never asks a peer',async()=>{
    const f=fixture([{id:'bad'},{id:'cached'},{id:'good'}],{getFromStore:async(_,id)=>{if(id==='bad')throw Error('read failed');return id==='cached'?{id,data:Buffer.from('local')}:null;}});
    const stats=await f.context.batch();assert.equal(stats.failed,1);assert.equal(stats.cached,1);assert.deepEqual(f.calls,['good']);
    assert.equal(f.files.get('cached').cacheCleared,false);
});
