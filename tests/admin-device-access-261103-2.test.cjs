'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const sid='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222',manager='33333333-3333-4333-8333-333333333333',device='44444444-4444-4444-8444-444444444444',outsider='55555555-5555-4555-8555-555555555555',unknown='99999999-9999-4999-8999-999999999999';
function section(a,b){const start=source.indexOf(a);return source.slice(start,source.indexOf(b,start));}
async function fixture(t){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-device-access-261103-2-')),store=await require('../server/infra-store').createInfraStore({dataDir:dir});
    t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
    store.setTunnelAccess(sid,owner,{sendText:false},1000,{[device]:{deviceId:device,permissions:{read:false}}},{},{[manager]:{deviceId:manager}});
    store.recordTunnelMember(sid,{deviceId:owner,deviceName:'Creator'},1000);store.recordTunnelMember(sid,{deviceId:device,deviceName:'Past member'},2000);store.recordTunnelMember(sid,{deviceId:manager,deviceName:'Offline manager'},3000);
    store.upsertDevice({deviceId:outsider,sessionId:'another-tunnel',deviceName:'Known elsewhere',online:true});store.flush();
    const f=vm.createContext({console,Date,Map,Set,infraStore:store,sessions:new Map(),io:{sockets:{sockets:new Map()}},sanitizeString:(value,max=80)=>String(value||'').slice(0,max),isValidDeviceId:value=>/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value)});
    vm.runInContext(section('const DEFAULT_TUNNEL_PERMISSIONS =','function canReadForwardedFile(')+section('function getSessionPermissionPayload(',"require('./server/tunnel-permissions').mountTunnelPermissionRoutes"),f);
    const {createAdminDeviceAccess,mountTunnelPermissionRoutes}=require('../server/tunnel-permissions');
    const access=createAdminDeviceAccess({get:id=>f.getAdminTunnelAccess(id),findDevice:id=>store.getDevice(id),normalize:value=>f.normalizeTunnelPermissions(value),canUse:(...args)=>f.canUseTunnelCapability(...args),save:(id,session,data)=>f.saveTunnelDevicePermissions(id,session,data,'back-office')});
    const app=require('express')();app.use(require('express').json());mountTunnelPermissionRoutes(app,{requireAuth:(req,res,next)=>req.get('x-test-auth')==='yes'?next():res.sendStatus(401),validSessionId:value=>/^[\da-f-]{36}$/i.test(value),validDeviceId:f.isValidDeviceId,get:id=>f.getAdminTunnelAccess(id)?.payload,save:(id,data)=>f.saveTunnelDevicePermissions(id,f.getAdminTunnelAccess(id).session,data,'back-office'),deviceAccess:access});
    const http=await require('./support/listen-http.cjs').listenHttp(app);t.after(()=>new Promise(r=>{http.closeAllConnections();http.close(r);}));
    const base='http://127.0.0.1:'+http.address().port+'/api/sessions/',headers={'x-test-auth':'yes','Content-Type':'application/json'};
    async function request(did,body,tunnel=sid){return fetch(base+tunnel+'/access/devices/'+did,{method:body?'PUT':'GET',headers,...(body?{body:JSON.stringify(body)}:{})});}
    return {f,store,access,request,base};
}
test('admin history uses persisted memberships and verifies online membership in this tunnel without creating a live session',async t=>{
    const {f,store}=await fixture(t);let payload=f.getAdminTunnelAccess(sid).payload;
    assert.equal(payload.knownDevices.length,3);assert.ok(payload.knownDevices.every(item=>!item.online));assert.ok(!payload.knownDevices.some(item=>item.deviceId===outsider));assert.equal(f.sessions.size,0);
    const live={...f.parseStoredTunnelAccess(store.getTunnel(sid).permissions_json),ownerDeviceId:owner,devices:new Map([[device,{deviceId:device,deviceName:'Now online',socketId:'present'}],[manager,{deviceId:manager,socketId:'stale'}]])};
    f.sessions.set(sid,live);f.io.sockets.sockets.set('present',{connected:true,data:{deviceId:device},emit(){}});f.io.sockets.sockets.set('stale',{connected:false,data:{deviceId:manager},emit(){}});
    payload=f.getAdminTunnelAccess(sid).payload;assert.equal(payload.knownDevices[0].deviceId,owner);assert.equal(payload.knownDevices[0].role,'owner');assert.equal(payload.knownDevices.find(item=>item.deviceId===device).online,true);assert.equal(payload.knownDevices.find(item=>item.deviceId===device).role,'designated-administrator');assert.equal(payload.knownDevices.find(item=>item.deviceId===manager).online,false);assert.equal(payload.knownDevices.find(item=>item.deviceId===manager).role,'administrator');
});
test('selection checks real registry or historical membership before returning permissions and stays read-only',async t=>{
    const {request,base,store}=await fixture(t),before=store.getTunnel(sid).permissions_json;
    assert.equal((await fetch(base+sid+'/access/devices/'+device)).status,401);assert.equal((await request(unknown)).status,404);assert.equal((await request('not-a-device')).status,400);
    assert.equal((await request(device,undefined,unknown)).status,404);
    const historical=await request(device);assert.equal(historical.status,200);assert.equal((await historical.json()).permissions.read,false);
    const knownElsewhere=await request(outsider);assert.equal(knownElsewhere.status,200);assert.equal((await knownElsewhere.json()).deviceName,'Known elsewhere');
    assert.equal(store.getTunnel(sid).permissions_json,before,'selecting never assigns a role or changes defaults');
});
test('saving only the selected device preserves other recent changes, original front administrators and independent capabilities',async t=>{
    const {access,request,store,f}=await fixture(t),selected=access.get(sid,device),permissions=f.normalizeTunnelPermissions({sendText:false,sendMarkdown:true,sendFile:false,sendWebZip:true});
    const session=f.getAdminTunnelAccess(sid).session;
    f.saveTunnelDevicePermissions(sid,session,{managementDevices:session.managementDevices,devicePermissions:{[outsider]:{deviceId:outsider,permissions:{delete:false}}}},'another-admin');
    const response=await request(device,{mode:'custom',permissions,version:selected.version});assert.equal(response.status,200);const saved=await response.json();
    assert.equal(saved.permissions.sendText,false);assert.equal(saved.permissions.sendMarkdown,true);assert.equal(saved.permissions.sendFile,false);assert.equal(saved.permissions.sendWebZip,true);
    const stored=f.parseStoredTunnelAccess(store.getTunnel(sid).permissions_json);assert.equal(stored.admins[device].permissions.read,false);assert.equal(stored.devicePermissions[outsider].permissions.delete,false);assert.ok(stored.managementDevices[manager]);
    assert.equal((await request(device,{mode:'administrator',permissions,version:saved.version})).status,200);const all=access.get(sid,device);assert.equal(all.mode,'administrator');assert.ok(Object.values(all.permissions).every(Boolean));assert.ok(access.get(sid,manager).mode==='administrator');
});
test('stale selected-device writes and creator edits are rejected without changing persisted permissions',async t=>{
    const {access,request,store}=await fixture(t),previous=access.get(sid,device);
    access.save(sid,device,{mode:'custom',permissions:previous.defaultPermissions,version:previous.version});const before=store.getTunnel(sid).permissions_json;
    assert.equal((await request(device,{mode:'administrator',version:previous.version})).status,409);assert.equal((await request(owner,{mode:'custom',permissions:previous.defaultPermissions,version:access.get(sid,owner).version})).status,400);
    assert.equal((await request(unknown,{mode:'administrator',version:'fake'})).status,404);assert.equal(store.getTunnel(sid).permissions_json,before);
});
test('restoring defaults removes only the selected override and retains historical membership and original administrator semantics',async t=>{
    const {access,store,f}=await fixture(t),previous=access.get(sid,device);
    access.save(sid,device,{mode:'administrator',version:previous.version});const current=access.get(sid,device);
    const reset=access.save(sid,device,{mode:'default',version:current.version});assert.equal(reset.mode,'default');assert.equal(reset.permissions.read,false,'original designated-admin restriction still applies');
    const stored=f.parseStoredTunnelAccess(store.getTunnel(sid).permissions_json);assert.equal(stored.managementDevices[device],undefined);assert.equal(stored.devicePermissions[device],undefined);assert.ok(stored.managementDevices[manager]);assert.ok(store.listTunnelMembers(sid).some(item=>item.device_id===device));
});
