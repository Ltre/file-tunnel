'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const express=require('express'),{Server}=require('socket.io'),{registerFileAssetHandlers}=require('../server/file-assets');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'app.js'),'utf8'),serverSource=fs.readFileSync(path.join(root,'server.js'),'utf8');
const part=(value,start,end)=>value.slice(value.indexOf(start),value.indexOf(end,value.indexOf(start)));
function fn(name){const start=source.indexOf(name),rest=source.slice(start),next=/\n(?:async )?function /.exec(rest);assert.ok(start>=0,name);return next?rest.slice(0,next.index):rest;}

async function run(t,relay){
 const sessionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ids=['00000000-0000-4000-8000-000000000001','ffffffff-ffff-4fff-8fff-ffffffffffff'];
 const devices=new Map(),sessions=new Map([[sessionId,{devices,fileAssets:new Map()}]]),deviceSockets=new Map(),events=[];
 const app=express();app.use('/client',express.static(path.join(root,'client')));
 const progressHtml=fs.readFileSync(path.join(root,'pages/index.html'),'utf8').match(/<div class="transfer-progress"[\s\S]*?(?=\s*<!-- 大文件确认)/)[0];
 app.get('/',(_q,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/index.css">${progressHtml}
 <script src="/socket.io/socket.io.js"></script><script src="/client/file-assets.js"></script><script>
 const state={sessionId:${JSON.stringify(sessionId)},deviceId:new URLSearchParams(location.search).get('id'),peers:new Map(),dataChannels:new Map(),pendingIceCandidates:new Map(),devices:new Map(),socket:io()},peerSignalQueues=new Map(),editorAssetP2PUnavailablePeers=new Map(),EDITOR_ASSET_P2P_COOLDOWN=5000;
 const cache=new Map(),events=[],received=new Map(),availability=new Map(),firstProgressAt=new Map(),removalTimes=new Map(),historyLog=(event,details)=>events.push({event,details,at:performance.now()});let fileAssetTransfer,fileCacheStore=null,progressDrawerCollapsed=false;
 const activeFileProgress=new Set(),completedFileProgress=new Set(),progressHideTimers=new Map(),progressUiLastPaint=new Map(),progressUiPending=new Map(),fileTransferProgressStates=new Map();
 const progressQueueSnapshot={queueLength:0,activeDownloads:0,updatedAt:0,expireTimer:null},PROGRESS_QUEUE_SNAPSHOT_TTL=15000,PROGRESS_UI_MIN_INTERVAL=120,FORCE_RESTORE_STALL_MS=12000,FORCE_RESTORE_PROGRESS_THRESHOLD=30;
 const getFromStore=async(_store,id)=>cache.get(id),saveToStore=async(_store,file)=>cache.set(file.id,file),materializeExternalFileRecord=async x=>x,materializeCachedFileRecord=async x=>x;
 const tunnelAuthorization=()=>({deviceId:state.deviceId,grant:''}),serverAssetRecoveries={metadata:new Map()},maybeShowLanP2pGuide=()=>{},refreshOpenSnsMediaClientStates=()=>{};
 const clearFileMessageAvailability=id=>availability.delete(id),updateFileMessageAvailability=(id,reason)=>availability.set(id,reason),releaseStoredFileUrl=()=>{},clearServerAssetRecoveryStage=()=>{},refreshFileMessage=async()=>{},notifyMusicLibraryAssetAvailable=(asset,file)=>received.set(asset.id,{at:performance.now(),file}),confirmServerAssetCache=()=>{};
 function handleDataChannelMessage(){} function setupEditorAssetDataChannel(){}
 ${part(source,'// ==================== WebRTC P2P ====================','// ==================== Editor image assets ====================')}
 ${fn('async function waitForDataChannel(')}
 ${part(source,'function getFileProgressKey(','function getBinaryDataSize(')}
 ${fn('function getBinaryDataSize(')}
 ${fn('function hasCompleteFileCache(')}
 ${part(source,'function showQueuedFileTransfer(','// ==================== 模态框')}
 ${fn('function initFileAssetTransfer(')}
 initFileAssetTransfer();
 new MutationObserver(records=>{for(const record of records){for(const node of record.addedNodes)if(node.dataset?.fileId&&!firstProgressAt.has(node.dataset.fileId))firstProgressAt.set(node.dataset.fileId,performance.now());for(const node of record.removedNodes)if(node.dataset?.fileId)removalTimes.set(node.dataset.fileId,performance.now());}}).observe(document.getElementById('progressList'),{childList:true});
 state.socket.on('connect',()=>state.socket.emit('join-session',{deviceId:state.deviceId}));state.socket.on('fixture-ready',()=>window.ready=true);state.socket.on('signal',queuePeerSignal);
 for(const [event,method]of Object.entries({request:'handleRequest',available:'handleAvailable',manifest:'handleManifest',unavailable:'handleUnavailable','transfer-status':'handleTransferStatus','relay-start':'handleRelayStart','relay-chunk':'handleRelayChunk','relay-complete':'handleRelayComplete'}))state.socket.on('file-asset-'+event,(data,ack)=>Promise.resolve(fileAssetTransfer[method](data)).then(value=>ack?.(value||{ok:true}),error=>ack?.({ok:false,reason:error.message})));
 window.fixture={transfer:fileAssetTransfer,state,cache,events,received,availability,firstProgressAt,removalTimes,async provide(id,size){const file={id,name:'small-'+id+'.bin',size,type:'application/octet-stream',data:Uint8Array.from({length:size},(_,n)=>n%251).buffer};cache.set(id,file);await fileAssetTransfer.announce(file);},async request(id,from,size){state.devices.set(from,{});window.requestAt=performance.now();await fileAssetTransfer.request(id,from,{id,name:'small-'+id+'.bin',size,type:'application/octet-stream'});}};
 </script>`));
 const http=app.listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));const base='http://127.0.0.1:'+http.address().port,io=new Server(http);t.after(()=>{io.close();http.closeAllConnections();});
 io.on('connection',socket=>{let deviceId='';socket.on('join-session',data=>{deviceId=data.deviceId;devices.set(deviceId,{});deviceSockets.set(deviceId,socket);socket.join(sessionId);socket.emit('fixture-ready');});
  const context={socket,deviceSockets,emitSocketError:(event,message)=>socket.emit(event,{message}),isValidDeviceId:value=>ids.includes(value),setTimeout,Date,console};Object.defineProperty(context,'currentDevice',{get:()=>deviceId});
  vm.runInNewContext(part(serverSource,'    let messageCount = 0;',"    socket.on('register-profile-device'")+part(serverSource,"    socket.on('signal', (data) => {",'    // 消息转发'),context);
  registerFileAssetHandlers(socket,{sessions,deviceSockets,getSessionId:()=>sessionId,getDeviceId:()=>deviceId,isValidId:value=>typeof value==='string'&&!!value,sanitize:String,historyLog:(event,details)=>events.push({event,details})});
 });
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const sender=await browser.newPage(),receiver=await browser.newPage({isMobile:true,viewport:{width:390,height:844}}),errors=[];
 for(const page of [sender,receiver]){page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));}
 await Promise.all([sender.goto(base+'/?id='+ids[0]),receiver.goto(base+'/?id='+ids[1])]);assert.deepEqual(errors,[]);await Promise.all([sender.waitForFunction(()=>window.ready),receiver.waitForFunction(()=>window.ready)]);
 if(relay===true)await sender.evaluate(id=>fixture.transfer.p2pUnavailablePeers.set(id,Date.now()+60000),ids[1]);
 else if(relay==='closed')await sender.evaluate(()=>{fixture.transfer.sendViaDataChannel=async channel=>{channel.close();throw Error('File asset channel closed');};});
 const id=relay?'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb':'cccccccc-cccc-4ccc-8ccc-cccccccccccc',size=384*1024;
 await sender.evaluate(({id,size})=>fixture.provide(id,size),{id,size});await receiver.evaluate(({id,size,from})=>fixture.request(id,from,size),{id,size,from:ids[0]});
 await receiver.waitForFunction(id=>fixture.received.has(id),id,{timeout:15000});
 const result=await receiver.evaluate(async id=>{
  // Check after the complete production callback and a paint opportunity.
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const file=fixture.cache.get(id),data=new Uint8Array(file.data),row=document.querySelector('#progressList [data-file-id="'+id+'"]');
  return{valid:data.every((value,n)=>value===n%251),bytes:data.byteLength,partial:file.isPartial,cleared:file.cacheCleared,interrupted:file.transferInterrupted,percent:row?.dataset.progressValue,visible:!!row&&getComputedStyle(document.getElementById('transferProgress')).display!=='none'&&row.getBoundingClientRect().height>0,elapsed:fixture.received.get(id).at-window.requestAt,firstProgressMs:fixture.firstProgressAt.get(id)-window.requestAt};
 },id);
 assert.equal(result.valid,true);assert.equal(result.bytes,size);assert.equal(result.partial,false);assert.equal(result.cleared,false);assert.equal(result.interrupted,false);assert.equal(result.visible,true,'a fast complete file remains visible after the full onReceived callback');assert.equal(result.percent,'100');
 await receiver.waitForFunction(id=>!document.querySelector('#progressList [data-file-id="'+id+'"]'),id,{timeout:2000});
 const completionVisibleMs=await receiver.evaluate(id=>fixture.removalTimes.get(id)-fixture.received.get(id).at,id);assert.ok(completionVisibleMs>=650&&completionVisibleMs<1800,'the existing 800 ms completion timer remains effective: '+completionVisibleMs);
 assert.equal(events.filter(item=>item.event==='file-asset-relay-started').length,relay?1:0);assert.deepEqual(errors,[]);
 if(!relay)await sender.waitForFunction(()=>fixture.events.some(item=>item.event==='file-asset-route-p2p-send-completed'));
 await receiver.evaluate(()=>{fixture.transfer.deps.onProgress('unavailable','unavailable.bin',30,'receiving-relay');fixture.transfer.deps.onUnavailable('unavailable','no-online-provider');});
 assert.equal(await receiver.locator('#progressList [data-file-id="unavailable"]').count(),0,'unavailable transfers are still removed immediately');
 t.diagnostic(JSON.stringify({route:relay?'socket.io-relay':'p2p',precedingP2pAttempt:relay==='closed',bytes:result.bytes,completeCallbackAndFrameVisible:result.visible,requestToFirstProgressMs:result.firstProgressMs,requestToCacheCompleteMs:result.elapsed,completionVisibleMs}));
}
test('384 KB real Socket.IO Relay preserves its painted completion after production onReceived and then expires',{timeout:30000},t=>run(t,true));
test('384 KB native P2P preserves bytes and painted completion without Relay',{timeout:30000},t=>run(t,false));
test('an explicitly closed P2P channel falls back to a painted 384 KB Relay completion',{timeout:30000},t=>run(t,'closed'));
