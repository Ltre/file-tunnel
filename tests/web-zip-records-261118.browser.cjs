'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),acorn=require('acorn');
const {createWebZipSync}=require('../server/web-zip-sync'),{createWebZipCredentials}=require('../server/web-zip-credentials');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),server=fs.readFileSync(path.join(root,'server.js'),'utf8'),app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const section=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fn(source,name){const node=acorn.parse(source,{ecmaVersion:'latest',allowReturnOutsideFunction:true}).body.find(node=>node.type==='FunctionDeclaration'&&node.id.name===name);assert.ok(node,name);return source.slice(node.start,node.end);}
const clone=value=>JSON.parse(JSON.stringify(value));
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-records-261118-')),infra=await require('../server/infra-store').createInfraStore({dataDir:dir});
 t.after(()=>{infra.close();assert.ok(dir.startsWith(path.join(os.tmpdir(),'webzip-records-261118-')));fs.rmSync(dir,{recursive:true,force:true});});
 const live=()=>({devices:new Map(),history:[],historySize:0,fileAssets:new Map(),deletedMessageIds:[]}),sessions=new Map([['A',live()],['B',live()]]),updates=[];
 const context={Map,Set,Date,JSON,Buffer,Promise,Error,sessions,infraStore:infra,MAX_MESSAGE_SIZE:1048576,MAX_HISTORY_SIZE:24*1048576,MAX_HISTORY_MESSAGES:100,
  getHistoryMessageEntry:(session,id)=>session?.history.find(entry=>entry.message.id===id),createHistoryMessage:clone,
  enqueueInfraAudit:(task,_key,options)=>{setImmediate(()=>{try{task();options.onSuccess();}catch(error){options.onFinalFailure(error);}});return true;},
  persistHistoryAudit:(sessionId,_session,message,source)=>infra.recordHistoryMessage(sessionId,message,{source}),historyLog(){},summarizeHistoryMessage:clone,
  emitToReadableSessionDevices:(_session,_event,value)=>updates.push(clone(value)),scheduleSessionHistoryBroadcast(){},isFileAssetStillReferenced:()=>true};
 vm.runInNewContext(section(server,'function readWebZipRecord(','function canSyncWebZipSource(')+fn(server,'addToSessionHistory'),context);
 const page={id:'root',name:'AAA.html.zip',size:3,type:'application/zip',webZip:true,creatorDeviceId:'creator',ownerDeviceId:'creator',webZipEditors:[]};
 const original={id:'origin',type:'file',sender:'creator',timestamp:1,remark:'original',fileInfo:page};
 infra.recordHistoryMessage('A',original);sessions.get('A').history.push({message:original,size:JSON.stringify(original).length});
 const insert=(id,file)=>{const record={id,type:'file',sender:'creator',timestamp:Date.now(),remark:id,forwardedFrom:{sessionId:'A',messageId:'origin'},fileInfo:clone(file)};
  infra.recordHistoryMessage('B',record,{source:'cross-tunnel-forward'});return context.addToSessionHistory('B',sessions.get('B'),record,{source:'cross-tunnel-forward'});};
 insert('one',{...page,id:'copy-one'});insert('two',{...page,id:'copy-two'});
 const options={filename:path.join(dir,'jobs.json'),credentials:createWebZipCredentials({dataDir:dir}),readRecord:context.readWebZipRecord,listRecords:context.listWebZipRecords,
  writeRecord:context.writeWebZipRecord,canPublish:()=>true,hasContent:()=>true,canSync:()=>true,isForwardedCopy:(sessionId,id)=>infra.get('SELECT source FROM transfer_records WHERE session_id=? AND message_id=?',[sessionId,id])?.source==='cross-tunnel-forward'};
 let service=createWebZipSync(options);
 const publish=async(messageId,id,name)=>{const file=infra.getHistoryMessage('B',messageId).fileInfo;
  await service.publish({sessionId:'B',messageId,fileId:file.id,deviceId:'editor',editCredential:service.issueCredential({sessionId:'B',messageId,fileId:file.id,deviceId:'editor'}),fileInfo:{id,name,type:'application/zip',size:5}});};
 return{context,infra,sessions,updates,insert,publish,read:(s,id)=>infra.getHistoryMessage(s,id),get service(){return service;},restart(){service=createWebZipSync(options);},
  rehydrate(){const session=live();sessions.set('B',session);for(const entry of infra.listHistoryRecords('B',{limit:1000}))context.addToSessionHistory('B',session,entry.message);return session.history.map(entry=>entry.message);}};
}
const renderScript=`const state={sessionId:'B',deviceId:'editor'},messages=new Map(),fileObjectUrls=new Map(),webZipMessageUpdates=new Map(),snsMarkdownUpdates=new Map();
 let activeCollectionPreviewMessageId='',activeRichMessageId='',activeFilePreviewMode='',activeFilePreviewFileId='';
 const isHistoryMessageDeleted=()=>false,getFromStore=async(store,id)=>store==='messages'?messages.get(id):null,saveToStore=async(_store,message)=>messages.set(message.id,structuredClone(message));
 const getMessageElement=id=>document.querySelector('[data-message-id="'+id+'"]'),isChatNearBottom=()=>false,historyLog=()=>{},summarizeHistoryMessage=x=>x;
 const getExternalFileSourceState=()=>({}),isAudioFileLike=()=>false,hasCompleteFileCache=()=>false,escapeHtml=s=>String(s).replace(/[&<>"']/g,'_');
 const getFileIcon=()=>'',webZipNewTabBadge=()=>'',formatFileSize=String,getFileDisplayName=f=>f.name,formatTransferTimestamp=String,getCollectionFiles=m=>m.collection?.files||[],renderRemarkHtml=escapeHtml;
 const syncTransferRecordFavoriteBadge=()=>{},syncTransferRecordSnsBadge=()=>{},syncFileMessageExternalSourceBadge=()=>{},renderFileMessageActions=()=>{},attachFileRecordInteractions=()=>{},renderMessageRecordActions=()=>{};
 const insertMessageElementByTimestamp=(container,row)=>container.append(row),requestMissingFileAssetCache=async()=>{},requestMissingCollectionAssetCaches=async()=>{},enqueueFileCacheCleanup=()=>{},scheduleFileObjectUrlCleanup=()=>{};
 ${fn(app,'addMessageToChat')}
 ${fn(app,'applyHistoryMessageUpdate')}
 window.fixture={async seed(list){for(const message of list){await saveToStore('messages',message);await addMessageToChat(message,false,{autoRequestAsset:false});}},async update(list){for(const entry of list)if(entry.sessionId==='B')await applyHistoryMessageUpdate(entry.message,{remote:true});},rows(){return [...document.querySelectorAll('.message')].map(row=>({id:row.dataset.messageId,fileId:row.dataset.fileId,name:row.dataset.fileName}));}};`;
