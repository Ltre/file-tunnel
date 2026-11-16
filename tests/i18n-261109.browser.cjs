'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..');let server,browser,base;
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const section=(file,start,end)=>{const source=read(file);return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));};
before(async()=>{
 const app=express();app.use('/client',express.static(path.join(root,'client')));
 app.get('/web-zip-preview/:file',(_req,res)=>res.sendFile(path.join(root,'pages/web-zip-preview.html')));
 for(const [url,file] of [['/','pages/index.html'],['/device','pages/device.html']])app.get(url,(_req,res)=>res.type('html').send(read(file).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</head>','<script defer src="/client/i18n-catalog.js"></script><script defer src="/client/i18n.js"></script></head>')));
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true});
});

test('all supported languages localize typed connection state and the registered prompt default without rewriting a user default',async()=>{
 const page=await browser.newPage({locale:'en-US'});try{
  await page.goto(base);const results=await page.evaluate(()=>{
   const dialogs=[];window.prompt=(...args)=>{dialogs.push(args);return '用户输入 unchanged';};
   return TunnelI18n.languages.map(([language])=>{
    TunnelI18n.setLanguage(language);const result=TunnelI18n.prompt('网页名称','我的网页');TunnelI18n.prompt('另一个输入框','我的网页');
    const expected=language==='zh-Hans'?'我的网页':Drop2TunnelI18nCatalog['我的网页'][language];
    return{language,result,defaultValue:dialogs.at(-2)[1],expected,userDefault:dialogs.at(-1)[1],connected:TunnelI18n.t('在线 · P2P已连接')};
   });
  });
  for(const result of results){assert.equal(result.defaultValue,result.expected,result.language);assert.equal(result.userDefault,'我的网页');assert.equal(result.result,'用户输入 unchanged');if(!['zh-Hans','zh-Hant'].includes(result.language))assert.equal(result.connected.includes('已连接'),false,result.language);}
 }finally{await page.close();}
});

test('real file-details rendering translates labels and cache state while retaining original names, MIME and IDs',async()=>{
 const page=await browser.newPage({locale:'en-US'});try{
  await page.goto(base);await page.addScriptTag({content:`let activeFileDetailsMessageId,activeFileDetailsFileId;const getFromStore=async()=>({}),hasCompleteFileCache=()=>true,getFileDisplayName=file=>file.name,formatFileSize=size=>size+' B',formatDateTime=()=> '2026-11-09',isLikelyTouchDevice=()=>false,historyLog=()=>{};${section('app.js','function getFileExtension(','function formatDateTime(')}${section('app.js','async function showFileDetailsForInfo(','async function showFileDetails(')}`});
  await page.evaluate(()=>showFileDetailsForInfo({id:'file-设置',name:'设置',type:'text/plain',size:123,ownerDeviceId:'device-名称'},{senderName:'名称'}));
  await page.waitForFunction(()=>document.querySelectorAll('#fileDetailsList dt')[1].textContent==='Extension');
  const values=await page.locator('#fileDetailsList dd').allTextContents();assert.equal(values[0],'设置');assert.equal(values[2],'text/plain');assert.equal(values[5],'名称');assert.equal(values[6],'device-名称');assert.equal(values[7],'Cached; ready to download or preview');
  await page.evaluate(()=>TunnelI18n.setLanguage('ja'));assert.equal(await page.locator('#fileDetailsList dt').nth(2).textContent(),'MIME タイプ');assert.equal(await page.locator('#fileDetailsList dd').first().textContent(),'设置');
  await page.evaluate(async()=>{TunnelI18n.setLanguage('en');await showFileDetailsForInfo({id:'readme',name:'README',size:10});});
  await page.waitForFunction(()=>document.querySelectorAll('#fileDetailsList dd')[1].textContent==='No extension');
  assert.equal(await page.locator('#fileDetailsList dd').nth(1).getAttribute('data-i18n-raw'),null,'system fallback values remain translatable');
 }finally{await page.close();}
});

test('actual device rows retain user names while translating the self label and P2P state',async()=>{
 const page=await browser.newPage({locale:'en-US'});try{
  await page.goto(base);await page.addScriptTag({content:`const state={deviceId:'self',dataChannels:new Map([['peer',{}]])},mediaController=null,normalizeContactProfile=device=>device,getDeviceDisplayName=device=>device.name,getLocalDeviceRemark=()=>null,makeDeviceNameInteractive=()=>{};${section('app.js','function renderDeviceRow(','function renderContacts(')}`});
  await page.evaluate(()=>{for(const deviceId of ['self','peer']){const row=renderDeviceRow({deviceId,name:'设置'});row.id='row-'+deviceId;document.body.append(row);}});
  await page.waitForFunction(()=>document.querySelector('#row-self .name').textContent==='设置 (me)');
  for(const [language]of await page.evaluate(()=>TunnelI18n.languages)){
   await page.evaluate(language=>TunnelI18n.setLanguage(language),language);
   assert.equal(await page.locator('#row-peer .name').textContent(),'设置');
   assert.equal(await page.locator('#row-self .name').textContent(),await page.evaluate(()=> '设置 '+TunnelI18n.t('(我)')));
   assert.equal(await page.locator('#row-peer .status').textContent(),await page.evaluate(()=>TunnelI18n.t('在线 · P2P已连接')));
  }
 }finally{await page.close();}
});

