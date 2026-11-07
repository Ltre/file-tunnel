'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),os=require('node:os'),path=require('node:path');
const {createTunnelAccess}=require('../server/tunnel-access');
const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
function receiver(values=new Map(),authorization){
    const events=[],storage={getItem:key=>values.get(key)||null},window={localStorage:storage};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../client/file-assets.js'),'utf8'),{window,Blob,ArrayBuffer,Uint8Array,DataView,setInterval:()=>0,clearInterval(){},setTimeout,clearTimeout,console:{log(){},warn(){},error(){}}});
    const transfer=new window.FileAssetTransfer({getSessionId:()=> 'target-B',getSocket:()=>({connected:true,emit:(event,data)=>events.push({event,data})}),load:async()=>null,log(){},...(authorization?{getTunnelAuthorization:authorization}:{})});
    return {transfer,events};
}
const metadata={id:'asset-1',name:'hello.txt',type:'text/plain',size:5,backupSourceSessionId:'source-A'};
function gate(t){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'source-access-261107-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const access=createTunnelAccess(dir),errors=[],current='target-B',device='identity-B';let middleware,forwarded=false;
    const start=server.indexOf('    socket.use(([event,data],next)=>{'),end=server.indexOf("    socket.on('session-short-code-update'",start);
    vm.runInNewContext(server.slice(start,end),{currentSession:current,currentDevice:device,trustedInternalClient:false,tunnelAccess:access,sessions:new Map(),socket:{data:{},use:fn=>middleware=fn},canReadForwardedFile:()=>forwarded,emitSocketError:(name,message)=>errors.push({name,message})});
    return {access,errors,setForwarded:value=>forwarded=value,accept:(data,event='file-asset-request',next=()=>{})=>{let accepted=false;middleware([event,{sessionId:current,assetId:metadata.id,sourceSessionId:'source-A',...data}],()=>{accepted=true;next();});return accepted;}};
}
test('requests and discovery use the saved source identity and its current grant, never the stale legacy grant',async()=>{
    const values=new Map([['tunnel-authorization:source-A',JSON.stringify({deviceId:'identity-A',grant:'new-source-grant'})],['tunnel-access:source-A','stale-legacy-grant']]);
    const {transfer,events}=receiver(values);await transfer.request(metadata.id,null,metadata);transfer.requestProviderDiscovery(metadata.id);
    assert.deepEqual(events.map(item=>item.event),['file-asset-request','file-asset-discovery']);
    for(const {data}of events){assert.equal(data.sourceDeviceId,'identity-A');assert.equal(data.sourceAccessGrant,'new-source-grant');assert.equal(data.sessionId,'target-B');assert.equal(data.sourceSessionId,'source-A');}
});
test('the app authorization dependency is read afresh for manifest fallback and range requests',async()=>{
    let grant='first';const {transfer,events}=receiver(new Map(),sid=>{assert.equal(sid,'source-A');return {deviceId:'identity-A',grant};});
    await transfer.request(metadata.id,null,metadata);grant='rotated';transfer.handleManifest({asset:metadata,providers:['provider']});
    transfer.multiSourceTransfers.set(metadata.id,{asset:metadata,providers:['provider'],ranges:new Map([['part',{rangeStart:0,rangeEnd:5,providerCursor:0,retryCount:0}]]),queuedRangeIds:['part'],activeRangeIds:new Set()});
    transfer.resetRangeTimer=()=>{};transfer.dispatchMultiSourceRanges(metadata.id);
    assert.equal(events.length,3);assert.equal(events[0].data.sourceAccessGrant,'first');
    for(const {data}of events.slice(1)){assert.equal(data.sourceAccessGrant,'rotated');assert.equal(data.sourceDeviceId,'identity-A');}
});
test('legacy grants still work and malformed modern authorization does not borrow a stale grant',async()=>{
    const values=new Map([['deviceId','legacy-device'],['tunnel-access:source-A','legacy-grant']]);
    const legacy=receiver(values);await legacy.transfer.request(metadata.id,null,metadata);
    assert.equal(legacy.events[0].data.sourceAccessGrant,'legacy-grant');assert.equal(legacy.events[0].data.sourceDeviceId,'legacy-device');
    values.set('tunnel-authorization:source-A','{broken');const broken=receiver(values);await broken.transfer.request(metadata.id,null,metadata);
    assert.equal(broken.events[0].data.sourceAccessGrant,'');
});
test('valid source credentials pass the real gate when the source and current tunnel identities differ',async t=>{
    const f=gate(t),grant=f.access.issue('source-A','identity-A'),{transfer,events}=receiver(new Map(),()=>({deviceId:'identity-A',grant}));
    await transfer.request(metadata.id,null,metadata);transfer.requestProviderDiscovery(metadata.id);
    for(const {event,data}of events)assert.equal(f.accept(data,event),true);
    assert.equal(f.errors.length,0);
});
test('the source identity alone, wrong signature, source, or credential identity cannot authorize a request',t=>{
    const f=gate(t),grant=f.access.issue('source-A','identity-A');
    for(const data of [{sourceDeviceId:'identity-A'},{sourceDeviceId:'identity-A',sourceAccessGrant:grant+'x'},{sourceDeviceId:'identity-B',sourceAccessGrant:grant},{sourceSessionId:'other-source',sourceDeviceId:'identity-A',sourceAccessGrant:grant}])assert.equal(f.accept(data),false);
    assert.equal(f.errors.length,4);assert.ok(f.errors.every(item=>item.message==='来源隧道尚未获得访问权'));
});
test('old clients and exact forwarded-file authorization retain their existing gate behavior',t=>{
    const f=gate(t);assert.equal(f.accept({sourceAccessGrant:f.access.issue('source-A','identity-B')}),true);
    f.setForwarded(true);assert.equal(f.accept({}),true);f.setForwarded(false);assert.equal(f.accept({}),false);
});
test('same-tunnel requests do not attach unrelated source credentials',async()=>{
    const {transfer,events}=receiver(new Map(),()=>assert.fail('no foreign authorization is needed'));
    await transfer.request(metadata.id,null,{...metadata,backupSourceSessionId:'target-B'});
    assert.equal(events[0].data.sourceSessionId,undefined);assert.equal(events[0].data.sourceAccessGrant,undefined);assert.equal(events[0].data.sourceDeviceId,undefined);
});
test('source credentials route real relay bytes to the current receiver without replacing its tunnel identity',async t=>{
    const f=gate(t),{registerFileAssetHandlers}=require('../server/file-assets'),events=[],received=[];
    const sessions=new Map([['source-A',{devices:new Map([['provider',{}]]),fileAssets:new Map()}],['target-B',{devices:new Map([['identity-B',{}]]),fileAssets:new Map()}]]),deviceSockets=new Map();
    function endpoint(sessionId,deviceId){
        const handlers=new Map(),socket={id:deviceId,data:{},on:(name,fn)=>handlers.set(name,fn),to:()=>({emit(){}}),timeout(){return this;},emit(name,data,ack){events.push({deviceId,name,data});if(name==='file-asset-relay-chunk')received.push(Buffer.from(data.chunk));ack?.(null,{ok:true});}};
        deviceSockets.set(deviceId,socket);registerFileAssetHandlers(socket,{sessions,deviceSockets,getSessionId:()=>sessionId,getDeviceId:()=>deviceId,sanitize:String,historyLog(){},isValidId:value=>typeof value==='string'&&value.length>0});
        return handlers;
    }
    const provider=endpoint('source-A','provider'),viewer=endpoint('target-B','identity-B');provider.get('file-asset-available')({sessionId:'source-A',asset:metadata});
    const grant=f.access.issue('source-A','identity-A'),client=receiver(new Map(),()=>({deviceId:'identity-A',grant}));await client.transfer.request(metadata.id,null,metadata);
    const request=client.events[0];assert.equal(f.accept(request.data,request.event,()=>viewer.get(request.event)(request.data)),true);
    assert.ok(events.some(item=>item.deviceId==='provider'&&item.name==='file-asset-request'&&item.data.from==='identity-B'));
    const call=(name,data)=>new Promise(resolve=>provider.get(name)({sessionId:'source-A',to:'identity-B',...data},resolve));
    assert.equal((await call('file-asset-relay-start',{asset:metadata})).ok,true);
    assert.equal((await call('file-asset-relay-chunk',{assetId:metadata.id,chunk:Buffer.from('hello')})).ok,true);
    assert.equal((await call('file-asset-relay-complete',{assetId:metadata.id})).ok,true);
    assert.equal(Buffer.concat(received).toString(),'hello');assert.equal(sessions.get('source-A').devices.has('identity-B'),false);assert.equal(f.errors.length,0);
});
