'use strict';
// Actual app HTML, theme assets and Service Worker, with fresh fixture data and
// browser storage. The server alone simulates the old/new worker script; no
// production files or cache are rewritten. Offline assertions concern the shell
// and theme resources, not unavailable network/auth/media business operations.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const { createFixture } = require('./support/streaming-console-fixture.cjs');
const root = path.resolve(__dirname, '..');
const sw = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
const current = sw.match(/const CACHE_NAME = '([^']+)'/)[1];
const previous = 'instant-tunnel-v95-content-v8-feedback-261029-1';
const assets = ['/app.js', '/client/disk-ui.js', '/client/streaming-console.js', '/client/streaming-player.js', '/client/streaming-i18n.js', '/client/sns-post-i18n.js', '/client/themes.css', '/client/themes-legacy.css', '/client/theme-preference.js', '/client/index.css', '/client/streaming-console.css', '/client/icons/streaming.png'];
async function run() {
    let upgraded = false, browser;
    const f = await createFixture({ serviceWorker: () => upgraded ? sw : sw.replace(current, previous) });
    const output = path.join(root, '.npm-cache', 'theme-offline-261028');
    fs.mkdirSync(output, { recursive: true });
    try {
        browser = await chromium.launch({ channel:'chrome', headless:true });
        const context = await browser.newContext({ locale:'zh-CN', serviceWorkers:'allow' });
        const page = await context.newPage(); page.setDefaultTimeout(20000);
        await page.goto(f.base + '/?leave=1');
        await page.waitForFunction(() => typeof startupTimings !== 'undefined' && startupTimings.completeMs !== null);
        await page.evaluate(async () => { await navigator.serviceWorker.ready; });
        await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
        const warm = async () => page.evaluate(async paths => {
            for (const url of paths) { const r=await fetch(url); if (!r.ok) throw Error(url+': '+r.status); await r.arrayBuffer(); }
        }, assets);
        await warm();
        assert.ok((await page.evaluate(() => caches.keys())).includes(previous));
        upgraded = true;
        await page.evaluate(async () => {
            const r=await navigator.serviceWorker.getRegistration(), previous=navigator.serviceWorker.controller;
            const changed=new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
            await r.update();
            if (navigator.serviceWorker.controller===previous) await changed;
        });
        await page.waitForFunction(async ({current,previous}) => (await caches.keys()).includes(current) && !(await caches.keys()).includes(previous), {current,previous});
        await page.reload({ waitUntil:'load' });
        await page.waitForFunction(() => typeof startupTimings !== 'undefined' && startupTimings.completeMs !== null);
        await warm();
        await page.evaluate(async name => {
            const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('theme-offline-business-sentinel',1);r.onupgradeneeded=()=>r.result.createObjectStore('records');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
            await new Promise((resolve,reject)=>{const tx=db.transaction('records','readwrite');tx.objectStore('records').put('unchanged','draft');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
            localStorage.setItem('uiTheme',name);
        }, 'orbit');
        const results=[];
        await context.setOffline(true);
        for (const theme of ['orbit','lumen']) {
            await page.evaluate(name => localStorage.setItem('uiTheme',name), theme);
            await page.reload({ waitUntil:'domcontentloaded' });
            await page.waitForFunction(name => document.body.dataset.theme === name && [...document.styleSheets].some(s => s.href?.endsWith('/client/themes.css')), theme);
            const result = await page.evaluate(async paths => {
                const resources=[];
                for (const url of paths) {const r=await fetch(url);resources.push({url,status:r.status,bytes:(await r.arrayBuffer()).byteLength});}
                const db=await new Promise(resolve=>{const r=indexedDB.open('theme-offline-business-sentinel');r.onsuccess=()=>resolve(r.result);});
                const sentinel=await new Promise(resolve=>{const r=db.transaction('records').objectStore('records').get('draft');r.onsuccess=()=>resolve(r.result);});db.close();
                return {theme:document.body.dataset.theme,ink:getComputedStyle(document.body).color,resources,sentinel,caches:await caches.keys(),previewRecovery:typeof releaseStoredFileUrl==='function'&&typeof scheduleFileObjectUrlCleanup==='function'};
            }, assets);
            assert.equal(result.theme,theme);assert.equal(result.ink,theme==='orbit'?'rgb(232, 235, 250)':'rgb(37, 41, 67)');
            assert.ok(result.resources.every(r=>r.status===200&&r.bytes>0));assert.equal(result.sentinel,'unchanged');
            assert.equal(result.previewRecovery,true,'offline shell must load the new preview URL lifecycle code');
            assert.ok(result.caches.includes(current));assert.ok(!result.caches.includes(previous));
            results.push(result);
            await page.screenshot({path:path.join(output,theme+'-offline.png')});
        }
        fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({workerUpgrade:previous+' -> '+current,results},null,2));
        console.log('PASS actual Service Worker upgrade and offline Lumen/Orbit reload; theme assets readable, independent IndexedDB sentinel retained');
    } finally {await browser?.close();await f.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
