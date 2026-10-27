'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('app.js', 'utf8');
function fixture() {
    let overlay, document;
    class Node {
        constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; }
        append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
        setAttribute(name, value) { this.attrs[name] = value; }
        addEventListener(name, listener) { this.listeners[name] = listener; }
        focus() { document.activeElement = this; }
        scrollIntoView() {}
        contains(node) { return node === this || this.children.some(child => child.contains(node)); }
        after(node) { this.parent.append(node); }
        remove() { this.removed = true; }
        querySelector(selector) { if (selector === '.forward-session-select') return this.select; }
        set innerHTML(html) {
            const select = new Node('select');
            select.options = [...html.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(([, value, textContent]) => ({ value, textContent }));
            select.value = select.options[0].value; this.select = select; this.append(select);
        }
    }
    document = { activeElement: null, createElement: tag => new Node(tag), body: { appendChild: node => { overlay = node; } } };
    const context = { document, state: { sessionId: 'current' }, generateId: () => 'picker-fixture', window: {},
        LAST_FORWARD_SESSION_STORAGE_KEY: 'last-forward', localStorage: { getItem: () => 'target-b' }, escapeHtml: String,
        getAllFromStore: async () => [{ sessionId: 'current', shortCode: '00000' }, { sessionId: 'target-a', shortCode: '11111', remark: '' }, { sessionId: 'target-b', shortCode: '22222', remark: '乙' }] };
    vm.runInNewContext(source.slice(source.indexOf('async function chooseForwardTargetSession()'), source.indexOf('async function cloneForwardFileInfo(')), context);
    return { context, get overlay() { return overlay; }, get document() { return document; } };
}
test('desktop choice and mobile native selection share one destination, only confirmation completes forwarding', async () => {
    const f = fixture(); let completed = false;
    const selection = f.context.chooseForwardTargetSession().then(value => { completed = true; return value; }); await new Promise(setImmediate);
    const overlay = f.overlay, select = overlay.select, picker = overlay.children[1], [toggle, list] = picker.children;
    assert.equal(select.options.length, 2); assert.equal(select.options[0].textContent, '11111'); assert.equal(select.value, 'target-b'); assert.equal(toggle.textContent, '22222 · 乙 ▾');
    toggle.onclick(); assert.equal(list.hidden, false); assert.equal(f.document.activeElement.dataset.value, 'target-b');
    list.children[0].onclick(); assert.equal(select.value, 'target-a'); assert.equal(list.hidden, true); assert.equal(completed, false);
    select.value = 'target-b'; select.onchange(); assert.equal(toggle.textContent, '22222 · 乙 ▾');
    overlay.listeners.click({ target: { closest: selector => selector === '[data-forward-confirm]' } });
    assert.equal(await selection, 'target-b'); assert.equal(overlay.removed, true);
});
test('keyboard navigation and Escape do not accidentally submit the selected tunnel', async () => {
    const f = fixture(), selection = f.context.chooseForwardTargetSession(); await new Promise(setImmediate);
    const overlay = f.overlay, picker = overlay.children[1], [toggle, list] = picker.children;
    toggle.focus(); picker.onkeydown({ key: 'Home', preventDefault() {} }); assert.equal(f.document.activeElement.dataset.value, 'target-a');
    picker.onkeydown({ key: 'ArrowDown', preventDefault() {} }); assert.equal(f.document.activeElement.dataset.value, 'target-b');
    picker.onkeydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(list.hidden, true); assert.equal(f.document.activeElement, toggle);
    overlay.listeners.click({ target: { closest: selector => selector === '[data-forward-cancel]' } }); assert.equal(await selection, '');
});
