'use strict';
// Isolated real drive API, account cookies and UI; synthetic media only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const express = require('express');
const { openDiskRepository } = require('../../server/disk-repository');
const { createDiskAuth } = require('../../server/disk-auth');
const { createDiskAccountSessions } = require('../../server/disk-account-sessions');
const { createDiskOidcReceipt } = require('../../server/disk-oidc-receipt');
const { createDiskOperations } = require('../../server/disk-operations');
const { createDiskAPI } = require('../../server/disk-api');
const { createTelegramDriveStore } = require('../../server/telegram-drive');
async function createFixture({ serverTransfers = false, listDelayMs = 0, extraUsers = [] } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-save-ui-'));
    const repository = openDiskRepository(dataDir);
    const fixtureUsers = [{ id: 'alice', username: 'alice', name: '验收甲账号' }, { id: 'bob', username: 'bob', name: '验收乙账号' }, ...extraUsers];
    repository.replace('users', fixtureUsers, user => user.id);
    const auth = createDiskAuth({ dataDir }), store = createTelegramDriveStore({ dataDir }), operations = createDiskOperations({ dataDir });
    store.createDirectory('alice', '甲目录/子目录', 30); store.createDirectory('bob', '乙目录/子目录', 30);
    store.putMetadataObject(auth.user('alice'), '甲目录', '甲账号.txt', 'text/plain', {}, 30);
    store.putMetadataObject(auth.user('bob'), '乙目录', '乙账号.txt', 'text/plain', {}, 30);
    let api, sends = 0, browserReads = 0, browserUploads = 0, serverTransfersStarted = 0; const bodies = new Map();
    const sessions = createDiskAccountSessions({ keyForRequest: () => auth.sessionKey, user: id => auth.user(id), isRevoked: value => api.isContentSessionRevoked(value) });
    const receipts = createDiskOidcReceipt({ keyForRequest: () => auth.sessionKey });
    let browserLoginAttempt = '';
    const telegram = { upload: async (_backend, files) => { sends += files.length; return files.map((file, index) => {
        const fileId = 'fixture-' + Date.now() + '-' + index; bodies.set(fileId, fs.readFileSync(file.path));
        return { fileId, messageId: sends + index, size: file.size };
    }); }, remove: async () => {}, syncCaption: async () => {}, parts: file => file.parts,
        readPart: async (_backend, part, { start, end }) => require('node:stream').Readable.from([(bodies.get(part.fileId) || Buffer.alloc(part.size)).subarray(start, end + 1)]) };
    api = createDiskAPI({ dataDir, auth, defaultStore: store, operations, telegram, getIdentity: req => sessions.identity(req),
        ...(serverTransfers ? { resolveTaskSource: require('../../server/download-task-source').createDownloadTaskSource({ isAdmin: () => true,
            services: Object.fromEntries(['sns','youtube'].map(source => [source, { get: id => tasks.find(task => task.id === id && id === source + '-fixture'), getFile: () => ({ path: path.join(dataDir, source + '-output.txt'), name: source + '-后台成品.txt' }) }])) }) } : {}),
        setIdentity: (req, res, user) => sessions.set(req, res, user), getOrigin: req => req.protocol + '://' + req.get('host'), isMockRequest: () => true,
        getDefaultBackend: () => ({ token: 'fixture-no-telegram', channelId: '-1001', baseUrl: 'https://example.invalid' }), maxDepth: () => 30, contentReuseMode: 'off', contentCleanupMode: 'observe' });
    const app = express(), root = path.join(__dirname, '../..'); app.use(express.json()); app.use(express.urlencoded({ extended: false }));
    app.use((req, _res, next) => { if (req.method === 'PUT' && /\/uploads\/[^/]+\/files\//.test(req.path)) browserUploads++; if (req.method === 'POST' && req.path.endsWith('/task-saves')) serverTransfersStarted++; next(); });
    sessions.registerRoutes(app, { origin: req => req.protocol + '://' + req.get('host'), revoke: req => api.revokeContentSession(req) });
    app.get('/api/telegram/drive/me', (req, res) => res.json({ identity: sessions.identity(req), accounts: sessions.list(req), loginAttempt: receipts.get(req, req.query.oidc_attempt), enabled: true, configured: true, oidcConfigured: true, oidcMode: 'mock' }));
    app.get('/api/telegram/drive/oidc/start', (req, res) => { browserLoginAttempt = String(req.query.attempt || browserLoginAttempt).replace(/[^a-zA-Z0-9-]/g, ''); res.type('html').send('<!doctype html><meta charset="utf-8"><h1>隔离 Mock 登录</h1><p>仅使用测试账号，不连接 Telegram。</p><form method="post" action="/fixture-login"><input type="hidden" name="attempt" value="' + browserLoginAttempt + '">' + fixtureUsers.map(user => '<button name="id" value="' + user.id + '">登录' + user.name + '</button>').join('') + '</form>'); });
    app.get('/fixture-mock-login', (_req,res) => res.redirect('/api/telegram/drive/oidc/start?attempt='+encodeURIComponent(browserLoginAttempt)));
    app.post('/fixture-login', (req, res) => { sessions.set(req, res, auth.user(req.body.id)); const message = { type: 'telegram-drive-oidc-result', result: 'success', attemptId: req.body.attempt, accountId: req.body.id }; receipts.record(req, res, { ...message, attemptId: req.body.attempt }); res.type('html').send('<!doctype html><meta charset="utf-8"><p>Mock 登录成功</p><script>window.opener?.postMessage(' + JSON.stringify(message) + ',location.origin);window.close();</script>'); });
    if (listDelayMs) app.get('/api/telegram/drive/list', (_req, _res, next) => setTimeout(next, listDelayMs));
    app.use('/api/telegram/drive', api.browser);
    const body = Buffer.from('后台缓存转存验收正文\n'.repeat(350));
    const tasks = ['sns', 'youtube'].map(source => ({ id: source + '-fixture', title: source === 'sns' ? 'SNS 转存验收' : 'YouTube 转存验收', outputFileName: source + '-后台成品.txt',
        completedAt: 1791830400000, createdAt: 1791830300000, outputFileSize: body.length, status: 'completed', hasFile: true, downloadUrl: '/fixture-source/' + source,
        mediaType: 'file', platform: 'x', url: 'https://example.com/watch?v=fixture', referenceInfo: {}, tags: [] }));
    if (serverTransfers) for (const source of ['sns','youtube']) fs.writeFileSync(path.join(dataDir, source + '-output.txt'), body);
    for (const [index, source] of ['sns-dl', 'youtube-premium'].entries()) {
        app.get('/api/' + source + '/tasks', (_req, res) => res.json({ tasks: [tasks[index]], ids: [tasks[index].id], page: 1, pages: 1, total: 1 }));
        app.get('/api/' + source + '/tasks/:id', (_req, res) => res.json(tasks[index]));
    }
    app.get('/fixture-source/:kind', (_req, res) => { browserReads++; res.type('text/plain').send(body); });
    app.get('/sns-dl', (_req, res) => res.type('html').send(fs.readFileSync(path.join(root, 'pages/sns-dl.html'),'utf8').replace('<head>', serverTransfers ? '<head><script>localStorage.setItem("snsDownloadCacheFiles","0")</script>' : '<head>')));
    app.get('/youtube-premium-dl', (_req, res) => res.type('html').send(fs.readFileSync(path.join(root, 'pages/youtube-premium-dl.html'),'utf8').replace('<head>', '<head><script>localStorage.setItem("youtubePremiumCacheFiles","0")</script>')));
    app.get('/api/youtube-premium/setup-status', (_req,res) => res.json({youtubePremiumCookie:{configured:true}}));
    app.get('/fixture-stats', (_req, res) => res.json({ sends, browserReads, browserUploads, serverTransfersStarted, files: api.spaces.entries().flatMap(({ diskSpace, store: drive }) => drive.adminFiles().filter(file => file.metadata?.pendingSaveId).map(file => ({ id: file.id, name: file.name, ownerId: file.ownerId, folderPath: file.folderPath, diskSpace }))) }));
    app.get('/layout', (req, res) => {
        let html = fs.readFileSync(path.join(root,'pages/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
        if (req.query.before === '1') html = html.replace('href="/client/index.css"','href="/fixture-before.css"');
        const appSource = fs.readFileSync(path.join(root,'app.js'),'utf8'), start = appSource.indexOf('function updateTextInputHeight()'), end = appSource.indexOf('async function sendText()',start);
        html = html.replace('</body>', '<script>' + appSource.slice(start,end) + 'function sendText(){};document.getElementById("tunnelStartupLoading")?.remove();document.getElementById("sessionLanding").hidden=true;document.getElementById("appShell").hidden=false;document.getElementById("textInput").addEventListener("input",updateTextInputHeight);updateTextInputHeight();</script></body>');
        res.type('html').send(html);
    });
    app.get('/fixture-before.css', (_req,res) => res.sendFile(path.join(root,'.npm-cache/261019-2-before.css')));
    app.get('/disk', (_req, res) => {
        const scripts = ['cache-store', 'sns-download-cache', 'youtube-premium-cache', 'disk-pending-save', 'disk-error-messages', 'disk-file-editor', 'disk-folder-upload', 'disk-operation-order', 'disk-client', 'disk-directory-picker', 'disk-mount-ui', 'disk-trash-ui', 'disk-import-picker', 'account-ui', 'disk-ui'];
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
    return { dataDir, repository, api, app, sessions, auth, store, base: 'http://127.0.0.1:' + server.address().port,
        async close() { api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); repository.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
module.exports = { createFixture };
if (require.main === module) createFixture().then(fixture => { console.log(fixture.base + '/sns-dl'); process.once('SIGINT', () => fixture.close().then(() => process.exit())); });
