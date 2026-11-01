'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('app.js','utf8');
const section=(a,b)=>app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)));
function topFunction(name){const start=app.indexOf(name);assert.ok(start>=0,name);const rest=app.slice(start),next=/\n(?:async )?function /.exec(rest);return next?rest.slice(0,next.index):rest;}
const textNode=value=>({nodeType:3,nodeValue:String(value),parentElement:{closest:()=>null}});
function fixture(){
 let now=100000;const timers=new Map();let sequence=0;const events=[],visibility=[],logs=[],rows=[],summary={childNodes:[],get textContent(){return this.childNodes.map(node=>node.nodeValue).join('');},set textContent(value){this.childNodes=[textNode(value)];},replaceChildren(...nodes){this.childNodes=nodes;}};
 const style={value:'none',set display(value){this.value=value;visibility.push(value);},get display(){return this.value;}};
 const elements={transferProgress:{style},progressList:{children:rows},progressDrawerSummary:summary};
 const context={window:{},console:{info(){}},ArrayBuffer,Blob,Uint8Array,DataView,Date:class extends Date{static now(){return now;}},
  setInterval:()=>0,clearInterval(){},setTimeout:(run,ms)=>{const id=++sequence;timers.set(id,{run,ms});return id;},clearTimeout:id=>timers.delete(id),
  document:{getElementById:id=>elements[id],createTextNode:textNode},progressQueueSnapshot:{queueLength:0,activeDownloads:0,updatedAt:0,expireTimer:null},PROGRESS_QUEUE_SNAPSHOT_TTL:15000,
  progressDrawerCollapsed:true,setProgressDrawerCollapsed(){},isProgressItemActivelyMoving:row=>row.dataset.progressActivity==='moving'};
 vm.createContext(context);vm.runInContext(section('function showQueuedFileTransfer(','const PROGRESS_ACTIVITY_RANK')+topFunction('function updateProgressDrawerSummary('),context);
 vm.runInContext(fs.readFileSync('client/file-assets.js','utf8'),context);
 const socket={connected:true,emit:(event,data)=>events.push({event,data})},progress=[];
 const transfer=new context.window.FileAssetTransfer({getSocket:()=>socket,getSessionId:()=> 'isolated-tunnel',getPeer:()=>null,
  load:async()=>null,store:async()=>{},log:(event,data)=>logs.push({event,data}),onProgress:(...args)=>progress.push(args),onUnavailable(){},onDownloadIdle(){},
  onQueue:(...args)=>context.showQueuedFileTransfer(...args)});
 return {context,transfer,events,visibility,style,rows,summary,progress,logs,timers,
  retry(){const [id,timer]=[...timers].find(([,timer])=>timer.ms>=2500&&timer.ms<=15000)||[];assert.ok(timer,'discovery retry remains scheduled');timers.delete(id);now+=timer.ms;timer.run();}};
}
test('missing cache and repeated no-provider discovery never open an empty transfer drawer',async()=>{
 const f=fixture(),asset={id:'absent',name:'missing.bin',size:16,type:'application/octet-stream'};
 await f.transfer.request(asset.id,'offline-provider',asset);
 for(let i=0;i<5;i++){f.transfer.handleUnavailable({assetId:asset.id,reason:'no-online-provider'});f.retry();}
 assert.ok(f.events.some(event=>event.event==='file-asset-request'),'the transfer request and discovery strategy remain active');
 assert.ok(f.transfer.desiredAssets.has(asset.id),'hiding the drawer does not discard the restore request');
 assert.deepEqual(f.progress,[]);assert.equal(f.visibility.includes('block'),false,'waiting for a provider must never flash the drawer');assert.equal(f.summary.textContent,'');
});
test('intent counts do not inflate real transfer rows or qualified queue rows in the drawer',()=>{
 const f=fixture();f.rows.push({dataset:{progressDirection:'receive',progressActivity:'moving'}});
 f.context.showQueuedFileTransfer('missing',17,3);assert.match(f.summary.textContent,/^1 个任务/);assert.doesNotMatch(f.summary.textContent,/建链中|17 个等待/);
 f.rows.push({dataset:{progressDirection:'send',progressActivity:'queued'}});f.context.updateProgressDrawerSummary();
 assert.match(f.summary.textContent,/^2 个任务/);assert.match(f.summary.textContent,/1 个等待/);
});
test('a multi-source manifest alone is not transport progress; accepting a range start is',()=>{
 const f=fixture(),asset={id:'multi',name:'large.bin',size:12*1024*1024,type:'application/octet-stream'};
 f.transfer.beginMultiSourceDownload(asset,['provider']);assert.deepEqual(f.progress,[],'manifest providers do not prove an established data connection');
 const transfer=f.transfer.multiSourceTransfers.get(asset.id),range=[...transfer.ranges.values()][0];
 f.transfer.beginMultiSourceRange(asset.id,asset,'provider','p2p',{transferId:range.transferId,rangeStart:range.rangeStart,rangeEnd:range.rangeEnd},'range-attempt');
 assert.equal(f.progress.length,1);assert.equal(f.progress[0][2],0);assert.equal(f.progress[0][3],'receiving-multi-source');
});

