'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const ui = source('client/disk-ui.js'), app = source('app.js');

test('控制中心排序兼容新增磁贴、重复和失效项目，保留切换隧道面板分界', () => {
    const normalize = vm.runInNewContext(app.slice(app.indexOf('function normalizeControlCenterOrder('), app.indexOf('function initTunnelControlCenter(')) + ';normalizeControlCenterOrder');
    const result = [...normalize(['theme', 'tunnels', 'disk', 'disk', 'unknown'])];
    assert.equal(result[0], 'theme'); assert.equal(result[1], 'tunnels'); assert.equal(result[2], 'disk');
    assert.equal(result.length, 10); assert.equal(new Set(result).size, 10);
});

test('预览按钮滚动引导只在浮层重新打开时执行，收藏重绘保留滚动位置', () => {
    const frames = [], scrolls = [], container = { dataset: {}, scrollWidth: 600, clientWidth: 300, scrollLeft: 0, replaceChildren() {}, appendChild() {}, scrollTo: options => scrolls.push(options.left) };
    let active = false;
    const context = vm.createContext({ document: { getElementById: () => container }, history: { state: {}, pushState() {} }, window: { location: { href: 'http://localhost' } },
        FILE_PREVIEW_HISTORY_KEY: 'preview', filePreviewHistoryOpen: false, filePreviewNestedHistoryOpen: false,
        requestAnimationFrame: fn => frames.push(fn), matchMedia: () => ({ matches: false }), setTimeout: fn => frames.push(fn) });
    vm.runInContext(app.slice(app.indexOf('function setFilePreviewActions('), app.indexOf('function resetFilePreviewContentStage(')) + ';this.actions=setFilePreviewActions;this.open=openFilePreviewHistory;', context);
    const viewer = { classList: { contains: () => active, add: () => { active = true; } } };
    context.open(viewer); context.actions([{}]); while (frames.length) frames.shift()(); assert.deepEqual(scrolls, [96, 0]);
    container.scrollLeft = 80; context.actions([{}, {}]); assert.equal(container.scrollLeft, 80); assert.equal(frames.length, 0);
    active = false; context.open(viewer); context.actions([{}]); while (frames.length) frames.shift()(); assert.deepEqual(scrolls, [96, 0, 96, 0]);
});

function dragFixture() {
    const callbacks = new Map(), timers = new Map(), moves = [], ghosts = [];
    let timerId = 0, target = null, now = 1000;
    class Element {
        constructor() { this.dataset = {}; this.style = {}; this.handlers = {}; this.classList = { add() {}, remove() {} }; this.captured = false; }
        addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
        setPointerCapture() { this.captured = true; } hasPointerCapture() { return this.captured; } releasePointerCapture() { this.captured = false; }
        closest() { return null; } remove() { this.removed = true; }
    }
    const list = new Element(); list.scrollTop = 50; list.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 700 });
    const context = vm.createContext({ HTMLElement: Element, Date: { now: () => now }, Math,
        document: { createElement: () => { const ghost = new Element(); ghosts.push(ghost); return ghost; }, body: { append() {} }, getElementById: () => list, elementsFromPoint: () => target ? [target] : [] },
        window: { addEventListener: (name, fn) => { (callbacks.get(name) || callbacks.set(name, []).get(name)).push(fn); }, removeEventListener: (name, fn) => callbacks.set(name, (callbacks.get(name) || []).filter(value => value !== fn)) },
        setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id), requestAnimationFrame: () => 1, cancelAnimationFrame() {},
        diskDragItems: [], telegramDriveSelected: new Map(), telegramDriveItemKey: item => item.id || item.path,
        moveTelegramDriveItems: async (items, destination) => moves.push({ items, destination }), alert: error => { throw Error(error); }, telegramDriveErrorText: error => error.message });
    vm.runInContext(ui.slice(ui.indexOf('function installContextGesture('), ui.indexOf('async function exportDiskItems(')) + ';this.install=installDiskPointerDrag;this.gesture=installContextGesture;this.begin=beginTouchDiskDrag;', context);
    const row = new Element(), file = { id: 'file', kind: 'file', name: '文件.mp4', folderPath: '原目录' };
    context.install(row, file); context.gesture(row, () => {}, event => context.begin([file], row, event));
    const event = extra => ({ target: row, pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 30, clientY: 80, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() { this.stopped = true; }, ...extra });
    const dispatch = (name, extra) => { const e = event(extra); for (const fn of [...(callbacks.get(name) || [])]) fn(e); for (const fn of row.handlers[name] || []) fn(e); return e; };
    return { context, row, file, list, ghosts, moves, timers, dispatch, target: value => { target = new Element(); target.dataset.diskDropPath = value; }, advance: value => { now += value; } };
}
test('PC 左键越过拖动阈值后移动到命中目录，松开后不触发单击；多选一起移动', () => {
    const f = dragFixture(), second = { ...f.file, id: 'second' };
    f.context.telegramDriveSelected.set('file', f.file); f.context.telegramDriveSelected.set('second', second);
    f.dispatch('pointerdown'); f.dispatch('pointermove', { clientX: 100 }); assert.equal(f.ghosts.length, 1);
    f.target('目标目录'); f.dispatch('pointermove', { clientX: 130 }); f.dispatch('pointerup');
    assert.equal(f.moves.length, 1); assert.equal(f.moves[0].items.length, 2); assert.equal(f.moves[0].destination, '目标目录');
    assert.equal(f.ghosts[0].removed, true); assert.equal(f.row.captured, false); assert.equal(f.dispatch('click').stopped, true);
});
test('触屏短滑保留列表滚动并取消长按，长按后指针取消不执行移动', () => {
    const f = dragFixture(); f.dispatch('pointerdown', { pointerType: 'touch' }); f.dispatch('pointermove', { pointerType: 'touch', clientY: 30 });
    assert.equal(f.list.scrollTop, 100); assert.equal(f.timers.size, 0); assert.equal(f.ghosts.length, 0); f.dispatch('pointerup');
    assert.equal(f.dispatch('click').stopped, true);
    f.advance(1000); f.dispatch('pointerdown', { pointerType: 'touch' }); [...f.timers.values()][0]();
    assert.equal(f.ghosts.length, 1); f.target('目标目录'); f.dispatch('pointermove', { pointerType: 'touch', clientX: 140 }); f.dispatch('pointercancel');
    assert.equal(f.moves.length, 0); assert.equal(f.ghosts[0].removed, true);
});
test('目录不能拖入自己或子目录，Escape 取消并释放拖动监听', () => {
    const f = dragFixture(), folder = { kind: 'directory', path: '父目录', name: '父目录' };
    f.context.begin([folder], f.row, { pointerId: 1, clientX: 30, clientY: 80, preventDefault() {} });
    f.target('父目录/子目录'); f.dispatch('pointermove', { clientX: 140 }); f.dispatch('pointerup'); assert.equal(f.moves.length, 0);
    f.advance(1000); f.dispatch('pointerdown'); f.dispatch('pointermove', { clientX: 140 }); f.dispatch('keydown', { key: 'Escape' });
    assert.equal(f.ghosts.at(-1).removed, true); assert.equal(f.moves.length, 0);
});
