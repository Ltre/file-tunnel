'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test } = require('node:test');
const { Readable } = require('stream');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const {
    TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
    TELEGRAM_OIDC_TOKEN_ENDPOINT,
    TELEGRAM_OIDC_JWKS_ENDPOINT,
    createTelegramOidcClient
} = require('../server/telegram-oidc');
const { createTelegramOidcMock, isLoopbackAddress, isLoopbackOrigin } = require('../server/telegram-oidc-mock');

test('Telegram 网盘索引按 Telegram 用户隔离、持久化目录并限制 20 层', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-drive-'));
    try {
        const drive = createTelegramDriveStore({ dataDir: dir, maxFileSize: () => 1024 });
        drive.createDirectory('1001', '音乐/现场', 20);
        assert.throws(() => drive.createDirectory('1001', Array.from({ length: 21 }, (_, i) => i).join('/'), 20), /folder-depth/);
        const job = drive.begin({ owner: { id: '1001', name: 'A' }, sessionId: 's', sourceMessageId: 'm', folderPath: '音乐/现场', files: [{ name: 'a.txt', type: 'text/plain', size: 3, sourceAssetId: 'asset-a' }], maxDepth: 20 });
        await drive.receive(job.id, 0, Readable.from([Buffer.from('abc')]));
        const [item] = drive.commit(job.id, '-100', [{ messageId: 11, fileId: 'file-a', fileUniqueId: 'unique-a' }]);
        assert.equal(drive.list('1001', '音乐/现场').files[0].id, item.id);
        assert.equal(drive.list('2002', '音乐/现场').files.length, 0);
        const loaded = createTelegramDriveStore({ dataDir: dir, maxFileSize: () => 1024 });
        assert.equal(loaded.get('1001', item.id).fileId, 'file-a');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Telegram 网盘目录和文件支持多级创建、重命名、移动、属性和递归删除', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-drive-crud-'));
    try {
        const drive = createTelegramDriveStore({ dataDir: dir, maxFileSize: () => 1024 });
        drive.createDirectory('1001', '项目/资料/图片', 20);
        drive.createDirectory('1001', '归档', 20);
        assert.deepEqual(drive.list('1001', '').folders.map(item => item.name).sort(), ['归档', '项目']);
        assert.deepEqual(drive.listDirectories('1001').map(item => item.path), ['归档', '项目', '项目/资料', '项目/资料/图片']);

        const job = drive.begin({ owner: { id: '1001', name: 'A' }, folderPath: '项目/资料/图片', files: [{ name: '旧名称.png', type: 'image/png', size: 3 }], maxDepth: 20 });
        await drive.receive(job.id, 0, Readable.from([Buffer.from('abc')]));
        const [file] = drive.commit(job.id, '-100', [{ messageId: 12, fileId: 'file-image' }]);
        const renamed = drive.renameDirectory('1001', '项目/资料', '文档', 20);
        assert.equal(renamed.path, '项目/文档');
        assert.equal(drive.get('1001', file.id).folderPath, '项目/文档/图片');
        const movedDirectory = drive.moveDirectory('1001', '项目/文档/图片', '归档', 20);
        assert.equal(movedDirectory.path, '归档/图片');
        drive.renameFile('1001', file.id, '新名称.png');
        drive.moveFile('1001', file.id, '', 20);
        assert.equal(drive.get('1001', file.id).name, '新名称.png');
        assert.equal(drive.get('1001', file.id).folderPath, '');
        assert.equal(drive.getDirectory('1001', '').fileCount, 1);
        assert.equal(drive.getDirectory('1001', '').size, 3);
        assert.throws(() => drive.removeDirectory('1001', '归档', false), /folder-not-empty/);
        drive.removeMany('1001', [file.id]);
        const removed = drive.removeDirectory('1001', '归档', true);
        assert.ok(removed.removedDirectories >= 2);

        const loaded = createTelegramDriveStore({ dataDir: dir, maxFileSize: () => 1024 });
        assert.equal(loaded.get('1001', file.id), null);
        assert.equal(loaded.getDirectory('1001', '归档'), null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Telegram 网盘保持独立存储、分区、album、修复与来电取消链路', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const tg = fs.readFileSync(path.join(__dirname, '..', 'pages', 'tgbot.html'), 'utf8');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'server', 'telegram-drive.js'), 'utf8'), /telegram-drive-index\.json/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'server', 'telegram-multipart.js'), 'utf8'), /sendMediaGroup/);
    assert.match(server, /getTelegramDriveUploadLimit/);
    assert.match(server, /app\.patch\('\/api\/telegram\/drive\/directories'/);
    assert.match(server, /app\.delete\('\/api\/telegram\/drive\/files\/:id'/);
    assert.match(server, /app\.post\('\/api\/telegram\/drive\/logout'/);
    assert.match(server, /TELEGRAM_DRIVE_COOKIE/);
    assert.match(server, /telegram-drive-used-channel-double-confirm-required/);
    assert.match(page, /Telegram网盘/);
    assert.match(page, /telegramDriveLogoutBtn/);
    assert.match(page, /telegramDriveBreadcrumbs/);
    assert.match(page, /telegramDriveSearch/);
    assert.match(page, /telegramDriveBatchMoveBtn/);
    assert.match(app, /保存到telegram网盘/);
    assert.match(app, /logoutTelegramDrive/);
    assert.match(app, /createTelegramDriveFolder/);
    assert.match(app, /moveTelegramDriveItems/);
    assert.match(app, /overlay\.classList\.add\('active'\)/);
    assert.match(app, /cache: method === 'GET' \? 'no-store' : 'no-cache'/);
    assert.match(server, /Cache-Control', 'no-store, no-cache, must-revalidate'/);
    assert.match(server, /\/api\/telegram\/drive\/oidc\/start/);
    assert.match(server, /createTelegramOidcMock/);
    assert.match(server, /enabled: process\.env\.TELEGRAM_OIDC_MOCK_ENABLED !== '0'/);
    assert.match(server, /\/api\/telegram\/drive\/oidc\/mock\/authorize/);
    assert.match(server, /flow\.mode === 'mock'/);
    assert.match(server, /codeVerifier: authorization\.codeVerifier/);
    assert.match(server, /verifyIdToken\(tokens\.id_token/);
    assert.match(server, /window\.opener\.postMessage\(payload,targetOrigin\)/);
    assert.match(server, /Cross-Origin-Opener-Policy', 'same-origin-allow-popups'/);
    assert.doesNotMatch(server, /verifyTelegramLoginPayload/);
    assert.doesNotMatch(app, /telegram-widget\.js/);
    assert.match(app, /window\.open\('\/api\/telegram\/drive\/oidc\/start'/);
    assert.match(app, /使用本地 Telegram Mock 登录/);
    assert.match(app, /当前隧道与文件传输不会中断/);
    assert.match(app, /event\.source !== telegramDriveOidcPopup/);
    assert.doesNotMatch(app, /window\.location\.assign\(`\/api\/telegram\/drive\/oidc\/start/);
    assert.match(app, /incoming\.callId === data\?\.callId/);
    assert.match(tg, /网盘专用存储频道/);
    assert.match(tg, /driveChannelDangerConfirmedTwice/);
    assert.match(tg, /Telegram Login OIDC Client ID/);
    assert.match(tg, /\/api\/telegram\/drive\/oidc\/callback/);
    assert.match(tg, /无需向 BotFather 登记 localhost/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'), /TELEGRAM_OIDC_MOCK_ENABLED/);
});

test('Telegram OIDC Mock 只允许已启用的回环请求并仅接收数字用户 ID', () => {
    assert.equal(isLoopbackOrigin('http://localhost:8080'), true);
    assert.equal(isLoopbackOrigin('http://127.0.0.1'), true);
    assert.equal(isLoopbackOrigin('http://[::1]:8080'), true);
    assert.equal(isLoopbackOrigin('https://tun-test.miku.us'), false);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('192.168.1.8'), false);

    const disabled = createTelegramOidcMock({ enabled: false });
    assert.equal(disabled.isAllowed({ publicOrigin: 'http://localhost', remoteAddress: '127.0.0.1' }), false);

    const mock = createTelegramOidcMock({ enabled: true, defaultUserId: '12345678' });
    assert.equal(mock.isAllowed({ publicOrigin: 'http://localhost:8080', remoteAddress: '::1' }), true);
    assert.equal(mock.isAllowed({ publicOrigin: 'https://tun-test.miku.us', remoteAddress: '::1' }), false);
    assert.equal(mock.isAllowed({ publicOrigin: 'http://localhost', remoteAddress: '10.0.0.2' }), false);
    const authorization = mock.createAuthorizationRequest({ publicOrigin: 'http://localhost:8080' });
    assert.equal(new URL(authorization.url).pathname, '/api/telegram/drive/oidc/mock');
    assert.equal(new URL(authorization.url).searchParams.get('state'), authorization.state);
    assert.deepEqual(mock.parseIdentity('99887766'), { id: '99887766', name: '本地 Mock 用户 99887766', username: 'mock_99887766' });
    assert.throws(() => mock.parseIdentity('not-a-user'), /telegram-oidc-mock-user-id-invalid/);
    const html = mock.renderAuthorizationPage({ state: authorization.state });
    assert.match(html, /Telegram User ID/);
    assert.match(html, /12345678/);
    assert.match(html, /不会连接 Telegram/);
});

test('Telegram 网盘登录使用 OIDC Authorization Code、PKCE、nonce 和 JWKS 验签', async () => {
    const now = 1_788_120_000_000;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    Object.assign(jwk, { kid: 'telegram-test-key', alg: 'RS256', use: 'sig' });
    let idToken = '';
    let tokenRequest = null;
    const fakeResponse = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
    const client = createTelegramOidcClient({
        now: () => now,
        fetchImpl: async (url, init = {}) => {
            if (url === TELEGRAM_OIDC_JWKS_ENDPOINT) return fakeResponse(200, { keys: [jwk] });
            if (url === TELEGRAM_OIDC_TOKEN_ENDPOINT) { tokenRequest = init; return fakeResponse(200, { access_token: 'access', id_token: idToken }); }
            throw new Error(`unexpected URL: ${url}`);
        }
    });
    const authorization = client.createAuthorizationRequest({ clientId: '123456789', redirectUri: 'https://example.test/api/telegram/drive/oidc/callback' });
    const authorizationUrl = new URL(authorization.url);
    assert.equal(authorizationUrl.origin + authorizationUrl.pathname, TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT);
    assert.equal(authorizationUrl.searchParams.get('response_type'), 'code');
    assert.equal(authorizationUrl.searchParams.get('scope'), 'openid profile');
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorizationUrl.searchParams.get('code_challenge'));
    assert.equal(authorizationUrl.searchParams.get('nonce'), authorization.nonce);

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({
        iss: 'https://oauth.telegram.org', aud: '123456789', sub: '99887766', id: 99887766,
        name: 'OIDC User', preferred_username: 'oidc_user', nonce: authorization.nonce,
        iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600
    })).toString('base64url');
    const signedContent = `${header}.${claims}`;
    idToken = `${signedContent}.${crypto.sign('RSA-SHA256', Buffer.from(signedContent), privateKey).toString('base64url')}`;

    const tokens = await client.exchangeCode({
        clientId: '123456789', clientSecret: 'client-secret', code: 'authorization-code',
        codeVerifier: authorization.codeVerifier, redirectUri: 'https://example.test/api/telegram/drive/oidc/callback'
    });
    assert.equal(tokenRequest.method, 'POST');
    assert.equal(tokenRequest.headers.Authorization, `Basic ${Buffer.from('123456789:client-secret').toString('base64')}`);
    assert.equal(tokenRequest.body.get('code_verifier'), authorization.codeVerifier);
    const verified = await client.verifyIdToken(tokens.id_token, { clientId: '123456789', nonce: authorization.nonce });
    assert.equal(verified.sub, '99887766');
    await assert.rejects(() => client.verifyIdToken(tokens.id_token, { clientId: '123456789', nonce: 'wrong-nonce' }), /telegram-oidc-nonce-invalid/);
});
