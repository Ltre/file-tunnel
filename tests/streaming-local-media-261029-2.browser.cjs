'use strict';
// Real console, file input, image decoder and player; all server data is temporary.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const { createFixture } = require('./support/streaming-console-fixture.cjs');
async function run() {
    const f = await createFixture(); let browser;
    try {
        const device = 'local-image-owner', secret = device.repeat(3), actor = { deviceId: device, userId: null, logins: [] };
        f.streaming.service.register(device, secret, 'Local image fixture');
        const station = f.streaming.service.create(actor, { name: '本机图片回归', creationId: 'local-image-261029-2' });
        f.app.get('/local-image-check', (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
          <link rel="stylesheet" href="/client/streaming-console.css"><link rel="stylesheet" href="/client/themes.css">
          <script src="/client/streaming-player.js"></script><script src="/client/streaming-console.js"></script><body data-theme="lumen"><script>
          window.showOpenFilePicker=undefined;
          localStorage.setItem('streaming:${device}:key',${JSON.stringify(secret)});
          localStorage.setItem('streaming:${device}:ui',JSON.stringify({view:'edit',stationId:${JSON.stringify(station.id)},scroll:{},drafts:{}}));
          localStorage.setItem('streaming:${device}:station:${station.id}',JSON.stringify({name:'本机图片回归',configVersion:1,items:[],loop:true,countdown:'bottom-right'}));
          StreamingConsole.init({deviceId:()=>${JSON.stringify(device)},deviceName:()=> 'Local image fixture',devices:()=>[],tunnels:async()=>[],toast:()=>{},home:()=>{}});StreamingConsole.open();
          </script>`));
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
        await page.addInitScript(()=>{window.fixtureLiveUrls=new Set();const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);window.fixtureLiveUrls.add(url);return url;};URL.revokeObjectURL=url=>{window.fixtureLiveUrls.delete(url);revoke(url);};});
        if (process.argv.includes('--baseline')) {
            const {execFileSync}=require('node:child_process');
            for(const file of ['client/streaming-console.js','client/streaming-player.js','client/streaming-console.css']) {
                const body=execFileSync('git',['show','HEAD:'+file],{encoding:'utf8'});
                await page.route('**/'+file,route=>route.fulfill({body,contentType:file.endsWith('.css')?'text/css':'application/javascript'}));
            }
        }
        const calls = [], results = [];
        const check = (name, ok, evidence) => { results.push({name,ok,evidence:structuredClone(evidence)}); console.log(ok?'PASS':'FAIL',name,JSON.stringify(evidence)); };
        page.on('request', req => { if (/\/api\/streaming\/(preview|media\/|peers\/)/.test(req.url())) calls.push(req.url().replace(f.base, '')); });
        // A creator must not have to upload its selected picture to itself.
        await page.route('**/api/streaming/provider-work/**', route => route.abort());
        await page.goto(f.base + '/local-image-check'); await page.getByLabel('上传封面').waitFor();
        const jpeg = await page.evaluate(() => { const c=document.createElement('canvas');c.width=96;c.height=72;const x=c.getContext('2d');x.fillStyle='#9365d8';x.fillRect(0,0,96,72);return c.toDataURL('image/jpeg').split(',')[1]; });
        const files = [0,1,2].map(i=>({name:'本机图'+i+'.jpg',mimeType:'image/jpeg',buffer:i===2?Buffer.concat([Buffer.from(jpeg,'base64'),Buffer.alloc(600000)]):Buffer.from(jpeg,'base64')}));
        // Controlled HTML-decoder failure only. This verifies the independent
        // real bitmap/canvas path; it does not identify Android's native cause.
        await page.evaluate(()=>{window.fixtureImage=window.Image;window.Image=function(){const image=new window.fixtureImage();Object.defineProperty(image,'src',{set(){queueMicrotask(()=>image.onerror?.());}});return image;};});
        for(let i=0;i<3;i++) {
            await page.getByLabel('上传封面').setInputFiles(files[0]);
            await page.waitForFunction(()=>/封面已裁剪|封面处理失败/.test(document.querySelector('.sc-cover-field [role=status]').textContent));
            check('real JPEG crop survives HTML decoder failure '+i,(await page.locator('.sc-cover-field [role=status]').textContent()).includes('封面已裁剪'));
        }
        await page.evaluate(()=>{window.Image=window.fixtureImage;delete window.fixtureImage;});
        await page.getByRole('button',{name:'导入',exact:true}).click();
        const chooser = page.waitForEvent('filechooser'); await page.getByRole('button',{name:'选择本机文件',exact:true}).click(); await (await chooser).setFiles(files);
        await page.locator('.sc-candidate').first().waitFor(); await page.waitForTimeout(900);
        const thumbnails = await page.locator('.sc-source-thumbnail').evaluateAll(nodes=>nodes.map(n=>{const i=n.querySelector('img');return {loaded:!!i?.naturalWidth,width:n.clientWidth,src:i?.getAttribute('src')};}));
        check('selected local image thumbnails decode without remote supplier', thumbnails.length===3&&thumbnails.every(v=>v.loaded), thumbnails);
        check('image thumbnail cells retain compact geometry',thumbnails.every(v=>v.width===64),thumbnails.map(v=>v.width));
        check('local import does not request remote preview tickets',calls.length===0,calls);
        const output=path.resolve('.npm-cache/streaming-local-media-261029-2');fs.mkdirSync(output,{recursive:true});
        await page.screenshot({path:path.join(output,'import-lumen'+(process.argv.includes('--baseline')?'-baseline':'')+'.png')});
        await page.locator('.sc-candidate').first().getByRole('button',{name:'预览',exact:true}).click(); await page.waitForTimeout(500);
        check('local image preview is immediately decoded',await page.locator('.sc-preview img').evaluateAll(nodes=>nodes.some(n=>n.naturalWidth>0)));
        const previewUrl=await page.locator('.sc-preview img').getAttribute('src');
        await page.locator('.sc-dialog').getByRole('button',{name:'关闭',exact:true}).click();
        check('closing the local preview releases its object URL',await page.evaluate(url=>!window.fixtureLiveUrls.has(url),previewUrl));
        await page.locator('.sc-import-actions').getByRole('button',{name:'导入',exact:true}).click(); await page.locator('.sc-editor-page').waitFor();
        check('leaving import releases all thumbnail object URLs',await page.evaluate(urls=>urls.every(url=>!window.fixtureLiveUrls.has(url)),thumbnails.map(v=>v.src)));
        await page.getByRole('button',{name:'保存',exact:true}).click(); await page.getByRole('button',{name:'上线',exact:true}).click();
        await page.getByRole('button',{name:'公开',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='邀请与可见性');
        await page.evaluate(()=>window.dispatchEvent(new PopStateEvent('popstate')));
        await page.locator('.sc-player').waitFor(); await page.waitForTimeout(700);
        const loaded = await page.locator('.sc-media>img').evaluateAll(nodes=>nodes.some(n=>n.naturalWidth>0&&n.src.startsWith('blob:')));
        check('creator plays its own local image without supplier roundtrip',loaded);
        check('authorized playback avoids remote body/peer paths',calls.every(url=>!url.includes('/media/')&&!url.includes('/peers/')),calls);
        for(const item of f.streaming.service.station(station.id).items.slice(1)) {
            const began=Date.now();f.streaming.service.control(station.id,actor,{action:'select',itemId:item.id,version:f.streaming.service.station(station.id).playback.version});
            try {
                await page.waitForFunction(name=>document.querySelector('.sc-media>img')?.alt===name&&document.querySelector('.sc-media>img')?.naturalWidth>0,item.name,{timeout:1500});
                check('local program '+item.name+' switches without supplier buffering',true,{ms:Date.now()-began});
            } catch(_){check('local program '+item.name+' switches without supplier buffering',false);}
        }
        // Updating the server without a matching local saved configuration
        // must use the established remote path rather than a stale local file.
        const remoteRead=page.waitForRequest(req=>req.url().includes('/api/streaming/media/'));
        const latest=f.streaming.service.station(station.id);
        await f.streaming.service.edit(station.id,actor,{configVersion:latest.configVersion,name:latest.name,loop:true,items:latest.items.map(item=>({...item,source:undefined}))});
        try {await remoteRead;check('stale local configuration falls back to the authorized media route',true);} catch(_){check('stale local configuration falls back to the authorized media route',false);}
        fs.writeFileSync(path.join(output,'report'+(process.argv.includes('--baseline')?'-baseline':'')+'.json'),JSON.stringify(results,null,2));
        assert.equal(results.filter(r=>!r.ok).length,0,JSON.stringify(results.filter(r=>!r.ok)));
    } finally { await browser?.close(); await f.close(); }
}
run().catch(cause=>{console.error(cause);process.exitCode=1;});
