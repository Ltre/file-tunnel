'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const{chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');let server,browser,base;
before(async()=>{
 const app=express();app.use(express.json());app.use('/client',express.static(path.join(root,'client')));app.use('/prototype',express.static(path.join(root,'prompts/resources/BUG-261106/tunnel-route-add-scan')));
 app.get('/entry',(_req,res)=>res.type('html').send(read('pages/tunnel-entry.html')));
 app.get('/api/short-codes/ABCDE',(_req,res)=>res.json({sessionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}));app.post('/api/tunnel-access',(req,res)=>res.json({allowed:true,grant:'fixture',deviceId:req.body.deviceId}));
 app.get('/',(_req,res)=>res.type('html').send('<main id="arrived">Entered target</main>'));
 const appSource=read('app.js'),landing=read('pages/index.html').slice(read('pages/index.html').indexOf('    <div class="tunnel-landing"'),read('pages/index.html').indexOf('    <header class="tunnel-topbar"'));
 app.get('/full',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${['themes-legacy','index','tunnel-landing','themes-blamen','themes-lusns','themes'].map(file=>'<link rel="stylesheet" href="/client/'+file+'.css">').join('')}<body>${landing}<div id="appShell">Previous home</div><script src="/client/tunnel-code-scanner.js"></script><script>
 const state={sessionId:new URLSearchParams(location.search).has('empty')?'':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',shortCode:'ABCDE',sessionRemark:'最近使用',recentSessionId:null,pendingSharedFileCount:0};
 const readSessionDirectoryCache=()=>JSON.parse(localStorage.getItem('tunnelSessionDirectory:v1')||'[]'),replaceSessionDirectoryCache=x=>x,getAllFromStore=async()=>readSessionDirectoryCache(),normalizeLocalShortCode=x=>x,historyLog=()=>{},generateId=()=>state.sessionId,authorizeTunnelSelection=async()=>{},selectTunnelByShortCode=async()=>{document.getElementById('appShell').textContent='scanned';};
 ${appSource.slice(appSource.indexOf('function initSessionLanding('),appSource.indexOf('function generateId('))}
 ${appSource.slice(appSource.indexOf('function closeTunnelCodeScanner('),appSource.indexOf('// ==================== Socket.io 连接'))}
 document.body.dataset.theme=localStorage.getItem('uiTheme')||'';window.showRoute=()=>{document.body.classList.add('tunnel-route-active');initSessionLanding({overlay:true});};</script>`));
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({channel:'chrome',headless:true});
});
test('all seven themes match both approved route layouts in lightweight and full-home modes',async()=>{
 const themes=['Classic','Lumen','Orbit','Atelier','Social','Blamen','Lusns'];
 for(const theme of themes)for(const joined of [false,true]){
  const actual=[];
  for(const mode of ['entry','full']){
   const page=await browser.newPage({viewport:{width:900,height:700}});try{
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(({theme,entries})=>{localStorage.setItem('uiTheme',theme.toLowerCase());localStorage.setItem('tunnelSessionDirectory:v1',JSON.stringify(entries));},{theme,entries:joined?entries:[]});
    await page.goto(base+'/'+mode+'?leave=1'+(joined?'':'&empty=1'));if(mode==='full')await page.evaluate(()=>showRoute());
    await page.locator('#sessionLanding').waitFor({state:'visible'});await page.waitForFunction(joined=>document.getElementById('sessionLanding').dataset.hasSessions===String(joined),joined);
    const values=await page.evaluate(()=>{
     const selectors=['.tunnel-landing-topbar','#tunnelCodeInputs input','#landingScanBtn','.tunnel-landing-actions','#landingSessionSelect','#landingRecentBtn','#landingCreateBtn'];
     return Object.fromEntries(selectors.map(selector=>{const n=document.querySelector(selector),r=n.getBoundingClientRect(),s=getComputedStyle(n);return[selector,{x:r.x,y:r.y,w:r.width,h:r.height,bg:s.backgroundColor,image:s.backgroundImage,color:s.color,border:s.borderColor,radius:s.borderRadius,font:s.fontSize,align:s.textAlign,last:s.textAlignLast}];}));
    });
    const expectBox=(selector,x,y,w,h)=>{for(const [key,value]of Object.entries({x,y,w,h}))assert.ok(Math.abs(values[selector][key]-value)<1.1,`${theme}/${joined}/${mode} ${selector}.${key}: ${values[selector][key]} expected ${value}`);};
    expectBox('.tunnel-landing-topbar',18,18,864,58);expectBox('#tunnelCodeInputs input',284,232,60,64);expectBox('#landingScanBtn',278,320,344,62);
    if(joined){expectBox('.tunnel-landing-actions',226,464,448,212);expectBox('#landingSessionSelect',238,475,424,57);expectBox('#landingRecentBtn',238,542,424,56);expectBox('#landingCreateBtn',238,607,424,57);assert.equal(values['#landingSessionSelect'].align,'center');assert.equal(values['#landingSessionSelect'].last,'center');}
    else{expectBox('#landingCreateBtn',278,426,344,56);assert.equal(await page.locator('#landingRecentBtn').isVisible(),false);}
    const svg=read('prompts/resources/BUG-261106/tunnel-route-add-scan/'+theme+'/tunnel-route-add-scan.svg');
    const expectedHex=(rule,property)=>svg.match(new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*\\{[^}]*?'+property+':(#[0-9a-f]+)'))?.[1];
    const rgb=hex=>'rgb('+hex.slice(1).match(/../g).map(n=>parseInt(n,16)).join(', ')+')';
    assert.equal(values['#landingCreateBtn'].border,rgb(expectedHex('#create-tunnel-button>rect','stroke')));assert.equal(values['#landingCreateBtn'].color,rgb(expectedHex('#create-tunnel-button>text','fill')));
    assert.notEqual(values['#landingScanBtn'].bg,'rgba(0, 0, 0, 0)');assert.equal(values['#tunnelCodeInputs input'].font,'26px');
    actual.push(values);assert.deepEqual(errors,[]);
    if(mode==='entry'&&['Lumen','Orbit'].includes(theme)){fs.mkdirSync(path.join(root,'.npm-cache/route-261106-3'),{recursive:true});await page.screenshot({path:path.join(root,'.npm-cache/route-261106-3',theme+'-'+(joined?'joined':'none')+'.png')});}
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.querySelector('#sessionLanding').scrollWidth<=innerWidth),true);
    const b=await page.locator('#landingCreateBtn').boundingBox();assert.ok(b.x>=0&&b.x+b.width<=390);
   }finally{await page.close();}
  }
  assert.deepEqual(actual[0],actual[1],`${theme}/${joined}: shared component differs between modes`);
 }
});
test('route scan buttons reuse the original scanner; closing it releases camera and decoded codes enter a tunnel',async()=>{
 for(const mode of ['entry','full']){
  const page=await browser.newPage();try{
   await page.addInitScript(()=>{
    window.stopped=0;window.scanValue='';window.BarcodeDetector=class{async detect(){return window.scanValue?[{rawValue:window.scanValue}]:[];}};
    navigator.mediaDevices.getUserMedia=async()=>{const stream=new MediaStream();stream.getTracks=()=>[{stop:()=>window.stopped++}];return stream;};
    HTMLMediaElement.prototype.play=async()=>{};Object.defineProperty(HTMLMediaElement.prototype,'readyState',{get:()=>4});
   });
   const files=[];page.on('request',request=>files.push(new URL(request.url()).pathname));
   await page.goto(base+'/'+mode+'?leave=1&empty=1');if(mode==='full')await page.evaluate(()=>showRoute());
   await page.locator('#landingScanBtn').click();await page.locator('[data-tunnel-code-scanner] video').waitFor();assert.equal(await page.locator('#sessionLanding [data-tunnel-code-scanner]').count(),1);
   await page.locator('[data-tunnel-code-scanner] [data-close]').click();assert.equal(await page.evaluate(()=>stopped),1);
   await page.locator('#landingScanBtn').click();await page.evaluate(()=>scanValue='ABCDE');
   if(mode==='entry')await page.locator('#arrived').waitFor();else await page.waitForFunction(()=>document.getElementById('appShell').textContent==='scanned');
   if(mode==='entry'){assert.equal(files.includes('/app.js'),false);assert.equal(files.some(file=>/file-assets|streaming-console|jsqr/i.test(file)),false);}
   await page.goto(base+'/'+mode+'?leave=1&empty=1');if(mode==='full')await page.evaluate(()=>showRoute());
   await page.locator('#landingScanBtn').click();await page.evaluate(value=>scanValue=value,base+'/?tunnel_join=fixture-signed-link#bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
   await page.locator('#arrived').waitFor();assert.equal(new URL(page.url()).searchParams.get('tunnel_join'),'fixture-signed-link');assert.equal(new URL(page.url()).hash,'#bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  }finally{await page.close();}
 }
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));});
const entries=[{sessionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',shortCode:'ABCDE',remark:'最近使用',lastActive:1}];
test('a blocked browser database cannot hide the local tunnel picker or lock lightweight routing',async()=>{
 const page=await browser.newPage();try{
 await page.addInitScript(value=>{localStorage.setItem('tunnelSessionDirectory:v1',JSON.stringify(value));indexedDB.open=()=>({});},entries);
 await page.goto(base+'/entry?leave=1');await page.locator('#sessionLanding').waitFor({state:'visible',timeout:1500});assert.equal(await page.locator('#landingSessionSelect').inputValue(),entries[0].sessionId);
 assert.equal(await page.locator('#landingScanBtn').isEnabled(),true);assert.equal(await page.locator('#landingCreateBtn').isEnabled(),true);
 }finally{await page.close();}
});