test('all started ranges going offline hide only idle progress and retain retries until a new range starts',()=>{
 const f=fixture(),asset={id:'multi-retry',name:'large.bin',size:12*1024*1024,type:'application/octet-stream'},idle=[];
 f.transfer.deps.onDownloadIdle=(...args)=>idle.push(args);f.transfer.desiredAssets.set(asset.id,null);
 f.transfer.beginMultiSourceDownload(asset,['p1','p2']);
 const multi=f.transfer.multiSourceTransfers.get(asset.id),buffer=multi.buffer,started=[...multi.activeRangeIds].map(id=>multi.ranges.get(id));
 assert.equal(started.length,2);
 for(const range of started)f.transfer.beginMultiSourceRange(asset.id,asset,range.providerId,'p2p',range,'attempt');
 const drop=range=>f.transfer.handleUnavailable({assetId:asset.id,from:range.providerId,transferId:range.transferId,reason:'provider-socket-unavailable'});
 drop(started[0]);assert.equal(idle.length,0,'the other started range is still receiving');
 drop(started[1]);assert.equal(idle.length,1,'no accepted range remains; waiting for providers is not progress');
 assert.equal(multi.activeRangeIds.size,0);assert.ok(started.every(range=>range.retryScheduled&&!range.transport));
 assert.equal(f.transfer.multiSourceTransfers.get(asset.id),multi);assert.equal(multi.buffer,buffer);assert.ok(f.transfer.desiredAssets.has(asset.id));
 const progressCount=f.progress.length;
 for(const [id,timer] of [...f.timers])if(timer.ms===500){f.timers.delete(id);timer.run();}
 assert.equal(f.progress.length,progressCount,'rediscovery and dispatch alone must not reopen progress');
 const restarted=multi.ranges.get([...multi.activeRangeIds][0]);assert.ok(restarted);
 f.transfer.beginMultiSourceRange(asset.id,asset,restarted.providerId,'p2p',restarted,'new-attempt');
 assert.equal(f.progress.length,progressCount+1,'an accepted new start restores progress');
});

test('rendered transfer summary translates each dynamic count and survives language switches',()=>{
 const f=fixture();let language='en';Object.assign(f.context,{localStorage:{getItem:()=>language},navigator:{language:'en'},Node:{TEXT_NODE:3}});
 Object.assign(f.context.document,{readyState:'loading',addEventListener(){},documentElement:{}});
 vm.runInContext(fs.readFileSync('client/i18n-catalog.js','utf8'),f.context);vm.runInContext(fs.readFileSync('client/i18n.js','utf8'),f.context);
 f.rows.push({dataset:{progressDirection:'receive',progressActivity:'starting'}});f.context.updateProgressDrawerSummary();
 for(const [lang,expected] of [['en','1 tasks · 1 ready to transfer'],['ja','タスク 1 件 · 転送準備済み 1 件'],['zh-Hant','1 個工作 · 1 個準備傳輸']]){
  language=lang;for(const node of f.summary.childNodes)f.context.window.TunnelI18n.translate(node);assert.equal(f.summary.textContent,expected);
 }
});
test('a manual restore button failure keeps nonblocking feedback and diagnostics without alert',async()=>{
 const alerts=[],feedback=[],logs=[];let actions;
 const context={isFileFavorite:async()=>false,createFileActionButton:(label,_tip,run)=>({label,run}),setFilePreviewActions:value=>actions=value,
  restoreFileCacheByInfo:async()=>{throw Error('Asset not found');},alert:text=>alerts.push(text),showAppToast:text=>feedback.push(text),updateFileMessageAvailability:(id,reason)=>feedback.push({id,reason}),
  getFromStore:async()=>null,hasCompleteFileCache:()=>false,historyLog:(event,data)=>logs.push({event,data})};
 vm.createContext(context);vm.runInContext(topFunction('async function renderSingleFilePreviewActions('),context);
 await context.renderSingleFilePreviewActions({messageId:'record',fileInfo:{id:'file'},ownerDeviceId:'provider',hasLocalData:false});
 actions.find(action=>action.label.includes('还原')).run();await new Promise(setImmediate);
 assert.deepEqual(alerts,[]);assert.ok(feedback.length,'failure remains visible without a modal');assert.equal(logs.at(-1).data.error,'Asset not found');
});

test('an older manual restore failure cannot overwrite a newer successful local cache',async()=>{
 const feedback=[],logs=[];let rejectOlder,actions;
 const context={ArrayBuffer,Blob,Uint8Array,isFileFavorite:async()=>false,createFileActionButton:(label,_tip,run)=>({label,run}),setFilePreviewActions:value=>actions=value,
  restoreFileCacheByInfo:()=>new Promise((_resolve,reject)=>rejectOlder=reject),getFromStore:async()=>({id:'file',size:4,data:new Uint8Array([1,2,3,4]).buffer}),
  showAppToast:value=>feedback.push(value),updateFileMessageAvailability:(...args)=>feedback.push(args),historyLog:(event,data)=>logs.push({event,data})};
 vm.createContext(context);vm.runInContext(topFunction('function getBinaryDataSize(')+topFunction('function hasCompleteFileCache(')+topFunction('async function renderSingleFilePreviewActions('),context);
 await context.renderSingleFilePreviewActions({messageId:'record',fileInfo:{id:'file',size:4},ownerDeviceId:'provider',hasLocalData:false});
 actions.find(action=>action.label.includes('还原')).run();rejectOlder(Error('Asset not found'));await new Promise(setImmediate);
 assert.deepEqual(feedback,[],'a complete newer cache must not be labelled unavailable by a late failure');assert.equal(logs.at(-1).data.error,'Asset not found');
});
test('a manual restore without a usable remote source also reports inline without alert',async()=>{
 const alerts=[],feedback=[],context={alert:text=>alerts.push(text),fileAssetTransfer:null,updateFileMessageAvailability:(...args)=>feedback.push(args),showAppToast:text=>feedback.push(text)};
 vm.createContext(context);vm.runInContext(topFunction('async function restoreFileCacheByInfo('),context);await context.restoreFileCacheByInfo({id:'missing'});
 assert.deepEqual(alerts,[]);assert.ok(feedback.length);
});
