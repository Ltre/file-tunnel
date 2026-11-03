'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {buildPostMarkdown}=require('../server/sns-post-markdown');
const body=buildPostMarkdown({source:{sourceUrl:'https://x.com/original_user/status/2117114477615190025'},metadata:{title:'Original post',body:'Body with a photo',author:'Original author < &',authorHandle:'original_user'},
    avatar:{sessionId:'tunnel',messageId:'author-record',file:{id:'avatar',name:'Avatar',type:'image/png'}},media:[{sessionId:'tunnel',messageId:'photo-record',file:{id:'photo',name:'Photo',type:'image/png'}}]});
let browser,server,base;
before(async()=>{
    const app=express();app.get('/case',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/streaming-console.css">
    <script src="/client/vendor/web-markdown/marked-18.0.14.umd.js"></script><script src="/client/vendor/web-markdown/purify-3.4.16.min.js"></script><script src="/client/folder-archive.js"></script><script src="/client/tunnel-markdown.js"></script><main id="inline"></main><script>
    window.message={id:'post',type:'markdown',markdown:${JSON.stringify(body)}};window.revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{revoked.push(url);revoke(url)};
    const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
    TunnelMarkdown.init({readReference:async()=>new Blob([png],{type:'image/png'}),referenceName:()=> 'image.png'});
    TunnelMarkdown.mount(document.getElementById('inline'),message);
    </script>`));app.use(express.static(path.resolve(__dirname,'..')));server=await require('./support/listen-http.cjs').listenHttp(app);base='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({channel:'chrome',headless:true});
});
after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}});
for(const width of [390,1280])test('author avatar is 28px to the left of its account link in inline and dialog Markdown at '+width+'px',async t=>{
    const page=await browser.newPage({viewport:{width,height:850}}),errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[]);});await page.goto(base+'/case');
    async function check(selector){
        await page.waitForFunction(selector=>{const image=document.querySelector(selector+' .sns-post-avatar');return image&&image.naturalWidth>0&&!image.hidden;},selector);
        const img=page.locator(selector+' .sns-post-avatar'),link=page.locator(selector+' .sns-post-author a'),picture=await img.boundingBox(),text=await link.boundingBox();
        assert.equal(picture.width,28);assert.equal(picture.height,28);assert.ok(picture.x+picture.width<=text.x);assert.ok(Math.abs((picture.y+14)-(text.y+text.height/2))<1);
        assert.match(await link.textContent(),/Original author < & @original_user/);assert.equal(await link.getAttribute('href'),'https://x.com/original_user');assert.match(await img.getAttribute('src'),/^blob:/);
    }
    await check('#inline');await page.evaluate(()=>{window.reader=TunnelMarkdown.preview(message);});await check('.sc-markdown-reader');
    await page.getByRole('button',{name:'关闭',exact:true}).click();await page.evaluate(()=>reader);assert.equal(await page.locator('.sc-markdown-reader').count(),0);
    assert.equal(await page.locator('#inline .sns-post-avatar').isVisible(),true,'closing preview must retain the inline avatar lease');
    const archive=await page.evaluate(async()=>{const file=await TunnelMarkdown.archive(message),entries=await FolderArchive.extractZip(file);return{type:file.type,size:file.size,entries:entries.map(entry=>entry.path),markdown:new TextDecoder().decode(entries.find(entry=>entry.path==='message.md').data)};});
    assert.equal(archive.type,'application/zip');assert.ok(archive.size>0);assert.equal(archive.entries.length,3);assert.doesNotMatch(archive.markdown,/tunnel-blob:/);assert.match(archive.markdown,/<img[^>]+src="resources\//);
});
