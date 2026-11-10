'use strict';
const { test, before, after } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), express = require('express');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
let browser, server, base;
before(async () => {
    const app = express(); app.use('/client', express.static(path.join(root, 'client')));
    const source = read('app.js'), start = source.indexOf('function initTunnelSettings()'), end = source.indexOf('function initStreamingConsoleIntegration()', start);
    app.get('/', (_req, res) => res.type('html').send(read('pages/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace('</head>', '<script defer src="/client/i18n-bootstrap.js"></script><script defer src="/client/i18n.js"></script></head>').replace('</body>', `<script>const initCallRingtoneSettings=()=>{},renderTunnelPermissionSettings=()=>{},updateLanP2pPermissionUi=()=>{},refreshCallRingtoneSettingsUi=()=>{},grantLanP2pPermission=()=>{};${source.slice(start, end)}initTunnelSettings();document.getElementById('tunnelStartupLoading')?.remove();document.getElementById('appShell').hidden=false;</script></body>`)));
    app.get('/parts', (_req, res) => res.type('html').send(read('pages/light-file-parts.html').replace('<script src="/client/light-transfer.js"></script>', '<script>window.Drop2TunnelLightTransfer={listTasks:async()=>[],listReceipts:async()=>[]};</script>')));
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); });
async function fixture(locale, preference) {
    const context = await browser.newContext({ locale });
    if (preference) await context.addInitScript(value => localStorage.setItem('drop2tunnel.language', value), preference);
    const page = await context.newPage(), requests = []; page.on('request', request => { if (/\/client\/i18n\//.test(request.url())) requests.push(request.url()); });
    await page.goto(base); await page.evaluate(() => TunnelI18n.ready);
    return { context, page, requests };
}
for (const [locale, expected] of [['zh-CN', 'zh-Hans'], ['zh-TW', 'zh-Hant'], ['en-US', 'en'], ['es-ES', 'en'], ['ja-JP', 'en'], ['pl-PL', 'en']]) test('initial system language ' + locale + ' uses only the Chinese/English startup data', async () => {
    const f = await fixture(locale); try {
        assert.equal(await f.page.locator('html').getAttribute('lang'), expected);
        assert.equal(await f.page.locator('#appLanguageSelect').inputValue(), 'system');
        assert.deepEqual(f.requests, []);
        assert.equal(await f.page.locator('#appLanguageSelect option[value="system"]').textContent(), await f.page.evaluate(() => TunnelI18n.t('使用系统语言')));
        assert.equal(await f.page.evaluate(() => Object.values(Drop2TunnelI18nCatalog).some(item => item.ja || item.es)), false);
    } finally { await f.context.close(); }
});
test('a Spanish system is offered its pack only on entering real tunnel settings; decline keeps English, accept preserves system and caches the pack', async () => {
    const f = await fixture('es-ES'); try {
        let message;
        f.page.once('dialog', async dialog => { message = dialog.message(); await dialog.dismiss(); });
        await f.page.locator('#tunnelSettingsBtn').evaluate(node => node.click());
        await f.page.waitForFunction(() => !document.getElementById('tunnelSettingsLayer').hidden);
        await f.page.waitForTimeout(80); assert.match(message, /Spanish.*language pack/); assert.deepEqual(f.requests, []);
        assert.equal(await f.page.locator('html').getAttribute('lang'), 'en');
        await f.page.reload(); await f.page.evaluate(() => TunnelI18n.ready);
        const other = await f.context.newPage(); await other.goto(base); await other.evaluate(() => TunnelI18n.ready);
        assert.equal(await other.locator('html').getAttribute('lang'), 'en');
        f.page.once('dialog', dialog => dialog.accept()); await f.page.locator('#tunnelSettingsBtn').evaluate(node => node.click());
        await f.page.waitForFunction(() => document.documentElement.lang === 'es');
        await other.waitForFunction(() => document.documentElement.lang === 'es');
        assert.equal(f.requests.length, 1); assert.match(f.requests[0], /\/es\.json\?v=/);
        assert.equal(await f.page.locator('#appLanguageSelect').inputValue(), 'system');
        assert.equal(await f.page.evaluate(() => localStorage.getItem('drop2tunnel.system-language-consent')), 'es');
        await f.page.reload(); await f.page.evaluate(() => TunnelI18n.ready); assert.equal(f.requests.length, 1, 'reuse the versioned device cache');
        assert.equal(await f.page.locator('html').getAttribute('lang'), 'es');
    } finally { await f.context.close(); }
});
test('explicit preferences and every on-demand language translate the requested labels and dynamic slots without rewriting user data', async () => {
    const f = await fixture('en-US', 'ja'); try {
        assert.equal(f.requests.length, 1); assert.match(f.requests[0], /ja\.json/);
        const labels = ['邀请协同编辑','编辑文件','位置','审核状态','创建时间','防失联检测','字节','当前分区尚未开放静态资源。','受邀加入','挂载到我的网盘','创建挂载','打开协同项目','移动挂载','移除挂载','创建公开分享','创建分享','开放静态资源','静态链接（目录链接是前缀）','清理缓存','复制/移动','移入回收站','下载','全选','反选','分享所选','退出账号','正在加载文件列表','读取传输记录','发送文本','发送文件','发送网页ZIP','删除记录','全局对讲机发声','群语音通话','我收藏的','已缓存','缓存已清理','已缓存到本机','全部资源','有引用','未引用','缓存缺失','Telegram 渠道'];
        await f.page.evaluate(labels => {
            const sample = document.createElement('section'); sample.id = 'labels';
            for (const key of labels) { const node = document.createElement('p'); node.textContent = key; sample.append(node); }
            const raw = document.createElement('span'); raw.dataset.i18nRaw = 'true'; raw.id = 'raw'; raw.textContent = '设置/名称/设备-254b'; sample.append(raw); document.body.append(sample);
        }, labels);
        for (const [language] of await f.page.evaluate(() => TunnelI18n.languages)) {
            await f.page.evaluate(language => TunnelI18n.setLanguage(language), language);
            await f.page.waitForFunction(labels => [...document.querySelectorAll('#labels p')].every((node, index) => node.textContent === TunnelI18n.t(labels[index])), labels);
            assert.equal(await f.page.locator('#raw').textContent(), '设置/名称/设备-254b');
            const values = await f.page.evaluate(labels => labels.map(key => TunnelI18n.t(key)), labels);
            if (!['zh-Hans','zh-Hant','ja'].includes(language)) for (const value of values) assert.equal(/\p{Script=Han}/u.test(value), false, language + ':' + value);
            const dynamic = await f.page.evaluate(() => [TunnelI18n.t('引用 19'), TunnelI18n.t('4.74 MB（4,975,074 字节）'), TunnelI18n.t('设备 📱 设备-254b 申请编辑“zl5gs创建.html.zip”'), TunnelI18n.t('将所选 2 项及目录中的全部内容移入当前分区回收站，可在回收站顶级列表还原。管理员已删除的占位节点只会移除，不能还原正文。')]);
            assert.ok(dynamic[0].includes('19')); assert.ok(dynamic[1].includes('4,975,074')); assert.ok(dynamic[2].includes('📱 设备-254b')); assert.ok(dynamic[2].includes('zl5gs创建.html.zip'));
            if (!['zh-Hans','zh-Hant','ja'].includes(language)) assert.equal(/\p{Script=Han}/u.test(dynamic[3]), false, language + ':' + dynamic[3]);
        }
        await f.page.evaluate(() => TunnelI18n.setLanguage('ja'));
        assert.equal(await f.page.evaluate(() => TunnelI18n.t('转存到我的网盘')), '自分のドライブに保存');
        assert.equal(await f.page.evaluate(() => TunnelI18n.t('下载')), 'ダウンロード');
        assert.equal(f.requests.length, 13, 'one request per extra language; both Chinese variants are built in');
    } finally { await f.context.close(); }
});
test('the optical continuation page now uses the same runtime and localizes its actual empty states', async () => {
    const f = await fixture('en-US'); try {
        await f.page.goto(base + '/parts'); await f.page.evaluate(() => TunnelI18n.ready);
        assert.equal(await f.page.locator('#tasks .empty').textContent(), 'No partial optical transfers to resume');
        assert.equal(await f.page.locator('#receipts .empty').textContent(), 'No completed optical transfers yet');
        assert.equal(await f.page.locator('.note').evaluate(node => /\p{Script=Han}/u.test(node.textContent)), false);
        assert.ok((await f.page.locator('.note').textContent()).includes('Socket.IO'));
    } finally { await f.context.close(); }
});

test('a failed pack can be retried once without losing preference, concurrent loads coalesce and a later choice wins', async () => {
    const f = await fixture('en-US'); let release; try {
        await f.page.route('**/client/i18n/ja.json?*', route => route.fulfill({ status: 503, body: 'unavailable' }));
        f.page.once('dialog', dialog => dialog.accept());
        assert.equal(await f.page.evaluate(() => TunnelI18n.setLanguage('ja')), false);
        assert.equal(await f.page.locator('#appLanguageSelect').inputValue(), 'ja');
        await f.page.unroute('**/client/i18n/ja.json?*');
        assert.deepEqual(await f.page.evaluate(() => Promise.all([TunnelI18n.setLanguage('ja'),TunnelI18n.setLanguage('ja')])), [true,true]);
        assert.equal(f.requests.filter(url => url.includes('/ja.json')).length, 2);
        const gate = new Promise(resolve => release=resolve);
        await f.page.route('**/client/i18n/fr.json?*', async route => { await gate; await route.continue(); });
        const requested = f.page.waitForRequest(request => request.url().includes('/fr.json'));
        const changing = f.page.evaluate(() => TunnelI18n.setLanguage('fr')); await requested;
        await f.page.evaluate(() => TunnelI18n.setLanguage('en')); release(); await changing;
        assert.equal(await f.page.locator('html').getAttribute('lang'), 'en'); assert.equal(await f.page.locator('#appLanguageSelect').inputValue(), 'en');
        await f.page.evaluate(() => { localStorage.setItem('drop2tunnel.language','ja');localStorage.setItem('drop2tunnel.i18n.ja',JSON.stringify({version:Drop2TunnelI18nConfig.packVersion,language:'ja',catalog:{},templates:[]})); });
        await f.page.reload(); await f.page.evaluate(() => TunnelI18n.ready); assert.equal(await f.page.locator('html').getAttribute('lang'), 'ja');
        assert.equal(f.requests.filter(url => url.includes('/ja.json')).length, 3, 'incomplete cached data is downloaded again');
    } finally { release?.(); await f.context.close(); }
});