async function open(browser){const page=await browser.newPage();await page.setContent('<main id="chatMessages"></main>');await page.addScriptTag({content:renderScript});return page;}

test('production webpage updates keep every rendered forwarded record through alternating edits, a new forward and reload',{timeout:45000},async t=>{
 const f=await setup(t);await f.service.approve({sessionId:'B',messageId:'one',fileId:'copy-one',creatorDeviceId:'creator',deviceId:'editor'});f.updates.length=0;
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());let page=await open(browser);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.evaluate(list=>fixture.seed(list),f.sessions.get('B').history.map(entry=>entry.message));
 const check=async(name,count)=>{const rows=await page.evaluate(()=>fixture.rows());assert.equal(rows.length,count,'independent record rows disappeared: '+JSON.stringify(rows));assert.equal(new Set(rows.map(row=>row.id)).size,count);assert.ok(rows.every(row=>row.name===name),JSON.stringify(rows));};
 for(const [messageId,id,name,count]of [['one','edit-1','AAA-1.html.zip',2],['two','edit-2','AAA-2.html.zip',2],['three','edit-3','w webpage AAA-3.html.zip',3],['one','edit-4','AAA-4.html.zip',3]]){
  if(messageId==='three'){const inserted=f.insert('three',{...clone(f.read('A','origin').fileInfo),id:'copy-three'});assert.equal(inserted.stored,true);await page.evaluate(list=>fixture.seed(list),[f.read('B','three')]);}
  await f.publish(messageId,id,name);await page.evaluate(list=>fixture.update(list),f.updates.splice(0));await check(name,count);
  assert.equal(f.read('A','origin').fileInfo.name,name);for(const anchor of count===2?['one','two']:['one','two','three'])assert.equal(f.read('B',anchor).fileInfo.webZipPendingSync,undefined);
  // The real durable writer is read again through a cold live-history window,
  // then the production renderer receives that snapshot in a fresh document.
  f.restart();const rehydrated=f.rehydrate();assert.equal(rehydrated.length,count);await page.close();page=await open(browser);page.on('pageerror',error=>errors.push(error.message));await page.evaluate(list=>fixture.seed(list),rehydrated);await check(name,count);
 }
 assert.deepEqual(errors,[]);
});
test('server live-history rehydration keeps two distinct forwarded webpage anchors sharing the same content asset',async t=>{
 const f=await setup(t);await f.service.approve({sessionId:'B',messageId:'one',fileId:'copy-one',creatorDeviceId:'creator',deviceId:'editor'});await f.publish('one','shared','AAA-1.html.zip');
 assert.equal(f.read('B','one').fileInfo.id,f.read('B','two').fileInfo.id,'shared content remains shared');
 assert.deepEqual(new Set(f.rehydrate().map(message=>message.id)),new Set(['one','two']));
});
test('ordinary duplicate assets and duplicate message IDs retain the existing bounded-history and renderer de-duplication',async t=>{
 const f=await setup(t),session=f.sessions.get('B');
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await open(browser);
 for(const extra of [{},{fileInfo:{name:'local.html.zip',webZip:true,creatorDeviceId:'creator'}},{forwardedFrom:{sessionId:'A',messageId:'origin'}},{forwardedFrom:{sessionId:'A'},fileInfo:{name:'unanchored.html.zip',webZip:true,creatorDeviceId:'creator'}}]){
  session.history=[];session.historySize=0;
  const ordinary={id:'ordinary-1',type:'file',...extra,fileInfo:{id:'ordinary',name:'regular.zip',size:3,type:'application/zip',...extra.fileInfo}};
  assert.equal(f.context.addToSessionHistory('B',session,ordinary).stored,true);assert.equal(f.context.addToSessionHistory('B',session,{...ordinary,id:'ordinary-2'}).reason,'duplicate-file');assert.equal(f.context.addToSessionHistory('B',session,ordinary).reason,'duplicate');
  await page.evaluate(()=>document.getElementById('chatMessages').replaceChildren());await page.evaluate(list=>fixture.seed(list),[ordinary,{...ordinary,id:'ordinary-2'},ordinary]);assert.equal((await page.evaluate(()=>fixture.rows())).length,1);
 }
});
