'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm');
const {createAdminAuth}=require('../server/admin-auth'),{createTunnelAccess}=require('../server/tunnel-access'),{createTaskAutoCache}=require('../server/task-auto-cache');
const read=name=>fs.readFileSync(name,'utf8'),tick=()=>new Promise(setImmediate);
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dr2t-261015-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('administrator signature survives reconstruction; stale duplicate and malformed cookies do not mask the valid session',t=>{
    const dataDir=directory(t);fs.writeFileSync(path.join(dataDir,'.gauth-admin.json'),JSON.stringify({secret:'JBSWY3DPEHPK3PXP',createdAt:'fixture'}));
    const first=createAdminAuth({dataDir}),token=first.createSession(),key=fs.readFileSync(path.join(dataDir,'.admin-session.key'),'utf8'),again=createAdminAuth({dataDir});
    const request={headers:{cookie:'tunnel_admin_session=invalid; tunnel_admin_session='+token+'; tunnel_admin_session=%ZZ'}};
    assert.equal(again.isAuthenticated(request),true);assert.equal(again.diagnose(request),'VALID');assert.equal(fs.readFileSync(path.join(dataDir,'.admin-session.key'),'utf8'),key);
    assert.equal(again.diagnose({headers:{}}),'COOKIE_MISSING');assert.equal(again.diagnose({headers:{cookie:'tunnel_admin_session='+token+'x'}}),'SESSION_SIGNATURE_MISMATCH');
    fs.writeFileSync(path.join(dataDir,'.admin-session.key'),'');assert.throws(()=>again.createSession(),/SIGNING_KEY_EMPTY/);assert.equal(fs.readFileSync(path.join(dataDir,'.admin-session.key'),'utf8'),'','never regenerate a damaged key silently');
});
test('tunnel grants are durable, bound to both identifiers, cannot be forged, and short-code attempts are bounded',t=>{
    const dir=directory(t),gate=createTunnelAccess(dir),token=gate.issue('tunnel','device');assert.equal(createTunnelAccess(dir).verify(token,'tunnel','device'),true);
    assert.equal(gate.verify(token,'other','device'),false);assert.equal(gate.verify(token,'tunnel','other'),false);assert.equal(gate.verify(token+'x','tunnel','device'),false);
    for(let i=0;i<40;i++)assert.equal(gate.attempt('fixture'),true);assert.equal(gate.attempt('fixture'),false);
});
test('entry authorization returns unknown links to plain selection, preserves disk parameters and keeps owned offline caches usable',async()=>{
    const source=read('app.js'),snippet=source.slice(source.indexOf('function savedTunnelGrant('),source.indexOf('async function initSession()'));
    for(const [reply,stored,creating,expected] of [[{allowed:false},'',false,false],[{allowed:true,creating:true},'',false,false],[{allowed:true,creating:true},'',true,true],[null,'signed-credential',false,true]]){
        let target='';const state={sessionId:'fixture-session',deviceId:'fixture-device',shortCode:'',pendingRecordId:'record',pendingTunnelInviteReceipt:{sessionId:'fixture-session'}},values=new Map(stored?[['tunnel-access:fixture-session',stored]]:[]);
        const context=vm.createContext({state,URL,localStorage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)},sessionStorage:{getItem:()=>creating?'1':null},history:{replaceState:(_a,_b,url)=>{target=url;}},window:{location:{href:'http://localhost/disk?disk_path=collection#fixture-session'}},fetch:async()=>{if(reply===null)throw Error('offline');return {status:reply.allowed?200:403,json:async()=>reply};}});
        vm.runInContext(snippet,context);assert.equal(await context.ensureTunnelAccess(),expected);if(!expected){assert.equal(state.sessionId,null);assert.equal(state.pendingTunnelInviteReceipt,null);assert.equal(target,'/disk?disk_path=collection');}
    }
});
test('stopping automatic caching closes every automatic response, prevents new automatic reads, and preserves manual reads',()=>{
    const gate=createTaskAutoCache(),responses=[];const req=automatic=>({get:()=>automatic?'1':''});
    const response=()=>{const value={destroyed:false,once(){},destroy(){this.destroyed=true;},status(code){this.code=code;return this;},json(value){this.body=value;}};responses.push(value);return value;};
    const a=response(),b=response(),manual=response();assert.equal(gate.admit('sns:task',req(true),a,{}),true);gate.admit('sns:task',req(true),b,{});gate.admit('sns:task',req(false),manual,{});gate.stop('sns:task');assert.equal(a.destroyed,true);assert.equal(b.destroyed,true);assert.equal(manual.destroyed,false);
    const stopped=response();assert.equal(gate.admit('sns:task',req(true),stopped,{autoCacheEnabled:false}),false);assert.equal(stopped.code,409);assert.equal(gate.admit('sns:task',req(false),manual,{autoCacheEnabled:false}),true);
});
for(const kind of ['SnsDownload','YoutubePremium'])test(kind+' automatic cache aborts partial data when the shared task preference changes; manual caching remains available',async()=>{
    let policy=true,poll,aborted=false,committed=false,record;const window={navigator:{},createDrop2TunnelCacheStore:async()=>({beginWrite:async()=>({async writeChunk(){policy=false;await poll();},async abort(){aborted=true;},async commit(){committed=true;return {data:new Uint8Array([1,2])};}}),deleteReference:async()=>{}})};
    const context={window,AbortController,DOMException,Blob,setInterval:fn=>{poll=fn;return 1;},clearInterval(){},fetch:async(url,options)=>{
        if(!url.endsWith('/file'))return {ok:true,json:async()=>({autoCacheEnabled:policy})};
        return {ok:true,headers:{get:()=>''},body:{getReader:()=>{let sent=false;return {async read(){options.signal?.throwIfAborted();if(sent)return {done:true};sent=true;return {done:false,value:new Uint8Array([1,2])};}};}}};}};
    vm.runInNewContext(read(kind==='SnsDownload'?'client/sns-download-cache.js':'client/youtube-premium-cache.js'),context);
    const cache=window['create'+kind+'BrowserCache']();cache.getRecord=async()=>null;cache.writeRecord=async value=>{record=value;};const task={id:'task',downloadUrl:'/api/source/tasks/task/file',outputFileSize:2,completedAt:1};
    await assert.rejects(cache.store(task,{automatic:true}),error=>error.name==='AbortError');assert.equal(aborted,true);assert.equal(committed,false);assert.equal(record,undefined);
    // Manual mode has neither the automatic policy check nor its abort signal.
    poll=async()=>{};await cache.store(task);assert.equal(committed,true);assert.equal(record.size,2);
});
test('real server refuses ID-only entry, accepts current short codes, preserves enrolled access across rotation and restart', {timeout:45000}, async t=>{
    const {spawn}=require('node:child_process'),net=require('node:net'),{io}=require('socket.io-client');const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'dr2t-261015-server-')),probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
    const base='http://127.0.0.1:'+port,sockets=[];let child,logs='';
    const stop=async()=>{sockets.splice(0).forEach(s=>s.disconnect());if(child&&child.exitCode===null&&child.signalCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;}};t.after(async()=>{await stop();fs.rmSync(dataDir,{recursive:true,force:true});});
    const start=async()=>{child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),TUNNEL_DATA_DIR:dataDir,TELEGRAM_OIDC_MOCK_ENABLED:'1'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>{logs=(logs+b).slice(-3000);});child.stderr.on('data',b=>{logs=(logs+b).slice(-3000);});for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/api/admin/auth/status')).ok)return;}catch(_){}await new Promise(r=>setTimeout(r,30));}throw Error('fixture startup timeout: '+logs);};
    const connect=async()=>{const socket=io(base,{transports:['websocket'],reconnection:false});sockets.push(socket);await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});return socket;};
    const event=(socket,name)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Missing '+name+': '+logs)),4000);socket.once(name,value=>{clearTimeout(timer);resolve(value);});});
    const legacySession=crypto.randomUUID(),legacyDevice=crypto.randomUUID(),seed=await require('../server/infra-store').createInfraStore({dataDir});
    seed.reserveShortCode('OLD51',legacySession);seed.recordTunnelMember(legacySession,{deviceId:legacyDevice,deviceName:'Pre-upgrade fixture'});seed.save();seed.db.close();
    await start();const sessionId=crypto.randomUUID(),ownerId=crypto.randomUUID(),owner=await connect(),ownerGrant=event(owner,'tunnel-access-grant'),code=event(owner,'session-short-code');owner.emit('join-session',{sessionId,deviceId:ownerId,deviceName:'Owner fixture',createTunnel:true});const grant=(await ownerGrant).grant,shortCode=(await code).shortCode;
    const denied=await connect(),deniedEvent=event(denied,'tunnel-access-required');denied.emit('join-session',{sessionId,deviceId:crypto.randomUUID(),deviceName:'Unknown fixture'});await deniedEvent;
    const member=await connect(),memberId=crypto.randomUUID(),joined=event(member,'tunnel-access-grant');member.emit('join-session',{sessionId,deviceId:memberId,deviceName:'Member fixture',shortCode});const memberGrant=(await joined).grant;
    const spoof=await connect(),spoofed=event(spoof,'tunnel-access-required');spoof.emit('join-session',{sessionId,deviceId:ownerId,deviceName:'Spoof fixture',shortCode});await spoofed;
    const fileId=crypto.randomUUID();const magnetResponse=await fetch(base+'/api/magnets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,deviceId:ownerId,accessGrant:grant,fileId,asset:{id:fileId,name:'fixture.bin',size:12,type:'application/octet-stream',ownerDeviceId:ownerId}})});assert.equal(magnetResponse.status,200);const magnet=await magnetResponse.json();
    const publicReader=await connect(),publicJoined=event(publicReader,'session-history');publicReader.emit('join-session',{sessionId,deviceId:crypto.randomUUID(),deviceName:'Public fixture',magnetId:magnet.id});assert.deepEqual((await publicJoined).messages,[]);
    const manifest=event(publicReader,'file-asset-manifest');publicReader.emit('file-asset-request',{sessionId,assetId:fileId,mode:'manifest'});assert.equal((await manifest).asset.id,fileId);
    const blocked=event(publicReader,'permission-denied');publicReader.emit('request-history',{sessionId});await blocked;
    const otherFile=event(publicReader,'permission-denied');publicReader.emit('file-asset-request',{sessionId,assetId:crypto.randomUUID(),mode:'manifest'});await otherFile;
    const rotated=await new Promise(resolve=>owner.emit('session-short-code-update',{shortCode:'ZX9Q1'},resolve));assert.equal(rotated.ok,true);assert.equal((await fetch(base+'/api/short-codes/'+shortCode)).status,404);
    const preflight=await fetch(base+'/api/tunnel-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,deviceId:memberId,grant:memberGrant})});assert.equal((await preflight.json()).allowed,true);
    const noCode=await fetch(base+'/api/tunnel-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,deviceId:crypto.randomUUID()})});assert.equal(noCode.status,403);
    const legacyOwner=await connect(),legacyOwnerId=crypto.randomUUID(),legacyJoined=event(legacyOwner,'tunnel-access-grant');legacyOwner.emit('join-session',{sessionId:legacySession,deviceId:legacyOwnerId,deviceName:'Legacy owner fixture',shortCode:'OLD51'});await legacyJoined;
    const legacyRotation=await new Promise(resolve=>legacyOwner.emit('session-short-code-update',{shortCode:'NEW51'},resolve));assert.equal(legacyRotation.ok,true,legacyRotation.error);
    await stop();await start();
    const upgrade=await fetch(base+'/api/tunnel-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:legacySession,deviceId:legacyDevice,shortCode:'OLD51'})});assert.equal(upgrade.status,200);const upgraded=await upgrade.json();assert.equal(upgraded.allowed,true);
    assert.equal((await fetch(base+'/api/short-codes/OLD51')).status,404);
    const duplicate=await fetch(base+'/api/tunnel-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:legacySession,deviceId:legacyDevice,shortCode:'OLD51'})});assert.equal(duplicate.status,403);
    const legacyReconnect=await connect(),legacyRejoined=event(legacyReconnect,'tunnel-access-grant');legacyReconnect.emit('join-session',{sessionId:legacySession,deviceId:legacyDevice,deviceName:'Upgraded legacy fixture',accessGrant:upgraded.grant});await legacyRejoined;
    const offlineReader=await connect(),offlineJoined=event(offlineReader,'session-history');offlineReader.emit('join-session',{sessionId,deviceId:crypto.randomUUID(),deviceName:'Offline public fixture',magnetId:magnet.id});assert.deepEqual((await offlineJoined).messages,[]);
    const reconnect=await connect(),rejoined=event(reconnect,'tunnel-access-grant');reconnect.emit('join-session',{sessionId,deviceId:ownerId,deviceName:'Owner fixture',accessGrant:grant});await rejoined;
});
