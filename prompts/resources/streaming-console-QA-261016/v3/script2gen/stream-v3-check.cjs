const fs=require('fs'),path=require('path'),vm=require('vm');
const {chromium}=require('C:/Users/Dell/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out='D:/Workspace/github/Ltre/file-tunnel/prompts/resources/streaming-console-QA-261016/v3';let browser;
(async()=>{
 const html=fs.readFileSync(path.join(out,'index.html'),'utf8');
 const data=JSON.parse(html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(script);
 const ids=new Set(data.map(d=>d.id));let links=0;
 for(const d of data){
  if(!fs.existsSync(path.join(out,d.id+'.png')))throw Error('Missing PNG '+d.id);
  if(fs.readFileSync(path.join(out,d.id+'.svg'),'utf8')!==d.svg)throw Error('Gallery and SVG differ '+d.id);
  if(/undefined|NaN/.test(d.svg))throw Error('Invalid value '+d.id);
  for(const m of d.svg.matchAll(/<a href="([^"]+)\.svg"/g)){links++;if(!ids.has(m[1]))throw Error('Broken target '+m[1]+' in '+d.id);}
 }
 console.log('Artifact structure: '+data.length+' SVG/PNG pairs; '+links+' valid state links; gallery JSON and JavaScript parse.');
 if(process.argv.includes('--static'))return;
 const executablePath=fs.existsSync(chromium.executablePath())?chromium.executablePath():'C:/Program Files/Google/Chrome/Application/chrome.exe';
 browser=await chromium.launch({headless:true,executablePath});
 const page=await browser.newPage({viewport:{width:1740,height:1160},deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('file:///'+out+'/index.html');await page.waitForSelector('#stage svg');
 async function choose(id){await page.selectOption('#selector',id);await page.waitForFunction(id=>location.hash==='#'+id,id);}
 async function click(label,to){await page.locator('#stage a').filter({has:page.locator('rect')}).evaluateAll(()=>{});await page.locator('#stage a[aria-label="'+label+'"]').first().click();await page.waitForFunction(id=>location.hash==='#'+id,to);}
 for(const d of data){await choose(d.id);await page.waitForFunction(title=>document.querySelector('#stage svg title')?.textContent===title,d.title);}
 await choose('01-home-entry');await click('串流控制台','02-discovery');await click('＋ 创建串流台','03-create-edit');await click('管理与排序','05-imported-pool');await click('＋ 导入可视资源','04-source-drive');await click('本机文件','12-source-local');await click('隧道记录','13-source-tunnel');await click('确认导入 3 项','34-imported-eight');await click('完成，返回创建页（8 项）','35-create-after-import');
 await choose('05-imported-pool');await click('将当前项移到首位','29-sorted-pool');await click('← 返回首页','22-home-background');await click('恢复串流控制台','02-discovery');
 await choose('14-camera');await click('授权并开始采集','20-camera-permission');await click('允许','32-live-active');
 await choose('15-screen');await click('选择屏幕并开始共享','21-screen-permission');await click('共享','32-live-active');
 await choose('36-receiver-live');await click('进入媒体全屏','38-live-fullscreen');await click('退出全屏 / Esc','36-receiver-live');
 await choose('08-monitor-wall');await click('布局预设','37-monitor-presets');await page.locator('#stage a[aria-label="加载此布局"]').last().click();await page.waitForFunction(()=>location.hash==='#18-monitor-nine');await click('媒体全屏','39-monitor-fullscreen');await click('退出全屏 / Esc','08-monitor-wall');
 if(errors.length)throw Error(errors.join('\n'));
 await page.screenshot({path:path.join(process.env.TEMP,'stream-v3-gallery-desktop.png')});
 await page.setViewportSize({width:390,height:844});await choose('25-mobile-import');if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Gallery overflows narrow viewport');await page.screenshot({path:path.join(process.env.TEMP,'stream-v3-gallery-narrow.png')});
 console.log('Offline gallery: all '+data.length+' states render, core import/sort/home/permission/live/monitor paths work, no page errors, narrow browser frame fits.');
 await browser.close();
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
