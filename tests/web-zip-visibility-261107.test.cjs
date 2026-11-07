'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),part=(a,b)=>server.slice(server.indexOf(a),server.indexOf(b,server.indexOf(a)));
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-visible-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const access=require('../server/tunnel-access').createTunnelAccess(dir),handlers=new Map(),sockets=new Map(),sessions=new Map();let changes=0;
 const socket={id:'editor-A',connected:true,data:{deviceId:'editor-A'}};sockets.set(socket.id,socket);sessions.set('A',{shortCode:'AAAAA',devices:new Map([['editor-A',{socketId:socket.id}]])});
 const context={Map,Set,sessions,io:{sockets:{sockets}},canUseTunnelCapability:(_s,id)=>id!=='denied',getNearbyCandidates:()=>[],socket:{...socket,on:(key,fn)=>handlers.set(key,fn)},
  tunnelAccess:access,infraStore:{findShortCodeForSession:id=>id==='A'?'AAAAA':'BBBBB'},normalizeShortCode:x=>x,isValidSessionId:x=>['A','B'].includes(x),reserveShortCode:()=>true,historyLog(){},currentSession:'A',currentDevice:'editor-A',profileDevice:null,clientIp:'127.0.0.1',console,
  webZipSync:{topologyChanged:()=>changes++}};
 vm.runInNewContext(part('function canSyncWebZipSource(','const webZipSync =')+part("    socket.on('register-session-codes',","    // 信令转发"),context);
 const register=(s=socket,proofs={A:'editor-A',B:'editor-B'})=>{context.socket=s;handlers.get('register-session-codes')({entries:Object.entries(proofs).map(([sessionId,deviceId])=>({sessionId,deviceId,shortCode:sessionId==='A'?'AAAAA':'BBBBB',accessGrant:access.issue(sessionId,deviceId)}))});};
 return{context,socket,sessions,sockets,register,get changes(){return changes;},handlers};
}
test('a device using different verified tunnel identities can resume its publication after moving to the source, without its creator',t=>{
 const f=setup(t);assert.equal(f.context.canSyncWebZipSource('editor-B','A','B'),false);f.register();
 assert.equal(f.context.canSyncWebZipSource('editor-B','A','B'),true);
 assert.equal(f.changes,1,'late directory proofs must retry pending sync after join has already fired');
 assert.equal(f.sessions.has('B'),false,'identity proof does not create membership');
 assert.equal(f.context.canSyncWebZipSource('other-editor','A','B'),false);
 assert.equal(f.context.canSyncWebZipSource('editor-B','A','unrelated'),false);
 f.socket.connected=false;assert.equal(f.context.canSyncWebZipSource('editor-B','A','B'),false);
});
test('unverified claimed identities cannot create a visible source path',t=>{
 const f=setup(t);f.handlers.get('register-session-codes')({entries:[{sessionId:'B',shortCode:'BBBBB',deviceId:'editor-B',accessGrant:'forged'}]});
 assert.equal(f.context.canSyncWebZipSource('editor-B','A','B'),false);assert.equal(f.changes,0);
});
test('an online visible helper may have a separate identity in the source, but must retain read permission',t=>{
 const f=setup(t);f.socket.data.deviceId='helper-A';f.sessions.get('A').devices=new Map([['helper-A',{socketId:f.socket.id}]]);
 f.register(f.socket,{A:'helper-A',B:'helper-B'});
 f.sessions.set('B',{devices:new Map([['editor-B',{socketId:'editor-B'}],['helper-B',{socketId:'helper-B'}]])});
 f.sockets.set('editor-B',{connected:true,data:{deviceId:'editor-B'}});f.sockets.set('helper-B',{connected:true,data:{deviceId:'helper-B'}});
 assert.equal(f.context.canSyncWebZipSource('editor-B','A','B'),true);
 f.context.canUseTunnelCapability=()=>false;assert.equal(f.context.canSyncWebZipSource('editor-B','A','B'),false);
});
test('durable pending work resumes through a verified identity when the creator is absent and the source editor list has not mirrored the grant',async t=>{
 const f=setup(t),directory=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-pending-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const original={id:'original-file',name:'page.html.zip',size:3,type:'application/zip',webZip:true,creatorDeviceId:'creator',webZipEditors:[]},copy={...original,id:'copy-file',webZipEditors:['editor-B']};
 const records=new Map([['A:original',{id:'original',type:'file',sender:'creator',fileInfo:original}],['B:copy',{id:'copy',type:'file',sender:'editor-B',fileInfo:copy,forwardedFrom:{sessionId:'A',messageId:'original'}}]]);
 const service=require('../server/web-zip-sync').createWebZipSync({filename:path.join(directory,'pending.json'),credentials:require('../server/web-zip-credentials').createWebZipCredentials({dataDir:directory}),
  readRecord:(s,id)=>records.get(s+':'+id),writeRecord:async(s,previous,next,options={})=>{assert.notEqual(options.check?.(),false);records.set(s+':'+previous.id,next);return next;},
  canPublish:(s,id)=>s==='B'&&id==='editor-B',hasContent:()=>true,isForwardedCopy:()=>true,canSync:f.context.canSyncWebZipSource});
 f.context.webZipSync=service;
 const credential=service.issueCredential({sessionId:'B',messageId:'copy',fileId:'copy-file',deviceId:'editor-B'});
 await service.publish({sessionId:'B',messageId:'copy',fileId:'copy-file',deviceId:'editor-B',editCredential:credential,fileInfo:{id:'new-file',name:'new.html.zip',size:5,type:'application/zip'}});
 assert.ok(records.get('B:copy').fileInfo.webZipPendingSync);assert.equal(records.get('A:original').fileInfo.id,'original-file');
 f.register();
 for(let n=0;n<100&&records.get('B:copy').fileInfo.webZipPendingSync;n++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(records.get('A:original').fileInfo.id,'new-file');assert.equal(records.get('B:copy').fileInfo.webZipPendingSync,undefined);
 assert.equal(f.sessions.has('B'),false);assert.equal(f.sessions.get('A').devices.has('creator'),false);
 for(let n=0;n<100&&JSON.parse(fs.readFileSync(path.join(directory,'pending.json'))).jobs.length;n++)await new Promise(resolve=>setTimeout(resolve,10));
});

test('nearby online devices qualify without sharing the editing tunnel, but unrelated or offline devices do not',t=>{
 const f=setup(t);f.socket.data.deviceId='nearby-source';f.sessions.get('A').devices=new Map([['nearby-source',{socketId:f.socket.id}]]);
 f.context.getNearbyCandidates=id=>id==='editor-B'?[{deviceId:'nearby-source'}]:[];
 assert.equal(f.context.canSyncWebZipSource('editor-B','A','B'),true);
 f.context.getNearbyCandidates=()=>[];assert.equal(f.context.canSyncWebZipSource('editor-B','A','B'),false);
 f.register(f.socket,{A:'nearby-source',B:'nearby-other-identity'});
 f.context.getNearbyCandidates=()=>[{deviceId:'nearby-other-identity'}];assert.equal(f.context.canSyncWebZipSource('editor-B','A','B'),true);
 f.context.getNearbyCandidates=()=>[{deviceId:'nearby-source'}];f.socket.connected=false;assert.equal(f.context.canSyncWebZipSource('editor-B','A','B'),false);
});
