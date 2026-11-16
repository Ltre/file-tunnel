'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {registerFileAssetHandlers}=require('../server/file-assets');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const section=(source,a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
function network(t,count=40,providerSession='A'){
    const events=[],sessions=new Map(),deviceSockets=new Map(),clients=[],timers=new Set();let disposed=false;
    sessions.set('A',{devices:new Map(providerSession==='A'?[['provider',{}]]:[]),fileAssets:new Map(),history:[]});
    sessions.set('B',{devices:new Map([['receiver',{}],...(providerSession==='B'?[['provider',{}]]:[])]),fileAssets:new Map(),history:[]});
    const assets=Array.from({length:count},(_,n)=>({id:n.toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000',name:n+'.bin',size:1024+n,type:'application/octet-stream',ownerDeviceId:'provider',isAsset:true,backupSourceSessionId:'A',forwardedToSessionId:'B'}));
    sessions.get('B').history.push({forwardedSourceSessionId:'A',message:{id:'collection',sender:'provider-B',type:'collection',collection:{files:assets}}});
    let gate;const context={sessions,infraStore:null,currentSession:'B',currentDevice:'receiver',trustedInternalClient:false,tunnelAccess:{verify:()=>false},canUseTunnelCapability:()=>true,socket:{data:{},use:fn=>gate=fn,to:room=>({emit:(event,data)=>{events.push({event:'destination-discovery',room,data});for(const peer of clients)if(peer.sessionId===room&&peer.deviceId!=='receiver')peer.serverSocket.emit(event,data);}})},emitSocketError:(event,message)=>events.push({event,message})};
    vm.runInNewContext(section(server,'function canReadForwardedFile(', 'function getSessionPermissionPayload(')+section(server,'    socket.use(([event,data],next)=>{',"    socket.on('session-short-code-update'"),context);
    function endpoint(sessionId,deviceId){
        const handlers=new Map(),cache=new Map(),localEvents=new Map();let transfer;
        const deliver=(event,data,ack)=>setImmediate(()=>{if(disposed)return;const handler=localEvents.get(event);if(handler)Promise.resolve(handler(data)).then(result=>ack?.(null,result||{ok:true}),error=>ack?.(null,{ok:false,reason:error.message}));else ack?.(null,{ok:true});});
        const socket={id:deviceId,connected:true,data:{deviceId},on:(name,fn)=>handlers.set(name,fn),emit:deliver,timeout:()=>({emit:deliver}),to:room=>({emit:(name,data)=>{for(const peer of clients)if(peer.sessionId===room&&peer.deviceId!==deviceId)peer.serverSocket.emit(name,data);}})};
        deviceSockets.set(deviceId,socket);registerFileAssetHandlers(socket,{sessions,deviceSockets,getSessionId:()=>sessionId,getDeviceId:()=>deviceId,sanitize:String,historyLog(){},isValidId:value=>typeof value==='string'&&!!value});
        const send=(event,data,ack)=>{events.push({event,data,deviceId});setImmediate(()=>{if(disposed)return;const run=()=>handlers.get(event)?.(data,result=>ack?.(null,result));if(deviceId==='receiver')gate([event,data],run);else run();});};
        const clientSocket={connected:true,emit:(event,data,ack)=>send(event,data,ack?(_error,result)=>ack(result):undefined),timeout:()=>({emit:send})};
        const window={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../client/file-assets.js'),'utf8'),{window,Blob,ArrayBuffer,Uint8Array,DataView,setInterval:()=>0,clearInterval(){},setTimeout:(fn,delay)=>{const timer=setTimeout(fn,delay);timers.add(timer);return timer;},clearTimeout,console:{log(){},warn(){},error(){}}});
        transfer=new window.FileAssetTransfer({getSessionId:()=>sessionId,getSocket:()=>clientSocket,getPeer:()=>null,connectPeer:async()=>{},load:async id=>cache.get(id),store:async value=>cache.set(value.id,value),log:(event,data)=>events.push({event,data,deviceId}),onProgress(){},onReceived(){},onUnavailable:(id,reason)=>events.push({event:'unavailable',id,reason})});
        for(const [event,method]of Object.entries({'request':'handleRequest','available':'handleAvailable','manifest':'handleManifest','unavailable':'handleUnavailable','transfer-status':'handleTransferStatus','relay-start':'handleRelayStart','relay-chunk':'handleRelayChunk','relay-complete':'handleRelayComplete'}))localEvents.set('file-asset-'+event,data=>transfer[method](data));
        localEvents.set('file-asset-discovery',async({assetId})=>{const file=cache.get(assetId);if(file)await transfer.announce(file);});
        const peer={sessionId,deviceId,cache,transfer,serverSocket:socket};clients.push(peer);return peer;
    }
    const provider=endpoint(providerSession,'provider'),receiver=endpoint('B','receiver');
    assets.forEach((asset,n)=>{const data=new Uint8Array(asset.size);data.fill(n%256);provider.cache.set(asset.id,{...asset,sessionId:'A',data:data.buffer});});
    t.after(()=>{disposed=true;for(const timer of timers)clearTimeout(timer);});
    return {assets,provider,receiver,events,sessions,context,async announce(){for(const asset of provider.cache.values())await provider.transfer.announce(asset);await new Promise(resolve=>setImmediate(resolve));}};
}
test('a forwarded collection restores every file through real client queues and server relay without single-file force retries',async t=>{
    const f=network(t);await f.announce();
    for(const asset of f.assets)await f.receiver.transfer.request(asset.id,'provider',asset);
    for(let n=0;n<200&&f.receiver.cache.size<f.assets.length;n++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(f.receiver.cache.size,f.assets.length,JSON.stringify(f.events.slice(-12)));
    for(const asset of f.assets)assert.deepEqual(new Uint8Array(f.receiver.cache.get(asset.id).data),new Uint8Array(f.provider.cache.get(asset.id).data));
});
test('late provider announcements retain the destination record source context needed by queued cross-tunnel requests',async t=>{
    const f=network(t,8),receiver=f.receiver.transfer;receiver.deps.getSocket=()=>({connected:false});
    for(const asset of f.assets)await receiver.request(asset.id,'provider',asset);
    receiver.handleAvailable({from:'provider',asset:{id:f.assets[7].id,name:'7.bin',size:f.assets[7].size,type:'application/octet-stream'}});
    assert.equal(receiver.sourceSessionId(f.assets[7].id),'A');
});
test('the real resource inventory and one-click batch preserve source metadata and restore all forwarded files',async t=>{
    const f=network(t),cache=f.receiver.cache;await f.announce();
    const context={state:{sessionId:'B',socket:{connected:true}},Map,Set,Promise,Error,window:{},document:{getElementById:()=>null},
        getCurrentSessionMessages:async()=>[{id:'collection',type:'collection',collection:{files:f.assets}}],getCurrentSessionFileInventory:async()=>[],getFromStore:async(_store,id)=>cache.get(id),getFavoriteMusicIds:()=>new Set(),
        getCollectionFiles:message=>message.collection.files,getEditorAssetEntries:()=>[],extractFileRefIds:()=>[],getResourceReferenceKey:JSON.stringify,hasCompleteFileInventoryCache:()=>false,
        saveToStore:async(_store,file)=>cache.set(file.id,file),hasCompleteFileCache:file=>Boolean(file?.data),fileAssetTransfer:f.receiver.transfer,
        hydrateEditorAssets:async()=>{},refreshFileMessage:async()=>{},showFileMessagePlaceholder(){},editorAssetRequests:new Map(),serverAssetRecoveries:{promises:new Map()},historyLog(){}};
    vm.runInNewContext(section(app,'async function getSessionResourceInventory(', 'async function readWebWorkshopResource(')+section(app,'const resourceCacheRestores =','function formatResourceCacheRestoreSummary('),context);
    const resources=await context.getSessionResourceInventory();assert.ok(resources.every(resource=>resource.backupSourceSessionId==='A'));
    const stats=await context.requestMissingResourceCaches();assert.equal(stats.requested,f.assets.length);
    for(let n=0;n<200&&f.assets.some(asset=>!cache.get(asset.id)?.data);n++)await new Promise(resolve=>setTimeout(resolve,10));
    for(const asset of f.assets)assert.deepEqual(new Uint8Array(cache.get(asset.id).data),new Uint8Array(f.provider.cache.get(asset.id).data));
});

test('automatic single-record and collection backfill carry the destination anchor through all queued requests',async t=>{
    const f=network(t);await f.announce();const context={fileAssetTransfer:f.receiver.transfer,getFromStore:async(_store,id)=>f.receiver.cache.get(id),shouldAutoRequestFileAssetCache:file=>!file?.data,getCollectionFiles:message=>message.collection.files,historyLog(){},summarizeHistoryMessage:message=>message.id};
    vm.runInNewContext(section(app,'async function requestMissingFileAssetCache(', 'async function handleMessage('),context);
    for(const asset of f.assets.slice(0,20))await context.requestMissingFileAssetCache({id:'record-'+asset.id,type:'file',fileInfo:asset},'fixture');
    await context.requestMissingCollectionAssetCaches({id:'collection',type:'collection',collection:{files:f.assets.slice(20)}},'fixture');
    for(let n=0;n<200&&f.receiver.cache.size<f.assets.length;n++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(f.receiver.cache.size,40);const requests=f.events.filter(event=>event.event==='file-asset-request'&&event.deviceId==='receiver');assert.equal(requests.length,40);
    assert.ok(requests.every(({data})=>data.recordMessageId===(f.assets.findIndex(asset=>asset.id===data.assetId)<20?'record-'+data.assetId:'collection')));
});

test('a forwarder now in B can supply every copied file still indexed locally under A, without returning to A or single-file force',async t=>{
    const f=network(t,20,'B');
    // cloneForwardFileInfo stores the newly copied bytes under A. On entering
    // B the session-indexed presence scan cannot announce those cached files.
    for(const asset of f.assets)await f.receiver.transfer.request(asset.id,'provider',{...asset,recordMessageId:'collection'});
    for(let n=0;n<200&&f.receiver.cache.size<f.assets.length;n++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(f.receiver.cache.size,20,'the authorized destination must discover its own online cache holder');
    for(const asset of f.assets)assert.deepEqual(new Uint8Array(f.receiver.cache.get(asset.id).data),new Uint8Array(f.provider.cache.get(asset.id).data));
    assert.equal(f.sessions.get('A').devices.size,0,'neither device joined the source');
    assert.equal(f.events.filter(event=>event.event==='destination-discovery').length,20,'duplicate retries do not flood destination discovery');
});

test('claimed provenance or a source grant alone cannot discover another destination cache',async t=>{
    const f=network(t,1,'B');f.sessions.get('B').history=[];
    await f.receiver.transfer.request(f.assets[0].id,'provider',{...f.assets[0],recordMessageId:'forged'});await new Promise(resolve=>setTimeout(resolve,25));
    assert.ok(f.events.some(event=>event.event==='permission-denied'));assert.equal(f.events.filter(event=>event.event==='destination-discovery').length,0);assert.equal(f.receiver.cache.size,0);
    f.context.tunnelAccess.verify=()=>true;f.receiver.transfer.cancel(f.assets[0].id);await f.receiver.transfer.request(f.assets[0].id,'provider',f.assets[0]);await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(f.events.filter(event=>event.event==='destination-discovery').length,0,'a source grant is not ownership of a destination copy');assert.equal(f.receiver.cache.size,0);
});
