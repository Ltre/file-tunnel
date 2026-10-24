'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr2t-261024-')); t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); }); return dir; }

test('manual categories persist independently from execution and retain the complete cache ownership list', t => {
    const dataDir = temporary(t);
    for (const [kind, create] of [['sns', require('../server/sns-downloader').createSnsDownloadService], ['youtube-premium', require('../server/youtube-premium').createYoutubePremiumService]]) {
        fs.writeFileSync(path.join(dataDir, kind === 'sns' ? 'sns-download-tasks.json' : kind + '-tasks.json'), JSON.stringify([
            { id:'completed', status:'completed', createdAt:1, completedAt:10, remark:'keep' }, { id:'failed', status:'failed', createdAt:2, completedAt:11 }
        ]));
        const options = { dataDir, analyze:async () => { throw Error('not used'); }, download:async () => { throw Error('not used'); } };
        const service = create(options);
        assert.equal(service.list(1, 10, 'pending').total, 2);
        service.updateDetails('failed', { handled: true });
        assert.equal(service.get('failed').status, 'failed'); assert.equal(service.get('failed').completedAt, 11);
        assert.deepEqual(service.list(1, 10, 'pending').tasks.map(item => item.id), ['completed']);
        assert.deepEqual(service.list(1, 10, 'handled').tasks.map(item => item.id), ['failed']);
        assert.equal(service.list(1, 10, 'pending').ids.length, 2); assert.equal(service.list().total, 2);
        assert.equal(create(options).get('failed').handled, true);
        assert.throws(() => service.updateDetails('failed', { handled: 'false' }), /布尔/);
    }
});

test('admin entry requires admin authorization and reuses signed admission without claiming another device identity', async t => {
    const gate = require('../server/tunnel-access').createTunnelAccess(temporary(t));
    const app = require('express')(), id = crypto.randomUUID(); let code = 'AB123';
    const source = read('server.js'), start = source.indexOf("app.get('/api/sessions/:sessionId/enter'");
    vm.runInNewContext(source.slice(start, source.indexOf("app.post('/api/tunnel-join-links'", start)), {
        app, adminAuth:{ requireAuth:(req,res,next) => req.get('X-Fixture-Admin') === 'yes' ? next() : res.sendStatus(403) },
        isValidSessionId: value => /^[a-f0-9-]{36}$/.test(value), infraStore:{ findShortCodeForSession:value => value === id ? code : '' }, sessions:new Map(), tunnelAccess:gate, encodeURIComponent
    });
    const server = await require('./support/listen-http.cjs').listenHttp(app); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = (value, admin = true) => fetch(base + '/api/sessions/' + value + '/enter', { redirect:'manual', headers:admin ? {'X-Fixture-Admin':'yes'} : {} });
    assert.equal((await request(id, false)).status, 403); assert.equal((await request('invalid')).status, 400); assert.equal((await request(crypto.randomUUID())).status, 404);
    const response = await request(id); assert.equal(response.status, 302); assert.equal(response.headers.get('cache-control'), 'no-store');
    const url = new URL(response.headers.get('location'), base), token = url.searchParams.get('tunnel_join'); assert.equal(url.hash, '#' + id);
    const device = crypto.randomUUID(), admission = gate.authorize(id, device, { joinToken:token, code }); assert.equal(admission.deviceId, device); assert.ok(gate.verify(admission.grant, id, device));
    assert.equal(gate.verify(admission.grant, id, crypto.randomUUID()), false);
    code = 'CD456'; assert.equal(gate.verifyJoin(token, id, code), false);
});

test('server details omit browser traffic while ordinary upload details remain unchanged', () => {
    const source = read('client/disk-ui.js'), start = source.indexOf('function diskUploadProgressLines(');
    const format = vm.runInNewContext('(' + source.slice(start, source.indexOf('function initDiskLoading(', start)) + ')', { window:{}, formatFileSize: value => value + ' B' });
    const browser = format({ clientBytesReceived:2, clientTotalBytes:4, clientFileName:'browser.txt', clientFileIndex:1, clientPartCount:2 });
    assert.match(browser.join('\n'), /浏览器 → 服务器 · 2 B\/4 B · 50.00%/);
    const server = format({ transferMode:'server', sourceBytesRead:3, sourceTotalBytes:6, sourceFileName:'server.txt', sourcePartIndex:1, sourcePartCount:2, clientBytesReceived:6, clientTotalBytes:6, telegramBytesSent:2, telegramTotalBytes:6 });
    assert.match(server.join('\n'), /服务端读取成品 · 3 B\/6 B · 50.00%/); assert.match(server.join('\n'), /服务器 → Telegram/); assert.doesNotMatch(server.join('\n'), /浏览器/);
});

test('pending banner hides an active transfer but retains records which can be resumed', async () => {
    class Node { constructor() { this.children = []; } append(...nodes) { this.children.push(...nodes); } querySelector() { return null; } }
    const target = new Node(), source = read('client/disk-ui.js'), start = source.indexOf('async function showTelegramDrivePendingSaveBanner(');
    const run = vm.runInNewContext('(' + source.slice(start, source.indexOf('async function choosePendingSaveTarget(', start)) + ')', {
        window:{DiskPendingSave:{isActive:id => id === 'uploading', list:async () => [...['pending','uploading','completed','cancelled'].map(status => ({id:status,status,file:{name:status,size:1}})),{id:'old',status:'uploading',file:{name:'old',size:1}}]}},
        document:{getElementById:() => target, createElement:() => new Node()}, formatFileSize:String
    });
    await run(); assert.equal(target.children.length, 1); assert.equal(target.children[0].children.length, 2);
    assert.match(target.children[0].children[0].children[0].textContent, /pending/);
});

test('source metadata shows video and audio properties without exposing the probe source URL', () => {
    const source = read('client/media-library.js'), start = source.indexOf('    function sourceMetadata('), opened = new Set();
    const el = (_tag, text) => ({text:text || '',children:[],append(...nodes){this.children.push(...nodes);}});
    const render = vm.runInNewContext('(' + source.slice(start, source.indexOf('    function renderSessions(', start)) + ')', {el,sourceMetadataOpen:opened});
    const resource = {id:'video',probe:{format:{filename:'http://private-source/credential',bit_rate:'1234',size:'1000'},streams:[
        {codec_type:'video',width:1920,height:1080,codec_name:'h264',color_space:'bt709'}, {codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2,tags:{language:'jpn'}}
    ]}};
    const flatten = node => node.text + node.children.map(flatten).join(' '), first = render(resource), text = flatten(first);
    for (const value of ['1920','1080','h264','bt709','aac','48000','jpn','1234']) assert.ok(text.includes(value));
    assert.doesNotMatch(text, /private-source|credential/);
    first.open = true; first.ontoggle(); assert.equal(render(resource).open, true);
});

test('watch and control navigation retains one viewing membership and leaving both releases it', () => {
    const source = read('client/streaming-console.js'), start = source.indexOf('    function navigate('); let closed = 0;
    const players = new Map([['station:alice',{close:() => closed++}]]), ui = {view:'watch',stationId:'station'};
    const navigate = vm.runInNewContext('(' + source.slice(start, source.indexOf('    function returnToList(', start)) + ')', {
        players, ui, account:() => 'alice', dirty:() => false, saveUi() {}, render() {}
    });
    navigate('control','station'); navigate('watch','station'); assert.equal(closed,0); assert.equal(players.size,1);
    navigate('discover'); assert.equal(closed,1); assert.equal(players.size,0);
});
