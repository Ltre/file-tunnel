'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const turn = () => new Promise(setImmediate);
const ui = source('client/disk-ui.js');

function fixture(options = {}) {
    const requests = [], refreshes = [], toasts = [], jobs = new Map();
    const elements = {};
    const element = () => ({ hidden: true, disabled: false, isConnected: true,
        setAttribute() {}, removeAttribute() {}, contains: () => false, focus() {} });
    for (const id of ['diskLoadingTitle', 'diskLoadingDetail', 'diskLoadingProgress', 'diskLoadingBackground', 'diskLoadingPrev', 'diskLoadingNext', 'diskLoadingPosition']) elements[id] = element();
    const overlay = { ...element(), firstElementChild: { addEventListener() {} } };
    let cleared = 0;
    const context = vm.createContext({
        window: {}, setInterval() {}, encodeURIComponent,
        telegramDriveContentStale: false,
        document: { createElement: () => overlay, body: { append() {} }, addEventListener() {} },
        $disk: id => elements[id], formatFileSize: n => n + ' B', telegramDriveDisplayPath: value => '/' + value,
        chooseTelegramDriveDestination: async () => options.cancelPicker ? null : 'target',
        confirmTelegramDriveAction: async () => !options.cancelConfirmation,
        clearTelegramDriveSelection: () => { cleared++; }, showAppToast: message => toasts.push(message),
        renderTelegramDrive: async value => { refreshes.push({ ...value }); if (options.refreshPending) await options.refreshPending; },
        fetch: async (url, init = {}) => {
            if (url.includes('/operations?')) return { ok: true, json: async () => ({ operations: [...jobs.values()].map(job => ({ ...job })) }) };
            assert.equal(init.method, 'PATCH');
            return new Promise(resolve => requests.push({ url, body: JSON.parse(init.body), resolve }));
        }
    });
    vm.runInContext(source('client/disk-client.js'), context);
    vm.runInContext(ui.slice(ui.indexOf('function diskUploadProgressLines('), ui.indexOf('function renderDiskTaskBubble(')) + ';this.restore = initDiskLoading();', context);
    vm.runInContext(ui.slice(ui.indexOf('async function moveTelegramDriveItems('), ui.indexOf('async function deleteTelegramDriveItems(')) + ';this.move = moveTelegramDriveItems;', context);
    const client = context.window.DiskClient;
    const accept = async (index, id) => {
        jobs.set(id, { operation_id: id, status: 'running', title: '移动', message: '处理中' });
        requests[index].resolve({ ok: true, json: async () => ({ operation_id: id }) });
        await turn();
    };
    const complete = async id => {
        Object.assign(jobs.get(id), { status: 'completed', result: {} });
        await client.refresh(true); await turn();
    };
    return { ...context, client, elements, overlay, requests, refreshes, toasts, accept, complete, cleared: () => cleared, stale: () => context.telegramDriveContentStale };
}
const file = { id: 'first', kind: 'file', name: 'first.txt', folderPath: 'source' };
const folder = { kind: 'directory', name: 'nested', path: 'source/nested' };

test('移动确认后在首个 HTTP 响应前显示 Loading，覆盖整批移动和最终目录刷新', async () => {
    let finishRefresh;
    const f = fixture({ refreshPending: new Promise(resolve => { finishRefresh = resolve; }) });
    const pending = f.move([file, folder], 'target');
    await turn();
    assert.equal(f.overlay.hidden, false, '不能等服务器任务轮询才出现 Loading');
    assert.match(f.elements.diskLoadingTitle.textContent, /1\/2.*first\.txt/);
    assert.match(f.elements.diskLoadingDetail.textContent, /目录：\/target/);
    assert.equal(f.cleared(), 0, '服务器尚未接受时保留选择');
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.requests[0].body, { folderPath: 'target' });
    await f.accept(0, 'move-1');
    assert.equal(f.cleared(), 1);
    assert.equal(f.elements.diskLoadingPosition.textContent, '1 / 1', '活动与服务器任务合并显示');
    await f.complete('move-1');
    assert.equal(f.requests.length, 2);
    assert.equal(f.overlay.hidden, false);
    assert.match(f.elements.diskLoadingTitle.textContent, /2\/2.*nested/);
    assert.deepEqual(f.requests[1].body, { path: 'source/nested', destinationPath: 'target' });
    await f.accept(1, 'move-2'); await f.complete('move-2');
    assert.equal(f.overlay.hidden, false, '目录刷新未结束时继续反馈');
    assert.match(f.elements.diskLoadingTitle.textContent, /正在刷新目录/);
    assert.deepEqual(f.refreshes, [{ contentsOnly: true }]);
    finishRefresh(); await pending;
    assert.equal(f.overlay.hidden, true);
    assert.equal(f.cleared(), 1);
    assert.deepEqual(f.toasts, ['已移动 2 项']);
});

