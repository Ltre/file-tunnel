'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const part=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const {registerFileAssetHandlers}=require('../server/file-assets');
function gate(mode){
 const handlers=new Map(),errors=[],wire=[],logged=[],target={devices:new Map(),fileAssets:new Map()},sessions=new Map([['target-B',target]]);let middleware,sourceReads=0;
 const get=sessions.get.bind(sessions);sessions.get=id=>{if(id==='private-A')sourceReads++;return get(id);};
 const socket={id:'fixture-socket',data:{},on:(name,fn)=>handlers.set(name,fn),use:fn=>middleware=fn,to:()=>({emit:(...args)=>wire.push(args)}),emit:(...args)=>wire.push(args)};
 const ctx={socket,sessions,currentSession:mode==='early'?null:'target-B',currentDevice:mode==='early'?null:'viewer',trustedInternalClient:false,
  canUseTunnelCapability:()=>true,canReadForwardedFile:()=>false,canSeekDestinationCopy:()=>false,tunnelAccess:{verify:()=>false},infraStore:null,
  console:{error:(...args)=>logged.push(args)},emitSocketError:(name,message,details)=>errors.push({name,message,...details})};
 if(!['early','gone'].includes(mode))target.devices.set('viewer',{});
 vm.runInNewContext(part(server,'    socket.use(([event,data],next)=>{',"    socket.on('session-short-code-update'"),ctx);
 registerFileAssetHandlers(socket,{sessions,deviceSockets:new Map(),getSessionId:()=>ctx.currentSession,getDeviceId:()=>ctx.currentDevice,isValidId:id=>typeof id==='string'&&!!id,sanitize:String,historyLog(){}});
 return{errors,wire,logged,context:ctx,target,sourceReads:()=>sourceReads,send(event,data){middleware([event,data],()=>handlers.get(event)(data));}};
}
for(const event of ['file-asset-request','file-asset-discovery'])for(const mode of ['early','stale','gone'])test(event+' ignores '+mode+' session context without reporting missing source access or touching its data',()=>{
 const f=gate(mode);f.send(event,{sessionId:mode==='stale'?'old-target':'target-B',assetId:'copy',sourceSessionId:'private-A'});
 assert.equal(f.errors.length,0);assert.equal(f.wire.length,0);assert.equal(f.sourceReads(),0);
});

test('a pre-join recovery keeps its intent and the existing resume path retries after joining',async t=>{
 const f=gate('early'),window={};
 vm.runInNewContext(fs.readFileSync(path.join(root,'client/file-assets.js'),'utf8'),{window,Blob,ArrayBuffer,Uint8Array,DataView,setInterval:()=>0,clearInterval(){},setTimeout:()=>0,clearTimeout(){},console:{log(){}}});
 const transfer=new window.FileAssetTransfer({getSessionId:()=> 'target-B',getSocket:()=>({connected:true,emit:(event,data)=>f.send(event,data)}),load:async()=>null,getTunnelAuthorization:()=>null,log(){},onProgress(){}});
 t.after(()=>transfer.cancel('copy'));
 await transfer.request('copy','holder',{id:'copy',name:'copy.bin',size:123,type:'application/octet-stream',backupSourceSessionId:'private-A'});
 assert.equal(transfer.desiredAssets.has('copy'),true);assert.equal(f.errors.length,0);assert.equal(f.sourceReads(),0);
 f.context.currentSession='target-B';f.context.currentDevice='viewer';f.target.devices.set('viewer',{});f.context.canReadForwardedFile=()=>true;
 transfer.resumePending();assert.equal(f.errors.length,0);assert.ok(f.sourceReads()>0);assert.equal(transfer.desiredAssets.has('copy'),true);
});
for(const event of ['file-asset-request','file-asset-discovery'])test(event+' records a joined denial with safe correlation data rather than granting private access',()=>{
 const f=gate('joined');f.send(event,{sessionId:'target-B',assetId:'private-file',sourceSessionId:'private-A',recordMessageId:'record',requestId:'request',sourceDeviceId:'source-viewer',sourceAccessGrant:'SUPER_SECRET',authorization:'ALSO_SECRET'});
 assert.equal(f.errors.length,1);assert.equal(f.errors[0].code,'FILE_SOURCE_ACCESS_DENIED');
 const d=f.errors[0].diagnostic;assert.equal(d.marker,'CAONIMA-GPT');assert.equal(d.event,event);assert.equal(d.requestId,'request');
 assert.equal(d.currentSessionId,'target-B');assert.equal(d.assetId,'private-file');assert.equal(d.sourceAuthorized,false);
 assert.doesNotMatch(JSON.stringify([f.errors,f.logged]),/SUPER_SECRET|ALSO_SECRET/);assert.equal(f.sourceReads(),0);
});

