'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
// Keep the real HTML, parser-written resource list and startup observer. Isolate
// business scripts/storage/network so this never connects to a real tunnel.
const html=fs.readFileSync(path.join(__dirname,'../pages/index.html'),'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi,(block,attributes,body)=>/\bsrc=/.test(attributes)||/function (startupLoadingObserver|loadVersionedClientScripts)\(/.test(body)?block:'');
let browser;
before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true});});
after(async()=>{await browser?.close();});
async function pageFor(userAgent,query=''){
    const page=await browser.newPage({userAgent});
    await page.route('http://startup.test/**',route=>{const url=new URL(route.request().url());return route.fulfill({contentType:url.pathname==='/'?'text/html':url.pathname.endsWith('.css')?'text/css':'application/javascript',body:url.pathname==='/'?html:''});});
    await page.goto('http://startup.test/'+query);await page.waitForFunction(()=>document.querySelector('[data-startup-count]').textContent==='资源已加载 61 / 61');
    return page;
}
for(const [name,userAgent]of [
    ['desktop','Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36'],
    ['Android 10','Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/142.0.0.0 Mobile Safari/537.36'],
    ['Android 14','Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/142.0.0.0 Mobile Safari/537.36']
])test(name+' receives the same 47 defer scripts and 14 styles, including a cache-busting reload',async()=>{
    const page=await pageFor(userAgent,'?_reload=fresh');try{
        const result=await page.evaluate(()=>({scripts:document.querySelectorAll('script[defer][src]').length,styles:document.querySelectorAll('link[rel="stylesheet"][href]').length,failed:document.querySelector('[data-startup-warning]').textContent}));
        assert.deepEqual(result,{scripts:47,styles:14,failed:''});
    }finally{await page.close();}
});
test('the total counts distinct discovered URLs: an extra style makes 62, failures do not reduce it, and removal does not erase history',async()=>{
    const page=await pageFor();try{
        await page.evaluate(()=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/extra-desktop-style.css';document.head.append(link);});
        await page.waitForFunction(()=>document.querySelector('[data-startup-count]').textContent==='资源已加载 62 / 62');
        await page.evaluate(()=>{const original=document.querySelector('link[href="/extra-desktop-style.css"]');document.head.append(original.cloneNode());});
        await page.waitForTimeout(240);assert.equal(await page.locator('[data-startup-count]').textContent(),'资源已加载 62 / 62');
        await page.evaluate(()=>{const node=document.querySelector('script[defer][src]');node.dispatchEvent(new Event('error'));document.querySelectorAll('link[href="/extra-desktop-style.css"]').forEach(n=>n.remove());});
        await page.waitForFunction(()=>document.querySelector('[data-startup-count]').textContent==='资源已加载 61 / 62');
        assert.match(await page.locator('[data-startup-warning]').textContent(),/1 个资源加载失败/);
        await page.evaluate(()=>{const link=document.querySelector('link[rel="stylesheet"]');link.href+='?replacement=1';});
        await page.waitForFunction(()=>document.querySelector('[data-startup-count]').textContent==='资源已加载 62 / 63');
    }finally{await page.close();}
});
