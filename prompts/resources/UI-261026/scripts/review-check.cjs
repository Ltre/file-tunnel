const fs=require('node:fs'),path=require('node:path');
const base=path.resolve(__dirname,'..');process.env.TEMP=path.join(base,'_runtime');process.env.TMP=process.env.TEMP;
const {chromium}=require('C:/Users/Dell/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const {pathToFileURL}=require('node:url');
async function run(){const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu','--no-first-run']});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));try{
 await page.goto(pathToFileURL(path.join(base,'index.html')).href);await page.locator('.direction').first().waitFor();
 await page.screenshot({path:path.join(base,'gallery-preview.png')});
 await page.getByRole('button',{name:'ORBIT',exact:true}).click();await page.selectOption('#screen','home-details-sns');
 await page.getByRole('button',{name:'手机 390',exact:true}).click();await page.waitForTimeout(250);
 const missing=await page.locator('img').evaluateAll(nodes=>nodes.filter(i=>!i.loading||i.loading!=='lazy').filter(i=>i.complete&&!i.naturalWidth).map(i=>i.src));
 await page.goto(pathToFileURL(path.join(base,'prototype.html')).href+'?variant=orbit&screen=disk-menu&size=mobile');await page.waitForTimeout(250);
 const frame=page.frames().find(f=>f.url().includes('/snapshots/'));if(!frame)throw Error('Missing preview iframe');
 const menu=await frame.locator('#telegramDriveItemMenu').evaluate(el=>{const r=el.getBoundingClientRect();return {visible:getComputedStyle(el).visibility==='visible',rect:[r.x,r.y,r.width,r.height],viewport:[innerWidth,innerHeight]};});
 await page.getByRole('button',{name:'原版对照',exact:true}).click();await page.waitForTimeout(100);
 const source=page.frames().find(f=>f.url().includes('/snapshots/'));const originalUnthemed=await source.evaluate(()=>!document.documentElement.hasAttribute('data-skin'));
 const manifest=JSON.parse(fs.readFileSync(path.join(base,'screens.json'),'utf8')),missingFiles=[];
 for(const variant of manifest.themes)for(const [size,names]of [['desktop',Object.keys(manifest.screenNames)],['mobile',manifest.mobileScreens]])for(const name of names){const file=path.join(base,variant,size,name+'.png');if(!fs.existsSync(file))missingFiles.push(file);}
 const report={checkedAt:new Date().toISOString(),errors,missingImages:missing,missingFiles,mobileMenu:menu,originalUnthemed};fs.writeFileSync(path.join(base,'gallery-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await browser.close();}}
run().catch(e=>{console.error(e);process.exit(1);});
