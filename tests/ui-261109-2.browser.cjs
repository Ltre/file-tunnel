'use strict';
const { test, before, after } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), express = require('express');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
const section = (file, start, end) => { const text = read(file), offset = text.indexOf(start); assert.ok(offset >= 0); const finish = text.indexOf(end, offset); assert.ok(finish > offset); return text.slice(offset, finish); };
let browser, server, base;
before(async () => {
    const app = express(); app.use('/client', express.static(path.join(root, 'client')));
    app.get('/', (_req, res) => res.type('html').send(read('pages/index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace('</head>', '<script defer src="/client/i18n-bootstrap.js"></script><script defer src="/client/i18n.js"></script></head>')));
    app.get('/permissions', (_req, res) => res.sendFile(path.join(root, 'pages/admin-tunnel-permissions.html')));
    app.get('/api/sessions', (_req, res) => res.json([{ id: 'one', shortCode: 'ONE01', lastActivity: 2 }, { id: 'two', shortCode: 'TWO02', lastActivity: 1 }]));
    app.get('/api/sessions/:id/access', (_req, res) => res.json({ knownDevices: [], ownerDeviceId: 'fixture-owner' }));
    app.get('/api/telegram/drive/directories', (_req, res) => res.json({ directories: [] }));
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); });
test('context-menu hover is visible in all seven themes, Orbit audio and exit details are readable', async () => {
    const page = await browser.newPage(); try {
        await page.goto(base); await page.evaluate(() => { document.body.innerHTML = '<div class="telegram-drive-item-menu"><button id="item">Menu</button></div><div id="filePreviewContent"><div class="audio-preview-player"><div class="audio-preview-name">filename.mp3</div></div></div><div class="send-mode-dialog"><div class="blocking-progress-detail">Details</div></div>'; });
        for (const theme of ['classic','atelier','social','lumen','orbit','blamen','lusns']) {
            await page.evaluate(theme => document.body.dataset.theme = theme, theme); await page.mouse.move(1100, 700);
            const before = await page.locator('#item').evaluate(node => getComputedStyle(node).backgroundColor);
            await page.locator('#item').hover(); const after = await page.locator('#item').evaluate(node => getComputedStyle(node).backgroundColor);
            assert.notEqual(before, after, theme + ' menu must react to hover');
        }
        await page.evaluate(() => document.body.dataset.theme = 'orbit');
        const colors = await page.evaluate(() => ({ audio: getComputedStyle(document.querySelector('.audio-preview-name')).color, detail: getComputedStyle(document.querySelector('.blocking-progress-detail')).color, ink: getComputedStyle(document.body).getPropertyValue('--ui-ink').trim(), muted: getComputedStyle(document.body).getPropertyValue('--ui-muted').trim() }));
        const rgb = hex => 'rgb(' + hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16)).join(', ') + ')';
        assert.equal(colors.audio, rgb(colors.ink)); assert.equal(colors.detail, rgb(colors.muted));
    } finally { await page.close(); }
});
test('the real mount directory picker fills its single-field row and localizes the new-folder default without changing typed names', async () => {
    const page = await browser.newPage(); try {
        await page.goto(base); await page.evaluate(() => { document.getElementById('tunnelStartupLoading')?.remove(); const overlay=document.getElementById('telegramDriveOverlay');overlay.hidden=false;overlay.classList.add('active'); }); for (const file of ['disk-directory-picker','disk-mount-ui']) await page.addScriptTag({ url: base + '/client/' + file + '.js' });
        await page.addScriptTag({ content: `let telegramDriveDialogHistoryOpen=false,telegramDriveDialogHistoryClosing=false;const closeTelegramDriveItemMenu=()=>{};function closeTelegramDriveDialog(value){const node=document.getElementById('telegramDriveDialog');node.hidden=true;node._telegramDriveResolver?.(value);} ${section('client/disk-ui.js','function openTelegramDriveDialog(','async function promptTelegramDriveText(')}` });
        for (const language of ['en','ja','fr']) {
            await page.evaluate(language => TunnelI18n.setLanguage(language), language);
            await page.evaluate(() => { DiskMountUI.chooseTarget({ spaces: [{ id: 'p1', name: 'User partition' }], includeName: false, title: '移动挂载到我的网盘', confirmText: '移动挂载', openDialog: openTelegramDriveDialog }); });
            await page.locator('.disk-mount-picker-controls select').waitFor();
            const bounds = await page.locator('.disk-mount-picker-controls select').evaluate(node => { const label=node.parentElement,range=document.createRange();range.selectNode(label.firstChild);return {select:node.getBoundingClientRect().width,label:label.getBoundingClientRect().width,text:range.getBoundingClientRect().width,gap:parseFloat(getComputedStyle(label).columnGap),row:node.closest('.disk-mount-picker-controls').getBoundingClientRect().width}; });
            assert.ok(bounds.label >= bounds.row - 2, JSON.stringify(bounds));
            assert.ok(bounds.select >= bounds.row - bounds.text - bounds.gap - 2, JSON.stringify(bounds));
            await page.getByRole('button', { name: await page.evaluate(() => TunnelI18n.t('在所选目录新建子目录')), exact: true }).click();
            const input = page.locator('.disk-folder-editor input');
            assert.equal(await input.inputValue(), await page.evaluate(() => TunnelI18n.t('新建文件夹')));
            await input.fill('设置/名称'); await page.evaluate(() => TunnelI18n.setLanguage('en')); assert.equal(await input.inputValue(), '设置/名称');
            await page.evaluate(() => closeTelegramDriveDialog(null));
        }
    } finally { await page.close(); }
});
test('real drive properties translate labels and byte units while preserving a name and path equal to system labels', async () => {
    const page = await browser.newPage({ locale: 'en-US' }); try {
        await page.goto(base); await page.evaluate(() => document.body.innerHTML = '<section id="properties"></section>');
        await page.addScriptTag({ content: `const telegramDriveRequest=async()=>({id:'file',name:'设置',folderPath:'名称',type:'text/plain',size:4975074,createdAt:1,updatedAt:2}),telegramDriveDisplayPath=value=>'/'+value,telegramDriveFileType=()=> 'text/plain',formatFileSize=()=> '4.74 MB',telegramDriveFormatDate=()=> '2026-11-10';const openTelegramDriveDialog=async({body})=>document.getElementById('properties').replaceChildren(body);${section('client/disk-ui.js','async function showTelegramDriveProperties(','async function renameTelegramDriveItem(')}showTelegramDriveProperties({kind:'file',id:'file'});` });
        await page.waitForFunction(() => document.querySelectorAll('dt')[1]?.textContent === 'Location');
        assert.equal(await page.locator('dd').nth(0).textContent(), '设置'); assert.equal(await page.locator('dd').nth(1).textContent(), '/名称');
        assert.equal(await page.locator('dd').nth(4).textContent(), '4.74 MB (4,975,074 bytes)');
        await page.evaluate(() => TunnelI18n.setLanguage('ja')); assert.equal(await page.locator('dt').nth(1).textContent(), '場所'); assert.equal(await page.locator('dd').first().textContent(), '设置');
    } finally { await page.close(); }
});
test('admin permissions select a listed deep-link tunnel and only disable the selector for an unlisted manual ID', async () => {
    const page = await browser.newPage(); try {
        await page.goto(base + '/permissions?session=two'); await page.waitForFunction(() => document.getElementById('tunnelAccessStatus').textContent.includes('two'));
        assert.equal(await page.locator('#accessTunnelSelect').inputValue(), 'two'); assert.equal(await page.locator('#accessTunnelId').inputValue(), ''); assert.equal(await page.locator('#accessTunnelSelect').isDisabled(), false);
        await page.goto(base + '/permissions?session=outside'); await page.waitForFunction(() => document.getElementById('tunnelAccessStatus').textContent.includes('outside'));
        assert.equal(await page.locator('#accessTunnelId').inputValue(), 'outside'); assert.equal(await page.locator('#accessTunnelSelect').isDisabled(), true);
        await page.locator('#accessTunnelId').fill('one'); await page.locator('#accessTunnelId').press('Enter');
        await page.waitForFunction(() => document.getElementById('accessTunnelSelect').value === 'one'); assert.equal(await page.locator('#accessTunnelSelect').isDisabled(), false); assert.equal(await page.locator('#accessTunnelId').inputValue(), '');
    } finally { await page.close(); }
});

