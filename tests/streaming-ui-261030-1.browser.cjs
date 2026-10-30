'use strict';
// Isolated real-console regression for selected resources, natural playlist
// endpoints and miniature-player input. No production data or credentials.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium } = require(process.argv[2] || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const { createFixture } = require('./support/streaming-console-fixture.cjs');
let f, browser, station, actor;
const output = path.resolve('.npm-cache/streaming-ui-261030-1');
before(async () => {
    fs.mkdirSync(output, { recursive: true }); f = await createFixture();
    actor = { deviceId: 'ui-261030-source', userId: null, logins: [] };
    const secret = actor.deviceId.repeat(3); f.streaming.service.register(actor.deviceId, secret, 'UI隔离设备');
    station = f.streaming.service.create(actor, { name: 'UI回归台', creationId: 'ui-261030' });
    await f.streaming.service.edit(station.id, actor, { configVersion: 1, loop: true, items: Array.from({ length: 24 }, (_, i) => ({ id: 'program-' + i, stay: 120, source: { kind: 'tunnel', sessionId: 'fixture-tunnel', messageId: 'image-record', fileId: 'image-asset', accessGrant: 'fixture-proof' } })) });
    f.streaming.service.visibility(station.id, actor, { visibility: 'public', version: f.streaming.service.station(station.id).playback.version });
    f.app.get('/ui-261030', (req, res) => {
        f.sessions.set(req, res, f.auth.user('alice')); const current = f.streaming.service.station(station.id);
        res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/streaming-console.css"><link rel="stylesheet" href="/client/themes.css"><script src="/client/disk-client.js"></script><script src="/client/streaming-player.js"></script><script src="/client/streaming-console.js"></script><body data-theme="${req.query.theme === 'orbit' ? 'orbit' : 'lumen'}"><script>
        window.showOpenFilePicker=undefined;
        localStorage.setItem('streaming:${actor.deviceId}:key',${JSON.stringify(secret)});
        localStorage.setItem('streaming:${actor.deviceId}:station:${station.id}',JSON.stringify(${JSON.stringify({ name: current.name, configVersion: current.configVersion, items: current.items, loop: true, countdown: 'bottom-right' })}));
        localStorage.setItem('streaming:${actor.deviceId}:ui',JSON.stringify({view:${JSON.stringify(req.query.view || 'import')},stationId:${JSON.stringify(station.id)},scroll:{},drafts:{},importState:{channel:'disk',pending:[],diskScope:{accountId:'alice',diskSpace:'',path:'',mountId:''}}}));
        StreamingConsole.init({deviceId:()=>${JSON.stringify(actor.deviceId)},deviceName:()=> 'UI隔离设备',devices:()=>[],tunnels:async()=>[{sessionId:'fixture-tunnel',accessGrant:'fixture-proof',name:'隔离隧道'}],toast:()=>{},home:()=>{}});StreamingConsole.open();</script>`);
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); await f?.close(); });

test('selected resources have disposable thumbnails and removal only changes the pending selection', async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    try {
        await page.addInitScript(() => { window.thumbnailUrls=new Set();const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);thumbnailUrls.add(url);return url;};URL.revokeObjectURL=url=>{thumbnailUrls.delete(url);return revoke(url);}; });
        await page.goto(f.base + '/ui-261030'); await page.locator('.sc-candidate').first().waitFor();
        await page.locator('.sc-candidate').filter({ hasText: '网盘图片.png' }).locator('input').check();
        await page.getByRole('button', { name: '隧道文件', exact: true }).click();
        await page.locator('.sc-candidate').filter({ hasText: '隧道图片.png' }).locator('input').check();
        await page.getByRole('button', { name: '本机文件', exact: true }).click();
        const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '选择本机文件', exact: true }).click();
        await (await chooser).setFiles({ name: '本机图片.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVioAAAAASUVORK5CYII=', 'base64') });
        await page.waitForFunction(()=>document.querySelector('.sc-candidate img')?.naturalWidth>0);
        const beforeSelected=await page.evaluate(()=>thumbnailUrls.size);
        await page.getByRole('button', { name: '已选 · 3', exact: true }).click();
        const overlay = page.locator('.sc-selected-overlay');
        for (const label of ['本机文件', '网盘文件', '隧道文件']) {
            await overlay.getByRole('button', { name: label, exact: true }).click();
            try { await page.waitForFunction(() => { const image=document.querySelector('.sc-selected-row img'); return image?.complete && image.naturalWidth > 0; },null,{timeout:4000}); }
            catch(cause){await page.screenshot({path:path.join(output,'selected-failure.png')});throw new Error(label+': '+await overlay.innerHTML(),{cause});}
            assert.equal(await overlay.locator('.sc-selected-row').count(), 1);
            assert.equal(await overlay.getByRole('button', { name: '删除', exact: true }).count(), 1);
        }
        await page.screenshot({path:path.join(output,'selected-files.png')});
        await overlay.getByRole('button', { name: '删除', exact: true }).click();
        assert.equal(await overlay.locator('.sc-selected-row').count(), 0);
        await overlay.getByRole('button', { name: '收起', exact: true }).click();
        assert.equal(await page.evaluate(()=>thumbnailUrls.size),beforeSelected,'closing and changing categories release selected-preview blob URLs');
        assert.equal(await page.getByRole('button', { name: '已选 · 2', exact: true }).count(), 1);
        await page.getByRole('button', { name: '隧道文件', exact: true }).click();
        assert.equal(await page.locator('.sc-candidate').filter({hasText:'隧道图片.png'}).locator('input').isChecked(), false);
        assert.ok(f.records.some(record => record.id === 'image-record'), 'the source record is retained');
        for (const width of [1024, 390, 320]) {
            await page.setViewportSize({width,height:768}); await page.getByRole('button',{name:'网盘文件',exact:true}).click();
            const boxes=await page.locator('.sc-source-controls').evaluate(el => [...el.querySelectorAll('select')].map(node => node.getBoundingClientRect().toJSON()));
            assert.equal(boxes.length,2); assert.ok(Math.abs(boxes[0].top-boxes[1].top)<2 && boxes[0].right<=boxes[1].left,JSON.stringify({width,boxes}));
        }
        await page.screenshot({path:path.join(output,'import-narrow.png')});
    } finally { await page.close(); }
});

test('desktop playlist has natural endpoints and follows middle/current items', async () => {
    const page = await browser.newPage({ viewport:{width:1366,height:768} });
    try {
        await page.goto(f.base+'/ui-261030?view=watch'); await page.locator('.sc-now-playing').waitFor();
        for(const index of [12,23,0]) {
            f.streaming.service.control(station.id, actor, { action:'select', itemId:'program-'+index, version:f.streaming.service.station(station.id).playback.version });
            await page.waitForFunction(i => document.querySelector('.sc-now-playing')?.dataset.itemId==='program-'+i,index); await page.waitForTimeout(650);
            const g=await page.locator('.sc-watch-grid>aside').evaluate(list => {
                const rows=[...list.querySelectorAll('.sc-watch-item')],box=list.getBoundingClientRect(),clip=document.querySelector('.sc-main').getBoundingClientRect();
                const first=rows[0].getBoundingClientRect(),last=rows.at(-1).getBoundingClientRect(),r=list.querySelector('.sc-now-playing').getBoundingClientRect();
                const top=Math.max(box.top+list.clientTop,clip.top,0),bottom=Math.min(box.top+list.clientTop+list.clientHeight,clip.bottom,innerHeight);
                return {startGap:first.top-list.querySelector('h2').getBoundingClientRect().bottom,endGap:list.scrollHeight-(last.bottom-box.top+list.scrollTop),delta:r.top+r.height/2-(top+bottom)/2,visible:r.top>=top-1&&r.bottom<=bottom+1,scroll:list.scrollTop,max:list.scrollHeight-list.clientHeight,spacers:list.querySelectorAll('.sc-playlist-space').length};
            });
            assert.ok(g.startGap<35 && g.endGap<35 && g.spacers===0,JSON.stringify({index,...g}));
            assert.equal(g.visible,true,JSON.stringify({index,...g}));
            if(index===12)assert.ok(Math.abs(g.delta)<5,JSON.stringify(g));
            if(index===23)assert.ok(Math.abs(g.scroll-g.max)<3,JSON.stringify(g));
            if(index===0)assert.ok(g.scroll<3,JSON.stringify(g));
        }
        await page.screenshot({path:path.join(output,'playlist-wide.png')});
    } finally { await page.close(); }
});

test('miniature double clicks cycle three proportional sizes, pinch resizes, drag and restore remain usable', async () => {
    const page=await browser.newPage({viewport:{width:1366,height:900}});
    try {
        await page.goto(f.base+'/ui-261030?view=watch'); await page.locator('.sc-now-playing').waitFor();
        await page.getByRole('button',{name:'小窗播',exact:true}).click(); const mini=page.locator('.sc-mini-window');
        const widths=[];
        for(let i=0;i<4;i++) {
            const box=await mini.boundingBox(); widths.push(Math.round(box.width)); assert.ok(box.height<=450+1 && Math.abs(box.width/box.height-16/9)<.02,JSON.stringify(box));
            if(i<3)await mini.dblclick({position:{x:80,y:45}});
        }
        assert.equal(new Set(widths.slice(0,3)).size,3,JSON.stringify(widths)); assert.equal(widths[0],widths[3]);
        const before=await mini.boundingBox();
        await mini.evaluate(node=>{const r=node.getBoundingClientRect(),send=(type,id,x,y)=>node.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerType:'touch',pointerId:id,isPrimary:id===31,button:0,clientX:x,clientY:y}));
            window.miniPointer=send;send('pointerdown',31,r.left+80,r.top+45);send('pointerdown',32,r.left+160,r.top+45);send('pointermove',32,r.left+220,r.top+45);send('pointerup',32,r.left+220,r.top+45);send('pointerup',31,r.left+80,r.top+45);});
        const grown=await mini.boundingBox(); assert.ok(grown.width>before.width && grown.height<=451,JSON.stringify({before,grown}));
        await page.waitForTimeout(380);
        const start=await mini.boundingBox();await page.mouse.move(start.x+70,start.y+45);await page.mouse.down();await page.mouse.move(start.x+15,start.y+20,{steps:3});await page.mouse.up();
        assert.ok((await mini.boundingBox()).x<start.x);
        await page.setViewportSize({width:390,height:600}); await page.waitForTimeout(100);
        const small=await mini.boundingBox();assert.ok(small.height<=301&&small.width<=390&&small.x>=0&&small.y>=0,JSON.stringify(small));
        await mini.click({position:{x:80,y:45}});await page.locator('#streamingConsole').waitFor({state:'visible'});
    } finally {await page.close();}
});

test('theme fixes use live record and collection selectors, without changing the other theme rich bubble',async()=>{
    const page=await browser.newPage();
    try{
        await page.goto(f.base+'/ui-261030'); await page.locator('#streamingConsole').waitFor();
        await page.evaluate(()=>{document.querySelector('#streamingConsole').hidden=true;const host=document.createElement('div');host.id='appShell';host.innerHTML='<div class="message"><div class="rich-preview">富文本</div><div class="message-bubble file-message"><div class="file-name media-file-name">文件名.mp4</div></div></div><div class="file-preview-content collection-stage"><div class="collection-file-grid"></div></div>';document.body.append(host);});
        const rich=await page.locator('.rich-preview').evaluate(el=>({edge:getComputedStyle(el).borderLeftColor,bg:getComputedStyle(el).backgroundColor}));
        assert.notEqual(rich.edge,'rgba(0, 0, 0, 0)');assert.equal(rich.bg,'rgb(255, 255, 255)');
        await page.evaluate(()=>document.body.dataset.theme='orbit');
        const orbit=await page.evaluate(()=>({name:getComputedStyle(document.querySelector('.file-name')).color,grid:getComputedStyle(document.querySelector('.collection-file-grid')).backgroundColor,stage:getComputedStyle(document.querySelector('.collection-stage')).backgroundColor}));
        assert.equal(orbit.name,'rgb(232, 235, 250)');assert.equal(orbit.grid,'rgb(26, 31, 45)');assert.equal(orbit.stage,'rgb(26, 31, 45)');
        await page.screenshot({path:path.join(output,'theme-orbit.png')});
    }finally{await page.close();}
});
