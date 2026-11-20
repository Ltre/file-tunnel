'use strict';
const { test, before, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), express = require('express');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const { createUpstreamExits } = require('../server/upstream-exits');
const { exportTrojanNodes, parseTrojanNodes } = require('../server/trojan-node-formats');
const root = path.resolve(__dirname, '..'); let browser, server, base, exits, dir; const calls = [];
before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'requirements-261120-'));
    exits = createUpstreamExits({ dataDir: dir, idleMs: 20, log() {}, startRuntime: async () => ({ proxy: 'http://127.0.0.1:9', alive: () => true, stop() {} }),
        nativeFetch: async url => {
            const name = exits.current().selected.name, ip = String(url).includes('api.ipify.org'); calls.push({ name, ip, url: String(url) });
            await new Promise(r => setTimeout(r, 80));
            if (name === 'Node B' && ip) throw Error('fixture IP lookup reset');
            return new Response(ip ? '192.0.2.20' : '<html>fixture page</html>', { status: 200 });
        } });
    for (const name of ['Node A', 'Node B', 'Node C']) exits.saveNode(null, { name, server: 'proxy.fixture.invalid', port: 443, password: 'synthetic-password' });
    const app = express(); app.use(express.json()); app.use('/client', express.static(path.join(root, 'client')));
    require('../server/upstream-exit-routes').registerUpstreamExitRoutes(app, { exits, requireAuth: (_q, _s, next) => next(), root });
    app.get('/picker', (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      ${['themes-legacy', 'index', 'disk', 'disk-directory-picker', 'themes-blamen', 'themes-lusns', 'themes'].map(name => '<link rel="stylesheet" href="/client/' + name + '.css">').join('')}
      <script src="/client/disk-directory-picker.js"></script><body data-theme="lumen"><div class="telegram-drive-dialog" style="display:block;position:relative;width:min(700px,95vw)"><div id="telegramDriveDialogBody" class="telegram-drive-dialog-body"></div></div><button id="openPicker">选择目录</button><output id="result"></output>
      <script>document.querySelector('#openPicker').onclick=()=>DiskDirectoryPicker.choose({initialPath:'测试专用',loadDirectories:async()=>({directories:[{path:'测试专用',name:'测试专用'},{path:'其它目录',name:'其它目录'}]}),openDialog:async options=>{const body=document.querySelector('#telegramDriveDialogBody');body.replaceChildren(...options.body);const done=document.createElement('button');done.textContent='确认目录';body.append(done);return await new Promise(resolve=>done.onclick=async()=>resolve(await options.validate()));}}).then(value=>document.querySelector('#result').textContent=value);</script>`));
    server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); server?.closeAllConnections(); if (server) await new Promise(r => server.close(r)); await exits?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
test('select all restores the previous choices independently per service across tab switches and save/reload', async () => {
    const page = await browser.newPage();
    try {
        await page.goto(base + '/upstream-exits'); await page.locator('#service-tab-telegram').waitFor({ state: 'attached' }); await page.locator('details').nth(1).locator('summary').click();
        const ids = exits.publicConfig().nodes.map(node => node.id);
        await page.locator('[data-exit-id="' + ids[1] + '"]').check(); await page.locator('[data-exit-id="' + ids[2] + '"]').check();
        await page.getByRole('button', { name: '全选', exact: true }).click(); assert.equal(await page.locator('.exit-order input:checked').count(), 4);
        await page.getByRole('button', { name: '全选', exact: true }).click();
        await page.locator('#service-tab-youtube').click(); assert.equal(await page.getByRole('button', { name: '撤销全选' }).isDisabled(), true);
        await page.getByRole('button', { name: '全选', exact: true }).click(); await page.getByRole('button', { name: '撤销全选' }).click(); assert.equal(await page.locator('.exit-order input:checked').count(), 0);
        await page.locator('#service-tab-telegram').click(); await page.getByRole('button', { name: '撤销全选' }).click();
        assert.deepEqual(await page.locator('.exit-order input:checked').evaluateAll(nodes => nodes.map(n => n.dataset.exitId)), ids.slice(1));
        await page.getByRole('button', { name: '保存此服务设置' }).click(); await page.waitForFunction(() => document.querySelector('#upstreamStatus').textContent.includes('已保存'));
        await page.reload(); await page.locator('#service-tab-telegram').waitFor({ state: 'attached' }); await page.locator('details').nth(1).locator('summary').click();
        assert.equal(await page.locator('.exit-order input:checked').count(), 2);
    } finally { await page.close(); }
});
test('bulk file export and import use actual endpoints and preserve unsaved editor input and policies', async () => {
    const page = await browser.newPage({ acceptDownloads: true });
    try {
        await page.goto(base + '/upstream-exits'); await page.locator('#nodeList button').first().waitFor({ state: 'attached' }); await page.locator('#trojanNodes summary').click();
        await page.locator('#nodeEditor input[name=name]').fill('未保存的表单');
        await page.getByRole('button', { name: '批量导出', exact: true }).click(); await page.locator('#nodeExportFormat').selectOption('clash');
        await page.locator('#nodeExportChoices input').nth(1).uncheck(); await page.locator('#nodeExportChoices input').nth(2).uncheck();
        const event = page.waitForEvent('download'); await page.getByRole('button', { name: '下载节点文件' }).click(); const download = await event;
        assert.match(download.suggestedFilename(), /clash\.yaml/); const parsed = parseTrojanNodes(fs.readFileSync(await download.path(), 'utf8')); assert.equal(parsed.nodes.length, 1);
        await page.locator('[data-close-dialog=nodeExportDialog]').click();
        const policy = exits.publicConfig().services;
        await page.getByRole('button', { name: '批量导入', exact: true }).click();
        await page.locator('#nodeImportFile').setInputFiles({ name: 'nodes.json', mimeType: 'application/json', buffer: Buffer.from(exportTrojanNodes([{ name: 'Imported node', server: 'new.fixture.invalid', port: 443, password: 'synthetic-import-password', verifyTls: true }], 'native').body) });
        await page.getByRole('button', { name: '导入节点', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#nodeImportResult').textContent.includes('已导入 1'));
        await page.locator('[data-close-dialog=nodeImportDialog]').click(); assert.equal(await page.locator('#nodeEditor input[name=name]').inputValue(), '未保存的表单');
        assert.deepEqual(exits.publicConfig().services, policy); assert.equal(exits.publicConfig().nodes.length, 4);
        await page.reload(); await page.locator('#nodeList button').filter({ hasText: 'Imported node' }).waitFor({ state: 'attached' });
        assert.equal(await page.locator('#trojanNodes').getAttribute('open'), null, 'node section retains its default collapsed state');
    } finally { await page.close(); }
});
test('batch panel keeps each exit fixed, continues page tests after IP failure, and survives closing', async () => {
    calls.length = 0; const page = await browser.newPage({ viewport: { width: 1250, height: 900 } });
    try {
        await page.goto(base + '/upstream-exits'); await page.locator('#nodeList button').first().waitFor({ state: 'attached' }); await page.locator('#trojanNodes summary').click();
        await page.getByRole('button', { name: '批量检查连通性' }).click(); await page.locator('#startNodeCheck:disabled').waitFor();
        await page.locator('[data-close-dialog=nodeCheckDialog]').click(); await page.getByRole('button', { name: '批量检查连通性' }).click();
        await page.waitForFunction(() => document.querySelector('#nodeCheckStatus').textContent.startsWith('检查完成'));
        const nodes = exits.publicConfig().nodes; assert.equal(calls.length, nodes.length * 2, 'reopening a running panel must not start duplicate work');
        assert.deepEqual(calls.map(c => c.name), nodes.flatMap(n => [n.name, n.name]));
        assert.ok(calls.every(c => c.ip || c.url === 'https://www.google.com/'));
        const failed = page.locator('#nodeCheckRows tr').filter({ hasText: 'Node B' });
        assert.equal(await failed.locator('td').nth(0).getAttribute('data-state'), 'failed'); assert.equal(await failed.locator('td').nth(1).getAttribute('data-state'), 'success');
        const output = path.join(root, '.npm-cache/261120-ui'); fs.mkdirSync(output, { recursive: true });
        await page.screenshot({ path: path.join(output, 'node-batch-wide.png') });
        await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(output, 'node-batch-narrow.png') });
    } finally { await page.close(); }
});
test('real directory picker selection stays visibly distinct under all themes, including hover and reselection', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 850 } });
    try {
        await page.goto(base + '/picker'); await page.locator('#openPicker').click(); await page.locator('.disk-folder-target.selected').waitFor();
        const selected = page.locator('[data-folder-path="测试专用"]'), other = page.locator('[data-folder-path="其它目录"]');
        for (const theme of ['lumen', 'orbit', 'classic', 'atelier', 'social', 'blamen', 'lusns']) {
            await page.evaluate(theme => document.body.dataset.theme = theme, theme);
            const style = await selected.evaluate(el => ({ image: getComputedStyle(el).backgroundImage, color: getComputedStyle(el).color, shadow: getComputedStyle(el).boxShadow }));
            assert.match(style.image, /gradient/, theme); assert.equal(style.color, 'rgb(255, 255, 255)', theme); assert.notEqual(style.shadow, 'none', theme);
            await other.hover(); assert.notEqual(await other.evaluate(el => getComputedStyle(el).backgroundImage), style.image, theme);
        }
        await other.click(); assert.equal(await selected.getAttribute('class'), 'disk-folder-target'); assert.equal(await other.getAttribute('class'), 'disk-folder-target selected');
        await page.getByRole('button', { name: '确认目录' }).click(); assert.equal(await page.locator('#result').innerText(), '其它目录');
        await page.evaluate(() => document.body.dataset.theme = 'lumen');
        const output = path.join(root, '.npm-cache/261120-ui'); fs.mkdirSync(output, { recursive: true });
        await page.screenshot({ path: path.join(output, 'picker-lumen.png') }); await page.evaluate(() => document.body.dataset.theme = 'orbit'); await page.screenshot({ path: path.join(output, 'picker-orbit.png') });
    } finally { await page.close(); }
});
