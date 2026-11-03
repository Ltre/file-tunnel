'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),os=require('node:os');
const server=fs.readFileSync(require.resolve('../server.js'),'utf8');
const sid='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222',admin='33333333-3333-4333-8333-333333333333',device='44444444-4444-4444-8444-444444444444';
function section(a,b){const start=server.indexOf(a);return server.slice(start,server.indexOf(b,start));}
function fixture(){const runtime=vm.createContext({console,Date,Map,Set,sanitizeString:(value,max=80)=>String(value||'').slice(0,max),isValidDeviceId:id=>/^[\da-f-]{36}$/i.test(id)});vm.runInContext(section('const DEFAULT_TUNNEL_PERMISSIONS =','function canReadForwardedFile(')+section('function canAssignTunnelPermissions(', 'function saveTunnelDevicePermissions('),runtime);return runtime;}
test('administrator role grants all business capabilities and device permission management',()=>{
    const f=fixture(),session={ownerDeviceId:owner,devices:new Map(),permissions:{read:false,sendText:false},managementDevices:{[admin]:{permissions:{read:false,sendText:false,sendMarkdown:false}}}};
    for(const capability of ['read','sendText','sendRich','sendFile','sendMarkdown','sendWebZip','delete','collaborativeEdit','globalIntercom','groupVoice'])assert.equal(f.canUseTunnelCapability(session,admin,capability),true,capability);
    assert.equal(f.canAssignTunnelPermissions(session,admin),true);assert.equal(f.canAssignTunnelPermissions(session,device),false);
    assert.equal(f.canManageTunnel(session,admin),true,'an explicit back-office manager can configure the existing tunnel without its owner device online');
});
test('the original front-office designated-administrator role retains its independent restricted permissions',()=>{
    const f=fixture(),session={ownerDeviceId:owner,devices:new Map(),permissions:{read:true,sendFile:true},admins:{[admin]:{permissions:{read:false,sendFile:false,sendText:true}}}};
    assert.equal(f.canUseTunnelCapability(session,admin,'read'),false);assert.equal(f.canUseTunnelCapability(session,admin,'sendFile'),false);assert.equal(f.canUseTunnelCapability(session,admin,'sendText'),true);
    assert.equal(f.canManageTunnel(session,admin),false);assert.equal(f.canAssignTunnelPermissions(session,admin),false);
});
test('ordinary device overrides are an upper limit and do not become administrators',()=>{
    const f=fixture(),session={ownerDeviceId:owner,devices:new Map(),permissions:f.normalizeTunnelPermissions(),admins:{},devicePermissions:{[device]:{permissions:f.normalizeTunnelPermissions({read:true,sendText:false,sendMarkdown:true,sendFile:false,sendWebZip:true,delete:false})}}};
    assert.equal(f.canUseTunnelCapability(session,device,'read'),true);assert.equal(f.canUseTunnelCapability(session,device,'sendText'),false);assert.equal(f.canUseTunnelCapability(session,device,'sendMarkdown'),true);
    assert.equal(f.canUseTunnelCapability(session,device,'sendFile'),false);assert.equal(f.canUseTunnelCapability(session,device,'sendWebZip'),true);assert.equal(f.canUseTunnelCapability(session,device,'delete'),false);
    assert.equal(f.canManageTunnel(session,device),false);assert.equal(f.canUseTunnelCapability(session,owner,'delete'),true);
});
test('legacy permissions inherit text/file restrictions while explicit Markdown and web ZIP grants stay independent',()=>{
    const f=fixture(),legacy=f.parseStoredTunnelAccess(JSON.stringify({permissions:{sendText:false,sendFile:false},admins:{[admin]:{permissions:{read:false}}}}));
    assert.equal(legacy.permissions.sendMarkdown,false);assert.equal(legacy.permissions.sendWebZip,false);assert.ok(legacy.admins[admin]);
    assert.equal(f.normalizeTunnelPermissions({sendText:false,sendMarkdown:true}).sendMarkdown,true);
    assert.deepEqual(Array.from(f.tunnelMessageCapabilities({type:'markdown'})),['sendMarkdown']);
    assert.deepEqual(Array.from(f.tunnelMessageCapabilities({type:'collection',collection:{files:[{name:'page.html.zip'},{name:'ordinary.zip'}]}})),['sendWebZip','sendFile']);
});
test('device permissions survive real SQLite persistence and reopening without touching another tunnel',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tunnel-permissions-261103-')),stores=[];t.after(()=>{for(const store of stores)store.close();fs.rmSync(dir,{recursive:true,force:true});});
    const {createInfraStore}=require('../server/infra-store'),f=fixture(),a=await createInfraStore({dataDir:dir});stores.push(a);
    a.setTunnelAccess(sid,owner,{sendText:false},Date.now(),{[device]:{deviceId:device,permissions:{read:false}}},{[device]:{deviceId:device,permissions:{sendMarkdown:false,sendWebZip:true}}},{[admin]:{deviceId:admin}});a.flush();a.close();stores.pop();
    const b=await createInfraStore({dataDir:dir});stores.push(b);const access=f.parseStoredTunnelAccess(b.getTunnel(sid).permissions_json);
    assert.ok(access.managementDevices[admin]);assert.equal(access.admins[device].permissions.read,false);assert.equal(access.devicePermissions[device].permissions.sendMarkdown,false);assert.equal(access.devicePermissions[device].permissions.sendWebZip,true);
    assert.equal(access.permissions.sendMarkdown,false);assert.equal(b.getTunnel('99999999-9999-4999-8999-999999999999'),null);
});
test('back-office access endpoints require authentication, accept multiple admins and keep ordinary grants separate',async t=>{
    const express=require('express'),app=express();app.use(express.json());let value={ownerDeviceId:owner,permissions:{},adminDevices:[],devicePermissionRecords:[]};
    require('../server/tunnel-permissions').mountTunnelPermissionRoutes(app,{requireAuth:(req,res,next)=>req.get('x-test-auth')==='yes'?next():res.sendStatus(401),validSessionId:id=>id===sid,get:()=>value,save:(_id,data)=>{value={...value,...data};return value;}});
    const http=await require('./support/listen-http.cjs').listenHttp(app);t.after(()=>new Promise(resolve=>{http.closeAllConnections();http.close(resolve);}));const url='http://127.0.0.1:'+http.address().port+'/api/sessions/'+sid+'/access';
    assert.equal((await fetch(url)).status,401);
    const result=await fetch(url,{method:'PUT',headers:{'x-test-auth':'yes','Content-Type':'application/json'},body:JSON.stringify({managementDevices:{[admin]:{},[owner]:{}},devicePermissions:{[device]:{permissions:{read:false}}}})});
    assert.equal(result.status,200);assert.equal(Object.keys((await result.json()).managementDevices).length,2);assert.equal(value.devicePermissions[device].permissions.read,false);
});
test('an authenticated back-office request saves an offline tunnel without its creator and preserves original front-office administrators',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'offline-access-261103-'));
    const store=await require('../server/infra-store').createInfraStore({dataDir:dir});
    t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
    store.setTunnelAccess(sid,owner,{read:true,sendText:false},Date.now(),{[device]:{deviceId:device,permissions:{read:false}}});store.flush();
    assert.equal(store.listTunnelsWithStats().find(tunnel=>tunnel.session_id===sid).owner_device_id,owner);
    const f=fixture();Object.assign(f,{infraStore:store,sessions:new Map(),io:{sockets:{sockets:new Map()}}});
    vm.runInContext(section('function getSessionPermissionPayload(',"require('./server/tunnel-permissions').mountTunnelPermissionRoutes"),f);
    const express=require('express'),app=express();app.use(express.json());
    require('../server/tunnel-permissions').mountTunnelPermissionRoutes(app,{requireAuth:(req,res,next)=>req.get('x-test-auth')==='yes'?next():res.sendStatus(401),validSessionId:id=>id===sid,
        get:id=>f.getAdminTunnelAccess(id)?.payload,save:(id,data)=>f.saveTunnelDevicePermissions(id,f.getAdminTunnelAccess(id).session,data,'back-office')});
    const http=await require('./support/listen-http.cjs').listenHttp(app);t.after(()=>new Promise(resolve=>{http.closeAllConnections();http.close(resolve);}));
    const url='http://127.0.0.1:'+http.address().port+'/api/sessions/'+sid+'/access',headers={'x-test-auth':'yes','Content-Type':'application/json'};
    const response=await fetch(url,{method:'PUT',headers,body:JSON.stringify({managementDevices:{[admin]:{deviceId:admin}},devicePermissions:{[device]:{deviceId:device,permissions:{sendFile:false,sendWebZip:true}}}})});
    assert.equal(response.status,200);const saved=await response.json();assert.equal(saved.managementDevices[0].deviceId,admin);
    const stored=f.parseStoredTunnelAccess(store.getTunnel(sid).permissions_json);
    assert.equal(stored.admins[device].permissions.read,false,'the original front-office admin record stays intact');
    assert.equal(stored.devicePermissions[device].permissions.sendFile,false);assert.equal(stored.devicePermissions[device].permissions.sendWebZip,true);
    assert.equal(f.sessions.size,0,'configuration does not create a fake online session');
    const before=store.getTunnel(sid).permissions_json;
    const rejected=await fetch(url,{method:'PUT',headers,body:JSON.stringify({managementDevices:{'not-a-device':{}},devicePermissions:{}})});
    assert.equal(rejected.status,400);assert.equal(store.getTunnel(sid).permissions_json,before);
});
