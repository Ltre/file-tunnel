'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.argv[2]||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {listenHttp}=require('./support/listen-http.cjs');
const appSource=fs.readFileSync('app.js','utf8'),section=(a,b)=>appSource.slice(appSource.indexOf(a),appSource.indexOf(b,appSource.indexOf(a)));
function fn(name){const start=appSource.indexOf(name),rest=appSource.slice(start),next=/\n(?:async )?function /.exec(rest);assert.ok(start>=0);return next?rest.slice(0,next.index):rest;}
(async()=>{
 let browser,server;
 try{
  const app=require('express')();app.use('/client',require('express').static(path.resolve('client')));app.get('/missing-file',(_req,res)=>res.status(404).json({error:'Asset not found'}));
  const progressHtml=fs.readFileSync('pages/index.html','utf8').match(/<div class="transfer-progress"[\s\S]*?(?=\s*<!-- 大文件确认)/)[0];
  app.get('/',(_req,res)=>res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/client/index.css"><script src="/client/file-assets.js"></script></head><body>${progressHtml}<article class="message" data-file-id="missing"><span class="file-size"></span></article><div id="actions"></div><script>
  const state={sessionId:'isolated',deviceId:'receiver',peers:new Map(),socket:{connected:true,emit:(event,data)=>events.push({event,data})}},events=[],logs=[],cache=new Map();
  let fileAssetTransfer,fileCacheStore=null,progressDrawerCollapsed=false;const activeFileProgress=new Set(),completedFileProgress=new Set(),progressHideTimers=new Map(),progressUiLastPaint=new Map(),fileTransferProgressStates=new Map();
  const progressQueueSnapshot={queueLength:0,activeDownloads:0,updatedAt:0,expireTimer:null},PROGRESS_QUEUE_SNAPSHOT_TTL=15000,PROGRESS_UI_MIN_INTERVAL=120,FORCE_RESTORE_STALL_MS=12000,FORCE_RESTORE_PROGRESS_THRESHOLD=30;
  const historyLog=(event,data)=>logs.push({event,data}),getFromStore=async(_store,id)=>cache.get(id),saveToStore=async(_store,file)=>cache.set(file.id,file),materializeExternalFileRecord=async x=>x,materializeCachedFileRecord=async x=>x;
  const connectToPeerForFileAsset=async()=>{},ensurePeerOfferForFileAsset=async()=>{},waitForDataChannel=async()=>{},maybeShowLanP2pGuide=()=>{},refreshCollectionPreviewCardForFile=async()=>{},refreshActiveFilePreviewForFile=async()=>{};
  const isFileFavorite=async()=>false,createFileActionButton=(label,_tip,run)=>{const button=document.createElement('button');button.textContent=label;button.onclick=run;return button;},setFilePreviewActions=actions=>document.getElementById('actions').replaceChildren(...actions.filter(Boolean));
  const requestServerAssetWithPeerPreference=async()=>{const response=await fetch('/missing-file');throw Error((await response.json()).error);},formatFileSize=value=>value+' B';
  ${section('function getFileProgressKey(','function getBinaryDataSize(')}
  ${fn('function getBinaryDataSize(')}
  ${fn('function hasCompleteFileCache(')}
  ${section('function showQueuedFileTransfer(','// ==================== 模态框')}
  ${fn('function updateFileMessageAvailability(')}
  ${fn('function showAppToast(')}
  ${fn('async function restoreFileCacheByInfo(')}
  ${fn('async function renderSingleFilePreviewActions(')}
  ${fn('function initFileAssetTransfer(')}
  initFileAssetTransfer();fileAssetTransfer.deps.onReceived=async()=>{};
  window.visibility=[];new MutationObserver(records=>{for(const r of records)visibility.push({old:r.oldValue,current:document.getElementById('transferProgress').style.display});}).observe(document.getElementById('transferProgress'),{attributes:true,attributeFilter:['style'],attributeOldValue:true});
  window.fixture={transfer:fileAssetTransfer,state,events,cache,logs};
  renderSingleFilePreviewActions({messageId:'record',fileInfo:{id:'missing',name:'missing.bin',isServerAsset:true,serverAssetUrl:'/missing-file'},ownerDeviceId:'absent',hasLocalData:false});
  </script></body></html>`));
  server=await listenHttp(app);browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1000,height:800}}),alerts=[],errors=[];page.on('dialog',async dialog=>{alerts.push(dialog.message());await dialog.dismiss();});page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);
  await page.clock.install();await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByRole('button',{name:/还原文件/}).click();await page.waitForFunction(()=>fixture.logs.some(log=>log.event==='file-cache-restore-by-info-failed'));
  assert.deepEqual(alerts,[]);assert.match(await page.locator('.device-details-toast').innerText(),/暂未能获取文件/);assert.match(await page.locator('.file-size').innerText(),/暂时不可用/);
  await page.evaluate(async()=>{await fixture.transfer.request('offline','absent',{id:'offline',size:16,name:'offline.bin',type:'application/octet-stream'});fixture.transfer.handleUnavailable({assetId:'offline',reason:'no-online-provider'});});
  for(let i=0;i<4;i++){await page.clock.fastForward(15000);await page.evaluate(()=>fixture.transfer.handleUnavailable({assetId:'offline',reason:'no-online-provider'}));}
  assert.equal(await page.locator('#transferProgress').isVisible(),false);assert.ok(await page.evaluate(()=>visibility.every(change=>!change.old?.includes('display: block')&&change.current!=='block')),'no transient visible style, even across no-provider retries');
  await page.clock.resume();
  const retried=await page.evaluate(()=>{
   const receiver=fixture.transfer,asset={id:'multi-offline',name:'offline-ranges.bin',size:12*1024*1024,type:'application/octet-stream'};
   receiver.desiredAssets.set(asset.id,null);receiver.beginMultiSourceDownload(asset,['p1','p2']);
   const multi=receiver.multiSourceTransfers.get(asset.id),buffer=multi.buffer,ranges=[...multi.activeRangeIds].map(id=>multi.ranges.get(id));
   for(const range of ranges)receiver.beginMultiSourceRange(asset.id,asset,range.providerId,'p2p',range,'attempt');
   const visible=()=>getComputedStyle(document.getElementById('transferProgress')).display!=='none',before=visible();
   receiver.handleUnavailable({assetId:asset.id,from:ranges[0].providerId,transferId:ranges[0].transferId,reason:'provider-socket-unavailable'});const oneLeft=visible();
   receiver.handleUnavailable({assetId:asset.id,from:ranges[1].providerId,transferId:ranges[1].transferId,reason:'provider-socket-unavailable'});
   const allOffline=visible(),retained=receiver.multiSourceTransfers.get(asset.id)?.buffer===buffer&&receiver.desiredAssets.has(asset.id);
   receiver.cancel(asset.id);return{before,oneLeft,allOffline,retained};
  });
  assert.deepEqual(retried,{before:true,oneLeft:true,allOffline:false,retained:true});
  const result=await page.evaluate(async()=>{
   fixture.transfer.cancel('offline');const receiver=fixture.transfer,body=new Uint8Array(512*1024).fill(61),asset={id:'12345678-1234-4123-8123-123456789abc',name:'native-rtc.bin',size:body.length,type:'application/octet-stream',data:body.buffer};
   await receiver.request(asset.id,'provider',asset);const a=new RTCPeerConnection(),b=new RTCPeerConnection();let release;const gate=new Promise(resolve=>release=resolve);receiver.deps.store=async file=>{await gate;fixture.cache.set(file.id,file);};
   a.onicecandidate=event=>{if(event.candidate)b.addIceCandidate(event.candidate).catch(()=>{});};b.onicecandidate=event=>{if(event.candidate)a.addIceCandidate(event.candidate).catch(()=>{});};
   b.ondatachannel=event=>receiver.setupChannel('provider',asset.id,event.channel);const channel=a.createDataChannel('file-asset:'+asset.id);channel._fileAssetPeerConnection=a;
   const sender=new FileAssetTransfer({log(){},onProgress(){}}),send=sender.sendWithBackpressure.bind(sender);sender.sendWithBackpressure=async(...args)=>{await send(...args);if(args[1] instanceof ArrayBuffer)await new Promise(resolve=>setTimeout(resolve,150));};const opened=new Promise(resolve=>channel.onopen=resolve);
   try{await a.setLocalDescription(await a.createOffer());await b.setRemoteDescription(a.localDescription);await b.setLocalDescription(await b.createAnswer());await a.setRemoteDescription(b.localDescription);await opened;
    const attempt=sender.transferAttemptId(receiver.requestIds.get(asset.id),'p2p');
    const sending=sender.sendViaDataChannel(channel,asset,null,'receiver',attempt);
    await new Promise((resolve,reject)=>{const deadline=Date.now()+10000;const inspect=()=>{if(receiver.transfers.get(asset.id)?.receivedSize===asset.size)return resolve();if(Date.now()>deadline)return reject(Error('RTC receive timeout '+JSON.stringify({received:receiver.transfers.get(asset.id)?.receivedSize,logs:fixture.logs.slice(-8)})));setTimeout(inspect,10);};inspect();});
    const visible=getComputedStyle(document.getElementById('transferProgress')).display!=='none',text=document.getElementById('progressList').textContent;release();await sending;await new Promise(resolve=>setTimeout(resolve,900));
    return{visible,text,bytes:fixture.cache.get(asset.id)?.data?.byteLength,hidden:getComputedStyle(document.getElementById('transferProgress')).display==='none'};
   }finally{release();clearInterval(sender.requestWatchdogTimer);a.close();b.close();}
  });
  assert.equal(result.visible,true);assert.match(result.text,/99%/);assert.equal(result.bytes,512*1024);assert.equal(result.hidden,true);assert.deepEqual(errors,[]);assert.deepEqual(alerts,[]);
  await page.addScriptTag({url:'/client/i18n-catalog.js'});await page.addScriptTag({url:'/client/i18n.js'});
  await page.evaluate(()=>{TunnelI18n.setLanguage('en');showProgress('summary-check','summary.bin',0,'',{route:'receiving'});});
  await page.waitForFunction(()=>document.getElementById('progressDrawerSummary').textContent==='1 tasks · 1 ready to transfer');
  for(const [language,expected] of [['ja','タスク 1 件 · 転送準備済み 1 件'],['zh-Hant','1 個工作 · 1 個準備傳輸']]){
   await page.evaluate(value=>TunnelI18n.setLanguage(value),language);assert.equal(await page.locator('#progressDrawerSummary').innerText(),expected);
  }
  await page.evaluate(()=>hideProgress('summary-check'));
  console.log('PASS manual restore without alert, no-provider discovery, all-source disconnect cleanup, native RTC progress and completion, live summary language switching');
 }finally{await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
