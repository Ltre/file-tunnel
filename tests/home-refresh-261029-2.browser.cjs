'use strict';
// Actual homepage/console and native Chrome dialogs; all business data is isolated.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createFixture } = require('./support/streaming-console-fixture.cjs');
const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { chromium } = require(process.env.TEST_PLAYWRIGHT || (fs.existsSync(bundled) ? bundled : 'playwright'));
const current = fs.readFileSync(path.resolve(__dirname, '../client/streaming-console.js'), 'utf8');

test('homepage refresh ignores a hidden persisted draft; the editor still names its unsaved changes', { timeout: 60000 }, async t => {
    const f = await createFixture(); t.after(() => f.close());
    const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
    const device = 'refresh-check-device', secret = device.repeat(3), actor = { deviceId: device, userId: null, logins: [] };
    f.streaming.service.register(device, secret, '隔离刷新验收');
    const station = f.streaming.service.create(actor, { name: '刷新验收原名称', creationId: 'refresh-check' });
    const saved = { name: station.name, configVersion: station.configVersion, coverId: '', loop: true, countdown: 'bottom-right', items: [] };
    for (const legacy of [true, false]) {
        const context = await browser.newContext({ serviceWorkers: 'block', locale: 'zh-CN' });
        try {
            if (legacy) await context.route('**/client/streaming-console.js', route => route.fulfill({ contentType: 'application/javascript',
                body: current.replace("global.addEventListener('pagehide', saveUi);", "global.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });") }));
            await context.addInitScript(({ device, secret, stationId, saved }) => {
                if (localStorage.getItem('refresh-check-seeded')) return;
                localStorage.setItem('refresh-check-seeded', '1'); localStorage.setItem('deviceId', device);
                localStorage.setItem('streaming:' + device + ':key', secret);
                localStorage.setItem('streaming:' + device + ':station:' + stationId, JSON.stringify(saved));
                localStorage.setItem('streaming:' + device + ':ui', JSON.stringify({ view: 'edit', stationId, scroll: {}, drafts: {
                    [stationId]: { ...saved, name: '本机尚未发布的草稿名称' }
                } }));
            }, { device, secret, stationId: station.id, saved });
            const page = await context.newPage(), native = [];
            page.on('dialog', async dialog => { native.push({ type: dialog.type(), message: dialog.message() }); await dialog.accept(); });
            await page.goto(f.base + '/?leave=1');
            await page.locator('#fixture-open-console').click();
            await page.locator('.sc-name').waitFor();
            await page.locator('[data-sc-minimize]').click();
            assert.equal(await page.locator('#streamingConsole').isVisible(), false);
            assert.equal(await page.evaluate(() => activeFileProgress.size), 0, 'no tunnel file transfer is active');
            await page.reload({ waitUntil: 'domcontentloaded' });
            assert.equal(native.filter(item => item.type === 'beforeunload').length, legacy ? 1 : 0, JSON.stringify(native));
            const persisted = await page.evaluate(device => JSON.parse(localStorage.getItem('streaming:' + device + ':ui')), device);
            assert.equal(persisted.drafts[station.id].name, '本机尚未发布的草稿名称');
            if (!legacy) {
                await page.locator('#fixture-open-console').click(); await page.locator('.sc-name').waitFor();
                assert.equal(await page.locator('.sc-name').inputValue(), '本机尚未发布的草稿名称');
                await page.locator('[data-sc-home]').click();
                const dialog = page.locator('.sc-dialog'); await dialog.getByRole('button', { name: '继续编辑', exact: true }).waitFor();
                assert.match(await dialog.textContent(), /有尚未保存的更改/);
                assert.equal(await dialog.getByRole('button', { name: '保存后离开', exact: true }).count(), 1);
                assert.equal(await dialog.getByRole('button', { name: '放弃更改', exact: true }).count(), 1);
                await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
                assert.equal(await page.locator('.sc-name').inputValue(), '本机尚未发布的草稿名称');
            }
        } finally { await context.close(); }
    }
});
