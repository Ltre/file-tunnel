'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), express = require('express');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
let browser, server, base;
const appSource=fs.readFileSync(path.resolve(__dirname,'../app.js'),'utf8');
const controlHistorySource=appSource.slice(appSource.indexOf('function bindControlCenterHistory('),appSource.indexOf('function initControlCenterShortcuts('));
before(async () => {
    const app = express();
    app.get('/before', (_req, res) => res.type('html').send('<title>Previous page</title>previous'));
    app.post('/api/streaming/devices', (_req, res) => res.json({ok:true}));
    app.post('/api/streaming/sync', (_req, res) => res.json({invitations:[]}));
    app.get('/api/streaming/provider-work', (_req, res) => res.json({requests:[]}));
    app.get('/api/streaming/stations', (_req, res) => res.json({stations:[]}));
    app.post('/api/streaming/invitations/fixture-invalid', (_req, res) => res.status(404).json({error:'STREAM_INVITE_INVALID'}));
    app.get('/case', (_req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/streaming-console.css"><link rel="stylesheet" href="/client/themes.css"><link rel="stylesheet" href="/client/account-ui.css">
        <script src="/client/vendor/web-markdown/marked-18.0.14.umd.js"></script><script src="/client/vendor/web-markdown/purify-3.4.16.min.js"></script>
        <script src="/client/tunnel-markdown.js"></script><script src="/client/streaming-console.js"></script><script src="/client/account-ui.js"></script><script src="/client/notification-center.js"></script>
        <main style="padding:28px"><h3>复制 / 移动</h3><div id="telegramDriveDialogBody"><div class="disk-space-transfer-tabs"><button class="active">复制到</button><button>移动到</button></div></div></main>
        <script>
        history.replaceState({session:'fixture-tunnel',filePreview:true},'',location.href);
        window.backgroundBacks=0;window.addEventListener('popstate',()=>backgroundBacks++);
        window.message={id:'record',sessionId:'fixture-tunnel',type:'markdown',markdown:'# Markdown preview\\n\\nVisible text.'};
        TunnelMarkdown.init({record:async()=>message,edit:async()=>({ok:true})});
        window.openReader=()=>{window.reader=TunnelMarkdown.preview(message)};
        ${controlHistorySource}
        window.openControl=()=>{const node=document.createElement('section');node.className='control-center-overlay';document.body.append(node);bindControlCenterHistory(node);};
        </script>`));
    app.use('/client', express.static(path.resolve(__dirname, '../client')));
    server = await require('./support/listen-http.cjs').listenHttp(app); base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
async function pageFor(t, width = 390) {
    const page = await browser.newPage({ viewport: { width, height: 844 } }); t.after(() => page.close());
    page.setDefaultTimeout(5000);
    await page.goto(base + '/before'); await page.goto(base + '/case#fixture-tunnel'); return page;
}
async function open(page) { await page.evaluate(() => openReader()); await page.locator('.sc-markdown-reader').last().waitFor(); }
async function closed(page) { await page.waitForFunction(() => !document.querySelector('.sc-markdown-dialog') && !history.state?.tunnelMarkdownDialog); }
test('narrow browser Back closes only the Markdown reader and keeps the underlying tunnel/file-preview state', async t => {
    const page = await pageFor(t); await open(page);
    assert.ok(await page.evaluate(() => history.state.tunnelMarkdownDialog));
    await page.goBack(); await closed(page);
    assert.deepEqual(await page.evaluate(() => history.state), { session: 'fixture-tunnel', filePreview: true });
    assert.equal(await page.evaluate(() => backgroundBacks), 0);
    assert.equal(new URL(page.url()).hash, '#fixture-tunnel');
});
test('close button and Escape consume their own history entry, including rapid reopening', async t => {
    const page = await pageFor(t);
    for (const method of ['button', 'Escape', 'button']) {
        await open(page);
        if (method === 'Escape') await page.keyboard.press('Escape');
        else await page.locator('.sc-markdown-reader header button').click();
        await closed(page);
    }
    assert.equal(await page.evaluate(() => backgroundBacks), 0);
    await page.goBack(); await page.waitForURL(base + '/before');
});
test('an editor preview returns to the unchanged unsaved editor, then Back closes that editor', async t => {
    const page = await pageFor(t); await open(page);
    await page.locator('.sc-markdown-reader-actions button').filter({ hasText: /^编辑$/ }).click();
    await page.locator('.sc-markdown-dialog textarea').waitFor();
    await page.locator('.sc-markdown-dialog textarea').fill('# Unsaved content');
    await page.locator('.sc-markdown-edit-actions button').filter({ hasText: /^预览$/ }).click();
    await page.locator('.sc-markdown-reader').waitFor();
    assert.equal(await page.locator('.sc-markdown-dialog').count(), 2);
    await page.goBack(); await page.waitForFunction(() => !document.querySelector('.sc-markdown-reader'));
    assert.equal(await page.locator('.sc-markdown-dialog textarea').inputValue(), '# Unsaved content');
    await page.goBack(); await closed(page);
    assert.equal(await page.evaluate(() => backgroundBacks), 0);
});
test('the nested common account panel receives Back before the Markdown reader', async t => {
    const page = await pageFor(t); await open(page);
    await page.evaluate(() => { void AccountUI.open({currentAccount:()=>'',load:async()=>({accounts:[],status:{}}),renderSignIn(){}}); });
    await page.locator('.account-overlay').waitFor(); await page.goBack(); await page.waitForFunction(() => !AccountUI.isOpen());
    assert.equal(await page.locator('.sc-markdown-reader').count(), 1);
    await page.goBack(); await closed(page); assert.equal(await page.evaluate(() => backgroundBacks), 0);
});

test('Back after manually closing the common account panel closes the reader in one action', async t => {
    const page = await pageFor(t); await open(page);
    await page.evaluate(() => { void AccountUI.open({currentAccount:()=>'',load:async()=>({accounts:[],status:{}}),renderSignIn(){}}); });
    await page.locator('.account-overlay').waitFor();
    await page.locator('.account-overlay').getByRole('button',{name:'关闭',exact:true}).click();
    await page.waitForFunction(() => !AccountUI.isOpen());
    await page.goBack(); await closed(page);
    assert.equal(await page.evaluate(() => backgroundBacks), 0);
    await page.goBack(); await page.waitForURL(base + '/before');
});

test('a Markdown invitation preserves the new real streaming history layer and skips the closed reader entry', async t => {
    const page = await pageFor(t);
    await page.evaluate(async() => {
        StreamingConsole.init({deviceId:()=> 'history-fixture',deviceName:()=> 'History test',devices:()=>[],tunnels:async()=>[],toast:()=>{},home:()=>{}});
        await StreamingConsole.whenReady();
        message.markdown='[Open invitation](/?stream_invite=fixture-invalid)';
    });
    await open(page); await page.getByRole('link',{name:'Open invitation',exact:true}).click();
    await page.waitForFunction(() => StreamingConsole.isOpen() && !document.querySelector('.sc-markdown-reader'));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => StreamingConsole.isOpen()), true);
    assert.equal(await page.locator('.sc-markdown-reader').count(), 0);
    assert.equal(await page.evaluate(() => history.state.streamingConsole), true);
    assert.equal(await page.evaluate(() => history.state.tunnelMarkdownDialog), undefined);
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('[data-sc-view="invitation"]')?.classList.contains('selected'));
    assert.equal(await page.evaluate(() => history.state.tunnelMarkdownDialog), undefined);
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('[data-sc-view="discover"]')?.classList.contains('selected'));
    await page.goBack(); await page.waitForFunction(() => !StreamingConsole.isOpen());
    assert.deepEqual(await page.evaluate(() => history.state), {session:'fixture-tunnel',filePreview:true});
    await page.goBack(); await page.waitForURL(base + '/before');
});

test('the real notification center receives Back and manual Close before the Markdown reader', async t => {
    const page = await pageFor(t); await open(page);
    await page.evaluate(() => { NotificationCenter.init(); NotificationCenter.open(); });
    await page.goBack(); await page.waitForFunction(() => document.getElementById('notificationCenter').hidden);
    assert.equal(await page.locator('.sc-markdown-reader').count(), 1);
    await page.evaluate(() => { NotificationCenter.open(); NotificationCenter.close(); });
    await page.waitForFunction(() => !history.state.notificationCenter);
    assert.equal(await page.locator('.sc-markdown-reader').count(), 1);
    await page.goBack(); await closed(page);
    await page.evaluate(() => NotificationCenter.open()); await open(page);
    await page.goBack(); await page.waitForFunction(() => !document.querySelector('.sc-markdown-reader'));
    assert.equal(await page.locator('#notificationCenter').evaluate(node=>node.hidden), false, 'a notification below Markdown keeps its own history');
});

test('the production control-center history closes above Markdown after an account Back without consuming the reader', async t => {
    const page = await pageFor(t); await open(page);
    await page.evaluate(() => { void AccountUI.open({currentAccount:()=>'',load:async()=>({accounts:[],status:{}}),renderSignIn(){}}); });
    await page.goBack(); await page.waitForFunction(() => !AccountUI.isOpen());
    await page.evaluate(() => openControl());
    await page.goBack(); await page.waitForFunction(() => !document.querySelector('.control-center-overlay'));
    assert.equal(await page.locator('.sc-markdown-reader').count(), 1);
    await page.evaluate(() => { openControl(); document.querySelector('.control-center-overlay').dismissControlCenter(); });
    await page.waitForFunction(() => !history.state.controlCenter);
    assert.equal(await page.locator('.sc-markdown-reader').count(), 1);
    await page.goBack(); await closed(page);
    await page.evaluate(() => openControl()); await open(page);
    await page.goBack(); await page.waitForFunction(() => !document.querySelector('.sc-markdown-reader'));
    assert.equal(await page.locator('.control-center-overlay').count(), 1, 'a control center below Markdown keeps its own history');
    await page.evaluate(() => document.querySelector('.control-center-overlay').dismissControlCenter());
    await page.waitForFunction(() => !history.state.controlCenter);
    await open(page);
    await page.evaluate(() => { void AccountUI.open({currentAccount:()=>'',load:async()=>({accounts:[],status:{}}),renderSignIn(){}}); });
    await page.locator('.account-overlay .account-close').click();
    await page.evaluate(() => { openControl(); document.querySelector('.control-center-overlay').dismissControlCenter(); });
    await page.waitForFunction(() => !history.state.controlCenter);
    assert.equal(await page.locator('.sc-markdown-reader').count(), 1, 'a manual control close after manual account close does not consume Markdown');
    await page.goBack(); await closed(page);
});

test('a failed editor metadata read keeps the current reader and its Back entry available', async t => {
    const page = await pageFor(t); await open(page);
    await page.evaluate(() => TunnelMarkdown.init({record:async()=>{throw Error('fixture-read-failed');},edit:async()=>({ok:true})}));
    await page.locator('.sc-markdown-reader-actions button').filter({ hasText: /^编辑$/ }).click();
    await page.getByText('操作未完成，请检查状态后重试 [fixture-read-failed]', {exact:true}).waitFor();
    assert.equal(await page.locator('.sc-markdown-reader').count(), 1);
    await page.goBack(); await closed(page);
});
test('closing all readers of a deleted record leaves no hidden Markdown history entry', async t => {
    const page = await pageFor(t); await open(page); await open(page);
    assert.equal(await page.locator('.sc-markdown-reader').count(), 2);
    await page.evaluate(() => TunnelMarkdown.closeRecord('record')); await closed(page);
    await open(page); await page.goBack(); await closed(page);
    await page.goBack(); await page.waitForURL(base + '/before');
});
test('wide reader keeps its original dimensions and does not add a history entry', async t => {
    const page = await pageFor(t, 1100), length = await page.evaluate(() => history.length); await open(page);
    const state = await page.locator('.sc-markdown-reader > section').evaluate(node => ({height:node.getBoundingClientRect().height,state:history.state,length:history.length}));
    assert.equal(state.length, length); assert.equal(state.state.tunnelMarkdownDialog, undefined); assert.ok(state.height < 844 && state.height > 600);
    await page.locator('.sc-markdown-reader header button').click(); await closed(page);
    await page.goBack(); await page.waitForURL(base + '/before');
});
test('Orbit and Lumen copy/move selection has strong contrast and a clear inset marker without changing layout', async t => {
    const page = await pageFor(t, 780); await page.setViewportSize({width:780,height:280});
    for (const theme of ['orbit', 'lumen']) {
        await page.evaluate(theme => document.body.dataset.theme = theme, theme);
        const state = await page.evaluate(() => {
            const selected=document.querySelector('.disk-space-transfer-tabs .active'),other=selected.nextElementSibling,s=getComputedStyle(selected),o=getComputedStyle(other);
            const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number),lum=value=>rgb(value).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
            const ink=lum(s.color),background=lum(s.backgroundColor);
            return {contrast:(Math.max(ink,background)+.05)/(Math.min(ink,background)+.05),selected:s.backgroundColor,other:o.backgroundColor,shadow:s.boxShadow,weight:Number(s.fontWeight),width:selected.getBoundingClientRect().width,otherWidth:other.getBoundingClientRect().width};
        });
        assert.ok(state.contrast >= 4.5); assert.notEqual(state.selected,state.other); assert.match(state.shadow,/inset/); assert.ok(state.weight>=800); assert.ok(Math.abs(state.width-state.otherWidth)<1);
        t.diagnostic(JSON.stringify({theme,...state}));
        await page.screenshot({path:path.resolve(__dirname,'../.npm-cache/261116-tabs-'+theme+'.png')});
    }
});
