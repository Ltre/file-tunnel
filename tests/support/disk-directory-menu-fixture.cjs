'use strict';
// Browser regression uses the real UI/adapter/upload client with synthetic API data.
// Run: node tests/support/disk-directory-menu-fixture.cjs, then open the printed URL.
const express = require('express'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '../..'), app = express(); app.use(express.json());
const directories = [{ path: '已有目录', name: '已有目录' }], files = [], jobs = [], uploads = new Map();
let report = { status: 'pending' };
app.post('/fixture/reset', (_req, res) => { directories.splice(1); files.splice(0); jobs.splice(0); uploads.clear(); report = { status: 'pending' }; res.json({ ok: true }); });
app.get('/', (_req, res) => {
    let html = fs.readFileSync(path.join(root, 'pages/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    html = html.replace('</body>', '<script src="/client/disk-client.js"></script><script src="/client/disk-ui.js"></script><script src="/client/disk-tunnel-adapter.js"></script><script src="/fixture.js"></script></body>');
    res.type('html').send(html);
});
app.get('/api/telegram/drive/me', (_req, res) => res.json({ identity: { id: 'directory-fixture', name: '本地目录回归' }, enabled: true, configured: true }));
app.get('/api/telegram/drive/list', (req, res) => {
    const current = String(req.query.path || ''), parts = current.split('/').filter(Boolean), localFiles = files.filter(file => file.folderPath === current);
    const folders = directories.filter(folder => folder.path.split('/').slice(0, -1).join('/') === current).map(folder => ({ ...folder, kind: 'directory' }));
    res.json({ path: current, breadcrumbs: parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') })), folders, files: localFiles,
        summary: { folderCount: folders.length, fileCount: localFiles.length, size: localFiles.reduce((sum, file) => sum + file.size, 0) } });
});
app.get('/api/telegram/drive/directories', (_req, res) => res.json({ directories }));
app.get('/api/telegram/drive/directories/properties', (req, res) => res.json({ path: req.query.path || '', name: String(req.query.path || '').split('/').pop() || '根目录', fileCount: 1, folderCount: 1, size: 3 }));
app.post('/api/telegram/drive/directories', (req, res) => {
    const parts = String(req.body.path).replace(/^\/+/, '').split('/').filter(Boolean), current = parts.join('/');
    parts.forEach((name, index) => { const folderPath = parts.slice(0, index + 1).join('/'); if (!directories.some(folder => folder.path === folderPath)) directories.push({ name, path: folderPath }); });
    const job = { operation_id: 'mkdir-' + jobs.length, status: 'completed', type: 'mkdir', phase: 'done', result: { path: current } }; jobs.push(job);
    res.status(202).json({ operation_id: job.operation_id });
});
app.post('/api/telegram/drive/uploads', (req, res) => {
    const id = 'upload-' + uploads.size, job = { operation_id: id, status: 'running', type: 'upload', phase: 'receiving', folderPath: req.body.folderPath, message: '上传测试文件', title: req.body.files[0].name, percent: 0 };
    uploads.set(id, { payload: req.body, job }); jobs.push(job); res.json({ uploadId: id, operation_id: id });
});
app.post('/api/telegram/drive/uploads/:id/phase', (_req, res) => res.json({}));
app.put('/api/telegram/drive/uploads/:id/files/:index', express.raw({ type: '*/*', limit: '1mb' }), (_req, res) => res.json({}));
app.post('/api/telegram/drive/uploads/:id/finish', (req, res) => { uploads.get(req.params.id).finish = res; });
app.get('/api/telegram/drive/operations', (_req, res) => res.json({ operations: jobs }));
app.get('/fixture/status', (_req, res) => res.json({ waiting: [...uploads].filter(([, upload]) => upload.finish).map(([id]) => id) }));
app.post('/fixture/release', (req, res) => {
    const upload = uploads.get(req.body.id), items = upload.payload.files.map((file, index) => ({ ...file, id: req.body.id + '-' + index, kind: 'file', folderPath: upload.payload.folderPath }));
    files.push(...items); Object.assign(upload.job, { status: 'completed', phase: 'done', percent: 100, result: { items } });
    upload.finish.json({ items }); upload.finish = null; res.json({ ok: true });
});
app.get('/report', (_req, res) => res.json(report));
app.post('/report', (req, res) => { report = req.body; console.log(JSON.stringify(report)); res.json({ ok: true }); });
app.use('/client', express.static(path.join(root, 'client')));
app.get('/fixture.js', (_req, res) => res.type('js').send('(' + run.toString() + ')();'));
async function run() {
    const results = [], alerts = [], cache = new Map(), removed = [], linked = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (condition, message) => { if (!condition) throw Error(message); };
    const until = async check => { for (let n = 0; n < 200; n++) { if (await check()) return; await sleep(25); } throw Error('等待 UI 超时'); };
    window.alert = message => alerts.push(message);
    window.TelegramDriveCache = { status: async items => Object.fromEntries(items.map(item => [item.id, cache.has(item.id)])),
        put: async (id, item) => cache.set(id, item), get: async id => cache.get(id), remove: async ids => { removed.push(...ids); ids.forEach(id => cache.delete(id)); } };
    const row = name => [...document.querySelectorAll('#telegramDriveList .telegram-drive-item')].find(el => el.querySelector('.telegram-drive-item-name').textContent === name);
    const menu = () => document.getElementById('telegramDriveItemMenu');
    const openMenu = () => document.getElementById('telegramDriveList').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: innerWidth - 25, clientY: innerHeight - 40 }));
    const choose = async name => {
        const saving = window.DiskTunnelAdapter.save({ id: name });
        await until(() => !document.getElementById('telegramDriveDialog').hidden);
        const input = document.querySelector('#telegramDriveDialogBody input'); input.value = name;
        [...document.querySelectorAll('#telegramDriveDialogBody button')].find(button => button.textContent === '创建多级目录并选中').click();
        await until(() => ![...document.querySelectorAll('#telegramDriveDialogBody button')].find(button => button.textContent === '创建多级目录并选中').disabled);
        [...document.querySelectorAll('#telegramDriveDialogActions button')].find(button => button.textContent === '保存到这里').click();
        let id; await until(async () => { id = (await (await fetch('/fixture/status')).json()).waiting[0]; return id; });
        return { saving, id };
    };
    const release = id => fetch('/fixture/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    try {
        await fetch('/fixture/reset', { method: 'POST' });
        window.DiskUI.init({ showAppToast: message => { console.log(message); } });
        window.DiskTunnelAdapter.configure({ filesForRecord: () => [{ id: 'source', name: '新文件.txt', size: 3, type: 'text/plain' }],
            readFile: async () => new Blob(['abc']), linkBackup: async id => linked.push(id) });
        await window.DiskUI.open();
        const first = await choose('自动定位目录'); await release(first.id); await first.saving;
        assert(window.DiskUI.path === '自动定位目录' && row('新文件.txt'), '保存完成未自动显示新目录与文件'); results.push('新目录上传完成自动定位并显示文件');
        openMenu(); assert([...menu().children].map(button => button.textContent).join('|') === '上传文件|新建目录|当前目录属性|清理本级目录缓存', '空白菜单不完整');
        await until(() => menu().style.left && menu().style.top); const bounds = menu().getBoundingClientRect(); assert(bounds.right <= innerWidth && bounds.bottom <= innerHeight, '菜单溢出屏幕');
        [...menu().children].find(button => button.textContent === '当前目录属性').click();
        await until(() => !document.getElementById('telegramDriveDialog').hidden);
        assert(!document.getElementById('telegramDriveOverlay').hidden && window.DiskUI.path === '自动定位目录', '菜单操作误关网盘或跳目录');
        assert(document.getElementById('telegramDriveDialogTitle').textContent.includes('自动定位目录'), '属性对象不正确');
        history.back(); await until(() => document.getElementById('telegramDriveDialog').hidden); results.push('空白菜单、属性面板及返回不误跳目录');
        openMenu(); [...menu().children].find(button => button.textContent === '清理本级目录缓存').click(); await until(() => removed.length > 0);
        assert(removed.length === 1 && window.DiskUI.path === '自动定位目录' && !document.getElementById('telegramDriveOverlay').hidden, '清理缓存发生错误导航'); results.push('本级缓存清理不误关网盘');
        const list = document.getElementById('telegramDriveList');
        for (const [name, id, x] of [['pointerdown', 701, 80], ['pointerdown', 702, 140], ['pointerup', 701, 80], ['pointerup', 702, 140]]) list.dispatchEvent(new PointerEvent(name, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: id, isPrimary: id === 701, clientX: x, clientY: 150 }));
        assert(!menu().hidden, '空白处双指轻触没有菜单'); history.back(); await until(() => menu().hidden); results.push('双指轻触菜单与返回关闭');
        const second = await choose('不打断浏览目录');
        document.getElementById('diskLoadingBackground').click(); await until(() => document.getElementById('diskLoading').hidden);
        document.querySelector('#telegramDriveBreadcrumbs button').click(); await until(() => window.DiskUI.path === '' && row('已有目录'));
        row('已有目录').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await until(() => window.DiskUI.path === '已有目录');
        await release(second.id); await second.saving; assert(window.DiskUI.path === '已有目录', '上传完成打断用户浏览'); results.push('上传期间切换目录后保持当前目录');
        const third = await choose('后台完成目录');
        document.getElementById('diskLoadingBackground').click(); await until(() => document.getElementById('diskLoading').hidden);
        document.getElementById('minimizeTelegramDriveBtn').click();
        await release(third.id); await third.saving; assert(document.getElementById('telegramDriveOverlay').hidden, '后台完成强制打开网盘');
        await window.DiskUI.open(); assert(window.DiskUI.path === '后台完成目录' && row('新文件.txt'), '恢复网盘未显示后台完成目录'); results.push('最小化完成不抢前台，恢复显示新文件');
        assert(linked.length === 3 && alerts.length === 0, '备用来源关联或错误提示异常：' + alerts.join(','));
        await fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'PASS', results }) });
    } catch (error) { await fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'FAIL', error: error.stack, results, alerts }) }); }
}
const server = app.listen(0, '127.0.0.1', () => console.log('Directory fixture: http://127.0.0.1:' + server.address().port + ' (PID ' + process.pid + ')'));
