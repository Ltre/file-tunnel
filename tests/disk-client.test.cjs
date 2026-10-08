'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('摘要进度进入任务列表，缺少 WebCrypto 的持有证明退回完整上传',async()=>{
    const window={},requests=[],snapshots=[];let finished=false;
    const Worker=class {postMessage(){queueMicrotask(()=>{this.onmessage({data:{bytes:2}});this.onmessage({data:{sha256:'a'.repeat(64)}});});}terminate(){}};
    const fetch=async(url,options={})=>{
        requests.push({url,options});let data={};
        if(url.endsWith('/content/preflight'))data={files:[{status:'proof',ticket:'challenge'}]};
        if(url.endsWith('/uploads'))data={uploadId:'u',operation_id:'op',files:[{reused:false}]};
        if(url.endsWith('/finish')){finished=true;data={operation_id:'op'};}
        if(url.includes('/operations?'))data={operations:[{operation_id:'op',status:finished?'completed':'running',result:{items:[{id:'file'}]}}]};
        return {ok:true,json:async()=>data};
    };
    vm.runInNewContext(source('client/disk-client.js'),{window,fetch,Worker,queueMicrotask,AbortController,console,setInterval(){},Date,Map,Set,Promise,encodeURIComponent});
    window.DiskClient.subscribe(jobs=>snapshots.push(...jobs.map(job=>({...job}))));
    await window.DiskClient.upload([{name:'local.bin',size:4}], '',async()=>new Blob(['abcd']));
    assert.ok(snapshots.some(job=>job.phase==='content-hashing' && job.hashedBytes===2 && job.hashTotalBytes===4 && job.percent===50));
    assert.equal(requests.filter(request=>request.options.method==='PUT').length,1);
    assert.equal(requests.some(request=>request.url.endsWith('/content/proof')),false);
    assert.equal(requests.filter(request=>request.url.endsWith('/content/release')).length,1);
});

test('持有证明逐个样本回显进度，不把本地摘要计为网络上传量',async()=>{
    const {webcrypto}=require('node:crypto'),window={},requests=[],snapshots=[];let finished=false;
    const Worker=class {postMessage(){queueMicrotask(()=>this.onmessage({data:{sha256:'a'.repeat(64)}}));}terminate(){}};
    const fetch=async(url,options={})=>{
        requests.push({url,options});let data={};
        if(url.endsWith('/content/preflight'))data={files:[{status:'proof',ticket:'challenge',nonce:'00'.repeat(32),ranges:[{offset:0,size:2},{offset:2,size:2}]}]};
        if(url.endsWith('/content/proof'))data={status:'reuse',reuseTicket:'reuse'};
        if(url.endsWith('/uploads'))data={uploadId:'u',operation_id:'op',files:[{reused:true}]};
        if(url.endsWith('/finish')){finished=true;data={operation_id:'op'};}
        if(url.includes('/operations?'))data={operations:[{operation_id:'op',status:finished?'completed':'running',result:{items:[{id:'file'}]}}]};
        return {ok:true,json:async()=>data};
    };
    vm.runInNewContext(source('client/disk-client.js'),{window,fetch,Worker,crypto:webcrypto,TextEncoder,queueMicrotask,AbortController,console,setInterval(){},Date,Map,Set,Promise,encodeURIComponent});
    window.DiskClient.subscribe(jobs=>snapshots.push(...jobs.map(job=>({...job}))));
    await window.DiskClient.upload([{name:'local.bin',size:4}], '',async()=>new Blob(['abcd']));
    const messages=snapshots.filter(job=>job.phase==='content-proof').map(job=>job.message);
    for(const progress of ['0/2','1/2','2/2'])assert.ok(messages.some(message=>message.includes(progress)),progress);
    assert.ok(snapshots.filter(job=>job.phase==='content-proof').every(job=>!job.clientBytesReceived && job.percent===null));
    assert.equal(requests.filter(request=>request.options.method==='PUT').length,0);
    assert.equal(JSON.parse(requests.find(request=>request.url.endsWith('/content/proof')).options.body).digests.length,2);
});

test('全命中浏览器不发送正文；Worker 失败仍可普通上传',async()=>{
    for(const failWorker of [false,true]) {
        const window={},requests=[];let finished=false;
        const Worker=class {postMessage(){queueMicrotask(()=>failWorker ? this.onerror() : this.onmessage({data:{sha256:'b'.repeat(64)}}));}terminate(){}};
        const fetch=async(url,options={})=>{
            requests.push({url,options});let data={};
            if(url.endsWith('/content/preflight'))data={files:[{status:'reuse',reuseTicket:'ticket'}]};
            if(url.endsWith('/uploads'))data={uploadId:'u',operation_id:'op',files:[{reused:!failWorker}]};
            if(url.endsWith('/finish')){finished=true;data={operation_id:'op'};}
            if(url.includes('/operations?'))data={operations:[{operation_id:'op',status:finished?'completed':'running',result:{items:[{id:'file'}]}}]};
            return {ok:true,json:async()=>data};
        };
        vm.runInNewContext(source('client/disk-client.js'),{window,fetch,Worker,queueMicrotask,AbortController,console:{warn(){}},setInterval(){},Date,Map,Set,Promise,encodeURIComponent});
        await window.DiskClient.upload([{name:'local.bin',size:4}], '',async()=>new Blob(['abcd']));
        assert.equal(requests.filter(request=>request.options.method==='PUT').length,failWorker?1:0);
        assert.equal(requests.some(request=>request.url.endsWith('/content/preflight')),!failWorker);
    }
});

