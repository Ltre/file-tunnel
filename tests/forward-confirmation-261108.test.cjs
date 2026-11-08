'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const section=(source,a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
function client(){
    const sent=[],toasts=[],alerts=[],saved=new Map(),confirmed=new Map();let sequence=0,mode='normal',failAt='';
    const context={Map,Set,Date,Promise,Error,window:{},state:{sessionId:'A',deviceId:'actor',deviceName:'device'},LAST_FORWARD_SESSION_STORAGE_KEY:'last-forward',localStorage:{setItem(){}},generateId:()=> 'target-'+(++sequence),getFromStore:async(_store,id)=>({id,type:'text',text:'record '+id}),saveToStore:async(_store,message)=>saved.set(message.id,message),tunnelDeviceId:()=> 'actor-B',savedTunnelGrant:()=> 'valid',showAppToast:text=>toasts.push(text),alert:text=>alerts.push(text),historyLog(){},showBlockingProgressPanel:()=>({update(){},close(){}})};
    context.state.socket={timeout(){return this;},emit(event,data,ack){if(event==='forward-message-status')return ack(null,{ok:true,confirmed:confirmed.has(data.targetMessageId),message:confirmed.get(data.targetMessageId)});sent.push(data.message);if(data.message.forwardedFrom.messageId===failAt)return ack(null,{ok:false,error:'permission-denied'});if(mode==='unknown')return ack(Error('timeout'));confirmed.set(data.message.id,JSON.parse(JSON.stringify(data.message)));ack(mode==='late'?Error('timeout'):null,{ok:true,message:data.message});}};
    context.showForwardHistoryProgress=()=>({setState(){},finish(){}});
    vm.runInNewContext(section(app,'async function cloneForwardFileInfo(','async function downloadFileFromMessage('),context);
    return{context,sent,toasts,alerts,saved,confirmed,setMode:value=>mode=value,setFailure:value=>failAt=value};
}
test('a 20-record batch reports confirmed results once, rather than 20 misleading individual success toasts',async()=>{
    const f=client(),records=Array.from({length:20},(_,n)=>({id:'r'+n}));const result=await f.context.forwardHistoryMessages(records,'B');assert.equal(result.confirmed,20);assert.equal(f.sent.length,20);assert.equal(f.saved.size,20);assert.equal(f.toasts.length,1);assert.equal(f.alerts.length,0);
});
test('a timed-out acknowledgement is reconciled against the exact accepted record',async()=>{
    const f=client();f.setMode('late');await f.context.forwardHistoryMessage('r1','B');assert.equal(f.sent.length,1);assert.equal(f.saved.size,1);assert.equal(f.toasts.length,1);
});
test('an unknown outcome retains its stable message id and a resumed batch skips its already confirmed records',async()=>{
    const f=client(),records=[{id:'first'},{id:'second'},{id:'third'}];
    const original=f.context.state.socket.emit;f.context.state.socket.emit=function(event,data,ack){if(event==='forward-message'&&data.message.forwardedFrom.messageId==='second')f.setMode('unknown');return original(event,data,ack);};
    const result=await f.context.forwardHistoryMessages(records,'B');assert.equal(result.confirmed,1);assert.equal(result.unsent,1);assert.equal(result.failures[0].unconfirmed,true);const pendingId=f.sent.at(-1).id;
    f.context.state.socket.emit=original;f.setMode('normal');const resumed=await f.context.forwardHistoryMessages(records,'B');assert.equal(resumed.confirmed,3);assert.equal(f.sent.filter(message=>message.forwardedFrom.messageId==='first').length,1);assert.equal(f.sent.filter(message=>message.forwardedFrom.messageId==='second').at(-1).id,pendingId);assert.equal(f.confirmed.size,3);
});
test('a definite refusal is listed while independent later records continue',async()=>{
    const f=client();f.setFailure('bad');const result=await f.context.forwardHistoryMessages([{id:'first'},{id:'bad'},{id:'last'}],'B');assert.equal(result.confirmed,2);assert.equal(result.failures.length,1);assert.equal(result.unsent,0);assert.equal(result.failures[0].id,'bad');assert.equal(f.alerts.length,0);assert.equal(f.toasts.length,0);
});

test('a later refusal cannot erase an earlier unknown outcome or allocate another record ID',async()=>{
    const f=client();f.setMode('unknown');await assert.rejects(f.context.forwardHistoryMessage('r1','B'),error=>error.unconfirmed);const id=f.sent[0].id;
    f.setFailure('r1');await assert.rejects(f.context.forwardHistoryMessage('r1','B'),error=>error.unconfirmed);
    f.setFailure('');f.setMode('normal');await f.context.forwardHistoryMessage('r1','B');assert.deepEqual(f.sent.map(message=>message.id),[id,id,id]);
});
test('the real server deduplicates a duplicate request while commit confirmation is pending and checks status scope',async()=>{
    const handlers=new Map(),sessions=new Map(),saved=new Map(),acks=[],broadcasts=[];let release,stored=0;
    const target={devices:new Map(),history:[]},source={devices:new Map([['actor',{}]])};sessions.set('A',source);sessions.set('B',target);
    const context={Map,Promise,JSON,Buffer,Error,console,sessions,currentSession:'A',currentDevice:'actor',clientIp:'fixture',MAX_MESSAGE_SIZE:1048576,infraStore:{getTunnel:()=>({}),findShortCodeForSession:()=> 'BBBBB',getHistoryMessage:(s,id)=>saved.get(s+':'+id),flush:()=>true},socket:{id:'socket',on:(event,run)=>handlers.set(event,run)},sanitizeString:String,isValidSessionId:()=>true,isValidDeviceId:()=>true,getOrCreateTelegramSession:id=>sessions.get(id),getHistoryMessageEntry:(session,id)=>session.history?.find(entry=>entry.message.id===id),tunnelAccess:{verify:token=>token==='valid'},canUseTunnelCapability:()=>true,tunnelMessageCapabilities:()=>[],getSessionAuditFileAssets:()=>new Map(),addToSessionHistory:(_s,session,message)=>{stored++;session.history.push({message});saved.set('B:'+message.id,message);return{stored:true};},enqueueInfraAudit:(task,_key,options)=>{release=()=>{task();options.onSuccess();};},emitToReadableSessionDevices:(_s,event,data)=>broadcasts.push({event,data}),scheduleSessionHistoryBroadcast(){}};
    vm.runInNewContext(section(server,"    socket.on('forward-message',","    socket.on('clipboard-update',"),context);
    const data={targetSessionId:'B',targetDeviceId:'actor-B',targetAccessGrant:'valid',message:{id:'target',type:'text',text:'hello',sender:'actor',forwardedFrom:{sessionId:'A',messageId:'source'}}};
    const first=handlers.get('forward-message')(structuredClone(data),response=>acks.push(response)),second=handlers.get('forward-message')(structuredClone(data),response=>acks.push(response));await new Promise(resolve=>setImmediate(resolve));assert.equal(stored,1);assert.equal(acks.length,0);release();await Promise.all([first,second]);assert.equal(acks.length,2);assert.ok(acks.every(response=>response.ok));assert.equal(broadcasts.length,1);
    let status;handlers.get('forward-message-status')({targetSessionId:'B',targetMessageId:'target',sourceMessageId:'source',targetDeviceId:'actor-B',targetAccessGrant:'valid'},value=>status=value);assert.equal(status.confirmed,true);
    handlers.get('forward-message-status')({targetSessionId:'B',targetMessageId:'target',sourceMessageId:'private-source',targetDeviceId:'actor-B',targetAccessGrant:'valid'},value=>status=value);assert.equal(status.ok,false);
});
