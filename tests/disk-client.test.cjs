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
