'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workshop = fs.readFileSync(path.join(__dirname, '..', 'client/web-workshop.js'), 'utf8');
const block = (start, end) => workshop.slice(workshop.indexOf(start), workshop.indexOf(end, workshop.indexOf(start)));

test('网页工坊可见性由独立状态控制：历史变化与内容加载不解除最小化', () => {
    let popstate;
    const topbar = { hidden:true };
    const content = {};
    const buttons = new Map();
    const overlay = {
        hidden:true, className:'web-workshop',
        classList:{ active:false, toggle(_name, enabled) { this.active = enabled; } },
        querySelector(selector) {
            if (selector === '.web-workshop-content') return content;
            if (!buttons.has(selector)) buttons.set(selector, {});
            return buttons.get(selector);
        }
    };
    const history = {
        state:{}, pushes:0, backs:0,
        pushState(value) { this.state = value; this.pushes++; },
        back() { this.backs++; }
    };
    const context = vm.createContext({
        window:{ addEventListener(name, handler) { if (name === 'popstate') popstate = handler; } },
        document:{
            createElement:() => overlay, body:{ append() {} },
            getElementById:id => id === 'topbarWorkshopBtn' ? topbar : null,
            addEventListener() {}
        },
        history, location:{ href:'https://example.test/' },
        clearTimeout() {}, renderHome() {}, revokePreviewUrls() {},
        commitPackageName() {}, commitEditorBuffer() {}, saveDraft:async () => {},
        config:{}, activeDraft:null, editorSession:null, saveTimer:null,
        historyOpen:false, presentationMode:'closed', presentationRevision:0
    });
    vm.runInContext(`
        let overlay, content;
        ${block('function ensureUi()', 'function commitPackageName(')}
        ${block('function open()', 'async function cleanupSandboxes(')}
        this.controls = { open, close, minimize, restore, showForContent, focusSourceRecord };
        this.mode = () => presentationMode;
    `, context);
    const { controls } = context;
    controls.open();
    assert.equal(context.mode(), 'open');
    assert.equal(overlay.hidden, false);
    controls.minimize();
    assert.equal(context.mode(), 'minimized');
    assert.equal(overlay.hidden, true);
    assert.equal(topbar.hidden, false);

    popstate({ state:{ unrelatedLayer:true } });
    assert.equal(context.mode(), 'minimized', 'unrelated history event must not close minimized workshop');
    controls.showForContent();
    assert.equal(context.mode(), 'minimized', 'import/preview content must not restore workshop');
    assert.equal(overlay.hidden, true);
    assert.equal(topbar.hidden, false);

    controls.restore();
    assert.equal(context.mode(), 'open');
    assert.equal(history.pushes, 2, 'restore creates a new history entry after the previous one was popped');
    controls.minimize();
    controls.close();
    assert.equal(context.mode(), 'closed');
    assert.equal(overlay.hidden, true);
    assert.equal(topbar.hidden, true);

    const focused = [];
    context.config.focusMessage = id => focused.push(id);
    controls.open();
    const pushes = history.pushes, backs = history.backs;
    controls.focusSourceRecord('message-1');
    assert.equal(context.mode(), 'minimized', '原记录跳转收起工坊但保留其 UI 状态');
    assert.equal(topbar.hidden, false, '顶栏必须保留恢复入口');
    assert.equal(overlay.hidden, true);
    assert.equal(history.pushes, pushes); assert.equal(history.backs, backs, '跳转不走关闭或 history.back');
    controls.focusSourceRecord('message-2');
    assert.equal(context.mode(), 'minimized');
    assert.deepEqual(focused, ['message-1', 'message-2']);
    controls.restore();
    assert.equal(context.mode(), 'open');
    assert.equal(topbar.hidden, true);
});

