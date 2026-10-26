const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const base=path.resolve(__dirname,'..');process.env.TEMP=path.join(base,'_runtime');process.env.TMP=process.env.TEMP;
const {chromium}=require('C:/Users/Dell/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const cases=[
 ['01','home-resources',1440,'.resource-browser-modal','资源浏览器 · 宽屏','.resource-browser-name,.resource-browser-summary,.resource-browser-meta,.resource-browser-mounts strong,.resource-action,.resource-reference-button'],
 ['02','home-settings',390,'.tunnel-settings-panel','隧道设置 · 窄屏','.tunnel-settings-header h2,.tunnel-settings-section>p,.tunnel-settings-panel .session-tool:not(:disabled),.tunnel-permission-option'],
 ['03','disk-transfer',390,'.telegram-drive-dialog-card','树形目录选择器 · 窄屏','.disk-folder-target'],
 ['04','home-settings',1440,'.tunnel-settings-panel','隧道设置 · 宽屏','.tunnel-settings-header h2,.tunnel-settings-section>p,.tunnel-settings-panel .session-tool:not(:disabled),.tunnel-permission-option'],
 ['05','home-rich',1440,'.rich-viewer','富文本预览 · 宽屏','.rich-viewer-content p,.rich-viewer-content h2,.rich-viewer-content li'],
 ['06','home-record-menu',1440,'.message-record-action-menu','传输记录菜单 · 宽屏','.message-record-action-menu .history-action'],
 ['07','home-device',1440,'.device-profile-modal','设备详情与二维码 · 宽屏','.device-profile-name'],
 ['08','home-control-center',1440,'.control-center','控制中心 · 列表可滚动','.session-switch-scroll,.session-switch-item'],
 ['09','home-backup',1440,'.send-mode-dialog','传输记录备份 · 宽屏','.send-mode-dialog>p,.send-mode-dialog>h3'],
 ['10','disk-transfer',1440,'.telegram-drive-dialog-card','树形目录选择器 · 宽屏','.disk-folder-target']
];
async function main(){const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu','--no-first-run']});const page=await browser.newPage();const dir=path.join(base,'orbit/review');fs.mkdirSync(dir,{recursive:true});const report=[];try{
for(const [id,screen,width,target,label,texts]of cases){await page.setViewportSize({width,height:width===1440?1000:844});await page.goto(pathToFileURL(path.join(base,'snapshots',screen+'.html')).href+'?variant=orbit');await page.addStyleTag({content:'*{animation:none!important;transition:none!important}'});await page.waitForTimeout(80);
 const rows=await page.locator(texts).evaluateAll(nodes=>{
  const rgb=s=>(s.match(/[\d.]+/g)||[]).map(Number),lum=v=>v.slice(0,3).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i],0);
  return nodes.filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width&&r.height&&s.visibility!=='hidden'&&!el.closest('[hidden]');}).map(el=>{const style=getComputedStyle(el),fg=rgb(style.color);let bg=[0,0,0,0],cursor=el;while(cursor&&bg[3]<.999){const v=rgb(getComputedStyle(cursor).backgroundColor),alpha=v.length>3?v[3]:1;const total=bg[3]+alpha*(1-bg[3]);if(total>0){for(let i=0;i<3;i++)bg[i]=(bg[i]*bg[3]+v[i]*alpha*(1-bg[3]))/total;bg[3]=total;}cursor=cursor.parentElement;}if(bg[3]<.999)bg=[255,255,255,1];const a=lum(fg),b=lum(bg);return {text:el.textContent.trim().slice(0,70),color:style.color,background:bg.slice(0,3).map(Math.round),ratio:Math.round(((Math.max(a,b)+.05)/(Math.min(a,b)+.05))*100)/100};});});report.push({id,screen,width,rows});
 await page.locator(target).first().screenshot({path:path.join(dir,id+'.png'),animations:'disabled'});
 // Refresh the existing overview image too, including the corrected monochrome menu icons.
 await page.screenshot({path:path.join(base,'orbit',width===1440?'desktop':'mobile',screen+'.png'),animations:'disabled'});
}
const issues=report.flatMap(c=>c.rows.filter(r=>r.ratio<4.5).map(r=>({id:c.id,...r})));fs.writeFileSync(path.join(base,'contrast-check.json'),JSON.stringify({checkedAt:new Date().toISOString(),method:'Computed text color vs composited flat ancestor surfaces; focus on reported labels and copy, excluding disabled text, icons and media.',cases:report,issues},null,2));
fs.writeFileSync(path.join(base,'orbit-review.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ORBIT · 十项反馈修订</title><style>body{margin:0;background:#11141d;color:#e8ebfa;font:15px/1.7 system-ui,'Microsoft YaHei',sans-serif}main{max-width:1280px;margin:40px auto;padding:0 24px}a{color:#b3a6ff}h1{font-size:34px}p{color:#b2bdd5}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}article{background:#1a1f2d;border:1px solid #343d56;border-radius:14px;padding:20px}img{display:block;max-width:100%;max-height:720px;margin:auto;object-fit:contain}h2{font-size:18px;margin:0 0 20px}@media(max-width:760px){.grid{grid-template-columns:1fr}}</style><main><a href="index.html?variant=orbit">← 设计总览</a><h1>ORBIT · 十项反馈修订</h1><p>按你给出的图号排列。保留原有布局、字段与操作；深色表面和文字分别校正。</p><div class="grid">${cases.map(([id,screen,width,target,label])=>`<article><h2>${id} / ${label}</h2><a href="prototype.html?variant=orbit&screen=${screen}&size=${width===1440?'desktop':'mobile'}"><img src="orbit/review/${id}.png" alt="${label}"></a></article>`).join('')}</div><p>控制中心使用 12 条示例隧道，展示原有的溢出与上下按钮；点击该图可进入可滚动预览。</p></main></html>`);
console.log(JSON.stringify({cases:report.length,texts:report.reduce((n,c)=>n+c.rows.length,0),issues}));
}finally{await browser.close();}}
main().catch(e=>{console.error(e);process.exit(1);});
