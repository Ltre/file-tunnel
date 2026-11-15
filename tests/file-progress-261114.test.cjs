'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../client/file-assets.js'),'utf8');
function harness(){const context={window:{},setInterval:()=>0,setTimeout,clearTimeout,console};vm.runInNewContext(source,context);const transfer=new context.window.FileAssetTransfer({log:()=>{},getSessionId:()=> 'fixture',store:async()=>{},onProgress:()=>{},onReceived:async()=>{}});transfer.announce=async()=>{};transfer.releaseCompletedDownload=()=>{};return transfer;}
test('late completion from an obsolete provider is ignored without failing the current request',async()=>{
 const transfer=harness(),active={from:'new-provider',attemptId:'new-attempt'};transfer.transfers.set('file',active);
 assert.equal(await transfer.complete('file','old-provider','p2p','old-attempt'),false);assert.equal(transfer.transfers.get('file'),active);
 assert.equal(await transfer.complete('absent','old-provider','p2p','old-attempt'),false);
});
test('a replaced receiver cannot commit or clear the new attempt after its queued chunk writes finish',async()=>{
 const transfer=harness();let finish,commits=0;const old={from:'peer',attemptId:'old',asset:{id:'file',size:1},receivedSize:1,pendingChunks:new Promise(r=>finish=r),cacheWriterPromise:Promise.resolve({commit(){commits++;return{data:new Uint8Array(1).buffer};}})};
 transfer.transfers.set('file',old);const pending=transfer.complete('file','peer','p2p','old');const newer={from:'peer',attemptId:'new'};transfer.transfers.set('file',newer);finish();assert.equal(await pending,false);assert.equal(commits,0);assert.equal(transfer.transfers.get('file'),newer);
});
test('an ignored completion receives a negative acknowledgement instead of claiming success',async()=>{
 const transfer=harness(),messages=[];transfer.complete=async()=>false;transfer.routeLog=()=>{};const channel={readyState:'open',send:message=>messages.push(JSON.parse(message)),close(){this.readyState='closed';}};
 await transfer.handleChannelMessage('peer','file',JSON.stringify({type:'file-asset-complete',assetId:'file',attemptId:'old'}),channel);
 assert.equal(messages.length,1);assert.equal(messages[0].ok,false);assert.equal(messages[0].reason,'stale-transfer');
});
test('a late full-file chunk from another provider cannot enter the current receiver, including legacy channels',async()=>{
 const transfer=harness();let appended=0;transfer.queueChunk=()=>{appended++;};transfer.transfers.set('file',{from:'current'});
 await transfer.handleChannelMessage('old','file',new Uint8Array(1).buffer,{});assert.equal(appended,0);
 await transfer.handleChannelMessage('current','file',new Uint8Array(1).buffer,{});assert.equal(appended,1);
});
test('sender progress follows buffer drain and reports completion only after the existing receiver acknowledgement',async()=>{
 const progress=[],context={window:{},setInterval:()=>0,setTimeout,clearTimeout,console};vm.runInNewContext(source,context);
 const transfer=new context.window.FileAssetTransfer({onProgress:(_id,_name,value)=>progress.push(value),log:()=>{},getPeer:()=>null});
 transfer.metadata=a=>({id:a.id});transfer.dataSize=data=>data.byteLength;transfer.sliceData=(data,l,h)=>data.slice(l,h);
 let acknowledge;transfer.waitForTransferAck=()=>new Promise(resolve=>acknowledge=resolve);
 const channel={readyState:'open',bufferedAmount:0,send(data){if(typeof data!=='string')this.bufferedAmount+=data.byteLength;},addEventListener(){},removeEventListener(){}};
 const sending=transfer.sendViaDataChannel(channel,{id:'file',name:'file',data:new Uint8Array(2*1024*1024)});
 await new Promise(resolve=>setTimeout(resolve,25));assert.ok(Math.max(...progress)<99,'enqueuing the complete file must not claim near-completion');
 const draining=setInterval(()=>{channel.bufferedAmount=Math.max(0,channel.bufferedAmount-256*1024);},20);
 try{await new Promise(resolve=>setTimeout(resolve,210));assert.ok(progress.some(value=>value>0&&value<99),'progress must continue while waiting for buffered data to drain');assert.equal(progress.includes(100),false);acknowledge();await sending;assert.equal(progress.at(-1),100);assert.equal(channel._fileAssetProgress,undefined);for(let i=1;i<progress.length;i++)assert.ok(progress[i]>=progress[i-1]);}finally{clearInterval(draining);}
});
