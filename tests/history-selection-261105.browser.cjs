'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const source = fs.readFileSync('app.js', 'utf8');

test('the wide record menu anchors to the gesture and stays within the viewport', async t => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1000, height: 750 }, hasTouch: true });
    page.setDefaultTimeout(4500);
    await page.setContent(`<main><div id="chatMessages"><article class="message" data-message-id="row" style="animation:none">
        <div class="message-bubble" style="position:fixed;inset:0;width:100%;max-width:none">Attachment</div>
        </article></div><div id="historySelectionActions" hidden></div></main>`);
    await page.addStyleTag({ path: 'client/index.css' });
    const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    await page.addScriptTag({ content: `
        function createRecordActionButton(_icon, text) {
            const button = document.createElement('button'); button.className = 'history-action'; button.textContent = text; return button;
        }
        ${section('function renderMessageRecordActions(', 'async function toggleTransferRecordFavorite(')}
        ${section('function openMessageRecordActionMenu(', 'async function editTransferRecordRemark(')}
        renderMessageRecordActions(document.querySelector('.message'), { id:'row', type:'text' });
        initHistoryRecordSelection();
    ` });
    const menu = page.getByRole('menu');
    const bubble = page.locator('.message-bubble');
    const close = () => page.locator('.message-record-action-menu-layer').evaluate(layer => layer.click());
    const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1, `${actual} is not at ${expected}`);
    await page.mouse.click(300, 150, { button: 'right' });
    let box = await menu.boundingBox();
    near(box.x, 300); near(box.y, 150);
    await close();
    await page.mouse.click(992, 742, { button: 'right' });
    box = await menu.boundingBox();
    near(box.x + box.width, 992); near(box.y + box.height, 742);
    await close();

    await bubble.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 10, clientX: 990, clientY: 740 });
    assert.equal(await bubble.evaluate(node => node.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true }))), false);
    await bubble.dispatchEvent('pointermove', { pointerType: 'touch', pointerId: 10, clientX: 994, clientY: 744 });
    await menu.waitFor();
    assert.equal(await menu.locator('.history-action').first().evaluate(node => getComputedStyle(node).userSelect), 'none');
    box = await menu.boundingBox();
    near(box.x + box.width, 994); near(box.y + box.height, 744);
    await bubble.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 10 });
    await close();

    await page.setViewportSize({ width: 800, height: 150 });
    await page.mouse.click(400, 75, { button: 'right' });
    box = await menu.boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 150);
    assert.ok(await menu.evaluate(node => node.scrollHeight > node.clientHeight));
    await close();

    await page.setViewportSize({ width: 390, height: 640 });
    await page.mouse.click(300, 150, { button: 'right' });
    await page.waitForFunction(() => !document.querySelector('[role="menu"]').getAnimations().length);
    box = await menu.boundingBox();
    near(box.x, 0); near(box.width, 390); near(box.y + box.height, 640);
});

test('right click and touch long press distinguish the record bubble from its row and preserve the composer', async t => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 720, height: 640 }, hasTouch: true });
    await page.setContent(`<main><div id="chatMessages">
        <article class="message" data-message-id="file1" data-type="file"><div class="message-bubble">Attachment</div><button class="message-record-menu-trigger">☰</button></article>
        <article class="message" data-message-id="text1" data-type="text"><div class="message-bubble">Text</div><button class="message-record-menu-trigger">☰</button></article>
        </div><div id="fileUploadComposer">Upload</div><div class="input-area"><textarea id="textInput">draft message</textarea></div>
        <div id="historySelectionActions" hidden></div></main>`);
    await page.addStyleTag({ path: 'client/index.css' });
    const start = source.indexOf('const selectedHistoryIds =');
    const end = source.indexOf('async function toggleTransferRecordFavorite(', start);
    assert.ok(start >= 0 && end > start);
    await page.addScriptTag({ content: `
        const state = { sessionId: 'fixture-tunnel' };
        const records = {
            file1: { id: 'file1', type: 'file', sessionId: 'fixture-tunnel', text: 'file text' },
            text1: { id: 'text1', type: 'text', sessionId: 'fixture-tunnel', text: 'ordinary text' }
        };
        const getFromStore = async (_store, id) => records[id];
        const showAppToast = text => window.toast = text;
        const copyTextToClipboard = async text => { window.copied = text; return true; };
        const recordTextPayload = record => ({ text: record.text });
        const getTransferRecordAnchorUrl = id => 'https://fixture.example/?record=' + id;
        const deleteHistoryMessage = async ids => { window.deleted = ids; return true; };
        let menus = 0;
        document.querySelectorAll('.message-record-menu-trigger').forEach(button => button.addEventListener('record-menu-open', () => { menus++; }));
        ${source.slice(start, end)}
        initHistoryRecordSelection();
    ` });
    const file = page.locator('[data-message-id="file1"]');
    const toolbar = page.locator('#historySelectionActions');
    await file.locator('.message-bubble').click({ button: 'right' });
    assert.equal(await page.evaluate(() => menus), 1);
    assert.equal(await toolbar.isVisible(), false);
    await file.click({ button: 'right', position: { x: 400, y: 15 } });
    assert.equal(await file.locator('.history-selection-check').count(), 1);
    assert.equal(await page.locator('#fileUploadComposer').isVisible(), false);
    assert.equal(await page.locator('#textInput').isVisible(), false);
    assert.equal(await toolbar.getByText('保存到网盘').isVisible(), true);
    await page.locator('[data-message-id="text1"] .message-bubble').click();
    assert.equal(await toolbar.getByText('保存到网盘').isVisible(), false);
    await toolbar.getByText('复制所有文本').click();
    assert.equal(await page.evaluate(() => copied), 'file text\n\nordinary text');
    await toolbar.getByText('复制所有锚点').click();
    assert.equal(await page.evaluate(() => copied), 'https://fixture.example/?record=file1\n\nhttps://fixture.example/?record=text1');
    await toolbar.getByText('退出多选').click();
    assert.equal(await page.locator('#textInput').inputValue(), 'draft message');
    assert.equal(await toolbar.isVisible(), false);
    await file.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 10, clientX: 400, clientY: 15 });
    await file.locator('.history-selection-check').waitFor();
    await file.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 10 });
    await file.dispatchEvent('contextmenu', { pointerType: 'touch' });
    assert.equal(await file.locator('.history-selection-check').count(), 1, 'native context menu after a long press does not undo selection');
    await toolbar.getByText('删除').click();
    assert.deepEqual(await page.evaluate(() => deleted), ['file1']);
});
