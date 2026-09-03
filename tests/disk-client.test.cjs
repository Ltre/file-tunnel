'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
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
test('隧道适配器传递普通 File 与目录相对路径，核心没有隧道状态依赖', async () => {
    let exporter, sent, closed = false, uploadArgs;
    const window = {
        DiskUI: { setExporter: fn => { exporter = fn; }, close: () => { closed = true; }, path: '' },
        DiskClient: { raw: async () => ({ identity: { id: 'user' } }), read: async () => new Blob(['abc']), upload: async (...args) => { uploadArgs = args; } }
    };
    vm.runInNewContext(source('client/disk-tunnel-adapter.js'), { window, File, Blob, confirm: () => true, prompt: () => '目标目录' });
    window.DiskTunnelAdapter.configure({ target: () => 'ABCDE', send: files => { sent = files; }, readFile: () => {}, filesForRecord: () => [{ name: 'a.txt', size: 3 }] });
    await exporter([{ name: 'a.txt', type: 'text/plain', relativePath: 'album/a.txt' }, { name: 'b.txt', type: 'text/plain' }]);
    assert.equal(closed, true); assert.equal(sent.length, 2); assert.equal(sent[0].relativePath, 'album/a.txt'); assert.equal(await sent[0].text(), 'abc');
    await window.DiskTunnelAdapter.save({ id: 'record' }); assert.equal(uploadArgs[1], '目标目录');
    for (const file of ['client/disk-client.js', 'client/disk-ui.js', 'server/disk-api.js', 'server/telegram-drive.js']) assert.doesNotMatch(source(file), /state\.sessionId|sendFileCollection|sourceMessageId|sourceSessionId/);
    assert.match(source('app.js'), /send: files => sendSelectedFiles\(files\)/);
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
    await assert.rejects(window.DiskClient.upload([{ name: 'a', size: 1 }], ''), /OFFLINE/);
    assert.equal(count, 1); assert.equal(active.length, 0);
    assert.equal(jobs.length, 1); assert.equal(jobs[0].type, 'upload'); assert.equal(jobs[0].status, 'failed'); assert.equal(jobs[0].errorCode, 'OFFLINE');
    window.DiskClient.stop(); assert.equal(jobs.length, 0, '登出后清理此账号的本地失败提示');
});

test('上传悬浮球只显示未完成上传：失败保留全红，完成/取消或其他操作不显示', () => {
    const ui = source('client/disk-ui.js');
    const code = ui.slice(ui.indexOf('function renderDiskTaskBubble'), ui.indexOf('function initDiskEnhancements'));
    const classes = new Set(), badge = {}, styles = {};
    const bubble = { classList: { toggle: (name, value) => value ? classes.add(name) : classes.delete(name) }, style: { setProperty: (key, value) => { styles[key] = value; } }, querySelector: () => badge };
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
