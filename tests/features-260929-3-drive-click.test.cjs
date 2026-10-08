'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ui = fs.readFileSync(path.join(__dirname, '../client/disk-ui.js'), 'utf8');

function fixture({ mobile = true, coarse = false, narrow = false } = {}) {
    const timers = new Map(), frames = new Map(), windowListeners = new Map(), opened = [], moved = [], menus = [];
    let now = 10000, timerId = 0, frameId = 0, filter = () => true;
    class Element {
        constructor(tag = 'div') {
            this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.handlers = {};
            this.classes = new Set(); this.captured = new Set(); this.insertions = 0; this.removals = 0;
            this.classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value),
                contains: value => this.classes.has(value), toggle: (value, enabled) => enabled ? this.classes.add(value) : this.classes.delete(value) };
        }
        setAttribute() {} append(...children) { this.children.push(...children); for (const child of children) if (typeof child === 'object') child.parentElement = this; }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        insertBefore(child, reference) { child.insertions++; child.remove(); const index = reference ? this.children.indexOf(reference) : this.children.length; this.children.splice(index, 0, child); child.parentElement = this; }
        addEventListener(type, fn, options) { (this.handlers[type] ||= []).push({ fn, capture: options === true || options?.capture }); }
        closest(selectors) { return selectors.split(',').some(selector => selector.trim() === this.tagName || selector.trim().slice(1) === this.className) ? this : this.parentElement?.closest(selectors) || null; }
        setPointerCapture(id) { this.captured.add(id); } hasPointerCapture(id) { return this.captured.has(id); } releasePointerCapture(id) { this.captured.delete(id); }
        remove() { if (this.parentElement) { this.removals++; const index = this.parentElement.children.indexOf(this); if (index >= 0) this.parentElement.children.splice(index, 1); this.parentElement = null; } }
        getBoundingClientRect() { return { left: 0, right: 400, top: 0, bottom: 700 }; }
    }
    const list = new Element(); list.scrollTop = 50;
    const selection = { hidden: true }, count = {}, manager = new Element();
    const nodes = { telegramDriveList: list, telegramDriveSelection: selection, telegramDriveSelectionCount: count, telegramDriveOverlay: { hidden: false } };
    const first = { kind: 'directory', path: 'a', name: '甲' }, second = { kind: 'directory', path: 'b', name: '乙' };
    const context = vm.createContext({
        telegramDriveCurrentData: { folders: [first, second], files: [] }, telegramDriveSearchData: null,
        telegramDriveSelected: new Map(), telegramDriveSelectionAnchor: '', telegramDriveView: 'list', diskDragItems: [], telegramDrivePath: '', telegramDriveRenderGeneration: 0,
        document: { getElementById: id => nodes[id] || null, createElement: tag => new Element(tag),
            querySelector: () => manager, querySelectorAll: () => [], elementsFromPoint: () => [], body: { append() {} } },
        window: { matchMedia: query => ({ matches: (mobile || coarse) && query.includes('coarse') || (mobile || narrow) && query.includes('max-width') || !mobile && query === '(pointer:fine)' }),
            DiskClient: {},
            addEventListener: (type, fn) => { (windowListeners.get(type) || windowListeners.set(type, []).get(type)).push(fn); },
            removeEventListener: (type, fn) => windowListeners.set(type, (windowListeners.get(type) || []).filter(entry => entry !== fn)) },
        Date: { now: () => now }, Math, HTMLElement: Element,
        setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id),
        requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id), queueMicrotask() {},
        getSortedTelegramDriveItems: data => [...(data.folders || []), ...(data.files || [])].filter(filter),
        getTelegramDriveDisplayData: () => context.telegramDriveSearchData || context.telegramDriveCurrentData,
        updateTelegramDriveBottomSummary() {}, telegramDriveMimeIcon: () => '📁', getTelegramDriveItemMeta: () => '', updateDiskCacheLabels() {},
        isTelegramDriveStaticOpen: () => false, refreshTelegramDriveStaticLinks: async () => {},
        telegramDriveItemKey: item => item.kind === 'directory' ? 'directory:' + item.path : 'file:' + item.id,
        openTelegramDriveItem: async item => opened.push(item), showTelegramDriveItemMenu: async item => menus.push(item),
        moveTelegramDriveItems: async (items, destination) => moved.push({ items, destination }),
        telegramDriveActionItems: item => [item], alert: assert.fail, telegramDriveErrorText: error => error.message,
        renderTelegramDriveBreadcrumbs() {}, refreshDiskCollaborations: async () => {}, scheduleTelegramDriveSearch() {}, encodeURIComponent
    });
    vm.runInContext(ui.slice(ui.indexOf('function clearTelegramDriveSelection()'), ui.indexOf('function updateTelegramDriveBottomSummary('))
        + ui.slice(ui.indexOf('let diskLastTouchAt = 0;'), ui.indexOf('async function uploadFilesToTelegramDrive('))
        + ui.slice(ui.indexOf('function installContextGesture('), ui.indexOf('async function exportDiskItems('))
        + ui.slice(ui.indexOf('async function refreshTelegramDriveContents('), ui.indexOf('async function navigateTelegramDrive(')), context);
    context.renderTelegramDriveItems();
    function dispatch(row, type, extra = {}) {
        const event = { type, target: row, pointerId: 1, pointerType: mobile ? 'touch' : 'mouse', button: 0, buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, isPrimary: true,
            clientX: 30, clientY: 80, timeStamp: now, detail: 1, preventDefault() { this.prevented = true; },
            stopPropagation() { this.propagationStopped = true; }, stopImmediatePropagation() { this.stopped = this.propagationStopped = true; }, ...extra };
        for (const fn of [...(windowListeners.get(type) || [])]) { fn(event); if (event.stopped) return event; }
        if (!row) return event;
        for (const handler of (row.handlers[type] || []).filter(entry => entry.capture)) { handler.fn(event); if (event.stopped) return event; }
        if (type === 'click' && event.target.tagName === 'input') {
            event.target.onclick(event); event.target.checked = !event.target.checked; event.target.onchange();
        }
        if (!event.propagationStopped) row['on' + type]?.(event);
        if (!event.stopped) for (const handler of (row.handlers[type] || []).filter(entry => !entry.capture)) { handler.fn(event); if (event.stopped) break; }
        return event;
    }
    const tap = (row, extra = {}) => { dispatch(row, 'pointerdown', extra); dispatch(row, 'pointerup', extra); return dispatch(row, 'click', extra); };
    return { context, list, opened, moved, menus, timers, frames, first, second, selection, count, dispatch, tap,
        row: (index = 0) => list.children[index], advance: ms => { now += ms; }, render: () => context.renderTelegramDriveItems(),
        refresh: async data => { context.window.DiskClient.raw = async () => data; await context.refreshTelegramDriveContents(); },
        filter: fn => { filter = fn; }, hold: () => { const entry = [...timers.entries()].find(([, timer]) => timer.delay === 550); assert.ok(entry); timers.delete(entry[0]); entry[1].fn(); } };
}

