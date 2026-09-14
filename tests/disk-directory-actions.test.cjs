'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const ui = source('client/disk-ui.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

function uploadFixture({ created = true, destination = '新目录', failed = false } = {}) {
    const rendered = [], linked = [], uploads = [];
    const overlay = { hidden: false };
    let finish;
    const result = { items: [{ id: 'uploaded-file', name: '新文件.txt' }] };
    const pending = new Promise((resolve, reject) => { finish = () => failed ? reject(Error('TELEGRAM_NETWORK_ERROR')) : resolve(result); });
    const context = vm.createContext({ rendered, overlay, result,
        document: { getElementById: () => overlay }, history: { pushState() {} }, location: { href: 'http://localhost/#fixture' },
        window: { DiskClient: { raw: async () => ({ identity: { id: 'fixture' } }), upload: (...args) => { uploads.push(args); return pending; } } }
    });
    vm.runInContext(`
        let telegramDrivePath='原目录', telegramDriveNavigationVersion=0, telegramDriveHistorySession='fixture';
        let telegramDriveCurrentData={}, telegramDriveContentStale=false, diskWindowState={retained:true,path:'原目录'};
        const saveDiskWindow=()=>{diskWindowState.path=telegramDrivePath};
        const clearTelegramDriveSearch=()=>{}, clearTelegramDriveSelection=()=>{};
        const renderTelegramDrive=async()=>{telegramDriveCurrentData={path:telegramDrivePath,files:result.items};rendered.push(telegramDriveCurrentData)};
        ${ui.slice(ui.indexOf('async function navigateTelegramDrive('), ui.indexOf('async function openTelegramDrive('))}
        window.DiskUI={setExporter(){}, open:async()=>{}, revealUploadedDirectory:revealTelegramDriveUploadedDirectory,
            get navigationVersion(){return telegramDriveNavigationVersion}, get path(){return telegramDrivePath}};
        this.drive={navigate:navigateTelegramDrive, reveal:revealTelegramDriveUploadedDirectory,
            get version(){return telegramDriveNavigationVersion},get path(){return telegramDrivePath},get stale(){return telegramDriveContentStale},
            get savedPath(){return diskWindowState.path},hide(){overlay.hidden=true;telegramDriveHistorySession=''}};
    `, context);
    context.window.DiskUI.chooseDirectory = async options => { if (created) options.onCreateDirectory(destination); return destination; };
    vm.runInContext(source('client/disk-tunnel-adapter.js'), context);
    context.window.DiskTunnelAdapter.configure({ filesForRecord: () => [{ id: 'source-file', name: '新文件.txt', size: 3, type: 'text/plain' }],
        readFile: async () => new Blob(['abc']), linkBackup: async (...args) => { linked.push(args); } });
    return { drive: context.drive, rendered, linked, uploads, finish, result,
        save: () => context.window.DiskTunnelAdapter.save({ id: 'source-record' }) };
}

test('隧道保存到新建目录：上传完成并关联备用来源后自动定位，列表读取到新文件', async () => {
    const f = uploadFixture(), saving = f.save(); await tick();
    assert.equal(f.drive.path, '原目录'); assert.equal(f.rendered.length, 0);
    assert.equal(f.uploads[0][1], '新目录'); assert.equal(f.uploads[0][3].source, 'tunnel');
    f.finish(); assert.equal(await saving, f.result);
    assert.equal(f.drive.path, '新目录'); assert.equal(f.linked[0][0], 'source-record');
    assert.equal(f.rendered[0].files[0].id, 'uploaded-file'); assert.equal(f.drive.savedPath, '新目录');
    assert.equal(f.drive.version, 0, '自动定位不能冒充用户切换目录');
});

test('上传期间切换目录，或切换后回到原目录，都不会被完成回调强制跳走', async () => {
    for (const returnToOriginal of [false, true]) {
        const f = uploadFixture(), saving = f.save(); await tick();
        await f.drive.navigate('其它目录'); if (returnToOriginal) await f.drive.navigate('原目录');
        const count = f.rendered.length; f.finish(); await saving;
        assert.equal(f.drive.path, returnToOriginal ? '原目录' : '其它目录'); assert.equal(f.rendered.length, count);
        assert.equal(f.linked.length, 1, '目录变化不影响隧道备用来源关联');
    }
});

test('选择已有目录、取消保存或上传失败，都不自动跳转到新目录', async () => {
    for (const options of [{ created: false }, { created: false, destination: null }, { failed: true }]) {
        const f = uploadFixture(options), saving = f.save(); await tick(); f.finish();
        if (options.failed) await assert.rejects(saving, /TELEGRAM_NETWORK_ERROR/); else await saving;
        assert.equal(f.drive.path, '原目录'); assert.equal(f.rendered.length, 0);
        if (options.destination === null) assert.equal(f.uploads.length, 0);
    }
});

test('上传完成时网盘已最小化：记住新目录，标记待刷新，不强制打开浮层', async () => {
    const f = uploadFixture(), saving = f.save(); await tick(); f.drive.hide(); f.finish(); await saving;
    assert.equal(f.drive.path, '新目录'); assert.equal(f.drive.savedPath, '新目录'); assert.equal(f.drive.stale, true);
    assert.equal(f.rendered.length, 0);
});

