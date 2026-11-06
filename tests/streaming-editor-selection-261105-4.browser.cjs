'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),os=require('node:os'),path=require('node:path');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('./support/streaming-console-fixture.cjs');
async function setup(t,width=1280,{withoutMembership=false}={}) {
    const f=await createFixture();t.after(()=>f.close());
    const actor={deviceId:'editor-selection',userId:null,logins:[]},secret=actor.deviceId.repeat(3);
    f.streaming.service.register(actor.deviceId,secret,'Editor selection');
    const station=f.streaming.service.create(actor,{name:'Editor selection',creationId:'selection'});
    const items=['a','b','c','d'].map(id=>({id,stay:10,source:{kind:'tunnel',sessionId:'fixture-tunnel',messageId:'text-record',fileId:'record',accessGrant:'fixture-proof'}}));
    await f.streaming.service.edit(station.id,actor,{configVersion:1,items});
    const saved=f.streaming.service.station(station.id);
    if (withoutMembership) { const describe=f.sources.describe;f.sources.describe=source=>({...describe(source),shortCode:'54321'}); }
    const tunnels=[{sessionId:'other-tunnel',shortCode:'11111',name:'11111',accessGrant:'not-used'},
        ...(!withoutMembership?[{sessionId:'fixture-tunnel',shortCode:'66666',name:'66666',accessGrant:'fixture-proof'}]:[])];
    const initial={name:saved.name,configVersion:saved.configVersion,loop:true,countdown:'bottom-right',items:saved.items.map(item=>({...item,source:{kind:'tunnel',sessionId:'fixture-tunnel',messageId:'text-record',fileId:'record'},sourceSaved:true}))};
    f.app.get('/editor-selection',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8">
      <link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/themes.css"><link rel="stylesheet" href="/client/themes-blamen.css"><link rel="stylesheet" href="/client/themes-lusns.css"><link rel="stylesheet" href="/client/streaming-console.css">
      <script src="/client/streaming-console.js"></script><script>
      window.DiskClient={getAccount:()=>''};localStorage.setItem('streaming:${actor.deviceId}:key',${JSON.stringify(secret)});
      if(!localStorage.getItem('streaming:${actor.deviceId}:station:${station.id}')){
        localStorage.setItem('streaming:${actor.deviceId}:station:${station.id}',JSON.stringify(${JSON.stringify(initial)}));
        localStorage.setItem('streaming:${actor.deviceId}:ui',JSON.stringify({view:'edit',stationId:'${station.id}',scroll:{},drafts:{}}));
      }
      StreamingConsole.init({deviceId:()=> '${actor.deviceId}',deviceName:()=> 'Editor selection',devices:()=>[],currentTunnel:()=> 'fixture-tunnel',tunnels:async()=>${JSON.stringify(tunnels)},toast:()=>{},home:()=>{}});StreamingConsole.open();</script>`));
    const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width,height:800},hasTouch:true});page.setDefaultTimeout(7000);
    const errors=[],sourceRequests=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().includes('/source-location?'))sourceRequests.push(request.url());});
    await page.goto(f.base+'/editor-selection');await page.locator('.sc-program').first().waitFor();
    return {...f,page,station:saved,errors,sourceRequests,ids:()=>page.locator('.sc-program').evaluateAll(rows=>rows.map(row=>row.dataset.itemId))};
}
test('single removal uses themed confirmation and slides out only the draft item',async t=>{
    const f=await setup(t),{page}=f,row=page.locator('[data-item-id="a"]');
    await page.waitForFunction(()=>document.querySelector('.sc-program-source').textContent.includes('66666'));
    assert.match(await row.locator('.sc-program-source').textContent(),/66666.*text-record/);
    const colors=new Set();
    for(const theme of ['classic','graphite','atelier','social','lumen','orbit','blamen','lusns']) {
        await page.evaluate(theme=>document.body.dataset.theme=theme,theme);
        colors.add(await row.getByRole('button',{name:'移除',exact:true}).evaluate(button=>getComputedStyle(button).color));
    }
    assert.ok(colors.size>=6);
    await row.getByRole('button',{name:'移除',exact:true}).click();
    await page.screenshot({path:'.npm-cache/261105-4-programme-confirm-desktop.png'});
    await row.getByRole('button',{name:'取消移除',exact:true}).click();assert.equal(await row.getByRole('button',{name:'移除',exact:true}).isVisible(),true);
    await row.getByRole('button',{name:'移除',exact:true}).click();await row.getByRole('button',{name:'确认移除',exact:true}).click();
    await page.locator('.sc-program-removing').waitFor();await row.waitFor({state:'detached'});
    assert.deepEqual(await f.ids(),['b','c','d']);assert.equal(f.station.items.length,4,'removing a draft item does not delete its source or persist the station');
    assert.deepEqual(f.errors,[]);
});
test('programme multiselect hides future heading components and moves and removes the selected group',async t=>{
    const f=await setup(t),{page}=f;
    const heading=page.locator('.sc-editor-heading'),actions=heading.locator('.sc-program-selection-actions');
    await heading.evaluate(node=>{const button=document.createElement('button');button.textContent='Future action';node.append(button);});
    await page.locator('[data-item-id="b"] strong').click({button:'right'});
    await page.locator('[data-item-id="d"] strong').click();
    assert.equal(await heading.getByText('Future action').isVisible(),false);
    assert.equal(await actions.locator('.sc-program-selection-count').textContent(),'2 ✓');
    await actions.getByRole('button',{name:'置顶',exact:true}).click();assert.deepEqual(await f.ids(),['b','d','a','c']);
    await actions.getByRole('button',{name:'↓',exact:true}).click();assert.deepEqual(await f.ids(),['a','b','d','c']);
    await actions.getByRole('button',{name:'↑',exact:true}).click();assert.deepEqual(await f.ids(),['b','d','a','c']);
    await actions.getByRole('button',{name:'置底',exact:true}).click();assert.deepEqual(await f.ids(),['a','c','b','d']);
    await actions.getByRole('button',{name:'移除',exact:true}).click();await actions.getByRole('button',{name:'取消移除',exact:true}).click();assert.equal((await f.ids()).length,4);
    await actions.getByRole('button',{name:'移除',exact:true}).click();await actions.getByRole('button',{name:'确认移除',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.sc-program').length===2);
    assert.deepEqual(await f.ids(),['a','c']);assert.equal(await heading.getByText('Future action').isVisible(),true);
    assert.deepEqual(f.errors,[]);
});
test('touch enters programme selection and tunnel import defaults to the current tunnel',async t=>{
    const {page,errors}=await setup(t,390),row=page.locator('[data-item-id="a"]');
    await row.locator('strong').dispatchEvent('pointerdown',{pointerType:'touch',pointerId:10,clientX:80,clientY:400});
    await row.locator('.sc-program-selection-check').waitFor();await row.dispatchEvent('pointerup',{pointerType:'touch',pointerId:10});
    await page.evaluate(()=>document.body.dataset.theme='orbit');await page.screenshot({path:'.npm-cache/261105-4-programme-selection-mobile.png'});
    await page.locator('.sc-program-selection-actions').getByRole('button',{name:'取消',exact:true}).click();
    await page.locator('.sc-editor-heading').getByRole('button',{name:'导入',exact:true}).click();
    await page.getByRole('button',{name:'隧道文件',exact:true}).click();
    assert.equal(await page.getByRole('combobox',{name:'来源隧道',exact:true}).inputValue(),'fixture-tunnel');
    assert.deepEqual(errors,[]);
});
test('saved sources outside the joined tunnel list load their short code once per tunnel',async t=>{
    const f=await setup(t,1280,{withoutMembership:true});
    await f.page.waitForFunction(()=>[...document.querySelectorAll('.sc-program-source')].every(node=>node.textContent.includes('54321')));
    assert.equal(f.sourceRequests.length,1);assert.deepEqual(f.errors,[]);
});
for(const width of [1280,390]) test('Back exits programme multiselect in place at '+width+'px',async t=>{
    const {page,errors}=await setup(t,width),row=page.locator('[data-item-id="a"]');
    if(width===390){await row.dispatchEvent('pointerdown',{pointerType:'touch',pointerId:7,isPrimary:true});await row.locator('.sc-program-selection-check').waitFor();await row.dispatchEvent('pointerup',{pointerType:'touch',pointerId:7});}
    else await row.locator('strong').click({button:'right'});
    await page.evaluate(()=>history.back());
    await page.waitForFunction(()=>!document.querySelector('.sc-editor-heading').classList.contains('sc-selecting'));
    assert.equal(await page.locator('.sc-editor-page').isVisible(),true);assert.equal(await page.locator('.sc-program-selection-check').count(),0);
    assert.equal(await page.locator('.sc-editor-heading').getByRole('button',{name:'导入',exact:true}).isVisible(),true);
    assert.deepEqual(errors,[]);
});
