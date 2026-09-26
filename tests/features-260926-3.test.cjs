const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function extract(file, from, to) {
    const source = fs.readFileSync(file, 'utf8');
    return source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
}

function classes() {
    const values = new Set();
    return {
        add: value => values.add(value),
        remove: value => values.delete(value),
        contains: value => values.has(value),
        toggle(value, enabled) { if (enabled) values.add(value); else values.delete(value); }
    };
}

function touchFixture() {
    const handlers = new Map(), timers = new Map(), calls = { inserts: 0, moves: [], menus: [], renders: [] };
    let nextTimer = 1, hit = null;
    const listen = (name, callback) => handlers.set(name, callback);
    const file = { dataset: { webPath: 'photo.png', webDirectory: 'false' }, classList: classes(), draggable: true };
    const directory = { dataset: { webPath: 'assets/', webDirectory: 'true' }, classList: classes(), draggable: true };
    file.closest = selector => selector === '[data-web-path]' ? file : null;
    directory.closest = selector => ['[data-web-path]', '[data-web-directory="true"]'].includes(selector) ? directory : null;
    const textarea = {
        value: 'ab', selectionStart: 2, selectionEnd: 2, isConnected: true,
        classList: classes(), style: {}, focus() {}, blur() {},
        setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); },
        dispatchEvent() { calls.inserts++; }
    };
    const tree = {
        classList: classes(), scrollTop: 0,
        addEventListener: listen,
        contains: element => [tree, file, directory].includes(element),
        querySelectorAll: () => [tree, file, directory].filter(element => element.classList.contains('is-drop-target')),
        getBoundingClientRect: () => ({ left: 0, right: 140, top: 0, bottom: 300 })
    };
    const draft = { files: [{ path: file.dataset.webPath }, { path: directory.dataset.webPath }] };
    const document = {
        activeElement: null,
        addEventListener: listen,
        removeEventListener(name, callback) { if (handlers.get(name) === callback) handlers.delete(name); },
        elementFromPoint: () => hit,
        createElement: () => ({ className: '', textContent: '', style: {}, remove() {} }),
        body: { append() {} }
    };
    const context = {
        document, content: { querySelector: selector => selector === 'textarea' ? textarea : null },
        overlay: { classList: classes() }, window: { getSelection: () => ({ removeAllRanges() {} }) },
        editorSession: { draft, path: 'index.html' },
        mediaHtmlTag: () => '<img src="photo.png">', isDirectory: item => item.path.endsWith('/'),
        baseName: path => path.split('/').filter(Boolean).at(-1),
        moveDraftEntry: async (...args) => { calls.moves.push(args); return 'assets/photo.png'; },
        renderEditor: (...args) => calls.renders.push(args),
        showTreeDirectoryMenu: (...args) => calls.menus.push(args),
        showError: error => { throw error; },
        setTimeout: callback => { const id = nextTimer++; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id),
        Event: class { constructor(type) { this.type = type; } }
    };
    const source = extract('client/web-workshop.js', '    function installTreeDirectoryGestures(', '    function installMediaInsertion(');
    vm.runInNewContext(`${source}\ninstallTreeDirectoryGestures(tree, draft);`, { ...context, tree, draft });
    const point = (x, y) => ({ identifier: 1, clientX: x, clientY: y });
    return {
        file, directory, textarea, calls, timers, setHit: element => { hit = element; },
        start: (row, x = 20, y = 40) => handlers.get('touchstart')({ target: row, touches: [point(x, y)] }),
        move: (x, y) => {
            let prevented = false;
            handlers.get('touchmove')?.({ touches: [point(x, y)], preventDefault() { prevented = true; } });
            return prevented;
        },
        end: (x, y) => handlers.get('touchend')?.({ changedTouches: [point(x, y)] }),
        hold: () => { const callback = timers.values().next().value; assert.ok(callback); callback(); }
    };
}

test('网页工坊触屏短滑保留滚动，长按文件后可插入 HTML 或确认移动', async () => {
    const ui = touchFixture();
    ui.start(ui.file);
    assert.equal(ui.move(20, 70), false);
    assert.equal(ui.timers.size, 0);

    ui.start(ui.file);
    ui.hold();
    ui.setHit(ui.textarea);
    assert.equal(ui.move(230, 90), true);
    await ui.end(230, 90);
    assert.equal(ui.textarea.value, 'ab<img src="photo.png">');
    assert.equal(ui.calls.inserts, 1);
    assert.equal(ui.calls.moves.length, 0);
    assert.equal(ui.file.draggable, true);

    ui.start(ui.file);
    ui.hold();
    ui.setHit(ui.directory);
    ui.move(80, 90);
    await ui.end(80, 90);
    assert.equal(ui.calls.moves.length, 1);
    assert.equal(ui.calls.moves[0][1], 'photo.png');
    assert.equal(ui.calls.moves[0][2], 'assets/');
    assert.equal(ui.calls.renders.length, 1);

    ui.start(ui.directory);
    ui.hold();
    await ui.end(20, 40);
    assert.equal(ui.calls.menus.length, 1);
});

test('传输记录跳转按钮仅在滚动期间显示，停下 1.5 秒后隐藏', () => {
    const listeners = new Map(), timers = new Map(), shell = { classList: classes() };
    let nextTimer = 1;
    const button = () => ({ tabIndex: -1, attributes: {}, addEventListener(name, callback) { this[name] = callback; }, setAttribute(name, value) { this.attributes[name] = value; } });
    const top = button(), bottom = button();
    const container = { scrollHeight: 1200, clientHeight: 300, addEventListener: (name, callback) => listeners.set(name, callback), scrollTo(options) { this.lastScroll = options; } };
    const elements = { chatMessages: container, chatMessagesShell: shell, chatJumpTopBtn: top, chatJumpBottomBtn: bottom };
    const source = extract('app.js', 'function initChatJumpButtons()', 'function insertMessageElementByTimestamp(');
    const context = {
        document: { getElementById: id => elements[id] }, window: { matchMedia: () => ({ matches: false }) },
        setTimeout: (callback, delay) => { assert.equal(delay, 1500); const id = nextTimer++; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id)
    };
    vm.runInNewContext(`${source}\ninitChatJumpButtons();`, context);
    assert.equal(shell.classList.contains('is-scrolling'), false);
    listeners.get('scroll')();
    assert.equal(shell.classList.contains('is-scrolling'), true);
    assert.equal(top.tabIndex, 0);
    bottom.click({ stopPropagation() {} });
    assert.equal(container.lastScroll.top, 1200);
    top.click({ stopPropagation() {} });
    assert.equal(container.lastScroll.top, 0);
    timers.values().next().value();
    assert.equal(shell.classList.contains('is-scrolling'), false);
    assert.equal(bottom.attributes['aria-hidden'], 'true');
});