test('浏览器缓存进度按实际收到的流字节从零计算', async () => {
    const snapshots = [], stored = [];
    const window = {
        TelegramDriveCache: { get: async () => null, put: async (_id, value) => stored.push(value) },
        dispatchEvent() { snapshots.push({ ...window.DiskClient.cacheProgress('file-1') }); }
    };
    const parts = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const fetch = async () => ({
        ok: true,
        headers: { get: name => name === 'Content-Length' ? '4' : '' },
        body: { getReader: () => ({ read: async () => parts.length ? { done: false, value: parts.shift() } : { done: true } }) }
    });
    vm.runInNewContext(source('client/disk-client.js'), { window, fetch, setInterval() {}, Blob, CustomEvent: class {}, Date, Map, Set, Promise, encodeURIComponent });
    const result = await window.DiskClient.read({ id: 'file-1', name: 'file.bin', size: 4 });
    assert.equal(result.size, 4);
    assert.equal(stored.length, 1);
    assert.deepEqual(snapshots.filter(item => item.phase === 'browser').map(item => item.percent), [0, 50, 100]);
});

test('large uploads wait through small queue probes and never hold another PUT while Telegram queue is full', async () => {
    const size = 120000000, window = {}, requests = []; let finished = false, putCount = 0, probes = 0, full = false;
    const blob = { size, slice: (start, end) => ({ size: end - start }) };
    const fetch = async (url, options = {}) => {
        requests.push({ url, method: options.method || 'GET' }); let data = {};
        if (url.endsWith('/uploads')) data = { uploadId: 'u', operation_id: 'op', uploadQueueCheck: true, queue: { pendingParts: 0, pendingBytes: 0 } };
        if (url.endsWith('/queue')) { probes++; full = probes < 2; data = { ready: !full, retryAfterMs: 250, queue: { pendingParts: full ? 5 : 0, pendingBytes: full ? 100000000 : 0 } }; }
        if (options.method === 'PUT') { assert.equal(full, false, 'body must not be sent during queue wait'); putCount++; full = putCount === 5; data = { queue: { pendingParts: full ? 5 : 0, pendingBytes: full ? 100000000 : 0 } }; }
        if (url.endsWith('/finish')) { finished = true; data = { operation_id: 'op' }; }
        if (url.includes('/operations?')) data = { operations: [{ operation_id: 'op', status: finished ? 'completed' : 'running', result: { items: [{ id: 'file' }] } }] };
        return { ok: true, json: async () => data };
    };
    vm.runInNewContext(source('client/disk-client.js'), { window, fetch, setInterval() {}, setTimeout: fn => setTimeout(fn, 1), clearTimeout, Date, Map, Set, Promise, encodeURIComponent });
    await window.DiskClient.upload([{ name: 'large.bin', size }], '', async () => blob);
    assert.equal(putCount, 6); assert.equal(probes, 2);
    assert.equal(requests.filter(request => request.url.endsWith('/queue')).every(request => request.method === 'GET'), true);
});

test('Failed to fetch reports a durable network failure without invoking the user-cancel DELETE path', async () => {
    const window = {}, requests = [];
    const fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (url.endsWith('/uploads')) return { ok: true, json: async () => ({ uploadId: 'u', operation_id: 'op' }) };
        if (options.method === 'PUT') throw new TypeError('Failed to fetch');
        return { ok: true, json: async () => ({ operations: [] }) };
    };
    vm.runInNewContext(source('client/disk-client.js'), { window, fetch, setInterval() {}, Date, Map, Set, Promise, encodeURIComponent });
    await assert.rejects(window.DiskClient.upload([{ name: 'small.bin', size: 3 }], '', async () => ({ size: 3, slice: () => ({ size: 3 }) })), /UPLOAD_CLIENT_NETWORK_ERROR/);
    assert.equal(requests.some(request => request.options.method === 'DELETE'), false);
    const failure = requests.find(request => request.url.endsWith('/failure'));
    assert.equal(failure.options.method, 'POST'); assert.equal(JSON.parse(failure.options.body).errorCode, 'UPLOAD_CLIENT_NETWORK_ERROR');
});

