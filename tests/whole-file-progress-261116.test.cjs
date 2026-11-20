'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function harness(){const context={window:{},ArrayBuffer,Uint8Array,Blob,setInterval:()=>0,setTimeout,clearTimeout,console},progress=[],idle=[];vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../client/file-assets.js'),'utf8'),context);const transfer=new context.window.FileAssetTransfer({log(){},getSessionId:()=> 'fixture',getPeer:()=>null,load:async()=>null,onProgress:(...args)=>progress.push(args),onUploadIdle:(...args)=>idle.push(args)});return{transfer,progress,idle};}
test('a 2 MiB range of a 115 MB file never completes the whole-file sending row, including duplicate ranges and retries',()=>{
 const {transfer,progress,idle}=harness(),asset={id:'large',name:'large.msi',size:115384320},part={transferId:'part-1',rangeStart:2097152,rangeEnd:4194304},route='sending-multi-source:phone:part-1';
 transfer.reportUploadProgress(asset,'phone',part,'request-1',2097152,route);assert.equal(progress.at(-1)[2],1);
 transfer.reportUploadProgress(asset,'phone',part,'request-2',2097152,route);assert.equal(progress.at(-1)[2],1,'a repeated range cannot double-count bytes');
 transfer.endUploadProgress(asset,'phone',part,route,'range-ended');assert.deepEqual(idle,[],'a range ending cannot remove the whole-file row');
 transfer.reportUploadProgress(asset,'phone',{transferId:'part-2',rangeStart:4194304,rangeEnd:6291456},'request-3',2097152,'sending-multi-source:phone:part-2');assert.equal(progress.at(-1)[2],3,'only ranges supplied by this device contribute to its upload row');
 transfer.reportUploadProgress(asset,'phone',{transferId:'part-3',rangeStart:6291456,rangeEnd:8388608},'request-4',0,'sending-multi-source:phone:part-3');assert.equal(progress.at(-1)[2],3,'the next range cannot reset the file progress');
 transfer.handleAvailable({asset,from:'another-device'});assert.equal(progress.some(row=>row[2]===100),false);
 transfer.handleAvailable({asset,from:'phone'});assert.equal(progress.at(-1)[2],100);
 const count=progress.length;transfer.reportUploadProgress(asset,'phone',part,'request-2',2097152,route);assert.equal(progress.length,count,'late queued progress cannot reopen a just-completed row');
});
test('local contributions remain isolated by receiver and do not use the withdrawn whole-file progress protocol',async()=>{
 const {transfer,progress}=harness(),asset={id:'file',name:'file',size:100},part={transferId:'part',rangeStart:40,rangeEnd:50};
 transfer.reportUploadProgress(asset,'phone-a',part,'attempt',8,'sending-multi-source:phone-a:part');assert.equal(progress.at(-1)[2],8);
 transfer.reportUploadProgress(asset,'phone-b',part,'attempt',3,'sending-multi-source:phone-b:part');assert.equal(progress.at(-1)[2],3);
 const count=progress.length,messages=[];
 await transfer.handleChannelMessage('phone-a','file',JSON.stringify({type:'file-asset-progress',assetId:'file',receivedBytes:10,totalBytes:10,fileSize:100,fileReceivedBytes:99,fileComplete:false}),{readyState:'open',send:data=>messages.push(data)});
 assert.equal(progress.length,count,'an old receiver percentage must not replace local contribution');assert.deepEqual(messages,[]);
 assert.equal(transfer.reportIncomingProgress,undefined,'no extra whole-file progress messages are produced');
});
test('a signaling reconnect retains live file progress and explicit cancellation clears only the matching file UI',()=>{
 const {transfer,progress,idle}=harness(),asset={id:'large',name:'large',size:100},part={transferId:'part',rangeStart:0,rangeEnd:10};
 transfer.deps.getSocket=()=>null;transfer.reportUploadProgress(asset,'phone',part,'attempt',10,'sending-multi-source:phone');const group=transfer.outgoingProgress.get(transfer.uploadProgressKey('large','phone'));
 transfer.resumePending();assert.equal(transfer.outgoingProgress.get(transfer.uploadProgressKey('large','phone')),group);
 transfer.cancel('large');assert.equal(transfer.outgoingProgress.size,0);assert.equal(idle.at(-1)[3],'upload-progress-cancelled');const count=progress.length;
 transfer.reportUploadProgress(asset,'phone',part,'attempt',10,'sending-multi-source:phone');assert.equal(progress.length,count,'late queued progress cannot reopen a cancelled file');
});
test('progress bookkeeping stays bounded and expires only UI state, keeping the transfer intent intact',()=>{
 const {transfer,idle}=harness(),part={transferId:'part',rangeStart:0,rangeEnd:10};
 for(let n=0;n<65;n++)transfer.reportUploadProgress({id:'file-'+n,name:'file',size:100},'phone',part,'attempt',5,'sending-multi-source:phone');
 assert.equal(transfer.outgoingProgress.size,64);assert.equal(idle.length,1);assert.equal(idle[0][3],'upload-progress-capacity');
 transfer.desiredAssets.set('file-64','provider');for(const group of transfer.outgoingProgress.values())group.updatedAt=Date.now()-90001;
 transfer.cleanupUploadProgress();assert.equal(transfer.outgoingProgress.size,0);assert.equal(transfer.desiredAssets.get('file-64'),'provider','UI expiry must not cancel or requeue the actual transfer');
});
test('a P2P range acknowledgement completes only its local contribution, and the receiver cache announcement completes the file row',async()=>{
 const {transfer,progress}=harness(),size=115384320,part={transferId:'part-1',rangeStart:0,rangeEnd:2*1024*1024},asset={id:'large',name:'large.msi',size,data:new Uint8Array(2*1024*1024).buffer};let acknowledge;
 transfer.waitForTransferAck=()=>new Promise(resolve=>acknowledge=resolve);
 const channel={readyState:'open',bufferedAmount:0,send(data){if(typeof data!=='string')this.bufferedAmount+=data.byteLength;},addEventListener(){},removeEventListener(){}};
 const sending=transfer.sendViaDataChannel(channel,asset,part,'phone','attempt');
 try{await new Promise(resolve=>setTimeout(resolve,25));assert.equal(progress.at(-1)[2],0,'queued chunks alone are not transmitted bytes');assert.equal(progress.some(row=>row[2]===100),false);
 channel.bufferedAmount=0;acknowledge();await sending;assert.equal(progress.at(-1)[2],1,'this sender supplied 2 MiB, not the bytes received from other providers');assert.equal(progress.some(row=>row[2]===100),false);
 }finally{channel.bufferedAmount=0;acknowledge?.();await sending;}
 transfer.handleAvailable({asset,from:'phone'});assert.equal(progress.at(-1)[2],100);
});