test('移动端重复轻触计数及合成鼠标双击均不吞掉独立打开动作', () => {
    const f = fixture(), row = f.row();
    f.tap(row, { detail: 1 }); f.tap(row, { detail: 2, pointerType: 'mouse', sourceCapabilities: { firesTouchEvents: true } }); f.tap(row, { detail: 3, pointerType: 'mouse', sourceCapabilities: { firesTouchEvents: true } });
    f.dispatch(row, 'dblclick', { detail: 2, pointerType: '' });
    assert.equal(f.opened.length, 3); assert.equal(f.context.telegramDriveSelected.size, 0);
});

test('当前 click 的 touch 来源在宽屏设备也不误进入 PC 选择', () => {
    const f = fixture({ mobile: false });
    f.dispatch(f.row(), 'click', { pointerType: 'touch', detail: 1 });
    assert.equal(f.opened.length, 1); assert.equal(f.context.telegramDriveSelected.size, 0);
});

test('普通鼠标或触摸按下不捕获整行指针，达到真实拖动或滚动阈值才捕获', () => {
    for (const mobile of [false, true]) {
        const f = fixture({ mobile }), row = f.row();
        f.dispatch(row, 'pointerdown', { target: row.children[2] }); assert.equal(row.captured.size, 0);
        f.dispatch(row, 'pointermove', { clientY: 77 }); assert.equal(row.captured.size, 0);
        f.dispatch(row, 'pointermove', { clientY: 30 }); assert.equal(row.captured.size, 1);
        f.dispatch(row, 'pointercancel', { clientY: 30 }); assert.equal(row.captured.size, 0);
    }
});

test('PC 单击即时选择、双击恢复首击前选择并打开，Enter 仍可打开', () => {
    const f = fixture({ mobile: false }), row = f.row();
    f.tap(row); assert.equal(f.opened.length, 0); assert.equal(f.context.telegramDriveSelected.size, 1);
    f.tap(row, { detail: 2 }); f.dispatch(row, 'dblclick', { detail: 2 });
    assert.equal(f.opened.length, 1); assert.equal(f.context.telegramDriveSelected.size, 0);
    f.dispatch(row, 'keydown', { key: 'Enter' }); assert.equal(f.opened.length, 2);
});