test('轮询发现服务端失败时中止挂起 PUT，保留 ECONNRESET 而非误报用户取消', async () => {
    const window = {}, requests = []; let failed = false, putStarted;
    const active = new Promise(resolve => { putStarted = resolve; });
    const operation = () => ({ operation_id: 'op', status: failed ? 'failed' : 'running', errorCode: failed ? 'TELEGRAM_NETWORK_ERROR' : '', errorDetails: { causeCode: 'ECONNRESET' } });
    const fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (url.endsWith('/uploads')) return { ok: true, json: async () => ({ uploadId: 'u', operation_id: 'op' }) };
        if (options.method === 'PUT') {
            putStarted();
            return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })), { once: true }));
        }
        return { ok: true, json: async () => url.includes('/operations?') ? { operations: [operation()] } : url.endsWith('/operations/op') ? operation() : {} };
    };
    vm.runInNewContext(source('client/disk-client.js'), { window, fetch, AbortController, setInterval() {}, Date, Map, Set, Promise, encodeURIComponent });
    let activities; window.DiskClient.subscribeActivity(value => { activities = value; });
    const upload = window.DiskClient.upload([{ name: 'file.bin', size: 3 }], '', async () => ({ size: 3, slice: () => ({ size: 3 }) }));
    const rejected = assert.rejects(upload, error => error.message === 'TELEGRAM_NETWORK_ERROR' && error.errorDetails.causeCode === 'ECONNRESET');
    await active; failed = true; await window.DiskClient.refresh(true); await rejected;
    assert.equal(requests.some(request => request.options.method === 'DELETE'), false);
    assert.equal(activities.length, 0);
    const failure = requests.find(request => request.url.endsWith('/failure'));
    assert.equal(JSON.parse(failure.options.body).errorCode, 'TELEGRAM_NETWORK_ERROR');
});

test('服务器队列等待期间发现失败，立即中断等待计时器和活动', async () => {
    const window = {}; let timerStarted, failed = false, clears = 0;
    const delayed = new Promise(resolve => { timerStarted = resolve; });
    const fetch = async (url, options = {}) => {
        let data = {};
        if (url.endsWith('/uploads')) data = { uploadId: 'u', operation_id: 'op', uploadQueueCheck: true, queue: { pendingParts: 5, pendingBytes: 100000000 } };
        else if (url.endsWith('/queue')) data = { ready: false, retryAfterMs: 60000, queue: { pendingParts: 5, pendingBytes: 100000000 } };
        else if (url.includes('/operations')) {
            const operation = { operation_id: 'op', status: failed ? 'failed' : 'running', errorCode: 'ECONNRESET' };
            data = url.includes('?') ? { operations: [operation] } : operation;
        }
        assert.notEqual(options.method, 'PUT'); assert.notEqual(options.method, 'DELETE');
        return { ok: true, json: async () => data };
    };
    vm.runInNewContext(source('client/disk-client.js'), { window, fetch, AbortController, setInterval() {}, setTimeout() { timerStarted(); return 1; }, clearTimeout() { clears++; }, Date, Map, Set, Promise, encodeURIComponent });
    const upload = window.DiskClient.upload([{ name: 'file.bin', size: 3 }], '', async () => ({ size: 3, slice: () => ({ size: 3 }) }));
    const rejected = assert.rejects(upload, /ECONNRESET/);
    await delayed; failed = true; await window.DiskClient.refresh(true); await rejected;
    assert.equal(clears, 1);
});

test('110 MB 浏览器上传仅通过 slice 顺序发送六个请求，声明仍为逻辑文件总大小', async () => {
    const size = 115384320, chunks = [], requests = [];
    let finished = false, reads = 0;
    const blob = { size, slice(start, end) { const part = { size: end - start }; chunks.push([start, end]); return part; }, arrayBuffer() { throw new Error('must not copy the full file'); } };
    const window = {};
    const fetch = async (url, options) => {
        requests.push({ url, options }); let data = {};
        if (url.endsWith('/uploads')) data = { uploadId: 'u', operation_id: 'op', partSize: 20000000 };
        if (url.endsWith('/finish')) { finished = true; data = { operation_id: 'op' }; }
        if (url.includes('/operations?')) data = { operations: [{ operation_id: 'op', status: finished ? 'completed' : 'running', result: { items: [{ id: 'file' }] } }] };
        return { ok: true, json: async () => data };
    };
    vm.runInNewContext(source('client/disk-client.js'), { window, fetch, setInterval() {}, Date, Map, Set, Promise, encodeURIComponent });
    await window.DiskClient.upload([{ name: 'large.msi', size }], '', async () => { reads++; return blob; });
    assert.equal(reads, 1); assert.equal(chunks.length, 6);
    const puts = requests.filter(r => r.options.method === 'PUT'); assert.equal(puts.length, 6);
    assert.equal(JSON.parse(requests[0].options.body).files[0].size, size);
    puts.forEach((r, i) => {
        assert.ok(r.options.body.size <= 20000000);
        assert.equal(r.options.headers['Content-Range'], `bytes ${chunks[i][0]}-${chunks[i][1] - 1}/${size}`);
    });
});

test('PC 顶栏只在真实拖动后捕获指针，不吞掉按钮的普通点击', () => {
    const app = source('app.js'), handlers = {}, captures = [];
    const scroller = { scrollLeft: 100, addEventListener: (name, fn) => { handlers[name] = fn; }, setPointerCapture: id => captures.push(id) };
    const context = { document: { querySelector: () => scroller }, Date };
    vm.runInNewContext(app.slice(app.indexOf('function initTopbarOverflowScroll()'), app.indexOf('\nfunction applyTheme(')) + '; initTopbarOverflowScroll();', context);
    const down = { pointerType: 'mouse', button: 0, pointerId: 1, clientX: 100 };
    handlers.pointerdown(down); assert.deepEqual(captures, []); handlers.pointerup(down);
    let prevented = false;
    handlers.click({ preventDefault: () => { prevented = true; }, stopImmediatePropagation() {} }); assert.equal(prevented, false);
    handlers.pointerdown(down); handlers.pointermove({ ...down, clientX: 80, preventDefault() {} });
    assert.deepEqual(captures, [1]); assert.equal(scroller.scrollLeft, 120);
});

