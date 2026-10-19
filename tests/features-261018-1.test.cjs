'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm');
const express=require('express'),{createTunnelAccess}=require('../server/tunnel-access'),{createFixture}=require('./support/media-library-fixture.cjs');
const source=fs.readFileSync('app.js','utf8');
const slice=(text,start,end)=>text.slice(text.indexOf(start),text.indexOf(end,text.indexOf(start)));

test('scanning a signed tunnel URL performs one navigation without reloading the previous document',()=>{
    for(const current of ['http://localhost/?leave=1','http://localhost/#old-session']){
        const actions=[],location={href:current,origin:'http://localhost',pathname:'/',hash:new URL(current).hash,assign:url=>actions.push(['assign',url]),reload:()=>actions.push(['reload',current])};
        const context=vm.createContext({URL,location,window:{location},closeTunnelCodeScanner(){},document:{getElementById:()=>null},joinByShortCode(){}});
        vm.runInContext(slice(source,'function applyScannedTunnelCode(','async function openTunnelCodeScanner('),context);
        const scanned='http://localhost/?tunnel_join=signed-proof#new-session';assert.equal(context.applyScannedTunnelCode(scanned),true);
        assert.deepEqual(actions,[['assign',scanned]],'do not race navigation to the QR entry with a reload of the old page');
    }
});

test('an enrolled device with a lost grant can explicitly join with the current code without inheriting that device identity',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dr2t-rejoin-261018-'));
    t.after(()=>{const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('dr2t-rejoin-261018-'));fs.rmSync(target,{recursive:true,force:true});});
    const app=express();app.use(express.json());const tunnelAccess=createTunnelAccess(dir),sessionId=crypto.randomUUID(),deviceId=crypto.randomUUID();
    const grant=tunnelAccess.issue(sessionId,deviceId),code='NEW51',infraStore={getTunnel:id=>id===sessionId?{short_code:code}:null,findSessionIdByShortCode:value=>value===code?sessionId:null,findShortCodeForSession:()=>code};
    const context=vm.createContext({app,tunnelAccess,infraStore,sessions:new Map(),shortCodes:new Map(),crypto,isValidSessionId:id=>/^[\w-]{8,64}$/.test(id||''),isValidDeviceId:id=>/^[\w-]{8,64}$/.test(id||''),normalizeShortCode:value=>/^[A-Z0-9]{5}$/.test(value||'')?value:'',generateId:()=>crypto.randomUUID()});
    vm.runInContext(slice(fs.readFileSync('server.js','utf8'),"app.post('/api/tunnel-join-links'",'const io = new Server('),context);
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));const base='http://127.0.0.1:'+server.address().port;
    const post=body=>fetch(base+'/api/tunnel-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,deviceId,...body})});
    assert.equal((await post({})).status,403,'ID-only entry stays forbidden');assert.equal((await post({shortCode:'OLD51'})).status,403,'a retired code does not restore an enrolled identity');
    const response=await fetch(base+'/api/short-codes/'+code,{headers:{'X-Tunnel-Device':deviceId}}),result=await response.json();
    assert.equal(result.sessionId,sessionId);
    assert.equal((await post({grant})).status,200,'the original credential and identity remain valid');
    const direct=await post({shortCode:code,rejoin:true});assert.equal(direct.status,200);const recovered=await direct.json();assert.notEqual(recovered.deviceId,deviceId,'missing private proof must not restore the old owner/admin identity');assert.equal(tunnelAccess.verify(recovered.grant,sessionId,recovered.deviceId),true);
    const values=new Map([['deviceId',deviceId],['history-do-not-delete','retained']]),state={sessionId,deviceId};let entry=new URL('http://localhost/#'+sessionId),uiRefreshes=0;
    const client=vm.createContext({state,URL,navigator:{userAgent:'fixture'},window:{location:{get href(){return entry.href;}}},localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)},sessionStorage:{getItem:()=>null},fetch:(url,options)=>fetch(base+url,options),detectDeviceModel:()=>'',getFromStore:async()=>({shortCode:'OLD51'}),updateSessionIdentityUi(){uiRefreshes++;},history:{replaceState:(_a,_b,value)=>{entry=new URL(value,entry);}}});
    vm.runInContext(slice(source,'function savedTunnelGrant(','function updateSessionIdentityUi()'),client);
    await client.authorizeTunnelSelection(sessionId,code);const admitted=client.tunnelDeviceId(sessionId);assert.notEqual(admitted,deviceId);assert.equal(values.get('deviceId'),deviceId);assert.equal(values.get('history-do-not-delete'),'retained');assert.equal(uiRefreshes,1,'the displayed identity updates when QR admission assigns a fresh member identity');
    await client.initSession();assert.equal(state.deviceId,admitted);assert.equal(await client.ensureTunnelAccess(),true);assert.equal(client.tunnelDeviceId(sessionId),admitted,'a normal reload does not mint another identity');
    assert.equal(client.tunnelDeviceId('another-tunnel'),deviceId,'other tunnels retain the original device identity');
    const stored=client.savedTunnelGrant(sessionId);client.fetch=async()=>{throw Error('fixture-offline');};await client.authorizeTunnelSelection(sessionId,code);assert.equal(client.savedTunnelGrant(sessionId),stored,'authorized offline entry still opens owned local history');
    client.fetch=async()=>({status:503,ok:false});await client.authorizeTunnelSelection(sessionId,code);assert.equal(client.tunnelDeviceId(sessionId),admitted);
    const offline=crypto.randomUUID();tunnelAccess.preserveLegacy(sessionId,'OLD51',[offline]);
    assert.equal((await post({deviceId:offline,shortCode:'OLD51'})).status,200,'an offline legacy member still upgrades with its snapshotted code');
    assert.equal((await post({deviceId:offline,shortCode:'OLD51'})).status,403,'the one-time legacy proof cannot restore an enrolled identity');
    const lostDelivery=await post({deviceId:offline,shortCode:code,rejoin:true});assert.equal(lostDelivery.status,200);assert.notEqual((await lostDelivery.json()).deviceId,offline,'a lost first credential response can be recovered without clearing browser data');
});

