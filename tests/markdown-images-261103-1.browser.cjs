'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),os=require('node:os'),express=require('express');
const fs=require('node:fs');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
let browser,server,base;
before(async()=>{
    const app=express();app.get('/case',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/client/streaming-console.css">
    <script src="/client/vendor/web-markdown/marked-18.0.14.umd.js"></script><script src="/client/vendor/web-markdown/purify-3.4.16.min.js"></script><script src="/client/tunnel-markdown.js"></script><main id="inline"></main><script>
    window.releases=[];window.fail=false;window.revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{revoked.push(url);revoke(url)};
    const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
    window.message={id:'post',type:'markdown',markdown:'# Text\\n\\n'+[1,2,3,4].map(i=>'![Photo '+i+'](tunnel-blob:tunnel/record/image-'+i+')').join('\\n\\n')};
    TunnelMarkdown.init({readReference:async()=>{await new Promise(resolve=>releases.push(resolve));if(fail)throw Error('fixture-unavailable');return new Blob([png],{type:'image/png'})}});
    window.release=async()=>{for(let i=0;i<6;i++){releases.splice(0).forEach(resolve=>resolve());await new Promise(resolve=>setTimeout(resolve,5));}};
    </script>`));app.use(express.static(path.resolve(__dirname,'..')));
    server=await require('./support/listen-http.cjs').listenHttp(app);base='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({channel:'chrome',headless:true});
});
after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
async function pageFor(t){const page=await browser.newPage();t.after(()=>page.close());await page.goto(base+'/case');return page;}
test('SNS progress keeps one visible record and a late snapshot cannot replace the finished Markdown', async t => {
    const page = await pageFor(t);
    await page.addScriptTag({ path: 'client/sns-post-markdown.js' });
    await page.addStyleTag({ path: 'client/index.css' });
    await page.locator('#inline').evaluate(node => { node.id = 'chatMessages'; });
    const app = fs.readFileSync('app.js', 'utf8');
    const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
    await page.addScriptTag({ content: `
        const state = { sessionId: 'fixture-tunnel', deviceId: 'browser' }, records = new Map();
        const isHistoryMessageDeleted = () => false, isChatNearBottom = () => true;
        const getMessageElement = id => document.querySelector('[data-message-id="' + id + '"]');
        const formatTransferTimestamp = () => 'now', historyLog = () => {}, summarizeHistoryMessage = value => value;
        const syncTransferRecordFavoriteBadge = () => {}, syncTransferRecordSnsBadge = () => {}, renderMessageRecordActions = () => {};
        const activeCollectionPreviewMessageId = null, getCollectionFiles = () => [];
        const insertMessageElementByTimestamp = (container, element) => container.append(element);
        const saveToStore = async (_store, message) => records.set(message.id, message);
        const getFromStore = async (_store, id) => records.get(id);
        ${section('async function addMessageToChat(', 'function getFileInfoFromMessageElement(')}
        ${section('const snsMarkdownUpdates =', 'async function updateHistoryMessage(')}
    ` });
    const record = { id: 'post-progress', type: 'markdown', markdown: '', sessionId: 'fixture-tunnel', sender: 'server', senderName: 'SNS' };
    const update = row => page.evaluate(row => applyHistoryMessageUpdate(row, { remote: true }), row);
    const first = { ...record, snsMarkdownRevision: 1, snsMarkdownProgress: { stage: 'inspect', frameworkReady: false, done: 0, total: null } };
    await update(first);
    const row = page.locator('[data-message-id="post-progress"]');
    assert.equal(await row.getByText('正在解析帖子').count(), 1);
    assert.equal(await row.getByRole('progressbar').getAttribute('value'), null);
    const working = { ...record, snsMarkdownRevision: 2, snsMarkdownProgress: { stage: 'resources', frameworkReady: true, done: 1, total: 3, resource: 'video' } };
    await update(working);
    assert.equal(await row.getByText('文档框架已就绪').count(), 1);
    assert.equal(await row.getByText('引用资源 1/3').count(), 1);
    assert.equal(await row.getByText('正在保存视频').count(), 1);
    assert.equal(await row.getByRole('progressbar').getAttribute('value'), '1');
    await update({ ...record, snsMarkdownRevision: 3, snsMarkdownProgress: { ...working.snsMarkdownProgress, stage: 'failed', error: 'SNS_POST_INTERRUPTED' } });
    assert.equal(await row.getByText('生成 Markdown 未完成').count(), 1);
    assert.equal(await row.getByRole('progressbar').count(), 0);
    const finished = { ...record, markdown: '# Finished post', snsMarkdownRevision: 4 };
    await page.evaluate(async ([finished, stale]) => {
        await Promise.all([applyHistoryMessageUpdate(finished), applyHistoryMessageUpdate(stale)]);
    }, [finished, working]);
    assert.equal(await row.count(), 1);
    assert.equal(await row.getByRole('heading', { name: 'Finished post' }).count(), 1);
    assert.equal(await row.getByRole('progressbar').count(), 0);
});
test('inline Markdown shows four loading placeholders, never four broken images, before references arrive',async t=>{
    const page=await pageFor(t);await page.evaluate(()=>TunnelMarkdown.mount(document.getElementById('inline'),message));
    assert.equal(await page.getByText('图片载入中...', {exact:true}).count(),4);
    assert.equal(await page.locator('#inline img:visible').count(),0);
    await page.evaluate(()=>release());await page.waitForFunction(()=>[...document.querySelectorAll('#inline img')].length===4&&[...document.querySelectorAll('#inline img')].every(img=>img.naturalWidth>0&&!img.hidden));
    assert.equal(await page.getByText('图片载入中...', {exact:true}).count(),0);
});
test('the Markdown dialog keeps per-image loading placeholders while media is pending',async t=>{
    const page=await pageFor(t);await page.evaluate(()=>{window.reader=TunnelMarkdown.preview(message)});
    assert.equal(await page.locator('.sc-markdown-reader').getByText('图片载入中...', {exact:true}).count(),4);
    assert.equal(await page.locator('.sc-markdown-reader img:visible').count(),0);
    await page.getByRole('button',{name:'关闭',exact:true}).click();await page.evaluate(async()=>{await release();await reader});
    assert.equal(await page.locator('.sc-markdown-reader').count(),0);
    assert.equal(await page.evaluate(()=>revoked.length),4);
});
test('reloading a converted SNS post keeps its avatar and four server images visible without a browser provider', async t => {
    const fixture = await require('./support/streaming-console-fixture.cjs').createFixture();
    t.after(() => fixture.close());
    const body = fixture.sourceFiles[0].body;
    const owner = 'sns-converted-post';
    const attachments = ['avatar', 'photo-1', 'photo-2', 'photo-3', 'photo-4'].map(label => {
        const id = 'sns-asset-' + label;
        const filePath = path.join(fixture.dataDir, id);
        fs.writeFileSync(filePath, body);
        fixture.serverAssets.set(id, { sessionId: 'fixture-tunnel', size: body.length, path: filePath, markdownOwnerId: owner });
        return { id, name: label + '.png', type: 'image/png', size: body.length, isServerAsset: true,
            serverAssetUrl: '/api/server-assets/' + id, markdownOwnerId: owner };
    });
    fixture.records.push({ id: owner, type: 'markdown', sessionId: 'fixture-tunnel', markdownAttachments: attachments,
        markdown: '# X 帖子\n\n' + attachments.map(file =>
            '![' + file.name + '](tunnel-blob:fixture-tunnel/' + owner + '/' + file.id + ')').join('\n\n') });
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.addInitScript(() => {
        const opened = new Promise((resolve, reject) => {
            const request = indexedDB.open('fixture-tunnel-files', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('files');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        async function use(mode, operation) {
            const database = await opened;
            return new Promise((resolve, reject) => {
                const transaction = database.transaction('files', mode);
                const request = operation(transaction.objectStore('files'));
                transaction.oncomplete = () => resolve(request.result);
                transaction.onabort = () => reject(transaction.error);
            });
        }
        window.fixtureMarkdownCache = {
            get: id => use('readonly', store => store.get(id)),
            put: (id, file) => use('readwrite', store => store.put(file, id)),
            clear: () => use('readwrite', store => store.clear())
        };
    });
    await page.route('**/api/streaming/**', route => route.abort());
    let mediaRequests = 0;
    page.on('request', request => {
        if (request.url().endsWith('/api/tunnel-markdown/reference')) mediaRequests++;
    });
    async function renderPost() {
        await page.evaluate(async () => {
            const { records } = await (await fetch('/api/stream-fixture')).json();
            renderFixtureMarkdown(records.find(record => record.id === 'sns-converted-post'));
        });
    }
    async function verifyImages(selector) {
        const record = page.locator(selector);
        await record.locator('img').first().waitFor({ state: 'attached' });
        await page.waitForFunction(selector => {
            const target = document.querySelector(selector);
            return target?.querySelectorAll('img:not([hidden])').length === 5 || target?.textContent.includes('引用资源未获准或已失效');
        }, selector, { timeout: 4000 });
        assert.equal(await record.getByText('引用资源未获准或已失效', { exact: true }).count(), 0);
        assert.equal(await record.locator('img:visible').count(), 5);
    }
    await page.goto(fixture.base + '/markdown-check');
    await page.locator('#record-fixture-picture img:visible').waitFor();
    await page.evaluate(async ({ ids, bytes }) => {
        for (const id of ids) await fixtureMarkdownCache.put(id, { data: new Blob([Uint8Array.from(bytes)], { type: 'image/png' }) });
    }, { ids: attachments.map(file => file.id), bytes: [...body] });
    let before = mediaRequests;
    await renderPost();
    await verifyImages('#record-sns-converted-post');
    assert.equal(mediaRequests, before);
    await page.reload();
    await page.locator('#record-fixture-picture img:visible').waitFor();
    before = mediaRequests;
    await renderPost();
    await verifyImages('#record-sns-converted-post');
    assert.equal(mediaRequests, before, 'reloading preserves local media without requesting a ticket or media bytes');
    await page.evaluate(() => fixtureMarkdownCache.clear());
    await page.reload();
    await page.locator('#record-fixture-picture img:visible').waitFor();
    before = mediaRequests;
    await renderPost();
    await verifyImages('#record-sns-converted-post');
    assert.equal(mediaRequests - before, 5, 'each cache miss makes one direct media request');
    await page.locator('#record-sns-converted-post h1').click();
    await verifyImages('.sc-markdown-reader');
    await page.reload();
    await page.locator('#record-fixture-picture img:visible').waitFor();
    before = mediaRequests;
    await renderPost();
    await verifyImages('#record-sns-converted-post');
    assert.equal(mediaRequests, before, 'the fallback media was persisted under the Markdown attachment IDs');
});
