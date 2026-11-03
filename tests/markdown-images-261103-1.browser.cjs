'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
let browser,server,base;
before(async()=>{
    const app=express();app.get('/case',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/client/streaming-console.css">
    <script src="/client/vendor/web-markdown/marked-18.0.14.umd.js"></script><script src="/client/vendor/web-markdown/purify-3.4.16.min.js"></script><script src="/client/tunnel-markdown.js"></script><main id="inline"></main><script>
    window.releases=[];window.fail=false;window.revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{revoked.push(url);revoke(url)};
    const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
    window.message={id:'post',type:'markdown',markdown:'# Text\\n\\n'+[1,2,3,4].map(i=>'![Photo '+i+'](tunnel-blob:tunnel/record/image-'+i+')').join('\\n\\n')};
    TunnelMarkdown.init({readReference:async()=>{await new Promise(resolve=>releases.push(resolve));if(fail)throw Error('fixture-unavailable');return new Blob([png],{type:'image/png'})}});
    window.release=async()=>{for(let i=0;i<6;i++){releases.splice(0).forEach(resolve=>resolve());await new Promise(resolve=>setTimeout(resolve,5));}};
    </script>`));app.use(express.static(path.resolve(__dirname,'..')));
    server=await require('./support/listen-http.cjs').listenHttp(app);base='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({channel:'chrome',headless:true});
});
after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
async function pageFor(t){const page=await browser.newPage();t.after(()=>page.close());await page.goto(base+'/case');return page;}
test('inline Markdown shows four loading placeholders, never four broken images, before references arrive',async t=>{
    const page=await pageFor(t);await page.evaluate(()=>TunnelMarkdown.mount(document.getElementById('inline'),message));
    assert.equal(await page.getByText('图片载入中...', {exact:true}).count(),4);
    assert.equal(await page.locator('#inline img:visible').count(),0);
    await page.evaluate(()=>release());await page.waitForFunction(()=>[...document.querySelectorAll('#inline img')].length===4&&[...document.querySelectorAll('#inline img')].every(img=>img.naturalWidth>0&&!img.hidden));
    assert.equal(await page.getByText('图片载入中...', {exact:true}).count(),0);
});
test('the Markdown dialog keeps per-image loading placeholders while media is pending',async t=>{
    const page=await pageFor(t);await page.evaluate(()=>{window.reader=TunnelMarkdown.preview(message)});
    assert.equal(await page.locator('.sc-markdown-reader').getByText('图片载入中...', {exact:true}).count(),4);
    assert.equal(await page.locator('.sc-markdown-reader img:visible').count(),0);
    await page.getByRole('button',{name:'关闭',exact:true}).click();await page.evaluate(async()=>{await release();await reader});
    assert.equal(await page.locator('.sc-markdown-reader').count(),0);
    assert.equal(await page.evaluate(()=>revoked.length),4);
});
