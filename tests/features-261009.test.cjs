'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const express = require('express');
const { createDiskPartCache } = require('../server/disk-part-cache');
const { createDiskAPI } = require('../server/disk-api');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskOperations } = require('../server/disk-operations');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
async function until(check) {
    for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('state did not settle');
}
function temp(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-261009-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }

test('最后一个下载者取消后停止共享生产者并删除半成品，后续读取可重建', { timeout: 5000 }, async t => {
    const dataDir = temp(t), cache = createDiskPartCache({ dataDir });
    const controller = new AbortController(); let upstreamSignal;
    const stream = await cache.open({ key:'cancel-window', size:128 * 1024, signal:controller.signal, cancelWhenUnused:true, source:async signal => {
        upstreamSignal = signal;
        return new Readable({ read() {} });
    } });
    const result = collect(stream);
    await until(() => upstreamSignal);
    controller.abort();
    await assert.rejects(result, /OPERATION_CANCELLED/);
    await until(() => cache.inflightCount() === 0);
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(fs.readdirSync(path.join(dataDir, 'telegram-part-cache')).some(name => /\.(tmp|part)$/.test(name)), false);
    assert.equal((await collect(await cache.open({ key:'cancel-window', size:3, source:() => Readable.from(['new']) }))).toString(), 'new');
});

test('并行分享下载取消其中一个不会中断另一个读者或重复回源', { timeout: 5000 }, async t => {
    const cache = createDiskPartCache({ dataDir:temp(t) }), controller = new AbortController();
    let releaseSource, upstreamSignal, calls = 0;
    const gate = new Promise(resolve => { releaseSource = resolve; });
    t.after(() => releaseSource());
    const prefix = Buffer.alloc(64 * 1024, 'a'), suffix = Buffer.alloc(64 * 1024, 'b');
    const source = signal => {
        calls++; upstreamSignal = signal;
        return Readable.from((async function* () { yield prefix; await gate; yield suffix; })());
    };
    const first = await cache.open({key:'shared-cancel',size:prefix.length+suffix.length,source,cancelWhenUnused:true,signal:controller.signal});
    const second = await cache.open({key:'shared-cancel',size:prefix.length+suffix.length,source,cancelWhenUnused:true});
    const remaining = collect(second), iterator = first[Symbol.asyncIterator]();
    assert.deepEqual(Buffer.from((await iterator.next()).value), prefix);
    controller.abort();
    await assert.rejects(iterator.next(), /OPERATION_CANCELLED/);
    assert.equal(upstreamSignal.aborted, false);
    releaseSource();
    assert.deepEqual(await remaining, Buffer.concat([prefix,suffix]));
    await until(() => cache.inflightCount() === 0);
    assert.equal(calls, 1);
});

test('分享下载真实 HTTP 断开向 Telegram 上游传递取消，不继续填充缓存', { timeout: 10000 }, async t => {
    const dataDir = temp(t), auth = createDiskAuth({ dataDir }), owner = auth.fromTelegram({ id:'261009' });
    const store = createTelegramDriveStore({ dataDir }), size = 1024 * 1024;
    const staged = store.begin({ owner, folderPath:'', files:[{ name:'download.bin', size }], maxDepth:20 });
    await store.receive(staged.id, 0, Readable.from([Buffer.alloc(size)]));
    const [file] = store.commit(staged.id, '-1001', [{ fileId:'remote', messageId:1 }]);
    let upstreamSignal, emitted = 0, source;
    const telegram = {
        parts:() => [{ fileId:'remote', size, offset:0 }],
        readPart:async (_backend, _part, { signal }) => {
            upstreamSignal = signal;
            source = new Readable({ read() {} });
            const timer = setInterval(() => { emitted += 64 * 1024; source.push(Buffer.alloc(64 * 1024)); if (emitted === size) { clearInterval(timer); source.push(null); } }, 25);
            source.once('close', () => clearInterval(timer));
            return source;
        }
    };
    const api = createDiskAPI({ dataDir, defaultStore:store, auth, operations:createDiskOperations({ dataDir }), telegram,
        getDefaultBackend:() => ({ token:'fake', channelId:'-1001' }), getIdentity:() => owner, setIdentity() {}, getOrigin:() => 'http://localhost', maxDepth:() => 20 });
    t.after(() => { source?.destroy(); api.close(); });
    const app = express(); app.use(express.json()); app.use('/drive', api.browser); app.use('/share', api.shared);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base + '/drive/shares', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ items:[{ kind:'file', id:file.id }] }) });
    assert.equal(response.status, 201);
    const share = await response.json(), controller = new AbortController();
    const download = await fetch(`${base}/share/${share.url.split('/').pop()}/files/${file.id}/download`, { signal:controller.signal });
    assert.equal(download.status, 200);
    const reader = download.body.getReader(); assert.ok((await reader.read()).value.length);
    controller.abort();
    await until(() => upstreamSignal?.aborted && source.destroyed);
    const stoppedAt = emitted;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(emitted, stoppedAt, '取消后的持续回源流量必须停止');
    assert.ok(emitted < size);
    await until(() => !fs.readdirSync(path.join(dataDir, 'telegram-part-cache')).some(name => /\.(tmp|part)$/.test(name)));
});

