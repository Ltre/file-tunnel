'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const { createTunnelAccess } = require('../server/tunnel-access');
const { createStreamingTunnels } = require('../server/streaming-tunnels');
const { registerStreamingConsole } = require('../server/streaming-http');

async function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-discovery-261025-'));
    const app = require('express')(); app.use(require('express').json());
    const gate = createTunnelAccess(dataDir), tunnelId = 'shared-tunnel', current = {devices:new Map(),permissions:{read:true}};
    const sessions = new Map([[tunnelId,current]]), grants = new Map(), users = new Map([['alice',{id:'alice',name:'Alice'}],['bob',{id:'bob',name:'Bob'}]]);
    const canUseTunnelCapability = (session, _id, capability) => session.permissions[capability] !== false;
    const serverSource = read('server.js'), start = serverSource.indexOf('visibleDevices: (deviceId, aliases = [])');
    const visibleDevices = vm.runInNewContext('(' + serverSource.slice(start + 'visibleDevices: '.length, serverSource.indexOf(',\n    sources:', start)) + ')', {sessions,canUseTunnelCapability});
    const tunnel = createStreamingTunnels({session:id => sessions.get(id), messages:() => [], admitted:(id,member,grant) => gate.verify(grant,id,member), capability:canUseTunnelCapability});
    const streaming = registerStreamingConsole(app, {dataDir, identity:req => users.get(req.get('X-Disk-Account')) || null,
        proofs:() => [{id:'alice',hash:'alice-proof',expiresAt:Date.now()+86400000}], user:id => users.get(id), origin:req => req.protocol+'://'+req.get('host'), visibleDevices, sources:{broker:{close(){}}}, tunnel});
    tunnel.bind(streaming.service);
    const server = await require('./support/listen-http.cjs').listenHttp(app), base = 'http://127.0.0.1:'+server.address().port;
    t.after(async () => { streaming.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        assert.equal(path.dirname(dataDir),path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith('stream-discovery-261025-')); fs.rmSync(dataDir,{recursive:true,force:true}); });
    async function call(device, route, method = 'GET', body) {
        const response = await fetch(base+'/api/streaming'+route,{method,headers:{'Content-Type':'application/json','X-Stream-Device':device,'X-Stream-Key':device.repeat(12),'X-Disk-Account':'alice'},body:body===undefined?undefined:JSON.stringify(body)});
        const result = await response.json(); assert.ok(response.ok,JSON.stringify(result)); return result;
    }
    async function enroll(device, member = device) { await call(device,'/devices','POST',{deviceId:device,key:device.repeat(12),name:device}); grants.set(member,gate.issue(tunnelId,member)); current.devices.set(member,{deviceId:member}); }
    await enroll('source-A','member-A');
    await call('source-A','/sync','POST',{tunnels:[{sessionId:tunnelId,tunnelDeviceId:'member-A',accessGrant:grants.get('member-A')}]});
    const station = await call('source-A','/stations','POST',{name:'Same tunnel station',creationId:'same-tunnel-station'});
    await call('source-A','/stations/'+station.id+'/visibility','POST',{visibility:'public',version:station.playback.version});
    return {base,station,current,grants,call,enroll,tunnelId,streaming};
}