test('移动完成时保留内容变更标记，网盘最小化后恢复不能复用旧列表', async () => {
    const f = fixture(), pending = f.move([file]);
    await turn();
    assert.equal(f.stale(), false);
    await f.accept(0, 'move-1'); await f.complete('move-1'); await pending;
    assert.equal(f.stale(), true, '隐藏状态下刷新跳过时仍需在下次打开重新读取列表');
});

test('移动请求未返回就后台执行，取得任务 ID 或切到下一项不重新弹出，可主动恢复', async () => {
    const f = fixture(), pending = f.move([file, folder]);
    await turn();
    f.elements.diskLoadingBackground.onclick();
    assert.equal(f.overlay.hidden, true);
    await f.accept(0, 'move-1');
    assert.equal(f.overlay.hidden, true);
    assert.equal(f.client.isLoadingHidden('move-1'), true);
    assert.equal(f.restore('move-1'), true);
    assert.equal(f.overlay.hidden, false, '任务列表仍能主动恢复');
    f.elements.diskLoadingBackground.onclick();
    await f.complete('move-1');
    assert.equal(f.overlay.hidden, true, '下一项提交前仍保持后台');
    await f.accept(1, 'move-2');
    assert.equal(f.overlay.hidden, true, '下一项任务 ID 不取消后台状态');
    assert.equal(f.client.isLoadingHidden('move-2'), true);
    await f.complete('move-2'); await pending;
    assert.equal(f.overlay.hidden, true);
    assert.deepEqual(f.toasts, ['已移动 2 项']);
});

test('取消移动不创建活动或请求，首个请求失败后撤掉 Loading 且保留选择', async () => {
    for (const options of [{ cancelPicker: true }, { cancelConfirmation: true }]) {
        const f = fixture(options);
        await f.move([file], options.cancelConfirmation ? 'target' : undefined);
        assert.equal(f.overlay.hidden, true); assert.equal(f.requests.length, 0); assert.equal(f.cleared(), 0);
    }
    const f = fixture(), pending = f.move([file]);
    await turn(); assert.equal(f.overlay.hidden, false);
    f.requests[0].resolve({ ok: false, status: 409, json: async () => ({ error: 'DISK_NAME_CONFLICT' }) });
    await assert.rejects(pending, /DISK_NAME_CONFLICT/);
    assert.equal(f.overlay.hidden, true); assert.equal(f.cleared(), 0);
    assert.equal(f.toasts.length, 0); assert.equal(f.refreshes.length, 0);
});

test('两批移动在服务器响应前也可左右切换，后台执行后独立完成', async () => {
    const f = fixture();
    const first = f.move([file], 'target');
    const second = f.move([{ ...file, id: 'second', name: 'second.txt' }], 'other');
    await turn();
    assert.equal(f.requests.length, 2);
    assert.equal(f.elements.diskLoadingPosition.textContent, '1 / 2');
    f.elements.diskLoadingNext.onclick();
    assert.match(f.elements.diskLoadingTitle.textContent, /second\.txt/);
    assert.match(f.elements.diskLoadingDetail.textContent, /目录：\/other/);
    f.elements.diskLoadingBackground.onclick();
    await f.accept(0, 'first-batch'); await f.accept(1, 'second-batch');
    assert.equal(f.overlay.hidden, true);
    await f.complete('first-batch'); await first;
    assert.equal(f.overlay.hidden, true);
    await f.complete('second-batch'); await second;
    assert.equal(f.overlay.hidden, true);
    assert.equal(f.toasts.length, 2);
});