test('the actual device profile translates status and action labels, preserving model, name, UA and dates',async()=>{
 const page=await browser.newPage({locale:'en-US'});try{
  await page.goto(base+'/device');await page.addScriptTag({content:`const fields=document.getElementById('profileFields'),qr=document.getElementById('profileQr');let currentDeviceProfile;const formatTime=value=>value,connectInviteSocket=()=>{},getCameraBridge=()=>{},startTunnelTransfer=()=>{};${section('pages/device.html','    function addField(','    function renderError(')}`});
  await page.evaluate(()=>renderProfile({deviceName:'设置',deviceId:'device-名称',deviceModel:'名称',userAgent:'浏览器',firstSeen:'首次访问',lastAccess:'最后访问',online:true,active:true}));
  await page.waitForFunction(()=>document.querySelector('#profileFields .label').textContent==='Online status');
  assert.equal(await page.locator('#deviceName').textContent(),'设置');const values=await page.locator('#profileFields .value').allTextContents();assert.deepEqual([values[2],values[5],values[6],values[7]],['名称','首次访问','最后访问','浏览器']);
  for(const [language]of await page.evaluate(()=>TunnelI18n.languages)){
   await page.evaluate(language=>TunnelI18n.setLanguage(language),language);
   for(const key of ['在线状态','活跃状态','设备型号','首次访问','最后访问','浏览器','共享我的摄像头','打开对方的摄像头'])assert.ok(await page.evaluate(key=>document.body.textContent.includes(TunnelI18n.t(key)),key),language+':'+key);
   assert.equal(await page.locator('#deviceName').textContent(),'设置');assert.equal(await page.locator('#profileFields .value').nth(2).textContent(),'名称');
   assert.equal(await page.title(),await page.evaluate(()=>TunnelI18n.t('设置 - 设备主页')));
  }
 }finally{await page.close();}
});

test('actual drive settings keep an unnamed partition blank, retain a saved name and translate all sort labels without changing values',async()=>{
 const page=await browser.newPage({locale:'en-US'});try{
  await page.goto(base);await page.addScriptTag({content:`let telegramDriveSpaces=[{id:'space',isDefault:true,name:''}],telegramDriveView='list',telegramDriveSort='name';const telegramDriveSpaceKey=space=>space.id,renderTelegramDriveItems=()=>{};window.DiskClient={getSpace:()=> 'space',raw:async route=>route==='/settings'?{settings:{folderUploadMaxBytes:1000000,maxDirectoryDepth:30}}:{credential:null}};const openTelegramDriveDialog=({body})=>{document.body.append(body);return new Promise(resolve=>window.closeSettings=resolve);};${section('client/disk-ui.js','async function manageTelegramDriveSpaces(','async function renderTelegramDrive(')}`});
  for(const [name,nameIsDefault,expected] of [['',false,''],['默认分区',true,''],['设置',false,'设置'],['默认分区',false,'默认分区']]){
   await page.evaluate(({name,nameIsDefault})=>{Object.assign(telegramDriveSpaces[0],{name,nameIsDefault});manageTelegramDriveSpaces();},{name,nameIsDefault});await page.waitForSelector('.disk-settings-dialog');
   assert.equal(await page.locator('.telegram-drive-space-create input[type="text"]').inputValue(),expected);
   for(const [language]of await page.evaluate(()=>TunnelI18n.languages)){
    await page.evaluate(language=>TunnelI18n.setLanguage(language),language);
    const options=page.locator('.disk-settings-dialog select').nth(1).locator('option');assert.deepEqual(await options.evaluateAll(nodes=>nodes.map(node=>node.value)),['name','type','size','updatedAt']);
    assert.deepEqual(await options.allTextContents(),await page.evaluate(()=>['名称','类型','大小','最后修改'].map(text=>TunnelI18n.t(text))));
    assert.equal(await page.locator('.telegram-drive-space-create input[type="text"]').inputValue(),expected);
   }
   await page.evaluate(()=>window.closeSettings());await page.waitForSelector('.disk-settings-dialog:empty',{state:'attached'});await page.locator('.disk-settings-dialog').evaluate(node=>node.remove());
  }
 }finally{await page.close();}
});

