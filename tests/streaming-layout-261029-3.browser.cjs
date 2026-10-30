'use strict';
// Actual console/CSS and drive APIs, isolated data and delayed startup scripts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || process.argv[2] || 'playwright');
const { createFixture } = require('./support/streaming-console-fixture.cjs');
let f, browser, station, actor;
const output = path.resolve('.npm-cache/streaming-layout-261029-3');
before(async () => {
    fs.mkdirSync(output, { recursive: true });
    f = await createFixture();
    actor = { deviceId: 'layout-261029-3', userId: null, logins: [] };
    const secret = actor.deviceId.repeat(3);
    f.streaming.service.register(actor.deviceId, secret, '布局隔离设备');
    station = f.streaming.service.create(actor, { name: '布局回归台', creationId: 'layout-261029-3' });
    await f.streaming.service.edit(station.id, actor, { configVersion: 1, loop: true, items: Array.from({ length: 24 }, (_, i) => ({
        id: 'program-' + i, stay: 120, source: { kind: 'tunnel', sessionId: 'fixture-tunnel', messageId: 'image-record', fileId: 'image-asset', accessGrant: 'fixture-proof' }
    })) });
    f.streaming.service.visibility(station.id, actor, { visibility: 'public', version: f.streaming.service.station(station.id).playback.version });
    for (let i = 0; i < 40; i++) {
        f.store.createDirectory('alice', '目录-' + i, 1);
        f.store.putMetadataObject(f.auth.user('alice'), '', '文件-' + i + '.txt', 'text/plain', {}, 30);
        f.records.push({ id: 'record-' + i, type: 'text', text: '记录正文 ' + i, timestamp: Date.now(), sender: 'device-A', sessionId: 'fixture-tunnel' });
    }
    f.app.get('/layout-261029-3', (req, res) => {
        f.sessions.set(req, res, f.auth.user('alice'));
        const view = req.query.view || 'import', channel = req.query.channel || 'disk';
        const current = f.streaming.service.station(station.id);
        res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/client/streaming-console.css"><link rel="stylesheet" href="/client/themes.css">
        <script src="/client/disk-client.js"></script><script src="/client/streaming-player.js"></script><script src="/client/streaming-console.js"></script>
        <body data-theme="${req.query.theme === 'orbit' ? 'orbit' : 'lumen'}"><script>
        localStorage.setItem('streaming:${actor.deviceId}:key',${JSON.stringify(secret)});
        localStorage.setItem('streaming:${actor.deviceId}:station:${station.id}',JSON.stringify(${JSON.stringify({ name: current.name, configVersion: current.configVersion, items: current.items, loop: true, countdown: 'bottom-right' })}));
        localStorage.setItem('streaming:${actor.deviceId}:ui',JSON.stringify({view:${JSON.stringify(view)},stationId:${JSON.stringify(station.id)},scroll:{},drafts:{},importState:{channel:${JSON.stringify(channel)},pending:[],diskScope:{accountId:'alice',diskSpace:'',path:'',mountId:''}}}));
        StreamingConsole.init({deviceId:()=>${JSON.stringify(actor.deviceId)},deviceName:()=> '布局隔离设备',devices:()=>[],tunnels:async()=>[{sessionId:'fixture-tunnel',accessGrant:'fixture-proof',name:'隔离隧道'}],toast:()=>{},home:()=>{}});StreamingConsole.open();
        </script>`);
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); await f?.close(); });

test('wide disk/tunnel imports give both panes the remaining height and keep bottom controls visible', async () => {
    const failures = [], measurements = [];
    for (const [width, height] of [[1600, 1000], [1024, 768], [768, 768], [390, 844]]) for (const channel of ['disk', 'tunnel']) {
        const page = await browser.newPage({ viewport: { width, height } });
        const networkFailures = [];
        page.on('requestfailed', request => networkFailures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
        try {
            await page.goto(f.base + '/layout-261029-3?channel=' + channel + '&theme=' + (channel === 'disk' ? 'lumen' : 'orbit'));
            await page.locator('.sc-candidate').first().waitFor();
            assert.equal(await page.locator('.sc-banner').isVisible(), false, JSON.stringify({ width, channel, networkFailures, message: await page.locator('.sc-banner').textContent() }));
            const boxes = await page.evaluate(() => {
                const rect = s => document.querySelector(s).getBoundingClientRect().toJSON();
                return { controls: rect('.sc-source-controls'), files: rect('.sc-candidate-list'), random: rect('.sc-import-random,.sc-import-random-count'), actions: rect('.sc-import-actions'), page: rect('.sc-import-page'), main: rect('.sc-main'),
                    fileScroll: document.querySelector('.sc-candidate-list').scrollHeight > document.querySelector('.sc-candidate-list').clientHeight,
                    sourceOverflow: getComputedStyle(document.querySelector('.sc-import-folders,.sc-import-records')).overflowY,
                    sourceScroll: document.querySelector('.sc-import-folders,.sc-import-records').scrollHeight > document.querySelector('.sc-import-folders,.sc-import-records').clientHeight };
            });
            measurements.push({ width, height, channel, ...boxes });
            if (width >= 768) {
                if (Math.abs(boxes.controls.top - boxes.files.top) > 2 || boxes.controls.right > boxes.files.left) failures.push({ width, channel, reason: 'panes are not side by side', boxes });
                if (Math.abs(boxes.controls.bottom - boxes.files.bottom) > 2 || boxes.files.height < 250) failures.push({ width, channel, reason: 'panes do not fill available height', boxes });
                if (boxes.random.top < boxes.files.bottom - 1 || boxes.random.bottom > boxes.actions.bottom + 1) failures.push({ width, channel, reason: 'random controls are not within the bottom operation area', boxes });
                assert.ok(boxes.sourceOverflow === 'auto' && boxes.fileScroll, 'source pane permits scrolling when needed; files remain independently scrollable');
            } else if (boxes.controls.bottom > boxes.files.top + 90) failures.push({ width, channel, reason: 'narrow layout no longer stacks', boxes });
            assert.ok(boxes.actions.bottom <= boxes.main.bottom + 1 && boxes.actions.bottom <= height, JSON.stringify(boxes));
            await page.locator('.sc-candidate input[type=checkbox]').first().check();
            assert.match(await page.locator('.sc-import-actions>.sc-import-selected').textContent(), /1/);
            await page.setViewportSize({ width: width === 390 ? 1024 : 390, height });
            assert.equal(await page.locator('.sc-candidate input[type=checkbox]').first().isChecked(), true, 'resize preserves selection');
            if (width === 1600) { await page.setViewportSize({ width, height }); await page.screenshot({ path: path.join(output, channel + '-wide.png') }); }
            await page.getByRole('button', { name: '本机文件', exact: true }).click();
            assert.equal(await page.locator('.sc-split-import').count(), 0, 'the local picker retains its original single-pane layout');
        } finally { await page.close(); }
    }
    fs.writeFileSync(path.join(output, 'import-layout.json'), JSON.stringify({ measurements, failures }, null, 2));
    assert.equal(failures.length, 0, JSON.stringify(failures.map(({ width, channel, reason }) => ({ width, channel, reason }))));
});

test('261029-4 disk scope uses 60/40 and merged controls preserve order on wide and narrow screens; playlist reordering stays a draft', async () => {
    for (const width of [1024, 390, 320]) for (const channel of ['disk', 'tunnel']) {
        const page = await browser.newPage({ viewport: { width, height: 768 } });
        try {
            await page.goto(f.base + '/layout-261029-3?channel=' + channel + '&theme=' + (channel === 'disk' ? 'lumen' : 'orbit'));
            await page.locator('.sc-candidate').first().waitFor();
            assert.equal(await page.locator('.sc-import-random').count(), 0, 'random controls must be part of the operation bar');
            const actions = page.locator('.sc-import-actions');
            assert.deepEqual(await actions.locator('button').allTextContents(), ['从当前范围随机选', '已选 · 0', '取消', '导入']);
            const box = await actions.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, countWidth: el.querySelector('input').getBoundingClientRect().width }));
            assert.ok(box.scroll <= box.width + 1 && box.countWidth <= 50, JSON.stringify(box));
            if (width >= 768 && channel === 'disk') {
                const ratio = await page.evaluate(() => { const a=document.querySelector('.sc-source-controls'),b=document.querySelector('.sc-candidate-list');return { value:a.clientWidth/(a.clientWidth+b.clientWidth),line:parseFloat(getComputedStyle(a).borderInlineEndWidth) }; });
                assert.ok(Math.abs(ratio.value-.6)<.01 && ratio.line===1, JSON.stringify(ratio));
            }
            await actions.locator('input').fill('2'); await actions.getByRole('button', { name: '从当前范围随机选', exact: true }).click();
            assert.equal(await page.locator('.sc-candidate input:checked').count(), 2);
            assert.match(await actions.textContent(), /已选 · 2/);
            if (width === 320 || width === 1024) await page.screenshot({path:path.join(output,'merged-'+channel+'-'+width+'.png')});
        } finally { await page.close(); }
    }
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    try {
        await page.goto(f.base+'/layout-261029-3?view=edit'); await page.locator('.sc-program').first().waitFor();
        const buttons=page.locator('.sc-editor-heading>button');
        assert.deepEqual(await buttons.allTextContents(),['打乱','逆转','导入']);
        assert.ok((await buttons.evaluateAll(nodes=>nodes.map(node=>node.className))).every(name=>name===''));
        await buttons.filter({hasText:'逆转'}).click();
        assert.equal(await page.locator('.sc-program').first().getAttribute('data-item-id'),'program-23');
        await page.evaluate(()=>{crypto.getRandomValues=array=>{array.fill(0);return array;};});
        await buttons.filter({hasText:'打乱'}).click();
        assert.equal(await page.locator('.sc-program').first().getAttribute('data-item-id'),'program-22');
        assert.equal(f.streaming.service.station(station.id).items[0].id,'program-0','reordering must not auto-publish');
        assert.equal(new Set(await page.locator('.sc-program').evaluateAll(rows=>rows.map(row=>row.dataset.itemId))).size,24);
        await page.screenshot({path:path.join(output,'editor-actions.png')});
    } finally { await page.close(); }
});

test('mobile playlist has no artificial end gaps and follows changes within its natural scroll range', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
        await page.goto(f.base + '/layout-261029-3?view=watch');
        await page.locator('.sc-now-playing').waitFor();
        await page.locator('.sc-main').evaluate(el => el.scrollTop = el.scrollHeight);
        for (const index of [12, 23, 0]) {
            f.streaming.service.control(station.id, actor, { action: 'select', itemId: 'program-' + index, version: f.streaming.service.station(station.id).playback.version });
            await page.waitForFunction(i => document.querySelector('.sc-now-playing')?.dataset.itemId === 'program-' + i, index);
            await page.waitForTimeout(650);
            const g = await page.locator('.sc-watch-grid>aside').evaluate(list => {
                const rows = [...list.querySelectorAll('.sc-watch-item')], row = list.querySelector('.sc-now-playing');
                const box = list.getBoundingClientRect(), clip = document.querySelector('.sc-main').getBoundingClientRect();
                const top = Math.max(box.top + list.clientTop, clip.top, 0), bottom = Math.min(box.top + list.clientTop + list.clientHeight, clip.bottom, innerHeight);
                const first = rows[0].getBoundingClientRect(), last = rows.at(-1).getBoundingClientRect(), r = row.getBoundingClientRect();
                return { startGap: first.top - list.querySelector('h2').getBoundingClientRect().bottom,
                    endGap: list.scrollHeight - (last.bottom - box.top + list.scrollTop),
                    delta: r.top + r.height / 2 - (top + bottom) / 2, scroll: list.scrollTop, max: list.scrollHeight - list.clientHeight };
            });
            assert.ok(g.startGap < 35 && g.endGap < 35, JSON.stringify({ index, ...g }));
            if (index === 12) assert.ok(Math.abs(g.delta) < 5, JSON.stringify(g));
            if (index === 23) assert.ok(Math.abs(g.scroll - g.max) < 3, JSON.stringify(g));
            if (index === 0) assert.ok(g.scroll < 3, JSON.stringify(g));
        }
        await page.setViewportSize({ width: 1366, height: 900 });
        await page.waitForTimeout(100);
        assert.equal(await page.locator('.sc-playlist-space').count(), 0, 'wide playlists also retain natural endpoints');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForFunction(() => !document.querySelector('.sc-playlist-space'));
        await page.screenshot({ path: path.join(output, 'playlist-mobile.png') });
    } finally { await page.close(); }
});

test('saved Lumen/Orbit style is applied before deferred startup scripts finish', async () => {
    for (const theme of ['lumen', 'orbit']) {
        const page = await browser.newPage();
        try {
            await page.addInitScript(value => localStorage.setItem('uiTheme', value), theme);
            await page.route('**/socket.io/socket.io.js', () => {});
            await page.goto(f.base + '/?leave=1', { waitUntil: 'commit' });
            await page.locator('#tunnelStartupLoading').waitFor();
            const early = await page.locator('#tunnelStartupLoading').evaluate(el => ({ theme: document.body.dataset.theme, background: getComputedStyle(el).backgroundImage, ink: getComputedStyle(el).color }));
            assert.equal(early.theme, theme, JSON.stringify(early));
            assert.ok(!early.background.includes('37, 59, 114'), JSON.stringify(early));
            assert.equal(early.ink, theme === 'lumen' ? 'rgb(37, 41, 67)' : 'rgb(232, 235, 250)');
            await page.screenshot({ path: path.join(output, 'startup-' + theme + '.png') });
        } finally { await page.close(); }
    }
});
