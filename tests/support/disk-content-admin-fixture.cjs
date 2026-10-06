'use strict';
// Actual admin page/API backed by an isolated SQLite fixture; no live Telegram.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const express = require('express');
const { openDiskRepository } = require('../../server/disk-repository');
const { createDiskAuth } = require('../../server/disk-auth');
const { createTelegramDriveStore } = require('../../server/telegram-drive');
const { createDiskOperations } = require('../../server/disk-operations');
const { createDiskAPI } = require('../../server/disk-api');
async function createFixture() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-admin-'));
    const repository = openDiskRepository(dataDir), content = repository.content;
    repository.replace('users', [
        { id: 'alice', name: '小林', username: 'alice', telegramId: '999000001', provider: 'telegram', passkeys: [{ publicKey: 'DO-NOT-EXPOSE-PASSKEY' }] },
        { id: 'bob', name: '小陈', username: 'bob', provider: 'passkey', passkeys: [{ publicKey: 'DO-NOT-EXPOSE-PASSKEY' }] }
    ], user => user.id);
    repository.replace('spaces', [{ name: '相册&照片' }], space => space.name);
    function file(id, ownerId, name, folderPath, body, messageId) {
        return { id, ownerId, name, folderPath, type: 'application/octet-stream', size: body.length, backendId: '', channelId: '-1001234567890',
            contentSha256: crypto.createHash('sha256').update(body).digest('hex'), createdAt: Date.now(),
            parts: [{ offset: 0, size: body.length, messageId, fileId: 'fixture-file-' + messageId, messageDate: Date.now() }] };
    }
    const shared = Buffer.from('shared-fixture'), records = [
        file('file-a', 'alice', '相同.har', '资料/同名', shared, 101), file('file-b', 'bob', '相同.har', 'backup', shared, 102),
        file('delete-active', 'alice', '清理失败.har', 'gc', Buffer.from('active'), 201),
        file('delete-pending', 'alice', '等待读取结束.har', 'gc', Buffer.from('pending'), 202),
        { ...file('audit-marker', 'alice', '审核占位.har', '', Buffer.from('deleted'), 0), reviewStatus: 'deleted', parts: [] }
    ];
    repository.replace('files', records, file => file.id);
    const photos = [file('file-photo', 'alice', '相同.har', '日本語 & 测试/留档', shared, 103)];
    repository.replace('files', photos, file => file.id, '相册&照片');
    const sharedId = records[0].contentId, deletingId = records[2].contentId, pendingId = records[3].contentId;
    content.lease(pendingId, 'alice', 'fixture-reader', 'read');
    repository.replace('files', records.filter(file => !file.id.startsWith('delete-')), file => file.id);
    const task = content.claimCleanup(Date.now(), deletingId); content.finishCleanup(task, Error('MOCK_TELEGRAM_UNAVAILABLE'));
    let remoteCalls = 0;
    const telegram = { remove: async () => { remoteCalls++; throw Error('NO_REAL_TELEGRAM_IN_FIXTURE'); } };
    const auth = createDiskAuth({ dataDir }), store = createTelegramDriveStore({ dataDir }), operations = createDiskOperations({ dataDir });
    const api = createDiskAPI({ dataDir, defaultStore: store, auth, operations, telegram, getDefaultBackend: () => ({ token: 'fixture-only', channelId: '-1001234567890', baseUrl: 'https://example.test' }),
        getIdentity: () => auth.user('alice'), setIdentity() {}, getOrigin: () => 'http://localhost', isMockRequest: () => true, maxDepth: () => 20, contentCleanupMode: 'observe' });
    const app = express(), root = path.join(__dirname, '../..'); app.use(express.json());
    const admin = (req, res, next) => req.get('X-Test-Admin') === '1' || /(?:^|;\s*)fixture_admin=1(?:;|$)/.test(req.get('Cookie') || '') ? next() : res.status(401).json({ error: 'LOGIN_REQUIRED' });
    app.get('/fixture-login', (_req, res) => { res.cookie('fixture_admin', '1', { httpOnly: true, sameSite: 'strict' }); res.redirect('/disk-management'); });
    app.get('/disk-management', admin, (_req, res) => res.sendFile(path.join(root, 'pages/disk-management.html')));
    app.use('/client', express.static(path.join(root, 'client')));
    app.use('/api/telegram/disk-admin', admin, api.admin); app.use('/api/telegram/drive', api.browser);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    return { dataDir, repository, content, server, api, sharedId, deletingId, pendingId, get remoteCalls() { return remoteCalls; },
        base: 'http://127.0.0.1:' + server.address().port,
        async close() { api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); repository.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
module.exports = { createFixture };
if (require.main === module) createFixture().then(f => {
    console.log('Content admin fixture: ' + f.base + '/fixture-login');
    process.once('SIGINT', () => f.close().then(() => process.exit()));
});