test('面包屑边缘滚动按时间匀速，离开区域或隐藏网盘立即停止', () => {
    const ui = source('client/disk-ui.js'), handlers = {}, frames = new Map(); let seq = 0, resized;
    const target = { scrollLeft: 200, scrollWidth: 1000, clientWidth: 400, getBoundingClientRect: () => ({ left: 0, right: 400, width: 400 }), addEventListener: (name, fn) => { handlers[name] = fn; } };
    const overlay = { hidden: false };
    const context = { document: { getElementById: id => id === 'telegramDriveBreadcrumbs' ? target : overlay }, window: { addEventListener() {} },
        requestAnimationFrame: fn => { frames.set(++seq, fn); return seq; }, cancelAnimationFrame: id => frames.delete(id),
        ResizeObserver: class { constructor(fn) { resized = fn; } observe() {} } };
    vm.runInNewContext(ui.slice(ui.indexOf('function initDiskBreadcrumbScroll()'), ui.indexOf('\nfunction getSortedTelegramDriveItems')) + '; initDiskBreadcrumbScroll();', context);
    const tick = time => { const [id, fn] = frames.entries().next().value; frames.delete(id); fn(time); };
    handlers.pointermove({ pointerType: 'mouse', clientX: 5 }); tick(100); tick(150); tick(200);
    assert.equal(target.scrollLeft, 182);
    handlers.pointermove({ pointerType: 'mouse', clientX: 395 }); tick(250); assert.equal(target.scrollLeft, 191);
    handlers.pointerleave(); assert.equal(frames.size, 0);
    handlers.pointermove({ pointerType: 'mouse', clientX: 395 }); overlay.hidden = true; tick(300); assert.equal(frames.size, 0);
    resized(); assert.equal(target.scrollLeft, 1000);
});

test('刷新后本地上传失败使用新任务 ID，不被上次错误确认记录误屏蔽', async () => {
    const ids = [];
    for (let session = 0; session < 2; session++) {
        const window = {}, jobs = [];
        vm.runInNewContext(source('client/disk-client.js'), { window, fetch: async () => { throw new Error('offline'); }, setInterval() {}, Date, Map, Set, Promise, encodeURIComponent });
        window.DiskClient.subscribe(value => jobs.push(...value));
        await assert.rejects(window.DiskClient.upload([{ name: 'x', size: 1 }], ''), error => error.message === 'UPLOAD_CLIENT_NETWORK_ERROR' && error.errorDetails.reason === 'offline');
        ids.push(jobs.find(job => job.status === 'failed').operation_id);
    }
    assert.notEqual(ids[0], ids[1]);
});
test('网盘客户端正确拼接路由、合并任务等待且仅从源读取一次上传文件', async () => {
    const calls = [], cached = [], blob = new Blob(['abc']);
    const result = { items: [{ id: 'file-1', name: 'test.txt', size: 3 }] };
    let reads = 0, finished = false;
    const window = { TelegramDriveCache: { put: async (id, value) => cached.push({ id, value }) } };
    const fetch = async (url, options) => {
        calls.push([url, options]);
        let data = {};
        if (url === '/api/telegram/drive/me') data = { identity: { id: 'user' } };
        else if (url === '/api/telegram/drive/uploads') data = { uploadId: 'upload-1', operation_id: 'op-1' };
        else if (url.endsWith('/finish')) { finished = true; data = { operation_id: 'op-1' }; }
        else if (url.includes('/operations?')) data = { operations: [{ operation_id: 'op-1', status: finished ? 'completed' : 'running', result }] };
        return { ok: true, json: async () => data };
    };
    vm.runInNewContext(source('client/disk-client.js'), { window, fetch, setInterval: () => {}, Date, Map, Set, Promise, Blob, encodeURIComponent });
    await window.DiskClient.raw('/me');
    await window.DiskClient.upload([{ name: 'test.txt', size: 3, type: 'text/plain' }], '', async () => { reads++; return blob; });
    assert.equal(reads, 1); assert.equal(cached[0].value.blob, blob);
    assert.ok(calls.every(([url]) => url.startsWith('/api/telegram/drive/')));
    assert.ok(calls.some(([url]) => url.includes('/operations?ids=op-1')));
    const [a, b] = await Promise.all([window.DiskClient.wait('op-1'), window.DiskClient.wait('op-1')]);
    assert.equal(a.items[0].id, b.items[0].id);
});
test('非 ASCII 分区名通过编码查询参数传递，不写入 HTTP 请求头', async () => {
    const calls = [], window = {};
    vm.runInNewContext(source('client/disk-client.js'), {
        window, URL, location: { origin: 'https://example.test' },
        fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({}) }; },
        setInterval: () => {}, Date, Map, Set, Promise, encodeURIComponent
    });
    window.DiskClient.setSpace('相册&照片');
    await window.DiskClient.raw('/list?path=收藏');
    const request = calls.find(entry => entry.url.includes('/list?'));
    assert.ok(request);
    const parsed = new URL(request.url, 'https://example.test');
    assert.equal(parsed.searchParams.get('disk_space'), '相册&照片');
    assert.equal(parsed.searchParams.get('path'), '收藏');
    assert.equal(request.options.headers['X-Disk-Space'], undefined);
});
test('触屏长按会打开菜单并吞掉后续单击，滑动或多点触摸取消长按', () => {
    const ui = source('client/disk-ui.js');
    const body = ui.slice(ui.indexOf('function installContextGesture'), ui.indexOf('function installDiskDrop'));
    let callback = null, cancelled = false, opened = 0, swallowed = 0;
    const listeners = {};
    const element = { addEventListener: (type, fn) => { listeners[type] = fn; } };
    const context = { setTimeout: fn => { callback = fn; cancelled = false; }, clearTimeout: () => { cancelled = true; }, Date, Math };
    vm.runInNewContext(body + '\nthis.install = installContextGesture;', context);
    context.install(element, () => opened++);
    listeners.pointerdown({ pointerType: 'touch', isPrimary: true, clientX: 10, clientY: 10 });
    callback(); assert.equal(opened, 1);
    listeners.click({ preventDefault() {}, stopImmediatePropagation() { swallowed++; } }); assert.equal(swallowed, 1);
    listeners.pointerdown({ pointerType: 'touch', isPrimary: true, clientX: 10, clientY: 10 });
    listeners.pointermove({ clientX: 30, clientY: 10 }); assert.equal(cancelled, true);
    listeners.pointerdown({ pointerType: 'touch', isPrimary: false }); assert.equal(cancelled, true);
});
test('隧道适配器传递普通 File 与目录相对路径，选定目标后不再二次确认', async () => {
    let exporter, sent, closed = false, uploadArgs, confirmations = 0;
    const window = {
        DiskUI: { setExporter: fn => { exporter = fn; }, close: () => { closed = true; }, open: async () => {}, chooseDirectory: async () => '目标目录', path: '' },
        DiskClient: { raw: async () => ({ identity: { id: 'user' } }), read: async () => new Blob(['abc']), upload: async (...args) => { uploadArgs = args; } }
    };
    vm.runInNewContext(source('client/disk-tunnel-adapter.js'), { window, File, Blob, confirm: () => { confirmations++; return true; } });
    window.DiskTunnelAdapter.configure({ target: () => 'ABCDE', send: files => { sent = files; }, readFile: () => {}, filesForRecord: () => [{ name: 'a.txt', size: 3 }] });
    await exporter([{ name: 'a.txt', type: 'text/plain', relativePath: 'album/a.txt' }, { name: 'b.txt', type: 'text/plain' }]);
    assert.equal(closed, true); assert.equal(sent.length, 2); assert.equal(sent[0].relativePath, 'album/a.txt'); assert.equal(await sent[0].text(), 'abc');
    assert.equal(confirmations, 0);
    await exporter([{ name: 'only.txt', type: 'text/plain' }]); assert.equal(confirmations, 0);
    await window.DiskTunnelAdapter.save({ id: 'record' }); assert.equal(uploadArgs[1], '目标目录');
    for (const file of ['client/disk-client.js', 'client/disk-ui.js', 'server/disk-api.js', 'server/telegram-drive.js']) assert.doesNotMatch(source(file), /state\.sessionId|sendFileCollection|sourceMessageId|sourceSessionId/);
    assert.match(source('app.js'), /send: files => sendSelectedFiles\(files\)/);
});

