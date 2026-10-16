const fs=require('fs'),path=require('path'),crypto=require('crypto');
const OUT=path.resolve(__dirname,'..'),MOBILE=path.join(OUT,'mobile');
const runtime='C:/Users/Dell/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const html=fs.readFileSync(path.join(OUT,'index.html'),'utf8');
const desktop=JSON.parse(html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const originalPC=new Map(desktop.flatMap(p=>['svg','png'].map(ext=>{const file=path.join(OUT,p.id+'.'+ext);return [file,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')];})));
const originalInfo=crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT,'info.txt'))).digest('hex');
const aliases={'23-mobile-navigation':'m-home-records','24-mobile-create-pool':'03-create-edit','25-mobile-import':'04-source-drive','26-mobile-play-monitor':'06-owner'};
const titleOverrides={
 '01-home-entry':'首页菜单入口','02-discovery':'发现与订阅','03-create-edit':'创建与编辑串流台','04-source-drive':'导入：网盘候选','05-imported-pool':'已导入资源与排序','06-owner':'发起端：播放与当前项','07-receiver':'接收端：文件观看','08-monitor-wall':'监控：四画面','09-access':'邀请与可见性','10-my-stations':'我创建的串流台','11-my-subscriptions':'我订阅的串流台','12-source-local':'导入：本机候选','13-source-tunnel':'导入：隧道候选','14-camera':'摄像头来源配置','15-screen':'屏幕共享来源配置','16-random-drive':'随机网盘资源','17-random-tunnel':'随机隧道记录','18-monitor-nine':'监控：九画面与单格控制','19-recovery':'异常、下线与恢复','20-camera-permission':'摄像头原生权限示意','21-screen-permission':'屏幕选择器示意','22-home-background':'首页：连接设备','27-media-fullscreen':'文件媒体全屏','28-private-confirm':'转为仅限邀请：确认','29-sorted-pool':'资源排序后','30-offline-confirm':'串流台下线：确认','31-media-previews':'音频、图片与文本预览入口','32-live-active':'实时采集：已启动','33-accept-invitation':'接收邀请与加入','34-imported-eight':'确认导入后的混合列表','35-create-after-import':'导入后返回创建页','36-receiver-live':'接收端：实时观看','37-monitor-presets':'监控布局预设','38-live-fullscreen':'实时画面全屏','39-monitor-fullscreen':'监控方阵全屏','40-kick-all':'批量踢出接收端：确认','41-kick-one':'踢出单个接收端：确认'
};
const extra=[
 ['m-home-records','首页：传输记录与草稿','22-home-background'],['m-home-editor','首页：协同编辑与草稿','22-home-background'],
 ['m-owner-playlist','发起端：查看播放列表','06-owner'],['m-owner-viewers','发起端：查看观看者状态','06-owner'],
 ['m-monitor-list','监控清单与添加订阅台','08-monitor-wall'],['m-monitor-focus','监控：单画面放大','08-monitor-wall'],
 ['m-resource-preview','已导入资源：独立预览','05-imported-pool'],['m-source-types','选择串流来源类型','03-create-edit'],
 ['m-templates','保存模板与复用入口','03-create-edit'],['m-media-audio','音频台：播放与本机音频','31-media-previews'],
 ['m-media-image','图片台：预览与上下切换','31-media-previews'],['m-media-markdown','Markdown 台：阅读','31-media-previews'],
 ['m-media-txt','TXT 台：阅读','31-media-previews'],['m-import-review','跨渠道待导入清单','04-source-drive']
];
const pages=[...desktop.filter(p=>!aliases[p.id]).map(p=>({id:p.id,title:titleOverrides[p.id]||p.title,pcId:p.id,note:`对应 PC ${p.id.slice(0,2)}；此页已按窄屏重排，内容独立滚动，底部主要动作保持可达。`})),...extra.map(([id,title,pcId])=>({id,title,pcId,note:'由 PC 页面 '+pcId.slice(0,2)+' 在窄屏下拆分出的独立操作页。'}))];
const catalog={version:3,widths:[320,360,390,430,768],aliases,pages};
function write(file,s){fs.writeFileSync(file,s);}
function prepare(){
 fs.mkdirSync(MOBILE,{recursive:true});fs.mkdirSync(path.join(MOBILE,'previews'),{recursive:true});
 write(path.join(MOBILE,'catalog.json'),JSON.stringify(catalog,null,2));
 write(path.join(MOBILE,'index.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>串流控制台 v3 · 移动版</title><link rel="stylesheet" href="prototype.css"></head><body><aside class="review-bar" id="review" hidden><strong>原型导航</strong><select id="review-page" aria-label="选择移动原型页面"></select><button id="reset">重置</button></aside><div id="app"></div><div id="toast" class="toast" role="status" hidden></div><script>window.MOBILE_CATALOG=${JSON.stringify(catalog).replace(/</g,'\\u003c')};</script><script src="prototype.js"></script></body></html>`);
 write(path.join(OUT,'index.html'),require('./streaming-console-v3-gallery.cjs')(desktop));
 const mapping='| PC 图 | 窄屏页面 | 处理方式 |\n| --- | --- | --- |\n'+desktop.map(p=>{const id=aliases[p.id]||p.id;return `| ${p.id.slice(0,2)} ${p.title} | [${titleOverrides[id]||pages.find(x=>x.id===id)?.title}](index.html#${id}) | ${aliases[p.id]?'原多手机拼图改为对应的真实单页预览':'布局重新排列，不缩小 PC SVG'} |`;}).join('\n');
 write(path.join(MOBILE,'README.md'),`# 串流控制台 v3 · 窄屏移动原型\n\n[独立移动预览](index.html) · [原 v3 浏览页的移动模式](../index.html?mode=mobile#02-discovery) · [移动版总览](00-overview.png)\n\n## 审核方式\n\n- 推荐打开原 v3 浏览页，选择「移动原型」，切换 320 / 360 / 390 / 430 像素；另外提供 768 像素用于较宽设备对照。\n- 移动页使用实际 HTML / CSS 单列与触控布局，不是对 PC SVG 缩放，也不是原来 23–26 的三手机拼图。\n- 可滚动查看完整页面，底部主要动作与首页快捷入口保持可达。独立预览可在手机浏览器直接打开；PC 上独立页限制在 480 像素内，完整宽度切换请用原浏览页。\n- 共 ${pages.length} 个单页状态，覆盖所有 PC 页面；把播放列表、观看者、预览、监控清单、模板和文档阅读拆成适合手机的独立页。\n- 每页附 [previews/](previews/) 下的 390 像素宽 PNG。长页面的 PNG 会展开全部内容；固定视口、滚动与固定底部动作请在交互浏览页审核。\n- 原型导航条和原 v3 浏览页工具栏属于审核工具，不是产品顶栏。媒体与权限框均为示意，不连接任何设备或申请真实采集权限。\n\n## 可以直接操作的流程\n\n1. 发现 → 创建 → 管理资源 → 导入，切换本机 / 网盘 / 隧道，跨渠道保留候选选择，查看待导入清单后确认。默认示例 5 + 3 = 8；取消选择后按实际确认数量追加。\n2. 已导入列表没有勾选框。可拖动点阵，或用 ↑ / ↓ 排列，也可按名称排序、移除、独立预览。移除不会删除原始文件。\n3. 发起端用页内入口切换播放、播放列表和观看者；接收端区分共享播放与本机静音 / 音量。\n4. 监控四画面使用每格本机控制；九画面通过点选格子，在下方显示可点按的控制。另有放大、监控清单、布局预设与方阵全屏。\n5. 公开转邀请、下线、批量 / 单个踢出分别确认。下线示例保留订阅和方阵位置。\n6. 摄像头 / 屏幕 → 原生授权示意 → LIVE。屏幕共享注明移动浏览器能力限制，不假定所有手机均可发起共享。\n7. 回首页 → 传输记录 / 协同编辑 → 顶栏串流入口恢复。首页草稿、控制台表单、候选选择与资源顺序保留在本次预览内。\n\n## 首页与手势约束\n\n白色全屏控制台位于原三栏之外。底部「连接设备 / 传输记录 / 协同编辑」是收起并跳到原页面的快捷入口，控制台没有占用或新增原三栏的横滑位置。首页顶栏保留原按钮顺序，只显示 v3 已有的串流恢复入口。\n\n本原型使用独立滚动区、触控按钮和点阵拖动范围表现设计边界；它不加载应用原有三栏侧滑代码，因此不能替代实际开发后的手势验收。实际接入仍需按 v3 设计要求隔离浮层与后台滑动、取消未完成手势、恢复原栏位、处理横竖屏和软键盘。\n\n## PC 对照\n\n${mapping}\n\n## 窄屏增加的独立页\n\n${extra.map(([id,title,pcId])=>`- [${title}](index.html#${id})：对应 PC ${pcId.slice(0,2)}。`).join('\n')}\n\n## 源文件\n\n- <code>prototype.css</code>：白色与中性灰视觉、窄屏 / 横屏 / 较宽设备排版。\n- <code>prototype.js</code>：演示页面和本地交互状态，不调用项目接口。\n- <code>catalog.json</code>：PC 与移动页对应关系。\n- <code>../script2gen/streaming-console-v3-mobile-build.cjs</code>：生成目录、原浏览页、说明与 PNG。\n- <code>../script2gen/streaming-console-v3-gallery.cjs</code>：原 v3 浏览页的 PC / 移动模式。\n\n所有产品内容是本地演示。原应用代码、PC SVG / PNG 与原有 <code>info.txt</code> 均不在本次修改范围内。\n`);
 const file=path.join(OUT,'README.md');let readme=fs.readFileSync(file,'utf8');
 const marker='<!-- mobile-review -->';if(!readme.includes(marker))readme=readme.replace('## 布局依据',`${marker}\n## 窄屏移动版审核\n\n原 [浏览页](index.html) 已支持「PC 原型 / 移动原型」切换，并可设置 320 / 360 / 390 / 430 像素视口；也可直接打开 [独立移动版](mobile/index.html)。移动版为完整的响应式单页流程，详见 [移动版说明与 PC 对照](mobile/README.md)，原 23–26 拼图保留作既有图纸。\n\n## 布局依据`);write(file,readme);
 console.log(`Prepared ${pages.length} narrow-screen pages and integrated PC/mobile gallery.`);
}
async function render(){
 const {chromium}=require(path.join(runtime,'playwright'));const sharp=require(path.join(runtime,'sharp'));
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const errors=[];const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 try{
  const url='file:///'+MOBILE.replace(/\\/g,'/')+'/index.html?embedded=1';
  for(let i=0;i<pages.length;i++){
   const s=pages[i],modal=s.id.includes('permission')||['28-private-confirm','30-offline-confirm','40-kick-all','41-kick-one'].includes(s.id);
   await page.goto(url+'&snapshot='+i+(modal?'':'&capture=1')+'#'+s.id);await page.waitForSelector('.app-view');await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(MOBILE,'previews',s.id+'.png'),fullPage:!modal});
   if((i+1)%10===0)console.log(`Rendered ${i+1}/${pages.length} mobile pages.`);
  }
  // 实际窄屏布局检查；不运行应用测试。
  const failures=[];let reviewed=0;
  for(const width of [320,360,390,430,768]){
   await page.setViewportSize({width,height:width===768?1024:844});
   for(const s of pages){await page.goto(url+'&layout='+width+'-'+s.id+'#'+s.id);await page.waitForSelector('.app-view');const info=await page.evaluate(()=>{const app=document.querySelector('.app-view'),content=document.querySelector('.scroll'),dialog=document.querySelector('.modal');return {outer:document.documentElement.scrollWidth>innerWidth,content:content&&content.scrollWidth>content.clientWidth+2,dialog:dialog&&dialog.scrollWidth>dialog.clientWidth+2,app:app?.getBoundingClientRect().width};});if(info.outer||info.content||info.dialog||Math.abs(info.app-width)>1)failures.push({width,id:s.id,info});reviewed++;}
  }
  if(failures.length)throw Error('Layout overflow: '+JSON.stringify(failures));
  console.log(`Reviewed ${reviewed} page/width combinations without horizontal content overflow.`);
  await page.setViewportSize({width:390,height:844});
  let serial=0;async function go(id){await page.goto(url+'&flow='+(serial++)+'#'+id);await page.waitForSelector('.app-view');}
  async function click(selector,id){await page.locator(selector).first().click();if(id)await page.waitForFunction(id=>window.prototypeReview.getRoute()===id,id);}
  await go('05-imported-pool');await click('[data-go="04-source-drive"]','04-source-drive');await page.selectOption('[data-select="source"]','local');await page.waitForFunction(()=>window.prototypeReview.getRoute()==='12-source-local');await page.selectOption('[data-select="source"]','tunnel');await page.waitForFunction(()=>window.prototypeReview.getRoute()==='13-source-tunnel');await click('[data-act="import"]','34-imported-eight');let count=await page.evaluate(()=>window.prototypeReview.getState().pool.length);if(count!==8)throw Error('Expected 5 + 3 = 8, got '+count);
  await go('04-source-drive');await page.locator('[data-candidate="drive:0"]').uncheck();await click('[data-act="import"]','34-imported-eight');count=await page.evaluate(()=>window.prototypeReview.getState().pool.length);if(count!==7)throw Error('Expected 5 + 2 = 7, got '+count);
  await go('05-imported-pool');await click('[data-act="move"][data-value="1:-1"]');let first=await page.evaluate(()=>window.prototypeReview.getState().pool[0].name);if(first!=='城市风光.jpg')throw Error('Up/down sorting failed');
  await go('03-create-edit');await page.fill('[data-form="name"]','保留我的串流台草稿');await click('[data-act="home"]','22-home-background');await click('[data-go="m-home-editor"]','m-home-editor');await page.locator('[data-editor]').fill('保留协同编辑内容');await click('[data-act="restore"]','03-create-edit');if(await page.inputValue('[data-form="name"]')!=='保留我的串流台草稿')throw Error('Console draft lost');await click('[data-go="m-home-editor"]','m-home-editor');if(!(await page.locator('[data-editor]').textContent()).includes('保留协同编辑内容'))throw Error('Home editor draft lost');
  await go('15-screen');await click('[data-go="21-screen-permission"]','21-screen-permission');await click('[data-act="start-live"]','32-live-active');if(await page.locator('#shared-progress').count())throw Error('Live source has file timeline');
  await go('09-access');await click('[data-act="visibility"][data-value="private"]','28-private-confirm');await click('[data-act="confirm-private"]','09-access');if((await page.evaluate(()=>window.prototypeReview.getState().viewers))!==0)throw Error('Confirmation demo state not updated');
  await page.setViewportSize({width:1740,height:1160});await page.goto('file:///'+OUT.replace(/\\/g,'/')+'/index.html?mode=mobile#03-create-edit');const frame=page.frameLocator('#mobile-frame');await frame.locator('[data-form="name"]').waitFor();await page.selectOption('#size','320,720');if(await frame.locator('.app-view').evaluate(el=>el.getBoundingClientRect().width)!==320)throw Error('Integrated viewport size not applied');await page.selectOption('#selector','05-imported-pool');await frame.locator('#resource-list').waitFor();await frame.locator('[data-go="04-source-drive"]').click();await page.waitForFunction(()=>location.hash==='#04-source-drive');await page.locator('#desktop-mode').click();await page.waitForSelector('#stage svg');
  if(errors.length)throw Error('Browser errors: '+errors.join('\n'));
  console.log('Import, deselection counts, sorting, drafts/home restoration, permissions, confirmation and integrated mode switching reviewed.');
  const cols=6,tw=218,th=472,gap=16,cw=cols*(tw+gap)+gap,ch=Math.ceil(pages.length/cols)*(th+48+gap)+86;
  const labels=`<svg width="${cw}" height="${ch}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f3f3f3"/><text x="20" y="40" font-family="Microsoft YaHei" font-size="24" fill="#262626">串流控制台 v3 · 窄屏移动版 ${pages.length} 页</text>${pages.map((s,i)=>{const x=gap+i%cols*(tw+gap),y=80+Math.floor(i/cols)*(th+48+gap)+th+19;const label=s.title.length>16?s.title.slice(0,16)+'…':s.title;return `<text x="${x}" y="${y}" font-family="Microsoft YaHei" font-size="11" fill="#404040">${String(i+1).padStart(2,'0')} ${label}</text>`;}).join('')}</svg>`;
  const composites=[];for(let i=0;i<pages.length;i++)composites.push({input:await sharp(path.join(MOBILE,'previews',pages[i].id+'.png')).resize(tw,th,{fit:'cover',position:'top'}).toBuffer(),left:gap+i%cols*(tw+gap),top:80+Math.floor(i/cols)*(th+48+gap)});
  await sharp(Buffer.from(labels)).composite(composites).png().toFile(path.join(MOBILE,'00-overview.png'));
  write(path.join(MOBILE,'审核记录.md'),`# 移动原型审核记录\n\n- ${pages.length} 个独立页面已输出 390 像素宽 PNG。长页展开为长图，弹层使用固定视口。\n- 320 / 360 / 390 / 430 / 768 五种宽度共 ${reviewed} 组页面布局检查，无横向内容溢出。\n- 已核对跨渠道选择保留、5 + 3 = 8、取消一项后 5 + 2 = 7、上下排序与预览入口。\n- 已核对返回首页与恢复台表单、协同编辑草稿保留。\n- 已核对原生权限示意、LIVE 无文件进度条、转邀请确认。\n- 已核对原浏览页 PC / 移动模式、视口切换及父子页面导航同步。\n- 浏览器未出现页面脚本错误。\n\n这些检查仅针对设计产物和本地演示状态；未运行项目应用测试，未验证真实媒体传输或应用原三栏手势实现。\n`);
  for(const [file,hash]of originalPC)if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==hash)throw Error('Existing PC artifact changed: '+file);
  if(crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT,'info.txt'))).digest('hex')!==originalInfo)throw Error('info.txt changed');
  console.log(`Saved ${pages.length} mobile PNGs, overview and review record to ${MOBILE}; existing PC SVG/PNG and info.txt unchanged.`);
 }finally{await browser.close();}
}
prepare();if(!process.argv.includes('--prepare'))render().catch(e=>{console.error(e);process.exitCode=1;});
