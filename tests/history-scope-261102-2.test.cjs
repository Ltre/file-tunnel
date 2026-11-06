'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function fixture() {
    const stored = new Map(), rendered = [], writes = [], recovery = [], emitted = [], deleted = [];
    const state = {sessionId:'tunnel-B',deviceId:'device',socket:{emit:(...args)=>emitted.push(args)}};
    const context = vm.createContext({state, console, historyLog(){}, compareHistoryMessages:(a,b)=>a.timestamp-b.timestamp,
        summarizeHistoryMessage: x=>x, getFromStore:async(_store,id)=>stored.get(id),
        saveToStore:async(_store,value)=>{writes.push(value);stored.set(value.id,value);},
        deleteHistoryMessageLocal:async id=>deleted.push(id),getMessageElement:()=>null,
        isAuthoritativeHistoryMessageChanged:()=>false,applyHistoryMessageUpdate:async()=>{},
        addMessageToChat:async message=>rendered.push(message),storeInlineFileData:async()=>{},reorderRenderedMessages(){},
        getCurrentSessionMessages:async()=>[...stored.values()].filter(x=>x.sessionId===state.sessionId),
        reconcileLocalHistory:async()=>{},pruneLocalHistoryToCanonicalSnapshot:async()=>{},
        enqueueHistoryAssetRecovery:messages=>recovery.push(...messages)});
    vm.runInContext(section('function isHistoryMessageDeleted(', 'async function deleteHistoryMessageLocal(') +
        section('async function handleSessionHistory(', 'async function getCurrentSessionMessages('), context);
    return {context,state,stored,rendered,writes,recovery,emitted,deleted,run:data=>context.handleSessionHistory(data)};
}
test('webpage snapshots use the ordered update boundary, including a first snapshot with an older unversioned ZIP',async()=>{
    const f=fixture(),updates=[];f.context.applyHistoryMessageUpdate=async message=>updates.push(message);
    await f.run({sessionId:'tunnel-B',messages:[{id:'webpage',type:'file',fileInfo:{id:'zip',name:'page.html.zip',webZip:true}}]});
    assert.equal(updates.length,1);assert.equal(f.writes.length,0,'a raw snapshot write must not race a newer webpage publication');
});

test('new B never renders or recovers A records already stored under their original tunnel', async()=>{
    const f=fixture();
    const messages=Array.from({length:65},(_,i)=>({id:'A-'+i,sessionId:'tunnel-A',timestamp:i,type:'file',fileInfo:{id:'file-'+i,isAsset:true}}));
    messages.forEach(message=>f.stored.set(message.id,message));
    // Older servers omit the envelope and per-message sessionId.
    await f.run({messages:messages.map(({sessionId,...message})=>message)});
    assert.equal(f.rendered.length,0,'A records must not temporarily populate the empty B UI');
    assert.equal(f.recovery.length,0,'foreign records must not schedule file recovery or progress rows');
    assert.equal(f.writes.length,0);assert.equal([...f.stored.values()].filter(x=>x.sessionId==='tunnel-B').length,0);
});

test('a late explicitly scoped A snapshot cannot render, delete, acknowledge or reconcile in B',async()=>{
    const f=fixture();
    await f.run({sessionId:'tunnel-A',messages:[{id:'old',type:'text'}],deletedMessageIds:['B-own'],authoritative:true});
    assert.equal(f.rendered.length+f.writes.length+f.deleted.length+f.emitted.length+f.recovery.length,0);
});

test('per-record tunnel identity is checked before writing previously unknown foreign records',async()=>{
    const f=fixture();
    await f.run({messages:[{id:'A-new',sessionId:'tunnel-A',type:'text',text:'old A'}]});
    assert.equal(f.writes.length,0);assert.equal(f.rendered.length,0);assert.equal(f.recovery.length,0);
});

test('session change while IndexedDB is awaited cannot render or relabel A as B',async()=>{
    const f=fixture();f.state.sessionId='tunnel-A';
    let finish;
    f.context.getFromStore=()=>new Promise(resolve=>{finish=resolve;});
    const pending=f.run({sessionId:'tunnel-A',messages:[{id:'A-late',type:'text'}]});
    f.state.sessionId='tunnel-B';finish(null);await pending;
    assert.equal(f.writes.length+f.rendered.length+f.emitted.length+f.recovery.length,0);
});

