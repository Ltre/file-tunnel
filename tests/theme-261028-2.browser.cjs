'use strict';
// Optional Chromium regression. All server writes use the existing isolated
// fixture's fresh OS-temp data directory; browser data belongs to a fresh
// context. No production server, .tunnel-data, credentials, or design resource
// is read or changed. Frozen design DOM is used only for geometry coverage;
// live interactions below run the actual app and actual component code.
// Usage: node tests/theme-261028-2.browser.cjs [absolute Playwright module path]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.argv[2] || 'playwright');
const { createFixture } = require('./support/streaming-console-fixture.cjs');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const themes = ['lumen', 'orbit', 'classic', 'graphite', 'atelier', 'social'];
const output = path.join(root, '.npm-cache', 'theme-261028-2');
const geometryKeys = ['x', 'y', 'width', 'height'];

async function geometry(page, selector = 'body *') {
    return page.evaluate(selector => Array.from(document.querySelectorAll(selector), (node, index) => {
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height || ['SCRIPT', 'STYLE', 'LINK', 'META'].includes(node.tagName)) return null;
        return {
            key: index + ':' + node.tagName + '#' + node.id + '.' + (typeof node.className === 'string' ? node.className : ''),
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            metrics: ['display', 'position', 'visibility', 'overflowX', 'overflowY', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
                'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
                'borderTopWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth'].map(key => style[key]).join('|')
        };
    }).filter(Boolean), selector);
}

function sameGeometry(before, after, label) {
    assert.equal(after.length, before.length, label + ': visible node count');
    const failures = [];
    for (let i = 0; i < before.length; i++) {
        const a = before[i], b = after[i];
        if (a.key !== b.key || a.metrics !== b.metrics || geometryKeys.some(key => Math.abs(a[key] - b[key]) > .25)) {
            failures.push({ node: a.key, before: a, after: b });
        }
    }
    assert.equal(failures.length, 0, label + ': geometry differences ' + JSON.stringify(failures.slice(0, 5)));
}