test('the actual remote picker and control panel translate every supported language while retaining device and file names',async()=>{
 const page=await browser.newPage({locale:'en-US'});try{
  await page.goto(base);await page.addScriptTag({content:`let remotePreviewSelection,remotePreviewControl=null,remotePreviewBubblePosition=null;const state={devices:new Map([['peer',{name:'设置'}]])},getDeviceDisplayName=device=>device.name,activeFilePreviewFileId='file',activeFilePreviewStoredFile={name:'名称',size:10},activeFilePreviewMediaType='text/plain',activeFilePreviewOwnerDeviceId='peer',activeFilePreviewMessageId='anchor';const isPreviewableFileType=()=>true,beginRemotePreviewCacheCheck=entry=>entry.status='available',showRemotePreviewDeviceModal=()=>{},historyLog=()=>{};${section('app.js','function remotePreviewStatusText(','function updateRemotePreviewEntry(')}${section('app.js','function openRemotePreviewDeviceModal(','async function handleRemotePreviewCacheCheck(')}${section('app.js','function renderRemotePreviewControlPanel(','function minimizeRemotePreviewControlPanel(')}`});
  await page.evaluate(()=>{openRemotePreviewDeviceModal();remotePreviewControl={targetName:'设置',fileName:'名称',statusText:'已进入全屏'};renderRemotePreviewControlPanel();});
  await page.waitForTimeout(60);assert.equal(await page.locator('.remote-preview-device-status').textContent(),'Complete cache confirmed; ready to open remotely');
  for(const [language]of await page.evaluate(()=>TunnelI18n.languages)){
   await page.evaluate(language=>TunnelI18n.setLanguage(language),language);
   assert.equal(await page.locator('.remote-preview-device-name').textContent(),'设置');assert.equal(await page.locator('#remotePreviewControlTitle').textContent(),'设置 · 名称');
   assert.equal(await page.locator('#remotePreviewFileName [data-i18n-raw]').textContent(),'名称');
   assert.equal(await page.locator('.remote-preview-device-row button').textContent(),await page.evaluate(()=>TunnelI18n.t('在此设备打开')));
   await page.evaluate(()=>{const entry=[...remotePreviewSelection.devices.values()][0];entry.status='opening';renderRemotePreviewDeviceList();});
   await page.waitForFunction(()=>document.querySelector('.remote-preview-device-status').textContent===TunnelI18n.t('正在目标设备打开并进入全屏…'),null,{timeout:2000});
   await page.evaluate(()=>{const entry=[...remotePreviewSelection.devices.values()][0];entry.status='available';renderRemotePreviewDeviceList();});
   await page.waitForFunction(()=>document.querySelector('.remote-preview-device-status').textContent===TunnelI18n.t('已确认完整缓存，可以远程打开'),null,{timeout:2000});
  }
  await page.evaluate(()=>TunnelI18n.setLanguage('en'));await page.waitForTimeout(80);
  assert.equal(await page.locator('#remotePreviewFileName').textContent(),'File: 名称','translation padding remains stable across observer passes and language changes');
 }finally{await page.close();}
});

test('the standalone ZIP preview translates waiting UI while preserving the authored page title',async()=>{
 const page=await browser.newPage({locale:'en-US'});try{
  await page.goto(base+'/web-zip-preview/fixture?name='+encodeURIComponent('设置'));
  await page.waitForFunction(()=>document.getElementById('statusText').textContent==='Receiving webpage ZIP from the source device…');
  for(const [language]of await page.evaluate(()=>TunnelI18n.languages)){
   await page.evaluate(language=>TunnelI18n.setLanguage(language),language);
   assert.equal(await page.title(),'设置');assert.equal(await page.locator('#title').textContent(),'设置');
   assert.equal(await page.locator('#reloadBtn').textContent(),await page.evaluate(()=>TunnelI18n.t('重新加载')));
  }
  const errors=await page.evaluate(()=>{TunnelI18n.setLanguage('en');return [TunnelI18n.t('打开失败：等待网页 ZIP 缓存超时，请回到隧道页面重试'),TunnelI18n.t('打开失败：设置')];});
  assert.equal(/\p{Script=Han}/u.test(errors[0]),false);assert.ok(errors[1].endsWith('设置'),'untyped error details are not mistaken for system labels');
 }finally{await page.close();}
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));});
for(const [locale,preference,expected,selected]of [['en-US',null,'en','system'],['pl-PL',null,'en','system'],['en-US','ja','ja','ja'],['en-US','system','en','system']])test('actual homepage markup localizes without script errors: '+locale+'/'+preference,async()=>{
 const context=await browser.newContext({locale});try{
  await context.addInitScript(preference=>{if(preference)localStorage.setItem('drop2tunnel.language',preference);},preference);
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(base);
  await page.waitForFunction(()=>window.TunnelI18n?.initialized);await page.waitForTimeout(60);
  assert.deepEqual(errors,[]);assert.equal(await page.locator('html').getAttribute('lang'),expected);
  assert.equal(await page.locator('#appLanguageSelect').inputValue(),selected);
  assert.equal(await page.locator('#appLanguageSelect option[value="system"]').textContent(),expected==='ja'?'システムの言語を使用':'Use system language');
  assert.equal(await page.locator('#remotePreviewDeviceTitle').textContent(),expected==='ja'?'操作対象の端末を選択':'Select controlled device');
 }finally{await context.close();}
});
