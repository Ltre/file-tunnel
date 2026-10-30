'use strict';
// Real signed account cookies, Mock popup and account UI; synthetic users only.
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
const { createFixture } = require('./support/pending-save-261012-fixture.cjs');
async function run() {
    const f = await createFixture({ listDelayMs: 5000 }); let browser;
    try {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const context = await browser.newContext();
        for (const id of ['alice', 'bob']) {
            const response = await context.request.post(f.base + '/fixture-login', { form: { id, attempt: 'seed-' + id } });
            assert.equal(response.ok(), true);
        }
        const page = await context.newPage();
        await page.goto(f.base + '/disk'); await page.waitForFunction(() => !!window.DiskUI);
        await page.evaluate(() => DiskClient.raw('/me', { accountId: '', diskSpace: '' }));
        const meta = [];
        page.on('request', request => { if (new URL(request.url()).pathname === '/api/telegram/drive/me') meta.push(request.url()); });
        await page.evaluate(() => { void DiskUI.manageAccounts(); });
        await page.getByRole('button', { name: '验收甲账号', exact: true }).waitFor();
        assert.equal(meta.length, 0, 'opening the account dialog should reuse fresh metadata');
        console.log('PASS account rows render from current metadata without a second HTTP read');

        const nextPopup = page.waitForEvent('popup');
        await page.getByRole('button', { name: '添加 / 重新验证 Mock 账号', exact: true }).click();
        const popup = await nextPopup;
        const before = Date.now();
        await popup.getByRole('button', { name: '登录验收甲账号', exact: true }).click().catch(error => { if (!popup.isClosed()) throw error; });
        await page.waitForFunction(() => !AccountUI.isOpen(), undefined, { timeout: 2500 });
        assert.equal(await page.evaluate(() => DiskClient.getAccount()), 'alice');
        assert.equal(Date.now() - before < 4000, true, 'login must finish before the five-second directory read');
        assert.ok(meta.length, 'completed popup still verifies a real current server session');
        console.log('PASS verified Mock login closes while the unrelated directory read remains delayed');
    } finally { await browser?.close(); await f.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
