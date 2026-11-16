'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const express=require('express'),{Server}=require('socket.io');
const {registerFileAssetHandlers}=require('../server/file-assets');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8'),appSource=read('app.js'),serverSource=read('server.js');
const part=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
async function runPeerScenario(t, bulk = false, abandoned = false) {
    const app=express(),sessionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ids=['00000000-0000-4000-8000-000000000001','ffffffff-ffff-4fff-8fff-ffffffffffff'];
    const devices=new Map(),sessions=new Map([[sessionId,{devices,fileAssets:new Map()}]]),deviceSockets=new Map(),events=[];
    app.use('/client',express.static(path.join(root,'client')));
    app.get('/',(_q,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><p id="state">waiting</p><script src="/socket.io/socket.io.js"></script><script src="/client/i18n-catalog.js"></script><script src="/client/i18n.js"></script><script src="/client/file-assets.js"></script><script>
    const state={deviceId:new URLSearchParams(location.search).get('id'),peers:new Map(),dataChannels:new Map(),pendingIceCandidates:new Map(),devices:new Map(),socket:io()},peerSignalQueues=new Map(),editorAssetP2PUnavailablePeers=new Map(),EDITOR_ASSET_P2P_COOLDOWN=5000;
    const cache=new Map(),events=[],historyLog=(event,details)=>events.push({event,details});let fileAssetTransfer;
    function handleDataChannelMessage(){} function setupEditorAssetDataChannel(){}
    ${part(appSource,'// ==================== WebRTC P2P ====================','// ==================== Editor image assets ====================')}
    fileAssetTransfer=new FileAssetTransfer({getSocket:()=>state.socket,getSessionId:()=>${JSON.stringify(sessionId)},getPeer:id=>state.peers.get(id),connectPeer:connectToPeerForFileAsset,ensurePeerOffer:ensurePeerOfferForFileAsset,load:async id=>cache.get(id),store:async file=>cache.set(file.id,file),onProgress(id,name,percent,transport){window.firstProgressAt??=performance.now();},log:(event,details)=>events.push({event,details}),onUnavailable(){},onReceived:file=>{document.getElementById('state').textContent=file.id;}});
    const getFromStore=async(_store,id)=>cache.get(id),shouldAutoRequestFileAssetCache=file=>!file?.data,summarizeHistoryMessage=message=>message.id,getCollectionFiles=message=>message.collection.files;
    ${part(appSource,'async function requestMissingFileAssetCache(','async function handleMessage(')}
    state.socket.on('connect',()=>state.socket.emit('join-session',{deviceId:state.deviceId}));state.socket.on('session-history',async data=>{window.historyReceivedAt=performance.now();window.ready=true;for(const message of data.messages||[]){state.devices.set(message.sender,{});await requestMissingFileAssetCache(message,'fixture-history');}});state.socket.on('signal',queuePeerSignal);
    for(const [event,method]of Object.entries({request:'handleRequest',available:'handleAvailable',manifest:'handleManifest',unavailable:'handleUnavailable','transfer-status':'handleTransferStatus','relay-start':'handleRelayStart','relay-chunk':'handleRelayChunk','relay-complete':'handleRelayComplete'}))state.socket.on('file-asset-'+event,(data,ack)=>Promise.resolve(fileAssetTransfer[method](data)).then(value=>ack?.(value||{ok:true}),error=>ack?.({ok:false,reason:error.message})));
    window.fixture={cache,events,state,transfer:fileAssetTransfer,async provide(id,size=100001){const file={id,name:id+'.bin',size,type:'application/octet-stream',data:Uint8Array.from({length:size},(_,n)=>n%251).buffer};cache.set(id,file);await fileAssetTransfer.announce(file);},async request(id,from){state.devices.set(from,{});await fileAssetTransfer.request(id,from,{id,name:id+'.bin',size:100001,type:'application/octet-stream'});}};
    </script>`));
    const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));const base='http://127.0.0.1:'+http.address().port,io=new Server(http);t.after(()=>{io.close();http.closeAllConnections();});
    io.on('connection',socket=>{let deviceId='';socket.on('join-session',data=>{deviceId=data.deviceId;devices.set(deviceId,{joinedAt:Date.now()});deviceSockets.set(deviceId,socket);socket.join(sessionId);socket.emit('session-history',{messages:bulk&&deviceId===ids[1]?[...sessions.get(sessionId).fileAssets.values()].map(record=>({id:'record-'+record.metadata.id,sender:ids[0],type:'file',fileInfo:{...record.metadata,isAsset:true,ownerDeviceId:ids[0]}})):[]});});
        const context={socket,deviceSockets,emitSocketError:(event,message)=>socket.emit(event,{message}),isValidDeviceId:value=>ids.includes(value),setTimeout,Date,console};Object.defineProperty(context,'currentDevice',{get:()=>deviceId});
        const rates=part(serverSource,'    let messageCount = 0;',"    socket.on('register-profile-device'");
        vm.runInNewContext(rates+part(serverSource,"    socket.on('signal', (data) => {",'    // 消息转发'),context);
        socket.on('fixture-business-burst',(_data,ack)=>{for(let n=0;n<100;n++)context.checkMessageRate();ack({ok:true});});
        registerFileAssetHandlers(socket,{sessions,deviceSockets,getSessionId:()=>sessionId,getDeviceId:()=>deviceId,isValidId:value=>typeof value==='string'&&!!value,sanitize:String,historyLog:(event,details)=>events.push({event,details})});
    });
    const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const a=await browser.newPage(),b=await browser.newPage({locale:'en-US',isMobile:true,viewport:{width:390,height:844}});
    if(bulk){
        await a.goto(base+'/?id='+ids[0]);await a.waitForFunction(()=>window.ready);
        await a.evaluate(async()=>{for(let n=0;n<45;n++)await fixture.provide(n.toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000',n===44?4400000:4900000);});
        for(let n=0;n<100&&sessions.get(sessionId).fileAssets.size<45;n++)await new Promise(resolve=>setTimeout(resolve,10));
        assert.equal(sessions.get(sessionId).fileAssets.size,45);await b.goto(base+'/?id='+ids[1]);
        await b.waitForFunction(()=>fixture.cache.size===45,null,{timeout:45000});
        const result=await b.evaluate(()=>{let bytes=0;for(const file of fixture.cache.values()){bytes+=file.size;const data=new Uint8Array(file.data);for(let n=0;n<data.length;n++)if(data[n]!==n%251)return{valid:false};}return{valid:true,bytes,firstProgressMs:window.firstProgressAt-window.historyReceivedAt};});
        assert.equal(result.valid,true);assert.equal(result.bytes,220000000);assert.ok(Number.isFinite(result.firstProgressMs));
        await a.waitForFunction(()=>fixture.events.filter(item=>item.event==='file-asset-route-p2p-send-completed').length===45);
        assert.equal(events.filter(item=>item.event==='file-asset-relay-started').length,0);t.diagnostic(JSON.stringify(result));return;
    }
    await Promise.all([a.goto(base+'/?id='+ids[0]),b.goto(base+'/?id='+ids[1])]);await Promise.all([a.waitForFunction(()=>window.ready),b.waitForFunction(()=>window.ready)]);
    await a.evaluate(()=>new Promise(resolve=>fixture.state.socket.emit('fixture-business-burst',{},resolve)));
    await b.evaluate(()=>new Promise(resolve=>fixture.state.socket.emit('fixture-business-burst',{},resolve)));
    const fileIds=['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
    if(abandoned){
        // Suppress the receiver's close notification to model a dead P2P path:
        // the real Socket.IO abandonment notice must release the active task.
        await b.evaluate(()=>{const original=fixture.transfer.setupChannel.bind(fixture.transfer);fixture.transfer.setupChannel=(...args)=>{original(...args);args[2].onclose=null;};});
        await a.evaluate(()=>{const original=fixture.transfer.sendViaDataChannel.bind(fixture.transfer);let once=true;fixture.transfer.sendViaDataChannel=async(channel,asset,range,peer,attemptId)=>{if(!once)return original(channel,asset,range,peer,attemptId);once=false;await fixture.transfer.sendWithBackpressure(channel,JSON.stringify({type:'file-asset-start',asset:fixture.transfer.metadata(asset),transfer:range,attemptId}));await new Promise(resolve=>fixture.releaseStall=resolve);throw Error('File asset channel backpressure stalled');};});
    }
    for(const [index,id] of fileIds.entries()) {
        await a.evaluate(id=>fixture.provide(id),id);await b.evaluate(({id,from})=>fixture.request(id,from),{id,from:ids[0]});
        if(abandoned&&index===0){await b.waitForFunction(id=>fixture.transfer.transfers.has(id),id);await a.evaluate(()=>fixture.releaseStall());}
        await b.waitForFunction(id=>fixture.cache.has(id),id,{timeout:12000});const correct=await b.evaluate(id=>[...new Uint8Array(fixture.cache.get(id).data)].every((value,n)=>value===n%251),id);assert.equal(correct,true);
        if(abandoned&&index===0){assert.equal(events.filter(item=>item.event==='file-asset-relay-started').length,1);const remaining=await a.evaluate(id=>Math.max(0,(fixture.transfer.p2pUnavailablePeers.get(id)||0)-Date.now()),ids[1]);await a.waitForTimeout(remaining+40);}
    }
    assert.equal(events.filter(item=>item.event==='file-asset-relay-started').length,abandoned?1:0,'only the explicitly abandoned attempt may use a relay retry');
    await a.waitForFunction(expected=>fixture.events.filter(item=>item.event==='file-asset-route-p2p-send-completed').length===expected,abandoned?1:2);
    const routes=await a.evaluate(()=>fixture.events.filter(item=>item.event==='file-asset-route-p2p-send-completed'));
    assert.equal(routes.length,abandoned?1:2,JSON.stringify(await a.evaluate(()=>fixture.events.slice(-25))));assert.equal(events.filter(item=>item.event==='file-asset-relay-started').length,abandoned?1:0);
    const selected=await a.evaluate(async()=>{const pc=[...fixture.state.peers.values()][0],stats=await pc.getStats();return [...stats.values()].filter(item=>item.type==='candidate-pair'&&item.state==='succeeded').map(item=>({state:item.state,nominated:item.nominated,bytesSent:item.bytesSent}));});assert.ok(selected.some(item=>item.bytesSent>0));
    // The reviewed baseline uses the identical P2P region: no broad rollback.
}
test('real Chrome peers use the unchanged native ICE and file DataChannel path, then serve a second file without relay',{timeout:30000},t=>runPeerScenario(t));
test('a fresh receiver restores 45 history files totaling 220 MB over native DataChannels without single-file retries',{timeout:70000},t=>runPeerScenario(t,true));
test('an explicitly stalled file uses a noncompeting real Socket.IO retry even without a close notice, then the next file returns to P2P',{timeout:30000},t=>runPeerScenario(t,false,true));