test('预览、草稿重绘和 ZIP 导入不直接切换最小化状态；发布成功后才返回传输记录', () => {
    const operations = [
        block('async function renderHome()', 'const isText='),
        block('async function renderEditor(', 'async function renderPreview('),
        block('async function renderPreview(', 'async function publishDraft(')
    ];
    for (const operation of operations) {
        assert.doesNotMatch(operation, /\b(?:restore|minimize|setPresentationMode|showForContent)\(/);
    }
    const importBlock = block('async function importPackage(', 'async function openPackage(');
    const packageBlock = block('async function openPackage(', 'function init(');
    assert.doesNotMatch(importBlock + packageBlock, /\b(?:restore|minimize|setPresentationMode)\(/);
    assert.match(importBlock, /showForContent\(\)/);
    assert.match(packageBlock, /showForContent\(\)/);
    assert.match(importBlock, /if\(revision!==presentationRevision\)return/);
    assert.match(packageBlock, /if\(revision!==presentationRevision\)return/);
    const publish = block('async function publishDraft(', 'async function packageSandbox(');
    assert.doesNotMatch(publish, /\b(?:close|restore|setPresentationMode)\(/);
    assert.match(publish, /if\(presentationMode==='open'\)minimize\(\);\s*config\.focusFile\?\.\(fileId\)/);
});

test('预览异步挂载完成后不会把已最小化的网页工坊展开', async () => {
    let finishMount;
    const status = { isConnected:true, textContent:'' };
    const frameSlot = { replaceWith(frame) { this.frame = frame; } };
    const content = {
        innerHTML:'',
        querySelector(selector) {
            if (selector === '.web-workshop-preview-status strong') return status;
            if (selector === '.web-workshop-preview-status') return frameSlot;
            if (selector === '[data-preview-back]') return {};
            return null;
        }
    };
    const overlay = { hidden:true };
    const context = vm.createContext({
        content, overlay, presentationMode:'minimized', activeDraft:null,
        previewEpoch:0, previewRuntimeIds:[],
        commitEditorBuffer() {}, revokePreviewUrls() {}, escapeHtml:value => value,
        restore() { throw new Error('render must not restore'); },
        document:{ createElement:() => ({ setAttribute() {} }) },
        global:{ WebZipRuntime:{ mount:() => new Promise(resolve => { finishMount = resolve; }), unmount:async () => {} } },
        Promise
    });
    vm.runInContext(`${block('async function renderPreview(', 'async function publishDraft(')}\nthis.preview = renderPreview;`, context);
    const pending = context.preview([], 'test.html.zip', () => {});
    assert.equal(overlay.hidden, true);
    finishMount({ id:'runtime', url:'/web-zip-runtime/runtime/index.html' });
    await pending;
    assert.equal(context.presentationMode, 'minimized');
    assert.equal(overlay.hidden, true);
    assert.equal(frameSlot.frame.src, '/web-zip-runtime/runtime/index.html');
});

test('发布成功先最小化工坊，再聚焦传输记录；已最小化时不重复切换', async () => {
    for (const initialMode of ['open', 'minimized']) {
        const events = [];
        const context = vm.createContext({
            presentationMode:initialMode, saveTimer:0, editorSession:null, activeDraft:null,
            clearTimeout() {}, commitEditorBuffer() {}, updatePackageManifest() {},
            setEditorSaveStatus() {}, flushEditorDraft:async () => ({ archive:new Uint8Array([1]) }),
            safeName:name => name, File,
            config:{ deviceId:() => 'device', publishNew:async () => 'file-1', focusFile:id => events.push(`focus:${id}`), toast() {} },
            remove:async () => {}, renderHome:async () => events.push('home'),
            minimize() { events.push('minimize'); context.presentationMode = 'minimized'; }
        });
        vm.runInContext(`${block('async function publishDraft(', 'async function packageSandbox(')}\nthis.publishDraft = publishDraft;`, context);
        await context.publishDraft({ id:'draft-1', name:'page', files:[] });
        assert.deepEqual(events, initialMode === 'open' ? ['home', 'minimize', 'focus:file-1'] : ['home', 'focus:file-1']);
        assert.equal(context.presentationMode, 'minimized');
    }
});
