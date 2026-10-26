'use strict';
// Render existing frozen UI states without running application APIs.
const fs=require('node:fs'),path=require('node:path');
const out=path.resolve(__dirname,'..'),root=path.resolve(out,'../../..'),runtime=path.join(out,'_runtime');
process.env.TMP=runtime;process.env.TEMP=runtime;fs.mkdirSync(runtime,{recursive:true});
const {chromium}=require('C:/Users/Dell/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const express=require(path.join(root,'node_modules/express'));
const write=(n,x)=>{const p=path.resolve(out,n);if(!p.startsWith(out+path.sep))throw Error('SCOPE');fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,x);};
const script=fs.readFileSync(path.join(__dirname,'capture.cjs'),'utf8');
const names={home:'功能首页 · 三栏','home-menu':'首页 · 汉堡菜单',disk:'网盘 · 文件列表','disk-menu':'网盘 · 文件菜单','disk-dialog':'网盘 · 新建目录',workshop:'网页工坊 · 草稿箱','workshop-editor':'网页工坊 · 文件编辑','workshop-import':'网页工坊 · 导入菜单',stream:'串流控制台 · 发现','stream-editor':'串流控制台 · 节目单排序','stream-import':'串流控制台 · 跨渠道导入','stream-control':'串流控制台 · 全局操控','stream-watch':'串流控制台 · 对外播放',route:'隧道路由 · 入口'};
for(const match of script.matchAll(/take\('([^']+)'\s*,\s*'([^']+)'/g))names[match[1]]=match[2];
const screens=fs.readdirSync(path.join(out,'snapshots')).filter(f=>f.endsWith('.html')&&!f.startsWith('mobile-')).map(f=>f.slice(0,-5)).filter(s=>names[s]);
const screenNames=Object.fromEntries(screens.map(s=>[s,names[s]]));
const mainScreens=['home','disk','workshop-editor','stream-control','route'];
const mobileScreens=['home','home-devices','home-editor','home-menu','disk','disk-menu','workshop','workshop-editor','workshop-import','stream','stream-editor','stream-import','stream-control','stream-watch','route','home-settings','home-control-center','home-cleanup','home-details','home-details-sns','home-details-raw','disk-accounts','disk-partitions','disk-transfer','disk-share','disk-trash','stream-selected','stream-access','stream-blacklist'].filter(s=>['home-devices','home-editor'].includes(s)||screens.includes(s));
const themes=['lumen','orbit'];
const mobileSnapshots=fs.readdirSync(path.join(out,'snapshots')).filter(f=>f.startsWith('mobile-')&&f.endsWith('.html')).map(f=>f.slice(7,-5));
write('screens.json',JSON.stringify({screenNames,mainScreens,mobileScreens,mobileSnapshots,themes},null,2));
const fallback='data:image/png;base64,'+fs.readFileSync(path.join(out,'assets/sample-landscape.png')).toString('base64');
for(const file of fs.readdirSync(path.join(out,'snapshots')).filter(f=>f.endsWith('.html'))){const p=path.join(out,'snapshots',file);let html=fs.readFileSync(p,'utf8');html=html.replace(/<img\b[^>]*>/g,tag=>tag.replace(/src="([^"]*)"/,(_all,src)=>{if(src.startsWith('data:image/'))return 'src="'+src+'"';if(tag.includes('telegram-drive-thumbnail'))return 'src="'+fallback+'"';let local=src.startsWith('/ui-design/')?path.join(out,src.slice('/ui-design/'.length)):src.startsWith('/client/')||src.startsWith('/prompts/resources/icons/')?path.join(root,src):null;if(local&&fs.existsSync(local)){const mime=path.extname(local)==='.svg'?'image/svg+xml':path.extname(local)==='.png'?'image/png':'image/jpeg';return 'src="data:'+mime+';base64,'+fs.readFileSync(local).toString('base64')+'"';}return 'src="'+src+'"';}));fs.writeFileSync(p,html);}
async function main(){
 const app=express();app.use(express.static(out));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu','--no-first-run','--disable-background-networking']});
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',deviceScaleFactor:1,serviceWorkers:'block'});
 const page=await context.newPage();const reports=[],inventory={},imageIssues=[];
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===origin||['data:','blob:'].includes(u.protocol))return route.continue();return route.abort();});
 try{
  for(const size of ['desktop','mobile'])for(const variant of ['source',...themes])for(const screen of size==='desktop'?screens:mobileScreens){
   const file=fs.existsSync(path.join(out,'snapshots/mobile-'+screen+'.html'))&&size==='mobile'?'mobile-'+screen:['home-devices','home-editor'].includes(screen)?'home':screen;
   const work=screen==='home-devices'?'devices':screen==='home-editor'?'editor':screen==='home-menu'&&size==='mobile'?'devices':'';
   console.log('RENDER',size,variant,screen);
   await page.setViewportSize(size==='desktop'?{width:1440,height:1000}:{width:390,height:844});
   await page.goto(origin+'/snapshots/'+file+'.html?variant='+variant+(work?'&workspace='+work:''));
   await page.addStyleTag({content:'*{animation:none!important;transition:none!important}'});
   await page.waitForTimeout(120);
   const result=await page.evaluate(()=>{
    const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return !!(r.width&&r.height)&&s.visibility!=='hidden'&&s.display!=='none';};
    const controls=[...document.querySelectorAll('button,input,select,textarea,a,[role=button],summary')].filter(visible).map((el,i)=>{const r=el.getBoundingClientRect();return {index:i,tag:el.tagName,id:el.id,cl:String(el.className),label:el.getAttribute('aria-label')||el.getAttribute('title')||(el.textContent||'').trim().slice(0,80),disabled:el.disabled===true,rect:[r.x,r.y,r.width,r.height].map(v=>Math.round(v*100)/100)};});
    const images=[...document.images].filter(visible).filter(i=>!i.complete||!i.naturalWidth).map(i=>({class:i.className,src:i.getAttribute('src').slice(0,100)}));
    return {controls,images};
   });
   reports.push({size,variant,screen,controls:result.controls});
   if(variant==='source')inventory[size+':'+screen]=result.controls;
   if(result.images.length)imageIssues.push({size,variant,screen,images:result.images});
   if(variant!=='source'){const dir=path.join(out,variant,size);fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,screen+'.png'),animations:'disabled'});}
  }
  const diffs=[];
  for(const r of reports.filter(r=>r.variant!=='source')){const base=reports.find(a=>a.variant==='source'&&a.size===r.size&&a.screen===r.screen);const a=base.controls,b=r.controls;if(a.length!==b.length){diffs.push({size:r.size,screen:r.screen,variant:r.variant,reason:'count',source:a.length,skin:b.length});continue;}for(let i=0;i<a.length;i++){const deltas=a[i].rect.map((v,j)=>Math.abs(v-b[i].rect[j]));if(deltas.some(n=>n>.15)){diffs.push({size:r.size,screen:r.screen,variant:r.variant,label:a[i].label,source:a[i].rect,skin:b[i].rect});break;}}}
  write('layout-geometry.json',JSON.stringify(reports));write('interaction-inventory.json',JSON.stringify(inventory,null,2));
  write('render-report.json',JSON.stringify({desktopSize:[1440,1000],mobileSize:[390,844],themes,desktopScreens:screens,mobileScreens,pngCount:themes.length*(screens.length+mobileScreens.length),geometryDifferences:diffs,imageIssues,method:'Same frozen DOM and original CSS, comparing control rectangles with source vs skin. Animations frozen for still-image inspection only.'},null,2));
  console.log('DONE',JSON.stringify({screens:screens.length,mobile:mobileScreens.length,differences:diffs.length,imageIssues:imageIssues.length}));
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exit(1);});
