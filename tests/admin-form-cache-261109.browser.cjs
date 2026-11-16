'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), os = require('node:os'), fs = require('node:fs');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const { createFixture } = require('./support/pending-save-261012-fixture.cjs'), { createAdminFormRouter, createAdminFormStore } = require('../server/admin-form-cache');
const formats = { title: 'All candidates', platform: 'youtube', downloadable: true, mediaType: 'video', selection: { ids: ['18'] }, formats: [{ id: '18', kind: 'video_audio', ext: 'mp4', videoCodec: 'avc1', audioCodec: 'aac' }, { id: '137', kind: 'video', ext: 'mp4', videoCodec: 'avc1' }, { id: '140', kind: 'audio', ext: 'm4a', audioCodec: 'aac' }] };
for (const [pagePath, apiPath, storageKey] of [['sns-dl', 'sns-dl', 'snsDownloadForms'], ['youtube-premium-dl', 'youtube-premium', 'youtubePremiumDownloadForms']]) test(pagePath + ': opt-in cloud snapshots survive a fresh browser, copy locally, delete remotely and clean after accepted submission', { timeout: 35000 }, async t => {
    const fixture = await createFixture(); t.after(() => fixture.close());
    fixture.app.use('/api/admin-forms', createAdminFormRouter({ dataDir: fixture.dataDir })); const store = createAdminFormStore(fixture.dataDir);
    const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
    let submissions = 0;
    const context = async () => {
        const context = await browser.newContext({ locale: 'zh-CN' });
        await context.route('**/api/' + apiPath + '/formats', route => route.fulfill({ json: formats }));
        await context.route('**/api/' + apiPath + '/tasks', route => route.fulfill({ json: { ...route.request().postDataJSON(), id: 'created-' + (++submissions), title: 'Created', status: 'queued' } }));
        return context;
    };
    const one = await context(), first = await one.newPage(); await first.goto(fixture.base + '/' + pagePath);
    await first.locator('#saveDownloadForm:enabled').waitFor();
    await first.locator('#urlInput').fill('https://www.youtube.com/watch?v=cloud');
    await first.locator('input[name="mode"][value="custom"]').evaluate(node => node.click());
    await first.locator('#formatList input[value="18"]').waitFor();
    await first.locator('#preDownloadRemarkInput').fill('原始备注'); await first.locator('#saveDownloadForm').click();
    await first.waitForFunction(() => document.querySelector('[data-draft-id][aria-pressed="true"]').textContent === '☁|原始备注');
    let saved = await store.list(pagePath); assert.equal(saved.length, 1); assert.equal(saved[0].analysis.formats.length, 3); assert.equal(saved[0].form.remark, '原始备注');
    assert.ok(fs.existsSync(path.join(fixture.dataDir, 'admin-forms', pagePath, saved[0].id + '.json')));
    const two = await context(), second = await two.newPage(); await second.goto(fixture.base + '/' + pagePath);
    await second.waitForFunction(() => document.querySelector('[data-draft-id][aria-pressed="true"]')?.textContent === '☁|原始备注');
    assert.equal(await second.locator('#urlInput').inputValue(), 'https://www.youtube.com/watch?v=cloud'); assert.equal(await second.locator('#formatList input').count(), 3);
    assert.equal(await second.locator('#preDownloadRemarkInput').inputValue(), '原始备注');
    await second.locator('#copyDownloadForm').click(); assert.equal(await second.locator('[data-draft-id][aria-pressed="true"]').textContent(), '原始备注'); assert.equal((await store.list(pagePath)).length, 1);
    second.on('dialog', dialog => dialog.accept()); await second.locator('#deleteDownloadForm').click();
    await second.waitForFunction(() => document.querySelectorAll('[data-draft-id]').length === 1);
    await second.locator('#deleteDownloadForm').click(); await second.waitForFunction(() => !document.getElementById('urlInput').value);
    assert.equal((await store.list(pagePath)).length, 0);
    await first.reload(); await first.locator('#saveDownloadForm:enabled').waitFor(); assert.equal(await first.locator('[data-draft-id][aria-pressed="true"]').textContent(), '原始备注');
    await first.locator('#formatList input[value="18"]').waitFor(); await first.locator('#saveDownloadForm').click();
    await first.waitForFunction(() => document.querySelector('[data-draft-id][aria-pressed="true"]').textContent.startsWith('☁|'));
    saved = await store.list(pagePath); assert.ok(saved[0].id > 1, 'a deleted form number is not recycled');
    let failedDelete = false;
    await first.route('**/api/admin-forms/' + pagePath + '/*', route => {
        if (route.request().method() === 'DELETE' && !failedDelete) { failedDelete = true; return route.abort('failed'); }
        return route.continue();
    });
    await first.locator('#startBtn').click(); await first.waitForFunction(() => !document.getElementById('urlInput').value);
    await first.getByRole('button', { name: '重试清理服务器表单', exact: true }).waitFor();
    assert.equal(submissions, 1, 'a cleanup failure never resubmits the accepted task');
    assert.equal(await first.evaluate(key => JSON.parse(localStorage.getItem(key)).cleanup.length, storageKey), 1);
    await first.getByRole('button', { name: '重试清理服务器表单', exact: true }).click();
    await first.waitForFunction(key => JSON.parse(localStorage.getItem(key)).cleanup.length === 0, storageKey);
    assert.equal((await store.list(pagePath)).length, 0); assert.equal(submissions, 1);
});

test('a cloud save response arriving after successful submission is cleaned instead of marking the blank replacement form', { timeout: 20000 }, async t => {
    const fixture = await createFixture(); t.after(() => fixture.close()); fixture.app.use('/api/admin-forms', createAdminFormRouter({ dataDir: fixture.dataDir }));
    const store = createAdminFormStore(fixture.dataDir), browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
    const page = await browser.newPage({ locale: 'zh-CN' }); let release, accepted, submissions = 0;
    const gate = new Promise(resolve => release = resolve), saving = new Promise(resolve => accepted = resolve); t.after(() => release());
    await page.route('**/api/admin-forms/sns-dl', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch(); accepted(); await gate; await route.fulfill({ response });
    });
    await page.route('**/api/sns-dl/tasks', route => route.fulfill({ json: { ...route.request().postDataJSON(), id: 'late-save-' + (++submissions), title: 'Created', status: 'queued' } }));
    await page.goto(fixture.base + '/sns-dl'); await page.locator('#saveDownloadForm:enabled').waitFor();
    await page.locator('#urlInput').fill('https://example.invalid/late-save'); await page.locator('#saveDownloadForm').click(); await saving;
    assert.equal((await store.list('sns-dl')).length, 1);
    await page.locator('#startBtn').click(); await page.waitForFunction(() => !document.getElementById('urlInput').value);
    release(); await page.waitForFunction(() => { const saved = JSON.parse(localStorage.getItem('snsDownloadForms')); return !saved.drafts.some(item => item.cloudId) && !saved.cleanup.length && !document.getElementById('saveDownloadForm').disabled; });
    assert.equal((await store.list('sns-dl')).length, 0); assert.equal(submissions, 1);
    assert.equal((await page.locator('[data-draft-id][aria-pressed="true"]').textContent()).includes('☁|'), false);
});