test('网页另存为深拷贝整包和发布设置，清除原记录关联并更新 manifest', () => {
    const window = {};
    vm.runInNewContext(read('client/web-workshop.js'), { window, Uint8Array, TextEncoder, TextDecoder, Blob, Map, Set, Date, Math, String, Number, Object, Array, RegExp, Error, Promise, URL, setTimeout, clearTimeout });
    const oldTime = '2020-01-01T00:00:00.000Z';
    const original = { id:'original', name:'原网页', sourceFileId:'file-original', sourceMessageId:'record-original', sourceFileInfo:{id:'file-original'}, publishMode:'update',
        webZipHideFrame:true, webZipFullscreen:true, createdAt:Date.parse(oldTime), files:[
            {path:'assets/',type:'application/x-directory'},
            {path:'assets/图片.png',type:'image/png',data:new Uint8Array([1,2,3])},
            {path:'index.html',type:'text/html',data:new TextEncoder().encode('刚刚编辑的正文')},
            {path:'manifest.json',type:'application/json',data:new TextEncoder().encode(JSON.stringify({createdAt:oldTime,extra:'retain'}))}
        ] };
    const copy = window.WebWorkshop._test.createDraftCopy(original, '独立网页.html.zip');
    assert.notEqual(copy.id, original.id); assert.equal(copy.name, '独立网页');
    assert.equal(copy.publishMode, 'new'); assert.equal(copy.sourceFileId, ''); assert.equal(copy.sourceMessageId, ''); assert.equal(copy.sourceFileInfo, null);
    assert.equal(copy.webZipHideFrame, true); assert.equal(copy.webZipFullscreen, true);
    assert.equal(copy.files.length, original.files.length);
    copy.files.find(file => file.path.endsWith('.png')).data[0] = 9;
    assert.equal(original.files[1].data[0], 1);
    const manifest = window.WebWorkshop._test.readPackageManifest(copy.files);
    assert.equal(manifest.fileName, '独立网页.html.zip'); assert.equal(manifest.extra, 'retain'); assert.notEqual(manifest.createdAt, oldTime);
    assert.equal(original.publishMode, 'update'); assert.equal(original.sourceMessageId, 'record-original');
});

test('挂载成功定位目标分区和目录，醒目标记仅持续约一秒', async () => {
    const source = read('client/disk-ui.js');
    const code = source.slice(source.indexOf('async function locateTelegramDriveMount('), source.indexOf('async function openTelegramDriveMount('));
    const navigated = [], timers = [], classes = new Set(); let space = '';
    const context = vm.createContext({ window:{DiskClient:{getSpace:()=>space}},
        switchTelegramDrivePartition:async target=>{space=target;}, clearTelegramDriveSearch(){}, clearTelegramDriveSelection(){},
        navigateTelegramDrive:async target=>navigated.push(target),
        document:{querySelectorAll:()=>[{dataset:{mountId:'new-mount'},scrollIntoView(){},classList:{add:n=>classes.add(n),remove:n=>classes.delete(n)}}]},
        setTimeout:(callback,ms)=>timers.push({callback,ms}) });
    vm.runInContext(code,context);
    await vm.runInContext('locateTelegramDriveMount({id:"new-mount",diskSpace:"媒体分区",parentPath:"资料/共享"})',context);
    assert.equal(space, '媒体分区'); assert.deepEqual(navigated,['资料/共享']);
    assert.equal(classes.has('disk-search-located'),true); assert.equal(timers[0].ms,1000);
    timers[0].callback(); assert.equal(classes.size,0);
});

test('协同列表跨分区操作使用独立请求作用域，不改变当前浏览分区', async () => {
    const window = {}, requests = [];
    vm.runInNewContext(read('client/disk-client.js'), {window,URL,location:{origin:'http://localhost'},
        localStorage:{getItem:()=>null,setItem(){}}, setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout,
        fetch:async (url,options)=>{requests.push({url,options});return{ok:true,json:async()=>({operations:[]})};}});
    window.DiskClient.setSpace('媒体分区'); window.DiskClient.stop();
    await window.DiskClient.raw('/collaborations/default-grant',{method:'DELETE',diskSpace:''});
    await window.DiskClient.raw('/collaborations/other-grant',{method:'DELETE',diskSpace:'另一分区'});
    const deletions = requests.filter(r=>r.options.method==='DELETE');
    assert.equal(deletions[0].url,'/api/telegram/drive/collaborations/default-grant');
    assert.equal(new URL(deletions[1].url,'http://localhost').searchParams.get('disk_space'),'另一分区');
    assert.equal('diskSpace' in deletions[1].options,false);
    assert.equal(window.DiskClient.getSpace(),'媒体分区');
});