async function skin(page, theme) {
    await page.evaluate(value => {
        if (typeof applyTheme === 'function') applyTheme(value);
        else document.body.dataset.theme = value;
    }, theme);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function run() {
    fs.mkdirSync(output, { recursive: true });
    const fixture = await createFixture();
    let browser;
    const report = { isolation: 'fresh fixture OS-temp directory and fresh browser contexts; non-fixture requests blocked', layouts: [], interactions: [], snapshots: [] };
    try {
        assert.notEqual(path.resolve(fixture.dataDir), path.join(root, '.tunnel-data'));
        fixture.app.use('/theme-design-readonly', express.static(path.join(root, 'prompts/resources/UI-261026')));
        fixture.app.get('/theme-live', (_req, res) => res.type('html').send(read('pages/index.html')));
        fixture.app.get('/theme-preference-host', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><title>隔离主题偏好宿主页</title>'));
        fixture.app.get('/theme-standalone/:name', (req, res) => {
            if (!['downloadList', 'downloader', 'light-file-parts', 'device'].includes(req.params.name)) return res.sendStatus(404);
            res.type('html').send(read('pages/' + req.params.name + '.html'));
        });
        fixture.app.get('/api/devices/:id', (req, res) => res.json({ device: {
            deviceId: req.params.id, deviceName: '主题隔离设备', deviceModel: 'Synthetic desktop', online: false, active: false,
            localIp: '127.0.0.1', profileUrl: fixture.base + '/theme-standalone/device', firstSeen: 1793150000000, lastAccess: 1793150000000
        } }));
        fixture.app.get('/api/magnets/:id', (req, res) => res.json({ id: req.params.id, sessionId: 'theme-isolated-session',
            asset: { id: 'theme-synthetic-file', name: '主题测试文件.txt', type: 'text/plain', size: 128 }, seedDevices: [] }));
        const styleLinks = [...read('pages/index.html').matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map(match => match[0]).join('\n');
        fixture.app.get('/theme-frozen/:name', (req, res) => {
            const file = path.basename(req.params.name);
            if (!/^[a-z0-9-]+\.html$/.test(file)) return res.sendStatus(400);
            const source = read('prompts/resources/UI-261026/snapshots/' + file)
                .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, '');
            res.type('html').send(source.replace('</head>', styleLinks + '<style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head>'));
        });
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', serviceWorkers: 'block' });
        await context.route('**/*', route => {
            const url = route.request().url();
            if (/^(data:|blob:)/.test(url) || url.startsWith(fixture.base + '/')) return route.continue();
            return route.abort();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        // leave=1 prevents fixture-only joined-session seeds from triggering
        // a real tunnel authorization/Socket.IO handshake after refresh.
        await page.goto(fixture.base + '/theme-live?leave=1');
        await page.waitForFunction(() => typeof startupTimings !== 'undefined' && startupTimings.completeMs !== null);
        await page.evaluate(async () => {
            await startTunnelApplication({ joined: false });
            state.sessionId = 'theme-isolated-session'; state.shortCode = 'T2610'; state.sessionRemark = '主题隔离验收';
            state.sessionOwnerDeviceId = state.deviceId;
            for (let i = 0; i < 36; i++) await saveToStore('sessions', {
                sessionId: i ? 'theme-session-' + i : state.sessionId,
                shortCode: String(i).padStart(5, '0'), remark: i % 2 ? '' : '隔离隧道 ' + i, createdAt: Date.now() - i * 1000
            });
            const messages = [
                { id: 'theme-text', type: 'text', text: '换肤必须保留业务内容、滚动和状态。' },
                { id: 'theme-rich', type: 'rich', content: '<p>作者内容 <span style="color:rgb(240,80,10);background-color:rgb(30,40,50)">显式格式</span></p>' }
            ];
            document.getElementById('chatMessages').replaceChildren();
            for (const message of messages) {
                Object.assign(message, { sessionId: state.sessionId, sender: state.deviceId, senderName: '隔离设备', timestamp: Date.now() });
                await saveToStore('messages', message);
                await addMessageToChat(message, true, { autoRequestAsset: false, scroll: false });
            }
            document.getElementById('editor').innerHTML = '<p>保留草稿 <span style="color:rgb(240,80,10);background-color:rgb(30,40,50)">作者格式</span></p>';
            document.getElementById('textInput').value = '还没有发送的文字';
            window.themeNodes = { editor: document.getElementById('editor'), input: document.getElementById('textInput'), chat: document.getElementById('chatMessages') };
        });
        const cssAudit = await page.evaluate(() => {
            const sheet = [...document.styleSheets].find(sheet => sheet.href?.includes('/client/themes.css'));
            if (!sheet) throw Error('Production theme sheet is not loaded');
            const allowed = /^(--[\w-]+|color|color-scheme|background(?:-color|-image|-size|-position(?:-x|-y)?|-repeat|-origin|-clip|-attachment)?|border(?:-(?:top|right|bottom|left))?-color|border(?:-(?:top-left|top-right|bottom-left|bottom-right))?-radius|box-shadow|text-shadow|outline-color|caret-color|accent-color|fill|stroke|opacity|filter|backdrop-filter|-webkit-backdrop-filter|scrollbar-color|text-decoration-color)$/;
            const invalid = [], selectors = [];
            const walk = rules => { for (const rule of rules) {
                if (rule.selectorText) {
                    selectors.push(rule.selectorText);
                    if (!rule.selectorText.split(',').every(() => /body(?:\[data-theme=|:is\(\[data-theme=)/.test(rule.selectorText))) invalid.push({ selector: rule.selectorText, property: 'UNSCOPED' });
                    for (const property of rule.style) if (!allowed.test(property)) invalid.push({ selector: rule.selectorText, property });
                } else if (rule.cssRules) walk(rule.cssRules);
            } };
            walk(sheet.cssRules); return { invalid, count: selectors.length };
        });
        assert.deepEqual(cssAudit.invalid, [], 'new themes must contain visual-only, scoped declarations');
        report.cssRules = cssAudit.count;
        const menus = await page.evaluate(() => ['.theme-quick-option[data-theme]', '.theme-option[data-theme]'].map(selector => [...document.querySelectorAll(selector)].map(node => node.dataset.theme)));
        assert.deepEqual(menus, [themes, themes]);
        assert.equal(await page.evaluate(() => document.body.dataset.theme), 'classic', 'unconfigured preference keeps original default');
        for (const theme of themes) {
            await skin(page, theme);
            const next = await page.evaluate(() => cycleTheme('theme-test'));
            assert.equal(next, themes[(themes.indexOf(theme) + 1) % themes.length]);
        }
        await skin(page, 'atelier');
        await page.goto(fixture.base + '/theme-live?leave=1');
        await page.waitForFunction(() => typeof startupTimings !== 'undefined' && startupTimings.completeMs !== null);
        await page.evaluate(() => startTunnelApplication({ joined: false }));
        assert.equal(await page.evaluate(() => document.body.dataset.theme), 'atelier', 'saved legacy preference is retained');
        await page.evaluate(() => applyTheme('removed-theme'));
        assert.equal(await page.evaluate(() => document.body.dataset.theme), 'classic', 'invalid preference has usable fallback');
        report.interactions.push('two theme menus and full cycle order; original default; saved old preference; invalid preference fallback');
        // Restore the current app shell after the intentional refresh.
        await page.evaluate(async () => {
            state.sessionId = 'theme-isolated-session';
            document.getElementById('editor').innerHTML = '<p>保留草稿 <span style="color:rgb(240,80,10);background-color:rgb(30,40,50)">作者格式</span></p>';
            document.getElementById('textInput').value = '还没有发送的文字';
            window.themeNodes = { editor: document.getElementById('editor'), input: document.getElementById('textInput'), chat: document.getElementById('chatMessages') };
        });
        // Compare settled layouts, not different frames of the existing mobile
        // workspace slide animation after crossing a breakpoint.
        await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
        for (const width of [1440, 1201, 1200, 1100, 1099, 1024, 800, 768, 767, 390]) {
            await page.setViewportSize({ width, height: 900 }); await skin(page, 'classic');
            const before = await geometry(page, '#appShell *, #tunnelTopbar, #tunnelTopbar *');
            const structure = await page.locator('#appShell .main-layout').evaluate(node => ({
                display: getComputedStyle(node).display,
                panels: [...node.children].map(panel => ({ visible: getComputedStyle(panel).display !== 'none', y: panel.getBoundingClientRect().y }))
            }));
            if (width >= 1100) { assert.equal(structure.display, 'grid'); assert.ok(structure.panels.every(panel => panel.visible)); }
            else if (width >= 768) { assert.equal(structure.display, 'grid'); assert.equal(structure.panels[2].visible, false); }
            else assert.equal(structure.display, 'flex');
            for (const theme of themes.slice(0, 2)) {
                await skin(page, theme);
                sameGeometry(before, await geometry(page, '#appShell *, #tunnelTopbar, #tunnelTopbar *'), 'live ' + width + ' ' + theme);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
                assert.equal(await page.evaluate(() => window.themeNodes.editor === document.getElementById('editor') && window.themeNodes.input === document.getElementById('textInput')), true, 'skin switch does not replace app DOM');
                assert.equal(await page.locator('#textInput').inputValue(), '还没有发送的文字');
                const authored = await page.locator('#editor span').evaluate(node => [getComputedStyle(node).color, getComputedStyle(node).backgroundColor]);
                assert.deepEqual(authored, ['rgb(240, 80, 10)', 'rgb(30, 40, 50)'], 'author explicit styles survive');
            }
            report.layouts.push({ width, mode: width >= 1100 ? 'A' : width >= 768 ? 'D' : 'B', nodes: before.length });
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        for (const theme of themes.slice(0, 2)) {
            await skin(page, theme);
            await page.evaluate(() => showJoinedSessionSwitcher());
            const center = page.locator('.control-center-overlay');
            await center.waitFor();
            assert.equal(await center.locator('[data-control-tile]').count(), 13);
            const panel = center.locator('[data-control-panel]');
            const list = center.locator('.session-switcher-list');
            const oldScroll = await list.evaluate(node => node.scrollTop);
            await center.locator('[data-scroll="1"]').click();
            await page.waitForFunction(value => document.querySelector('.session-switcher-list').scrollTop > value + 10, oldScroll);
            assert.equal(await center.count(), 1, 'list scroll does not dismiss control center');
            const originalPanel = await panel.elementHandle();
            await center.locator('[data-control-tile="theme"]').click();
            assert.equal(await center.count(), 1, 'theme tile keeps control center open');
            assert.equal(await originalPanel.evaluate(node => node.isConnected), true);
            await center.evaluate(async node => {
                const tile = node.querySelector('[data-control-tile="disk"]'), rect = tile.getBoundingClientRect(), panel = node.querySelector('[data-control-panel]').getBoundingClientRect();
                const pointer = (type, id, pointerType, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType, isPrimary: true, button: 0, clientX: x, clientY: y });
                tile.dispatchEvent(pointer('pointerdown', 81, 'mouse', rect.left + 12, rect.top + 12));
                window.dispatchEvent(pointer('pointermove', 81, 'mouse', panel.left + 12, panel.bottom - 8));
                window.dispatchEvent(pointer('pointerup', 81, 'mouse', panel.left + 12, panel.bottom - 8));
                if (!node.querySelector('[data-control-side="after"] [data-control-tile="disk"]')) throw Error('mouse drag did not cross tunnel panel');
                const next = tile.getBoundingClientRect();
                tile.dispatchEvent(pointer('pointerdown', 82, 'touch', next.left + 12, next.top + 12));
                await new Promise(resolve => setTimeout(resolve, 550));
                if (node.querySelector('.control-center-drag-label').hidden) throw Error('touch hold did not activate existing drag');
                window.dispatchEvent(pointer('pointermove', 82, 'touch', panel.left + 12, panel.top + 8));
                window.dispatchEvent(pointer('pointerup', 82, 'touch', panel.left + 12, panel.top + 8));
                if (!node.querySelector('[data-control-side="before"] [data-control-tile="disk"]') || !node.querySelector('.control-center-drag-label').hidden) throw Error('touch drag or cleanup failed');
            });
            // Click visible container padding, not a tile or tunnel panel.
            const blank = await center.evaluate(node => {
                const rect = node.querySelector('.control-center').getBoundingClientRect();
                for (let y = rect.top + 2; y < rect.bottom - 2; y += 4) for (let x = rect.left + 2; x < rect.right - 2; x += 4) {
                    const hit = document.elementFromPoint(x, y);
                    if (hit && node.contains(hit) && !hit.closest('.control-center-tile,[data-control-panel],.control-center-drag-label')) return { x, y };
                }
                throw Error('No control-center interior blank position');
            });
            await page.mouse.click(blank.x, blank.y); await center.waitFor({ state: 'detached' });
            await page.evaluate(() => showJoinedSessionSwitcher());
            await page.mouse.click(3, 3); await center.waitFor({ state: 'detached' });
            await page.evaluate(() => showJoinedSessionSwitcher());
            await center.locator('[data-control-tile="settings"]').click();
            await center.waitFor({ state: 'detached' });
            await page.locator('.tunnel-settings-layer').waitFor({ state: 'visible' });
            await page.locator('#closeTunnelSettingsBtn').click();
            await page.locator('.tunnel-settings-layer').waitFor({ state: 'hidden' });
            report.interactions.push(theme + ': control center interior/exterior whitespace dismiss, 13 tiles, live theme cycle, list scroll, synthetic mouse/touch-hold drag, settings action');
        }
        // The actual shared AccountUI creates its dialog dynamically under body.
        // Injected identity data is synthetic; selection callbacks never switch
        // production identities or start network business operations.
        await page.evaluate(() => {
            window.themeAccountCalls = 0;
            AccountUI.open({ choose: true, currentAccount: () => 'theme-alice', load: async () => ({ accounts: [
                { identity: { id: 'theme-alice', name: '隔离甲账号' } },
                { identity: { id: 'theme-bob', name: '隔离乙账号' }, reauthRequired: true }
            ] }), renderSignIn: root => { const input = document.createElement('input'); input.value = '未提交'; root.append(input); },
            select: async () => { window.themeAccountCalls++; return false; } });
        });
        await page.locator('.account-row').first().waitFor();
        await page.locator('.account-panel').getByRole('button', { name: '选择此账号', exact: true }).evaluate(node => { node.disabled = true; });
        await skin(page, 'classic');
        const accountBefore = await geometry(page, '.account-overlay, .account-overlay *');
        for (const theme of themes.slice(0, 2)) {
            await skin(page, theme);
            await page.locator('.account-panel input').focus();
            sameGeometry(accountBefore, await geometry(page, '.account-overlay, .account-overlay *'), theme + ': dynamic account geometry');
            assert.equal(await page.locator('.account-row [aria-pressed="true"]').count(), 1);
            assert.equal(await page.locator('.account-panel').getByRole('button', { name: '选择此账号', exact: true }).isDisabled(), true);
            assert.equal(await page.locator('.account-panel input').inputValue(), '未提交');
        }
        assert.equal(await page.evaluate(() => themeAccountCalls), 0);
        await page.evaluate(() => AccountUI.close());
        report.interactions.push('dynamic AccountUI: selected and disabled states, focused unsent input and DOM geometry retained without account callback');

        // Application-owned separate documents share only uiTheme. Their APIs
        // return synthetic read-only data above; no transfer/camera action is
        // clicked. The downloader has no live seed/socket, so this proves its
        // shell and preference propagation, not a real download.
        const writer = await context.newPage();
        await writer.goto(fixture.base + '/theme-preference-host');
        report.standalone = [];
        for (const name of ['downloadList', 'downloader', 'light-file-parts', 'device']) {
            await writer.evaluate(() => localStorage.setItem('uiTheme', 'classic'));
            await page.setViewportSize({ width: 1200, height: 900 });
            await page.goto(fixture.base + '/theme-standalone/' + name + (name === 'downloader' ? '?magnet=theme-magnet-261028' : ''));
            await page.waitForFunction(() => document.body?.dataset.themePage);
            if (name === 'device') await page.waitForFunction(() => document.getElementById('profileFields')?.children.length > 0);
            if (name === 'light-file-parts') await page.waitForFunction(() => document.getElementById('tasks').children.length > 0);
            if (name === 'downloader') await page.waitForFunction(() => document.getElementById('meta').textContent.includes('主题测试文件'));
            if (name === 'downloadList') await page.waitForFunction(() => !document.getElementById('list').textContent.includes('正在读取缓存'));
            await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
            assert.equal(await page.evaluate(() => document.body.dataset.theme), undefined, name + ': classic retains original standalone presentation');
            const before = await geometry(page);
            for (const theme of themes.slice(0, 2)) {
                await writer.evaluate(theme => localStorage.setItem('uiTheme', theme), theme);
                await page.waitForFunction(theme => document.body.dataset.theme === theme, theme);
                sameGeometry(before, await geometry(page), name + ' standalone ' + theme);
                await page.screenshot({ path: path.join(output, theme + '-standalone-' + name + '.png') });
            }
            await page.reload();
            await page.waitForFunction(() => document.body.dataset.theme === 'orbit');
            await writer.evaluate(() => localStorage.setItem('uiTheme', 'graphite'));
            await page.waitForFunction(() => !document.body.dataset.theme);
            report.standalone.push({ name, initialPreference: true, crossDocumentStorage: true, reload: true, legacyReset: true, geometry: 'unchanged' });
        }
        await writer.evaluate(() => {
            localStorage.setItem('uiTheme', 'lumen');
            const frame = document.createElement('iframe'); frame.src = '/theme-standalone/downloadList?embedded=1'; document.body.append(frame);
        });
        const embedded = writer.frameLocator('iframe');
        await embedded.locator('body[data-theme="lumen"]').waitFor();
        await page.evaluate(() => localStorage.setItem('uiTheme', 'orbit'));
        await embedded.locator('body[data-theme="orbit"]').waitFor();
        report.interactions.push('actual application iframe: initial saved theme and same-origin storage propagation');
        // Hold only app.js, so the unchanged startup loader stays visible while
        // the real read-only preference bootstrap already has a parsed body.
        let releaseApp;
        const appGate = new Promise(resolve => { releaseApp = resolve; });
        await page.route('**/app.js*', async route => { await appGate; await route.continue(); });
        const startupNavigation = page.goto(fixture.base + '/theme-live?leave=1', { waitUntil: 'domcontentloaded' });
        try {
            await page.waitForURL('**/theme-live?leave=1', { waitUntil: 'commit' });
            await page.locator('#tunnelStartupLoading').waitFor({ state: 'visible' });
            await page.waitForFunction(() => document.body.dataset.theme === 'orbit');
            assert.equal(await page.locator('#tunnelStartupLoading').evaluate(node => getComputedStyle(node).color), 'rgb(232, 235, 250)');
            await page.screenshot({ path: path.join(output, 'orbit-startup.png') });
        } finally { releaseApp(); }
        await startupNavigation;
        await page.waitForFunction(() => typeof startupTimings !== 'undefined' && startupTimings.completeMs !== null);
        await page.unroute('**/app.js*');
        report.interactions.push('real startup loader adopts saved Orbit before held app.js executes; bootstrap continues after release');
        await writer.close();

        // Broad static component coverage against current production structural
        // CSS, NOT the stale source.css shipped with the design gallery.
        const gallery = JSON.parse(read('prompts/resources/UI-261026/assets/gallery-data.js').replace(/^window\.UI_DESIGN=/, '').replace(/;\s*$/, ''));
        const snapshots = [
            ...Object.keys(gallery.screenNames).map(screen => ({ screen, file: screen + '.html', mobile: false })),
            ...gallery.mobileScreens.map(screen => ({ screen, mobile: true, file: (gallery.mobileSnapshots.includes(screen) ? 'mobile-' + screen : ['home-devices', 'home-editor'].includes(screen) ? 'home' : screen) + '.html' }))
        ];
        for (const { screen, file, mobile } of snapshots) {
            await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
            await page.goto(fixture.base + '/theme-frozen/' + file);
            if (['home-devices', 'home-editor'].includes(screen)) await page.evaluate(screen => {
                const view = screen === 'home-devices' ? 'devices' : 'editor';
                document.getElementById('appShell').dataset.mobileView = view;
                document.querySelector('.main-layout').style.setProperty('--workspace-index', view === 'devices' ? 0 : 2);
                document.querySelectorAll('.mobile-workspace-button').forEach(node => node.classList.toggle('active', node.dataset.mobileView === view));
            }, screen);
            await page.evaluate(() => document.fonts.ready);
            await skin(page, 'classic');
            const before = await geometry(page);
            for (const theme of themes.slice(0, 2)) {
                await skin(page, theme); sameGeometry(before, await geometry(page), (mobile ? 'mobile ' : 'desktop ') + screen + ' ' + theme);
            }
            // Removing the complete legacy theme sheet must not change either
            // new theme's geometry or inherited component token values.
            if (file === 'home.html' || file === 'disk-dialog.html' || file === 'stream-watch.html') {
                for (const theme of themes.slice(0, 2)) {
                    await skin(page, theme);
                    const beforeRemoval = await geometry(page);
                    const values = await page.evaluate(() => ['--panel-bg', '--text-main', '--text-color', '--accent', '--primary-color'].map(name => getComputedStyle(document.body).getPropertyValue(name).trim()));
                    await page.evaluate(() => document.querySelector('link[href*="themes-legacy.css"]')?.remove());
                    sameGeometry(beforeRemoval, await geometry(page), file + ' legacy removal ' + theme);
                    assert.deepEqual(await page.evaluate(() => ['--panel-bg', '--text-main', '--text-color', '--accent', '--primary-color'].map(name => getComputedStyle(document.body).getPropertyValue(name).trim())), values);
                }
            }
            if (['home', 'home-control-center', 'disk-dialog', 'stream-watch', 'home-editor'].includes(screen)) {
                for (const theme of themes.slice(0, 2)) { await skin(page, theme); await page.screenshot({ path: path.join(output, theme + '-' + (mobile ? 'mobile-' : '') + screen + '.png') }); }
            }
            report.snapshots.push({ screen, file, viewport: mobile ? '390x844' : '1440x1000', nodes: before.length });
        }
        assert.equal(errors.length, 0, 'live JS errors: ' + errors.join('\n'));
        report.status = 'PASS';
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
    } catch (error) {
        report.status = 'FAIL'; report.error = error.stack;
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
        throw error;
    } finally { if (browser) await browser.close(); await fixture.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
