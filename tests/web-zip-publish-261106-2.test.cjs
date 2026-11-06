'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const code=source.slice(source.indexOf('async function publishWebZipUpdate('),source.indexOf('function focusPublishedWebZip('));
function fixture({reject=false}={}){
    const original={id:'old',name:'web.html.zip',type:'application/zip',size:3,creatorDeviceId:'creator',webZipEditors:['editor']};
    const message={id:'copy',type:'file',fileInfo:original,sessionId:'B',forwardedFrom:{sessionId:'A',messageId:'origin'}},updates=[],cleaned=[];
    const context={getCurrentSessionMessages:async()=>[message],getCollectionFiles:()=>[],canEditWebZip:()=>true,generateId:()=> 'new',
        createFileInfoFromFile:(file,options)=>({...options,id:options.fileId,name:file.name,type:file.type,size:file.size}),
        state:{deviceId:'editor',deviceName:'Editor',sessionId:'B',socket:{timeout(){return this;},emit(event,data,ack){assert.equal(event,'web-zip-publish');if(reject)return ack(null,{ok:false,error:'WEB_ZIP_SOURCE_CHANGED'});const next=JSON.parse(JSON.stringify(message));next.fileInfo={...data.fileInfo,id:'new',webZipPendingSync:{state:'pending',sessionId:'A',messageId:'origin'}};ack(null,{ok:true,message:next});}}},
        storeAndAnnounceFileAsset:async()=>{},getFromStore:async()=>({id:'new',data:new Blob(['new'])}),materializeCachedFileRecord:async x=>x,hasCompleteFileCache:()=>true,
        updateHistoryMessage:async next=>updates.push(next),applyHistoryMessageUpdate:async next=>updates.push(next),refreshFileMessage:async()=>{},
        recentlyPublishedWebZipMessages:new Map(),enqueueFileCacheCleanup:ids=>cleaned.push(...ids),Date,JSON,Math,Promise,Error,window:{},
    };
    vm.runInNewContext(code+';globalThis.publish=publishWebZipUpdate;',context);
    return{context,message,updates,cleaned,draft:{sourceMessageId:'copy',sourceFileId:'old',sourceFileInfo:original}};
}
test('forwarded webpage publication applies the confirmed pending sync state instead of an optimistic ordinary message update',async()=>{
    const f=fixture();assert.equal(await f.context.publish({name:'new.html.zip',type:'application/zip',size:3},f.draft),'new');
    assert.equal(f.updates[0].fileInfo.webZipPendingSync?.sessionId,'A');assert.equal(f.updates[0].fileInfo.webZipPendingSync?.state,'pending');
    assert.deepEqual(f.cleaned,['old']);
});
test('a rejected webpage publication retains the previous record and does not clean its cache',async()=>{
    const f=fixture({reject:true});await assert.rejects(f.context.publish({name:'new.html.zip',type:'application/zip',size:3},f.draft));
    assert.deepEqual(f.updates,[]);assert.deepEqual(f.cleaned,[]);
});
