'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync(require.resolve('../app.js'),'utf8');
function section(a,b){return app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)));}
function fixture(){
    const stored=new Map(),rendered=new Set(),recovery=[];
    const state={sessionId:'tunnel',deviceId:'self',socket:{emit(){}}};
    const context=vm.createContext({state,console,historyLog(){},compareHistoryMessages:()=>0,summarizeHistoryMessage:x=>x,
        deletedHistoryMessageIds:new Map(),pendingHistoryMessageIds:new Set(),activeCollectionPreviewMessageId:null,activeFileDetailsMessageId:null,
        getFromStore:async(_store,id)=>stored.get(id),saveToStore:async(_store,value)=>stored.set(value.id,value),deleteFromStore:async(_store,id)=>stored.delete(id),
        document:{querySelector:selector=>({remove:()=>rendered.delete(selector.match(/data-message-id="([^"]+)/)[1])})},
        cleanupProgressForDeletedFile(){},enqueueFileCacheCleanup(){},getMessageElement:id=>rendered.has(id),
        isAuthoritativeHistoryMessageChanged:()=>false,applyHistoryMessageUpdate:async()=>{},addMessageToChat:async message=>rendered.add(message.id),
        storeInlineFileData:async()=>{},reorderRenderedMessages(){},getCurrentSessionMessages:async()=>[...stored.values()],
        reconcileLocalHistory:async()=>{},pruneLocalHistoryToCanonicalSnapshot:async()=>{},enqueueHistoryAssetRecovery:messages=>recovery.push(...messages)});
    if(app.includes('function isHistoryMessageDeleted('))vm.runInContext(section('function isHistoryMessageDeleted(', 'async function deleteHistoryMessageLocal('),context);
    vm.runInContext(section('async function deleteHistoryMessageLocal(', 'async function findReferencedFileIds(')+section('async function handleSessionHistory(', 'async function getCurrentSessionMessages('),context);
    return {stored,rendered,recovery,context};
}
test('a pre-delete snapshot arriving after a local deletion cannot restore an SNS photo',async()=>{
    const f=fixture(),message={id:'photo',sessionId:'tunnel',type:'file',sender:'sns-server',fileInfo:{id:'asset',isServerAsset:true}};
    f.stored.set(message.id,message);f.rendered.add(message.id);
    await f.context.deleteHistoryMessageLocal(message.id);
    await f.context.handleSessionHistory({sessionId:'tunnel',messages:[message],authoritative:true,deletedMessageIds:[]});
    assert.equal(f.rendered.has(message.id),false);assert.equal(f.stored.has(message.id),false);assert.equal(f.recovery.length,0);
});
test('deleting an as-yet uncached record still protects against its late snapshot',async()=>{
    const f=fixture();await f.context.deleteHistoryMessageLocal('late-photo');
    await f.context.handleSessionHistory({sessionId:'tunnel',messages:[{id:'late-photo',type:'file',fileInfo:{id:'asset'}}]});
    assert.equal(f.stored.size,0);assert.equal(f.rendered.size,0);
});
