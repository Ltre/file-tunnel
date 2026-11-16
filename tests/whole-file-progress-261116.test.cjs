'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function harness(){const context={window:{},ArrayBuffer,Uint8Array,Blob,setInterval:()=>0,setTimeout,clearTimeout,console},progress=[],idle=[];vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../client/file-assets.js'),'utf8'),context);const transfer=new context.window.FileAssetTransfer({log(){},getSessionId:()=> 'fixture',getPeer:()=>null,load:async()=>null,onProgress:(...args)=>progress.push(args),onUploadIdle:(...args)=>idle.push(args)});return{transfer,progress,idle};}
test('a 2 MiB range of a 115 MB file never completes the whole-file sending row, including duplicate ranges and retries',()=>{
 const {transfer,progress,idle}=harness(),asset={id:'large',name:'large.msi',size:115384320},part={transferId:'part-1',rangeStart:2097152,rangeEnd:4194304},route='sending-multi-source:phone:part-1';
 transfer.reportUploadProgress(asset,'phone',part,'request-1',2097152,route);assert.equal(progress.at(-1)[2],1);
 transfer.reportUploadProgress(asset,'phone',part,'request-2',2097152,route);assert.equal(progress.at(-1)[2],1,'a repeated range cannot double-count bytes');
 transfer.endUploadProgress(asset,'phone',part,route,'range-ended');assert.deepEqual(idle,[],'a range ending cannot remove the whole-file row');
 const received=Math.ceil(asset.size*0.45);transfer.reportUploadProgress(asset,'phone',part,'request-2',2097152,route,{fileSize:asset.size,fileReceivedBytes:received});assert.equal(progress.at(-1)[2],45);
 transfer.reportUploadProgress(asset,'phone',{transferId:'part-3',rangeStart:6291456,rangeEnd:8388608},'request-3',0,'sending-multi-source:phone:part-3');assert.equal(progress.at(-1)[2],45,'the next range cannot reset the file progress');
 transfer.handleAvailable({asset,from:'another-device'});assert.equal(progress.some(row=>row[2]===100),false);
 transfer.handleAvailable({asset,from:'phone'});assert.equal(progress.at(-1)[2],100);
 const count=progress.length;transfer.reportUploadProgress(asset,'phone',part,'request-2',2097152,route,{fileSize:asset.size,fileReceivedBytes:received});assert.equal(progress.length,count,'late receipts cannot reopen a completed row');
});
test('range feedback includes bytes received from all providers and remains bounded between chunks',()=>{
 const {transfer}=harness(),messages=[],range={from:'pc1',rangeStart:40,rangeEnd:50,receivedSize:8,attemptId:'attempt',completed:false},other={receivedSize:7,completed:false},multi={asset:{size:100},completedBytes:40,ranges:new Map([['part',range],['other',other]])},channel={readyState:'open',_fileAssetAttemptId:'attempt',send:data=>messages.push(JSON.parse(data))};
 transfer.multiSourceTransfers.set('file',multi);transfer.reportIncomingProgress('pc1','file',channel,'part');assert.equal(messages[0].fileReceivedBytes,55);assert.equal(messages[0].fileSize,100);assert.equal(messages[0].fileComplete,false);
 range.receivedSize=9;transfer.reportIncomingProgress('pc1','file',channel,'part');assert.equal(messages.length,1,'intermediate feedback is throttled');
 range.receivedSize=10;transfer.reportIncomingProgress('pc1','file',channel,'part');assert.equal(messages.length,2,'the end of a range is reported without waiting');assert.equal(messages[1].fileComplete,false,'range completion is not file completion');
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
test('P2P sender keeps the receiver whole-file 45% after its own range acknowledgement, then finishes on the receiver cache announcement',async()=>{
 const {transfer,progress}=harness(),size=115384320,part={transferId:'part-1',rangeStart:0,rangeEnd:2*1024*1024},asset={id:'large',name:'large.msi',size,data:new Uint8Array(2*1024*1024).buffer};let acknowledge;
 transfer.waitForTransferAck=()=>new Promise(resolve=>acknowledge=resolve);
 const channel={readyState:'open',bufferedAmount:0,send(data){if(typeof data!=='string')this.bufferedAmount+=data.byteLength;},addEventListener(){},removeEventListener(){}};
 const sending=transfer.sendViaDataChannel(channel,asset,part,'phone','attempt');await new Promise(resolve=>setTimeout(resolve,25));
 await transfer.handleChannelMessage('phone',asset.id,JSON.stringify({type:'file-asset-progress',assetId:asset.id,transferId:part.transferId,attemptId:'attempt',receivedBytes:2*1024*1024,totalBytes:2*1024*1024,fileSize:size,fileReceivedBytes:Math.ceil(size*0.45)}),channel);
 assert.equal(progress.at(-1)[2],45);channel.bufferedAmount=0;acknowledge();await sending;assert.equal(progress.at(-1)[2],45);assert.equal(progress.some(row=>row[2]===100),false);
 transfer.handleAvailable({asset,from:'phone'});assert.equal(progress.at(-1)[2],100);
});
