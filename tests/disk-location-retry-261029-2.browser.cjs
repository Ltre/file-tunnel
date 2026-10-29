'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { createFixture } = require('./support/pending-save-261012-fixture.cjs');
const { chromium } = require('C:/Users/Dell/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
test('failed saved-file lookup remains visible and retries in the same drive page without another upload', async t => {
    const f = await createFixture({ serverTransfers: true }); t.after(() => f.close());
    const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
    const page = await browser.newPage();
    await page.request.post(f.base + '/fixture-login', { form: { id: 'alice' } });
    const get = async route => (await page.request.get(f.base + route)).json();
    const task = await get('/api/sns-dl/tasks/sns-fixture'), spaces = await get('/api/telegram/drive/spaces');
    const id = crypto.randomUUID();
    const response = await page.request.post(f.base + '/api/telegram/drive/task-saves', { data: {
        pendingSaveId: id, source: 'sns', taskId: task.id, version: task.completedAt + '-' + task.outputFileSize,
        partitionId: spaces.spaces[0].id, folderPath: '甲目录'
    } });
    const started = await response.json(); assert.ok(started.operation_id, JSON.stringify(started));
    let result;
    for (let n = 0; n < 100; n++) {
        result = await get('/api/telegram/drive/operations/' + started.operation_id);
        if (result.status === 'completed') break;
        await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(result.status, 'completed');
    await page.goto(f.base + '/api/telegram/drive/me');
    await page.addScriptTag({ url: f.base + '/client/disk-pending-save.js' });
    const saved = await page.evaluate(task => DiskPendingSave.prepareServer({ source: 'sns', task }), task);
    assert.equal(saved.id, id); assert.equal(saved.status, 'completed');
    let failed = false;
    await page.route('**/api/telegram/drive/files/*', route => {
        if (!failed) { failed = true; return route.abort('failed'); }
        return route.continue();
    });
    await page.goto(f.base + '/disk?pendingSave=' + id);
    const feedback = page.locator('#diskPendingSaveFeedback');
    await feedback.getByRole('button', { name: '重试查看' }).waitFor();
    assert.match(await feedback.textContent(), /转存完成记录仍保留/);
    assert.equal(new URL(page.url()).searchParams.get('pendingSave'), id);
    assert.doesNotMatch(await page.locator('#fixtureStatus').textContent(), /错误/);
    await feedback.getByRole('button', { name: '重试查看' }).click();
    await page.locator('#telegramDriveList .disk-upload-located').waitFor();
    assert.equal(new URL(page.url()).searchParams.has('pendingSave'), false);
    assert.equal(await feedback.count(), 0);
    assert.equal(await page.evaluate(async id => (await DiskPendingSave.get(id)).status, id), 'completed');
    const stats = await get('/fixture-stats'); assert.equal(stats.serverTransfersStarted, 1); assert.equal(stats.browserUploads, 0);
});
