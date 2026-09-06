'use strict';
// Manual browser regression fixture. All API data is synthetic and stays local.
// Run: node tests/support/disk-ui-fixture.cjs
const express = require('express'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..'), app = express();
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const topbar = appSource.slice(appSource.indexOf('function initTopbarOverflowScroll()'), appSource.indexOf('\nfunction applyTheme('));
const setup = `
${topbar}
document.getElementById('tunnelTopbar').hidden = false;
const open = document.createElement('button'); open.textContent = '打开测试网盘'; open.id = 'fixtureOpen';
document.querySelector('.tunnel-topbar-group').append(open);
window.DiskUI.init({ formatFileSize: bytes => (bytes / 1000000).toFixed(2) + ' MB' });
initTopbarOverflowScroll();
open.onclick = () => window.DiskUI.open();
`;
app.get('/', (req, res) => {
    let html = fs.readFileSync(path.join(root, 'pages/index.html'), 'utf8');
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    html = html.replace('</body>', '<script src="/client/disk-client.js"></script><script src="/client/disk-ui.js"></script><script src="/fixture-setup.js"></script></body>');
    res.type('html').send(html);
});
app.get('/fixture-setup.js', (req, res) => res.type('js').send(setup));
app.get('/api/telegram/drive/me', (req, res) => res.json({ identity: { id: 'fixture-user', name: '本地测试用户' }, oidcMode: 'mock', enabled: true, configured: true }));
app.get('/api/telegram/drive/list', (req, res) => {
    const folderPath = String(req.query.path || '');
    const parts = folderPath.split('/').filter(Boolean);
    const nextName = '下一层目录以及较长的名称用于验证面包屑完整显示';
    res.json({ path: folderPath, breadcrumbs: parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') })),
        summary: { folderCount: 1, fileCount: 0 }, files: [],
        folders: [{ kind: 'directory', name: nextName, path: [folderPath, nextName].filter(Boolean).join('/'), parentPath: folderPath, folderCount: 1, fileCount: 0 }] });
});
app.get('/api/telegram/drive/operations', (req, res) => res.json({ operations: [1, 2].map(id => ({ operation_id: 'fixture-failed-' + id, type: 'upload', title: '旧的测试错误 ' + id, status: 'failed', phase: 'failed', percent: null, errorCode: 'TELEGRAM_UPLOAD_RESULT_INVALID' })) }));
app.use('/client', express.static(path.join(root, 'client')));
app.listen(3187, '127.0.0.1', () => console.log('Isolated drive fixture: http://127.0.0.1:3187'));
