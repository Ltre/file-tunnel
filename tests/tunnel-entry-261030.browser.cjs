'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), express = require('express');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
(async () => {
    const app = express();
    app.use(express.json());
    app.get('/api/short-codes/ABCDE', (_req, res) => res.json({sessionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}));
    app.post('/api/tunnel-access', (req, res) => res.json({allowed:true,grant:'fixture-grant',deviceId:req.body.deviceId}));
    app.use('/client', express.static(path.join(root, 'client')));
    app.get('/service-worker.js', (_req, res) => res.type('js').send(read('service-worker.js')));
    app.get('/tunnel-entry.html', (_req, res) => res.type('html').send(read('pages/tunnel-entry.html')));
    app.get('/index.html', (_req, res) => res.type('html').send('<title>完整首页</title><main id="full">完整首页</main>'));
    app.get('/manifest.webmanifest', (_req, res) => res.json({name:'fixture',start_url:'/'}));
    app.get('/tunnel-icon.svg', (_req, res) => res.type('svg').send('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    app.get('/', (req, res) => {
        if (Object.keys(req.query).every(key => key === 'leave' || key === 'pwa')) return res.type('html').send(read('pages/tunnel-entry.html'));
        res.type('html').send('<title>完整首页</title><main id="full">完整首页</main>');
    });
    app.get('/overlay', (req, res) => {
        if (req.query.open) return res.type('html').send('<title>完整首页</title><main id="full">完整首页</main>');
        const source = read('app.js'), functions = source.slice(source.indexOf('function initSessionLanding('), source.indexOf('function generateId('));
        const index = read('pages/index.html'), landing = index.slice(index.indexOf('    <div class="tunnel-landing"'), index.indexOf('    <header class="tunnel-topbar"'));
        res.type('html').send(`<!doctype html><link rel="stylesheet" href="/client/index.css"><link rel="stylesheet" href="/client/tunnel-landing.css"><body>${landing}<div id="appShell"><input id="draft" value="keep this"><div id="modal">original dialog</div></div><script>
        const state={sessionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',deviceId:'test',recentSessionId:null,pendingSharedFileCount:0};
        const list=[{sessionId:state.sessionId,shortCode:'ABCDE',lastActive:20},{sessionId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',shortCode:'FGHIJ',lastActive:10}];
        const readSessionDirectoryCache=()=>list,replaceSessionDirectoryCache=x=>x,getAllFromStore=async()=>list,normalizeLocalShortCode=x=>x,historyLog=()=>{},authorizeTunnelSelection=async()=>{},selectTunnelByShortCode=async()=>{},generateId=()=>state.sessionId;
        ${functions}
        window.showChooser=leaveTunnel;</script></body>`);
    });
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port; let browser;
    try {
        browser = await chromium.launch({channel:'chrome', headless:true});
        const context = await browser.newContext(), page = await context.newPage(), requests = [];
        page.on('request', request => requests.push(new URL(request.url()).pathname));
        await page.goto(base + '/'); await page.locator('#sessionLanding').waitFor({state:'visible'});
        assert.ok(!requests.some(url => ['/app.js', '/client/disk-ui.js', '/client/streaming-console.js', '/socket.io/socket.io.js', '/client/index.css', '/client/themes.css', '/client/themes-legacy.css'].includes(url)));
        await page.evaluate(() => localStorage.setItem('tunnelSessionDirectory:v1', JSON.stringify([{sessionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',shortCode:'ABCDE',lastActive:10}])));
        await page.goto(base + '/'); await page.locator('#full').waitFor(); assert.match(page.url(), /open=1#aaaaaaaa/);
        await page.goto(base + '/?leave=1'); await page.locator('#landingSessionSelect').waitFor({state:'visible'}); assert.equal(await page.locator('#landingSessionSelect').inputValue(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
        await page.goto(base + '/overlay'); await page.evaluate(() => showChooser());
        await page.locator('#sessionLanding').waitFor({state:'visible'}); assert.equal(await page.locator('#appShell').evaluate(node => getComputedStyle(node).visibility), 'hidden');
        await page.locator('#landingRecentBtn').click(); assert.equal(await page.locator('#sessionLanding').isVisible(), false); assert.equal(await page.locator('#draft').inputValue(), 'keep this'); assert.equal(await page.locator('#modal').isVisible(), true);
        await page.evaluate(() => showChooser()); await page.locator('#landingSessionSelect').selectOption('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
        await page.locator('#landingRecentBtn').click(); await page.locator('#full').waitFor(); assert.match(page.url(), /open=1#bbbbbbbb/);
        await context.close();
        const joinContext = await browser.newContext();
        await joinContext.addInitScript(() => { Object.defineProperty(crypto, 'randomUUID', {value:undefined}); });
        const joinPage = await joinContext.newPage(); await joinPage.goto(base + '/'); await joinPage.locator('#sessionLanding').waitFor({state:'visible'});
        for (let i = 0; i < 5; i++) await joinPage.locator('#tunnelCodeInputs input').nth(i).fill('ABCDE'[i]);
        await joinPage.locator('#full').waitFor();
        assert.equal(await joinPage.evaluate(() => JSON.parse(localStorage.getItem('tunnel-authorization:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).grant), 'fixture-grant');
        await joinContext.close();
        const sharedContext = await browser.newContext(), sharedPage = await sharedContext.newPage();
        await sharedPage.goto(base + '/overlay');
        await sharedPage.evaluate(async () => {
            localStorage.setItem('tunnelSessionDirectory:v1', JSON.stringify([{sessionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',shortCode:'ABCDE',lastActive:10}]));
            await new Promise((resolve, reject) => { const r = indexedDB.open('TunnelDB', 1); r.onupgradeneeded = () => r.result.createObjectStore('shareQueue', {keyPath:'id'}); r.onsuccess = () => { const db=r.result, tx=db.transaction('shareQueue','readwrite'); tx.objectStore('shareQueue').put({id:1}); tx.oncomplete=()=>{db.close();resolve();}; tx.onerror=()=>reject(tx.error); }; r.onerror=()=>reject(r.error); });
        });
        await sharedPage.goto(base + '/'); await sharedPage.locator('#sharedFilesNotice').waitFor({state:'visible'}); assert.match(await sharedPage.locator('#sharedFilesNotice').textContent(), /1/);
        await sharedContext.close();
        const offline = await browser.newContext(), offlinePage = await offline.newPage();
        await offlinePage.goto(base + '/'); await offlinePage.locator('#sessionLanding').waitFor({state:'visible'});
        await offlinePage.evaluate(async () => { await navigator.serviceWorker.ready; });
        await offlinePage.reload(); await offlinePage.waitForFunction(() => navigator.serviceWorker.controller !== null);
        await offline.setOffline(true); await offlinePage.goto(base + '/'); await offlinePage.locator('#sessionLanding').waitFor({state:'visible'});
        await offlinePage.goto(base + '/?open=1#aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); await offlinePage.locator('#full').waitFor();
        await offline.close(); console.log('PASS: minimal entry, recent resume, overlay restore, different tunnel and offline shell separation');
    } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
