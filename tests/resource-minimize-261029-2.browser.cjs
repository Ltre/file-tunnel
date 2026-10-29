'use strict';
// Production CSS and minimize/restore handlers; no business server or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), express = require('express');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.resolve(__dirname, '..');
async function run() {
    const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const handlers = source.slice(source.indexOf('function minimizeResourceBrowser('), source.indexOf('function initResourceBrowserCapsuleDrag('));
    const app = express(); app.use('/client', express.static(path.join(root, 'client')));
    app.get('/', (_req, res) => res.type('html').send(`<link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/themes.css">
        <button id="other" style="position:fixed;left:20px;top:20px">Other action</button>
        <aside id="resourceBrowserLayer" class="resource-browser-layer active"><div class="modal resource-browser-modal">
        <header class="resource-browser-header"><div class="resource-browser-header-main"><h3>Resources</h3></div><div class="resource-browser-header-actions"><button class="resource-browser-minimize">−</button></div></header>
        <section>Resource list</section></div></aside><script>${handlers}
        document.querySelector('.resource-browser-minimize').onclick=minimizeResourceBrowser;
        document.querySelector('.resource-browser-header-main').onclick=restoreResourceBrowser;
        window.otherClicks=0;document.getElementById('other').onclick=()=>otherClicks++;</script>`));
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    let browser;
    try {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        for (const theme of ['lumen', 'orbit', 'classic']) {
            await page.goto('http://127.0.0.1:' + server.address().port);
            await page.evaluate(theme => document.body.dataset.theme = theme, theme);
            const layer = page.locator('#resourceBrowserLayer');
            assert.notEqual(await layer.evaluate(n => getComputedStyle(n).backgroundColor), 'rgba(0, 0, 0, 0)', theme + ': expanded backdrop');
            await page.locator('.resource-browser-minimize').click();
            const minimized = await layer.evaluate(n => { const s = getComputedStyle(n); return { background: s.backgroundColor, blur: s.backdropFilter, pointer: s.pointerEvents }; });
            assert.equal(minimized.background, 'rgba(0, 0, 0, 0)', theme + ': no dim layer');
            assert.equal(minimized.blur, 'none', theme + ': no blur layer');
            await page.locator('#other').click(); assert.equal(await page.evaluate(() => otherClicks), 1);
            await page.locator('.resource-browser-header-main').click();
            assert.equal(await layer.evaluate(n => n.classList.contains('active') && !n.classList.contains('is-minimized')), true);
            console.log('PASS ' + theme + ': minimizes without backdrop and restores, other actions remain usable');
        }
    } finally { await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
