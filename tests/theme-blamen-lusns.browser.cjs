'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os'),express=require('express');
const {chromium}=require(process.argv[2]||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8'),out=path.join(root,'.npm-cache/theme-261101');
(async()=>{
 const app=express(),source=read('app.js');let browser;
 const themes=source.slice(source.indexOf('function applyTheme('),source.indexOf('function isTunnelOwner('));
 const shell=read('pages/index.html'),startup=[...shell.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].find(match=>match[1].includes('const startupTheme ='))[0];
 const controls=source.slice(source.indexOf('function normalizeControlCenterOrder('),source.indexOf('function showTunnelRemarkDialog('));
 const signIn=read('client/disk-ui.js').split('function appendTelegramDriveAddAccount(')[1].split('async function manageTelegramDriveAccounts(')[0];
 app.get('/theme-check',(_req,res)=>res.type('html').send(read('pages/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>',`<script>
 const state={sessionId:'fixture-tunnel'},getAllFromStore=async()=>[{sessionId:'fixture-tunnel',shortCode:'ABCDE',remark:'主题验证'}],escapeHtml=String,normalizeLocalShortCode=String,historyLog=()=>{},hasActiveTransferTasks=()=>false;
 ${themes}\n${controls}\nfunction appendTelegramDriveAddAccount(${signIn}
 initThemeSwitcher();
 document.getElementById('tunnelStartupLoading').hidden=!new URL(location.href).searchParams.has('loading');document.getElementById('appShell').hidden=false;document.getElementById('sessionLanding').hidden=true;document.getElementById('tunnelTopbar').hidden=false;
 document.getElementById('chatMessages').innerHTML='<article class="message"><div class="message-header">设备 · 12:30</div><div class="message-bubble">文件与协作，保持原有组件。</div></article><article class="message own"><div class="message-header">我 · 12:31</div><div class="message-bubble">自己的消息</div></article><article class="message"><div class="file-message"><div class="file-name">文件示例.mp4</div><div class="file-size">12 MB</div></div><div class="record-remark-preview">记录备注</div></article>';
 document.getElementById('editor').textContent='协同编辑区域';document.getElementById('shortCodeText')?.replaceChildren(document.createTextNode('ABCDE'));
 const samples=document.createElement('div');samples.id='palette-samples';samples.innerHTML='<button id="telegramDriveCreateBtn">+</button><div class="account-overlay"><section class="account-panel"><div id="signin"></div></section></div><div id="streamingConsole" class="sc-overlay" hidden><nav class="sc-nav"><button data-sc-view="discover">发现</button><button class="sc-primary">+ 创建</button></nav><div class="sc-row-actions"><button class="sc-primary">打开观看</button></div><div class="sc-editor-actions"><button class="sc-primary">保存</button></div><div class="sc-import-actions"><button class="sc-primary">导入</button></div><div class="sc-editor-heading"><button>打乱</button><button>导入</button></div></div>';document.body.append(samples);
 appendTelegramDriveAddAccount(document.getElementById('signin'),{oidcConfigured:true,oidcMode:'mock'},{embedded:true});document.querySelector('.account-overlay').hidden=true;
 document.getElementById('telegramDriveDialogBody').innerHTML='<div class="disk-collaboration-list"></div>';document.getElementById('telegramDriveDialogActions').innerHTML='<button class="btn btn-primary">关闭</button>';
 </script></body>`)));
 app.get('/startup-check',(_req,res)=>res.type('html').send(shell.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('<body>','<body>'+startup+`<script>window.paints=[];requestAnimationFrame(function sample(){const n=document.getElementById('tunnelStartupLoading');if(n)paints.push({theme:document.body.dataset.theme,background:getComputedStyle(n).backgroundImage});if(paints.length<8)requestAnimationFrame(sample);});</script>`)));
 app.use(express.static(root));const server=await require('./support/listen-http.cjs').listenHttp(app),base='http://127.0.0.1:'+server.address().port;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1366,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));fs.mkdirSync(out,{recursive:true});
  await page.goto(base+'/theme-check');const results=[];
  const settle=()=>page.evaluate(async()=>{await new Promise(requestAnimationFrame);await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
  const geometry=()=>page.evaluate(()=>['#tunnelTopbar','.main-layout','.left-panel','.center-panel','#workspaceCollabPanel','#dropZone','#textInput','#sendMarkdownBtn','#sendTextBtn','#editor','#sendRichBtn','.short-code-switch'].map(selector=>{const n=document.querySelector(selector),r=n.getBoundingClientRect(),s=getComputedStyle(n);return{selector,rect:[r.x,r.y,r.width,r.height],font:[s.fontFamily,s.fontSize,s.fontWeight,s.lineHeight],radius:s.borderRadius,text:n.textContent};}));
  for(const width of [390,800,1366,1920]){
   await page.setViewportSize({width,height:900});await page.evaluate(()=>{applyTheme('classic');document.getElementById('appShell').dataset.mobileView='chat';});await settle();const baseline=await geometry();
   for(const theme of ['blamen','lusns']){
    await page.evaluate(theme=>applyTheme(theme),theme);await settle();assert.deepEqual(await geometry(),baseline,'new theme must retain base geometry, fonts, shape and content at '+width);
    const palette=await page.evaluate(()=>({background:getComputedStyle(document.body).backgroundImage,header:getComputedStyle(document.querySelector('.center-panel .panel-header')).backgroundImage,border:getComputedStyle(document.getElementById('dropZone')).borderStyle}));
    assert.match(palette.background,/repeating-linear-gradient/);assert.equal(palette.border,'dashed');
    results.push({theme,width,...palette});await page.screenshot({path:path.join(out,theme+'-'+width+'.png')});
   }
  }
  for(const theme of ['blamen','lusns']){
   await page.evaluate(theme=>applyTheme(theme),theme);await settle();
   const colors=await page.evaluate(()=>['#telegramDriveCreateBtn','#telegramDriveDialogActions>button','.account-overlay [data-sign-in-mode="mock"]','#streamingConsole [data-sc-view="discover"]','#streamingConsole .sc-nav>.sc-primary','#streamingConsole .sc-row-actions>.sc-primary','#streamingConsole .sc-editor-actions>.sc-primary','#streamingConsole .sc-import-actions>.sc-primary','#streamingConsole .sc-editor-heading>button:last-child'].map(selector=>{const s=getComputedStyle(document.querySelector(selector));return[s.backgroundImage,s.backgroundColor,s.color];}));
   assert.ok(colors.every(color=>JSON.stringify(color)===JSON.stringify(colors[0])),'specified external buttons share the theme primary palette');
   await page.setViewportSize({width:390,height:844});await page.evaluate(()=>showJoinedSessionSwitcher());await page.locator('.control-center-overlay').waitFor();
   const current=await page.locator('.session-switch-item.is-current').evaluate(n=>{const s=getComputedStyle(n);return{s:s.color,b:s.borderColor,bg:s.backgroundImage,fill:s.backgroundColor,shadow:s.boxShadow};});assert.equal(current.fill,'rgb(255, 255, 255)');assert.equal(current.bg,'none');assert.equal(current.b,'rgb(94, 114, 216)');assert.equal(current.shadow,'rgba(102, 126, 234, 0.14) 0px 0px 0px 2px');
   await page.screenshot({path:path.join(out,theme+'-control-center.png')});
   await page.locator('.control-center').evaluate(n=>n.dispatchEvent(new MouseEvent('click',{bubbles:true})));assert.equal(await page.locator('.control-center-overlay').count(),0,'empty area inside the visual rectangle closes the control center');
   await page.reload();assert.equal(await page.evaluate(()=>document.body.dataset.theme),theme,'saved theme survives reload');
   assert.equal(await page.locator('.theme-option[data-theme="'+theme+'"],.theme-quick-option[data-theme="'+theme+'"]').count(),2);
   await page.goto(base+'/theme-check?loading=1');await page.screenshot({path:path.join(out,theme+'-loading.png')});assert.match(await page.locator('#tunnelStartupLoading').evaluate(n=>getComputedStyle(n).backgroundImage),/repeating-linear-gradient/);
   await page.locator('#tunnelStartupLoading').evaluate(n=>n.hidden=true);
   const other=theme==='blamen'?'lusns':'blamen';await page.evaluate(other=>{for(const link of document.querySelectorAll('link[rel=stylesheet]'))if(link.href.endsWith('/themes.css')||link.href.endsWith('/themes-legacy.css')||link.href.endsWith('/themes-'+other+'.css'))link.remove();},other);
   assert.match(await page.evaluate(()=>getComputedStyle(document.querySelector('.center-panel .panel-header')).backgroundImage),/gradient/,'palette works without every other theme file');
   await page.goto(base+'/startup-check');await page.waitForFunction(()=>paints.length>=4);assert.ok(await page.evaluate(theme=>paints.every(p=>p.theme===theme&&p.background.includes('repeating-linear-gradient')),theme),'production startup preference is correct from the first painted loading frame');
   await page.goto(base+'/theme-check');
  }
  const allowed=new Set(['background','background-color','background-image','color','border-color','border-left-color','border-right-color','border-top-color','border-bottom-color','box-shadow','caret-color','accent-color','outline-color']);
  const bad=await page.evaluate(()=>{const rules=[];const walk=items=>{for(const rule of items){if(rule.cssRules)walk(rule.cssRules);if(rule.style)for(const property of rule.style)rules.push(property);}};for(const sheet of document.styleSheets)if(/themes-(blamen|lusns)\.css$/.test(sheet.href||''))walk(sheet.cssRules);return rules;});assert.deepEqual(bad.filter(p=>!p.startsWith('--')&&!p.startsWith('background-')&&!allowed.has(p)),[],'theme declarations are color/effect only');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(results,null,2));console.log('PASS independent Blamen/Lusns colors, four viewport geometries, external button scope, control center, preferences and loading');
 }finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
