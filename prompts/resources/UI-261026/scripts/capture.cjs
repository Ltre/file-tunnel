'use strict';
// Design-only renderer. Real UI modules + isolated sample data; writes stay under UI-261026.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const root = path.resolve(__dirname, '../../../..'), out = path.resolve(__dirname, '..');
const runtime = path.join(out, '_runtime'); fs.mkdirSync(runtime, { recursive: true });
process.env.TMP = runtime; process.env.TEMP = runtime;
fs.writeFileSync(path.join(runtime,'capture.pid'),String(process.pid));
const bundle = 'C:/Users/Dell/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const { chromium } = require(path.join(bundle, 'playwright'));
const sharp = require(path.join(bundle, 'sharp'));
function write(name, value) { const dest = path.resolve(out, name); if (!dest.startsWith(out + path.sep)) throw Error('OUTPUT_SCOPE'); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, value); }
const esc = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pageSource = fs.readFileSync(path.join(root, 'pages/index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const sources = ['pages/index.html','client/index.css','client/disk.css','client/disk-ui.js','client/web-workshop.js','client/web-workshop.css','client/streaming-console.js','client/streaming-console.css','client/streaming-player.js','app.js'];
write('source-baseline.json', JSON.stringify({ capturedAt: new Date().toISOString(), files: sources.map(file => ({file,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')})) }, null, 2));
const paper = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><defs><linearGradient id="sky" x2="0.8" y2="1"><stop stop-color="#0e2142"/><stop offset=".5" stop-color="#214b7a"/><stop offset="1" stop-color="#69c7bb"/></linearGradient><linearGradient id="s" y2="1"><stop stop-color="#f9b4a1"/><stop offset="1" stop-color="#e87380"/></linearGradient><filter id="b"><feGaussianBlur stdDeviation="30"/></filter></defs><path fill="url(#sky)" d="M0 0h1600v900H0z"/><ellipse cx="1120" cy="330" rx="180" ry="180" fill="#f5e5cb" opacity=".22" filter="url(#b)"/><circle cx="1110" cy="330" r="124" fill="url(#s)"/><path d="M0 650 500 180 980 700Z" fill="#1a3b61"/><path d="m500 180 95 330-95-45-90 37z" fill="#d5efec"/><path d="m690 900 465-470 445 360v110" fill="#16314d"/><path d="m1155 430 85 190-85-55-70 50z" fill="#b6dedb"/><path d="M0 685q350-80 700 15t900-10v210H0" fill="#366e80"/><path d="M0 770q500-120 1050 0t550 20v110H0" fill="#122f48"/><path d="M0 850q500-90 1000 0t600-5v55H0" fill="#0e263b"/><text x="92" y="125" font-family="Arial,sans-serif" font-size="22" letter-spacing="8" fill="#fff" opacity=".7">FIELD NOTES / 2026</text><text x="85" y="225" font-family="Arial,sans-serif" font-size="92" font-weight="700" fill="#fff">AFTER THE BLUE.</text><text x="94" y="274" font-family="Arial,sans-serif" font-size="25" letter-spacing="3" fill="#d1eeed">A QUIET MOMENT IN MOTION</text></svg>`;
write('assets/sample-landscape.svg', paper);
function embedCss(css, filename) { return css.replace(/url\((['"]?)([^)'"\s]+)\1\)/g, (all, _q, url) => { if (/^(data:|https?:|#)/.test(url)) return all; const clean=url.split('?')[0], file=clean.startsWith('/')?path.join(root,clean):path.resolve(path.dirname(filename),clean); if(!fs.existsSync(file)||!fs.statSync(file).isFile())return all; const mime=({'.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.jpg':'image/jpeg','.webp':'image/webp'})[path.extname(file)]||'application/octet-stream'; return 'url("data:'+mime+';base64,'+fs.readFileSync(file).toString('base64')+'")'; }); }
let originalCss='';
for (const match of pageSource.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)) { const file=path.join(root,match[1].split('?')[0]); originalCss+='\n/* '+match[1]+' */\n'+embedCss(fs.readFileSync(file,'utf8'),file); }
write('assets/source.css', originalCss);
const deviceRenderer=appSource.slice(appSource.indexOf('function renderDeviceRow('),appSource.indexOf('\nfunction renderContacts('));
write('scripts/device-source.js', deviceRenderer);
const scripts=['qrcode-1.0.0.min','folder-archive','web-workshop','disk-operation-order','disk-client','disk-error-messages','disk-file-editor','disk-folder-upload','disk-directory-picker','disk-mount-ui','disk-trash-ui','disk-import-picker','account-ui','disk-ui','vendor/web-markdown/marked-18.0.14.umd','vendor/web-markdown/purify-3.4.16.min','tunnel-markdown','streaming-player','streaming-console'];
const screenNames={home:'功能首页 · 三栏', 'home-menu':'首页 · 汉堡菜单',disk:'网盘 · 文件列表','disk-menu':'网盘 · 文件菜单','disk-dialog':'网盘 · 新建目录',workshop:'网页工坊 · 草稿箱','workshop-editor':'网页工坊 · 文件编辑','workshop-import':'网页工坊 · 导入菜单',stream:'串流控制台 · 发现','stream-editor':'串流控制台 · 节目单排序','stream-import':'串流控制台 · 跨渠道导入','stream-control':'串流控制台 · 全局操控','stream-watch':'串流控制台 · 对外播放',route:'隧道路由 · 入口'};
const mainScreens=['home','disk','workshop-editor','stream-control','route'];
const extraScreens=Object.keys(screenNames).filter(s=>!mainScreens.includes(s));
const mobileScreens=['home','home-devices','home-editor','home-menu','disk','disk-menu','workshop','workshop-editor','stream','stream-editor','stream-import','stream-control','stream-watch','route'];
const themes=['lumen','orbit'];

async function freeze(page, name) {
 console.log('FREEZE_START',name);
 const html=await page.evaluate(async()=>{
  const imageData=new Map(); for(const el of document.querySelectorAll('img')) { if(!el.src||!el.complete||!el.naturalWidth)continue;try{const c=document.createElement('canvas');c.width=el.naturalWidth;c.height=el.naturalHeight;c.getContext('2d').drawImage(el,0,0);imageData.set(el.src,c.toDataURL('image/png'));}catch{} }
  const clone=document.documentElement.cloneNode(true);
  const originals=[...document.querySelectorAll('input,textarea,select')], copies=[...clone.querySelectorAll('input,textarea,select')];
  originals.forEach((el,i)=>{const c=copies[i]; if(el.tagName==='TEXTAREA')c.textContent=el.value;else if(el.tagName==='SELECT')[...c.options].forEach((o,j)=>o.toggleAttribute('selected',el.options[j].selected));else {c.setAttribute('value',el.value);c.toggleAttribute('checked',el.checked);} });
  clone.querySelectorAll('script,link[rel=stylesheet],link[rel=preload],#tunnelStartupLoading,#fixtureStatus,#fixture-open-console').forEach(n=>n.remove());
  clone.querySelectorAll('img').forEach(el=>{const url=new URL(el.getAttribute('src')||'',location.href).href;if(imageData.has(url))el.src=imageData.get(url);el.removeAttribute('loading');});
  clone.querySelectorAll('video,audio').forEach(el=>{el.removeAttribute('src');el.removeAttribute('autoplay');});
  clone.querySelectorAll('input,textarea,select,button,a,[contenteditable]').forEach(el=>el.setAttribute('tabindex','-1'));
  clone.querySelectorAll('[contenteditable]').forEach(el=>el.setAttribute('contenteditable','false'));
  clone.querySelectorAll('*').forEach(el=>{for(const attr of [...el.attributes])if(attr.name.startsWith('on'))el.removeAttribute(attr.name);});
  clone.querySelector('head').insertAdjacentHTML('beforeend','<link rel="stylesheet" href="../assets/source.css"><link rel="stylesheet" href="../assets/skins.css"><script>const skin=new URLSearchParams(location.search).get("variant")||"lumen";if(skin==="source")delete document.documentElement.dataset.skin;else document.documentElement.dataset.skin=skin;<\/script>');
  clone.querySelector('body').insertAdjacentHTML('beforeend','<script>const v=new URLSearchParams(location.search).get("workspace");if(["devices","editor","chat"].includes(v)){document.getElementById("appShell").dataset.mobileView=v;document.querySelector(".main-layout").style.setProperty("--workspace-index",({devices:0,chat:1,editor:2})[v]);document.querySelectorAll(".mobile-workspace-button").forEach(b=>b.classList.toggle("active",b.dataset.mobileView===v));}<\/script>');
  clone.querySelector('body').insertAdjacentHTML('beforeend','<script src="../assets/snapshot-preview.js"><\/script>');
  clone.querySelector('body').removeAttribute('data-skin');
  return '<!doctype html>\n'+clone.outerHTML;
 });
 write('snapshots/'+name+'.html',html);
 console.log('FREEZE_DONE',name);
}

async function main(){
 const {createFixture}=require(path.join(root,'tests/support/streaming-console-fixture.cjs'));
 const f=await createFixture();
 if(!path.resolve(f.dataDir).startsWith(runtime+path.sep))throw Error('RUNTIME_SCOPE');
 const portrait=await sharp(Buffer.from(paper)).resize(1280,720).png().toBuffer();write('assets/sample-landscape.png',portrait);
 const owner={deviceId:'design-device',userId:'alice',logins:[{id:'alice',hash:'design-seed',expiresAt:Date.now()+86400000}]};
 f.streaming.service.register('design-device','design-preview-key'.repeat(4),'MacBook Pro');
 const fixtureUser=f.auth.user.bind(f.auth);f.auth.user=id=>{const u=fixtureUser(id);return u?{...u,name:id==='alice'?'林同学':'陈同学'}:null;};
 f.repository.replace('users',[{id:'alice',username:'lin',name:'林同学'},{id:'bob',username:'chen',name:'陈同学'}],user=>user.id);
 const metadata = await f.api.objectStorage.put({userId:'alice',diskSpace:''},'蓝调时刻.png',Readable.from([portrait]),{size:portrait.length,contentType:'image/png'});
 for (const dir of ['项目资料','影像素材','共享文档','网页作品'])f.store.createDirectory('alice',dir,30);
 for(const [name,type,text] of [['创意提案.md','text/markdown','# 创意提案\n\n先把灵感连接起来。'],['使用说明.txt','text/plain','跨设备协作工作台'],['项目资料/设计说明.md','text/markdown','# 设计说明']])await f.api.objectStorage.put({userId:'alice',diskSpace:''},name,Readable.from([Buffer.from(text)]),{size:Buffer.byteLength(text),contentType:type});
 const actualFiles=f.store.adminFiles().filter(x=>x.ownerId==='alice');
 const picture=actualFiles.find(x=>x.name==='蓝调时刻.png'), textFile=actualFiles.find(x=>x.name==='使用说明.txt'), mdFile=actualFiles.find(x=>x.name==='创意提案.md');
 const items=[{id:'design-item-0',stay:90,start:0,source:{kind:'disk',accountId:'alice',fileId:picture.id}},
 {id:'design-item-1',start:0,duration:180,source:{kind:'local',fileId:'design-audio',name:'清晨电台.wav',type:'audio/wav',size:1600000}},
 {id:'design-item-2',stay:90,start:0,source:{kind:'tunnel',sessionId:'fixture-tunnel',messageId:'text-record',fileId:'record',accessGrant:'fixture-proof'}},
 {id:'design-item-3',stay:90,start:0,source:{kind:'disk',accountId:'alice',fileId:mdFile.id}}];
 f.app.get('/design-seed-login',(req,res)=>{f.sessions.set(req,res,f.auth.user('alice'));res.json({ok:true});});
 const login=await fetch(f.base+'/design-seed-login');
 const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 const seedEdit=async(stationId,payload)=>{const response=await fetch(f.base+'/api/streaming/stations/'+stationId,{method:'PUT',headers:{'Content-Type':'application/json','X-Stream-Device':'design-device','X-Stream-Key':'design-preview-key'.repeat(4),'X-Disk-Account':'alice','Cookie':cookie},body:JSON.stringify(payload)});const body=await response.json();if(!response.ok)throw Error('SEED_EDIT '+JSON.stringify(body));return body;};
 const s=f.streaming.service.create(owner,{name:'蓝调放映室',creationId:'design-station'});
 await seedEdit(s.id,{configVersion:s.configVersion,loop:true,countdown:'edge',items});
 f.streaming.service.visibility(s.id,owner,{visibility:'public',version:f.streaming.service.station(s.id).playback.version});
 const station=f.streaming.service.station(s.id);
 // A second genuine station makes the list dense, without inventing UI columns.
 const s2=f.streaming.service.create(owner,{name:'工作时的背景频道',creationId:'design-station-2'});
 await seedEdit(s2.id,{configVersion:s2.configVersion,loop:true,items:[items[0]]});
 f.streaming.service.visibility(s2.id,owner,{visibility:'public',version:f.streaming.service.station(s2.id).playback.version});
 const express=require(path.join(root,'node_modules/express'));
 f.app.use('/ui-design',express.static(out));
 f.app.use('/prompts/resources',express.static(path.join(root,'prompts/resources')));
 f.app.get('/design-full',(_req,res)=>res.type('html').send(pageSource));
 f.app.get('/design-login',(req,res)=>{f.sessions.set(req,res,f.auth.user('alice'));res.redirect('/design-preview?surface='+encodeURIComponent(req.query.surface||'home'));});
 f.app.get('/design-preview',(req,res)=>{
  const surface=String(req.query.surface||'home');
  const stripped=pageSource.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
  const seed={surface,stationId:s.id,station:{name:station.name,configVersion:station.configVersion,loop:station.loop,countdown:station.countdown,items:station.items.map((item,i)=>({...item,source:{...item.source,accountId:'alice'},sourceSaved:true,location:'网盘 / 默认分区 / '+item.name}))},files:actualFiles.map(x=>({id:x.id,name:x.name})),deviceSecret:'design-preview-key'.repeat(4)};
  res.type('html').send(stripped.replace('</body>',scripts.map(n=>'<script src="/client/'+n+'.js"></script>').join('')+'<script>window.DESIGN_SEED='+JSON.stringify(seed)+'</script><script src="/ui-design/scripts/device-source.js"></script><script src="/ui-design/scripts/bootstrap.js"></script></body>'));
 });
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu','--no-first-run','--disable-background-networking'],downloadsPath:path.join(runtime,'downloads')});
 const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,locale:'zh-CN',timezoneId:'Asia/Singapore',serviceWorkers:'block'});
 const page=await context.newPage();
 page.on('pageerror',err=>console.log('PAGE_ERROR',err.message));
 page.on('dialog',async dialog=>{console.log('NATIVE_DIALOG',dialog.type(),dialog.message().slice(0,180));await dialog.dismiss();});
 const shotSource=async(name,surface,action)=>{console.log('SOURCE',name);await page.goto(f.base+'/design-login?surface='+surface);await page.waitForFunction(()=>window.DESIGN_READY===true,{timeout:30000});if(action)await action(page);await page.waitForTimeout(350);await freeze(page,name);};
 const take=async(name,title)=>{screenNames[name]=title;if(!mainScreens.includes(name)&&!extraScreens.includes(name))extraScreens.push(name);console.log('STATE',name);await page.waitForTimeout(200);await freeze(page,name);};
 const fullHome=async()=>{await page.goto(f.base+'/design-full');await page.waitForFunction(()=>typeof startupTimings!=='undefined'&&startupTimings.completeMs!==null);await page.addScriptTag({path:path.join(out,'scripts/full-home.js')});await page.waitForFunction(()=>window.DESIGN_HOME_READY||window.DESIGN_HOME_ERROR);const e=await page.evaluate(()=>window.DESIGN_HOME_ERROR);if(e)throw Error(e);};
 try{
 if(process.env.DESIGN_MOBILE_MENU){
  await page.setViewportSize({width:390,height:844});
  await shotSource('mobile-disk','disk');
  await page.locator('.telegram-drive-item').filter({hasText:'创意提案.md'}).first().locator('.telegram-drive-item-more').click();
  await page.waitForFunction(()=>document.getElementById('telegramDriveItemMenu')?.style.visibility==='visible');
  await freeze(page,'mobile-disk-menu');return;
 }
 if(!process.env.DESIGN_REMAINDER){
 await page.goto(f.base+'/design-seed-login');await fullHome();await freeze(page,'home');
 await page.locator('#connectionHeaderMenuBtn').click();await freeze(page,'home-menu');await page.locator('#connectionHeaderMenuBtn').click();
 await page.locator('#tunnelSettingsBtn').click();await take('home-settings','首页 · 隧道设置');await page.locator('#closeTunnelSettingsBtn').click();
 await page.evaluate(()=>showJoinedSessionSwitcher());await take('home-control-center','首页 · 控制中心与隧道切换');await page.locator('#closeSessionSwitcher').click();
 await page.evaluate(()=>showDeviceProfile({deviceId:'design-phone',name:'iPhone 16',model:'iPhone',shortCode:'K7M2P'}));await take('home-device','首页 · 设备资料');await page.locator('#closeDeviceProfileBtn').click();
 await page.locator('[data-message-id="design-msg-text"] .message-record-menu-trigger').click();await take('home-record-menu','传输记录 · 记录菜单');await page.keyboard.press('Escape');await page.mouse.click(400,105);
 await page.evaluate(()=>showTransferRecordDetails('design-msg-photo'));await take('home-details','传输记录 · 详细数据');mobileScreens.push('home-details');await page.evaluate(()=>closeTransferRecordDetails());
 await page.evaluate(async()=>{const record=await getFromStore('messages','design-msg-text');record.snsMediaItems=[{id:'design-sns',title:'蓝调时刻 · 周末影像手记',mediaKind:'video',coverUrl:'/ui-design/assets/sample-landscape.png',mediaUrl:'https://example.invalid/watch/blue-hour',serverState:'ready',generatedMessageId:'design-msg-photo',resultFileName:'蓝调时刻.png'}];await saveToStore('messages',record);await showTransferRecordDetails(record.id);});await take('home-details-sns','传输记录 · SNS来源详情');await page.locator('.transfer-record-raw-details summary').click();await take('home-details-raw','传输记录 · 记录元数据展开');await page.evaluate(()=>closeTransferRecordDetails());
 await page.evaluate(()=>viewRichContent('design-msg-rich'));await take('home-rich','传输记录 · 富文本预览');await page.evaluate(()=>document.getElementById('richViewer').classList.remove('active'));
 await page.evaluate(()=>showHistoryBackupDialog());await take('home-backup','首页 · 备份与导入');await page.evaluate(()=>document.querySelectorAll('.send-mode-overlay').forEach(n=>n.remove()));
 await page.evaluate(()=>showGarbageCleanupDialog());await page.locator('#confirmGarbageCleanup').waitFor();await take('home-cleanup','首页 · 清理垃圾缓存');mobileScreens.push('home-cleanup');await page.locator('#cancelGarbageCleanup').click();
 await page.evaluate(()=>showResourceBrowser());await take('home-resources','首页 · 资源浏览器');await page.evaluate(()=>document.getElementById('resourceBrowserLayer').hidden=true);
 await page.evaluate(()=>{NotificationCenter.add({id:'design-notice',type:'notice',title:'新的协作邀请',body:'小陈邀请你一起查看周末的影像素材。',createdAt:Date.now()});NotificationCenter.open();});await take('home-notifications','首页 · 通知中心');
 await shotSource('route','route');
 await shotSource('disk','disk');
 console.log('DISK_ROWS',await page.locator('#telegramDriveList').innerText());
 const fileRow=page.locator('.telegram-drive-item').filter({hasText:'蓝调时刻.png'}).first();
 await fileRow.locator('.telegram-drive-item-more').click();await page.waitForTimeout(200);await freeze(page,'disk-menu');
 await page.locator('#telegramDriveItemMenuBackdrop').click({position:{x:6,y:6}});await page.locator('#telegramDriveCreateBtn').click();await page.locator('#telegramDriveNewFolderBtn').click();await page.waitForTimeout(150);await freeze(page,'disk-dialog');
 const resetDisk=async()=>shotSource('disk','disk');
 const diskAction=async(label)=>{await page.locator('.telegram-drive-item').filter({hasText:'创意提案.md'}).first().locator('.telegram-drive-item-more').click();await page.locator('#telegramDriveItemMenu button').getByText(label,{exact:true}).click();};
 const closeDiskDialog=async()=>{await page.locator('#telegramDriveDialogCloseBtn').click();};
 await resetDisk();await page.locator('#telegramDriveViewBtn').click();await take('disk-grid','网盘 · 网格视图');await page.locator('#telegramDriveViewBtn').click();
 await diskAction('属性');await take('disk-properties','网盘 · 文件属性');await closeDiskDialog();
 await diskAction('复制/移动');await take('disk-transfer','网盘 · 复制与移动目录选择');await closeDiskDialog();
 await diskAction('静态资源设置');await take('disk-static','网盘 · 静态资源设置');await closeDiskDialog();
 await diskAction('分享');await take('disk-share','网盘 · 公开分享确认');await closeDiskDialog();
 await diskAction('邀请协同编辑');await take('disk-collaboration','网盘 · 协同邀请');await closeDiskDialog();
 await page.locator('#telegramDriveSettingsBtn').click();await take('disk-partitions','网盘 · 分区与个人设置');await closeDiskDialog();
 await page.locator('.disk-account-switcher').click();await take('disk-accounts','网盘 · 账号切换');await page.evaluate(()=>AccountUI.close());
 await page.locator('#telegramDriveTrashBtn').click();await take('disk-trash','网盘 · 回收站');
 }
 await shotSource('disk','disk');await page.locator('.telegram-drive-item-check').first().evaluate(el=>el.click());await take('disk-selection','网盘 · 批量选择');
 await page.locator('#telegramDriveClearSelectionBtn').click();await page.locator('#telegramDriveSearch').fill('没有匹配的测试条目');await page.waitForTimeout(500);await take('disk-empty','网盘 · 搜索无结果');
 await shotSource('workshop','workshop');
 await page.locator('[data-action="edit"]').first().click();await page.locator('.web-editor textarea').waitFor();await freeze(page,'workshop-editor');
 await page.locator('[data-editor-action="import-menu"]').click();await freeze(page,'workshop-import');
 await shotSource('stream','stream');
 await page.locator('.sc-row-actions button').filter({hasText:'操控串流台'}).first().click();await page.locator('.sc-global-controls').waitFor();await page.waitForTimeout(500);await freeze(page,'stream-control');
 await page.locator('.sc-actions button').filter({hasText:'编辑节目单'}).first().click();await page.locator('.sc-program').first().waitFor();await freeze(page,'stream-editor');
 await page.locator('.sc-editor-heading button').click();await page.locator('.sc-tabs button').filter({hasText:'网盘文件'}).click();await page.locator('.sc-candidate').first().waitFor();await page.locator('.sc-candidate input').first().check();await freeze(page,'stream-import');
 await page.locator('.sc-import-actions button').first().click();await take('stream-selected','串流控制台 · 待导入资源分类');await page.locator('.sc-selected-overlay button').getByText('收起',{exact:true}).click();
 await shotSource('stream-watch','watch');
 await shotSource('stream','stream');await page.locator('.sc-row-actions button').filter({hasText:'操控串流台'}).first().click();await page.locator('.sc-global-controls').waitFor();await page.locator('.sc-actions button').filter({hasText:'邀请与可见性'}).first().click();await take('stream-access','串流控制台 · 邀请与可见性');
 await page.locator('.sc-page button').getByText('观看者黑名单',{exact:true}).click();await take('stream-blacklist','串流控制台 · 观看者黑名单');
 // Responsive anchored menus are staged at their own viewport, rather than reusing desktop coordinates.
 await page.setViewportSize({width:390,height:844});
 await shotSource('mobile-disk','disk');await page.locator('.telegram-drive-item').filter({hasText:'创意提案.md'}).first().locator('.telegram-drive-item-more').click();await page.waitForFunction(()=>document.getElementById('telegramDriveItemMenu')?.style.visibility==='visible');await freeze(page,'mobile-disk-menu');
 await fullHome();await page.locator('[data-mobile-view="devices"]').click();await page.locator('#connectionHeaderMenuBtn').click();await freeze(page,'mobile-home-menu');
 await shotSource('mobile-workshop','workshop');await page.locator('[data-action="edit"]').first().click();await page.locator('.web-editor textarea').waitFor();await freeze(page,'mobile-workshop-editor');await page.locator('[data-editor-action="import-menu"]').click();await freeze(page,'mobile-workshop-import');mobileScreens.push('workshop-import','disk-accounts','disk-partitions','stream-selected','stream-access','stream-blacklist');
 if(process.env.DESIGN_CAPTURE_ONLY)return;
 // Screen docs are frozen actual DOM; no live APIs or product event handlers are exported.
 const rectReports=[];
 write('screens.json',JSON.stringify({screenNames,mainScreens,mobileScreens,themes},null,2));
 for(const variant of ['source',...themes]){
  for(const screen of [...mainScreens,...extraScreens]){
   console.log('RENDER',variant,screen);await page.setViewportSize({width:1440,height:1000});await page.goto(f.base+'/ui-design/snapshots/'+screen+'.html?variant='+variant);await page.waitForTimeout(120);
   if(screen==='stream-watch'||screen==='stream-control')await page.locator('.sc-media img').first().waitFor({state:'visible',timeout:3000}).catch(()=>{});
   await page.addStyleTag({content:'*{animation:none!important;transition:none!important}'});
   const rects=await page.evaluate(()=>[...document.querySelectorAll('button,input,select,textarea,.main-layout,.panel,.web-editor,.sc-nav,.sc-program,.telegram-drive-item')].filter(el=>el.getBoundingClientRect().width&&el.getBoundingClientRect().height).map(el=>{const r=el.getBoundingClientRect();return {tag:el.tagName,id:el.id,cl:el.className,text:(el.textContent||'').slice(0,32),x:r.x,y:r.y,w:r.width,h:r.height};}));rectReports.push({variant,screen,viewport:'desktop',rects});
   if(variant==='source')continue;
   await page.screenshot({path:path.join(out,variant,'desktop',screen+'.png'),animations:'disabled'});
  }
  if(variant==='source')continue;
  for(const screen of mobileScreens){
   console.log('MOBILE',variant,screen);const file=fs.existsSync(path.join(out,'snapshots/mobile-'+screen+'.html'))?'mobile-'+screen:['home-devices','home-editor'].includes(screen)?'home':screen;
   await page.setViewportSize({width:390,height:844});await page.goto(f.base+'/ui-design/snapshots/'+file+'.html?variant='+variant);
   if(screen==='home-devices'||screen==='home-editor')await page.evaluate(view=>{document.getElementById('appShell').dataset.mobileView=view;document.querySelector('.main-layout').style.setProperty('--workspace-index',view==='devices'?'0':'2');document.querySelectorAll('.mobile-workspace-button').forEach(b=>b.classList.toggle('active',b.dataset.mobileView===view));},screen==='home-devices'?'devices':'editor');
   if(screen==='home-menu')await page.evaluate(()=>{document.getElementById('appShell').dataset.mobileView='devices';document.querySelector('.main-layout').style.setProperty('--workspace-index','0');});
   await page.waitForTimeout(280);await page.screenshot({path:path.join(out,variant,'mobile',screen+'.png'),animations:'disabled'});
  }
 }
 write('layout-geometry.json',JSON.stringify(rectReports));
 const differences=[];for(const screen of Object.keys(screenNames)){const rows=rectReports.filter(x=>x.screen===screen);for(const r of rows.slice(1)){if(JSON.stringify(r.rects)!==JSON.stringify(rows[0].rects))differences.push({screen,variant:r.variant});}}
 write('render-report.json',JSON.stringify({desktopSize:[1440,1000],mobileSize:[390,844],themes,desktopScreens:Object.keys(screenNames),mobileCount:mobileScreens.length,geometryDifferences:differences,sourceFilesUnchanged:sources.every(file=>{const baseline=JSON.parse(fs.readFileSync(path.join(out,'source-baseline.json'),'utf8')).files.find(x=>x.file===file);return baseline.sha256===crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');})},null,2));
 }finally{await browser.close();await f.close();}
}
// Screenshot directories must exist before Playwright writes.
for(const variant of ['lumen','offset','orbit'])for(const size of ['desktop','mobile'])fs.mkdirSync(path.join(out,variant,size),{recursive:true});
main().catch(err=>{console.error(err);process.exit(1);});
