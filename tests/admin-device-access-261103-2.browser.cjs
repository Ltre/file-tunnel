'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const owner='11111111-1111-4111-8111-111111111111',device='22222222-2222-4222-8222-222222222222',unknown='99999999-9999-4999-8999-999999999999';
const members=Array.from({length:96},(_,i)=>({deviceId:i?`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`:device,deviceName:'Device '+i,online:i===0}));
let browser,server,base,calls=[],saves=[];
before(async()=>{
    const app=express();app.use(express.json());
    app.get('/api/sessions',(_req,res)=>res.json({sessions:[{id:'old-tunnel',shortCode:'OLDER',lastActivity:10},{id:'new-tunnel',shortCode:'NEWER',lastActivity:20}]}));
    app.get('/admin',(_req,res)=>res.sendFile(path.resolve(__dirname,'../pages/admin-layout.html')));
    app.get('/admin/tunnel-permissions',(_req,res)=>res.sendFile(path.resolve(__dirname,'../pages/admin-tunnel-permissions.html')));
    app.get('/api/sessions/:sid/access',async(req,res)=>{calls.push(['tunnel',req.params.sid]);if(req.params.sid==='missing-tunnel')return res.status(404).json({error:'session-not-found'});if(req.params.sid==='old-tunnel')await new Promise(r=>setTimeout(r,180));res.json({ownerDeviceId:owner,permissions:{},knownDevices:members,devicePermissionRecords:members.map(m=>({...m,permissions:{}})),managementDevices:[]});});
    app.get('/api/sessions/:sid/access/devices/:did',async(req,res)=>{calls.push(['device',req.params.sid,req.params.did]);if(req.params.did===unknown)return res.status(404).json({error:'device-not-found'});if(req.params.did===members[1].deviceId)await new Promise(r=>setTimeout(r,180));res.json({deviceId:req.params.did,deviceName:'Selected '+req.params.did,mode:req.params.did===owner?'owner':'custom',permissions:{sendText:false,sendMarkdown:true},defaultPermissions:{},version:'v1'});});
    app.put('/api/sessions/:sid/access/devices/:did',(req,res)=>{saves.push({sid:req.params.sid,did:req.params.did,...req.body});res.json({deviceId:req.params.did,deviceName:'Saved',mode:req.body.mode,permissions:req.body.permissions,defaultPermissions:{},version:'v2'});});
    app.use(express.static(path.resolve(__dirname,'..')));server=await require('./support/listen-http.cjs').listenHttp(app);base='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({channel:'chrome',headless:true});
});
after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}});
async function open(t,query=''){const page=await browser.newPage({locale:'zh-CN',viewport:{width:1000,height:480}});const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[]);});await page.goto(base+'/pages/admin-tunnel-permissions.html'+query);return page;}
async function openTouchAdmin(t) {
    const context = await browser.newContext({locale:'zh-CN', viewport:{width:390,height:480}, isMobile:true, hasTouch:true});
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(base+'/admin?view='+encodeURIComponent('/admin/tunnel-permissions'));
    const frame = page.frameLocator('#admin-content');
    await frame.locator('.tunnel-access-device').first().waitFor();
    return { page, frame };
}
test('selecting a device brings the loaded permission editor into the mobile viewport', async t => {
    const { page, frame } = await openTouchAdmin(t);
    await frame.locator('#tunnelAccessEditor').evaluate(node => {
        const scroll = node.scrollIntoView.bind(node);
        node.scrollIntoView = options => {
            node.dataset.scrollBehavior = options.behavior;
            scroll(options);
        };
    });
    await frame.locator('.tunnel-access-device').first().tap();
    await page.waitForFunction(() => {
        const doc = document.getElementById('admin-content').contentDocument;
        const heading = doc?.querySelector('.tunnel-access-heading')?.getBoundingClientRect();
        return heading && heading.top >= 0 && heading.bottom <= doc.documentElement.clientHeight;
    }, null, {timeout:3000});
    assert.equal(await frame.locator('#tunnelAccessEditor').getAttribute('data-scroll-behavior'), 'smooth');
});
test('device selection leaves the scroll position alone when most of the permissions are already visible', async t => {
    const page = await open(t);
    await page.setViewportSize({width:1280,height:720});
    await page.evaluate(() => {
        const original = Element.prototype.scrollIntoView;
        window.permissionScrolls = 0;
        Element.prototype.scrollIntoView = function (...args) {
            if (this.id === 'tunnelAccessEditor') window.permissionScrolls++;
            return original.apply(this,args);
        };
    });
    await page.locator('.tunnel-access-device').first().click();
    await page.locator('.tunnel-access-record').waitFor();
    assert.equal(await page.evaluate(() => window.permissionScrolls), 0);

    await page.setViewportSize({width:390,height:720});
    const position = await page.locator('#tunnelAccessEditor').evaluate(node => {
        window.scrollTo(0, node.getBoundingClientRect().top + window.scrollY - 140);
        return window.scrollY;
    });
    assert.ok(position > 0);
    await page.locator(`.tunnel-access-device[data-device-id="${members[1].deviceId}"]`).evaluate(button => button.click());
    assert.equal(await page.evaluate(() => window.scrollY), position, 'loading another device must keep the existing scroll position');
    await page.waitForFunction(id => document.querySelector('.tunnel-access-heading')?.textContent.includes(id), members[1].deviceId);
    assert.equal(await page.evaluate(() => window.permissionScrolls), 0);
});
test('a touch swipe at the bottom of the device list scrolls the permissions document', async t => {
    const { page, frame } = await openTouchAdmin(t);
    await frame.locator('.tunnel-access-device').first().tap();
    await frame.locator('.tunnel-access-record').waitFor();
    const panel = frame.locator('.tunnel-access-device-options');
    await panel.evaluate(node => {
        node.ownerDocument.scrollingElement.scrollTop = 0;
        node.scrollTop = node.scrollHeight;
    });
    const box = await panel.boundingBox();
    const viewport = await page.locator('#admin-content').boundingBox();
    const x = Math.round(box.x + box.width / 2);
    const y = Math.floor(Math.min(box.y + box.height, viewport.y + viewport.height) - 15);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{x,y}] });
    for (let step = 1; step <= 8; step++) {
        await page.waitForTimeout(16);
        await cdp.send('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:[{x,y:y-step*12}] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
    const outerScroll = await panel.evaluate(node => node.ownerDocument.scrollingElement.scrollTop);
    assert.ok(outerScroll > 0, `touch input must move the permissions document, got ${outerScroll}px`);
});
test('the short back-office viewport can scroll to all controls instead of clipping below the iframe',async t=>{
    const page=await open(t);await page.waitForFunction(()=>document.querySelectorAll('.tunnel-access-record,.tunnel-access-device').length>=96);
    await page.mouse.move(10,350);await page.mouse.wheel(0,10000);await page.waitForTimeout(100);
    assert.ok(await page.evaluate(()=>document.scrollingElement.scrollTop>0),'wheel must scroll the actual permission document');
});
test('latest tunnel loads automatically, historical devices stay flat, and manual selection validates the device',async t=>{
    const page=await open(t);await page.locator('.tunnel-access-device').first().waitFor();
    assert.equal(await page.locator('#accessTunnelSelect').inputValue(),'new-tunnel');assert.equal(await page.locator('.tunnel-access-device').count(),96);
    assert.equal(await page.locator('.tunnel-access-device.is-online').count(),1);assert.equal(await page.locator('.tunnel-access-device.is-offline').count(),95);
    assert.equal(await page.locator('#accessDeviceId').evaluate(node=>node===node.parentNode.firstElementChild&&node.nextElementSibling.id==='accessDeviceList'),true);
    await page.locator('#accessDeviceId').fill(unknown);await page.locator('#accessDeviceId').blur();await page.getByText('当前选中设备不存在，请重新指定',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-capability]').count(),0);assert.equal(await page.locator('#accessDeviceId').getAttribute('aria-pressed'),null);
    await page.locator('#accessDeviceId').fill(device);await page.locator('#accessDeviceId').blur();await page.locator('[data-capability=sendText]').waitFor();
    assert.equal(await page.locator('#accessDeviceId').evaluate(node=>node.classList.contains('is-selected')),true);
    assert.equal(await page.locator('[data-capability=sendText]').isChecked(),false);assert.equal(await page.locator('[data-capability=sendMarkdown]').isChecked(),true);
    await page.locator('[data-capability=sendFile]').uncheck();await page.getByRole('button',{name:'保存设备权限',exact:true}).click();await page.getByText('设备权限已保存',{exact:true}).waitFor();
    const saved=saves.at(-1);assert.equal(saved.sid,'new-tunnel');assert.equal(saved.did,device);assert.equal(saved.permissions.sendFile,false);assert.equal(saved.version,'v1');assert.equal(saved.managementDevices,undefined,'save only the selected device');
});
test('manual missing tunnel replaces the whole device row with a centered three-line notice',async t=>{
    const page=await open(t);await page.locator('.tunnel-access-device').first().waitFor();
    await page.locator('#accessTunnelId').fill('missing-tunnel');await page.locator('#accessTunnelId').blur();await page.getByText('当前选中隧道不存在，请重新指定',{exact:true}).waitFor();
    assert.equal(await page.locator('#accessDevicePicker').isVisible(),false);assert.equal(await page.locator('[data-capability]').count(),0);
    const style=await page.locator('#tunnelAccessMissing').evaluate(node=>{const s=getComputedStyle(node);return{height:node.getBoundingClientRect().height,line:parseFloat(s.lineHeight),align:s.textAlign,bg:s.backgroundColor};});
    assert.ok(style.height>=style.line*3);assert.equal(style.align,'center');assert.notEqual(style.bg,'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('#accessTunnelId').evaluate(node=>node.classList.contains('is-selected')),true);
});
test('rapid tunnel and device changes ignore stale responses, and administrator controls remain fully scrollable',async t=>{
    const page=await open(t);await page.locator('.tunnel-access-device').first().waitFor();
    await page.locator('#accessTunnelSelect').selectOption('old-tunnel');await page.locator('#accessTunnelSelect').selectOption('new-tunnel');await page.locator('.tunnel-access-device').first().waitFor();await page.waitForTimeout(220);
    assert.match(await page.locator('#tunnelAccessStatus').textContent(),/new-tunnel/);
    await page.locator(`.tunnel-access-device[data-device-id="${members[1].deviceId}"]`).click();await page.locator(`.tunnel-access-device[data-device-id="${device}"]`).click();await page.locator('[data-capability]').first().waitFor();await page.waitForTimeout(220);
    assert.match(await page.locator('.tunnel-access-record .tunnel-access-heading').textContent(),new RegExp(device));
    await page.getByRole('checkbox',{name:'设为隧道管理员（全部权限及分配权限）',exact:true}).check();assert.equal(await page.locator('[data-capability]:disabled:checked').count(),10);
    await page.mouse.move(10,350);await page.mouse.wheel(0,10000);await page.waitForTimeout(100);
    assert.ok((await page.getByRole('button',{name:'保存设备权限',exact:true}).boundingBox()).y<480);
});
test('the selection rows have left labels and the explanation only opens through the title info icon',async t=>{
    const page=await open(t),button=page.getByRole('button',{name:'查看权限说明',exact:true});
    assert.equal(await page.locator('.tunnel-access-picker>label').textContent(),'选择隧道');
    assert.equal(await page.locator('#accessDevicePicker>label').textContent(),'选择设备');
    assert.equal(await page.locator('#tunnelAccessHelp').isVisible(),false);assert.equal(await button.evaluate(node=>node.parentNode.matches('main>h1')),true);
    await button.click();assert.equal(await button.getAttribute('aria-expanded'),'true');assert.match(await page.locator('#tunnelAccessHelp').textContent(),/管理员设备拥有全部隧道权限/);
    await page.locator('#accessTunnelId').click();assert.equal(await page.locator('#tunnelAccessHelp').isVisible(),false);
    await button.click();await page.keyboard.press('Escape');assert.equal(await page.locator('#tunnelAccessHelp').isVisible(),false);
});
test('manual device ID wraps and matches its adjacent device block on wide and narrow screens',async t=>{
    const page=await open(t);await page.locator('.tunnel-access-device').first().waitFor();
    for(const width of [1000,390]){
        await page.setViewportSize({width,height:600});await page.locator('#accessDeviceId').fill(unknown);
        const sizes=await page.locator('#accessDeviceId').evaluate(node=>{const rect=node.getBoundingClientRect(),peer=document.querySelector('.tunnel-access-device').getBoundingClientRect(),s=getComputedStyle(node);return{tag:node.tagName,width:rect.width,height:rect.height,peerWidth:peer.width,peerHeight:peer.height,whiteSpace:s.whiteSpace,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth};});
        assert.equal(sizes.tag,'TEXTAREA');assert.ok(Math.abs(sizes.width-sizes.peerWidth)<.1);assert.equal(sizes.height,sizes.peerHeight);assert.equal(sizes.scrollWidth,sizes.clientWidth);assert.notEqual(sizes.whiteSpace,'nowrap');
        await page.locator('#accessDeviceId').focus();const focusStyle=await page.locator('#accessDeviceId').evaluate(node=>{const style=getComputedStyle(node);return{outline:style.outlineStyle,border:style.borderStyle};});assert.equal(focusStyle.outline,'none');assert.equal(focusStyle.border,'solid');
    }
});
test('the real back-office iframe shell allows scrolling down to permissions and back to both selection rows',async t=>{
    const page=await open(t);await page.goto(base+'/admin?view='+encodeURIComponent('/admin/tunnel-permissions'));
    const frame=page.frameLocator('#admin-content');
    await frame.locator('#tunnelAccessEditor').evaluate(node => {
        const scroll = node.scrollIntoView.bind(node);
        node.scrollIntoView = options => {
            node.ownerDocument.addEventListener('scrollend', () => { node.dataset.scrollSettled = 'true'; }, {once:true});
            scroll(options);
        };
    });
    await frame.locator('.tunnel-access-device').first().click();
    await frame.locator('#tunnelAccessEditor[data-scroll-settled=true]').waitFor({timeout:3000});
    await page.waitForFunction(() => {
        const doc = document.getElementById('admin-content').contentDocument;
        const save = [...doc.querySelectorAll('#tunnelAccessEditor button')].find(button => button.textContent === '保存设备权限');
        const rect = save?.getBoundingClientRect();
        return rect && rect.top >= 0 && rect.bottom <= doc.documentElement.clientHeight;
    },null,{timeout:3000});
    const viewport = await page.locator('#admin-content').boundingBox();
    await page.mouse.move(viewport.x+8,viewport.y+viewport.height/2);
    await page.mouse.wheel(0,-1000);
    await page.waitForFunction(() => {
        const doc = document.getElementById('admin-content').contentDocument;
        const select = doc.getElementById('accessTunnelSelect')?.getBoundingClientRect();
        return select && select.top >= 0 && select.bottom <= doc.documentElement.clientHeight;
    },null,{timeout:3000});
});
test('the device selection area shows at most three rows and scrolls independently of the permissions document',async t=>{
    const page=await open(t);await page.locator('.tunnel-access-device').first().waitFor();
    const panel=page.locator('.tunnel-access-device-options'),geometry=await panel.evaluate(node=>({height:node.getBoundingClientRect().height,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight}));
    assert.ok(geometry.height<=296);assert.ok(geometry.scrollHeight>geometry.clientHeight);
    const rect=await panel.boundingBox(),before=await page.evaluate(()=>document.scrollingElement.scrollTop);await page.mouse.move(rect.x+rect.width/2,Math.min(470,rect.y+30));await page.mouse.wheel(0,700);await page.waitForTimeout(100);
    assert.ok(await panel.evaluate(node=>node.scrollTop>0));assert.equal(await page.evaluate(()=>document.scrollingElement.scrollTop),before);
});
test('wide permission pages use 75 percent with room for five devices, aligned rows and a uniform background',async t=>{
    const page=await open(t);await page.setViewportSize({width:1600,height:700});await page.locator('.tunnel-access-device').first().waitFor();
    const layout=await page.locator('.tunnel-access-page').evaluate(node=>{const box=node.getBoundingClientRect(),first=document.querySelector('.tunnel-access-device').getBoundingClientRect();return{left:box.left,width:box.width,viewport:document.documentElement.clientWidth,columns:[...document.querySelectorAll('.tunnel-access-device')].filter(item=>Math.abs(item.getBoundingClientRect().top-first.top)<1).length};});
    assert.equal(layout.width,layout.viewport*.75);assert.equal(layout.left,(layout.viewport-layout.width)/2);assert.ok(layout.columns>=5,'the first row needs at least five devices in addition to the manual field');
    const alignment=await page.evaluate(()=>{const select=document.querySelector('#accessTunnelSelect').getBoundingClientRect(),manual=document.querySelector('#accessTunnelId').getBoundingClientRect(),devices=document.querySelector('.tunnel-access-device-options').getBoundingClientRect();return{left:Math.abs(select.left-devices.left),right:Math.abs(manual.right-devices.right)};});assert.ok(alignment.left<1&&alignment.right<1);
    assert.deepEqual(await page.evaluate(()=>[document.documentElement,document.body,document.querySelector('main')].map(node=>getComputedStyle(node).backgroundColor)),['rgb(255, 255, 255)','rgb(255, 255, 255)','rgb(255, 255, 255)']);
});
test('creator and both kinds of administrator are marked first, including offline devices, and saves refresh the marking',async t=>{
    const page=await open(t);await page.route('**/api/sessions/*/access',route=>route.fulfill({json:{ownerDeviceId:members[2].deviceId,managementDevices:[{deviceId:members[3].deviceId}],adminDevices:[{deviceId:members[4].deviceId}],knownDevices:members,permissions:{}}}));await page.reload();
    await page.waitForFunction(()=>document.querySelectorAll('.tunnel-access-device-role').length===3);
    assert.deepEqual(await page.locator('.tunnel-access-device').evaluateAll(nodes=>nodes.slice(0,3).map(node=>node.dataset.deviceId)),[members[2].deviceId,members[3].deviceId,members[4].deviceId]);
    assert.deepEqual(await page.locator('.tunnel-access-device-role').allTextContents(),['创建者','管理员','管理员']);
    assert.equal(await page.locator('.tunnel-access-device').first().evaluate(node=>node.classList.contains('is-offline')),true);
    await page.locator(`.tunnel-access-device[data-device-id="${device}"]`).click();await page.getByRole('checkbox',{name:'设为隧道管理员（全部权限及分配权限）',exact:true}).check();await page.getByRole('button',{name:'保存设备权限',exact:true}).click();await page.getByText('设备权限已保存',{exact:true}).waitFor();
    assert.equal(await page.locator('.tunnel-access-device-role').count(),4);assert.equal(await page.locator('.tunnel-access-device').nth(1).getAttribute('data-device-id'),device);
});