test('右键操作保留整个选中集合，全选和反选只操作当前视图', () => {
    const ui = source('client/disk-ui.js'), context = { Map, rendered: 0 };
    const code = ui.slice(ui.indexOf('function selectTelegramDriveItems'), ui.indexOf('async function updateDiskCacheLabels'));
    vm.runInNewContext(`const telegramDriveSelected = new Map(); const telegramDriveCurrentData = {}; const files = [{id:'a'},{id:'b'},{id:'c'}]; const telegramDriveItemKey = f=>f.id; const getSortedTelegramDriveItems = ()=>files; const getTelegramDriveDisplayData = () => telegramDriveCurrentData; function renderTelegramDriveItems(){} function updateTelegramDriveSelectionBar(){}; ${code}; this.select = selectTelegramDriveItems; this.items = telegramDriveActionItems; this.chosen = telegramDriveSelected;`, context);
    context.select(); assert.equal(context.chosen.size, 3); assert.equal(context.items({ id: 'b' }).length, 3);
    context.chosen.delete('c'); context.select(true); assert.deepEqual([...context.chosen.keys()], ['c']);
    assert.equal(context.items({ id: 'unselected' })[0].id, 'unselected');
    assert.match(ui, /exportDiskItems\(chosen\)/); assert.match(ui, /row\.ondblclick/);
    assert.match(ui, /checkbox\.checked = !checkbox\.checked;[\s\S]*?toggleTelegramDriveSelection\(item, checkbox\.checked, \{ renderBar: false \}\);[\s\S]*?selectionTimer = setTimeout\([\s\S]*?updateTelegramDriveSelectionBar\(\)[\s\S]*?500\)/, '桌面单击应立即勾选，只延迟 500ms 显示选择栏');
    assert.match(ui, /row\.ondblclick = event => \{[\s\S]*?clearTimeout\(selectionTimer\)/, 'PC 双击应取消尚未执行的单击选择');
    assert.match(ui, /\['缓存到浏览器', \(\) => cacheTelegramDriveItems\(chosen\)\]/);
    assert.match(ui, /\['清理缓存', \(\) => clearTelegramDriveCache\(chosen\)\]/);
    assert.match(ui, /TelegramDriveCache\?\.remove\(tree\.files\.map\(file => file\.id\)\)/, '目录删除成功后必须递归清理浏览器缓存');
    assert.match(ui, /TelegramDriveCache\?\.remove\(\[item\.id\]\)/, '文件删除成功后必须清理对应浏览器缓存');
});

test('公开分享显示流式百分比、使用独立浏览器缓存并为瞬时失败重试', () => {
    const page = source('pages/disk-share.html'), client = source('client/disk-share.js'), css = source('client/disk.css');
    assert.match(page, /id="shareLoadingProgress"/); assert.match(page, /telegram-drive-cache\.js/);
    assert.match(client, /share:' \+ token \+ ':' \+ file\.id/);
    assert.match(client, /response\.body\.getReader/); assert.match(client, /for \(let attempt = 0; attempt < 2; attempt\+\+\)/);
    assert.match(client, /TelegramDriveCache\?\.put\(cacheKey/);
    assert.match(css, /#sharePreviewClose\{[^}]*background:rgba\(12,35,55/);
});

test('网盘提供最小化、目标隧道选择与上次目标记忆，管理页独立于 tgbot', () => {
    const page = source('pages/index.html'), ui = source('client/disk-ui.js'), css = source('client/disk.css'), adapter = source('client/disk-tunnel-adapter.js'), admin = source('pages/disk-management.html'), server = source('server.js');
    assert.match(page, /id="minimizeTelegramDriveBtn"/); assert.match(adapter, /telegram-drive-last-tunnel/);
    assert.match(page, /id="mobileForceRefreshBtn"[\s\S]*?id="tunnelTopbarButtonGroup"[\s\S]*?id="tunnelSettingsBtn"[\s\S]*?id="topbarDiskBtn"[\s\S]*?id="topbarMusicBtn"[\s\S]*?id="leaveTunnelBtn"/);
    assert.match(page, /topbar-now-playing-slot/); assert.match(page, /id="telegramDriveSearchAll"/);
    assert.match(page, /tunnel-topbar-scroll[\s\S]*?overflow-x: auto/);
    assert.match(source('app.js'), /function initTopbarOverflowScroll[\s\S]*?scroller\.scrollLeft = drag\.scrollLeft - dx/);
    assert.match(ui, /function minimizeTelegramDrive\([^]*?saveDiskWindow\(true\)/);
    assert.match(ui, /function closeTelegramDrive\([^]*?if \(forget\) \{ saveDiskWindow\(false\)/);
    assert.match(ui, /function saveDiskWindow\([^]*?topbarDiskBtn[^]*?button\.hidden = !retained/);
    assert.match(ui, /history\.pushState[\s\S]*?telegramDriveHistorySession/); assert.match(ui, /addEventListener\('popstate'/);
    assert.match(ui, /DiskClient\.raw\('\/search\?q=/); assert.match(ui, /telegramDriveRenderGeneration/);
    assert.match(css, /-webkit-user-select:none;user-select:none/);
    assert.match(adapter, /选择转发目标隧道/); assert.match(adapter, /【当前隧道】/); assert.match(adapter, /host\.navigate\(target\.id\)/);
    assert.match(adapter, /telegram-drive-pending-forward/); assert.match(admin, /网盘先发后审流水/); assert.match(admin, /用户与网盘分区/);
    assert.match(server, /app\.get\('\/disk-management'/); assert.match(source('pages/admin.html'), /href="\/disk-management"/);
    assert.doesNotMatch(source('pages/tgbot.html'), /disk-management\.js/);
    assert.match(source('client/disk-management.js'), /取消屏蔽/); assert.match(source('client/disk-management.js'), /diskAdminPreview/);
    assert.match(admin, /缩略图|diskAdminPreview/);
});

test('居中 loading 的活动覆盖请求及服务端任务终态，后台轮询不产生新活动', async () => {
    const window = {}, snapshots = [];
    let release, status = 'running';
    const response = new Promise(resolve => { release = resolve; });
    const fetch = async url => url.includes('/operations?')
        ? { ok: true, json: async () => ({ operations: [{ operation_id: 'delete-1', status, result: { deleted: true } }] }) }
        : url.endsWith('/me') ? { ok: true, json: async () => ({ identity: {} }) } : response;
    vm.runInNewContext(source('client/disk-client.js'), { window, fetch, setInterval: () => {} });
    const client = window.DiskClient;
    client.subscribeActivity(items => snapshots.push(items.map(item => ({ ...item }))));
    await client.raw('/me'); assert.equal(snapshots.length, 1);
    const pending = client.request('/files/a', { method: 'DELETE' });
    assert.equal(snapshots.at(-1)[0].message, '正在删除文件');
    release({ ok: true, json: async () => ({ operation_id: 'delete-1' }) });
    await new Promise(setImmediate);
    assert.equal(snapshots.at(-1)[0].operationId, 'delete-1');
    assert.equal(snapshots.at(-1).length, 1, 'HTTP 202 后仍应保持 loading');
    await client.refresh(true); assert.equal(snapshots.at(-1).length, 1);
    status = 'completed'; await client.refresh(true);
    assert.equal((await pending).deleted, true); assert.equal(snapshots.at(-1).length, 0);
});

test('loading 在读取完整 Blob 前持续，失败或取消后清理，并发操作互不误关', async () => {
    const window = {}; let releaseBlob, active = [];
    const blob = new Promise(resolve => { releaseBlob = resolve; });
    const fetch = async url => url.includes('/download')
        ? { ok: true, headers: { get: () => 'read-1' }, blob: () => blob }
        : { ok: false, json: async () => ({ error: 'TEST_FAILED' }) };
    vm.runInNewContext(source('client/disk-client.js'), { window, fetch, setInterval: () => {} });
    window.DiskClient.subscribeActivity(items => { active = items; });
    const reading = window.DiskClient.read({ id: 'a', name: '音乐.mp3', size: 3 });
    await new Promise(setImmediate);
    assert.equal(active[0].operationId, 'read-1');
    await assert.rejects(window.DiskClient.request('/files/b', { method: 'DELETE' }), /TEST_FAILED/);
    assert.equal(active.length, 1, '另一请求失败不应提前关闭文件读取 loading');
    releaseBlob(new Blob(['abc'])); await reading; assert.equal(active.length, 0);
    await assert.rejects(window.DiskClient.withActivity('取消预览', () => { throw new Error('AbortError'); }), /AbortError/);
    assert.equal(active.length, 0);
});

test('上传 loading 覆盖初始化失败且只创建一个完整活动', async () => {
    const window = {}; let active = [], count = 0, jobs = [];
    vm.runInNewContext(source('client/disk-client.js'), { window, fetch: async () => { throw new Error('OFFLINE'); }, setInterval: () => {} });
    window.DiskClient.subscribeActivity(items => { active = items; count = Math.max(count, items.length); });
    window.DiskClient.subscribe(items => { jobs = items; });
    await assert.rejects(window.DiskClient.upload([{ name: 'a', size: 1 }], ''), error => error.message === 'UPLOAD_CLIENT_NETWORK_ERROR' && error.errorDetails.reason === 'OFFLINE');
    assert.equal(count, 1); assert.equal(active.length, 0);
    assert.equal(jobs.length, 1); assert.equal(jobs[0].type, 'upload'); assert.equal(jobs[0].status, 'failed'); assert.equal(jobs[0].errorCode, 'UPLOAD_CLIENT_NETWORK_ERROR');
    window.DiskClient.stop(); assert.equal(jobs.length, 0, '登出后清理此账号的本地失败提示');
});

test('上传悬浮球只显示未完成上传：失败保留全红，完成/取消或其他操作不显示', () => {
    const ui = source('client/disk-ui.js');
    const code = ui.slice(ui.indexOf('function renderDiskTaskBubble'), ui.indexOf('function initDiskEnhancements'));
    const classes = new Set(), badge = {}, styles = {};
    const bubble = { dataset: {}, classList: { toggle: (name, value) => value ? classes.add(name) : classes.delete(name) }, style: { setProperty: (key, value) => { styles[key] = value; } }, querySelector: () => badge };
    const context = { telegramDriveErrorText: value => value, window: {}, innerWidth: 390, innerHeight: 700 };
    vm.runInNewContext(code + '\nthis.render = renderDiskTaskBubble; this.position = positionDiskTaskBubble;', context);
    for (const jobs of [[], [{ type: 'upload', status: 'completed' }], [{ type: 'upload', status: 'cancelled' }], [{ type: 'read', status: 'running' }], [{ type: 'delete', status: 'failed' }]]) {
        context.render(bubble, jobs); assert.equal(bubble.hidden, true);
    }
    context.render(bubble, [{ type: 'upload', status: 'running', percent: 50 }]);
    assert.equal(bubble.hidden, false); assert.equal(styles['--progress'], '180deg');
    context.render(bubble, [{ type: 'upload', status: 'running', percent: 50 }, { type: 'upload', status: 'failed', percent: 25, errorCode: 'OFFLINE' }]);
    assert.equal(bubble.hidden, false); assert.equal(classes.has('failed'), true); assert.equal(styles['--progress'], '360deg'); assert.equal(badge.textContent, '!');
    context.render(bubble, [{ type: 'upload', status: 'queued', percent: null }]);
    assert.equal(classes.has('failed'), false); assert.equal(classes.has('indeterminate'), true);
    context.position(bubble, 1200, 900);
    assert.equal(bubble.style.left, '318px'); assert.equal(bubble.style.top, '628px');
    context.window.visualViewport = { width: 320, height: 400, offsetLeft: 20, offsetTop: 40 };
    context.position(bubble, 900, 900); assert.equal(bubble.style.left, '268px'); assert.equal(bubble.style.top, '368px');
    assert.doesNotMatch(source('client/disk.css'), /body:has\(#telegramDriveOverlay\.active\) #diskTaskBubble/);
    assert.match(source('client/disk.css'), /#diskTaskBubble\.failed\{background:#dc2626/);
});

test('任务列表可按 operation_id 恢复任意后台任务，并保留多任务切换', () => {
    const ui = source('client/disk-ui.js'), elements = {}, listeners = {};
    const create = () => ({ hidden: true, isConnected: true, setAttribute() {}, removeAttribute() {}, contains: () => false, focus() {} });
    for (const id of ['diskLoadingTitle', 'diskLoadingDetail', 'diskLoadingProgress', 'diskLoadingBackground', 'diskLoadingPrev', 'diskLoadingNext', 'diskLoadingPosition']) elements[id] = create();
    let overlay, activityListener, jobListener;
    const context = {
        document: { createElement: () => (overlay = create()), body: { append() {} }, addEventListener: (type, fn) => { listeners[type] = fn; } },
        window: { DiskClient: { subscribeActivity: fn => { activityListener = fn; }, subscribe: fn => { jobListener = fn; }, hideLoading() {}, showLoading() {} } },
        $disk: id => elements[id], formatFileSize: n => n + ' B'
    };
    vm.runInNewContext(ui.slice(ui.indexOf('function diskUploadProgressLines'), ui.indexOf('function renderDiskTaskBubble')) + '; this.restore = initDiskLoading();', context);
    const activity = { operationId: 'upload-1', message: '上传测试' };
    const job = { operation_id: 'upload-1', type: 'upload', status: 'running', title: '上传测试', phase: 'telegram-upload', message: '等待 Telegram', percent: 50, totalBytes: 6, processedBytes: 3 };
    const move = { operation_id: 'move-1', type: 'move', status: 'running', title: '移动目录', phase: 'moving', message: '移动中', percent: 20 };
    activityListener([activity]); jobListener([job, move]); assert.equal(overlay.hidden, false);
    for (let repeat = 0; repeat < 3; repeat++) {
        elements.diskLoadingBackground.onclick(); assert.equal(overlay.hidden, true);
        jobListener([{ ...job }, { ...move }]); assert.equal(overlay.hidden, true, '后台轮询不能自行抢回前台');
        assert.equal(context.restore('move-1'), true); assert.equal(overlay.hidden, false);
        assert.equal(elements.diskLoadingTitle.textContent, '移动目录'); assert.equal(elements.diskLoadingPosition.textContent, '2 / 2');
        elements.diskLoadingPrev.onclick(); assert.equal(elements.diskLoadingTitle.textContent, '上传测试');
        activityListener([activity, { message: '读取旁路请求' }]); activityListener([activity]);
        jobListener([{ ...job, percent: 60 }, { ...move }]); assert.equal(overlay.hidden, false);
        assert.equal(elements.diskLoadingTitle.textContent, '上传测试');
    }
    const progressed = { ...job, telegramBytesSent: 4, telegramBytesConfirmed: 3, telegramTotalBytes: 6 };
    jobListener([progressed, { ...move }]);
    assert.match(elements.diskLoadingDetail.textContent, /服务器 → Telegram · 4 B\/6 B · 66.67%/);
    assert.doesNotMatch(elements.diskLoadingDetail.textContent, /Telegram 已确认/);
    jobListener([{ ...progressed, status: 'failed' }, { ...move, status: 'completed' }]);
    assert.equal(overlay.hidden, true, '匹配服务端失败的残留活动不能继续显示队列等待浮层');
    activityListener([]);
    jobListener([job, move]); assert.equal(overlay.hidden, false, '从持久化任务恢复时不依赖本页活动');
    jobListener([{ ...job, status: 'completed' }, { ...move, status: 'completed' }]); assert.equal(overlay.hidden, true); assert.equal(context.restore(), false);
});

test('居中 loading 同时列出所有运行任务并可左右切换', () => {
    const ui = source('client/disk-ui.js'), elements = {}, listeners = {};
    const create = () => ({ hidden: true, disabled: false, isConnected: true, setAttribute() {}, removeAttribute() {}, contains: () => false, focus() {} });
    for (const id of ['diskLoadingTitle', 'diskLoadingDetail', 'diskLoadingProgress', 'diskLoadingBackground', 'diskLoadingPrev', 'diskLoadingNext', 'diskLoadingPosition']) elements[id] = create();
    let activityListener, jobListener;
    const card = { addEventListener() {} };
    const overlay = { ...create(), firstElementChild: card };
    const context = {
        document: { createElement: () => overlay, body: { append() {} }, addEventListener: (type, fn) => { listeners[type] = fn; } },
        window: { DiskClient: { isLoadingHidden: () => false, subscribeActivity: fn => { activityListener = fn; }, subscribe: fn => { jobListener = fn; } } },
        $disk: id => elements[id], formatFileSize: n => n + ' B'
    };
    vm.runInNewContext(ui.slice(ui.indexOf('function diskUploadProgressLines'), ui.indexOf('function renderDiskTaskBubble')) + '; initDiskLoading();', context);
    activityListener([]);
    jobListener([
        { operation_id: 'upload-1', type: 'upload', status: 'running', title: '第一个任务', message: '上传中' },
        { operation_id: 'upload-2', type: 'upload', status: 'queued', title: '第二个任务', message: '等待中' }
    ]);
    assert.equal(elements.diskLoadingPosition.textContent, '1 / 2');
    assert.equal(elements.diskLoadingPrev.disabled, false); assert.equal(elements.diskLoadingNext.disabled, false);
    elements.diskLoadingNext.onclick();
    assert.equal(elements.diskLoadingPosition.textContent, '2 / 2'); assert.equal(elements.diskLoadingTitle.textContent, '第二个任务');
});
