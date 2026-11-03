'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..');let browser,server,base;
const owner='11111111-1111-4111-8111-111111111111',device='22222222-2222-4222-8222-222222222222';
const sessions=Array.from({length:8},(_,i)=>({id:'session-'+i,shortCode:'CODE'+i,remark:'Tunnel '+i,isActive:Boolean(i&1),isOnline:Boolean(i&2),messageCount:i&4?3:0,createdAt:1000,lastActivity:1000}));
sessions[0].ownerDeviceId=owner;sessions[0].ownerDeviceName='Creator fixture';
let access={ownerDeviceId:owner,permissions:{read:true,sendText:true,sendFile:true},managementDevices:[],devicePermissionRecords:[],knownDevices:[{deviceId:device,deviceName:'Test device'}]},saved;
const jobs=Array.from({length:45},(_,i)=>({id:'job-'+i,createdAt:i+1,mode:'core',folder:String(i),status:'completed',completedFiles:1,totalFiles:1,completedBytes:1,totalBytes:1,target:null,skipped:[]}));
before(async()=>{
    const app=express();app.use(express.json());
    app.get('/api/sessions',(_req,res)=>res.json({sessions,totalDevices:0}));
    app.get('/api/sessions/:id/access',(_req,res)=>res.json(access));
    app.put('/api/sessions/:id/access',(req,res)=>{saved=req.body;access={...access,managementDevices:Object.values(req.body.managementDevices),devicePermissionRecords:Object.values(req.body.devicePermissions)};res.json({ok:true,...access});});
    const selectedAccess=()=>{const manager=access.managementDevices.find(record=>record.deviceId===device),custom=access.devicePermissionRecords.find(record=>record.deviceId===device);return{deviceId:device,deviceName:'Test device',mode:manager?'administrator':custom?'custom':'default',permissions:custom?.permissions||access.permissions,defaultPermissions:access.permissions,version:'fixture-v1'};};
    app.get('/api/sessions/:id/access/devices/:did',(_req,res)=>res.json(selectedAccess()));
    app.put('/api/sessions/:id/access/devices/:did',(req,res)=>{saved=req.body;access.managementDevices=saved.mode==='administrator'?[{deviceId:device}]:[];access.devicePermissionRecords=saved.mode==='custom'?[{deviceId:device,permissions:saved.permissions}]:[];res.json(selectedAccess());});
    app.get('/socket.io/socket.io.js',(_req,res)=>res.type('js').send('window.io=()=>({on(){}});'));
    app.get('/api/system-backup/state',(_req,res)=>res.json({config:{full:null,core:null},jobs,active:''}));
    const appSource=fs.readFileSync(path.join(root,'app.js'),'utf8'),index=fs.readFileSync(path.join(root,'pages/index.html'),'utf8');
    const section=index.slice(index.indexOf('    <div class="tunnel-settings-layer"'),index.indexOf('    <div class="container" id="appShell"'));
    const definitions=appSource.slice(appSource.indexOf('const DEFAULT_TUNNEL_PERMISSIONS ='),appSource.indexOf('let musicPlayerPersistTimer'));
    const functions=appSource.slice(appSource.indexOf('function isTunnelOwner('),appSource.indexOf('function applyTunnelPermissionUi('));
    const permissionHandler=appSource.slice(appSource.indexOf("    state.socket.on('session-permissions',"),appSource.indexOf("    state.socket.on('permission-denied',"));
    app.get('/front-settings',(req,res)=>res.type('html').send('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/themes.css">'+section+`<script>
        const state={sessionId:'session',deviceId:'ordinary',sessionOwnerDeviceId:${JSON.stringify(req.query.pending ? '' : 'owner')},sessionIsAdmin:false,sessionPermissions:null,sessionAdminDevices:new Map(),devices:new Map()};
        ${definitions}${functions}
        state.socket={on(_name,callback){window.receivePermissionPayload=callback;}};function applyTunnelPermissionUi(){renderTunnelPermissionSettings();}${permissionHandler}
        document.getElementById('tunnelSettingsLayer').hidden=false;renderTunnelPermissionSettings();</script>`));
    app.use(express.static(root));server=await require('./support/listen-http.cjs').listenHttp(app);base='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({channel:'chrome',headless:true});
});
after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
async function pageFor(t,url){const page=await browser.newPage({locale:'zh-CN'});const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[]);});await page.goto(base+url);return page;}
test('dedicated tunnel list applies all 27 combinations of activity, real online presence and record filters',async t=>{
    const page=await pageFor(t,'/pages/admin-tunnels.html');await page.waitForFunction(()=>document.querySelectorAll('.session-item').length===8);
    for(const active of ['all','yes','no'])for(const online of ['all','yes','no'])for(const records of ['all','yes','no']){
        await page.locator('#sessionActiveFilter').selectOption(active);await page.locator('#sessionOnlineFilter').selectOption(online);await page.locator('#sessionRecordsFilter').selectOption(records);
        const expected=sessions.filter(s=>(active==='all'||s.isActive===(active==='yes'))&&(online==='all'||s.isOnline===(online==='yes'))&&(records==='all'||(s.messageCount>0)===(records==='yes'))).map(x=>x.id).sort();
        assert.deepEqual(await page.locator('.session-item').evaluateAll(nodes=>nodes.map(node=>node.dataset.sessionId).sort()),expected);
    }
    assert.equal(await page.getByText('有真实设备在线',{exact:true}).count(),1);
});
test('overview keeps its statistics and no longer contains the tunnel list',async t=>{
    const page=await pageFor(t,'/pages/admin.html');await page.waitForFunction(()=>document.getElementById('totalSessions')?.textContent==='8');
    assert.equal(await page.locator('#sessionList').count(),0);assert.equal(await page.getByRole('link',{name:'隧道列表',exact:true}).count(),1);
});
test('creator details stay on the back-office tunnel list and legacy tunnels explain an absent creator',async t=>{
    const page=await pageFor(t,'/pages/admin-tunnels.html');await page.waitForFunction(()=>document.querySelectorAll('.session-item').length===8);
    assert.match(await page.locator('[data-session-id="session-0"]').textContent(),/Creator fixture/);
    assert.equal(await page.locator('[data-session-id="session-0"] .session-owner-info').count(),0);
    const info=page.locator('[data-session-id="session-1"] .session-owner-info');
    assert.equal(await info.count(),1);
    let message;page.once('dialog',async popup=>{message=popup.message();await popup.accept();});await info.click();
    assert.match(message,/早期创建.*首个进入.*自动成为创建者/);
});
test('back-office page saves ordinary grants separately and administrator role disables the restriction grid',async t=>{
    const page=await pageFor(t,'/pages/admin-tunnel-permissions.html');await page.locator('.tunnel-access-device').click();
    await page.locator('[data-capability=sendText]').uncheck();await page.locator('[data-capability=sendMarkdown]').check();
    await page.getByRole('button',{name:'保存设备权限',exact:true}).click();await page.getByText('设备权限已保存',{exact:true}).waitFor();
    assert.equal(saved.permissions.sendText,false);assert.equal(saved.permissions.sendMarkdown,true);assert.equal(saved.mode,'custom');
    const role=page.getByRole('checkbox',{name:'设为隧道管理员（全部权限及分配权限）',exact:true});await role.check();
    assert.equal(await page.locator('[data-capability]').count(),10);assert.equal(await page.locator('[data-capability]:disabled:checked').count(),10);
    await page.getByRole('button',{name:'保存设备权限',exact:true}).click();await page.waitForTimeout(100);assert.equal(saved.mode,'administrator');
});
test('front-office keeps the original designated-administrator form and adds only the two permission items',async t=>{
    const page=await pageFor(t,'/front-settings');
    assert.equal(await page.getByRole('heading',{name:'指定设备管理员',exact:true}).count(),1);
    assert.equal(await page.locator('#tunnelAdminDeviceSelect').count(),1);assert.equal(await page.locator('#tunnelAdminManualId').count(),1);assert.equal(await page.locator('#addTunnelAdminBtn').count(),1);
    assert.equal(await page.locator('.tunnel-access-picker').count(),0);assert.equal(await page.locator('#tunnelPermissionGrid [data-permission]').count(),10);
    assert.equal(await page.locator('#tunnelPermissionGrid [data-permission=sendMarkdown]').count(),1);assert.equal(await page.locator('#tunnelPermissionGrid [data-permission=sendWebZip]').count(),1);
});
test('permission settings stay greyed before identity confirmation and the confirmed creator retains editing access',async t=>{
    const page=await pageFor(t,'/front-settings?pending=1');
    assert.equal(await page.locator('#tunnelPermissionGrid [data-permission]:disabled').count(),10,'first paint must not enable any permission checkbox');
    assert.equal(await page.locator('#saveTunnelPermissionsBtn').isVisible(),false);
    await page.evaluate(()=>{state.sessionOwnerDeviceId='another-device';state.sessionPermissions={read:true};renderTunnelPermissionSettings();});
    assert.equal(await page.locator('#tunnelPermissionGrid [data-permission]:disabled').count(),10);
    await page.evaluate(()=>{state.sessionOwnerDeviceId=state.deviceId;renderTunnelPermissionSettings();});
    assert.equal(await page.locator('#tunnelPermissionGrid [data-permission]:enabled').count(),10);
    assert.equal(await page.locator('#saveTunnelPermissionsBtn').isVisible(),true);
});
test('a confirmed management device can edit defaults and select online administrators; revocation greys both groups immediately',async t=>{
    const page=await pageFor(t,'/front-settings?pending=1');assert.equal(await page.locator('#tunnelPermissionGrid [data-permission]:disabled').count(),10);
    await page.evaluate(()=>{state.devices.set('peer',{deviceId:'peer',deviceName:'Online peer'});receivePermissionPayload({ownerDeviceId:'creator',isAdmin:true,canManagePermissions:true,permissions:{},adminDevices:[]});});
    assert.equal(await page.locator('#tunnelPermissionGrid [data-permission]:enabled').count(),10);assert.equal(await page.locator('#tunnelAdminDeviceSelect').isEnabled(),true);assert.equal(await page.locator('#tunnelAdminManualId').isEnabled(),true);assert.equal(await page.locator('#addTunnelAdminBtn').isEnabled(),true);assert.equal(await page.locator('#tunnelAdminDeviceSelect option[value=peer]').count(),1);
    assert.equal(await page.locator('#saveTunnelPermissionsBtn').isVisible(),true);assert.equal(await page.locator('#saveTunnelAdminsBtn').isVisible(),true);
    await page.evaluate(()=>receivePermissionPayload({ownerDeviceId:'creator',isAdmin:true,canManagePermissions:false,permissions:{},adminDevices:[]}));
    assert.equal(await page.locator('#tunnelPermissionGrid [data-permission]:disabled').count(),10);assert.equal(await page.locator('#tunnelAdminDeviceSelect').isDisabled(),true);
});
test('backup history starts at the newest two, grows by twenty, preserves expansion on refresh and collapses',async t=>{
    const page=await pageFor(t,'/pages/system-backup.html');await page.waitForFunction(()=>document.querySelectorAll('[data-job-id]').length===2);
    assert.deepEqual(await page.locator('[data-job-id]').evaluateAll(nodes=>nodes.map(node=>node.dataset.jobId)),['job-44','job-43']);
    await page.locator('#sb-expand-history').click();assert.equal(await page.locator('[data-job-id]').count(),22);
    await page.locator('#sb-refresh').click();await page.waitForTimeout(80);assert.equal(await page.locator('[data-job-id]').count(),22);
    await page.locator('#sb-expand-history').click();assert.equal(await page.locator('[data-job-id]').count(),42);
    await page.locator('#sb-expand-history').click();assert.equal(await page.locator('[data-job-id]').count(),45);assert.equal(await page.locator('#sb-expand-history').isVisible(),false);
    await page.locator('#sb-collapse-history').click();assert.equal(await page.locator('[data-job-id]').count(),2);
});
