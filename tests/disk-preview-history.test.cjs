'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../client/disk-ui.js'), 'utf8');
function fixture() {
    const stack = [{}], pending = [], rendered = [], listeners = [];
    let index = 0, hostEvents = 0;
    const nodes = new Map();
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { hidden: true, classList: { add() {}, remove() {} }, replaceChildren() {}, open: false });
        return nodes.get(id);
    };
    const history = {
        get state() { return stack[index]; },
        pushState(state) { stack.splice(++index); stack[index] = structuredClone(state); },
        replaceState(state) { stack[index] = structuredClone(state); },
        back() { if (index > 0) { const state = stack[--index]; pending.push(() => dispatch(state)); } }
    };
    function dispatch(state) {
        let stopped = false;
        const event = { state, stopImmediatePropagation() { stopped = true; } };
        for (const listener of listeners) { listener.fn(event); if (stopped) return; }
    }
    // Mirrors app.js registering before DiskUI.init after asynchronous startup.
    listeners.push({ fn: () => { if (!context.drive.ownsHistory()) hostEvents++; }, capture: false });
    const context = vm.createContext({ history, location: { href: 'http://localhost/#test' }, Date, Math, URL,
        document: { getElementById: node, body: { classList: { add() {}, remove() {} } } },
        window: { addEventListener(name, fn, options) { if (name === 'popstate') listeners.push({ fn, capture: !!options?.capture }); } },
        rendered, alert: message => { throw Error(message); }
    });
    const driveLifecycle = source.slice(source.indexOf('async function navigateTelegramDrive('), source.indexOf('function prepareTelegramDrivePicker('));
    const previewLifecycle = source.slice(source.indexOf('function closeDiskPreview('), source.indexOf('function formatDiskMediaTime('));
    const handler = source.slice(source.indexOf('function ownsTelegramDriveHistory('), source.indexOf('function init(options'));
    vm.runInContext(`
        let telegramDrivePath='', telegramDriveHistorySession='', telegramDriveCurrentData={}, telegramDriveSearchData, telegramDriveContentStale=false;
        let diskWindowState={}, previewItems=[], previewIndex=0, previewGeneration=0, previewURL='', previewAbort;
        let diskPreviewHistoryOpen=false, diskPreviewHistoryClosing=false, diskPreviewBaseState=null;
        let telegramDriveMenuHistoryOpen=false, telegramDriveDialogHistoryOpen=false;
        const $disk=id=>document.getElementById(id), disposeActiveDiskMedia=()=>{}, saveDiskWindow=retained=>{diskWindowState.retained=retained};
        const clearTelegramDriveSearch=()=>{}, clearTelegramDriveSelection=()=>{}, updateDiskCacheLabels=()=>{};
        const renderTelegramDriveBreadcrumbs=()=>{}, renderTelegramDriveItems=()=>{};
        const renderTelegramDrive=async()=>{rendered.push(telegramDrivePath);telegramDriveCurrentData={}};
        const closeTelegramDriveDialog=()=>{}, closeTelegramDriveItemMenu=()=>{}, telegramDriveErrorText=e=>e.message;
        const getTelegramDriveDisplayData=()=>({}), getSortedTelegramDriveItems=()=>[{id:'media'}], isDiskPreviewable=()=>true, renderDiskPreview=async()=>{};
        ${driveLifecycle}
        ${previewLifecycle}
        ${handler}
        ${source.match(/window\.addEventListener\('popstate', handleTelegramDrivePopstate[^;]+;/)[0]}
        this.drive={open:openTelegramDrive,close:closeTelegramDrive,navigate:navigateTelegramDrive,preview:()=>openDiskPreview({id:'media'}),closePreview:closeDiskPreview,
            path:()=>telegramDrivePath, previewOpen:()=>diskPreviewHistoryOpen, ownsHistory:ownsTelegramDriveHistory};
    `, context);
    return { drive: context.drive, node, history, stack, rendered, hostEvents: () => hostEvents, flush: () => { while (pending.length) pending.shift()(); } };
}
for (const reopen of [false, true]) test(`PC 预览关闭仅回到当前目录；${reopen ? '关闭网盘再打开' : '连续切换目录'}后下一次返回正常导航`, async () => {
    const f = fixture(); await f.drive.open(); await f.drive.navigate('A'); await f.drive.navigate('A/B');
    if (reopen) { f.drive.close({ forget: true }); await f.drive.open(); }
    assert.equal(f.drive.path(), 'A/B');
    const before = f.rendered.length; await f.drive.preview();
    f.drive.closePreview(); f.drive.closePreview(); f.flush();
    assert.equal(f.node('diskPreview').hidden, true); assert.equal(f.node('telegramDriveOverlay').hidden, false);
    assert.equal(f.drive.path(), 'A/B'); assert.equal(f.history.state.telegramDrivePath, 'A/B');
    assert.equal(f.rendered.length, before); assert.equal(f.hostEvents(), 0);
    if (reopen) await f.drive.navigate('A/B/C');
    f.history.back(); f.flush();
    assert.equal(f.drive.path(), reopen ? 'A/B' : 'A'); assert.equal(f.node('telegramDriveOverlay').hidden, false);
});
test('异步关闭遇到旧会话/旧目录或残余 preview 标记仍只关闭预览，绝不关闭网盘/跳目录', async () => {
    for (const stale of [{}, { telegramDriveOpen: true, telegramDrivePath: 'old', telegramDriveHistorySession: 'old' }, { telegramDrivePreview: true }]) {
        const f = fixture(); await f.drive.open(); await f.drive.navigate('current'); await f.drive.preview();
        f.stack[f.stack.length - 2] = stale;
        f.drive.closePreview(); f.flush();
        assert.equal(f.drive.previewOpen(), false); assert.equal(f.drive.path(), 'current');
        assert.equal(f.node('telegramDriveOverlay').hidden, false); assert.equal(f.history.state.telegramDrivePath, 'current');
        assert.equal(f.history.state.telegramDrivePreview, undefined); assert.equal(f.hostEvents(), 0);
    }
});
test('返回手势先退出预览，随后一次返回切换上一级；不重复消费首页事件', async () => {
    const f = fixture(); await f.drive.open(); await f.drive.navigate('A'); await f.drive.navigate('A/B'); await f.drive.preview();
    f.history.back(); f.flush(); assert.equal(f.drive.previewOpen(), false); assert.equal(f.drive.path(), 'A/B');
    f.history.back(); f.flush(); assert.equal(f.drive.path(), 'A');
    f.drive.close(); f.history.back(); f.flush(); assert.equal(f.hostEvents(), 1);
});
