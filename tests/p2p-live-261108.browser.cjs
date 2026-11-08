'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const express=require('express'),{Server}=require('socket.io');
const {registerFileAssetHandlers}=require('../server/file-assets');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8'),appSource=read('app.js'),serverSource=read('server.js');
const part=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
test('real Chrome peers use the unchanged native ICE and file DataChannel path, then serve a second file without relay',{timeout:30000},async t=>{
    const app=express(),sessionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ids=['00000000-0000-4000-8000-000000000001','ffffffff-ffff-4fff-8fff-ffffffffffff'];
    const devices=new Map(),sessions=new Map([[sessionId,{devices,fileAssets:new Map()}]]),deviceSockets=new Map(),events=[];
    app.use('/client',express.static(path.join(root,'client')));
    app.get('/',(_q,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><p id="state">waiting</p><script src="/socket.io/socket.io.js"></script><script src="/client/i18n-catalog.js"></script><script src="/client/i18n.js"></script><script src="/client/file-assets.js"></script><script>
    const state={deviceId:new URLSearchParams(location.search).get('id'),peers:new Map(),dataChannels:new Map(),pendingIceCandidates:new Map(),devices:new Map(),socket:io()},peerSignalQueues=new Map(),editorAssetP2PUnavailablePeers=new Map(),EDITOR_ASSET_P2P_COOLDOWN=5000;
    const cache=new Map(),events=[],historyLog=(event,details)=>events.push({event,details});let fileAssetTransfer;
    function handleDataChannelMessage(){} function setupEditorAssetDataChannel(){}
    ${part(appSource,'// ==================== WebRTC P2P ====================','// ==================== Editor image assets ====================')}
    fileAssetTransfer=new FileAssetTransfer({getSocket:()=>state.socket,getSessionId:()=>${JSON.stringify(sessionId)},getPeer:id=>state.peers.get(id),connectPeer:connectToPeerForFileAsset,ensurePeerOffer:ensurePeerOfferForFileAsset,load:async id=>cache.get(id),store:async file=>cache.set(file.id,file),onProgress(){},log:(event,details)=>events.push({event,details}),onUnavailable(){},onReceived:file=>{document.getElementById('state').textContent=file.id;}});
    state.socket.on('connect',()=>state.socket.emit('join-session',{deviceId:state.deviceId}));state.socket.on('session-history',()=>window.ready=true);state.socket.on('signal',queuePeerSignal);
    for(const [event,method]of Object.entries({request:'handleRequest',available:'handleAvailable',manifest:'handleManifest',unavailable:'handleUnavailable','transfer-status':'handleTransferStatus','relay-start':'handleRelayStart','relay-chunk':'handleRelayChunk','relay-complete':'handleRelayComplete'}))state.socket.on('file-asset-'+event,(data,ack)=>Promise.resolve(fileAssetTransfer[method](data)).then(value=>ack?.(value||{ok:true}),error=>ack?.({ok:false,reason:error.message})));
    window.fixture={cache,events,state,async provide(id){const file={id,name:id+'.bin',size:100001,type:'application/octet-stream',data:Uint8Array.from({length:100001},(_,n)=>n%251).buffer};cache.set(id,file);await fileAssetTransfer.announce(file);},async request(id,from){state.devices.set(from,{});await fileAssetTransfer.request(id,from,{id,name:id+'.bin',size:100001,type:'application/octet-stream'});}};
    </script>`));
    const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));const base='http://127.0.0.1:'+http.address().port,io=new Server(http);t.after(()=>{io.close();http.closeAllConnections();});
    io.on('connection',socket=>{let deviceId='';socket.on('join-session',data=>{deviceId=data.deviceId;devices.set(deviceId,{joinedAt:Date.now()});deviceSockets.set(deviceId,socket);socket.join(sessionId);socket.emit('session-history',{messages:[]});});
        const context={socket,deviceSockets,emitSocketError:(event,message)=>socket.emit(event,{message}),isValidDeviceId:value=>ids.includes(value),setTimeout,Date,console};Object.defineProperty(context,'currentDevice',{get:()=>deviceId});
        const rates=part(serverSource,'    let messageCount = 0;',"    socket.on('register-profile-device'");
        vm.runInNewContext(rates+part(serverSource,"    socket.on('signal', (data) => {",'    // 消息转发'),context);
        socket.on('fixture-business-burst',(_data,ack)=>{for(let n=0;n<100;n++)context.checkMessageRate();ack({ok:true});});
        registerFileAssetHandlers(socket,{sessions,deviceSockets,getSessionId:()=>sessionId,getDeviceId:()=>deviceId,isValidId:value=>typeof value==='string'&&!!value,sanitize:String,historyLog:(event,details)=>events.push({event,details})});
    });
    const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const a=await browser.newPage(),b=await browser.newPage({locale:'en-US',isMobile:true,viewport:{width:390,height:844}});
    await Promise.all([a.goto(base+'/?id='+ids[0]),b.goto(base+'/?id='+ids[1])]);await Promise.all([a.waitForFunction(()=>window.ready),b.waitForFunction(()=>window.ready)]);
    await a.evaluate(()=>new Promise(resolve=>fixture.state.socket.emit('fixture-business-burst',{},resolve)));
    await b.evaluate(()=>new Promise(resolve=>fixture.state.socket.emit('fixture-business-burst',{},resolve)));
    for(const id of ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc']) {
        await a.evaluate(id=>fixture.provide(id),id);await b.evaluate(({id,from})=>fixture.request(id,from),{id,from:ids[0]});
        await b.waitForFunction(id=>fixture.cache.has(id),id,{timeout:12000});const correct=await b.evaluate(id=>[...new Uint8Array(fixture.cache.get(id).data)].every((value,n)=>value===n%251),id);assert.equal(correct,true);
    }
    assert.equal(events.filter(item=>item.event==='file-asset-relay-started').length,0,'business-message saturation must not suppress ICE/SDP and force both files through relay');
    await a.waitForFunction(()=>fixture.events.filter(item=>item.event==='file-asset-route-p2p-send-completed').length===2);
    const routes=await a.evaluate(()=>fixture.events.filter(item=>item.event==='file-asset-route-p2p-send-completed'));
    assert.equal(routes.length,2,JSON.stringify(await a.evaluate(()=>fixture.events.slice(-25))));assert.equal(events.filter(item=>item.event==='file-asset-relay-started').length,0);
    const selected=await a.evaluate(async()=>{const pc=[...fixture.state.peers.values()][0],stats=await pc.getStats();return [...stats.values()].filter(item=>item.type==='candidate-pair'&&item.state==='succeeded').map(item=>({state:item.state,nominated:item.nominated,bytesSent:item.bytesSent}));});assert.ok(selected.some(item=>item.bytesSent>0));
    // The reviewed baseline uses the identical P2P region: no broad rollback.
});
