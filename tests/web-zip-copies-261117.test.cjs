'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createWebZipSync}=require('../server/web-zip-sync'),{createWebZipCollaborationCredential:createWebZipCredentials}=require('../server/web-zip-collaboration-credentials');
const clone=value=>JSON.parse(JSON.stringify(value));
const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
async function settled(predicate){for(let i=0;i<100&&!predicate();i++)await pause();assert.ok(predicate(),'copy group did not settle');}
function setup(t){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-copies-261117-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const page={id:'root',name:'AAA.html.zip',size:3,type:'application/zip',webZip:true,creatorDeviceId:'creator',ownerDeviceId:'creator',webZipEditors:[]};
    const records=new Map([['A:origin',{id:'origin',type:'file',sender:'creator',remark:'source',fileInfo:clone(page)}]]);
    for(const id of ['one','two'])records.set('B:'+id,{id,type:'file',sender:'creator',remark:id,forwardedFrom:{sessionId:'A',messageId:'origin'},fileInfo:{...clone(page),id:'copy-'+id}});
    const state={online:true,gate:null,list:true,allowed:true,peerGate:null,peerWaiting:false},writes=[];
    const read=(s,id)=>records.get(s+':'+id)||null;
    const options={filename:path.join(dir,'jobs.json'),credentials:createWebZipCredentials({dataDir:dir}),readRecord:read,
        listRecords:s=>state.list?[...records].filter(([key])=>key.startsWith(s+':')).map(([,record])=>record):[],
        writeRecord:async(s,before,next,options={})=>{if(s==='A'&&state.gate)await state.gate;if(s==='B'&&before.id==='two'&&state.peerGate){state.peerWaiting=true;await state.peerGate;}if(JSON.stringify(read(s,before.id))!==JSON.stringify(before)||options.check?.()===false)throw Error('WEB_ZIP_SOURCE_CHANGED');records.set(s+':'+before.id,clone(next));writes.push({s,next:clone(next)});},
        canPublish:()=>state.allowed,hasContent:()=>true,canSync:()=>state.online,isForwardedCopy:(_s,id)=>id!=='forged'};
    let service=createWebZipSync(options);
    const approve=()=>service.approve({sessionId:'B',messageId:'one',fileId:read('B','one').fileInfo.id,creatorDeviceId:'creator',deviceId:'editor'});
    const publish=(messageId,id,name)=>{const file=read('B',messageId).fileInfo;return service.publish({sessionId:'B',messageId,fileId:file.id,deviceId:'editor',editCredential:service.issueCredential({sessionId:'B',messageId,fileId:file.id,deviceId:'editor'}),fileInfo:{id,name:name+'.html.zip',size:id.length,type:'application/zip'}});};
    return{read,records,state,writes,dir,approve,publish,get service(){return service;},restart:()=>service=createWebZipSync(options)};
}
test('one creator approval covers both same-origin copies and alternating edits update both copies and the original',async t=>{
    const f=setup(t);await f.approve();
    assert.equal(f.service.needsApproval('B','two','copy-two','editor'),false);
    assert.ok(f.read('B','two').fileInfo.webZipEditors.includes('editor'));
    await f.publish('one','edit-1','AAA-1');
    for(const [s,id]of [['A','origin'],['B','one'],['B','two']]){assert.equal(f.read(s,id).fileInfo.name,'AAA-1.html.zip');assert.equal(f.read(s,id).fileInfo.webZipPendingSync,undefined);}
    await f.publish('two','edit-2','AAA-2');
    for(const [s,id]of [['A','origin'],['B','one'],['B','two']]){assert.equal(f.read(s,id).fileInfo.name,'AAA-2.html.zip');assert.equal(f.read(s,id).fileInfo.webZipRevision,2);assert.equal(f.read(s,id).fileInfo.webZipPendingSync,undefined);}
    assert.equal(f.read('B','one').remark,'one');assert.equal(f.read('B','two').remark,'two');assert.equal(f.read('A','origin').remark,'source');
});
test('offline edits from either sibling coalesce to one durable latest source update across restart',async t=>{
    const f=setup(t);await f.approve();f.state.online=false;
    await f.publish('one','edit-1','AAA-1');
    assert.ok(f.read('B','two').fileInfo.webZipPendingSync);assert.equal(f.read('B','two').fileInfo.id,'edit-1');
    await f.publish('two','edit-2','AAA-2');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'jobs.json'))).jobs.length,1);
    f.restart();f.state.online=true;f.service.topologyChanged();await settled(()=>!f.read('B','one').fileInfo.webZipPendingSync&&!f.read('B','two').fileInfo.webZipPendingSync);
    assert.equal(f.read('A','origin').fileInfo.id,'edit-2');assert.equal(f.writes.filter(w=>w.s==='A'&&w.next.fileInfo.id==='edit-2').length,1);
});
test('same creator or claimed source metadata does not join unrelated or unverified webpage groups',async t=>{
    const f=setup(t),other={...clone(f.read('A','origin')),id:'other',fileInfo:{...clone(f.read('A','origin').fileInfo),id:'other-root'}};
    f.records.set('A:other',other);f.records.set('B:unrelated',{id:'unrelated',type:'file',forwardedFrom:{sessionId:'A',messageId:'other'},fileInfo:{...clone(other.fileInfo),id:'other-copy'}});
    f.records.set('B:forged',{id:'forged',type:'file',forwardedFrom:{sessionId:'A',messageId:'origin'},fileInfo:{...clone(f.read('A','origin').fileInfo),id:'forged-copy',webZipRootId:'root'}});
    await f.approve();await f.publish('one','edit-1','AAA-1');
    assert.deepEqual(f.read('B','unrelated').fileInfo.webZipEditors,[]);assert.equal(f.read('B','unrelated').fileInfo.id,'other-copy');
    assert.deepEqual(f.read('B','forged').fileInfo.webZipEditors,[]);assert.equal(f.read('B','forged').fileInfo.id,'forged-copy');
});
test('a source edit outside the group still blocks pending sync instead of overwriting independent work',async t=>{
    const f=setup(t);await f.approve();f.state.online=false;await f.publish('two','edit-1','AAA-1');
    Object.assign(f.read('A','origin').fileInfo,{id:'independent',webZipRootId:'root',webZipRevision:1});
    f.state.online=true;f.service.topologyChanged();await settled(()=>f.read('B','two').fileInfo.webZipPendingSync?.lastError==='WEB_ZIP_SOURCE_CHANGED');
    assert.equal(f.read('A','origin').fileInfo.id,'independent');assert.equal(f.read('B','one').fileInfo.webZipPendingSync.lastError,'WEB_ZIP_SOURCE_CHANGED');
});
test('an existing second-copy pending job resumes from the exact completed sibling version after restart',async t=>{
    const f=setup(t);f.state.list=false;await f.approve();
    await f.service.approve({sessionId:'B',messageId:'two',fileId:'copy-two',creatorDeviceId:'creator',deviceId:'editor'});
    await f.publish('one','edit-1','AAA-1');await f.publish('two','edit-2','AAA-2');
    assert.equal(f.read('B','two').fileInfo.webZipPendingSync.lastError,'WEB_ZIP_SOURCE_CHANGED');
    f.state.list=true;f.restart();f.service.topologyChanged();await settled(()=>!f.read('B','two').fileInfo.webZipPendingSync);
    assert.equal(f.read('A','origin').fileInfo.name,'AAA-2.html.zip');assert.equal(f.read('A','origin').fileInfo.webZipRevision,2);
    assert.equal(f.read('B','one').fileInfo.name,'AAA-2.html.zip');assert.equal(f.read('B','one').fileInfo.webZipPendingSync,undefined);
});
test('deleting the publishing record keeps the shared pending work alive on its remaining verified sibling',async t=>{
    const f=setup(t);await f.approve();f.state.online=false;await f.publish('one','edit-1','AAA-1');
    f.records.delete('B:one');f.service.recordChanged('B','one');
    await settled(()=>JSON.parse(fs.readFileSync(path.join(f.dir,'jobs.json'))).jobs[0]?.messageId==='two');
    f.restart();f.state.online=true;f.service.topologyChanged();await settled(()=>!f.read('B','two').fileInfo.webZipPendingSync);
    assert.equal(f.read('A','origin').fileInfo.id,'edit-1');assert.equal(f.read('B','one'),null);
});
test('target revocation before recovery prevents spreading a prepared publication to an untouched sibling',async t=>{
    const f=setup(t);f.state.list=false;await f.approve();
    f.state.online=false;await f.publish('one','edit-1','AAA-1');
    f.state.list=true;f.state.allowed=false;f.restart();f.service.topologyChanged();
    await settled(()=>f.read('B','one').fileInfo.webZipPendingSync.lastError==='WEB_ZIP_EDIT_DENIED');
    assert.equal(f.read('B','two').fileInfo.id,'copy-two');assert.equal(f.read('A','origin').fileInfo.id,'root');
});
test('target revocation while a sibling write waits is rechecked at commit',async t=>{
    const f=setup(t);await f.approve();f.state.online=false;
    let release;f.state.peerGate=new Promise(resolve=>release=resolve);
    const pending=f.publish('one','edit-1','AAA-1');await settled(()=>f.state.peerWaiting);f.state.allowed=false;release();await pending;
    assert.equal(f.read('B','two').fileInfo.id,'copy-two');assert.equal(f.read('A','origin').fileInfo.id,'root');
    f.state.peerGate=null;f.state.allowed=true;f.state.online=true;f.service.topologyChanged();await settled(()=>!f.read('B','one').fileInfo.webZipPendingSync);
    assert.equal(f.read('B','two').fileInfo.id,'edit-1');assert.equal(f.read('A','origin').fileInfo.id,'edit-1');
});
test('concurrent publications based on the old sibling versions cannot overwrite the first confirmed group update',async t=>{
    const f=setup(t);await f.approve();const outcomes=await Promise.allSettled([f.publish('one','edit-1','AAA-1'),f.publish('two','edit-2','AAA-2')]);
    assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,1);assert.equal(outcomes.filter(value=>value.status==='rejected').length,1);
    for(const [s,id]of [['A','origin'],['B','one'],['B','two']])assert.equal(f.read(s,id).fileInfo.id,'edit-1');
});
test('two webpages in one source collection keep separate roots when their forwarded collections are synchronized',async t=>{
    const f=setup(t),first={...clone(f.read('A','origin').fileInfo),webZipRootId:'root'},second={...clone(first),id:'other-root',webZipRootId:'other-root',name:'other.html.zip'};
    f.records.set('A:origin',{id:'origin',type:'collection',collection:{files:[first,second]}});
    for(const id of ['one','two'])f.records.set('B:'+id,{id,type:'collection',forwardedFrom:{sessionId:'A',messageId:'origin'},collection:{files:[{...clone(first),id:'copy-'+id},{...clone(second),id:'other-'+id}]}});
    await f.service.approve({sessionId:'B',messageId:'one',fileId:'copy-one',creatorDeviceId:'creator',deviceId:'editor'});
    for(const id of ['one','two']){const file=f.read('B',id).collection.files[0];assert.ok(file.webZipEditors.includes('editor'));assert.deepEqual(f.read('B',id).collection.files[1].webZipEditors,[]);}
    const current=f.read('B','one').collection.files[0],credential=f.service.issueCredential({sessionId:'B',messageId:'one',fileId:current.id,deviceId:'editor'});
    await f.service.publish({sessionId:'B',messageId:'one',fileId:current.id,deviceId:'editor',editCredential:credential,fileInfo:{id:'new-one',name:'AAA-1.html.zip',size:5,type:'application/zip'}});
    for(const [s,id]of [['A','origin'],['B','one'],['B','two']]){const files=f.read(s,id).collection.files;assert.equal(files[0].name,'AAA-1.html.zip');assert.equal(files[1].name,'other.html.zip');assert.deepEqual(files[1].webZipEditors,[]);}
});
test('real SQLite writer finds a sibling outside live history and commits alternating publications to all three anchors',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-copies-db-261117-')),infra=await require('../server/infra-store').createInfraStore({dataDir:dir});
    t.after(()=>{infra.close();assert.ok(dir.startsWith(path.join(os.tmpdir(),'webzip-copies-db-261117-')));fs.rmSync(dir,{recursive:true,force:true});});
    const page={id:'root',name:'AAA.html.zip',size:3,type:'application/zip',webZip:true,creatorDeviceId:'creator',ownerDeviceId:'creator',webZipEditors:[]};
    const original={id:'origin',type:'file',sender:'creator',fileInfo:page},one={id:'one',type:'file',sender:'creator',forwardedFrom:{sessionId:'A',messageId:'origin'},fileInfo:{...page,id:'copy-one'}},two={...clone(one),id:'two',fileInfo:{...clone(page),id:'copy-two'}};
    for(const [s,message]of [['A',original],['B',one],['B',two]])infra.recordHistoryMessage(s,message,{source:s==='B'?'cross-tunnel-forward':'web-zip-created'});infra.flush();
    const live=messages=>({devices:new Map([['editor',{socketId:'editor'}]]),history:messages.map(message=>({message,size:JSON.stringify(message).length})),historySize:messages.reduce((sum,message)=>sum+JSON.stringify(message).length,0),fileAssets:new Map(),deletedMessageIds:[]});
    const sessions=new Map([['A',live([original])],['B',live([one])]]),root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'server.js'),'utf8');
    const broadcasts=[],context={require:name=>require(path.join(root,name)),path,SERVER_DATA_DIR:dir,Map,Set,Date,JSON,Buffer,Promise,Error,setImmediate,console,
        app:{get(){},post(){}},crypto:require('node:crypto'),diskAuth:{sessionKey:Buffer.from('fixture'),user:()=>({permissionVersion:0}),users:()=>[],hasPermission:()=>true},
        sessions,infraStore:infra,io:{sockets:{sockets:new Map([['editor',{connected:true,data:{deviceId:'editor'}}]])}},MAX_MESSAGE_SIZE:1048576,MAX_HISTORY_SIZE:24*1048576,
        getHistoryMessageEntry:(session,id)=>session?.history.find(entry=>entry.message.id===id),createHistoryMessage:clone,
        enqueueInfraAudit:(task,_key,options)=>setImmediate(()=>{try{task();options.onSuccess();}catch(error){options.onFinalFailure(error);}}),
        emitToReadableSessionDevices:(_session,_event,value)=>broadcasts.push(value),scheduleSessionHistoryBroadcast(){},isFileAssetStillReferenced:()=>false,canUseTunnelCapability:()=>true,getNearbyCandidates:()=>[]};
    vm.runInNewContext(source.slice(source.indexOf('function readWebZipRecord('),source.indexOf("io.on('connection',"))+';globalThis.service=webZipSync;',context);
    await context.service.approve({sessionId:'B',messageId:'one',fileId:'copy-one',creatorDeviceId:'creator',deviceId:'editor'});
    assert.ok(infra.getHistoryMessage('B','two').fileInfo.webZipEditors.includes('editor'));
    for(const [messageId,id,name]of [['one','new-one','AAA-1.html.zip'],['two','new-two','AAA-2.html.zip']]){
        const file=infra.getHistoryMessage('B',messageId).fileInfo,info={id,name,size:5,type:'application/zip'};sessions.get('B').fileAssets.set(id,{metadata:info,providers:new Set(['editor'])});
        const credential=context.service.issueCredential({sessionId:'B',messageId,fileId:file.id,deviceId:'editor'});
        await context.service.publish({sessionId:'B',messageId,fileId:file.id,deviceId:'editor',fileInfo:info,editCredential:credential});
        for(const [s,anchor]of [['A','origin'],['B','one'],['B','two']]){const saved=infra.getHistoryMessage(s,anchor);assert.equal(saved.fileInfo.name,name);assert.equal(saved.fileInfo.webZipPendingSync,undefined);}
        const reader=new(require('node:sqlite').DatabaseSync)(infra.dbPath,{readOnly:true});try{assert.equal(JSON.parse(reader.prepare('SELECT payload_json FROM transfer_records WHERE session_id=? AND message_id=?').get('B','two').payload_json).fileInfo.name,name);}finally{reader.close();}
    }
    assert.equal(sessions.get('B').history.length,1,'enumeration must not expand the live history window');
    assert.ok(broadcasts.some(value=>value.sessionId==='B'&&value.message.id==='two'));
});