test('空白处菜单使用打开时的目录，缓存清理仅处理本级文件，根目录属性也可访问', async () => {
    for (const folderPath of ['', '当前目录/子目录']) {
        let menu, uploaded = 0, created, property, removed;
        const requests = [];
        const context = vm.createContext({ telegramDrivePath: folderPath, telegramDriveMenuItem: null,
            document: { getElementById: () => ({ click: () => uploaded++ }) }, closeTelegramDriveItemMenu() {},
            renderTelegramDriveContextMenu: (item, anchor, actions) => { menu = { item, anchor, actions }; },
            createTelegramDriveFolder: path => { created = path; }, showTelegramDriveProperties: item => { property = item; },
            showAppToast() {}, updateDiskCacheLabels() {}, telegramDriveRequest: () => { throw Error('本级缓存不应递归读取目录树'); },
            window: { DiskClient: { raw: async url => { requests.push(url); return { files: [{ kind: 'file', id: 'a' }, { kind: 'file', id: 'b' }] }; } },
                TelegramDriveCache: { remove: async ids => { removed = [...ids]; } } }
        });
        const show = vm.runInContext(ui.slice(ui.indexOf('async function clearTelegramDriveCache('), ui.indexOf('async function cacheTelegramDriveItems('))
            + ui.slice(ui.indexOf('function showTelegramDriveBackgroundMenu('), ui.indexOf('function renderTelegramDriveContextMenu('))
            + ';showTelegramDriveBackgroundMenu', context);
        const anchor = {}; show(anchor);
        assert.deepEqual([...menu.actions].map(action => action[0]), ['上传文件', '新建目录', '当前目录属性', '清理本级目录缓存']);
        context.telegramDrivePath = '后来切换的目录';
        await menu.actions[0][1](); await menu.actions[1][1](); await menu.actions[2][1](); await menu.actions[3][1]();
        assert.equal(uploaded, 1); assert.equal(created, folderPath); assert.equal(property.path, folderPath);
        assert.equal(property.kind, 'directory'); if (!folderPath) assert.equal(property.name, '根目录');
        assert.deepEqual(removed, ['a', 'b']); assert.deepEqual(requests, ['/list?path=' + encodeURIComponent(folderPath)]);
    }
});

function gestureFixture(beginTouchDrag = null) {
    const listeners = {}, opened = [], timers = new Map(); let time = 1000, timerId = 0;
    const element = { addEventListener: (type, callback) => { listeners[type] = callback; } };
    const context = vm.createContext({ Date: { now: () => time }, Math,
        setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) });
    const install = vm.runInContext(ui.slice(ui.indexOf('function installContextGesture('), ui.indexOf('function installDiskDrop(')) + ';installContextGesture', context);
    const blank = { closest: () => null }, row = { closest: () => ({}) };
    install(element, event => opened.push(event), beginTouchDrag, beginTouchDrag ? {} : { twoFingerTap: true, longPress: false, accept: event => !event.target.closest('.telegram-drive-item') });
    const dispatch = (type, extra = {}) => listeners[type]({ target: blank, clientX: 50, clientY: 50, pointerType: 'touch', pointerId: 1, isPrimary: true,
        preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...extra });
    return { opened, timers, row, dispatch, advance: amount => { time += amount; } };
}

test('空白处 PC 右键及双指轻触打开菜单，单指、滑动、取消和混合触摸均不误开', () => {
    const pc = gestureFixture(); pc.dispatch('contextmenu', { pointerType: 'mouse' }); pc.dispatch('contextmenu', { pointerType: 'mouse' }); assert.equal(pc.opened.length, 2);
    for (const mode of ['tap', 'single', 'move', 'cancel', 'mixed', 'three']) {
        const f = gestureFixture(); f.dispatch('pointerdown'); assert.equal(f.timers.size, 0, '空白处不启用单指长按');
        if (mode !== 'single') f.dispatch('pointerdown', { pointerId: 2, isPrimary: false, clientX: 150, ...(mode === 'mixed' ? { target: f.row } : {}) });
        if (mode === 'three') f.dispatch('pointerdown', { pointerId: 3, isPrimary: false });
        if (mode === 'move') f.dispatch('pointermove', { clientX: 75 });
        if (mode === 'cancel') f.dispatch('pointercancel'); else f.dispatch('pointerup');
        if (mode !== 'single') f.dispatch('pointerup', { pointerId: 2, isPrimary: false });
        if (mode === 'three') f.dispatch('pointerup', { pointerId: 3, isPrimary: false });
        assert.equal(f.opened.length, mode === 'tap' ? 1 : 0, mode);
        if (mode === 'tap') assert.equal(f.opened[0].clientX, 100);
        if (mode === 'single') { f.dispatch('contextmenu', { pointerType: 'mouse' }); assert.equal(f.opened.length, 0, '触摸后的原生长按菜单不应重复触发'); }
    }
    const row = gestureFixture(); row.dispatch('contextmenu', { target: row.row, pointerType: 'mouse' }); assert.equal(row.opened.length, 0);
});

test('文件行仍保留单指长按拖动及双指轻触菜单，空白处扩展不改变既有手势', () => {
    let dragged = 0;
    const f = gestureFixture(() => dragged++); f.dispatch('pointerdown'); [...f.timers.values()][0](); f.dispatch('pointerup');
    assert.equal(dragged, 1); assert.equal(f.opened.length, 0);
    f.advance(1500); f.dispatch('pointerdown'); f.dispatch('pointerdown', { pointerId: 2, isPrimary: false });
    f.dispatch('pointerup'); f.dispatch('pointerup', { pointerId: 2, isPrimary: false });
    assert.equal(dragged, 1); assert.equal(f.opened.length, 1);
});
