'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const { createFixture } = require('./support/streaming-console-fixture.cjs');
const geometry = () => {
    const row = document.querySelector('.sc-now-playing'), list = row?.parentElement, main = document.querySelector('.sc-main');
    if (!row || !list || !main) return null;
    const r = row.getBoundingClientRect(), box = list.getBoundingClientRect(), clip = main.getBoundingClientRect();
    const top = Math.max(box.top + list.clientTop, clip.top + main.clientTop, 0);
    const bottom = Math.min(box.top + list.clientTop + list.clientHeight, clip.top + main.clientTop + main.clientHeight, innerHeight);
    return { row: r.top + r.height / 2, middle: (top + bottom) / 2, top, bottom, scroll: list.scrollTop, mainScroll: main.scrollTop, index: [...list.querySelectorAll('.sc-watch-item')].indexOf(row) };
};
(async () => {
    const fixture = await createFixture(); let browser;
    try {
        const actor = { deviceId: 'device-A', userId: null, logins: [] };
        fixture.streaming.service.register('device-A', 'device-A'.repeat(8), '自动轮播测试供源');
        const station = fixture.streaming.service.create(actor, { name: '自动轮播定位回归', creationId: 'playlist-follow-261028' });
        await fixture.streaming.service.edit(station.id, actor, { configVersion: 1, loop: true, items: Array.from({ length: 24 }, (_, i) => ({ id: 'program-' + i, stay: i === 12 ? 3 : 120,
            source: { kind: 'tunnel', sessionId: 'fixture-tunnel', messageId: 'image-record', fileId: 'image-asset', accessGrant: 'fixture-proof' } })) });
        fixture.streaming.service.visibility(station.id, actor, { visibility: 'public', version: fixture.streaming.service.station(station.id).playback.version });
        const control = (action, extra = {}) => { fixture.streaming.service.tick(); return fixture.streaming.service.control(station.id, actor, { action, ...extra, version: fixture.streaming.service.station(station.id).playback.version }); };
        fixture.app.get('/playlist-follow', (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <link rel="stylesheet" href="/client/streaming-console.css"><script src="/client/streaming-player.js"></script><script src="/client/streaming-console.js"></script>
            <body><button id="restore" onclick="StreamingConsole.open()">恢复串流台</button><script>localStorage.removeItem('streaming:playlist-viewer:ui');StreamingConsole.init({deviceId:()=> 'playlist-viewer',deviceName:()=> '隔离观看者',devices:()=>[],tunnels:async()=>[],toast:()=>{},home:()=>{}});StreamingConsole.open();</script>`));
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        const tickets = new Map();
        page.on('response', async response => {
            if (response.url().endsWith('/ticket') && response.status() === 200) {
                const body = response.request().postDataJSON(), access = await response.json(); tickets.set(body.itemId, new URL(access.url, fixture.base).href);
            }
        });
        await page.goto(fixture.base + '/playlist-follow');
        await page.locator('article').filter({ hasText: '自动轮播定位回归' }).getByRole('button', { name: '打开观看', exact: true }).click();
        await page.locator('.sc-now-playing').waitFor();
        control('select', { itemId: 'program-10' });
        await page.waitForFunction(() => [...document.querySelectorAll('.sc-watch-item')].indexOf(document.querySelector('.sc-now-playing')) === 10);
        await page.waitForFunction(() => {
            const row = document.querySelector('.sc-now-playing'), panel = row?.parentElement, main = document.querySelector('.sc-main');
            if (!row || !main) return false;
            const box = panel.getBoundingClientRect(), clip = main.getBoundingClientRect(), r = row.getBoundingClientRect();
            const top = Math.max(box.top + panel.clientTop, clip.top + main.clientTop, 0), bottom = Math.min(box.top + panel.clientTop + panel.clientHeight, clip.top + main.clientTop + main.clientHeight, innerHeight);
            return Math.abs(r.top + r.height / 2 - (top + bottom) / 2) < 5;
        });
        const measured = await page.evaluate(geometry); console.log('visible center', measured);
        const failures = [];
        if (Math.abs(measured.row - measured.middle) >= 5) failures.push('current row is not in the actually visible center');
        // No explicit select for program-13: its appearance is natural local playback.
        control('select', { itemId: 'program-12' });
        await page.waitForFunction(() => [...document.querySelectorAll('.sc-watch-item')].indexOf(document.querySelector('.sc-now-playing')) === 13, { timeout: 10000 });
        await page.waitForTimeout(600);
        const natural = await page.evaluate(geometry); console.log('natural transition', natural);
        if (Math.abs(natural.row - natural.middle) >= 5) failures.push('natural transition is not in the actually visible center');
        assert.ok(tickets.has('program-13'));
        for (const index of [23, 0]) {
            control('select', { itemId: 'program-' + index });
            await page.waitForFunction(i => document.querySelector('.sc-now-playing')?.dataset.itemId === 'program-' + i, index);
            await page.waitForTimeout(600);
            const edge = await page.evaluate(geometry); console.log('edge item', edge);
            if (index === 0 && edge.scroll > 3) failures.push('first wide item did not reach the natural start');
            if (index === 23 && !await page.locator('.sc-watch-grid>aside').evaluate(el => Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) < 3)) failures.push('last wide item did not reach the natural end');
        }
        const file = path.resolve('.npm-cache/261028-1-playlist-follow.png'); await page.screenshot({ path: file });
        await page.close();
        // A slow control/event stream must not prevent local next-item UI updates.
        control('select', { itemId: 'program-12' });
        const local = await context.newPage(); local.setDefaultTimeout(10000);
        await local.route('**/events**', () => {});
        const localTickets = new Map();
        local.on('response', async response => { if (response.url().endsWith('/ticket') && response.status() === 200) { const access = await response.json(); localTickets.set(response.request().postDataJSON().itemId, new URL(access.url, fixture.base).href); } });
        await local.goto(fixture.base + '/playlist-follow');
        await local.locator('article').filter({ hasText: '自动轮播定位回归' }).getByRole('button', { name: '打开观看', exact: true }).click();
        await local.waitForFunction(() => document.querySelector('.sc-media>img'));
        await local.getByRole('button', { name: '最小化', exact: true }).click();
        const deadline = Date.now() + 7000;
        const actualSource = async () => new URL(await local.locator('.sc-media>img').getAttribute('src').catch(() => '') || '/', fixture.base).href;
        while (Date.now() < deadline && (!localTickets.has('program-13') || await actualSource() !== localTickets.get('program-13'))) await local.waitForTimeout(50);
        assert.equal(await actualSource(), localTickets.get('program-13'), 'the local player must really have advanced');
        await local.getByRole('button', { name: '恢复串流台', exact: true }).click();
        await local.waitForTimeout(600);
        const withoutEvents = await local.evaluate(geometry); console.log('local transition with delayed events', withoutEvents);
        if (withoutEvents.index !== 13) failures.push('local item changed but playlist still marks the old item');
        if (Math.abs(withoutEvents.row - withoutEvents.middle) >= 5) failures.push('local transition did not center');
        await local.close();
        const phone = await context.newPage(); await phone.setViewportSize({ width: 390, height: 844 }); phone.setDefaultTimeout(10000);
        await phone.goto(fixture.base + '/playlist-follow');
        await phone.locator('article').filter({ hasText: '自动轮播定位回归' }).getByRole('button', { name: '打开观看', exact: true }).click();
        await phone.locator('.sc-now-playing').waitFor();
        await phone.locator('.sc-main').evaluate(el => el.scrollTo(0, el.scrollHeight));
        const mainScroll = await phone.locator('.sc-main').evaluate(el => el.scrollTop);
        for (const index of [18, 19, 23, 0]) {
            control('select', { itemId: 'program-' + index });
            await phone.waitForFunction(i => document.querySelector('.sc-now-playing')?.dataset.itemId === 'program-' + i, index);
            await phone.waitForTimeout(600);
            const narrow = await phone.evaluate(geometry); console.log('narrow item', narrow);
            // Compact endpoints stay against natural scroll boundaries; no
            // half-screen spacers are inserted just to center the first/last.
            if (![23, 0].includes(index) && Math.abs(narrow.row - narrow.middle) >= 5) failures.push('narrow item ' + index + ' did not center');
            if (index === 0 && narrow.scroll > 3) failures.push('first narrow item did not reach the natural start');
            if (index === 23 && !await phone.locator('.sc-watch-grid>aside').evaluate(el => Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) < 3)) failures.push('last narrow item did not reach the natural end');
            assert.equal(narrow.mainScroll, mainScroll, 'automatic positioning must only scroll the playlist');
        }
        assert.deepEqual(failures, []);
        console.log('actual visible center and natural playback: passed');
    } finally { await browser?.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