test('Windows 混合设备、小窗口及近期触摸均不能覆盖明确鼠标双击来源', () => {
    for (const options of [{ coarse: true }, { narrow: true }, { coarse: true, narrow: true }]) {
        const f = fixture({ mobile: false, ...options }), row = f.row();
        f.context.telegramDriveSelected.set('directory:b', f.second); f.render();
        f.dispatch(row, 'pointerdown', { pointerType: 'touch' }); f.dispatch(row, 'pointercancel', { pointerType: 'touch' });
        f.tap(row, { detail: 1, pointerType: 'mouse' });
        assert.equal(f.context.telegramDriveSelected.has('directory:a'), true, '真实鼠标首击仍应选择');
        f.tap(row, { detail: 2, pointerType: 'mouse' });
        f.dispatch(row, 'dblclick', { detail: 2, pointerType: '' });
        assert.equal(f.opened.length, 1); assert.equal(f.opened[0].path, 'a');
        assert.equal(f.context.telegramDriveSelected.has('directory:a'), false, '双击还原首击前状态');
        assert.equal(f.context.telegramDriveSelected.has('directory:b'), true, '其它既定选择保留');
    }
});

test('PC 两次点击间或按下松开间的异步刷新不拆掉未变化的行及名称目标', async () => {
    for (const duringSecondPress of [false, true]) {
        const f = fixture({ mobile: false }), row = f.row(), name = row.children[2].children[0];
        const insertions = row.insertions, removals = row.removals;
        f.tap(row, { target: name, detail: 1 });
        if (duringSecondPress) f.dispatch(row, 'pointerdown', { target: name, detail: 2 });
        // Use the production async refresh path: new JSON objects and another
        // completed upload appearing in the listing, with the clicked item unchanged.
        await f.refresh({ path: '', folders: [{ kind: 'directory', path: 'new', name: '新增' }, { ...f.first }, { ...f.second }], files: [] });
        assert.equal(f.row(1), row); assert.equal(row.children[2].children[0], name);
        assert.equal(row.insertions, insertions); assert.equal(row.removals, removals);
        if (duringSecondPress) { f.dispatch(row, 'pointerup', { target: name, detail: 2 }); f.dispatch(row, 'click', { target: name, detail: 2 }); }
        else f.tap(row, { target: name, detail: 2 });
        f.dispatch(row, 'dblclick', { target: name, detail: 2, pointerType: '' });
        assert.equal(f.opened.length, 1); assert.equal(f.context.telegramDriveSelected.has('directory:a'), false);
    }
});

test('同key记录真实改名/移动/审查及预览数据变化时更新显示与操作对象，复用行同步勾选', async () => {
    const f = fixture({ mobile: false });
    const original = { kind: 'file', id: 'f', name: '旧.txt', folderPath: '', type: 'text/plain', reviewStatus: '', cover: 'old', parts: [{ fileId: 'old-source' }] };
    await f.refresh({ path: '', folders: [], files: [original] });
    const row = f.row(); f.context.telegramDriveSelected.set('file:f', original); f.render();
    assert.equal(f.row(), row); assert.equal(row.children[0].checked, true);
    f.context.telegramDriveSelected.clear(); f.render(); assert.equal(f.row(), row); assert.equal(row.children[0].checked, false);
    const changed = { ...original, name: '新.mp4', folderPath: '目标目录', type: 'video/mp4', reviewStatus: 'blocked', cover: 'new', parts: [{ fileId: 'new-source' }] };
    await f.refresh({ path: '', folders: [], files: [changed] });
    assert.notEqual(f.row(), row); assert.equal(f.row().children[2].children[0].textContent, changed.name);
    f.tap(f.row()); f.tap(f.row(), { detail: 2 }); f.dispatch(f.row(), 'dblclick', { detail: 2, pointerType: '' });
    assert.equal(f.opened[0], changed, '更新后的操作闭包必须使用新记录，不能继续引用旧分片/路径');
});

