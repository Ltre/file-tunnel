'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const express = require('express'), { Server } = require('socket.io');
const { registerFileAssetHandlers } = require('../server/file-assets');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root = path.resolve(__dirname, '..'), appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8'), serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

test('equal-size ordinary and SNS browser caches retain the same real P2P route and byte result', async t => {
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ids = ['00000000-0000-4000-8000-000000000001', 'ffffffff-ffff-4fff-8fff-ffffffffffff'];
    const devices = new Map(), sessions = new Map([[sessionId, { devices, fileAssets: new Map() }]]), deviceSockets = new Map(), serverEvents = [];
    const app = express();
    app.use('/client', express.static(path.join(root, 'client')));
    app.get('/', (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><script src="/socket.io/socket.io.js"></script><script src="/client/file-assets.js"></script><script>
        const state={deviceId:new URLSearchParams(location.search).get('id'),peers:new Map(),dataChannels:new Map(),pendingIceCandidates:new Map(),devices:new Map(),socket:io()},peerSignalQueues=new Map(),editorAssetP2PUnavailablePeers=new Map(),EDITOR_ASSET_P2P_COOLDOWN=5000;
        const cache=new Map(),events=[],progress=[],historyLog=(event,details)=>events.push({event,details});let fileAssetTransfer;
        function handleDataChannelMessage(){} function setupEditorAssetDataChannel(){}
        ${section(appSource, '// ==================== WebRTC P2P ====================', '// ==================== Editor image assets ====================')}
        const transfer=fileAssetTransfer=new FileAssetTransfer({getSocket:()=>state.socket,getSessionId:()=>${JSON.stringify(sessionId)},getPeer:id=>state.peers.get(id),connectPeer:connectToPeerForFileAsset,ensurePeerOffer:ensurePeerOfferForFileAsset,
            load:async id=>cache.get(id),store:async file=>cache.set(file.id,file),onProgress:(id,name,percent,transport)=>progress.push({id,percent,transport,at:performance.now()}),log:(event,details)=>events.push({event,details}),onReceived(){},onUnavailable(){}});
        state.socket.on('connect',()=>state.socket.emit('join-session',{deviceId:state.deviceId}));state.socket.on('session-history',()=>window.ready=true);state.socket.on('signal',queuePeerSignal);
        for(const [event,method]of Object.entries({request:'handleRequest',available:'handleAvailable',manifest:'handleManifest',unavailable:'handleUnavailable','transfer-status':'handleTransferStatus','relay-start':'handleRelayStart','relay-chunk':'handleRelayChunk','relay-complete':'handleRelayComplete'}))state.socket.on('file-asset-'+event,(data,ack)=>Promise.resolve(transfer[method](data)).then(value=>ack?.(value||{ok:true}),error=>ack?.({ok:false,reason:error.message})));
        window.fixture={state,transfer,cache,events,progress,async provide(id,size,sns){const file={id,name:id+'.mp4',size,type:'video/mp4',ownerDeviceId:state.deviceId,isFileAsset:true,isAsset:!sns,...(sns?{isServerAsset:true,serverAssetUrl:'/api/server-assets/'+id,sourceChannel:'sns-download'}:{}),data:Uint8Array.from({length:size},(_,n)=>n%251).buffer};cache.set(id,file);await transfer.announce(file);},async request(id,size,sns,from){state.devices.set(from,{});await transfer.request(id,from,{id,name:id+'.mp4',size,type:'video/mp4',ownerDeviceId:from,isAsset:!sns,...(sns?{isServerAsset:true,serverAssetUrl:'/api/server-assets/'+id,sourceChannel:'sns-download'}:{})});}};
    </script>`));
    const http = app.listen(0, '127.0.0.1'); await new Promise(resolve => http.once('listening', resolve));
    const io = new Server(http), base = 'http://127.0.0.1:' + http.address().port;
    t.after(() => { io.close(); http.closeAllConnections(); });
    io.on('connection', socket => {
        let deviceId = '';
        socket.on('join-session', data => { deviceId = data.deviceId; devices.set(deviceId, {}); deviceSockets.set(deviceId, socket); socket.join(sessionId); socket.emit('session-history', { messages: [] }); });
        const context = { socket, deviceSockets, emitSocketError: (name, message) => socket.emit(name, { message }), isValidDeviceId: value => ids.includes(value), setTimeout, Date, console };
        Object.defineProperty(context, 'currentDevice', { get: () => deviceId });
        vm.runInNewContext(section(serverSource, '    let messageCount = 0;', "    socket.on('register-profile-device'") + section(serverSource, "    socket.on('signal', (data) => {", '    // 消息转发'), context);
        registerFileAssetHandlers(socket, { sessions, deviceSockets, getSessionId: () => sessionId, getDeviceId: () => deviceId, isValidId: value => typeof value === 'string' && !!value,
            sanitize: String, historyLog: (event, details) => serverEvents.push({ event, details }) });
    });
    const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
    const a = await browser.newPage(), b = await browser.newPage({ isMobile: true, viewport: { width: 390, height: 844 } });
    await Promise.all([a.goto(base + '/?id=' + ids[0]), b.goto(base + '/?id=' + ids[1])]);
    await Promise.all([a.waitForFunction(() => window.ready), b.waitForFunction(() => window.ready)]);
    const samples = [], size = 4 * 1024 * 1024;
    for (const [index, sns] of [false, true, true, false].entries()) {
        const id = index.toString(16).padStart(8, '0') + '-0000-4000-8000-000000000000';
        await a.evaluate(({ id, size, sns }) => fixture.provide(id, size, sns), { id, size, sns });
        await b.evaluate(({ id, size, sns, from }) => fixture.request(id, size, sns, from), { id, size, sns, from: ids[0] });
        try { await b.waitForFunction(id => fixture.cache.has(id), id, { timeout: 20000 }); }
        catch (error) { for (const [name, page] of [['sender', a], ['receiver', b]]) t.diagnostic(JSON.stringify({ name, events: await page.evaluate(() => fixture.events.slice(-20)) })); throw error; }
        const result = await b.evaluate(id => { const file = fixture.cache.get(id), bytes = new Uint8Array(file.data), rows = fixture.progress.filter(row => row.id === id);
            return { valid: bytes.every((value, n) => value === n % 251), bytes: bytes.length, routes: [...new Set(rows.map(row => row.transport).filter(value => value === 'p2p' || value === 'socket-relay'))], bodyElapsedMs: rows.at(-1).at - rows.find(row => row.percent > 0).at }; }, id);
        assert.equal(result.valid, true); assert.equal(result.bytes, size); assert.deepEqual(result.routes, ['p2p']); samples.push({ sns, ...result });
    }
    assert.equal(serverEvents.filter(row => row.event === 'file-asset-relay-started').length, 0);
    t.diagnostic(JSON.stringify({ environment: 'isolated local Chrome, memory cache, 4 MiB sequential samples', samples }));
});