test('valid B snapshots keep the existing full history and recovery behavior',async()=>{
    const f=fixture();
    await f.run({sessionId:'tunnel-B',messages:[{id:'B-own',type:'text',text:'B'}]});
    assert.equal(f.rendered.length,1);assert.equal(f.writes[0].sessionId,'tunnel-B');
    assert.equal(f.emitted[0][1].sessionId,'tunnel-B');assert.equal(f.recovery.length,1);
});

test('a late A snapshot cannot replace a B snapshot already waiting in the queue',()=>{
    const pending={sessionId:'tunnel-B',messages:[{id:'B-own'}]};
    const queue={running:true,pending};
    const runtime=vm.createContext({state:{sessionId:'tunnel-B'},sessionHistoryQueue:queue});
    vm.runInContext(section('function enqueueSessionHistory(', 'function enqueueHistoryAssetRecovery('),runtime);
    runtime.enqueueSessionHistory({sessionId:'tunnel-A',messages:[{id:'A-old'}]});
    assert.equal(queue.pending,pending);
});

test('deletion tombstones cannot remove records stored under another tunnel',async()=>{
    const f=fixture();
    f.stored.set('A-keep',{id:'A-keep',sessionId:'tunnel-A'});
    f.stored.set('B-delete',{id:'B-delete',sessionId:'tunnel-B'});
    await f.run({sessionId:'tunnel-B',messages:[],deletedMessageIds:['A-keep','B-delete']});
    assert.deepEqual(f.deleted,['B-delete']);
});

test('a queued recovery from A is skipped after the active tunnel changes to B',async()=>{
    const queue={recoveryRunning:false,recoveryPending:null};
    const requests=[];
    const runtime=vm.createContext({state:{sessionId:'tunnel-B'},sessionHistoryQueue:queue,
        requestMissingFileAssetCache:async message=>requests.push(message.id),sleep:async()=>{},historyLog(){}});
    vm.runInContext(section('function isHistoryMessageDeleted(', 'async function deleteHistoryMessageLocal(') +
        section('function enqueueHistoryAssetRecovery(', 'async function handleSessionHistory('),runtime);
    runtime.enqueueHistoryAssetRecovery([{id:'A-file',sessionId:'tunnel-A',type:'file',fileInfo:{isAsset:true}},
        {id:'B-file',sessionId:'tunnel-B',type:'file',fileInfo:{isAsset:true}}]);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(requests,['B-file']);
});

test('A history broadcast uses its session socket even when the same device has since opened B',()=>{
    const server=fs.readFileSync(require.resolve('../server.js'),'utf8');
    const code=server.slice(server.indexOf('function emitToReadableSessionDevices('),server.indexOf('function scheduleSessionHistoryBroadcast('));
    const sent=[];
    const socketA={id:'socket-A',connected:true,data:{deviceId:'device'},emit:(event,payload)=>sent.push({target:'A',event,payload})};
    const socketB={id:'socket-B',connected:true,data:{deviceId:'device'},emit:(event,payload)=>sent.push({target:'B',event,payload})};
    const sockets=new Map([[socketA.id,socketA],[socketB.id,socketB]]);
    const runtime=vm.createContext({deviceSockets:new Map([['device',socketB]]),io:{sockets:{sockets}},canUseTunnelCapability:()=>true});
    vm.runInContext(code,runtime);
    const sessionA={devices:new Map([['device',{socketId:socketA.id}]])};
    runtime.emitToReadableSessionDevices(sessionA,'session-history',{messages:[{id:'A-only'}]});
    assert.deepEqual(sent.map(x=>x.target),['A'],'the latest global device socket may belong to another tunnel');
    sent.length=0;sockets.delete(socketA.id);
    runtime.emitToReadableSessionDevices(sessionA,'session-history',{messages:[{id:'A-only'}]});
    assert.equal(sent.length,0,'disconnected A must not fall back to live B');
    sockets.set(socketA.id,socketA);
    runtime.canUseTunnelCapability=()=>false;
    runtime.emitToReadableSessionDevices(sessionA,'message',{message:{id:'protected'}});
    assert.equal(sent.length,0,'the original read permission check still applies');
    runtime.canUseTunnelCapability=()=>true;
    runtime.emitToReadableSessionDevices(sessionA,'message',{},'device');
    assert.equal(sent.length,0,'the original excluded sender is still excluded');
    socketA.data.deviceId='different-device';
    runtime.emitToReadableSessionDevices(sessionA,'message',{});
    assert.equal(sent.length,0,'a stale or mismatched socket identity cannot receive records');
});
