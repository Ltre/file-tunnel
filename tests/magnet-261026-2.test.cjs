'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), crypto = require('node:crypto');
const express = require('express');
const code = fs.readFileSync('server.js', 'utf8');
const section = (a,b) => code.slice(code.indexOf(a),code.indexOf(b,code.indexOf(a)));
test('magnet registration accepts the same asset IDs as tunnel file transfers, without granting unrelated access', async t => {
    const app = express(); app.use(express.json());
    const deviceId = crypto.randomUUID(), sessionId = crypto.randomUUID(), session = { devices:new Map([[deviceId,{deviceName:'fixture'}]]),fileAssets:new Map() }, saved=[];
    const context = { app, console, sessions:new Map([[sessionId,session]]),deviceSockets:new Map([[deviceId,{}]]),magnets:new Map(),MAX_MAGNETS:100,
        MAX_MAGNET_FILE_ASSET_SIZE:8*1024**3, cleanupExpiredMagnets(){}, tunnelAccess:{verify:(grant,s,d)=>grant==='fixture-grant'&&s===sessionId&&d===deviceId},
        infraStore:{findMagnet:()=>null,saveMagnet:value=>saved.push(value)},createMagnetId:()=>crypto.randomUUID(),historyLog(){},sanitizeString:String,
        getHttpClientIp:()=> 'fixture',getRequestBaseUrl:req=>'http://'+req.get('host') };
    vm.runInNewContext(section('function isValidSessionId(', 'function normalizeShortCode(')+section('function isValidDeviceId(', 'function isValidEditorAsset(')+section('function isValidServerAssetId(', 'function isTelegramBotOriginAsset(')+section('function isValidMagnetAssetPayload(', 'function getRequestBaseUrl(')+section('function getLiveSeedDevices(', 'function cleanupExpiredMagnets(')+section("app.post('/api/magnets',", "app.get('/api/magnets',"),context);
    const server=await require('./support/listen-http.cjs').listenHttp(app); t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    const send=async(fileId,grant='fixture-grant')=>{const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/magnets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,deviceId,accessGrant:grant,fileId,asset:{id:fileId,name:'fixture.png',type:'image/png',size:68}})});return {status:response.status,body:await response.json()};};
    for(const fileId of [crypto.randomUUID(),'server_asset_0123456789abcdef']) {
        const result=await send(fileId);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.asset.id,fileId);
    }
    assert.equal((await send('server_asset_0123456789abcdef','bad')).status,403);
    assert.equal((await send('../not-an-asset')).status,400);assert.equal(saved.length,2);
});
