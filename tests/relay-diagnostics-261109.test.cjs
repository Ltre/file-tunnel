'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {registerFileAssetHandlers}=require('../server/file-assets');
async function fixture(){
 const handlers=new Map(),events=[],timeouts=[];let complete;
 const sessionId=crypto.randomUUID(),to='receiver',asset={id:crypto.randomUUID(),name:'private filename.bin',size:4,type:'application/octet-stream'},attemptId='attempt-one';
 const target={timeout(milliseconds){return{emit(event,_data,ack){timeouts.push({event,milliseconds});if(event==='file-asset-relay-complete')complete=ack;else ack(null,{ok:true});}};}};
 registerFileAssetHandlers({id:'provider-socket',on:(name,callback)=>handlers.set(name,callback)},{sessions:new Map(),deviceSockets:new Map([[to,target]]),getSessionId:()=>sessionId,getDeviceId:()=> 'provider',sanitize:String,historyLog:(event,details)=>events.push({event,details}),isValidId:value=>typeof value==='string'&&value.length>0});
 let started;await handlers.get('file-asset-relay-start')({sessionId,to,asset,attemptId},result=>started=result);assert.equal(started.ok,true);
 let chunked;await handlers.get('file-asset-relay-chunk')({sessionId,to,assetId:asset.id,attemptId,chunk:Buffer.from('test')},result=>chunked=result);assert.equal(chunked.ok,true);
 return{events,timeouts,data:{sessionId,to,assetId:asset.id,attemptId},finish:ack=>handlers.get('file-asset-relay-complete')({sessionId,to,assetId:asset.id,attemptId},ack),reply:(error,result)=>complete(error,result)};
}
test('relay completion waits for the receiver acknowledgement and does not report success early',async()=>{
 const f=await fixture();let result;const pending=f.finish(value=>result=value);await new Promise(setImmediate);
 assert.equal(result,undefined);assert.equal(f.events.some(value=>value.event==='file-asset-relay-completed'),false);
 f.reply(null,{ok:true});await pending;assert.equal(result.ok,true);assert.equal(f.events.some(value=>value.event==='file-asset-relay-completed'),true);
 assert.equal(f.timeouts.find(value=>value.event==='file-asset-relay-complete').milliseconds,60000,'the existing completion deadline is unchanged');
});
test('a missing completion acknowledgement fails with bounded correlation data, without logging file contents or claiming completion',async t=>{
 const logged=[];t.mock.method(console,'error',(...args)=>logged.push(args));const f=await fixture();let result;const pending=f.finish(value=>result=value);f.reply(new Error('operation has timed out'));await pending;
 assert.equal(result.ok,false);assert.equal(f.events.some(value=>value.event==='file-asset-relay-completed'),false);
 assert.equal(logged.length,1);assert.equal(logged[0][2].phase,'receiver-complete-ack');assert.equal(logged[0][2].assetId,f.data.assetId);assert.equal(logged[0][2].attemptId,f.data.attemptId);
 assert.ok(logged[0][2].elapsedMs>=0);assert.equal(JSON.stringify(logged).includes('private filename'),false);
});
