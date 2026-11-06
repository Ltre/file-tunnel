'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const section=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
const ids={A:'11111111-1111-4111-8111-111111111111',B:'22222222-2222-4222-8222-222222222222',creator:'33333333-3333-4333-8333-333333333333',editor:'44444444-4444-4444-8444-444444444444',H:'55555555-5555-4555-8555-555555555555',R:'66666666-6666-4666-8666-666666666666',origin:'77777777-7777-4777-8777-777777777777',copy:'88888888-8888-4888-8888-888888888888',oldA:'99999999-9999-4999-8999-999999999999',oldB:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',next:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
test('actual publish callback, SQLite persistence and copied-file read gate defer and resume without joining the editor to the source',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-integration-'));
    const infra=await require('../server/infra-store').createInfraStore({dataDir:dir});
    t.after(()=>{infra.close();assert.ok(dir.startsWith(path.join(os.tmpdir(),'webzip-integration-')));fs.rmSync(dir,{recursive:true,force:true});});
    const committed=(sessionId,messageId)=>{const reader=new(require('node:sqlite').DatabaseSync)(infra.dbPath,{readOnly:true});try{return JSON.parse(reader.prepare('SELECT payload_json FROM transfer_records WHERE session_id = ? AND message_id = ?').get(sessionId,messageId)?.payload_json||'null');}finally{reader.close();}};
    const file={id:ids.oldA,name:'page.html.zip',size:3,type:'application/zip',webZip:true,creatorDeviceId:ids.creator,webZipEditors:[ids.editor],ownerDeviceId:ids.creator};
    const original={id:ids.origin,type:'file',sender:ids.creator,timestamp:10,fileInfo:file,remark:'keep source'};
    const copy={id:ids.copy,type:'file',sender:ids.editor,timestamp:20,fileInfo:{...file,id:ids.oldB,ownerDeviceId:ids.editor},forwardedFrom:{sessionId:ids.A,messageId:ids.origin}};
    infra.recordHistoryMessage(ids.A,original);infra.recordHistoryMessage(ids.B,copy,{source:'cross-tunnel-forward'});
    const sessions=new Map([[ids.B,{devices:new Map([[ids.editor,{socketId:'editor-B'}]]),history:[{message:copy,size:JSON.stringify(copy).length}],historySize:JSON.stringify(copy).length,fileAssets:new Map([[ids.next,{metadata:{id:ids.next,name:'updated.html.zip',size:5,type:'application/zip'},providers:new Set([ids.editor])}]]),deletedMessageIds:[]}]]);
    const sockets=new Map([['editor-B',{connected:true,data:{deviceId:ids.editor}}]]),handlers=new Map(),broadcasts=[];
    const context={require:name=>require(path.join(root,name)),path,SERVER_DATA_DIR:dir,Map,Set,Date,JSON,Buffer,Promise,Error,setImmediate,console,
        sessions,infraStore:infra,io:{sockets:{sockets}},MAX_MESSAGE_SIZE:1048576,MAX_HISTORY_SIZE:24*1048576,
        getHistoryMessageEntry:(session,id)=>session?.history.find(entry=>entry.message.id===id),createHistoryMessage:value=>JSON.parse(JSON.stringify(value)),
        enqueueInfraAudit:(task,_key,options)=>{setImmediate(()=>{try{task();options.onSuccess();}catch(error){options.onFinalFailure(error);}});return true;},
        emitToReadableSessionDevices:(session,_event,value)=>broadcasts.push({session,value}),scheduleSessionHistoryBroadcast(){},isFileAssetStillReferenced:()=>false,
        canUseTunnelCapability:session=>Boolean(session),getNearbyCandidates:()=>[],socket:{on:(name,run)=>handlers.set(name,run)},currentSession:ids.B,currentDevice:ids.editor,checkMessageRate:()=>true,isValidDeviceId:value=>/^[\da-f-]{36}$/i.test(value),
        getOrCreateTelegramSession:sessionId=>{const value={devices:new Map(),history:[],fileAssets:new Map(),deletedMessageIds:[]};sessions.set(sessionId,value);return value;},
        tunnelAccess:{verifyFileForward:()=>false}
    };
    vm.runInNewContext(section(server,'function readWebZipRecord(',"io.on('connection',")+';globalThis.service=webZipSync;',context);
    vm.runInContext(section(server,"    socket.on('web-zip-publish',","    socket.on('web-zip-edit-request',"),context);
    let credentialResult;handlers.get('web-zip-edit-credential')({sessionId:ids.B,messageId:ids.copy,fileId:ids.oldB},result=>credentialResult=result);
    assert.equal(credentialResult.ok,true);assert.match(credentialResult.credential,/^we1\./);
    assert.equal(JSON.stringify(committed(ids.B,ids.copy)).includes(credentialResult.credential),false,'the private credential must not enter shared record metadata');
    let ack;await handlers.get('web-zip-publish')({sessionId:ids.B,messageId:ids.copy,fileId:ids.oldB,editCredential:credentialResult.credential,fileInfo:{id:ids.next,name:'updated.html.zip',size:5,type:'application/zip'}},result=>ack=result);
    assert.equal(ack.ok,true);assert.equal(ack.message.fileInfo.webZipPendingSync.sessionId,ids.A);assert.equal(infra.getHistoryMessage(ids.A,ids.origin).fileInfo.id,ids.oldA);assert.equal(sessions.has(ids.A),false,'looking up the original record must not create membership or a live source session');
    assert.equal(committed(ids.B,ids.copy)?.fileInfo.id,ids.next,'publication must commit before returning success, rather than wait for the normal audit debounce');
    sessions.set(ids.A,{devices:new Map([[ids.H,{socketId:'helper-A'}],[ids.R,{socketId:'viewer-A'}]]),history:[{message:original,size:JSON.stringify(original).length}],historySize:JSON.stringify(original).length,fileAssets:new Map(),deletedMessageIds:[]});
    sockets.set('helper-A',{connected:true,data:{deviceId:ids.H}});sockets.set('helper-B',{connected:true,data:{deviceId:ids.H}});sockets.set('viewer-A',{connected:true,data:{deviceId:ids.R}});sessions.get(ids.B).devices.set(ids.H,{socketId:'helper-B'});
    context.service.topologyChanged();
    for(let n=0;n<100&&infra.getHistoryMessage(ids.B,ids.copy).fileInfo.webZipPendingSync;n++)await new Promise(resolve=>setTimeout(resolve,10));
    const updated=infra.getHistoryMessage(ids.A,ids.origin);assert.equal(updated.fileInfo.id,ids.next);assert.equal(updated.remark,'keep source');assert.equal(sessions.get(ids.A).devices.has(ids.editor),false);assert.equal(infra.getHistoryMessage(ids.B,ids.copy).fileInfo.webZipPendingSync,undefined);
    assert.equal(committed(ids.A,ids.origin)?.fileInfo.id,ids.next,'the original must commit before its pending marker is cleared');
    assert.equal(updated.fileInfo.backupSourceSessionId,ids.B);assert.equal(updated.fileInfo.forwardedToSessionId,ids.A);
    assert.ok(broadcasts.some(value=>value.value.sessionId===ids.A));
    vm.runInContext(section(server,'function canReadForwardedFile(', 'function getSessionPermissionPayload('),context);
    delete sessions.get(ids.A).history[0].forwardedSourceSessionId;
    assert.equal(context.canReadForwardedFile(ids.A,ids.R,ids.B,ids.next),true,'the persisted copied-file provenance authorizes only the updated bytes after the volatile marker is lost');
    assert.equal(context.canReadForwardedFile(ids.A,ids.R,ids.B,'private-file'),false);
    assert.equal(sessions.get(ids.B).devices.has(ids.R),false,'the source-only viewer is not granted membership in the editing tunnel');
    context.currentSession=ids.A;let rejected;await handlers.get('web-zip-publish')({sessionId:ids.B,messageId:ids.copy,fileId:ids.next,fileInfo:{id:ids.oldB}},result=>rejected=result);
    assert.equal(rejected.ok,false);
    handlers.get('web-zip-edit-credential')({sessionId:ids.B,messageId:ids.copy,fileId:ids.next},result=>rejected=result);assert.equal(rejected.error,'invalid-session');
    // A later pending update also resumes when the editor arrives directly in
    // A after a restart, with B absent from the live session map.
    const next2='cccccccc-cccc-4ccc-8ccc-cccccccccccc';sockets.get('helper-A').connected=false;context.currentSession=ids.B;
    sessions.get(ids.B).fileAssets.set(next2,{metadata:{id:next2,name:'later.html.zip',size:7,type:'application/zip'},providers:new Set([ids.editor])});
    await handlers.get('web-zip-publish')({sessionId:ids.B,messageId:ids.copy,fileId:ids.next,fileInfo:{id:next2,name:'later.html.zip',size:7,type:'application/zip'}},result=>ack=result);
    assert.ok(ack.message.fileInfo.webZipPendingSync);assert.equal(infra.getHistoryMessage(ids.A,ids.origin).fileInfo.id,ids.next);
    sessions.delete(ids.B);assert.equal(context.canSyncWebZipSource(ids.editor,ids.A),false);
    sessions.get(ids.A).devices.set(ids.editor,{socketId:'editor-A'});sockets.set('editor-A',{connected:true,data:{deviceId:ids.editor}});
    assert.equal(context.canSyncWebZipSource(ids.editor,ids.A),true);context.service.topologyChanged();
    for(let n=0;n<100&&infra.getHistoryMessage(ids.B,ids.copy).fileInfo.webZipPendingSync;n++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(infra.getHistoryMessage(ids.A,ids.origin).fileInfo.id,next2,JSON.stringify(infra.getHistoryMessage(ids.B,ids.copy).fileInfo.webZipPendingSync));assert.equal(infra.getHistoryMessage(ids.B,ids.copy).fileInfo.webZipPendingSync,undefined);
    assert.equal(sessions.get(ids.B).devices.size,0,'loading stored policy must not join the editor to B either');
    const recovered=[];sessions.get(ids.B).devices.set(ids.editor,{socketId:'editor-B'});context.currentSession=ids.B;
    Object.assign(context,{MAX_HISTORY_MESSAGES:100,clientIp:'127.0.0.1',resumePendingSnsMetadataScans(){},historyLog(){},
        addToSessionHistory:(_id,_session,message)=>{recovered.push(message);return{stored:true};}});
    vm.runInContext(section(server,"    socket.on('history-reconcile',","    socket.on('session-history-ack',"),context);
    handlers.get('history-reconcile')({sessionId:ids.B,messages:[copy]});
    assert.equal(recovered[0]?.fileInfo.id,next2,'a stale browser snapshot cannot replace the persisted webpage on a cold server');
    for(let n=0;n<100&&JSON.parse(fs.readFileSync(path.join(dir,'web-zip-sync.json'))).jobs.length;n++)await new Promise(resolve=>setTimeout(resolve,10));
});
test('late pending-state messages cannot replace a completed webpage sync in the actual history update boundary',async()=>{
    const app=fs.readFileSync(path.join(root,'app.js'),'utf8'),start=app.indexOf('const snsMarkdownUpdates =');
    const prefix=app.slice(start,app.indexOf('    if (previous) {',start));
    let record={id:'copy',webZipUpdateVersion:1};const written=[];
    const context={Map,Promise,Number,state:{sessionId:'B'},isHistoryMessageDeleted:()=>false,getFromStore:async()=>record,
        write:async message=>{if(message.webZipUpdateVersion===2)await new Promise(resolve=>setTimeout(resolve,20));record=message;written.push(message.webZipUpdateVersion);}};
    vm.runInNewContext(prefix+'await write(message);}\nglobalThis.apply=applyHistoryMessageUpdate;',context);
    await Promise.all([context.apply({id:'copy',webZipUpdateVersion:2,pending:true}),context.apply({id:'copy',webZipUpdateVersion:3})]);
    await context.apply({id:'copy',webZipUpdateVersion:2,pending:true});assert.equal(record.webZipUpdateVersion,3);assert.equal(record.pending,undefined);assert.deepEqual(written,[2,3]);
});

test('the real webpage writer retries a failed commit without acknowledging, broadcasting or advancing its version twice',async t=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-writer-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    const previous={id:'page',sessionId:'A',type:'file',fileInfo:{id:'old',webZip:true}},next={...previous,fileInfo:{id:'new',webZip:true}};
    let stored=previous,flushes=0,committed=false;const delivered=[];
    const context={require:name=>require(path.join(root,name)),path,SERVER_DATA_DIR:directory,Map,Set,Date,JSON,Buffer,Promise,Error,setImmediate,
        console:{warn(){},error(){}},sessions:new Map(),io:{sockets:{sockets:new Map()}},MAX_MESSAGE_SIZE:1048576,MAX_HISTORY_SIZE:24*1048576,
        infraAuditPendingByKey:new Map(),infraAuditQueue:[],infraAuditDrainScheduled:false,INFRA_AUDIT_MAX_ATTEMPTS:3,
        infraStore:{getHistoryMessage:()=>stored,recordHistoryMessage:(_session,message)=>{stored=message;return{updated:true};},flush:()=>{committed=++flushes>1;return committed;}},
        getHistoryMessageEntry:()=>null,createHistoryMessage:value=>JSON.parse(JSON.stringify(value)),
        emitToReadableSessionDevices:(_session,_event,value)=>{assert.equal(committed,true);delivered.push(value);},scheduleSessionHistoryBroadcast(){},isFileAssetStillReferenced:()=>false,
        getNearbyCandidates:()=>[],canUseTunnelCapability:()=>false};
    vm.runInNewContext(section(server,'function finishInfraAuditEntry(','function persistHistoryAudit(')+section(server,'function readWebZipRecord(',"io.on('connection',"),context);
    const saved=await context.writeWebZipRecord('A',previous,next);
    assert.equal(flushes,2);assert.equal(saved.webZipUpdateVersion,1);assert.equal(delivered.length,1);assert.equal(stored.fileInfo.id,'new');
});
