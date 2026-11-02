'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path'), os = require('node:os'), express = require('express');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
let browser, server, base;
before(async () => {
    const app = express();
    app.get('/case', (_req, res) => res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/streaming-console.css">
        <link rel="stylesheet" href="/client/themes.css"><link rel="stylesheet" href="/client/themes-blamen.css"><link rel="stylesheet" href="/client/themes-lusns.css">
        <script src="/client/vendor/web-markdown/marked-18.0.14.umd.js"></script>
        <script src="/client/vendor/web-markdown/purify-3.4.16.min.js"></script><script src="/client/tunnel-markdown.js"></script>
        <div id="inline"></div><script>
        window.calls=[];window.revoked=[];window.mode='ready';window.releases=[];
        const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{revoked.push(url);revoke(url)};
        const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
        window.message={id:'sns-post',sessionId:'tunnel',type:'markdown',markdown:'# 帖子正文\\n\\n[原帖](https://x.com/example/status/123)\\n\\n'+[1,2,3,4].map(i=>'![图'+i+'](tunnel-blob:tunnel/record/image-'+i+')').join('\\n\\n')};
        TunnelMarkdown.init({readReference:async url=>{calls.push(url);if(mode==='blocked')await new Promise(resolve=>releases.push(resolve));if(mode==='failed')throw Error('fixture-missing');return new Blob([png],{type:'image/png'})}});
        window.openReader=()=>{window.reader=TunnelMarkdown.preview(message).catch(e=>{window.readerError=e.message})};
        </script>`));
    app.use(express.static(path.resolve(__dirname, '..')));
    server = await require('./support/listen-http.cjs').listenHttp(app);
    base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
async function pageFor(t) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    t.after(() => page.close());
    await page.goto(base + '/case');
    return page;
}
async function prime(page) {
    await page.evaluate(() => TunnelMarkdown.mount(document.getElementById('inline'), message));
    await page.waitForFunction(() => {
        const images = [...document.querySelectorAll('#inline img')];
        return images.length === 4 && images.every(image => image.complete && image.naturalWidth > 0);
    });
}
async function frame(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }

test('already visible SNS images open in the reader without rereading all four bodies', async t => {
    const page = await pageFor(t); await prime(page);
    await page.evaluate(() => { mode = 'blocked'; openReader(); }); await frame(page);
    const state = await page.evaluate(() => ({
        visible: !document.querySelector('.sc-markdown-reader .sc-document').hidden,
        loaded: [...document.querySelectorAll('.sc-markdown-reader img')].filter(image => image.complete && image.naturalWidth > 0).length,
        calls: calls.length
    }));
    assert.equal(state.visible, true, 'reader body must not stay hidden behind 正在加载 Markdown…');
    assert.equal(state.loaded, 4, 'reuse images already loaded in the connected inline record');
    assert.equal(state.calls, 4, 'opening the same record must not fetch all image bodies again');
    for (let i = 0; i < 3; i++) {
        await page.locator('.sc-markdown-reader header button').click();
        await page.evaluate(() => openReader()); await frame(page);
        assert.equal(await page.evaluate(() => calls.length), 4);
    }
});

test('a slow first media read does not hide Markdown text or disable closing', async t => {
    const page = await pageFor(t);
    await page.evaluate(() => { mode = 'blocked'; openReader(); }); await frame(page);
    assert.equal(await page.locator('.sc-markdown-reader .sc-document').isVisible(), true);
    assert.match(await page.locator('.sc-markdown-reader .sc-document').innerText(), /帖子正文/);
    assert.equal(await page.locator('.sc-markdown-reader .sc-markdown-loading').isVisible(), true, 'cold media loading remains visible without covering the text');
    await page.locator('.sc-markdown-reader header button').click();
    await page.evaluate(async () => {
        for (let i = 0; i < 5; i++) { releases.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setTimeout(resolve, 0)); }
        await reader;
    });
    assert.equal(await page.locator('.sc-markdown-reader').count(), 0);
    assert.equal(await page.evaluate(() => revoked.length), 4, 'late reads must release their object URLs');
});

test('reader retains shared URLs after the inline record disappears, then releases them on close', async t => {
    const page = await pageFor(t); await prime(page);
    await page.evaluate(async () => { openReader(); await reader; });
    const url = await page.locator('.sc-markdown-reader img').first().getAttribute('src');
    await page.locator('#inline').evaluate(node => node.remove()); await frame(page);
    assert.equal(await page.evaluate(async url => (await fetch(url)).ok, url), true);
    await page.locator('.sc-markdown-reader header button').click(); await frame(page);
    assert.equal(await page.evaluate(() => revoked.length), 4, 'each shared URL is released once after both views close');
});

test('simultaneous readers retain independent leases and release only after the last view closes', async t => {
    const page = await pageFor(t); await prime(page);
    await page.evaluate(async () => { openReader(); await reader; openReader(); await reader; });
    const url = await page.locator('.sc-markdown-reader img').first().getAttribute('src');
    await page.locator('#inline').evaluate(node => node.remove()); await frame(page);
    await page.locator('.sc-markdown-reader header button').last().click(); await frame(page);
    assert.equal(await page.evaluate(async url => (await fetch(url)).ok, url), true);
    assert.equal(await page.evaluate(() => revoked.length), 0);
    await page.locator('.sc-markdown-reader header button').click(); await frame(page);
    assert.equal(await page.evaluate(() => revoked.length), 4);
});

test('an open reader shares an inline read already in flight, but a different record object reads afresh', async t => {
    const page = await pageFor(t);
    await page.evaluate(() => { mode = 'blocked'; TunnelMarkdown.mount(document.getElementById('inline'), message); openReader(); });
    await frame(page);
    assert.equal(await page.evaluate(() => calls.length), 1);
    assert.equal(await page.locator('.sc-markdown-reader .sc-document').isVisible(), true);
    await page.evaluate(async () => { mode = 'ready'; releases.splice(0).forEach(resolve => resolve()); await reader; });
    assert.equal(await page.evaluate(() => calls.length), 4);
    await page.locator('.sc-markdown-reader header button').click();
    await page.evaluate(() => TunnelMarkdown.preview({ ...message }));
    assert.equal(await page.evaluate(() => calls.length), 8, 'same ID/body on a different object must not use a global resource cache');
});

test('edited content does not reuse an old inline reference mapping; failed resources keep text and retry', async t => {
    const page = await pageFor(t); await prime(page);
    await page.evaluate(async () => {
        message.markdown = '# 修改后的正文\n\n![新图](tunnel-blob:tunnel/new/new-image)';
        mode = 'failed'; openReader(); await reader;
    });
    assert.equal(await page.evaluate(() => calls.length), 5);
    assert.match(await page.locator('.sc-markdown-reader .sc-document').innerText(), /修改后的正文/);
    assert.equal(await page.getByRole('button', { name: '重试', exact: true }).isVisible(), true);
    await page.evaluate(() => { mode = 'ready'; });
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.sc-markdown-reader img')?.naturalWidth > 0);
});

test('Blamen and Lusns mobile control center containers have four rounded corners without clipping tiles', async t => {
    const page = await pageFor(t);
    const geometry = [];
    for (const theme of ['classic', 'blamen', 'lusns']) {
        const state = await page.evaluate(theme => {
            document.body.dataset.theme = theme;
            document.querySelector('.control-center')?.remove();
            const panel = document.createElement('div'); panel.className = 'control-center';
            panel.innerHTML = '<div class="control-center-tiles"><button class="control-center-tile">☀</button></div>'; document.body.append(panel);
            const style = getComputedStyle(panel), rect = panel.getBoundingClientRect();
            return { radius: [style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius], size: [rect.width,rect.height], overflow: style.overflowY };
        }, theme);
        geometry.push(state.size);
        if (theme !== 'classic') assert.ok(state.radius.every(value => parseFloat(value) >= 9), theme + ' control-center corners must be rounded');
        assert.equal(state.overflow, 'auto');
    }
    assert.deepEqual(geometry[1], geometry[0]); assert.deepEqual(geometry[2], geometry[0]);
    await page.setViewportSize({width: 1024, height: 844});
    assert.equal(await page.locator('.control-center').evaluate(node => getComputedStyle(node).borderRadius), '0px', 'the radius exception applies only on narrow screens');
});
