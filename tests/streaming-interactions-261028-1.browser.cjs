'use strict';
// Optional real-browser regression. Pass the installed Playwright module path
// as argv[2], or install Playwright in the local test environment.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const { createFixture } = require('./support/streaming-console-fixture.cjs');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const output = path.join(root, '.npm-cache');
fs.mkdirSync(output, { recursive: true });

async function run() {
    const fixture = await createFixture({ media: true });
    let browser;
    try {
        const owner = { deviceId: 'device-A', userId: null, logins: [] };
        fixture.streaming.service.register('device-A', 'device-A'.repeat(8), '隔离供源');
        const station = fixture.streaming.service.create(owner, { name: '长节目单交互验收', creationId: 'interaction-261028' });
        await fixture.streaming.service.edit(station.id, owner, { configVersion: 1, loop: true, items: Array.from({ length: 24 }, (_, i) => ({
            id: 'program-' + i, stay: 120, source: { kind: 'tunnel', sessionId: 'fixture-tunnel', messageId: 'image-record', fileId: 'image-asset', accessGrant: 'fixture-proof' }
        })) });
        fixture.streaming.service.visibility(station.id, owner, { visibility: 'public', version: fixture.streaming.service.station(station.id).playback.version });
        const control = (action, extra = {}) => fixture.streaming.service.control(station.id, owner, {
            action, ...extra, version: fixture.streaming.service.station(station.id).playback.version
        });
        fixture.app.get('/responsive-261028', (_req, res) => {
            const code = read('app.js');
            const init = code.slice(code.indexOf('function initAdaptiveWorkspaceLayout()'), code.indexOf('function setMobileWorkspaceView('));
            const html = read('pages/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
            res.type('html').send(html.replace('</body>', `<script>${init}
                document.getElementById('tunnelStartupLoading').hidden=true;
                document.getElementById('sessionLanding').hidden=true;
                document.getElementById('appShell').hidden=false;
                document.getElementById('tunnelTopbar').hidden=false;
                initAdaptiveWorkspaceLayout();</script></body>`));
        });
        fixture.app.get('/interaction-261028', (req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <link rel="stylesheet" href="/client/streaming-console.css">
            <script src="/client/streaming-player.js"></script><script src="/client/streaming-console.js"></script>
            <body><h1>隔离功能首页</h1><script>StreamingConsole.init({deviceId:()=> '${req.query.device === 'phone' ? 'interaction-phone' : 'interaction-viewer'}',deviceName:()=> '隔离观看者',devices:()=>[],tunnels:async()=>[],toast:()=>{},home:()=>{}});StreamingConsole.open();</script>`));

        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(fixture.base + '/responsive-261028');
        const matrix = [];
        for (const width of [1440, 1201, 1200, 1100, 1099, 1024, 800, 768, 767, 390]) {
            await page.setViewportSize({ width, height: 900 });
            for (const theme of ['', 'graphite', 'atelier']) {
                await page.evaluate(value => { document.body.dataset.theme = value; }, theme);
                const layout = await page.evaluate(() => {
                    const shell = document.getElementById('appShell'), grid = shell.querySelector('.main-layout');
                    const visible = node => getComputedStyle(node).display !== 'none';
                    const panels = [...grid.children].map(node => ({ ...Object.fromEntries(['x','y','width','height'].map(k => [k,node.getBoundingClientRect()[k]])), visible: visible(node) }));
                    return { display: getComputedStyle(grid).display, panels, trigger: visible(document.getElementById('workspaceCollabOpen')), height: shell.getBoundingClientRect().bottom, overflow: document.documentElement.scrollWidth > innerWidth, topbar: document.getElementById('tunnelTopbar').getBoundingClientRect().bottom };
                });
                if (width >= 1100) {
                    assert.equal(layout.display, 'grid'); assert.equal(layout.trigger, false);
                    assert.ok(layout.panels.every(panel => panel.visible));
                    assert.ok(Math.abs(layout.panels[0].y - layout.panels[1].y) < 1);
                    assert.ok(layout.panels[1].width >= 350, 'transfer column must remain usable');
                } else if (width >= 768) {
                    assert.equal(layout.display, 'grid'); assert.equal(layout.trigger, true);
                    assert.equal(layout.panels[2].visible, false);
                    assert.ok(Math.abs(layout.panels[0].y - layout.panels[1].y) < 1);
                    assert.ok(layout.panels[1].width >= 400);
                } else assert.equal(layout.display, 'flex');
                assert.equal(layout.overflow, false); assert.ok(layout.height <= 901);
            }
            matrix.push({ width, mode: width >= 1100 ? 'A' : width >= 768 ? 'D' : 'B' });
        }
        console.log('layout matrix', JSON.stringify(matrix));
        await page.setViewportSize({ width: 1024, height: 800 });
        await page.evaluate(() => { document.body.dataset.theme = ''; });
        await page.screenshot({ path: path.join(output, '261028-1-layout-d.png') });
        const editor = page.locator('#editor');
        await page.getByRole('button', { name: '📝 协同编辑' }).click();
        await editor.fill('展开与收起保留这段编辑内容');
        const overlay = await page.locator('#workspaceCollabPanel').boundingBox(), bar = await page.locator('#tunnelTopbar').boundingBox();
        assert.ok(overlay.y >= bar.y + bar.height - 1);
        assert.ok(overlay.y + overlay.height >= 799);
        await page.screenshot({ path: path.join(output, '261028-1-layout-editor.png') });
        await page.getByRole('button', { name: '关闭', exact: true }).click();
        await page.getByRole('button', { name: '📝 协同编辑' }).click();
        assert.equal(await editor.textContent(), '展开与收起保留这段编辑内容');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#workspaceCollabOpen').getAttribute('aria-expanded'), 'false');
        await page.getByRole('button', { name: '📝 协同编辑' }).click();
        await page.setViewportSize({ width: 1366, height: 900 });
        await page.waitForFunction(() => !document.getElementById('appShell').classList.contains('workspace-collab-open'));
        assert.equal(await editor.textContent(), '展开与收起保留这段编辑内容');
        assert.equal(await page.locator('#appShell').evaluate(el => el.classList.contains('workspace-collab-open')), false);

        // Minimal red-capable mute repro: hold across the real 250ms update.
        await page.goto(fixture.base + '/api/stream-fixture');
        await page.setContent('<style>' + read('client/streaming-console.css') + '</style><div class="sc-overlay"><main class="sc-viewer-page"></main></div>');
        await page.addScriptTag({ content: read('client/streaming-player.js') });
        await page.evaluate(() => {
            const player = StreamingPlayer.create({ stationId: 'minimal', watchId: 'watch', subscribe: () => () => {}, request: async () => ({
                url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVioAAAAASUVORK5CYII=', expiresAt: Date.now() + 600000
            }) });
            document.querySelector('main').append(player.element); window.testPlayer = player;
            player.apply({ id: 'minimal', configVersion: 1, serverTime: Date.now(), items: [{ id: 'item', kind: 'image', stay: 10000 }], playback: { itemId: 'item', status: 'playing', position: 0, version: 1 } });
        });
        await page.getByRole('button', { name: '媒体全屏', exact: true }).click();
        const mute = page.locator('.sc-sound-toggle');
        for (let i = 0; i < 16; i++) {
            const label = await mute.getAttribute('aria-label'), box = await mute.boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
            await page.waitForTimeout([80, 180, 280, 380][i % 4]); await page.mouse.up();
            assert.notEqual(await mute.getAttribute('aria-label'), label, 'mouse click must survive periodic text updates');
        }
        await page.evaluate(() => window.testPlayer.close());
        console.log('held full-screen mute clicks: 16/16');

        await page.goto(fixture.base + '/interaction-261028');
        await page.locator('article').filter({ hasText: '长节目单交互验收' }).getByRole('button', { name: '打开观看', exact: true }).click();
        await page.locator('.sc-now-playing').waitFor();
        control('select', { itemId: 'program-12' });
        await page.waitForFunction(() => [...document.querySelectorAll('.sc-watch-item')].indexOf(document.querySelector('.sc-now-playing')) === 12);
        await page.waitForFunction(() => {
            const row = document.querySelector('.sc-now-playing'), panel = row.parentElement;
            const clip = document.querySelector('.sc-main').getBoundingClientRect(), box = panel.getBoundingClientRect();
            const top = Math.max(box.top + panel.clientTop, clip.top, 0), bottom = Math.min(box.top + panel.clientTop + panel.clientHeight, clip.bottom, innerHeight);
            return Math.abs(row.getBoundingClientRect().y + row.clientHeight / 2 - (top + bottom) / 2) < 5;
        });
        await page.evaluate(() => { window.currentRow = document.querySelector('.sc-now-playing'); window.playerBefore = document.querySelector('.sc-player'); });
        control('pause');
        await page.locator('.sc-buffering').filter({ hasText: '已被管理员暂停' }).waitFor();
        assert.equal(await page.evaluate(() => window.currentRow === document.querySelector('.sc-now-playing')), true, 'same-item reports retain row DOM');
        control('play');
        await page.getByRole('button', { name: '小窗播' }).click();
        const mini = page.locator('.sc-mini-window');
        const visibleButtons = await mini.locator('button:visible').allTextContents();
        assert.equal(visibleButtons.length, 3); assert.ok(visibleButtons.includes('×'));
        assert.equal(await mini.locator('input:visible').count(), 0);
        assert.equal(await mini.locator('.sc-play-status').isVisible(), false);
        assert.equal(await mini.locator('.sc-background-toggle').isVisible(), false);
        const oldBox = await mini.boundingBox();
        await page.mouse.move(oldBox.x + oldBox.width / 2, oldBox.y + 60); await page.mouse.down();
        await page.mouse.move(oldBox.x + oldBox.width / 2 - 120, oldBox.y + 10, { steps: 8 }); await page.mouse.up();
        assert.ok((await mini.boundingBox()).x < oldBox.x - 100);
        assert.equal(await page.locator('#streamingConsole').isVisible(), false, 'a drag must not restore the station');
        const box = await mini.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + 60);
        assert.equal(await page.locator('#streamingConsole').isVisible(), true);
        assert.equal(await page.evaluate(() => window.playerBefore === document.querySelector('.sc-player')), true);
        await page.getByRole('button', { name: '小窗播' }).click();
        await page.screenshot({ path: path.join(output, '261028-1-mini.png') });
        await mini.getByRole('button', { name: '关闭小窗' }).click();
        assert.equal(await mini.isVisible(), false);
        assert.equal(await page.locator('#streamingConsole').isVisible(), false);
        const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        const phone = await mobile.newPage();
        phone.setDefaultTimeout(10000);
        await phone.goto(fixture.base + '/interaction-261028?device=phone');
        await phone.locator('article').filter({ hasText: '长节目单交互验收' }).getByRole('button', { name: '打开观看', exact: true }).tap();
        await phone.locator('.sc-now-playing').waitFor();
        const mainScroll = await phone.locator('.sc-main').evaluate(el => el.scrollTop);
        control('select', { itemId: 'program-18' });
        await phone.waitForFunction(() => {
            const row = document.querySelectorAll('.sc-watch-item')[18], panel = row?.parentElement;
            if (!row?.classList.contains('sc-now-playing')) return false;
            const clip = document.querySelector('.sc-main').getBoundingClientRect(), box = panel.getBoundingClientRect();
            const top = Math.max(box.top + panel.clientTop, clip.top, 0), bottom = Math.min(box.top + panel.clientTop + panel.clientHeight, clip.bottom, innerHeight);
            return Math.abs(row.getBoundingClientRect().y + row.clientHeight / 2 - (top + bottom) / 2) < 5;
        });
        assert.equal(await phone.locator('.sc-main').evaluate(el => el.scrollTop), mainScroll, 'playlist positioning must not scroll the mobile playback page');
        await phone.getByRole('button', { name: '小窗播' }).tap();
        await phone.evaluate(() => { window.touchTrace = []; for (const type of ['pointerdown','pointerup','pointercancel','click']) document.addEventListener(type, e => window.touchTrace.push({ type, target: e.target.className, id: e.pointerId, primary: e.isPrimary }), true); });
        const phoneMini = phone.locator('.sc-mini-window'), phoneBox = await phoneMini.boundingBox();
        const cdp = await mobile.newCDPSession(phone);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: phoneBox.x + 100, y: phoneBox.y + 60 }] });
        for (let i = 1; i <= 8; i++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: phoneBox.x + 100 - i * 4, y: phoneBox.y + 60 - i * 12 }] });
            await phone.waitForTimeout(20);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await phone.waitForTimeout(350);
        assert.equal(await phone.locator('#streamingConsole').isVisible(), false);
        const moved = await phoneMini.boundingBox(); assert.ok(moved.y < phoneBox.y - 80);
        const mobileMute = phoneMini.locator('.sc-sound-toggle'), oldLabel = await mobileMute.getAttribute('aria-label');
        await mobileMute.tap();
        try { await phone.waitForFunction(label => document.querySelector('.sc-mini-window .sc-sound-toggle')?.getAttribute('aria-label') !== label, oldLabel, { timeout: 1500 }); }
        catch (error) { console.log('touch trace', await phone.evaluate(() => window.touchTrace)); throw error; }
        assert.notEqual(await mobileMute.getAttribute('aria-label'), oldLabel);
        assert.equal(await phone.locator('#streamingConsole').isVisible(), false);
        await phone.touchscreen.tap(moved.x + 150, moved.y + 60);
        await phone.locator('#streamingConsole').waitFor({ state: 'visible' });
        await mobile.close();
        assert.deepEqual(errors, []);
        console.log('desktop/touch playlist center, preserved rows, mini controls/drag/restore/close: passed');
    } finally { await browser?.close(); await fixture.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