test('completing every locally supplied range still waits for confirmed complete receiver cache before displaying 100',()=>{
 const {transfer,progress}=harness(),asset={id:'small',name:'small',size:100};
 for(const [start,end]of [[0,40],[40,100]])transfer.reportUploadProgress(asset,'phone',{transferId:'part-'+start,rangeStart:start,rangeEnd:end},'attempt-'+start,end-start,'sending-multi-source:phone');
 assert.equal(progress.at(-1)[2],99);transfer.handleAvailable({asset,from:'phone'});assert.equal(progress.at(-1)[2],100);
});

test('small P2P file advances while its already-queued bytes drain, but waits for receiver ACK at 99',async()=>{
 const {transfer,progress}=harness(),size=1024*1024,asset={id:'image',name:'image.jpg',size,data:new Uint8Array(size).buffer};let ack;transfer.deps.getSocket=()=>null;
 transfer.waitForTransferAck=()=>new Promise(resolve=>ack=resolve);
 const channel={readyState:'open',bufferedAmount:0,send(data){if(typeof data!=='string')this.bufferedAmount+=data.byteLength;},addEventListener(){},removeEventListener(){}};
 const sending=transfer.sendViaDataChannel(channel,asset,null,'phone','image-attempt');
 try {
  await new Promise(r=>setTimeout(r,35));assert.equal(progress.at(-1)[2],0);
  channel.bufferedAmount=size/2;await new Promise(r=>setTimeout(r,140));assert.equal(progress.at(-1)[2],50);
  channel.bufferedAmount=0;await new Promise(r=>setTimeout(r,140));assert.equal(progress.at(-1)[2],99);
  assert.equal(progress.some(row=>row[2]===100),false);assert.equal(transfer.uploadDrainProgress.size,0);
  ack();await sending;assert.equal(progress.at(-1)[2],100);
 }finally{channel.bufferedAmount=0;ack?.();await sending;transfer.cancel(asset.id);}
});

test('cancelled or failed drain observations stop without changing transport state or reopening progress',async()=>{
 const {transfer,progress}=harness(),asset={id:'queued',name:'queued',size:100},channel={readyState:'open',bufferedAmount:100};transfer.deps.getSocket=()=>null;
 transfer.reportUploadProgress(asset,'phone',null,'attempt',0,'sending:phone',{channel,queuedBytes:100});
 transfer.endUploadProgress(asset,'phone',null,'sending:phone','p2p-attempt-ended');
 assert.equal(transfer.uploadDrainProgress.size,0);const count=progress.length;channel.bufferedAmount=10;
 await new Promise(r=>setTimeout(r,130));assert.equal(progress.length,count);
 channel.bufferedAmount=100;transfer.reportUploadProgress(asset,'phone',null,'attempt2',0,'sending:phone',{channel,queuedBytes:100});
 transfer.cancel(asset.id);assert.equal(transfer.uploadDrainProgress.size,0);
 assert.equal(channel.readyState,'open','display cleanup cannot close the real channel');
});
