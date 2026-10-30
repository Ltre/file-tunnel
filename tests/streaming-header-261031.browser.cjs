'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { chromium } = require(process.argv[2] || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const { createFixture } = require('./support/streaming-console-fixture.cjs');
(async () => {
    const f = await createFixture(); let browser;
    try {
        const actor = { deviceId: 'header-261031-device', userId: null, logins: [] }, secret = actor.deviceId.repeat(3);
        f.streaming.service.register(actor.deviceId, secret, 'Header test');
        const create = async (name, creationId) => {
            const station = f.streaming.service.create(actor, { name, creationId });
            await f.streaming.service.edit(station.id, actor, { configVersion: 1, loop: true, items: Array.from({ length: 18 }, (_, i) => ({ id: creationId + '-item-' + i, stay: 300, source: { kind: 'tunnel', sessionId: 'fixture-tunnel', messageId: 'image-record', fileId: 'image-asset', accessGrant: 'fixture-proof' } })) });
            f.streaming.service.visibility(station.id, actor, { visibility: 'public', version: f.streaming.service.station(station.id).playback.version });
            return station;
        };
        const first = await create('第一台·后台状态测试', 'header-first'), second = await create('第二台', 'header-second');
        f.app.get('/header-261031', (_req, res) => res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/streaming-console.css"><link rel="stylesheet" href="/client/themes.css"><script src="/client/streaming-player.js"></script><script src="/client/streaming-console.js"></script></head><body data-theme="orbit"><script>
            localStorage.setItem('streaming:${actor.deviceId}:key',${JSON.stringify(secret)});
            localStorage.setItem('streaming:${actor.deviceId}:ui',JSON.stringify({view:'control',stationId:${JSON.stringify(first.id)},scroll:{},drafts:{}}));
            StreamingConsole.init({deviceId:()=>${JSON.stringify(actor.deviceId)},deviceName:()=> 'Header test',devices:()=>[],tunnels:async()=>[{sessionId:'fixture-tunnel',accessGrant:'fixture-proof'}],toast:()=>{},home:()=>{}});StreamingConsole.open();
        </script></body></html>`));
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
        const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(12000);
        await page.goto(f.base + '/header-261031'); await page.locator('.sc-watch-item').first().waitFor();
        const logo = page.locator('#streamingConsole>.sc-header .sc-header-logo');
        assert.equal(await logo.count(), 1, 'header replaces its text title with the streaming logo');
        assert.equal(await logo.getAttribute('src'), '/client/icons/streaming.png');
        assert.notEqual(await logo.evaluate(node => getComputedStyle(node).filter), 'none', 'Orbit must adapt the logo to its dark background');
        const last = page.locator('.sc-watch-item').last(); await last.getByRole('button', { name: '切换节目', exact: true }).scrollIntoViewIfNeeded();
        assert.ok(await page.locator('.sc-player').evaluate(node => node.getBoundingClientRect().bottom < document.querySelector('.sc-main').getBoundingClientRect().top), 'the mobile playlist action begins below the player');
        await last.getByRole('button', { name: '切换节目', exact: true }).click();
        await page.waitForFunction(() => { const box = document.querySelector('.sc-player').getBoundingClientRect(), clip = document.querySelector('.sc-main').getBoundingClientRect(); return box.top >= clip.top - 2 && box.top < clip.bottom; });
        await page.waitForFunction(() => document.querySelector('.sc-play-status')?.dataset.status === 'reading');
        const ticker = () => page.locator('.sc-background-now');
        assert.equal(await ticker().count(), 0, 'foreground playback does not show a background ticker');
        await page.getByRole('button', { name: '返回列表', exact: true }).click(); await ticker().waitFor();
        assert.equal(await ticker().getAttribute('aria-label'), '在播·' + first.number + '·第一台·后台状态测试');
        fs.mkdirSync(path.resolve('.npm-cache/streaming-header-261031'), { recursive: true });
        for (const width of [320, 390, 1024]) {
            await page.setViewportSize({ width, height: 844 });
            const bounds = await page.locator('.sc-header').evaluate(header => ({ width: header.clientWidth, scrollWidth: header.scrollWidth, ticker: header.querySelector('.sc-background-now').getBoundingClientRect().width }));
            assert.ok(bounds.scrollWidth <= bounds.width && bounds.ticker > 10, JSON.stringify({ width, ...bounds }));
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.resolve('.npm-cache/streaming-header-261031/header-background-orbit-mobile.png') });
        await page.evaluate(() => document.body.dataset.theme = 'lumen');
        assert.equal(await logo.evaluate(node => getComputedStyle(node).filter), 'none', 'light-theme logo retains its original pixels');
        await page.evaluate(() => document.body.dataset.theme = 'orbit');
        await ticker().click(); await page.locator('.sc-viewer-page').waitFor(); assert.equal(await ticker().count(), 0);
        await page.locator('.sc-local-pause').click(); await page.getByRole('button', { name: '返回列表', exact: true }).click(); assert.equal(await ticker().count(), 0, 'locally paused playback has no ticker');
        await page.locator('.sc-station-row').filter({ hasText: '第一台·后台状态测试' }).getByRole('button', { name: '打开观看', exact: true }).click();
        await page.locator('.sc-local-pause').click(); await page.waitForFunction(() => document.querySelector('.sc-play-status')?.dataset.status === 'reading');
        await page.locator('.sc-background-toggle input').uncheck(); await page.getByRole('button', { name: '返回列表', exact: true }).click(); assert.equal(await ticker().count(), 0, 'background-disabled playback has no ticker');
        await page.locator('.sc-station-row').filter({ hasText: '第一台·后台状态测试' }).getByRole('button', { name: '打开观看', exact: true }).click();
        await page.locator('.sc-background-toggle input').check(); await page.getByRole('button', { name: '小窗播', exact: true }).click();
        assert.equal(await ticker().count(), 0, 'small-window playback is excluded');
        await page.locator('.sc-mini-window .sc-mini-close').click(); await page.evaluate(() => StreamingConsole.open());
        await page.getByRole('button', { name: '返回列表', exact: true }).click(); await ticker().waitFor();
        f.streaming.service.control(first.id, actor, { action: 'pause', version: f.streaming.service.station(first.id).playback.version });
        await page.waitForFunction(() => !document.querySelector('.sc-background-now'));
        f.streaming.service.control(first.id, actor, { action: 'play', version: f.streaming.service.station(first.id).playback.version }); await ticker().waitFor();
        await page.locator('.sc-station-row').filter({ hasText: '第二台' }).getByRole('button', { name: '打开观看', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.sc-play-status')?.dataset.status === 'reading');
        await page.getByRole('button', { name: '返回列表', exact: true }).click(); await ticker().waitFor(); assert.equal(await ticker().getAttribute('aria-label'), '在播·' + second.number + '·第二台');
        f.streaming.service.control(second.id, actor, { action: 'stop', version: f.streaming.service.station(second.id).playback.version }); await page.waitForFunction(() => !document.querySelector('.sc-background-now'));
        assert.equal(await page.locator('.sc-player').count(), 1, 'switching stations retains only one player');
        assert.deepEqual(errors, []);
        await page.screenshot({ path: path.resolve('.npm-cache/streaming-header-261031/header-orbit-mobile.png') });
        console.log('PASS mobile program selection returns to player; Orbit header logo; background ticker follows sole playback owner, local/global pause, background switch, small window, station change and stop');
    } finally { await browser?.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
