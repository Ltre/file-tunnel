'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), os = require('node:os');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const { createFixture } = require('./support/streaming-console-fixture.cjs');

test('source errors mark all affected programmes and persist until repaired or the next Save', async t => {
    const f = await createFixture(); t.after(() => f.close());
    const actor = { deviceId: 'save-errors-device', userId: null, logins: [] }, secret = actor.deviceId.repeat(3);
    f.streaming.service.register(actor.deviceId, secret, 'Save errors');
    const secondRecord = structuredClone(f.records.find(record => record.id === 'image-record'));
    secondRecord.id = 'second-image-record'; secondRecord.fileInfo.id = 'second-image-asset'; f.records.push(secondRecord);
    const station = f.streaming.service.create(actor, { name: 'Save errors', creationId: 'save-errors' });
    const items = Array.from({ length: 18 }, (_, index) => ({ id: 'programme-' + index, stay: 10,
        source: { kind: 'tunnel', sessionId: 'fixture-tunnel', accessGrant: 'fixture-proof',
            messageId: index < 16 ? 'text-record' : index === 16 ? 'image-record' : 'second-image-record',
            fileId: index < 16 ? 'record' : index === 16 ? 'image-asset' : 'second-image-asset' } }));
    await f.streaming.service.edit(station.id, actor, { configVersion: 1, items });
    const saved = f.streaming.service.station(station.id);
    const initial = { name: saved.name, configVersion: saved.configVersion, loop: true, countdown: 'bottom-right',
        items: saved.items.map(item => ({ ...item, source: { kind: 'tunnel', sessionId: item.source.sessionId,
            messageId: item.source.messageId, fileId: item.source.fileId }, sourceSaved: true })) };
    f.app.get('/save-errors-check', (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8">
        <link rel="stylesheet" href="/client/streaming-console.css"><script src="/client/streaming-player.js"></script>
        <script src="/client/streaming-console.js"></script><script>
        window.DiskClient={getAccount:()=>''};
        localStorage.setItem('streaming:${actor.deviceId}:key',${JSON.stringify(secret)});
        if(!localStorage.getItem('streaming:${actor.deviceId}:station:${station.id}')) {
            localStorage.setItem('streaming:${actor.deviceId}:station:${station.id}',JSON.stringify(${JSON.stringify(initial)}));
            localStorage.setItem('streaming:${actor.deviceId}:ui',JSON.stringify({view:'edit',stationId:'${station.id}',scroll:{},drafts:{}}));
        }
        StreamingConsole.init({deviceId:()=> '${actor.deviceId}',deviceName:()=> 'Save errors',devices:()=>[],
            tunnels:async()=>[{sessionId:'fixture-tunnel',accessGrant:'fixture-proof'}],toast:()=>{},home:()=>{}});
        StreamingConsole.open();</script>`));
    const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', cause => errors.push(cause.message));
    await page.goto(f.base + '/save-errors-check');
    await page.locator('.sc-name').fill('Edited name');
    const image = f.records.find(record => record.id === 'image-record').fileInfo, size = image.size;
    image.size++; secondRecord.fileInfo.size++;
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const dialog = page.locator('.sc-dialog');
    await dialog.waitFor();
    const marked = page.locator('.sc-program.sc-source-error');
    assert.deepEqual(await marked.evaluateAll(rows => rows.map(row => row.dataset.itemId)), ['programme-16', 'programme-17']);
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
    await page.waitForFunction(() => {
        const row = document.querySelector('.sc-program.sc-source-error').getBoundingClientRect();
        const list = document.querySelector('.sc-program-list').getBoundingClientRect();
        return row.top < list.bottom && row.bottom > list.top;
    });
    const first = await marked.first().boundingBox(), list = await page.locator('.sc-program-list').boundingBox();
    assert.ok(first.y < list.y + list.height && first.y + first.height > list.y);
    await page.waitForTimeout(1400);
    assert.equal(await marked.count(), 2, 'the error markers have no expiry timer');
    image.size = size;
    await page.locator('.sc-program[data-item-id="programme-16"]').getByRole('button', { name: '预览', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-item-id="programme-16"]').classList.contains('sc-source-error'));
    assert.deepEqual(await marked.evaluateAll(rows => rows.map(row => row.dataset.itemId)), ['programme-17']);
    await page.locator('.sc-dialog header').getByRole('button', { name: '关闭', exact: true }).click();
    await page.reload();
    await marked.first().waitFor();
    assert.equal(await marked.count(), 1, 'only unresolved save errors survive restoring the draft');
    secondRecord.fileInfo.size = size;
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '编辑节目单', exact: true }).waitFor();
    assert.equal(saved.name, 'Edited name');
    assert.equal(await marked.count(), 0);
    assert.deepEqual(errors, []);
});