async function client(f, device, member, {beforeSync = async () => {}, delayedSocket = false} = {}) {
    const storage = new Map([['deviceId',device],['streaming:'+device+':key',device.repeat(12)]]), socket = new EventEmitter(), documentEvents = new EventEmitter(), windowEvents = new EventEmitter();
    const state = {sessionId:f.tunnelId,deviceId:member,deviceName:device,devices:new Map(),contacts:new Map(),socket:delayedSocket ? undefined : socket}; let authorization = {};
    const window = {DiskClient:{getAccount:() => 'alice'},TunnelMarkdown:{init(){}},addEventListener:(...args) => windowEvents.on(...args)};
    const document = {getElementById:() => null,addEventListener:(...args) => documentEvents.on(...args)};
    window.document = document; window.removeEventListener = (...args) => windowEvents.off(...args); document.removeEventListener = (...args) => documentEvents.off(...args);
    const context = {window,document,location:{href:f.base+'/',origin:f.base},URL,Uint8Array,Uint32Array,structuredClone,AbortController,TextDecoder,
        crypto:crypto.webcrypto, localStorage:{getItem:key => storage.get(key)||null,setItem:(key,value) => storage.set(key,value),removeItem:key => storage.delete(key)},
        setInterval:() => 1,clearInterval(){},setTimeout,clearTimeout,queueMicrotask,
        fetch:async (url,options) => { if (String(url).endsWith('/provider-work')) return new Promise(() => {}); if (String(url).endsWith('/sync')) await beforeSync(options); return fetch(f.base+url,options); }};
    vm.runInNewContext(read('client/streaming-app-adapter.js'),context); vm.runInNewContext(read('client/streaming-console.js').replace('global.StreamingConsole =', 'global.__discoveryTest = {sync}; global.StreamingConsole ='),context);
    const adapter = window.StreamingAppAdapter.create({state,listSessions:async () => [{sessionId:f.tunnelId}],authorization:() => authorization,toast(){}});
    await window.StreamingConsole.init(adapter);
    return {window,state,documentEvents, socket, adapter, connectSocket() {
        const app = read('app.js'), start = app.indexOf('function initSocket()');
        const init = app.slice(start, app.indexOf('function requestSessionHistory(', start));
        const host = {state,window,document:{...document,dispatchEvent:event => documentEvents.emit(event.type)},Event,
            io:() => socket,CONFIG:{},navigator:{language:'zh-CN'},configureLightTransfer(){},ensureDeviceCameraBridge(){},handleSessionDevices(){}};
        for (const match of init.matchAll(/state\.socket\.on\('[^']+',\s*(\w+)\)/g)) host[match[1]] ||= () => {};
        vm.runInNewContext(init+';initSocket();',host);
    }, authorize() { authorization={grant:f.grants.get(member),deviceId:member}; }};
}

test('opening another page without restored tunnel credentials does not erase verified device aliases', async t => {
    const f = await fixture(t); await f.enroll('viewer-B','member-B');
    await f.call('viewer-B','/sync','POST',{tunnels:[{sessionId:f.tunnelId,tunnelDeviceId:'member-B',accessGrant:f.grants.get('member-B')}]});
    assert.equal((await f.call('viewer-B','/stations?kind=discover')).stations.length,1);
    await f.call('viewer-B','/sync','POST',{tunnels:[]});
    assert.equal((await f.call('viewer-B','/stations?kind=discover')).stations.length,1,'another page must not erase a verified alias');
    await f.call('source-A','/sync','POST',{tunnels:[]});
    assert.equal((await f.call('viewer-B','/stations?kind=discover')).stations.length,1,'source page startup must not hide its station');
    f.current.devices.delete('member-B');
    assert.equal((await f.call('viewer-B','/stations?kind=discover')).stations.length,0,'aliases do not grant tunnel presence');
});

test('a tunnel grant arriving after streaming startup refreshes discovery on both viewing devices without account toggles', async t => {
    const f = await fixture(t); await f.enroll('viewer-B','member-B'); await f.enroll('viewer-C','member-C');
    const b = await client(f,'viewer-B','member-B',{delayedSocket:true}), c = await client(f,'viewer-C','member-C',{delayedSocket:true});
    assert.equal((await f.call('viewer-B','/stations?kind=discover')).stations.length,0,'no unverified alias is trusted before tunnel authorization is ready');
    // Production reveals the shell before awaiting music/contact/session data,
    // and only creates Socket.IO after that restoration has completed.
    for (const instance of [b,c]) instance.documentEvents.emit('tunnel-shell-ready');
    await new Promise(resolve => setTimeout(resolve,150));
    for (const instance of [b,c]) { instance.authorize(); instance.connectSocket(); instance.socket.emit('session-devices'); }
    await new Promise(resolve => setTimeout(resolve,350));
    for (const device of ['viewer-B','viewer-C']) assert.deepEqual((await f.call(device,'/stations?kind=discover')).stations.map(value => value.id),[f.station.id],device+' must discover the same admitted source without waiting for the 30s poll');
});

test('the same verified aliases restore discovery through normal sync without relaxing same-account or tunnel access rules', async t => {
    const f = await fixture(t); await f.enroll('viewer-B','member-B');
    const b = await client(f,'viewer-B','member-B'); b.authorize();
    await b.window.__discoveryTest.sync(true);
    assert.deepEqual((await f.call('viewer-B','/stations?kind=discover')).stations.map(value => value.id),[f.station.id]);
    await f.enroll('outsider-D','member-D'); f.current.devices.delete('member-D');
    assert.deepEqual((await f.call('outsider-D','/stations?kind=discover')).stations,[],'the same account alone must not create device visibility');
    await f.call('outsider-D','/sync','POST',{tunnels:[{sessionId:f.tunnelId,tunnelDeviceId:'member-D',accessGrant:f.grants.get('member-D')}]});
    assert.deepEqual((await f.call('outsider-D','/stations?kind=discover')).stations,[],'valid admission alone does not bypass the current visible-device policy');
    await f.call('outsider-D','/sync','POST',{tunnels:[{sessionId:f.tunnelId,tunnelDeviceId:'member-B',accessGrant:f.grants.get('member-D')}]});
    assert.deepEqual((await f.call('outsider-D','/stations?kind=discover')).stations,[],'a grant for a different member cannot forge the visible alias');
});

test('an authorization event during an old sync queues one fresh sync and coalesces a burst of device events', async t => {
    const f = await fixture(t); await f.enroll('viewer-B','member-B');
    let block = false, release, observed, syncs = 0;
    const reached = new Promise(resolve => { observed = resolve; });
    const b = await client(f,'viewer-B','member-B',{beforeSync:async () => { syncs++; if (block) { block=false; observed(); await new Promise(resolve => { release=resolve; }); } }});
    block=true; const oldSync = b.window.__discoveryTest.sync(); await reached;
    b.authorize();
    for (let i=0;i<10;i++) { b.socket.emit('tunnel-access-grant'); b.socket.emit('session-devices'); }
    await new Promise(resolve => setTimeout(resolve,150)); release(); await oldSync;
    await new Promise(resolve => setTimeout(resolve,150));
    assert.equal(syncs,3,'initial, old in-flight, and one merged fresh sync');
    assert.deepEqual((await f.call('viewer-B','/stations?kind=discover')).stations.map(value => value.id),[f.station.id]);
});

test('a source page restoring admission after startup restores its existing station to other admitted devices', async t => {
    const f = await fixture(t); await f.enroll('viewer-B','member-B');
    const source = await client(f,'source-A','member-A'), b = await client(f,'viewer-B','member-B');
    b.authorize(); await b.window.__discoveryTest.sync(true);
    assert.deepEqual((await f.call('viewer-B','/stations?kind=discover')).stations.map(value=>value.id),[f.station.id],'source startup retains its previously verified alias');
    assert.equal(f.streaming.service.station(f.station.id).visibility,'public','the persisted station was neither deleted nor taken offline');
    source.authorize(); source.socket.emit('tunnel-access-grant'); source.socket.emit('session-devices');
    await new Promise(resolve => setTimeout(resolve,250));
    assert.deepEqual((await f.call('viewer-B','/stations?kind=discover')).stations.map(value => value.id),[f.station.id]);
});

test('visibility observers unsubscribe only their own passive listeners', async t => {
    const f = await fixture(t); await f.enroll('viewer-B','member-B');
    const b = await client(f,'viewer-B','member-B'); let updates = 0;
    const original = () => {}; b.socket.on('session-devices',original);
    const stop = b.adapter.subscribeVisibilityChanges(() => { updates++; });
    b.socket.emit('session-devices'); assert.equal(updates,1);
    stop(); b.socket.emit('session-devices'); assert.equal(updates,1);
    b.documentEvents.emit('tunnel-socket-ready'); assert.equal(updates,1,'the stopped observer also releases its socket-ready lifecycle listener');
    assert.ok(b.socket.listeners('session-devices').includes(original),'the tunnel core listener remains installed');
});

test('a late empty list response cannot replace the latest nonempty discovery result', async () => {
    const source = read('client/streaming-console.js'), pending = [], list = {children:[],replaceChildren(){this.children=[];},append(node){this.children.push(node);}};
    const node = () => ({dataset:{},children:Array.from({length:6},()=>({classList:{add(){}}})),classList:{add(){}},setAttribute(){},remove(){},prepend(){},append(){},querySelector(){return node();}});
    const context = {listRequest:0,renderVersion:1,ui:{view:'discover'},account:() => 'alice',currentUser:{id:'alice'},discoveryTimes:{},
        request:() => new Promise(resolve => pending.push(resolve)),main:{querySelector:() => list,append(){}},lastList:[],t:value => value,localStorage:{setItem(){}},key:String,userText:String,stateLabel:String,
        button:node,coverImage:node,document:{createElement:node}};
    const start = source.indexOf('    async function refreshList(');
    vm.runInNewContext(source.slice(start,source.indexOf('    async function createStation(',start))+';this.refresh=refreshList;',context);
    const older=context.refresh(), newer=context.refresh();
    pending[1]({stations:[{id:'station',name:'Station',playback:{status:'playing'}}]}); await newer;
    assert.equal(context.lastList[0].id,'station');
    pending[0]({stations:[]}); await older;
    assert.equal(context.lastList[0].id,'station');
    assert.equal(list.children.length,1);
});
