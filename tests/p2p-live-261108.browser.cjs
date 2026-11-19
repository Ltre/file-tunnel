'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const express=require('express'),{Server}=require('socket.io');
const {registerFileAssetHandlers}=require('../server/file-assets');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8'),appSource=read('app.js'),serverSource=read('server.js');
const part=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
async function runPeerScenario(t, bulk = false, abandoned = false, reverse = false, multi = false, forced = false, relayProvider = true, largeRejoin = false, allRelay = false) {
    const app=express(),sessionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ids=['00000000-0000-4000-8000-000000000001','ffffffff-ffff-4fff-8fff-ffffffffffff',...(multi?['88888888-8888-4888-8888-888888888888']:[])];
    const devices=new Map(),sessions=new Map([[sessionId,{devices,fileAssets:new Map()}]]),deviceSockets=new Map(),events=[];
    app.use('/client',express.static(path.join(root,'client')));
    app.get('/',(_q,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><p id="state">waiting</p><script src="/socket.io/socket.io.js"></script><script src="/client/i18n-catalog.js"></script><script src="/client/i18n.js"></script><script src="/client/file-assets.js"></script><script>
    const state={deviceId:new URLSearchParams(location.search).get('id'),peers:new Map(),dataChannels:new Map(),pendingIceCandidates:new Map(),devices:new Map(),socket:io()},peerSignalQueues=new Map(),editorAssetP2PUnavailablePeers=new Map(),EDITOR_ASSET_P2P_COOLDOWN=5000;
    const cache=new Map(),cacheTimes=new Map(),events=[],progress=[],historyLog=(event,details)=>events.push({event,details});let fileAssetTransfer;
    function handleDataChannelMessage(){} function setupEditorAssetDataChannel(){}
    ${part(appSource,'// ==================== WebRTC P2P ====================','// ==================== Editor image assets ====================')}
    fileAssetTransfer=new FileAssetTransfer({getSocket:()=>state.socket,getSessionId:()=>${JSON.stringify(sessionId)},getPeer:id=>state.peers.get(id),connectPeer:connectToPeerForFileAsset,ensurePeerOffer:ensurePeerOfferForFileAsset,load:async id=>cache.get(id),store:async file=>{cache.set(file.id,file);cacheTimes.set(file.id,Date.now());},onProgress(id,name,percent,transport){window.firstProgressAt??=performance.now();progress.push({id,percent,transport,at:Date.now(),activeRoutes:[...(fileAssetTransfer?.multiSourceTransfers.get(id)?.ranges.values()||[])].filter(r=>r.active&&!r.completed&&!r.retryScheduled&&r.from&&r.transport).map(r=>r.transport)});},log:(event,details)=>events.push({event,details}),onUnavailable(){},onReceived:file=>{document.getElementById('state').textContent=file.id;}});
    const getFromStore=async(_store,id)=>cache.get(id),shouldAutoRequestFileAssetCache=file=>!file?.data,summarizeHistoryMessage=message=>message.id,getCollectionFiles=message=>message.collection.files;
    ${part(appSource,'async function requestMissingFileAssetCache(','async function handleMessage(')}
    state.socket.on('connect',()=>state.socket.emit('join-session',{deviceId:state.deviceId}));state.socket.on('session-history',async data=>{window.historyReceivedAt=performance.now();window.ready=true;for(const message of data.messages||[]){state.devices.set(message.sender,{});await requestMissingFileAssetCache(message,'fixture-history');}});state.socket.on('signal',queuePeerSignal);
    for(const [event,method]of Object.entries({request:'handleRequest',available:'handleAvailable',manifest:'handleManifest',unavailable:'handleUnavailable','transfer-status':'handleTransferStatus','relay-start':'handleRelayStart','relay-chunk':'handleRelayChunk','relay-complete':'handleRelayComplete'}))state.socket.on('file-asset-'+event,(data,ack)=>Promise.resolve(fileAssetTransfer[method](data)).then(value=>ack?.(value||{ok:true}),error=>ack?.({ok:false,reason:error.message})));
    window.fixture={cache,cacheTimes,events,progress,state,transfer:fileAssetTransfer,async provide(id,size=100001){const file={id,name:id+'.bin',size,type:'application/octet-stream',data:Uint8Array.from({length:size},(_,n)=>n%251).buffer};cache.set(id,file);await fileAssetTransfer.announce(file);},async request(id,from){state.devices.set(from,{});await fileAssetTransfer.request(id,from,{id,name:id+'.bin',size:100001,type:'application/octet-stream'});}};
    </script>`));
    const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));const base='http://127.0.0.1:'+http.address().port,io=new Server(http);t.after(()=>{io.close();http.closeAllConnections();});
    io.on('connection',socket=>{let deviceId='';socket.on('join-session',data=>{deviceId=data.deviceId;devices.set(deviceId,{joinedAt:Date.now()});deviceSockets.set(deviceId,socket);socket.join(sessionId);socket.emit('session-history',{messages:bulk&&deviceId===ids[1]?[...sessions.get(sessionId).fileAssets.values()].map(record=>({id:'record-'+record.metadata.id,sender:ids[0],type:'file',fileInfo:{...record.metadata,isAsset:true,ownerDeviceId:ids[0]}})):[]});});
        const context={socket,deviceSockets,emitSocketError:(event,message)=>socket.emit(event,{message}),isValidDeviceId:value=>ids.includes(value),setTimeout,Date,console};Object.defineProperty(context,'currentDevice',{get:()=>deviceId});
        const rates=part(serverSource,'    let messageCount = 0;',"    socket.on('register-profile-device'");
        vm.runInNewContext(rates+part(serverSource,"    socket.on('signal', (data) => {",'    // 消息转发'),context);
        socket.on('fixture-business-burst',(_data,ack)=>{for(let n=0;n<100;n++)context.checkMessageRate();ack({ok:true});});
        registerFileAssetHandlers(socket,{sessions,deviceSockets,getSessionId:()=>sessionId,getDeviceId:()=>deviceId,isValidId:value=>typeof value==='string'&&!!value,sanitize:String,historyLog:(event,details)=>events.push({event,details})});
    });
    const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const desktop=await browser.newPage(),mobile=await browser.newPage({locale:'en-US',isMobile:true,viewport:{width:390,height:844}}),a=reverse?mobile:desktop,b=reverse?desktop:mobile;
    if(multi){
        const c=await browser.newPage(),file='dddddddd-dddd-4ddd-8ddd-dddddddddddd',size=largeRejoin?115384320:12*1024*1024;
        await Promise.all([a.goto(base+'/?id='+ids[0]),b.goto(base+'/?id='+ids[1]),c.goto(base+'/?id='+ids[2])]);await Promise.all([a.waitForFunction(()=>window.ready),b.waitForFunction(()=>window.ready),c.waitForFunction(()=>window.ready)]);
        await a.evaluate(({file,size})=>fixture.provide(file,size),{file,size});await c.evaluate(async({file,size,to,relayProvider})=>{await fixture.provide(file,size);if(relayProvider)fixture.transfer.p2pUnavailablePeers.set(to,Date.now()+60000);},{file,size,to:ids[1],relayProvider});
        if(allRelay)await a.evaluate(to=>fixture.transfer.p2pUnavailablePeers.set(to,Date.now()+60000),ids[1]);
        for(let n=0;n<100&&(sessions.get(sessionId).fileAssets.get(file)?.providers.size||0)<2;n++)await new Promise(resolve=>setTimeout(resolve,10));
        if(largeRejoin){await b.reload();await b.waitForFunction(()=>window.ready);assert.equal(await b.evaluate(file=>fixture.cache.has(file),file),false);}
        await b.evaluate(({file,from,size,forced})=>fixture.transfer.request(file,from,{id:file,name:file+'.bin',size,type:'application/octet-stream'},forced?{force:true,requestId:'force-'+('restore-token-'.repeat(20))}:{}),{file,from:ids[0],size,forced});
        await b.waitForFunction(file=>fixture.cache.has(file),file,{timeout:largeRejoin?180000:30000});
        const result=await b.evaluate(file=>{const data=new Uint8Array(fixture.cache.get(file).data);for(let i=0;i<data.length;i++)if(data[i]!==i%251)return{valid:false};return{valid:true,bytes:data.length,multi:fixture.events.some(x=>x.event==='file-asset-multi-source-started'),routes:fixture.events.filter(x=>x.event==='file-asset-range-receiving').map(x=>x.details.transport)};},file);
        const cachedAt=await b.evaluate(file=>fixture.cacheTimes.get(file),file);
        for(const sender of [a,c])await sender.waitForFunction(file=>fixture.progress.some(row=>row.id===file&&row.percent===100),file,{timeout:5000});
        const sending=[...await a.evaluate(()=>fixture.progress),...await c.evaluate(()=>fixture.progress)].filter(row=>row.id===file);
        assert.equal(sending.filter(row=>row.percent===100&&row.at<cachedAt).length,0,'a range ACK cannot finish the file row before the whole receiver cache exists');
        const receiving=await b.evaluate(file=>fixture.progress.filter(row=>row.id===file&&row.transport.startsWith('receiving-multi-source')),file);
        for(const row of receiving){
            const routes=new Set(row.activeRoutes);if(!routes.size)continue;
            const expected=routes.has('socket-relay')?routes.has('p2p')?'receiving-multi-source-mixed':'receiving-multi-source-relay':'receiving-multi-source';
            assert.equal(row.transport,expected,'receiver progress describes the actual active ranges');
        }
        if(allRelay)assert.ok(receiving.length&&receiving.every(row=>row.transport==='receiving-multi-source-relay'),'Relay-only downloads never claim P2P');
        t.diagnostic(JSON.stringify({...result,prematureFileCompletions:0}));assert.equal(result.valid,true);assert.equal(result.bytes,size);assert.equal(result.routes.includes('p2p'),!allRelay);
        if(relayProvider){assert.ok(result.routes.includes('socket-relay'));assert.ok(events.some(x=>x.event==='file-asset-relay-started'));}
        else{assert.ok(result.routes.every(route=>route==='p2p'));assert.equal(events.filter(x=>x.event==='file-asset-relay-started').length,0);}
        return;
    }
    if(bulk){
        await a.goto(base+'/?id='+ids[0]);await a.waitForFunction(()=>window.ready);
        await a.evaluate(async()=>{for(let n=0;n<45;n++)await fixture.provide(n.toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000',n===44?4400000:4900000);});
        for(let n=0;n<100&&sessions.get(sessionId).fileAssets.size<45;n++)await new Promise(resolve=>setTimeout(resolve,10));
        assert.equal(sessions.get(sessionId).fileAssets.size,45);await b.goto(base+'/?id='+ids[1]);
        try { await b.waitForFunction(()=>fixture.cache.size===45,null,{timeout:60000}); }
        catch(error) {
            for(const [name,page]of [['sender',a],['receiver',b]])t.diagnostic(JSON.stringify({name,...await page.evaluate(()=>({cached:fixture.cache.size,active:[...fixture.transfer.transfers].map(([id,value])=>({id,bytes:value.receivedSize,size:value.asset?.size})),queued:fixture.transfer.downloadQueue.length,events:fixture.events.slice(-12)}))}));
            throw error;
        }
        const result=await b.evaluate(()=>{const elapsedMs=performance.now()-window.historyReceivedAt;let bytes=0;for(const file of fixture.cache.values()){bytes+=file.size;const data=new Uint8Array(file.data);for(let n=0;n<data.length;n++)if(data[n]!==n%251)return{valid:false};}return{valid:true,bytes,firstProgressMs:window.firstProgressAt-window.historyReceivedAt,elapsedMs};});
        assert.equal(result.valid,true);assert.equal(result.bytes,220000000);assert.ok(Number.isFinite(result.firstProgressMs));
        await a.waitForFunction(()=>fixture.events.filter(item=>item.event==='file-asset-route-p2p-send-completed').length===45);
        assert.equal(events.filter(item=>item.event==='file-asset-relay-started').length,0);t.diagnostic(JSON.stringify(result));return;
    }
    await Promise.all([a.goto(base+'/?id='+ids[0]),b.goto(base+'/?id='+ids[1])]);await Promise.all([a.waitForFunction(()=>window.ready),b.waitForFunction(()=>window.ready)]);
    await a.evaluate(()=>new Promise(resolve=>fixture.state.socket.emit('fixture-business-burst',{},resolve)));
    await b.evaluate(()=>new Promise(resolve=>fixture.state.socket.emit('fixture-business-burst',{},resolve)));
    const fileIds=['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
    if(abandoned){
        // An explicitly closed file channel uses the baseline Relay fallback.
        // A backpressure stall has a different policy and must not be relabeled.
        await a.evaluate(()=>{const original=fixture.transfer.sendViaDataChannel.bind(fixture.transfer);let once=true;fixture.transfer.sendViaDataChannel=async(channel,...args)=>{if(!once)return original(channel,...args);once=false;channel.close();throw Error('File asset channel closed');};});
    }
    for(const [index,id] of fileIds.entries()) {
        await a.evaluate(id=>fixture.provide(id),id);await b.evaluate(({id,from})=>fixture.request(id,from),{id,from:ids[0]});
        await b.waitForFunction(id=>fixture.cache.has(id),id,{timeout:12000});const correct=await b.evaluate(id=>[...new Uint8Array(fixture.cache.get(id).data)].every((value,n)=>value===n%251),id);assert.equal(correct,true);
        if(abandoned&&index===0){assert.equal(events.filter(item=>item.event==='file-asset-relay-started').length,1);const remaining=await a.evaluate(id=>Math.max(0,(fixture.transfer.p2pUnavailablePeers.get(id)||0)-Date.now()),ids[1]);await a.waitForTimeout(remaining+40);}
    }
    assert.equal(events.filter(item=>item.event==='file-asset-relay-started').length,abandoned?1:0,'only the explicitly closed attempt may use a relay retry');
    if(abandoned)assert.ok(await a.evaluate(()=>fixture.events.some(item=>item.event==='file-asset-route-p2p-degrade-to-relay'&&item.details.error==='File asset channel closed')));
    await a.waitForFunction(expected=>fixture.events.filter(item=>item.event==='file-asset-route-p2p-send-completed').length===expected,abandoned?1:2);
    await a.waitForFunction(()=>fixture.events.some(item=>item.event==='file-asset-route-connection-stats'&&item.details.selected&&item.details.local?.protocol&&item.details.remote?.protocol));
    const samples=await a.evaluate(()=>fixture.events.filter(item=>item.event==='file-asset-route-connection-stats'));
    assert.ok(samples.every(item=>item.details.scope==='peer-connection'));
    assert.ok(samples.some(item=>item.details.local?.candidateType==='host'&&item.details.remote?.candidateType==='host'));
    assert.ok(samples.some(item=>item.details.fileTransport===(abandoned?'socket.io-relay':'p2p')), 'sampling context reflects the real attempt; a short subsequent P2P file may fall within the sampling throttle');
    const routes=await a.evaluate(()=>fixture.events.filter(item=>item.event==='file-asset-route-p2p-send-completed'));
    assert.equal(routes.length,abandoned?1:2,JSON.stringify(await a.evaluate(()=>fixture.events.slice(-25))));assert.equal(events.filter(item=>item.event==='file-asset-relay-started').length,abandoned?1:0);
    // Chrome may briefly return a cached stats snapshot taken before file bytes
    // were sent. File contents/ACKs above already validate the completed path.
    await a.waitForFunction(async()=>{const pc=[...fixture.state.peers.values()][0],stats=await pc.getStats();return [...stats.values()].some(item=>item.type==='candidate-pair'&&item.state==='succeeded'&&item.bytesSent>0);},null,{timeout:3000});
    // The reviewed baseline uses the identical P2P region: no broad rollback.
}
test('real Chrome peers use the unchanged native ICE and file DataChannel path, then serve a second file without relay',{timeout:30000},t=>runPeerScenario(t));
test('a fresh receiver restores 45 history files totaling 220 MB over native DataChannels without single-file retries',{timeout:90000},t=>runPeerScenario(t,true));
test('an explicitly closed file channel falls back to real Socket.IO Relay, then the next file returns to P2P after cooldown',{timeout:30000},t=>runPeerScenario(t,false,true));
test('a mobile Chrome profile sends files back to the desktop over the same native P2P path without relay',{timeout:30000},t=>runPeerScenario(t,false,false,true));
test('a real three-peer range download combines P2P and Relay without restarting completed ranges',{timeout:40000},t=>runPeerScenario(t,false,false,false,true));
test('a forced three-peer restore retains long request-token compatibility over P2P and Relay',{timeout:40000},t=>runPeerScenario(t,false,false,false,true,true));
test('two real source peers deliver over P2P to one receiver without completing either file row at a range boundary',{timeout:40000},t=>runPeerScenario(t,false,false,false,true,false,false));

test('a rejoining receiver restores a 115384320-byte file from two native P2P sources and verifies every byte and final completion',{timeout:180000},t=>runPeerScenario(t,false,false,false,true,false,false,true));
test('a three-peer Relay-only restore keeps actual receiving path labels and verifies every byte',{timeout:40000},t=>runPeerScenario(t,false,false,false,true,false,true,false,true));