test('new collections separate sessions and put Clips in clips and images in shots',async t=>{
    const f=createFixture();t.after(()=>f.close());const s=f.service;s.processing.probe=async()=>({format:{duration:'4',start_time:'0'},streams:[{codec_type:'video',duration:'4'}]});
    const resource=s.createImport({kind:'disk',...f.put('source')},{id:'alice'});await s.pump();
    const session=s.createSession(resource.id,'会话名称1'),clip=s.clip(session.id,{start:0,end:1});await s.pump();
    const savedClip=s.collect(clip.id);await s.pump();s.extract(session.id,{mode:'random',count:1});await s.pump();const image=s.list('result').find(value=>value.kind==='image'),savedImage=s.collect(image.id);await s.pump();
    const clipPath=s.get('collection',savedClip.id).file.path,imagePath=s.get('collection',savedImage.id).file.path;
    assert.equal(clipPath,'collection/会话名称1/clips');assert.equal(imagePath,'collection/会话名称1/shots');
    const another=s.createSession(resource.id,'会话名称1'),next=s.clip(another.id,{start:1,end:2});await s.pump();const savedNext=s.collect(next.id);await s.pump();
    assert.notEqual(s.get('collection',savedNext.id).file.path,clipPath,'same display name does not merge different sessions');
    assert.equal(s.collect(clip.id).id,savedClip.id,'repeat collection retains the existing file');
    s.db.patch('session',session.id,'alice',{name:'改名后的会话'});const more=s.clip(session.id,{start:2,end:3});await s.pump();f.failAfterWrite();const retry=s.collect(more.id);await s.pump();assert.equal(s.get('collection',retry.id).state,'failed');const writes=f.writes;s.collect(more.id);await s.pump();assert.equal(s.get('collection',retry.id).file.path,clipPath);assert.equal(f.writes,writes,'retry after a confirmed write does not create another file or folder');
    assert.equal(s.get('collection',savedClip.id).file.path,clipPath,'existing collections are not moved after a session rename');
});