test('鼠标行外松开后的无按钮hover不启动残留拖动，随后双击正常打开', () => {
    const f = fixture({ mobile: false }), row = f.row();
    f.dispatch(row, 'pointerdown'); f.dispatch(null, 'pointerup');
    f.dispatch(row, 'pointermove', { clientX: 130, buttons: 0 });
    assert.equal(row.captured.size, 0); assert.equal(f.frames.size, 0); assert.equal(f.moved.length, 0);
    f.tap(row); f.tap(row, { detail: 2 }); f.dispatch(row, 'dblclick', { detail: 2, pointerType: '' });
    assert.equal(f.opened.length, 1);
});

test('PC真实拖动产生的click/dblclick均被抑制，下一次完整双击无需等待旧抑制窗口', () => {
    const f = fixture({ mobile: false }), row = f.row();
    f.tap(row); f.dispatch(row, 'pointerdown', { detail: 2 }); f.dispatch(row, 'pointermove', { clientX: 130 }); f.dispatch(row, 'pointerup');
    assert.equal(f.dispatch(row, 'click', { detail: 2 }).stopped, true);
    assert.equal(f.dispatch(row, 'dblclick', { detail: 2, pointerType: '' }).stopped, true); assert.equal(f.opened.length, 0);
    f.tap(row); f.tap(row, { detail: 2 }); f.dispatch(row, 'dblclick', { detail: 2, pointerType: '' });
    assert.equal(f.opened.length, 1);
});

test('滚动合成 click 被抑制，但 700ms 内下一次轻触立即停止惯性并打开', () => {
    const f = fixture(), row = f.row();
    f.dispatch(row, 'pointerdown'); f.advance(20); f.dispatch(row, 'pointermove', { clientY: 30 }); f.dispatch(row, 'pointerup', { clientY: 30 });
    assert.equal(f.list.scrollTop, 100); assert.ok(f.frames.size > 0);
    assert.equal(f.dispatch(row, 'click').stopped, true); assert.equal(f.opened.length, 0);
    f.advance(50); f.tap(f.row(1));
    assert.equal(f.frames.size, 0); assert.equal(f.opened.length, 1); assert.equal(f.opened[0].path, 'b');
});

test('长按拖动结束的合成 click 被抑制，下一次同一行轻触无需等抑制超时', () => {
    const f = fixture(), row = f.row();
    f.dispatch(row, 'pointerdown'); f.hold(); f.dispatch(row, 'pointerup');
    assert.equal(f.dispatch(row, 'click').stopped, true); assert.equal(f.opened.length, 0); assert.equal(f.moved.length, 0);
    f.advance(50); f.tap(row);
    assert.equal(f.opened.length, 1); assert.equal(row.captured.size, 0);
});

test('显式复选框多选保留，复选框和操作按钮的长按不启动行拖动', () => {
    const f = fixture(), row = f.row(), checkbox = row.children[0], button = row.children.at(-1);
    f.dispatch(row, 'pointerdown', { target: checkbox }); assert.equal(f.timers.size, 0);
    f.dispatch(row, 'pointerup', { target: checkbox }); f.dispatch(row, 'click', { target: checkbox });
    assert.equal(f.context.telegramDriveSelected.size, 1); assert.equal(f.selection.hidden, false);
    f.tap(f.row(1)); assert.equal(f.context.telegramDriveSelected.size, 2); assert.equal(f.opened.length, 0);
    f.dispatch(row, 'pointerdown', { target: button }); assert.equal(f.timers.size, 0);
});

test('刷新删除失效选择并恢复单击打开，过滤和有效全盘搜索选择继续保留', () => {
    const f = fixture();
    f.context.telegramDriveSelected.set('directory:a', f.first); f.context.telegramDriveSelectionAnchor = 'directory:a';
    f.filter(item => item.path === 'b'); f.render();
    assert.equal(f.context.telegramDriveSelected.size, 1, '本级过滤不应删除有效选择');
    const outside = { kind: 'directory', path: 'outside', name: '全盘结果' };
    f.context.telegramDriveSearchData = { folders: [outside], files: [] };
    f.context.telegramDriveSelected.set('directory:outside', outside); f.render();
    assert.equal(f.context.telegramDriveSelected.size, 2);
    f.context.telegramDriveSearchData = null;
    f.context.telegramDriveCurrentData = { folders: [{ ...f.second, name: '已更新' }], files: [] };
    f.render(); assert.equal(f.context.telegramDriveSelected.size, 0); assert.equal(f.context.telegramDriveSelectionAnchor, ''); assert.equal(f.selection.hidden, true);
    f.tap(f.row()); assert.equal(f.opened.length, 1);
    f.context.telegramDriveSelected.set('directory:b', f.second); f.render();
    assert.equal(f.context.telegramDriveSelected.get('directory:b').name, '已更新');
});