test('actual collaboration list origin labels and its cancellation warning translate independently of project names', async () => {
    const page = await browser.newPage({ locale: 'en-US' }); try {
        await page.goto(base); await page.evaluate(() => document.body.innerHTML = '<section id="list"></section>');
        await page.addScriptTag({ content: `const refreshDiskCollaborations=async()=>{},telegramDriveCollaborations=[{id:'own',owned:true,diskSpace:'p',name:'设置',kind:'file',path:'名称'},{id:'other',owned:false,name:'名称',kind:'directory',path:'设置'}],telegramDriveSpaces=[{id:'p',name:'设置'}],telegramDriveSpaceKey=space=>space.id,telegramDriveDisplayPath=value=>'/'+value,installContextGesture=()=>{};const openTelegramDriveDialog=async({body})=>document.getElementById('list').replaceChildren(body);${section('client/disk-ui.js','async function showDiskCollaborations(','function openTelegramDriveItem(')}showDiskCollaborations();` });
        await page.waitForFunction(() => document.querySelector('.disk-collaboration-entry span').textContent === 'My creations');
        assert.equal(await page.locator('.is-invited .disk-collaboration-entry span').first().textContent(), 'Joined by invitation');
        for (const language of ['ja','fr','es']) {
            await page.evaluate(language => TunnelI18n.setLanguage(language), language);
            assert.equal(await page.locator('.is-owned .disk-collaboration-entry span').first().textContent(), await page.evaluate(() => TunnelI18n.t('我创建的')));
            assert.ok((await page.locator('.is-owned [data-i18n-raw]').textContent()).includes('设置'));
        }
        await page.evaluate(() => TunnelI18n.setLanguage('ja')); let warning;
        page.once('dialog', async dialog => { warning=dialog.message(); await dialog.dismiss(); });
        await page.locator('.is-owned .disk-collaboration-remove-action').click();
        assert.ok(warning.includes('すべての招待')); assert.ok(warning.includes('设置'));
    } finally { await page.close(); }
});
