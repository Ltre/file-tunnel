'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os'), path = require('node:path');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const { createFixture } = require('./support/pending-save-261012-fixture.cjs');

for (const [pagePath, apiPath] of [['sns-dl', 'sns-dl'], ['youtube-premium-dl', 'youtube-premium']]) {
    test(pagePath + ' keeps independent drafts, submits the right form and restores an existing task', async t => {
        const fixture = await createFixture();
        t.after(() => fixture.close());
        const browser = await chromium.launch({ channel: 'chrome', headless: true });
        t.after(() => browser.close());
        const page = await browser.newPage();
        page.setDefaultTimeout(6000);
        const base = 'https://www.youtube.com/watch?v=';
        const [first, second] = [base + 'first', base + 'second'];
        const formats = id => ({
            title: 'Fixture ' + id, platform: 'twitter', downloadable: true, mediaType: 'video',
            selection: { ids: [id] }, formats: [{ id, kind: 'video_audio', ext: 'mp4', videoCodec: 'avc1', audioCodec: 'aac' }]
        });
        let releaseFirst, releaseSubmit, sent, failFormat = false;
        const firstGate = new Promise(resolve => { releaseFirst = resolve; });
        const submitGate = new Promise(resolve => { releaseSubmit = resolve; });
        const tasks = [{ id: 'existing-task', title: 'Earlier download', url: first, status: 'queued', mode: 'custom',
            selectedFormatIds: ['one'], downloadSections: '*00:01-00:02', remark: 'prior remark', cacheFiles: false }];
        await page.route('**/api/' + apiPath + '/formats', async route => {
            const { url } = route.request().postDataJSON();
            if (url === first) await firstGate;
            await route.fulfill({ json: formats(url === first && !failFormat ? 'one' : 'two') });
        });
        await page.route('**/api/' + apiPath + '/tasks?*', route => route.fulfill({ json: {
            tasks, total: tasks.length, page: 1, pages: 1, pageSize: 10, ids: tasks.map(task => task.id)
        } }));
        await page.route('**/api/' + apiPath + '/tasks', async route => {
            sent = route.request().postDataJSON();
            await submitGate;
            const task = { ...sent, id: 'created-task', title: 'Created', status: 'queued' };
            tasks.unshift(task);
            await route.fulfill({ json: task });
        });
        const mode = () => page.locator('input[name="mode"][value="custom"]').evaluate(input => input.click());
        const tab = n => page.getByRole('button', { name: '表单 ' + n, exact: true });
        await page.goto(fixture.base + '/' + pagePath);
        const url = page.locator('#urlInput');
        await url.fill(first);
        const requested = page.waitForRequest(req => req.url().endsWith('/formats') && req.postDataJSON()?.url === first);
        await mode();
        await requested;
        await page.getByRole('button', { name: '新建任务表单' }).click();
        await url.fill(second);
        await mode();
        await page.locator('#formatList input[value="two"]:checked').waitFor();
        releaseFirst();
        await tab(1).click();
        await page.locator('#formatList input[value="one"]:checked').waitFor();
        await page.locator('#preDownloadRemarkInput').fill('draft one');
        await tab(2).click();
        assert.equal(await url.inputValue(), second);
        await page.locator('#startBtn').click();
        await tab(1).click();
        releaseSubmit();
        await page.locator('[data-task-id="created-task"]').waitFor();
        assert.equal(sent.url, second);
        assert.equal(await url.inputValue(), first);
        await tab(2).click();
        assert.equal(await url.inputValue(), '');
        assert.equal(await page.locator('#formatList input').count(), 0);
        await tab(1).click();
        await page.reload();
        assert.equal(await url.inputValue(), first);
        assert.equal(await page.locator('#preDownloadRemarkInput').inputValue(), 'draft one');
        const reuse = page.locator('[data-task-id="existing-task"]').getByRole('button', { name: '复用此参数创建任务' });
        await reuse.click();
        assert.equal(await tab(3).getAttribute('aria-pressed'), 'true');
        await page.locator('#formatList input[value="one"]:checked').waitFor();
        assert.equal(await page.locator('#manualFormatInput').inputValue(), '');
        assert.equal(await page.locator('#preDownloadRemarkInput').inputValue(), 'prior remark');
        failFormat = true;
        await reuse.click();
        await page.locator('#formatList input[value="two"]').waitFor();
        assert.equal(await page.locator('#manualFormatInput').inputValue(), 'one');
        assert.equal(await page.locator('#useManualFormatInput').isChecked(), true);
    });
}
