'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'server.js'),'utf8');
const part=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
test('two source-anchor updates commit through real publish handlers and SQLite while both devices remain in another tunnel',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-offline-source-')),infra=await require('../server/infra-store').createInfraStore({dataDir:dir});
 t.after(()=>{infra.close();assert.ok(dir.startsWith(path.join(os.tmpdir(),'webzip-offline-source-')));fs.rmSync(dir,{recursive:true,force:true});});
 const [A,B,creator,editor,sourceEditor,origin,copyId,oldSource,oldCopy,next1,next2,next3]=Array.from({length:12},(_,i)=>i.toString(16).padStart(8,'0')+'-0000-4000-8000-000000000001');
 const file={id:oldSource,name:'page.html.zip',size:3,type:'application/zip',webZip:true,creatorDeviceId:creator,webZipEditors:[editor]},original={id:origin,type:'file',sender:creator,fileInfo:file};
 const copy={id:copyId,type:'file',sender:editor,fileInfo:{...file,id:oldCopy},forwardedFrom:{sessionId:A,messageId:origin}};
 infra.recordHistoryMessage(A,original);infra.recordHistoryMessage(B,copy,{source:'cross-tunnel-forward'});infra.flush();
 const access=require('../server/tunnel-access').createTunnelAccess(dir),handlers=new Map(),peer={id:'editor-B',connected:true,data:{deviceId:editor},on:(name,fn)=>handlers.set(name,fn)};
 const live={devices:new Map([[editor,{socketId:peer.id}],[creator,{socketId:'creator-B'}]]),history:[{message:copy,size:JSON.stringify(copy).length}],historySize:JSON.stringify(copy).length,fileAssets:new Map(),deletedMessageIds:[]};
 const sessions=new Map([[B,live]]),sockets=new Map([[peer.id,peer],['creator-B',{connected:true,data:{deviceId:creator}}]]),writes=[];
 const context={require:name=>require(path.join(root,name)),path,SERVER_DATA_DIR:dir,Map,Set,Date,JSON,Buffer,Promise,Error,setImmediate,console,sessions,infraStore:infra,io:{sockets:{sockets}},tunnelAccess:access,
  MAX_MESSAGE_SIZE:1048576,MAX_HISTORY_SIZE:24*1048576,currentSession:B,currentDevice:editor,profileDevice:null,clientIp:'127.0.0.1',socket:peer,checkMessageRate:()=>true,isValidDeviceId:value=>/^[\da-f-]{36}$/i.test(value),isValidSessionId:value=>[A,B].includes(value),normalizeShortCode:value=>value||'',reserveShortCode:()=>true,historyLog(){},
  sanitizeString:(value,limit)=>String(value||'').slice(0,limit),getNearbyCandidates:()=>[],
  getHistoryMessageEntry:(session,id)=>session?.history.find(entry=>entry.message.id===id),createHistoryMessage:value=>JSON.parse(JSON.stringify(value)),
  enqueueInfraAudit:(task,_key,options)=>setImmediate(()=>{try{task();options.onSuccess();}catch(error){options.onFinalFailure(error);}}),
  emitToReadableSessionDevices:(_session,_event,value)=>writes.push(value),scheduleSessionHistoryBroadcast(){},isFileAssetStillReferenced:()=>false};
 vm.runInNewContext(part('const DEFAULT_TUNNEL_PERMISSIONS =','function canReadForwardedFile(')+part('function readWebZipRecord(',"io.on('connection',")+';globalThis.service=webZipSync;',context);
 infra.setTunnelAccess(A,creator,{read:true});
 vm.runInContext(part("    socket.on('register-session-codes',",'    // 信令转发')+part("    socket.on('web-zip-publish',","    socket.on('web-zip-edit-request',"),context);
 handlers.get('register-session-codes')({entries:[{sessionId:A,shortCode:'',deviceId:sourceEditor,accessGrant:access.issue(A,sourceEditor)},{sessionId:B,shortCode:'',deviceId:editor,accessGrant:access.issue(B,editor)}]});
 let current=oldCopy;
 for(const next of [next1,next2]){
  let credential;handlers.get('web-zip-edit-credential')({sessionId:B,messageId:copyId,fileId:current},result=>credential=result);assert.equal(credential.ok,true);
  const info={id:next,name:'updated.html.zip',size:5,type:'application/zip'};live.fileAssets.set(next,{metadata:info,providers:new Set([editor])});
  let ack;await handlers.get('web-zip-publish')({sessionId:B,messageId:copyId,fileId:current,fileInfo:info,editCredential:credential.credential},result=>ack=result);
  assert.equal(ack.ok,true);assert.equal(ack.message.fileInfo.webZipPendingSync,undefined);
  const reader=new(require('node:sqlite').DatabaseSync)(infra.dbPath,{readOnly:true});try{
   const saved=JSON.parse(reader.prepare('SELECT payload_json FROM transfer_records WHERE session_id=? AND message_id=?').get(A,origin).payload_json);assert.equal(saved.fileInfo.id,next);assert.equal(saved.id,origin);
  }finally{reader.close();}
  assert.equal(sessions.has(A),false,'reading source permissions must not create or join a live source session');assert.equal(live.devices.size,2);current=next;
 }
 assert.equal(writes.filter(value=>value.sessionId===A).length,2);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'web-zip-sync.json'),'utf8')).jobs,[]);
 infra.setTunnelAccess(A,creator,{read:true},Date.now(),{},{[sourceEditor]:{permissions:{read:false}}});
 assert.equal(context.canSyncWebZipSource(editor,A,B),false,'the persisted source read revocation is checked even though the signed admission remains valid');
 let credential;handlers.get('web-zip-edit-credential')({sessionId:B,messageId:copyId,fileId:current},result=>credential=result);assert.equal(credential.ok,true);
 const info={id:next3,name:'pending.html.zip',size:6,type:'application/zip'};live.fileAssets.set(next3,{metadata:info,providers:new Set([editor])});
 let ack;await handlers.get('web-zip-publish')({sessionId:B,messageId:copyId,fileId:current,fileInfo:info,editCredential:credential.credential},result=>ack=result);
 assert.equal(ack.ok,true);assert.ok(ack.message.fileInfo.webZipPendingSync);assert.equal(infra.getHistoryMessage(A,origin).fileInfo.id,next2);
 infra.setTunnelAccess(A,creator,{read:true});context.service.topologyChanged();
 for(let n=0;n<100&&infra.getHistoryMessage(A,origin).fileInfo.id!==next3;n++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(infra.getHistoryMessage(A,origin).fileInfo.id,next3);assert.equal(sessions.has(A),false);
 for(let n=0;n<100&&JSON.parse(fs.readFileSync(path.join(dir,'web-zip-sync.json'),'utf8')).jobs.length;n++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'web-zip-sync.json'),'utf8')).jobs,[]);
});
