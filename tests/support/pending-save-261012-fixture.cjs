'use strict';
// Isolated real drive API, account cookies and UI; synthetic media only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const express = require('express');
const { openDiskRepository } = require('../../server/disk-repository');
const { createDiskAuth } = require('../../server/disk-auth');
const { createDiskAccountSessions } = require('../../server/disk-account-sessions');
const { createDiskOperations } = require('../../server/disk-operations');
const { createDiskAPI } = require('../../server/disk-api');
const { createTelegramDriveStore } = require('../../server/telegram-drive');
async function createFixture() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-save-ui-'));
    const repository = openDiskRepository(dataDir);
    repository.replace('users', [{ id: 'alice', username: 'alice', name: '验收甲账号' }, { id: 'bob', username: 'bob', name: '验收乙账号' }], user => user.id);
    const auth = createDiskAuth({ dataDir }), store = createTelegramDriveStore({ dataDir }), operations = createDiskOperations({ dataDir });
    store.createDirectory('alice', '甲目录/子目录', 30); store.createDirectory('bob', '乙目录/子目录', 30);
    store.putMetadataObject(auth.user('alice'), '甲目录', '甲账号.txt', 'text/plain', {}, 30);
    store.putMetadataObject(auth.user('bob'), '乙目录', '乙账号.txt', 'text/plain', {}, 30);
    let api, sends = 0; const bodies = new Map();
    const sessions = createDiskAccountSessions({ keyForRequest: () => auth.sessionKey, user: id => auth.user(id), isRevoked: value => api.isContentSessionRevoked(value) });
    const telegram = { upload: async (_backend, files) => { sends += files.length; return files.map((file, index) => {
        const fileId = 'fixture-' + Date.now() + '-' + index; bodies.set(fileId, fs.readFileSync(file.path));
        return { fileId, messageId: sends + index, size: file.size };
    }); }, remove: async () => {}, syncCaption: async () => {}, parts: file => file.parts,
        readPart: async (_backend, part, { start, end }) => require('node:stream').Readable.from([(bodies.get(part.fileId) || Buffer.alloc(part.size)).subarray(start, end + 1)]) };
    api = createDiskAPI({ dataDir, auth, defaultStore: store, operations, telegram, getIdentity: req => sessions.identity(req),
        setIdentity: (req, res, user) => sessions.set(req, res, user), getOrigin: req => req.protocol + '://' + req.get('host'), isMockRequest: () => true,
        getDefaultBackend: () => ({ token: 'fixture-no-telegram', channelId: '-1001', baseUrl: 'https://example.invalid' }), maxDepth: () => 30, contentReuseMode: 'off', contentCleanupMode: 'observe' });
    const app = express(), root = path.join(__dirname, '../..'); app.use(express.json()); app.use(express.urlencoded({ extended: false }));
    sessions.registerRoutes(app, { origin: req => req.protocol + '://' + req.get('host'), revoke: req => api.revokeContentSession(req) });
    app.get('/api/telegram/drive/me', (req, res) => res.json({ identity: sessions.identity(req), ...sessions.list(req), enabled: true, configured: true, oidcConfigured: true, oidcMode: 'mock' }));
    app.get('/api/telegram/drive/oidc/start', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><h1>隔离 Mock 登录</h1><p>仅使用测试账号，不连接 Telegram。</p><form method="post" action="/fixture-login"><button name="id" value="alice">登录验收甲账号</button><button name="id" value="bob">登录验收乙账号</button></form>'));
    app.post('/fixture-login', (req, res) => { sessions.set(req, res, auth.user(req.body.id)); res.type('html').send('<!doctype html><meta charset="utf-8"><p>Mock 登录成功</p><script>window.opener?.postMessage({type:"telegram-drive-oidc-result",result:"success"},location.origin);window.close();</script>'); });
    app.use('/api/telegram/drive', api.browser);
    const body = Buffer.from('后台缓存转存验收正文\n'.repeat(350));
    const tasks = ['sns', 'youtube'].map(source => ({ id: source + '-fixture', title: source === 'sns' ? 'SNS 转存验收' : 'YouTube 转存验收', outputFileName: source + '-后台成品.txt',
        completedAt: 1791830400000, createdAt: 1791830300000, outputFileSize: body.length, status: 'completed', hasFile: true, downloadUrl: '/fixture-source/' + source,
        mediaType: 'file', platform: 'x', url: 'https://example.com/watch?v=fixture', referenceInfo: {}, tags: [] }));
    for (const [index, source] of ['sns-dl', 'youtube-premium'].entries()) {
        app.get('/api/' + source + '/tasks', (_req, res) => res.json({ tasks: [tasks[index]], ids: [tasks[index].id], page: 1, pages: 1, total: 1 }));
        app.get('/api/' + source + '/tasks/:id', (_req, res) => res.json(tasks[index]));
    }
    app.get('/fixture-source/:kind', (_req, res) => res.type('text/plain').send(body));
    app.get('/sns-dl', (_req, res) => res.sendFile(path.join(root, 'pages/sns-dl.html')));
    app.get('/fixture-stats', (_req, res) => res.json({ sends, files: api.spaces.entries().flatMap(({ diskSpace, store: drive }) => drive.adminFiles().filter(file => file.metadata?.pendingSaveId).map(file => ({ id: file.id, name: file.name, ownerId: file.ownerId, folderPath: file.folderPath, diskSpace }))) }));
    app.get('/disk', (_req, res) => {
        const scripts = ['cache-store', 'sns-download-cache', 'youtube-premium-cache', 'disk-pending-save', 'disk-error-messages', 'disk-file-editor', 'disk-folder-upload', 'disk-operation-order', 'disk-client', 'disk-directory-picker', 'disk-mount-ui', 'disk-trash-ui', 'disk-import-picker', 'disk-ui'];
        let html = fs.readFileSync(path.join(root, 'pages/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
        html = html.replace('</body>', '<output id="fixtureStatus" style="position:fixed;bottom:0;left:0;z-index:10000;background:white;color:black"></output>' + scripts.map(name => '<script src="/client/' + name + '.js"></script>').join('') + '<script src="/fixture-ui.js"></script></body>');
        res.type('html').send(html);
    });
    app.get('/fixture-ui.js', (_req, res) => res.type('js').send(`document.getElementById('tunnelStartupLoading')?.remove();window.alert=message=>{document.getElementById('fixtureStatus').textContent='错误：'+message;};window.addEventListener('error',event=>{document.getElementById('fixtureStatus').textContent='脚本错误：'+event.message;});window.DiskUI.init({formatFileSize:n=>n+' B',showAppToast:message=>{document.getElementById('fixtureStatus').textContent=message;}});`));
    app.use('/client', express.static(path.join(root, 'client')));
    let server; for (let attempt = 0; attempt < 10; attempt++) {
        server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
        try { await fetch('http://127.0.0.1:' + server.address().port + '/fixture-stats'); break; }
        catch (_) { await new Promise(resolve => server.close(resolve)); server = null; }
    }
    if (!server) throw new Error('TEST_HTTP_PORT_UNAVAILABLE');
    return { dataDir, repository, api, base: 'http://127.0.0.1:' + server.address().port,
        async close() { api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); repository.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
module.exports = { createFixture };
if (require.main === module) createFixture().then(fixture => { console.log(fixture.base + '/sns-dl'); process.once('SIGINT', () => fixture.close().then(() => process.exit())); });