test('the browser records correlated source diagnostics and cache-key presence without reading a file body or storing credentials',async()=>{
 const app=fs.readFileSync(path.join(root,'app.js'),'utf8'),logs=[];let readMethod='';
 const file={id:'file',name:'copy.bin',size:1024,backupSourceSessionId:'private-A',forwardedToSessionId:'target-B',data:'SECRET_BODY',forwardedSourceGrant:'SUPER_SECRET'};
 const state={sessionId:'target-B',deviceId:'viewer',socket:{id:'socket',connected:true},messages:[{id:'record',type:'file',sender:'forwarder',fileInfo:file,content:'SECRET_BODY'}],
  db:{transaction(names,mode){assert.deepEqual(Array.from(names),['files']);assert.equal(mode,'readonly');return{objectStore(){return{getKey(id){readMethod='getKey';const request={result:id};queueMicrotask(()=>request.onsuccess());return request;},get(){throw Error('must not load body');}};}};}}};
 const transfer={requestedMetadata:new Map([['file',file]]),requestIds:new Map([['file','request']]),desiredAssets:new Map([['file','holder']]),activeDownloads:new Set(['file']),downloadQueue:[],transfers:new Map(),multiSourceTransfers:new Map()};
 const ctx={state,fileAssetTransfer:transfer,savedTunnelGrant:()=> 'SECRET_GRANT',window:{BrowserLogs:{record:(...args)=>logs.push(args)}}};
 vm.runInNewContext(part(app,'function recordSourceAccessFailure(', 'function requestSessionHistory('),ctx);
 ctx.recordSourceAccessFailure({diagnostic:{marker:'CAONIMA-GPT',requestId:'request',assetId:'file',recordMessageId:'record',event:'file-asset-request',records:[{recordId:'record',fileId:'file'}]}});
 await Promise.resolve();assert.equal(readMethod,'getKey');assert.ok(logs.length>=5);
 assert.ok(logs.every(row=>row[0]==='error'&&row[1]==='CAONIMA-GPT'&&row[3].correlation==='request'));
 assert.equal(logs.find(row=>row[2]==='client-cache-key')[3].present,true);
 assert.doesNotMatch(JSON.stringify(logs),/SECRET_BODY|SUPER_SECRET|SECRET_GRANT/);
});

test('the toast handler captures translated legacy source denials as well as modern diagnostic codes',()=>{
 const app=fs.readFileSync(path.join(root,'app.js'),'utf8'),callbacks=new Map(),captured=[],toasts=[];
 vm.runInNewContext(part(app,"    state.socket.on('permission-denied',", "    state.socket.on('tunnel-access-grant',"),{
  state:{socket:{on:(name,run)=>callbacks.set(name,run)}},window:{TunnelI18n:{t:()=> '翻訳済みのソース権限エラー'}},
  recordSourceAccessFailure:value=>captured.push(value),showAppToast:value=>toasts.push(value),TUNNEL_PERMISSION_LABELS:{}
 });
 for(const data of [{message:'来源隧道尚未获得访问权'},{message:'翻訳済みのソース権限エラー'},{code:'FILE_SOURCE_ACCESS_DENIED',message:'another locale'},{message:'unrelated permission'}])callbacks.get('permission-denied')(data);
 assert.equal(captured.length,3);assert.equal(toasts.length,4);
});

test('denial diagnostics expose only tombstone status for removed records and no target metadata without read permission',()=>{
 const f=gate('joined');f.context.infraStore={query:()=>[{message_id:'deleted',deleted_at:1,removed_at:null,payload_json:JSON.stringify({id:'deleted',sender:'HIDDEN_SENDER',fileInfo:{id:'private-file',name:'HIDDEN_FILE'}})}]};
 f.send('file-asset-request',{sessionId:'target-B',sourceSessionId:'private-A',assetId:'private-file'});
 assert.equal(f.errors[0].diagnostic.records[0].deleted,true);assert.doesNotMatch(JSON.stringify(f.errors),/HIDDEN_SENDER|HIDDEN_FILE/);
 f.context.canUseTunnelCapability=()=>false;f.send('file-asset-request',{sessionId:'target-B',sourceSessionId:'private-A',assetId:'private-file'});
 assert.equal(f.errors[1].diagnostic.records.length,0);assert.equal(f.errors[1].diagnostic.liveHistoryCount,undefined);
 f.context.canUseTunnelCapability=()=>true;f.context.infraStore.query=()=>{throw Error('SQLITE_MISUSE: database is not open');};
 f.send('file-asset-request',{sessionId:'target-B',sourceSessionId:'private-A',assetId:'private-file'});
 assert.match(f.errors[2].diagnostic.recordLookupError.message,/database is not open/);
});

test('an unavailable diagnostic logger cannot interrupt the original permission feedback path',()=>{
 const app=fs.readFileSync(path.join(root,'app.js'),'utf8'),ctx={state:{sessionId:'target-B'},fileAssetTransfer:null,window:{BrowserLogs:{record(){throw Error('fixture logger unavailable');}}}};
 vm.runInNewContext(part(app,'function recordSourceAccessFailure(', 'function requestSessionHistory('),ctx);
 assert.doesNotThrow(()=>ctx.recordSourceAccessFailure({diagnostic:{assetId:'file'}}));
});
