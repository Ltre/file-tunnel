'use strict';
// Isolated real console and image decoding. A single missing blob URL injects
// the mobile failure boundary; it is not a claim to reproduce Android's cause.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const { createFixture } = require('./support/streaming-console-fixture.cjs');
const output = path.resolve('.npm-cache/streaming-261029-1');
async function run() {
    fs.mkdirSync(output, { recursive: true });
    const f = await createFixture(); let browser;
    try {
        const device = 'cover-playlist-owner', secret = device.repeat(3), actor = { deviceId: device, userId: null, logins: [] };
        f.streaming.service.register(device, secret, '隔离管理设备');
        const station = f.streaming.service.create(actor, { name: '播放与封面回归', creationId: 'streaming-261029-1' });
        await f.streaming.service.edit(station.id, actor, { configVersion: 1, loop: true, items: Array.from({ length: 24 }, (_, i) => ({
            id: 'program-' + i, stay: 120, source: { kind: 'tunnel', sessionId: 'fixture-tunnel', messageId: 'image-record', fileId: 'image-asset', accessGrant: 'fixture-proof' }
        })) });
        f.streaming.service.visibility(station.id, actor, { visibility: 'public', version: f.streaming.service.station(station.id).playback.version });
        const control = id => f.streaming.service.control(station.id, actor, { action: 'select', itemId: 'program-' + id, version: f.streaming.service.station(station.id).playback.version });
        f.app.get('/streaming-261029-1', (req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <link rel="stylesheet" href="/client/streaming-console.css"><link rel="stylesheet" href="/client/themes.css">
            <script src="/client/streaming-player.js"></script><script src="/client/streaming-console.js"></script>
            <body><script>localStorage.setItem('streaming:${device}:key',${JSON.stringify(secret)});
            localStorage.setItem('streaming:${device}:ui',JSON.stringify({view:${JSON.stringify(req.query.view || 'watch')},stationId:${JSON.stringify(station.id)},scroll:{},drafts:{}}));
            localStorage.setItem('streaming:${device}:station:${station.id}',JSON.stringify(${JSON.stringify({name:station.name,configVersion:2,items:[],loop:true,countdown:'bottom-right'})}));
            StreamingConsole.init({deviceId:()=>${JSON.stringify(device)},deviceName:()=> '隔离管理设备',devices:()=>[],tunnels:async()=>[],toast:()=>{},home:()=>{}});StreamingConsole.open();</script>`));
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); page.setDefaultTimeout(10000);
        const results = [];
        const check = (name, ok, evidence) => { results.push({ name, ok, evidence }); console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(evidence)); };
        await page.goto(f.base + '/streaming-261029-1?view=control');
        await page.locator('.sc-watch-item').first().waitFor();
        const message = await page.locator('.sc-banner').textContent();
        check('controller opens without false optional-chain method errors', !message.includes('is not a function'), message);
        await page.goto(f.base + '/streaming-261029-1?view=watch');
        await page.locator('.sc-now-playing').waitFor(); await page.waitForTimeout(700);
        const blank = await page.locator('.sc-watch-grid>aside').evaluate(el => ({ gap: el.querySelector('.sc-watch-item').getBoundingClientRect().top - el.querySelector('h2').getBoundingClientRect().bottom, scroll: el.scrollTop }));
        check('initial first program has no artificial half-screen gap', blank.gap < 35, blank);
        await page.screenshot({ path: path.join(output, 'playlist-initial.png') });
        for (const next of [12, 23, 0]) {
            control(next);
            try {
                await page.waitForFunction(id => {
                    const row = document.querySelector('.sc-now-playing'), panel = row?.parentElement, clip = document.querySelector('.sc-main')?.getBoundingClientRect();
                    if (!row || row.dataset.itemId !== 'program-' + id) return false;
                    const box = panel.getBoundingClientRect(), top = Math.max(box.top + panel.clientTop, clip.top, 0), bottom = Math.min(box.top + panel.clientTop + panel.clientHeight, clip.bottom, innerHeight);
                    if (id === 0) return panel.scrollTop < 3;
                    if (id === 23) return Math.abs(panel.scrollTop - (panel.scrollHeight - panel.clientHeight)) < 3;
                    return Math.abs(row.getBoundingClientRect().top + row.clientHeight / 2 - (top + bottom) / 2) < 5;
                }, next, { timeout: 5000 }); check('switched program ' + next + ' follows within the natural playlist boundaries', true);
            } catch (cause) { check('switched program ' + next + ' follows within the natural playlist boundaries', false, await page.locator('.sc-watch-grid>aside').evaluate(el => ({scroll:el.scrollTop,max:el.scrollHeight-el.clientHeight,box:el.getBoundingClientRect().toJSON(),row:el.querySelector('.sc-now-playing').getBoundingClientRect().toJSON(),clip:document.querySelector('.sc-main').getBoundingClientRect().toJSON()}))); }
        }
        await page.waitForTimeout(400);
        await page.locator('.sc-watch-grid>aside').evaluate(el => { el.scrollTop = 0; window.retainedRow = el.querySelector('.sc-now-playing'); });
        f.streaming.service.control(station.id, actor, { action: 'pause', version: f.streaming.service.station(station.id).playback.version });
        await page.waitForTimeout(700);
        check('same-program reports preserve user scrolling and row DOM', await page.locator('.sc-watch-grid>aside').evaluate(el => el.scrollTop === 0 && window.retainedRow === el.querySelector('.sc-now-playing')));
        await f.streaming.service.edit(station.id, actor, { configVersion: f.streaming.service.station(station.id).configVersion, loop: true, items: [0, 1].map(i => ({
            id: 'program-' + i, stay: 120, source: { kind: 'tunnel', sessionId: 'fixture-tunnel', messageId: 'image-record', fileId: 'image-asset', accessGrant: 'fixture-proof' }
        })) });
        await page.goto(f.base + '/streaming-261029-1?view=watch');
        await page.locator('.sc-now-playing').waitFor(); await page.waitForTimeout(400);
        check('short playlist initially has no artificial gap', await page.locator('.sc-watch-grid>aside').evaluate(el => el.querySelector('.sc-watch-item').getBoundingClientRect().top - el.querySelector('h2').getBoundingClientRect().bottom < 35));
        control(1); await page.waitForTimeout(900);
        const shortCenter = await page.locator('.sc-watch-grid>aside').evaluate(panel => {
            const row = panel.querySelector('.sc-now-playing'), clip = document.querySelector('.sc-main').getBoundingClientRect(), box = panel.getBoundingClientRect();
            const top = Math.max(box.top + panel.clientTop, clip.top, 0), bottom = Math.min(box.top + panel.clientTop + panel.clientHeight, clip.bottom, innerHeight);
            return { item: row.dataset.itemId, delta: row.getBoundingClientRect().top + row.clientHeight / 2 - (top + bottom) / 2, scroll:panel.scrollTop, max:panel.scrollHeight-panel.clientHeight, spacers:panel.querySelectorAll('.sc-playlist-space').length };
        });
        check('short playlist switch stays visible without artificial gaps', shortCenter.item === 'program-1' && shortCenter.spacers === 0 && shortCenter.scroll === 0 && shortCenter.max === 0, shortCenter);
        await page.goto(f.base + '/streaming-261029-1?view=edit');
        await page.locator('.sc-cover-field input[type=file]').waitFor();
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVioAAAAASUVORK5CYII=', 'base64');
        await page.evaluate(() => {
            const create = URL.createObjectURL.bind(URL); let fail = true;
            URL.createObjectURL = blob => { if (fail && blob instanceof File) { fail = false; return 'blob:' + location.origin + '/missing-cover-fixture'; } return create(blob); };
        });
        const choose = async buffer => { await page.getByLabel('上传封面').setInputFiles({ name: '封面.png', mimeType: 'image/png', buffer }); await page.waitForFunction(() => /封面已裁剪|封面处理失败/.test(document.querySelector('.sc-cover-field [role=status]').textContent)); return page.locator('.sc-cover-field [role=status]').textContent(); };
        const recovery = await choose(png); check('valid file survives one blob URL load failure', recovery.includes('封面已裁剪'), recovery);
        for (let n = 0; n < 12; n++) { const status = await choose(png); check('valid image reselection ' + n, status.includes('封面已裁剪'), status); }
        const bad = await choose(Buffer.from('not an image')); check('invalid image stays rejected after bounded fallback', bad.includes('封面处理失败'), bad);
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
        assert.equal(results.filter(result => !result.ok).length, 0, 'console, playlist and cover regressions');
    } finally { await browser?.close(); await f.close(); }
}
run().catch(cause => { console.error(cause); process.exitCode = 1; });
