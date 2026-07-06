/**
 * 即时传输隧道 - Socket.io 服务器 (安全版本)
 * 用于会话管理和信令中转
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { registerFileAssetHandlers, cleanupFileAssetRelays } = require('./server/file-assets');
const { registerMediaHandlers, cleanupMediaDevice } = require('./server/media-session');
const { createInfraStore } = require('./server/infra-store');
const { createAdminAuth } = require('./server/admin-auth');

const app = express();
const PROJECT_CONFIG_PATH = path.join(__dirname, 'tunnel.config.json');
const MANIFEST_HOSTS_PATH = path.join(__dirname, 'manifest.hosts.json');
const SERVER_DATA_DIR = path.join(__dirname, '.tunnel-data');
const TELEGRAM_ASSET_DIR = path.join(SERVER_DATA_DIR, 'telegram-assets');
const TELEGRAM_BOT_CONFIG_PATH = path.join(SERVER_DATA_DIR, 'telegram-bot.json');
const TELEGRAM_CHAT_TUNNELS_PATH = path.join(SERVER_DATA_DIR, 'telegram-chat-tunnels.json');
const LEGACY_SHORT_CODE_STORE_PATH = path.join(SERVER_DATA_DIR, 'short-codes.json');
const projectConfig = loadProjectConfig();
const manifestHostMap = loadManifestHostMap();
let infraStore = null;
const adminAuth = createAdminAuth({ dataDir: SERVER_DATA_DIR, issuer: 'Instant Tunnel Admin' });

// ==================== 安全配置 ====================

const WEB_PORT = Number(projectConfig.serverPort || 80);
const webServer = http.createServer(app);

function splitEnvList(value) {
    return value.split(',').map(item => item.trim()).filter(Boolean);
}

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
    ? splitEnvList(process.env.ALLOWED_ORIGINS)
    : ['*'];

function isAllowedOrigin(origin) {
    if (ALLOWED_ORIGINS.includes('*')) {
        return true;
    }

    return ALLOWED_ORIGINS.includes(origin);
}

// 速率限制配置
const RATE_LIMIT = {
    windowMs: 15 * 60 * 1000, // 15分钟
    max: 1000, // 每个IP最多100个请求
    message: { error: '请求过于频繁，请稍后再试' },
    validate: {
        xForwardedForHeader: false
    }
};
const adminAuthRateLimit = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: { error: 'admin-auth-rate-limited' }
});

// 会话限制
const MAX_SESSIONS = 1000;
const MAX_DEVICES_PER_SESSION = 10;
const MAX_SESSION_AGE = 2 * 60 * 60 * 1000; // 2小时
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB
const MAX_EDITOR_CONTENT_SIZE = 512 * 1024; // Keep editor updates well below Socket.IO's 1MB buffer.
const MAX_EDITOR_ASSET_SIZE = 20 * 1024 * 1024;
const MAX_EDITOR_ASSETS_PER_SESSION = 100;
const MAX_EDITOR_ASSET_RELAY_CHUNK_SIZE = 64 * 1024;
const MAX_HISTORY_MESSAGES = 1000;
const MAX_HISTORY_SIZE = 16 * 1024 * 1024; // metadata-only history window per session
const HISTORY_DEBUG = process.env.HISTORY_DEBUG !== undefined
    ? process.env.HISTORY_DEBUG !== 'false'
    : projectConfig.debugLogsEnabled === true;
const MAX_DEBUG_LOGS = 5000;
const MAX_DEBUG_STRING_LENGTH = 500;
const DEBUG_LOG_TOKEN = process.env.DEBUG_LOG_TOKEN || null;
const TELEGRAM_BOT_DEVICE_ID = '00000000-0000-4000-8000-000000000001';
let telegramConfig = loadTelegramBotConfig();

function normalizeTelegramBotConfig(config = {}) {
    const token = sanitizeString(config.token || '', 260);
    const webhookSecret = sanitizeString(config.webhookSecret || '', 160);
    const maxFileSize = Math.max(1, Number(config.maxFileSize || 500 * 1024 * 1024));
    const backupChatId = sanitizeString(config.backupChatId || '', 120);
    return {
        enabled: Boolean(token),
        token,
        webhookSecret,
        maxFileSize,
        backupChatId
    };
}

function loadTelegramBotConfig() {
    try {
        const raw = fs.readFileSync(TELEGRAM_BOT_CONFIG_PATH, 'utf8');
        return normalizeTelegramBotConfig(JSON.parse(raw));
    } catch {
        return normalizeTelegramBotConfig({});
    }
}

function saveTelegramBotConfig(config) {
    const normalized = normalizeTelegramBotConfig(config);
    fs.mkdirSync(SERVER_DATA_DIR, { recursive: true });
    const tmpPath = `${TELEGRAM_BOT_CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2));
    try {
        fs.renameSync(tmpPath, TELEGRAM_BOT_CONFIG_PATH);
    } catch (err) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
        fs.copyFileSync(tmpPath, TELEGRAM_BOT_CONFIG_PATH);
        try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
    telegramConfig = normalized;
    return normalized;
}

function isTelegramBotEnabled() {
    return telegramConfig.enabled === true && Boolean(telegramConfig.token);
}

function getTelegramBotToken() {
    return telegramConfig.token || '';
}

function getTelegramWebhookSecret() {
    return telegramConfig.webhookSecret || '';
}

function getTelegramMaxFileSize() {
    return Math.max(1, Number(telegramConfig.maxFileSize || 500 * 1024 * 1024));
}

function loadTelegramChatTunnels() {
    try {
        const entries = JSON.parse(fs.readFileSync(TELEGRAM_CHAT_TUNNELS_PATH, 'utf8'));
        return new Map((Array.isArray(entries) ? entries : []).filter(entry =>
            Array.isArray(entry) && entry.length === 2 && entry[0] && entry[1]?.shortCode && entry[1]?.sessionId
        ));
    } catch (_) {
        return new Map();
    }
}

function persistTelegramChatTunnels() {
    fs.mkdirSync(SERVER_DATA_DIR, { recursive: true });
    fs.writeFileSync(TELEGRAM_CHAT_TUNNELS_PATH, JSON.stringify(Array.from(telegramChatTunnels.entries()), null, 2));
}

function loadProjectConfig() {
    try {
        const raw = fs.readFileSync(PROJECT_CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function createDefaultManifest() {
    return {
        name: '即时传输隧道',
        short_name: 'Drop2Tunnel',
        description: '在同一个传输隧道中的设备间发送文件、消息和协同内容。',
        start_url: '/?pwa=1',
        scope: '/',
        display: 'standalone',
        background_color: '#f4f6fb',
        theme_color: '#4f5ec2',
        icons: [
            {
                src: '/tunnel-icon.svg',
                sizes: 'any',
                type: 'image/svg+xml',
                purpose: 'any maskable'
            }
        ],
        share_target: {
            action: '/share/',
            method: 'POST',
            enctype: 'multipart/form-data',
            params: {
                title: 'title',
                text: 'text',
                url: 'url',
                files: [
                    {
                        name: 'shared_file',
                        accept: ['*/*']
                    }
                ]
            }
        }
    };
}

function loadManifestHostMap() {
    try {
        const raw = fs.readFileSync(MANIFEST_HOSTS_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
        console.warn(`Manifest host map unavailable: ${err.message}`);
        return {};
    }
}

function getRequestHostname(req) {
    return String(req.hostname || req.headers.host || '')
        .split(':')[0]
        .trim()
        .toLowerCase();
}

function getManifestForHost(hostname) {
    const manifest = manifestHostMap[hostname] || manifestHostMap.default || createDefaultManifest();
    return JSON.parse(JSON.stringify(manifest));
}

// ==================== Express 中间件 ====================

// 基础安全头
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// 速率限制
app.use(rateLimit(RATE_LIMIT));
app.use(express.json({ limit: '64kb' }));

app.get('/runtime-config.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.type('application/javascript').send(
        `window.TUNNEL_CONFIG=${JSON.stringify({ HISTORY_DEBUG, RTC: projectConfig.rtc || {} })};`
    );
});

app.get('/manifest.webmanifest', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.type('application/manifest+json').send(
        JSON.stringify(getManifestForHost(getRequestHostname(req)), null, 2)
    );
});

app.get('/api/server-assets/:assetId', async (req, res) => {
    const assetId = req.params.assetId;
    const asset = resolveTelegramServerAsset(assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    try {
        await ensureTelegramServerAssetFile(asset);
        const stat = fs.statSync(asset.path);
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Type', asset.type || 'application/octet-stream');
        res.setHeader('Content-Length', String(stat.size));
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(asset.name || 'file')}"`);
        telegramAssetReaders.set(assetId, (telegramAssetReaders.get(assetId) || 0) + 1);
        let released = false;
        const release = completed => {
            if (released) return;
            released = true;
            const readers = Math.max(0, (telegramAssetReaders.get(assetId) || 1) - 1);
            if (readers) telegramAssetReaders.set(assetId, readers);
            else telegramAssetReaders.delete(assetId);
            if (completed && !readers && asset.fileId) removeTelegramAssetTemporaryFile(asset);
        };
        res.once('finish', () => release(true));
        res.once('close', () => release(res.writableFinished));
        fs.createReadStream(asset.path).on('error', err => {
            release(false);
            if (!res.headersSent) res.status(500).json({ error: 'Asset read failed' });
            else res.destroy(err);
        }).pipe(res);
    } catch (err) {
        console.warn(`Telegram asset ${assetId} fetch failed: ${err.message}`);
        if (!res.headersSent) res.status(502).json({ error: 'Telegram asset fetch failed' });
    }
});

app.post('/api/telegram/webhook/:secret?', async (req, res) => {
    if (!isTelegramBotEnabled()) return res.status(404).json({ ok: false, error: 'telegram-bot-disabled' });
    const webhookSecret = getTelegramWebhookSecret();
    const headerSecret = String(req.get('x-telegram-bot-api-secret-token') || '');
    if (webhookSecret && req.params.secret !== webhookSecret && headerSecret !== webhookSecret) {
        return res.status(403).json({ ok: false, error: 'invalid-secret' });
    }
    res.json({ ok: true });
    handleTelegramUpdate(req.body).catch(err => console.error('telegram webhook error:', err));
});
function shouldDisableStaticCache(filePath) {
    return [
        '.html',
        '.js',
        '.webmanifest',
        '.svg'
    ].some(ext => filePath.endsWith(ext));
}

function isPrivateAdminSetupRequest(req) {
    const isPrivateAddress = value => value === '::1' || value === '127.0.0.1' || value.startsWith('10.') ||
        value.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(value);
    const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    const forwarded = String(req.get('cf-connecting-ip') || req.get('x-forwarded-for') || '').split(',')[0].trim();
    const address = isPrivateAddress(remote) && forwarded ? forwarded.replace(/^::ffff:/, '') : remote;
    return isPrivateAddress(address);
}

// 静态文件服务 (限制目录遍历)
function redirectShareEntry(req, res) {
    const route = req.path === '/share/' ? 'share-slash' : 'share';
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.redirect(303, `/?share=1&shareRoute=${route}`);
}

app.get(['/share', '/share/'], redirectShareEntry);
app.post(['/share', '/share/'], redirectShareEntry);

app.get('/admin-auth', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-auth.html'));
});

app.get('/api/admin/auth/status', (req, res) => {
    const authenticated = adminAuth.isAuthenticated(req);
    const configured = adminAuth.isConfigured();
    const setupAllowed = !configured && isPrivateAdminSetupRequest(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        authenticated,
        configured,
        setupAllowed,
        setup: setupAllowed ? adminAuth.getSetup(req.query?.issuer) : undefined
    });
});

app.post('/api/admin/auth/setup', adminAuthRateLimit, (req, res) => {
    if (adminAuth.isConfigured()) return res.status(409).json({ error: 'admin-auth-already-configured' });
    if (!isPrivateAdminSetupRequest(req)) return res.status(403).json({ error: 'admin-auth-setup-local-network-required' });
    if (!adminAuth.finishSetup(req.body?.token, req.body?.issuer)) return res.status(401).json({ error: 'invalid-totp' });
    res.setHeader('Set-Cookie', adminAuth.cookieHeader(req, adminAuth.createSession()));
    res.json({ ok: true });
});

app.post('/api/admin/auth/login', adminAuthRateLimit, (req, res) => {
    if (!adminAuth.isConfigured()) return res.status(409).json({ error: 'admin-auth-setup-required' });
    if (!adminAuth.verifyToken(req.body?.token)) return res.status(401).json({ error: 'invalid-totp' });
    res.setHeader('Set-Cookie', adminAuth.cookieHeader(req, adminAuth.createSession()));
    res.json({ ok: true });
});

app.post('/api/admin/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', adminAuth.cookieHeader(req, '', 0));
    res.json({ ok: true });
});

app.use(['/admin.html', '/tgbot.html'], adminAuth.requireAuth);

app.use(express.static(path.join(__dirname), {
    dotfiles: 'deny',
    index: ['index.html'],
    setHeaders: (res, filePath) => {
        if (shouldDisableStaticCache(filePath)) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        }
    }
}));

// 管理后台API
app.get('/admin', (req, res) => {
    if (!adminAuth.isAuthenticated(req)) return adminAuth.requireAuth(req, res, () => {});
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/tgbot', (req, res) => {
    if (!adminAuth.isAuthenticated(req)) return adminAuth.requireAuth(req, res, () => {});
    res.sendFile(path.join(__dirname, 'tgbot.html'));
});

app.get('/api/telegram/config', adminAuth.requireAuth, (req, res) => {
    const config = loadTelegramBotConfig();
    res.json({
        enabled: config.enabled,
        tokenConfigured: Boolean(config.token),
        tokenPreview: config.token ? `${config.token.slice(0, 8)}...${config.token.slice(-6)}` : '',
        webhookSecretConfigured: Boolean(config.webhookSecret),
        webhookSecretPreview: config.webhookSecret ? `${config.webhookSecret.slice(0, 6)}...${config.webhookSecret.slice(-4)}` : '',
        maxFileSize: config.maxFileSize,
        backupChatId: config.backupChatId || ''
    });
});

app.post('/api/telegram/config', adminAuth.requireAuth, async (req, res) => {
    try {
        const keepExistingToken = req.body?.keepExistingToken === true;
        const token = sanitizeString(req.body?.token || '', 260);
        const currentConfig = loadTelegramBotConfig();
        const finalToken = token || (keepExistingToken ? currentConfig.token : '');
        const webhookSecret = finalToken ? crypto.randomBytes(32).toString('base64url') : '';
        const nextConfig = normalizeTelegramBotConfig({
            token: finalToken,
            webhookSecret,
            maxFileSize: req.body?.maxFileSize || 500 * 1024 * 1024,
            backupChatId: req.body?.backupChatId ?? currentConfig.backupChatId
        });
        let webhookRegistered = false;
        if (nextConfig.enabled) {
            await telegramApi('getMe', {}, nextConfig.token);
            saveTelegramBotConfig(nextConfig);
            const protocol = String(req.get('x-forwarded-proto') || '').split(',')[0].trim() || req.protocol;
            const host = req.get('x-forwarded-host') || req.get('host');
            const webhookUrl = `${protocol}://${host}/api/telegram/webhook/${nextConfig.webhookSecret}`;
            await telegramApi('setWebhook', {
                url: webhookUrl,
                secret_token: nextConfig.webhookSecret,
                allowed_updates: ['message', 'edited_message', 'callback_query'],
                drop_pending_updates: false
            }, nextConfig.token);
            await telegramApi('setMyCommands', {
                commands: [
                    { command: 'tunnel', description: '进入指定的传输隧道中转模式' },
                    { command: 'leave_tunnel', description: '退出当前隧道中转模式' }
                ]
            }, nextConfig.token);
            webhookRegistered = true;
        } else if (currentConfig.token) {
            await telegramApi('deleteWebhook', { drop_pending_updates: false }, currentConfig.token);
            saveTelegramBotConfig(nextConfig);
        } else {
            saveTelegramBotConfig(nextConfig);
        }
        const config = loadTelegramBotConfig();
        telegramConfig = config;
        res.json({
            ok: true,
            enabled: config.enabled,
            tokenConfigured: Boolean(config.token),
            webhookSecretConfigured: Boolean(config.webhookSecret),
            maxFileSize: config.maxFileSize,
            webhookRegistered
        });
    } catch (err) {
        console.error('save telegram config error:', err);
        res.status(500).json({ ok: false, error: 'save-telegram-config-failed' });
    }
});

app.post('/api/telegram/assets/check', async (req, res) => {
    if (!isTelegramBotEnabled()) return res.status(503).json({ error: 'telegram-bot-disabled' });
    const sessionId = sanitizeString(req.body?.sessionId, 80);
    const assetIds = Array.from(new Set(Array.isArray(req.body?.assetIds) ? req.body.assetIds : []))
        .filter(isValidServerAssetId)
        .slice(0, 1000);
    if (!isValidSessionId(sessionId)) return res.status(400).json({ error: 'invalid-session' });
    const results = [];
    for (const assetId of assetIds) {
        const asset = resolveTelegramServerAsset(assetId);
        if (!asset || asset.sessionId !== sessionId) {
            results.push({ assetId, valid: false, repairable: false, reason: 'asset-not-registered' });
            continue;
        }
        if (!asset.fileId) {
            results.push({ assetId, valid: false, repairable: true, reason: 'telegram-file-id-missing' });
            continue;
        }
        try {
            const info = await telegramApi('getFile', { file_id: asset.fileId });
            asset.lastFileIdCheckedAt = Date.now();
            persistTelegramServerAsset(asset);
            results.push({ assetId, valid: Boolean(info?.file_path), repairable: true, checkedAt: asset.lastFileIdCheckedAt });
        } catch (err) {
            results.push({ assetId, valid: false, repairable: true, reason: String(err.message || 'telegram-file-id-invalid').slice(0, 180) });
        }
    }
    res.json({ ok: true, results });
});

app.post('/api/telegram/assets/:assetId/repair', async (req, res) => {
    const assetId = req.params.assetId;
    const sessionId = sanitizeString(req.query?.sessionId, 80);
    const asset = resolveTelegramServerAsset(assetId);
    if (!asset || asset.sessionId !== sessionId) return res.status(404).json({ error: 'asset-not-registered' });
    if (!isTelegramBotEnabled()) return res.status(503).json({ error: 'telegram-bot-disabled' });
    if (!telegramConfig.backupChatId) return res.status(409).json({ error: 'telegram-backup-chat-not-configured' });
    const chunks = [];
    let size = 0;
    const maxSize = getTelegramMaxFileSize();
    try {
        for await (const chunk of req) {
            size += chunk.length;
            if (size > maxSize) return res.status(413).json({ error: 'telegram-file-too-large' });
            chunks.push(chunk);
        }
        const result = await uploadTelegramAssetBackup(asset, Buffer.concat(chunks, size));
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('telegram asset repair error:', err);
        if (!res.headersSent) res.status(502).json({ error: String(err.message || 'telegram-asset-repair-failed').slice(0, 180) });
    }
});

app.get('/downloader', (req, res) => {
    res.sendFile(path.join(__dirname, 'downloader.html'));
});

app.get('/downloadList', (req, res) => {
    res.sendFile(path.join(__dirname, 'downloadList.html'));
});

app.get('/device/:deviceId', (req, res) => {
    if (!isValidDeviceId(req.params.deviceId)) return res.status(400).send('Invalid device id');
    res.sendFile(path.join(__dirname, 'device.html'));
});

app.get('/wasted', (req, res) => {
    const sessionId = sanitizeString(req.query.sessionId || '', 80);
    res.type('html').send(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>传输隧道已删除</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f6fb; color: #24304a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(92vw, 680px); text-align: center; }
    h1 { margin: 0 0 14px; font-size: clamp(1.8rem, 6vw, 3.2rem); }
    p { margin: 0; color: #66718a; font-size: 1rem; line-height: 1.8; word-break: break-all; }
  </style>
</head>
<body><main><h1>这个传输隧道已被删除</h1><p>刚才删除的传输隧道 ID：${sessionId || '未知'}</p></main></body>
</html>`);
});

app.get('/magnet/:magnetId', (req, res) => {
    const magnetId = req.params.magnetId;
    if (!isValidMagnetId(magnetId)) return res.status(400).send('Invalid magnet id');
    res.redirect(`/downloader?magnet=${encodeURIComponent(magnetId)}`);
});

app.post('/api/magnets', (req, res) => {
    try {
        cleanupExpiredMagnets();
        const { sessionId, fileId, deviceId, asset } = req.body || {};
        if (!isValidSessionId(sessionId) || !isValidDeviceId(fileId)) {
            return res.status(400).json({ error: 'Invalid magnet payload' });
        }

        const session = sessions.get(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Session is not online' });
        }

        if (!session.fileAssets) session.fileAssets = new Map();
        let record = session.fileAssets.get(fileId);
        const canRegisterRequester = isValidDeviceId(deviceId) && session.devices.has(deviceId) && deviceSockets.has(deviceId);
        if (!record && canRegisterRequester && isValidMagnetAssetPayload(asset, fileId)) {
            record = createMagnetFileAssetRecord(asset, deviceId);
            session.fileAssets.set(fileId, record);
            historyLog('magnet-file-asset-registered-from-request', {
                sessionId,
                deviceId,
                clientIp: getHttpClientIp(req),
                asset: record.metadata
            });
        } else if (record && canRegisterRequester && (!asset || isValidMagnetAssetPayload(asset, fileId))) {
            record.providers.add(deviceId);
        }

        if (!record) {
            return res.status(404).json({ error: 'File asset is not registered online' });
        }

        const seedDevices = getLiveSeedDevices(session, record);
        if (!seedDevices.length) {
            return res.status(409).json({ error: 'No online seed device for this file' });
        }

        if (magnets.size >= MAX_MAGNETS) cleanupExpiredMagnets();
        if (magnets.size >= MAX_MAGNETS) {
            return res.status(429).json({ error: 'Magnet registry is full' });
        }

        let existingId = null;
        for (const [id, magnet] of magnets) {
            if (magnet.sessionId === sessionId && magnet.assetId === fileId) {
                existingId = id;
                break;
            }
        }

        const id = existingId || createMagnetId();
        const existingMagnet = magnets.get(id);
        const createdByDeviceId = isValidDeviceId(deviceId) ? deviceId : existingMagnet?.createdByDeviceId || null;
        const createdByDevice = createdByDeviceId ? session.devices.get(createdByDeviceId) : null;
        magnets.set(id, {
            id,
            sessionId,
            assetId: fileId,
            asset: record.metadata,
            createdByDeviceId,
            createdByDeviceName: createdByDevice?.deviceName || existingMagnet?.createdByDeviceName || '',
            createdAt: existingMagnet?.createdAt || Date.now()
        });

        const url = `${getRequestBaseUrl(req)}/magnet/${id}`;
        historyLog('magnet-created', {
            sessionId,
            deviceId: createdByDeviceId,
            clientIp: getHttpClientIp(req),
            magnetId: id,
            asset: record.metadata,
            seedDeviceIds: seedDevices.map(seed => seed.deviceId)
        });
        res.json({ id, url, seedDevices, asset: record.metadata });
    } catch (err) {
        console.error('create magnet error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/magnets', adminAuth.requireAuth, (req, res) => {
    try {
        cleanupExpiredMagnets();
        const baseUrl = getRequestBaseUrl(req);
        const items = Array.from(magnets.values())
            .map(magnet => {
                const session = sessions.get(magnet.sessionId);
                const record = session?.fileAssets?.get(magnet.assetId);
                const seedDevices = getLiveSeedDevices(session, record);
                return {
                    id: magnet.id,
                    url: `${baseUrl}/magnet/${magnet.id}`,
                    sessionId: magnet.sessionId,
                    assetId: magnet.assetId,
                    asset: record?.metadata || magnet.asset,
                    createdAt: magnet.createdAt,
                    createdByDeviceId: magnet.createdByDeviceId || '',
                    createdByDeviceName: magnet.createdByDeviceName || '',
                    seedCount: seedDevices.length,
                    seedDevices
                };
            })
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        res.json({ generatedAt: new Date().toISOString(), magnets: items });
    } catch (err) {
        console.error('list magnets error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/magnets/:magnetId', (req, res) => {
    try {
        cleanupExpiredMagnets();
        const { magnetId } = req.params;
        if (!isValidMagnetId(magnetId)) return res.status(400).json({ error: 'Invalid magnet id' });
        const payload = getMagnetPayload(magnetId);
        if (!payload) return res.status(404).json({ error: 'Magnet not found' });
        res.json(payload);
    } catch (err) {
        console.error('get magnet error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API: 获取所有会话信息
app.get('/api/sessions', adminAuth.requireAuth, (req, res) => {
    try {
        const sessionMap = new Map();
        let totalDevices = 0;
        let totalMessages = 0;
        let totalFiles = 0;

        for (const tunnel of infraStore?.listTunnels() || []) {
            const sessionId = tunnel.session_id;
            if (!isValidSessionId(sessionId)) continue;
            sessionMap.set(sessionId, {
                id: sessionId,
                shortCode: tunnel.short_code || '',
                remark: tunnel.remark || '',
                deviceCount: 0,
                createdAt: Number(tunnel.created_at) || Date.now(),
                lastActivity: Number(tunnel.last_activity) || Date.now(),
                isActive: false,
                isOnline: false,
                messageCount: 0,
                fileCount: 0
            });
        }
        
        sessions.forEach((session, sessionId) => {
            totalDevices += session.devices.size;
            const messages = Array.isArray(session.history) ? session.history.map(entry => entry && entry.message).filter(Boolean) : [];
            const messageCount = messages.length;
            const fileCount = messages.reduce((count, message) => {
                if (message.type === 'collection' && Array.isArray(message.collection?.files)) {
                    return count + message.collection.files.length;
                }
                return count + ((message.type === 'file' || message.fileInfo) ? 1 : 0);
            }, 0);
            totalMessages += messageCount;
            totalFiles += fileCount;
            const current = sessionMap.get(sessionId) || {
                id: sessionId,
                createdAt: session.createdAt,
                shortCode: session.shortCode || '',
                remark: session.remark || '',
                messageCount: 0,
                fileCount: 0
            };
            sessionMap.set(sessionId, {
                ...current,
                deviceCount: session.devices.size,
                createdAt: current.createdAt || session.createdAt,
                lastActivity: session.lastActivity,
                remark: session.remark || current.remark || '',
                isActive: Date.now() - session.lastActivity < 5 * 60 * 1000,
                isOnline: session.devices.size > 0,
                messageCount,
                fileCount
            });
        });
        
        const sessionList = Array.from(sessionMap.values());

        // 按最后活动时间排序
        sessionList.sort((a, b) => b.lastActivity - a.lastActivity);
        
        res.json({
            sessions: sessionList,
            totalDevices,
            totalMessages,
            totalFiles
        });
    } catch (err) {
        console.error('API error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/devices', adminAuth.requireAuth, (req, res) => {
    try {
        const now = Date.now();
        const deviceMap = new Map();
        for (const device of infraStore?.listDevices(MAX_ACCESS_DEVICES) || []) {
            const deviceId = device.device_id;
            if (!deviceId) continue;
            deviceMap.set(deviceId, {
                key: deviceId,
                deviceId,
                sessionId: device.session_id || '',
                deviceName: device.device_name || '',
                deviceModel: device.device_model || '',
                localIp: device.local_ip || '',
                externalIp: device.external_ip || '',
                ip: device.ip || device.external_ip || '',
                socketId: device.socket_id || '',
                userAgent: device.user_agent || '',
                firstSeen: Number(device.first_seen) || now,
                lastAccess: Number(device.last_access) || now,
                online: Number(device.online) === 1,
                active: Number(device.active) === 1
            });
        }
        for (const device of accessDevices.values()) {
            if (device.deviceId || device.key) deviceMap.set(device.deviceId || device.key, device);
        }
        const devices = Array.from(deviceMap.values())
            .map(device => ({
                ...device,
                active: device.online === true && now - (device.lastAccess || 0) < 5 * 60 * 1000
            }))
            .sort((a, b) => Number(b.online) - Number(a.online) || (b.lastAccess || 0) - (a.lastAccess || 0));

        res.json({
            generatedAt: new Date().toISOString(),
            totalDevices: devices.length,
            onlineDevices: devices.filter(device => device.online).length,
            activeDevices: devices.filter(device => device.active).length,
            devices
        });
    } catch (err) {
        console.error('devices API error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/devices/:deviceId', (req, res) => {
    try {
        const deviceId = req.params.deviceId;
        if (!isValidDeviceId(deviceId)) {
            return res.status(400).json({ error: 'Invalid device id' });
        }

        const device = getPublicDeviceProfile(deviceId, req);
        if (!device) {
            return res.status(404).json({ error: 'Device not found' });
        }

        res.json({ generatedAt: new Date().toISOString(), device });
    } catch (err) {
        console.error('device profile API error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/sessions/:sessionId', adminAuth.requireAuth, (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        if (!isValidSessionId(sessionId)) {
            return res.status(400).json({ error: 'Invalid session id' });
        }

        const session = sessions.get(sessionId);
        if (!session) {
            deleteShortCodesForSession(sessionId);
            return res.json({ ok: true, deleted: false, reason: 'not-found' });
        }

        deleteShortCodesForSession(sessionId);
        for (const deviceId of session.devices.keys()) {
            const socket = deviceSockets.get(deviceId);
            if (socket) {
                socket.emit('session-deleted', { sessionId });
                deviceSockets.delete(deviceId);
            }
        }
        cleanupFileAssetRelays(sessionId, null);
        for (const key of editorAssetRelays.keys()) {
            if (key.startsWith(`${sessionId}:`)) editorAssetRelays.delete(key);
        }
        for (const [magnetId, magnet] of magnets) {
            if (magnet.sessionId === sessionId) magnets.delete(magnetId);
        }
        sessions.delete(sessionId);
        historyLog('session-deleted-by-admin', {
            sessionId,
            deviceId: null,
            clientIp: getSocketClientIp({ handshake: { headers: req.headers, address: req.ip } })
        });
        res.json({ ok: true, deleted: true });
    } catch (err) {
        console.error('delete session error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/debug-logs', adminAuth.requireAuth, (req, res) => {
    if (DEBUG_LOG_TOKEN && req.get('x-debug-log-token') !== DEBUG_LOG_TOKEN) {
        return res.status(403).json({ error: 'Debug log access denied' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
    const since = Date.parse(req.query.since || '');
    const { sessionId, deviceId, source } = req.query;

    const logs = debugLogs.filter(entry => {
        if (!Number.isNaN(since) && Date.parse(entry.timestamp) < since) return false;
        if (sessionId && entry.sessionId !== sessionId) return false;
        if (deviceId && entry.deviceId !== deviceId) return false;
        if (source && entry.source !== source) return false;
        return true;
    });

    res.json({
        generatedAt: new Date().toISOString(),
        retainedCount: debugLogs.length,
        returnedCount: Math.min(logs.length, limit),
        logs: logs.slice(-limit)
    });
});

// ==================== Socket.io 配置 ====================

app.get('/api/short-codes/:shortCode', (req, res) => {
    const shortCode = normalizeShortCode(req.params.shortCode);
    if (!shortCode) return res.status(400).json({ error: 'Invalid short code' });

    const sessionId = infraStore?.findSessionIdByShortCode(shortCode) || shortCodes.get(shortCode);
    if (!sessionId || !isValidSessionId(sessionId)) {
        deleteShortCode(shortCode);
        return res.status(404).json({ error: 'Short code not found' });
    }

    res.json({ sessionId });
});

const io = new Server(webServer, {
    cors: {
        origin: (origin, callback) => {
            // 允许无origin的请求 (如移动应用)
            if (!origin) return callback(null, true);
            
            if (isAllowedOrigin(origin)) {
                callback(null, true);
            } else {
                console.warn(`CORS blocked: ${origin}`);
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ['GET', 'POST'],
        credentials: true
    },
    // 连接限制
    maxHttpBufferSize: MAX_MESSAGE_SIZE,
    pingTimeout: 60000,
    pingInterval: 25000
});

// ==================== 存储 ====================

const sessions = new Map();
const deviceSockets = new Map();
const ipConnections = new Map(); // IP -> Set<socketId>
const debugLogs = [];
const editorAssetRelays = new Map();
const shortCodes = new Map();
const magnets = new Map();
const accessDevices = new Map();
const nearbyPresence = new Map();
const sessionHistoryBroadcastTimers = new Map();
const telegramPendingFiles = new Map();
const telegramChatTunnels = loadTelegramChatTunnels();
const telegramServerAssets = new Map();
const telegramMediaGroups = new Map();
const telegramProcessedUpdates = new Map();
const telegramAwaitingTunnelCode = new Set();
const telegramAssetDownloads = new Map();
const telegramAssetReaders = new Map();

function nearbyDistanceMeters(left, right) {
    if (!Number.isFinite(left?.latitude) || !Number.isFinite(left?.longitude) ||
        !Number.isFinite(right?.latitude) || !Number.isFinite(right?.longitude)) return null;
    const radians = value => value * Math.PI / 180;
    const dLat = radians(right.latitude - left.latitude);
    const dLon = radians(right.longitude - left.longitude);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function samePrivateSubnet(left, right) {
    const a = String(left || '').split('.');
    const b = String(right || '').split('.');
    const isPrivate = parts => parts.length === 4 && (
        parts[0] === '10' ||
        (parts[0] === '192' && parts[1] === '168') ||
        (parts[0] === '172' && Number(parts[1]) >= 16 && Number(parts[1]) <= 31)
    );
    return isPrivate(a) && isPrivate(b) && a.slice(0, 3).join('.') === b.slice(0, 3).join('.');
}

function getNearbyCandidates(deviceId) {
    const own = nearbyPresence.get(deviceId);
    if (!own) return [];
    const now = Date.now();
    return Array.from(nearbyPresence.values()).filter(candidate => {
        if (candidate.deviceId === deviceId || now - candidate.lastSeen > 70000) return false;
        const distance = nearbyDistanceMeters(own, candidate);
        return distance !== null ? distance <= 10000 :
            (own.externalIp === candidate.externalIp || samePrivateSubnet(own.localIp, candidate.localIp));
    }).map(candidate => {
        const distance = nearbyDistanceMeters(own, candidate);
        return {
            deviceId: candidate.deviceId,
            name: candidate.deviceName,
            model: candidate.deviceModel,
            profileUrl: `/device/${candidate.deviceId}`,
            distanceMeters: distance === null ? null : Math.round(distance),
            discoveryReason: distance !== null ? 'location' : (own.externalIp === candidate.externalIp ? 'same-network' : 'local-subnet'),
            lastSeen: candidate.lastSeen
        };
    }).sort((a, b) => (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER) || b.lastSeen - a.lastSeen).slice(0, 30);
}

function emitNearbyCandidates(deviceId) {
    emitToDevice(deviceId, 'nearby-devices', { devices: getNearbyCandidates(deviceId), generatedAt: Date.now() });
}

function bindSocketToDevice(socket, deviceId) {
    socket.data.deviceId = deviceId;
    deviceSockets.set(deviceId, socket);
}

function getDeviceSockets(deviceId) {
    const sockets = new Map();
    const primary = deviceSockets.get(deviceId);
    if (primary?.connected) sockets.set(primary.id, primary);
    for (const candidate of io.sockets.sockets.values()) {
        if (candidate.connected && candidate.data?.deviceId === deviceId) {
            sockets.set(candidate.id, candidate);
        }
    }
    return Array.from(sockets.values());
}

function emitToDevice(deviceId, eventName, payload) {
    const targets = getDeviceSockets(deviceId);
    targets.forEach(target => target.emit(eventName, payload));
    return targets;
}
const SHORT_CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_MAGNETS = 1000;
const MAX_MAGNET_FILE_ASSET_SIZE = 1024 * 1024 * 1024;
const MAGNET_TTL = 24 * 60 * 60 * 1000;
const MAX_ACCESS_DEVICES = 2000;
const ACCESS_DEVICE_TTL = 7 * 24 * 60 * 60 * 1000;

// ==================== 验证函数 ====================

function sanitizeString(str, maxLength = 100) {
    if (typeof str !== 'string') return '';
    return str.slice(0, maxLength).replace(/[<>"']/g, '');
}

function sanitizeDebugValue(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value.slice(0, MAX_DEBUG_STRING_LENGTH);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth >= 4) return '[max-depth]';

    if (Array.isArray(value)) {
        return value.slice(0, 50).map(item => sanitizeDebugValue(item, depth + 1));
    }

    if (typeof value === 'object') {
        const result = {};
        const sensitiveKeys = new Set(['content', 'data', 'sdp', 'candidate', 'text', 'token', 'password']);

        Object.entries(value).slice(0, 50).forEach(([key, item]) => {
            result[key] = sensitiveKeys.has(key) ? '[redacted]' : sanitizeDebugValue(item, depth + 1);
        });
        return result;
    }

    return String(value).slice(0, MAX_DEBUG_STRING_LENGTH);
}

function recordDebugLog({ source, event, details, sessionId = null, deviceId = null, deviceName = null, socketId = null, clientIp = null, clientTimestamp = null }) {
    const entry = {
        timestamp: new Date().toISOString(),
        source,
        event: sanitizeString(event, 120),
        sessionId,
        deviceId,
        deviceName: deviceName ? sanitizeString(deviceName, 50) : null,
        socketId,
        clientIp,
        clientTimestamp,
        details: sanitizeDebugValue(details || {})
    };

    debugLogs.push(entry);
    if (debugLogs.length > MAX_DEBUG_LOGS) {
        debugLogs.splice(0, debugLogs.length - MAX_DEBUG_LOGS);
    }

    if (HISTORY_DEBUG) {
        console.log(`[debug][${entry.source}][${entry.event}]`, entry);
    }

    return entry;
}

function getSocketClientIp(socket) {
    const headers = socket.handshake.headers || {};
    const forwardedFor = headers['x-forwarded-for'];
    return headers['cf-connecting-ip'] ||
        (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : null) ||
        socket.handshake.address ||
        'unknown';
}

function getHttpClientIp(req) {
    const forwardedFor = req.get('x-forwarded-for');
    return req.get('cf-connecting-ip') ||
        (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : null) ||
        req.ip ||
        'unknown';
}

function isValidSessionId(id) {
    return typeof id === 'string' && 
           /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

function normalizeShortCode(value) {
    const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return /^[A-Z0-9]{5}$/.test(code) ? code : '';
}

function findShortCodeForSession(sessionId) {
    const storedCode = infraStore?.findShortCodeForSession(sessionId);
    if (storedCode) {
        shortCodes.set(storedCode, sessionId);
        return storedCode;
    }
    for (const [code, mappedSessionId] of shortCodes) {
        if (mappedSessionId === sessionId) return code;
    }
    return '';
}

function reserveShortCode(code, sessionId) {
    if (!code || !isValidSessionId(sessionId)) return null;
    const existingSessionId = infraStore?.findSessionIdByShortCode(code) || shortCodes.get(code);
    if (existingSessionId && existingSessionId !== sessionId) return null;
    const existingCode = findShortCodeForSession(sessionId);
    if (existingCode && existingCode !== code) return null;
    const reserved = infraStore?.reserveShortCode(code, sessionId);
    if (!reserved && infraStore) return null;
    shortCodes.set(code, sessionId);
    return code;
}

function createShortCode(sessionId, preferredCode = '') {
    const existingCode = findShortCodeForSession(sessionId);
    if (existingCode) return existingCode;

    const reservedPreferred = reserveShortCode(normalizeShortCode(preferredCode), sessionId);
    if (reservedPreferred) return reservedPreferred;

    for (let attempt = 0; attempt < 100; attempt++) {
        let code = '';
        for (let index = 0; index < 5; index++) {
            code += SHORT_CODE_ALPHABET[Math.floor(Math.random() * SHORT_CODE_ALPHABET.length)];
        }
        if (reserveShortCode(code, sessionId)) return code;
    }
    return null;
}

function deleteShortCodesForSession(sessionId) {
    for (const [code, mappedSessionId] of shortCodes) {
        if (mappedSessionId === sessionId) {
            shortCodes.delete(code);
        }
    }
    infraStore?.deleteTunnel(sessionId);
}

function deleteShortCode(shortCode) {
    const removedFromCache = shortCodes.delete(shortCode);
    infraStore?.deleteShortCode(shortCode);
    return removedFromCache;
}

function hydrateShortCodeCache() {
    shortCodes.clear();
    for (const tunnel of infraStore?.listTunnels() || []) {
        const shortCode = normalizeShortCode(tunnel.short_code);
        if (shortCode && isValidSessionId(tunnel.session_id)) {
            shortCodes.set(shortCode, tunnel.session_id);
        }
    }
}

function migrateLegacyShortCodeStore() {
    if (!infraStore || !fs.existsSync(LEGACY_SHORT_CODE_STORE_PATH)) return;
    try {
        const raw = fs.readFileSync(LEGACY_SHORT_CODE_STORE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const entries = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? Object.entries(parsed)
            : [];
        let migrated = 0;
        for (const [code, sessionId] of entries) {
            const shortCode = normalizeShortCode(code);
            if (!shortCode || !isValidSessionId(sessionId)) continue;
            if (infraStore.reserveShortCode(shortCode, sessionId)) migrated++;
        }
        const migratedPath = `${LEGACY_SHORT_CODE_STORE_PATH}.migrated`;
        fs.renameSync(LEGACY_SHORT_CODE_STORE_PATH, migratedPath);
        console.log(`Migrated ${migrated} legacy short codes to SQLite`);
    } catch (err) {
        console.error('Failed to migrate legacy short code store:', err);
    }
}

function createMagnetId() {
    return crypto.randomBytes(12).toString('base64url');
}

function isValidMagnetId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{12,64}$/.test(id);
}

function createServerAssetId() {
    return crypto.randomBytes(16).toString('base64url');
}

function isValidServerAssetId(assetId) {
    return typeof assetId === 'string' && /^[a-zA-Z0-9_-]{12,64}$/.test(assetId);
}

function getTelegramAssetMetadataPath(assetId) {
    return path.join(TELEGRAM_ASSET_DIR, `${assetId}.json`);
}

function persistTelegramServerAsset(asset) {
    telegramServerAssets.set(asset.id, asset);
    fs.writeFileSync(getTelegramAssetMetadataPath(asset.id), JSON.stringify({
        id: asset.id,
        name: asset.name,
        type: asset.type,
        size: asset.size,
        sessionId: asset.sessionId,
        createdAt: asset.createdAt,
        fileId: asset.fileId || '',
        fileUniqueId: asset.fileUniqueId || '',
        fileIdUpdatedAt: Number(asset.fileIdUpdatedAt) || 0,
        lastFileIdCheckedAt: Number(asset.lastFileIdCheckedAt) || 0,
        fileIdHistory: Array.isArray(asset.fileIdHistory) ? asset.fileIdHistory.slice(-20) : []
    }));
}

function resolveTelegramServerAsset(assetId) {
    if (!isValidServerAssetId(assetId)) return null;
    const cached = telegramServerAssets.get(assetId);
    if (cached && (cached.fileId || fs.existsSync(cached.path))) return cached;

    const assetPath = path.join(TELEGRAM_ASSET_DIR, assetId);
    let metadata = {};
    try {
        metadata = JSON.parse(fs.readFileSync(getTelegramAssetMetadataPath(assetId), 'utf8'));
    } catch (_) {
        // Assets created before metadata persistence remain downloadable.
    }
    const hasFile = fs.existsSync(assetPath) && fs.statSync(assetPath).isFile();
    if (!hasFile && !metadata.fileId) return null;
    const stat = hasFile ? fs.statSync(assetPath) : null;
    const asset = {
        id: assetId,
        path: assetPath,
        name: sanitizeString(metadata.name || assetId, 180) || assetId,
        type: sanitizeString(metadata.type || 'application/octet-stream', 100) || 'application/octet-stream',
        size: Number(metadata.size) || stat?.size || 0,
        sessionId: isValidSessionId(metadata.sessionId) ? metadata.sessionId : '',
        createdAt: Number(metadata.createdAt) || stat?.birthtimeMs || stat?.mtimeMs || Date.now(),
        fileId: typeof metadata.fileId === 'string' ? metadata.fileId : '',
        fileUniqueId: typeof metadata.fileUniqueId === 'string' ? metadata.fileUniqueId : '',
        fileIdUpdatedAt: Number(metadata.fileIdUpdatedAt) || 0,
        lastFileIdCheckedAt: Number(metadata.lastFileIdCheckedAt) || 0,
        fileIdHistory: Array.isArray(metadata.fileIdHistory) ? metadata.fileIdHistory.slice(-20) : []
    };
    telegramServerAssets.set(assetId, asset);
    return asset;
}

async function ensureTelegramServerAssetFile(asset) {
    if (fs.existsSync(asset.path)) return asset.path;
    if (!asset.fileId) throw new Error('telegram-file-source-missing');
    let download = telegramAssetDownloads.get(asset.id);
    if (!download) {
        download = (async () => {
            const data = await downloadTelegramFile(asset.fileId, getTelegramMaxFileSize());
            fs.mkdirSync(TELEGRAM_ASSET_DIR, { recursive: true });
            fs.writeFileSync(asset.path, data);
            asset.size = data.length;
            persistTelegramServerAsset(asset);
            return asset.path;
        })().finally(() => telegramAssetDownloads.delete(asset.id));
        telegramAssetDownloads.set(asset.id, download);
    }
    return download;
}

function removeTelegramAssetTemporaryFile(asset) {
    try {
        if (fs.existsSync(asset.path)) fs.unlinkSync(asset.path);
    } catch (err) {
        console.warn(`Unable to remove Telegram temporary asset ${asset.id}: ${err.message}`);
    }
}

function hydrateTelegramServerAssets() {
    fs.mkdirSync(TELEGRAM_ASSET_DIR, { recursive: true });
    let restored = 0;
    for (const entry of fs.readdirSync(TELEGRAM_ASSET_DIR, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const assetId = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : entry.name;
        if (!telegramServerAssets.has(assetId) && resolveTelegramServerAsset(assetId)) restored += 1;
    }
    if (restored) console.log(`Restored ${restored} Telegram server assets from disk`);
}

function extractShortCodeFromText(text) {
    const match = String(text || '').toUpperCase().match(/\b[A-Z0-9]{5}\b/);
    return match ? match[0] : '';
}

function escapeHtmlServer(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function extractTunnelCommandShortCode(text) {
    const match = String(text || '').trim().match(/^\/tunnel(?:@\w+)?\s+([A-Za-z0-9]{5})\b/i);
    return match ? normalizeShortCode(match[1]) : '';
}

function isLeaveTunnelCommand(text) {
    return /^\/leave_tunnel(?:@\w+)?(?:\s|$)/i.test(String(text || '').trim());
}

function getTelegramTextPayload(message = {}) {
    if (typeof message.text === 'string') {
        return {
            text: message.text,
            entities: Array.isArray(message.entities) ? message.entities : []
        };
    }
    if (typeof message.caption === 'string') {
        return {
            text: message.caption,
            entities: Array.isArray(message.caption_entities) ? message.caption_entities : []
        };
    }
    return { text: '', entities: [] };
}

function telegramEntityTags(entity, rawText) {
    const type = entity?.type;
    if (type === 'bold') return ['<strong>', '</strong>'];
    if (type === 'italic') return ['<em>', '</em>'];
    if (type === 'underline') return ['<u>', '</u>'];
    if (type === 'strikethrough') return ['<s>', '</s>'];
    if (type === 'spoiler') return ['<span class="telegram-spoiler">', '</span>'];
    if (type === 'code') return ['<code>', '</code>'];
    if (type === 'pre') return ['<pre>', '</pre>'];
    if (type === 'text_link' && entity.url) {
        const url = escapeHtmlServer(entity.url).replace(/[\r\n]/g, '');
        return [`<a href="${url}" target="_blank" rel="noopener">`, '</a>'];
    }
    if (type === 'url') {
        const url = rawText.slice(entity.offset, entity.offset + entity.length);
        const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        return [`<a href="${escapeHtmlServer(href)}" target="_blank" rel="noopener">`, '</a>'];
    }
    return ['', ''];
}

function telegramTextToHtml(text, entities = []) {
    const raw = String(text || '');
    const opens = new Map();
    const closes = new Map();
    entities
        .filter(entity => entity && entity.type !== 'bot_command' && Number(entity.length) > 0)
        .forEach(entity => {
            const start = Math.max(0, Number(entity.offset) || 0);
            const end = Math.min(raw.length, start + (Number(entity.length) || 0));
            if (end <= start) return;
            const [open, close] = telegramEntityTags(entity, raw);
            if (!open && !close) return;
            if (!opens.has(start)) opens.set(start, []);
            if (!closes.has(end)) closes.set(end, []);
            opens.get(start).push(open);
            closes.get(end).unshift(close);
        });
    let html = '';
    for (let i = 0; i <= raw.length; i++) {
        if (closes.has(i)) html += closes.get(i).join('');
        if (opens.has(i)) html += opens.get(i).join('');
        if (i < raw.length) html += escapeHtmlServer(raw[i]).replace(/\n/g, '<br>');
    }
    return html;
}

function getTelegramFileFromMessage(message = {}) {
    const remark = String(message.caption || '').trim().slice(0, 500);
    if (message.document) {
        return {
            fileId: message.document.file_id,
            fileUniqueId: message.document.file_unique_id || '',
            name: message.document.file_name || 'telegram-file',
            type: message.document.mime_type || 'application/octet-stream',
            size: Number(message.document.file_size) || 0,
            remark
        };
    }
    if (message.video) {
        return {
            fileId: message.video.file_id,
            fileUniqueId: message.video.file_unique_id || '',
            name: message.video.file_name || `telegram-video-${Date.now()}.mp4`,
            type: message.video.mime_type || 'video/mp4',
            size: Number(message.video.file_size) || 0,
            remark
        };
    }
    if (message.animation) {
        return {
            fileId: message.animation.file_id,
            fileUniqueId: message.animation.file_unique_id || '',
            name: message.animation.file_name || `telegram-animation-${Date.now()}.mp4`,
            type: message.animation.mime_type || 'video/mp4',
            size: Number(message.animation.file_size) || 0,
            remark
        };
    }
    if (message.audio) {
        return {
            fileId: message.audio.file_id,
            fileUniqueId: message.audio.file_unique_id || '',
            name: message.audio.file_name || `telegram-audio-${Date.now()}.mp3`,
            type: message.audio.mime_type || 'audio/mpeg',
            size: Number(message.audio.file_size) || 0,
            remark
        };
    }
    if (message.voice) {
        return {
            fileId: message.voice.file_id,
            fileUniqueId: message.voice.file_unique_id || '',
            name: `telegram-voice-${Date.now()}.ogg`,
            type: message.voice.mime_type || 'audio/ogg',
            size: Number(message.voice.file_size) || 0,
            remark
        };
    }
    if (message.video_note) {
        return {
            fileId: message.video_note.file_id,
            fileUniqueId: message.video_note.file_unique_id || '',
            name: `telegram-video-note-${Date.now()}.mp4`,
            type: 'video/mp4',
            size: Number(message.video_note.file_size) || 0,
            remark
        };
    }
    if (Array.isArray(message.photo) && message.photo.length) {
        const photo = message.photo[message.photo.length - 1];
        return {
            fileId: photo.file_id,
            fileUniqueId: photo.file_unique_id || '',
            name: `telegram-photo-${Date.now()}.jpg`,
            type: 'image/jpeg',
            size: Number(photo.file_size) || 0,
            remark
        };
    }
    return null;
}

async function publishTelegramPending(chatId, shortCode, pending) {
    if (!pending) return false;
    if (pending.kind === 'text') return publishTelegramTextToTunnel(chatId, shortCode, pending.textPayload);
    const files = Array.isArray(pending.files) ? pending.files : (pending.file ? [pending.file] : []);
    if (files.length > 1) return publishTelegramCollectionToTunnel(chatId, shortCode, files, pending.remark || '');
    if (files.length === 1) return publishTelegramFileToTunnel(chatId, shortCode, files[0]);
    return false;
}

async function bindTelegramTunnel(chatId, shortCode) {
    const sessionId = infraStore?.findSessionIdByShortCode(shortCode) || shortCodes.get(shortCode);
    if (!sessionId || !isValidSessionId(sessionId)) {
        await telegramSendMessage(chatId, '没有找到这个隧道暗号，请确认 5 位暗号是否正确。');
        return false;
    }
    telegramChatTunnels.set(String(chatId), { shortCode, sessionId, updatedAt: Date.now() });
    persistTelegramChatTunnels();
    await telegramSendMessage(chatId, `当前处于 ${shortCode} 隧道中转模式，直接发送任何内容，将转发到此隧道。`, telegramBoundKeyboard(shortCode));
    const pending = telegramPendingFiles.get(String(chatId));
    if (pending) {
        telegramPendingFiles.delete(String(chatId));
        await publishTelegramPending(chatId, shortCode, pending);
    }
    return true;
}

function getTelegramCollectionRemark(message = {}) {
    const caption = String(message.caption || '').trim();
    return caption.slice(0, 500);
}

function queueTelegramMediaGroup(chatId, message, file, targetShortCode) {
    const key = `${chatId}:${message.media_group_id}`;
    let group = telegramMediaGroups.get(key);
    if (!group) {
        group = { chatId, files: [], targetShortCode: '', remark: '', timer: null, createdAt: Date.now() };
        telegramMediaGroups.set(key, group);
    }
    group.files.push({ ...file, telegramMessageId: Number(message.message_id) || 0 });
    if (targetShortCode) group.targetShortCode = targetShortCode;
    const remark = getTelegramCollectionRemark(message);
    if (remark && !group.remark) group.remark = remark;
    clearTimeout(group.timer);
    group.timer = setTimeout(async () => {
        telegramMediaGroups.delete(key);
        try {
            group.files.sort((left, right) => left.telegramMessageId - right.telegramMessageId);
            if (group.targetShortCode) {
                await publishTelegramCollectionToTunnel(chatId, group.targetShortCode, group.files, group.remark);
            } else {
                telegramPendingFiles.set(String(chatId), { kind: 'files', files: group.files, remark: group.remark, createdAt: Date.now() });
                await promptTelegramShortCode(chatId);
            }
        } catch (err) {
            console.error('telegram media group error:', err);
            await telegramSendMessage(chatId, '媒体合辑处理失败，请稍后重试。');
        }
    }, 2200);
}

async function handleTelegramUpdate(update = {}) {
    const updateId = Number(update.update_id);
    if (Number.isFinite(updateId)) {
        if (telegramProcessedUpdates.has(updateId)) return;
        telegramProcessedUpdates.set(updateId, Date.now());
        const expiresBefore = Date.now() - 10 * 60 * 1000;
        for (const [id, seenAt] of telegramProcessedUpdates) if (seenAt < expiresBefore) telegramProcessedUpdates.delete(id);
    }
    const callback = update.callback_query;
    if (callback) {
        if (callback.data === 'cancel_pending') telegramPendingFiles.delete(String(callback.message?.chat?.id || callback.from?.id));
        await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: '已放弃发送' });
        return;
    }
    const message = update.message || update.edited_message;
    const chatId = message?.chat?.id;
    if (!chatId) return;
    const chatKey = String(chatId);
    const textPayload = getTelegramTextPayload(message);
    const text = textPayload.text || '';
    const trimmed = text.trim();
    if (trimmed === '放弃发送') {
        telegramPendingFiles.delete(chatKey);
        telegramAwaitingTunnelCode.delete(chatKey);
        await telegramSendMessage(chatId, '已放弃待发送内容。', { remove_keyboard: true });
        return;
    }
    if (isLeaveTunnelCommand(text)) {
        const hadTunnel = telegramChatTunnels.delete(chatKey);
        if (hadTunnel) persistTelegramChatTunnels();
        telegramPendingFiles.delete(chatKey);
        telegramAwaitingTunnelCode.delete(chatKey);
        await telegramSendMessage(chatId, hadTunnel ? '已离开隧道中转模式。' : '当前不在隧道中转模式。', { remove_keyboard: true });
        return;
    }
    if (/^\/tunnel(?:@\w+)?\s*$/i.test(trimmed)) {
        telegramAwaitingTunnelCode.add(chatKey);
        await telegramSendMessage(chatId, '请输入 5 位隧道暗号。', { force_reply: true, input_field_placeholder: '输入 5 位隧道暗号' });
        return;
    }
    const commandCode = extractTunnelCommandShortCode(text);
    if (commandCode) {
        telegramAwaitingTunnelCode.delete(chatKey);
        await bindTelegramTunnel(chatId, commandCode);
        return;
    }
    let boundTunnel = telegramChatTunnels.get(chatKey);
    if (boundTunnel) {
        const activeSessionId = infraStore?.findSessionIdByShortCode(boundTunnel.shortCode) || shortCodes.get(boundTunnel.shortCode);
        if (!activeSessionId || activeSessionId !== boundTunnel.sessionId) {
            telegramChatTunnels.delete(chatKey);
            persistTelegramChatTunnels();
            boundTunnel = null;
            await telegramSendMessage(chatId, '此前绑定的隧道已失效，已自动退出中转模式。请重新使用 /tunnel 进入有效隧道。', { remove_keyboard: true });
        }
    }
    const extractedCode = boundTunnel ? '' : extractShortCodeFromText(text);
    const extractedSessionId = extractedCode && (infraStore?.findSessionIdByShortCode(extractedCode) || shortCodes.get(extractedCode));
    const captionCode = extractedSessionId && isValidSessionId(extractedSessionId) ? extractedCode : '';
    const pending = telegramPendingFiles.get(chatKey);
    if (telegramAwaitingTunnelCode.has(chatKey) && /^[A-Z0-9]{5}$/i.test(trimmed)) {
        telegramAwaitingTunnelCode.delete(chatKey);
        await bindTelegramTunnel(chatId, normalizeShortCode(trimmed));
        return;
    }
    if (pending && /^[A-Z0-9]{5}$/i.test(trimmed)) {
        telegramPendingFiles.delete(chatKey);
        const published = await publishTelegramPending(chatId, normalizeShortCode(trimmed), pending);
        if (published) {
            telegramAwaitingTunnelCode.delete(chatKey);
            await telegramSendMessage(chatId, '待发送内容已处理完成。', { remove_keyboard: true });
        }
        return;
    }
    const telegramFile = getTelegramFileFromMessage(message);
    const targetShortCode = boundTunnel?.shortCode || captionCode || '';
    if (telegramFile && message.media_group_id) {
        queueTelegramMediaGroup(chatId, message, telegramFile, targetShortCode);
        return;
    }
    if (telegramFile) {
        if (targetShortCode) await publishTelegramFileToTunnel(chatId, targetShortCode, telegramFile);
        else {
            telegramPendingFiles.set(chatKey, { kind: 'files', files: [telegramFile], createdAt: Date.now() });
            await promptTelegramShortCode(chatId);
        }
        return;
    }
    if (boundTunnel?.shortCode && trimmed) {
        await publishTelegramTextToTunnel(chatId, boundTunnel.shortCode, textPayload);
        return;
    }
    if (trimmed && !trimmed.startsWith('/')) {
        telegramPendingFiles.set(chatKey, { kind: 'text', textPayload, createdAt: Date.now() });
        await promptTelegramShortCode(chatId);
    }
}

async function telegramApi(method, payload, token = getTelegramBotToken()) {
    if (!token) throw new Error('telegram-bot-disabled');
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
        throw new Error(result.description || `telegram-${method}-failed`);
    }
    return result.result;
}

async function uploadTelegramAssetBackup(asset, data) {
    if (!data?.length) throw new Error('repair-file-content-empty');
    const form = new FormData();
    form.set('chat_id', telegramConfig.backupChatId);
    form.set('caption', `Drop2Tunnel backup · ${asset.id}`);
    form.set('document', new Blob([data], { type: asset.type || 'application/octet-stream' }), asset.name || 'file');
    const response = await fetch(`https://api.telegram.org/bot${getTelegramBotToken()}/sendDocument`, {
        method: 'POST',
        body: form
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.description || `telegram-sendDocument-${response.status}`);
    const document = payload.result?.document;
    if (!document?.file_id) throw new Error('telegram-repair-file-id-missing');
    const updatedAt = Date.now();
    const previousFileId = asset.fileId || '';
    asset.fileIdHistory = [
        ...(Array.isArray(asset.fileIdHistory) ? asset.fileIdHistory : []),
        ...(previousFileId ? [{ fileId: previousFileId, fileUniqueId: asset.fileUniqueId || '', replacedAt: updatedAt, reason: 'rotated-by-current-bot' }] : [])
    ].slice(-20);
    asset.fileId = document.file_id;
    asset.fileUniqueId = document.file_unique_id || '';
    asset.fileIdUpdatedAt = updatedAt;
    asset.lastFileIdCheckedAt = updatedAt;
    persistTelegramServerAsset(asset);
    updateTelegramAssetMetadataInSession(asset);
    return {
        assetId: asset.id,
        telegramFileId: asset.fileId,
        telegramFileUniqueId: asset.fileUniqueId,
        telegramFileIdUpdatedAt: updatedAt
    };
}

function updateTelegramAssetMetadataInSession(asset) {
    const session = sessions.get(asset.sessionId);
    if (!session) return;
    for (let index = 0; index < session.history.length; index++) {
        const previous = session.history[index];
        const message = previous.message;
        let changed = false;
        const patch = fileInfo => {
            if (!fileInfo || fileInfo.id !== asset.id) return;
            fileInfo.telegramFileId = asset.fileId;
            fileInfo.telegramFileUniqueId = asset.fileUniqueId;
            fileInfo.telegramFileIdUpdatedAt = asset.fileIdUpdatedAt;
            fileInfo.serverAssetUrl = `/api/server-assets/${asset.id}`;
            fileInfo.isServerAsset = true;
            changed = true;
        };
        patch(message.fileInfo);
        if (message.type === 'collection') message.collection?.files?.forEach(patch);
        if (!changed) continue;
        const historyMessage = createHistoryMessage(message);
        const size = Buffer.byteLength(JSON.stringify(historyMessage), 'utf8');
        session.history[index] = { message: historyMessage, size };
        session.historySize = Math.max(0, session.historySize - previous.size + size);
        io.to(asset.sessionId).emit('message-updated', { message: historyMessage });
    }
    scheduleSessionHistoryBroadcast(asset.sessionId, 'telegram-file-id-repaired');
}

async function telegramSendMessage(chatId, text, replyMarkup = undefined) {
    if (!chatId || !isTelegramBotEnabled()) return;
    await telegramApi('sendMessage', { chat_id: chatId, text, reply_markup: replyMarkup }).catch(err => {
        console.warn(`telegram sendMessage failed: ${err.message}`);
    });
}

function telegramUnboundKeyboard() {
    return {
        keyboard: [[{ text: '放弃发送' }]],
        resize_keyboard: true,
        one_time_keyboard: false,
        input_field_placeholder: '请输入 5 位隧道暗号'
    };
}

function telegramBoundKeyboard(shortCode) {
    return {
        keyboard: [[{ text: '/leave_tunnel' }]],
        resize_keyboard: true,
        is_persistent: true,
        input_field_placeholder: `当前处于 ${shortCode} 隧道中转模式`
    };
}

async function promptTelegramShortCode(chatId) {
    await telegramSendMessage(chatId, '所发内容的备注文字中没有找到 5 位隧道暗号，请提供给我；也可以点击“放弃发送”。', telegramUnboundKeyboard());
}

async function downloadTelegramFile(fileId, maxSize = getTelegramMaxFileSize()) {
    const file = await telegramApi('getFile', { file_id: fileId });
    if (!file?.file_path) throw new Error('telegram-file-path-missing');
    const expectedSize = Number(file.file_size) || 0;
    if (expectedSize > maxSize) {
        const err = new Error('telegram-file-too-large-before-download');
        err.fileSize = expectedSize;
        throw err;
    }
    const response = await fetch(`https://api.telegram.org/file/bot${getTelegramBotToken()}/${file.file_path}`);
    if (!response.ok) throw new Error(`telegram-file-download-${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

function getOrCreateTelegramSession(sessionId, shortCode = '') {
    let session = sessions.get(sessionId);
    if (!session) {
        session = {
            devices: new Map(),
            editorAssets: new Map(),
            fileAssets: new Map(),
            history: [],
            deletedMessageIds: [],
            shortCode: normalizeShortCode(shortCode),
            remark: '',
            historySize: 0,
            createdAt: Date.now(),
            lastActivity: Date.now()
        };
        sessions.set(sessionId, session);
    }
    if (!Array.isArray(session.deletedMessageIds)) session.deletedMessageIds = [];
    if (!session.fileAssets) session.fileAssets = new Map();
    return session;
}

async function publishTelegramFileToTunnel(chatId, shortCode, telegramFile) {
    const sessionId = infraStore?.findSessionIdByShortCode(shortCode) || shortCodes.get(shortCode);
    if (!sessionId || !isValidSessionId(sessionId)) {
        await telegramSendMessage(chatId, '没有找到这个隧道暗号，请确认 5 位暗号是否正确。');
        return false;
    }
    const maxTelegramFileSize = getTelegramMaxFileSize();
    if (telegramFile.size > maxTelegramFileSize) {
        await telegramSendMessage(chatId, `文件太大，当前 Telegram bot 接收上限是 ${Math.round(maxTelegramFileSize / 1024 / 1024)}MB。`);
        return false;
    }
    fs.mkdirSync(TELEGRAM_ASSET_DIR, { recursive: true });
    const assetId = createServerAssetId();
    const safeName = sanitizeString(telegramFile.name || 'telegram-file', 180) || 'telegram-file';
    const assetPath = path.join(TELEGRAM_ASSET_DIR, assetId);
    const asset = {
        id: assetId,
        path: assetPath,
        name: safeName,
        type: sanitizeString(telegramFile.type || 'application/octet-stream', 100) || 'application/octet-stream',
        size: Number(telegramFile.size) || 0,
        sessionId,
        createdAt: Date.now(),
        fileId: telegramFile.fileId,
        fileUniqueId: telegramFile.fileUniqueId || '',
        fileIdUpdatedAt: Date.now()
    };
    persistTelegramServerAsset(asset);
    const session = getOrCreateTelegramSession(sessionId, shortCode);
    const message = {
        id: crypto.randomUUID(),
        type: 'file',
        fileInfo: {
            id: assetId,
            name: asset.name,
            size: asset.size,
            type: asset.type,
            timestamp: Date.now(),
            sender: TELEGRAM_BOT_DEVICE_ID,
            senderName: 'Telegram Bot',
            ownerDeviceId: TELEGRAM_BOT_DEVICE_ID,
            isAsset: false,
            isServerAsset: true,
            serverAssetUrl: `/api/server-assets/${assetId}`,
            remark: String(telegramFile.remark || '').trim().slice(0, 500),
            telegramFileId: asset.fileId,
            telegramFileUniqueId: asset.fileUniqueId,
            telegramFileIdUpdatedAt: asset.fileIdUpdatedAt
        },
        timestamp: Date.now(),
        sender: TELEGRAM_BOT_DEVICE_ID,
        senderName: 'Telegram Bot',
        sessionId,
        remark: String(telegramFile.remark || '').trim().slice(0, 500)
    };
    addToSessionHistory(sessionId, session, message, {
        fromDeviceId: TELEGRAM_BOT_DEVICE_ID,
        source: 'telegram-bot'
    });
    session.lastActivity = Date.now();
    io.to(sessionId).emit('message', { message });
    scheduleSessionHistoryBroadcast(sessionId, 'telegram-bot-file', 300);
    await telegramSendMessage(chatId, `已发送到隧道 ${shortCode}：${asset.name}`);
    historyLog('telegram-file-published', {
        sessionId,
        deviceId: TELEGRAM_BOT_DEVICE_ID,
        asset: { id: asset.id, name: asset.name, type: asset.type, size: asset.size }
    });
    return true;
}

async function prepareTelegramCollectionAsset(sessionId, telegramFile) {
    const maxSize = getTelegramMaxFileSize();
    if (telegramFile.size > maxSize) throw new Error(`文件 ${telegramFile.name} 超过 Telegram 接收上限`);
    fs.mkdirSync(TELEGRAM_ASSET_DIR, { recursive: true });
    const assetId = createServerAssetId();
    const asset = {
        id: assetId,
        path: path.join(TELEGRAM_ASSET_DIR, assetId),
        name: sanitizeString(telegramFile.name || 'telegram-file', 180) || 'telegram-file',
        type: sanitizeString(telegramFile.type || 'application/octet-stream', 100) || 'application/octet-stream',
        size: Number(telegramFile.size) || 0,
        sessionId,
        createdAt: Date.now(),
        fileId: telegramFile.fileId,
        fileUniqueId: telegramFile.fileUniqueId || '',
        fileIdUpdatedAt: Date.now()
    };
    persistTelegramServerAsset(asset);
    return {
        id: asset.id,
        name: asset.name,
        size: asset.size,
        type: asset.type,
        timestamp: Date.now(),
        sender: TELEGRAM_BOT_DEVICE_ID,
        senderName: 'Telegram Bot',
        ownerDeviceId: TELEGRAM_BOT_DEVICE_ID,
        isAsset: false,
        isServerAsset: true,
        serverAssetUrl: `/api/server-assets/${asset.id}`,
        remark: String(telegramFile.remark || '').trim().slice(0, 500),
        telegramFileId: asset.fileId,
        telegramFileUniqueId: asset.fileUniqueId,
        telegramFileIdUpdatedAt: asset.fileIdUpdatedAt
    };
}

async function publishTelegramCollectionToTunnel(chatId, shortCode, telegramFiles, remark = '') {
    const sessionId = infraStore?.findSessionIdByShortCode(shortCode) || shortCodes.get(shortCode);
    if (!sessionId || !isValidSessionId(sessionId)) {
        await telegramSendMessage(chatId, '没有找到这个隧道暗号，请确认 5 位暗号是否正确。');
        return false;
    }
    const fileInfos = [];
    for (const telegramFile of telegramFiles.slice(0, 100)) {
        fileInfos.push(await prepareTelegramCollectionAsset(sessionId, telegramFile));
    }
    if (!fileInfos.length) return false;
    const session = getOrCreateTelegramSession(sessionId, shortCode);
    const message = {
        id: crypto.randomUUID(),
        type: 'collection',
        collection: {
            id: crypto.randomUUID(),
            files: fileInfos,
            count: fileInfos.length,
            totalSize: fileInfos.reduce((sum, file) => sum + file.size, 0),
            remark: String(remark || '').trim().slice(0, 500)
        },
        timestamp: Date.now(),
        sender: TELEGRAM_BOT_DEVICE_ID,
        senderName: 'Telegram Bot',
        sessionId,
        remark: String(remark || '').trim().slice(0, 500)
    };
    addToSessionHistory(sessionId, session, message, { fromDeviceId: TELEGRAM_BOT_DEVICE_ID, source: 'telegram-bot-album' });
    session.lastActivity = Date.now();
    io.to(sessionId).emit('message', { message });
    scheduleSessionHistoryBroadcast(sessionId, 'telegram-bot-album', 300);
    await telegramSendMessage(chatId, `已将 ${fileInfos.length} 个媒体文件以合辑发送到隧道 ${shortCode}。`, telegramBoundKeyboard(shortCode));
    return true;
}

async function publishTelegramTextToTunnel(chatId, shortCode, textPayload) {
    const sessionId = infraStore?.findSessionIdByShortCode(shortCode) || shortCodes.get(shortCode);
    if (!sessionId || !isValidSessionId(sessionId)) {
        await telegramSendMessage(chatId, '没有找到这个隧道暗号，请确认 5 位暗号是否正确。');
        return false;
    }
    const text = String(textPayload?.text || '').trim();
    if (!text) return false;
    const entities = Array.isArray(textPayload?.entities) ? textPayload.entities : [];
    const richEntities = entities.filter(entity => entity?.type && entity.type !== 'bot_command');
    const session = getOrCreateTelegramSession(sessionId, shortCode);
    const isRich = richEntities.length > 0;
    const message = {
        id: crypto.randomUUID(),
        type: isRich ? 'rich' : 'text',
        timestamp: Date.now(),
        sender: TELEGRAM_BOT_DEVICE_ID,
        senderName: 'Telegram Bot',
        sessionId
    };
    if (isRich) {
        message.content = telegramTextToHtml(text, richEntities);
    } else {
        message.text = text;
    }
    const historyResult = addToSessionHistory(sessionId, session, message, {
        fromDeviceId: TELEGRAM_BOT_DEVICE_ID,
        source: 'telegram-bot-text'
    });
    session.lastActivity = Date.now();
    if (historyResult.stored) {
        io.to(sessionId).emit('message', { message });
        scheduleSessionHistoryBroadcast(sessionId, 'telegram-bot-text', 300);
    }
    await telegramSendMessage(chatId, `已发送到隧道 ${shortCode}。`);
    historyLog('telegram-text-published', {
        sessionId,
        deviceId: TELEGRAM_BOT_DEVICE_ID,
        rich: isRich,
        textLength: text.length,
        historyResult
    });
    return true;
}

function isValidMagnetAssetPayload(asset, fileId) {
    return asset &&
        asset.id === fileId &&
        isValidDeviceId(asset.id) &&
        typeof asset.name === 'string' && asset.name.length > 0 && asset.name.length <= 255 &&
        typeof asset.type === 'string' && asset.type.length > 0 && asset.type.length <= 100 &&
        typeof asset.size === 'number' && asset.size > 0 && asset.size <= MAX_MAGNET_FILE_ASSET_SIZE;
}

function createMagnetFileAssetRecord(asset, providerDeviceId) {
    return {
        metadata: {
            id: asset.id,
            name: sanitizeString(asset.name, 255),
            type: sanitizeString(asset.type || 'application/octet-stream', 100),
            size: asset.size,
            ownerDeviceId: isValidDeviceId(asset.ownerDeviceId) ? asset.ownerDeviceId : providerDeviceId,
            isFolderArchive: asset.isFolderArchive === true,
            isDirectoryMirror: asset.isDirectoryMirror === true,
            folderName: typeof asset.folderName === 'string' ? sanitizeString(asset.folderName, 120) : undefined,
            entryCount: Number.isInteger(asset.entryCount) ? asset.entryCount : undefined
        },
        providers: new Set([providerDeviceId]),
        providerLoads: new Map(),
        assignments: new Map()
    };
}

function getRequestBaseUrl(req) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    const host = req.get('host');
    return `${proto}://${host}`;
}

function getLiveSeedDevices(session, record) {
    if (!session || !record) return [];
    return Array.from(record.providers || [])
        .filter(deviceId => session.devices.has(deviceId) && deviceSockets.has(deviceId))
        .map(deviceId => {
            const device = session.devices.get(deviceId) || {};
            return {
                deviceId,
                deviceName: device.deviceName || '',
                socketId: device.socketId || '',
                deviceModel: device.deviceModel || '',
                localIp: device.localIp || '',
                externalIp: device.externalIp || ''
            };
        });
}

function cleanupExpiredMagnets() {
    const now = Date.now();
    for (const [magnetId, magnet] of magnets) {
        if (now - magnet.createdAt > MAGNET_TTL || !sessions.has(magnet.sessionId)) {
            magnets.delete(magnetId);
        }
    }
}

function getMagnetPayload(magnetId) {
    const magnet = magnets.get(magnetId);
    if (!magnet) return null;
    const session = sessions.get(magnet.sessionId);
    const record = session?.fileAssets?.get(magnet.assetId);
    const seedDevices = getLiveSeedDevices(session, record);
    return {
        id: magnetId,
        sessionId: magnet.sessionId,
        assetId: magnet.assetId,
        asset: record?.metadata || magnet.asset,
        createdAt: magnet.createdAt,
        createdByDeviceId: magnet.createdByDeviceId || '',
        createdByDeviceName: magnet.createdByDeviceName || '',
        seedDevices
    };
}

function normalizeStoredDevice(row = {}) {
    if (!row.device_id) return null;
    return {
        deviceId: row.device_id,
        sessionId: row.session_id || '',
        deviceName: row.device_name || '',
        deviceModel: row.device_model || '',
        localIp: row.local_ip || '',
        externalIp: row.external_ip || '',
        ip: row.ip || row.external_ip || '',
        userAgent: row.user_agent || '',
        firstSeen: Number(row.first_seen) || 0,
        lastAccess: Number(row.last_access) || 0,
        online: Number(row.online) === 1,
        active: Number(row.active) === 1
    };
}

function getPublicDeviceProfile(deviceId, req) {
    if (!isValidDeviceId(deviceId)) return null;
    const now = Date.now();
    let device = normalizeStoredDevice(infraStore?.getDevice(deviceId) || {});
    const memoryDevice = accessDevices.get(deviceId);
    if (memoryDevice) {
        device = {
            ...(device || {}),
            ...memoryDevice,
            deviceId: memoryDevice.deviceId || deviceId
        };
    }

    for (const [liveSessionId, session] of sessions) {
        const liveDevice = session.devices.get(deviceId);
        if (!liveDevice) continue;
        device = {
            ...(device || {}),
            deviceId,
            sessionId: liveSessionId || device?.sessionId || memoryDevice?.sessionId || '',
            deviceName: liveDevice.deviceName || device?.deviceName || '',
            deviceModel: liveDevice.deviceModel || device?.deviceModel || '',
            localIp: liveDevice.localIp || device?.localIp || '',
            externalIp: liveDevice.externalIp || device?.externalIp || '',
            ip: liveDevice.externalIp || device?.ip || '',
            online: deviceSockets.has(deviceId),
            active: deviceSockets.has(deviceId),
            lastAccess: now
        };
        break;
    }

    if (!device?.deviceId) return null;
    const sessionId = device.sessionId || '';
    const shortCode = sessionId && isValidSessionId(sessionId) ? findShortCodeForSession(sessionId) : '';
    const active = deviceSockets.has(deviceId) || (device.online === true && now - (device.lastAccess || 0) < 5 * 60 * 1000);
    const online = deviceSockets.has(deviceId) || (memoryDevice?.online === true && active);
    return {
        deviceId,
        deviceName: sanitizeString(device.deviceName || device.name || '', 100),
        deviceModel: sanitizeString(device.deviceModel || device.model || '', 100),
        localIp: sanitizeString(device.localIp || device.internalIp || '', 80),
        externalIp: sanitizeString(device.externalIp || '', 80),
        ip: sanitizeString(device.ip || device.externalIp || '', 80),
        userAgent: sanitizeString(device.userAgent || '', 180),
        sessionId,
        shortCode,
        firstSeen: Number(device.firstSeen) || Number(device.first_seen) || 0,
        lastAccess: Number(device.lastAccess) || Number(device.last_access) || 0,
        online,
        active,
        profileUrl: `${getRequestBaseUrl(req)}/device/${encodeURIComponent(deviceId)}`,
        tunnelUrl: sessionId ? `${getRequestBaseUrl(req)}/#${encodeURIComponent(sessionId)}` : ''
    };
}

function touchAccessDevice(key, patch = {}) {
    if (!key) return null;
    const now = Date.now();
    const previous = accessDevices.get(key) || {};
    const record = {
        ...previous,
        ...patch,
        key,
        firstSeen: previous.firstSeen || patch.firstSeen || now,
        lastAccess: patch.lastAccess || now
    };
    accessDevices.set(key, record);
    if (record.deviceId) {
        infraStore?.upsertDevice(record);
    }
    pruneAccessDevices();
    return record;
}

function markAccessDeviceOffline(key, patch = {}) {
    if (!key) return;
    touchAccessDevice(key, {
        ...patch,
        online: false,
        active: false,
        disconnectedAt: Date.now()
    });
}

function pruneAccessDevices() {
    const now = Date.now();
    for (const [key, device] of accessDevices) {
        if (!device.online && now - (device.lastAccess || device.firstSeen || 0) > ACCESS_DEVICE_TTL) {
            accessDevices.delete(key);
        }
    }

    if (accessDevices.size <= MAX_ACCESS_DEVICES) return;
    Array.from(accessDevices.entries())
        .sort((a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0))
        .slice(0, accessDevices.size - MAX_ACCESS_DEVICES)
        .forEach(([key]) => accessDevices.delete(key));
}

function isValidDeviceId(id) {
    return typeof id === 'string' && 
           /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function isValidEditorAsset(asset) {
    return asset &&
        isValidDeviceId(asset.id) &&
        typeof asset.name === 'string' && asset.name.length > 0 && asset.name.length <= 255 &&
        typeof asset.type === 'string' && asset.type.startsWith('image/') && asset.type.length <= 100 &&
        typeof asset.size === 'number' && asset.size > 0 && asset.size <= MAX_EDITOR_ASSET_SIZE;
}

function getAvailableEditorAssetProvider(session, assetId, requesterDeviceId, preferredProviderId) {
    const asset = session.editorAssets && session.editorAssets.get(assetId);
    if (!asset) return null;

    const providers = Array.from(asset.providers);
    const preferred = providers.find(deviceId =>
        deviceId === preferredProviderId &&
        deviceId !== requesterDeviceId &&
        session.devices.has(deviceId)
    );
    if (preferred) return preferred;

    return providers.find(deviceId =>
        deviceId !== requesterDeviceId && session.devices.has(deviceId)
    ) || null;
}

function getEditorAssetRelayKey(sessionId, from, to, assetId) {
    return `${sessionId}:${from}:${to}:${assetId}`;
}

function getBinaryDataSize(value) {
    if (Buffer.isBuffer(value)) return value.length;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    return -1;
}

function isValidDeviceName(name) {
    return typeof name === 'string' && 
           name.length > 0 && 
           name.length <= 50;
}

function isEditorContentEmpty(content) {
    return !content || content
        .replace(/<br\s*\/?\s*>/gi, '')
        .replace(/&nbsp;/gi, '')
        .trim() === '';
}

function extractFileReferenceIds(content) {
    const html = String(content || '');
    return new Set([
        ...Array.from(html.matchAll(/data-tunnel-file-ref-id="([^"]+)"/g), match => match[1]),
        ...Array.from(html.matchAll(/downloadFile\(['"]([^'"]+)['"]\)/g), match => match[1])
    ]);
}

function isFileAssetStillReferenced(session, fileId) {
    if (!fileId) return false;
    const referencedByHistory = session.history.some(entry =>
        (entry.message?.type === 'file' && entry.message.fileInfo?.id === fileId) ||
        (entry.message?.type === 'rich' && extractFileReferenceIds(entry.message.content).has(fileId)) ||
        (entry.message?.type === 'collection' && Array.isArray(entry.message.collection?.files) &&
            entry.message.collection.files.some(file => file?.id === fileId))
    );
    if (referencedByHistory) return true;
    return Array.from(session.devices.values()).some(device =>
        extractFileReferenceIds(device.editorContent).has(fileId)
    );
}

function createHistoryMessage(message) {
    const historyMessage = JSON.parse(JSON.stringify(message));

    // Inline small files are deliberately capped below the Socket.IO limit, so
    // their bytes can travel with a session snapshot. P2P file bytes remain local.
    if (historyMessage.type === 'file' && historyMessage.fileInfo && !historyMessage.fileInfo.isSmall) {
        delete historyMessage.fileInfo.data;
    }
    if (historyMessage.type === 'collection' && Array.isArray(historyMessage.collection?.files)) {
        historyMessage.collection.files.forEach(file => {
            if (file && typeof file === 'object') delete file.data;
        });
    }

    return historyMessage;
}

function preserveNewestTelegramFileIds(previousMessage, nextMessage) {
    const previousById = new Map();
    const collect = (message, callback) => {
        if (message?.fileInfo?.id) callback(message.fileInfo);
        if (message?.type === 'collection' && Array.isArray(message.collection?.files)) message.collection.files.forEach(callback);
    };
    collect(previousMessage, fileInfo => previousById.set(fileInfo.id, fileInfo));
    collect(nextMessage, fileInfo => {
        const previous = previousById.get(fileInfo.id);
        if (!previous) return;
        const previousUpdatedAt = Number(previous.telegramFileIdUpdatedAt) || 0;
        const nextUpdatedAt = Number(fileInfo.telegramFileIdUpdatedAt) || 0;
        if (previousUpdatedAt <= nextUpdatedAt) return;
        fileInfo.telegramFileId = previous.telegramFileId;
        fileInfo.telegramFileUniqueId = previous.telegramFileUniqueId || '';
        fileInfo.telegramFileIdUpdatedAt = previousUpdatedAt;
        fileInfo.isServerAsset = previous.isServerAsset;
        fileInfo.serverAssetUrl = previous.serverAssetUrl;
    });
    return nextMessage;
}

function summarizeHistoryMessage(message) {
    const fileInfo = message.fileInfo;
    const collectionFiles = Array.isArray(message.collection?.files) ? message.collection.files : [];
    return {
        id: message.id,
        type: message.type,
        sender: message.sender,
        timestamp: message.timestamp,
        file: fileInfo ? {
            id: fileInfo.id,
            name: fileInfo.name,
            size: fileInfo.size,
            isSmall: fileInfo.isSmall,
            hasInlineData: Boolean(fileInfo.data)
        } : undefined,
        collection: collectionFiles.length ? {
            id: message.collection?.id,
            count: collectionFiles.length,
            totalSize: collectionFiles.reduce((sum, file) => sum + (Number(file?.size) || 0), 0)
        } : undefined
    };
}

function historyLog(event, details) {
    if (HISTORY_DEBUG) {
        recordDebugLog({
            source: 'server',
            event,
            sessionId: details && details.sessionId,
            deviceId: details && (details.deviceId || details.targetDeviceId || details.fromDeviceId),
            socketId: details && (details.socketId || details.targetSocketId),
            clientIp: details && details.clientIp,
            details
        });
    }
}

function addToSessionHistory(sessionId, session, message, context = {}) {
    if (session.history.some(entry => entry.message.id === message.id)) {
        historyLog('store-skipped', {
            sessionId,
            ...context,
            reason: 'duplicate',
            message: summarizeHistoryMessage(message),
            historyCount: session.history.length
        });
        return { stored: false, reason: 'duplicate', evicted: 0 };
    }
    const fileId = message?.type === 'file' ? message.fileInfo?.id : null;
    if (fileId && session.history.some(entry => entry.message?.type === 'file' && entry.message.fileInfo?.id === fileId)) {
        historyLog('store-skipped', {
            sessionId,
            ...context,
            reason: 'duplicate-file',
            message: summarizeHistoryMessage(message),
            historyCount: session.history.length
        });
        return { stored: false, reason: 'duplicate-file', evicted: 0 };
    }

    const historyMessage = createHistoryMessage(message);
    const size = Buffer.byteLength(JSON.stringify(historyMessage), 'utf8');
    if (size > MAX_HISTORY_SIZE) {
        historyLog('store-skipped', {
            sessionId,
            ...context,
            reason: 'message-too-large',
            size,
            message: summarizeHistoryMessage(message)
        });
        return { stored: false, reason: 'message-too-large', evicted: 0 };
    }

    let evicted = 0;
    while (session.history.length >= MAX_HISTORY_MESSAGES ||
           session.historySize + size > MAX_HISTORY_SIZE) {
        const removed = session.history.shift();
        session.historySize -= removed.size;
        evicted++;
    }

    session.history.push({ message: historyMessage, size });
    session.historySize += size;
    historyLog('stored', {
        sessionId,
        ...context,
        message: summarizeHistoryMessage(historyMessage),
        size,
        historyCount: session.history.length,
        historySize: session.historySize,
        evicted
    });
    return { stored: true, reason: null, evicted };
}

function getSessionDeviceList(session, excludeDeviceId = '') {
    const deviceList = [];
    if (!session?.devices) return deviceList;
    session.devices.forEach((d, id) => {
        if (id === excludeDeviceId) return;
        deviceList.push({
            deviceId: d.deviceId,
            deviceName: d.deviceName,
            joinedAt: d.joinedAt,
            deviceModel: d.deviceModel,
            localIp: d.localIp,
            internalIp: d.localIp,
            externalIp: d.externalIp
        });
    });
    return deviceList;
}

function emitSessionSnapshot(socket, sessionId, session, targetDeviceId, context = {}) {
    const historyMessages = session.history.map(entry => entry.message);
    socket.emit('session-history', {
        messages: historyMessages,
        deletedMessageIds: session.deletedMessageIds || [],
        reason: context.reason || 'snapshot'
    });
    historyLog('snapshot-sent', {
        sessionId,
        targetDeviceId,
        targetSocketId: socket.id,
        clientIp: context.clientIp,
        reason: context.reason || 'snapshot',
        messageCount: historyMessages.length,
        messages: historyMessages.map(summarizeHistoryMessage)
    });
}

function scheduleSessionHistoryBroadcast(sessionId, reason = 'message-broadcast', delay = 800) {
    if (!isValidSessionId(sessionId)) return;
    const existing = sessionHistoryBroadcastTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        sessionHistoryBroadcastTimers.delete(sessionId);
        const session = sessions.get(sessionId);
        if (!session) return;
        const historyMessages = session.history.map(entry => entry.message);
        io.to(sessionId).emit('session-history', {
            messages: historyMessages,
            deletedMessageIds: session.deletedMessageIds || [],
            authoritative: true,
            reason
        });
        historyLog('snapshot-broadcast', {
            sessionId,
            reason,
            messageCount: historyMessages.length
        });
    }, delay);
    sessionHistoryBroadcastTimers.set(sessionId, timer);
}

// ==================== Socket.io 连接处理 ====================

io.on('connection', (socket) => {
    const clientIp = getSocketClientIp(socket);
    const socketAccessKey = `socket:${socket.id}`;
    
    console.log(`Client connected: ${socket.id} from ${clientIp}`);
    recordDebugLog({
        source: 'server',
        event: 'socket-connected',
        socketId: socket.id,
        clientIp,
        details: { transport: socket.conn.transport.name }
    });
    touchAccessDevice(socketAccessKey, {
        deviceId: '',
        sessionId: '',
        deviceName: '未加入隧道',
        deviceModel: '',
        localIp: '',
        externalIp: clientIp,
        ip: clientIp,
        socketId: socket.id,
        userAgent: sanitizeString(socket.handshake.headers['user-agent'] || '', 160),
        online: true,
        active: true
    });
    
    // IP连接数限制
    if (!ipConnections.has(clientIp)) {
        ipConnections.set(clientIp, new Set());
    }
    const ipSockets = ipConnections.get(clientIp);
    
    if (ipSockets.size >= 20) { // 每个IP最多20个连接
        console.warn(`IP ${clientIp} exceeded connection limit`);
        socket.emit('error', { message: '连接数超限' });
        socket.disconnect();
        return;
    }
    ipSockets.add(socket.id);
    
    let currentSession = null;
    let currentDevice = null;
    let profileDevice = null;
    let messageCount = 0;
    const MESSAGE_LIMIT = 100; // 每分钟最多100条消息
    let messageResetTime = Date.now() + 60000;
    
    // 消息速率检查
    function checkMessageRate() {
        const now = Date.now();
        if (now > messageResetTime) {
            messageCount = 0;
            messageResetTime = now + 60000;
        }
        messageCount++;
        return messageCount <= MESSAGE_LIMIT;
    }

    socket.on('register-profile-device', (data, ack) => {
        try {
            const deviceId = data?.deviceId;
            if (!isValidDeviceId(deviceId)) {
                if (typeof ack === 'function') ack({ ok: false, error: 'Invalid device id' });
                return;
            }
            const deviceName = isValidDeviceName(data.deviceName || '') ? sanitizeString(data.deviceName) : `设备-${deviceId.slice(-4)}`;
            profileDevice = deviceId;
            bindSocketToDevice(socket, deviceId);
            accessDevices.delete(socketAccessKey);
            touchAccessDevice(deviceId, {
                deviceId,
                sessionId: sanitizeString(data.sessionId || '', 80),
                deviceName,
                deviceModel: sanitizeString(data.deviceModel || '', 80),
                localIp: sanitizeString(data.localIp || '', 80),
                externalIp: clientIp,
                ip: clientIp,
                socketId: socket.id,
                userAgent: sanitizeString(socket.handshake.headers['user-agent'] || '', 160),
                online: true,
                active: true
            });
            if (typeof ack === 'function') ack({ ok: true });
        } catch (err) {
            if (typeof ack === 'function') ack({ ok: false, error: 'Register failed' });
        }
    });

    socket.on('device-tunnel-invite', (data, ack) => {
        try {
            const from = data?.from;
            const to = data?.to;
            const sessionId = data?.sessionId;
            const invitationId = sanitizeString(data?.invitationId || '', 80);
            const link = sanitizeString(data?.link || '', 500);
            if (!isValidDeviceId(from) || !isValidDeviceId(to) || !isValidSessionId(sessionId) || !invitationId || !link) {
                if (typeof ack === 'function') ack({ ok: false, delivered: false, error: 'Invalid invite' });
                return;
            }
            const payload = {
                invitationId,
                from,
                to,
                sessionId,
                link,
                sender: data?.sender || {}
            };
            const targets = emitToDevice(to, 'device-tunnel-invite', payload);
            if (targets.length) {
                if (typeof ack === 'function') ack({ ok: true, delivered: true });
            } else if (typeof ack === 'function') {
                ack({ ok: true, delivered: false });
            }
            historyLog('device-tunnel-invite', { deviceId: from, targetDeviceId: to, sessionId, delivered: targets.length > 0, targetSocketCount: targets.length, socketId: socket.id, clientIp });
        } catch (err) {
            if (typeof ack === 'function') ack({ ok: false, delivered: false, error: 'Invite failed' });
        }
    });

    socket.on('device-tunnel-invite-ack', data => {
        const to = data?.to;
        const from = data?.from;
        if (!isValidDeviceId(to) || !isValidDeviceId(from)) return;
        emitToDevice(to, 'device-tunnel-invite-ack', {
            invitationId: sanitizeString(data.invitationId || '', 80),
            from,
            to,
            sessionId: sanitizeString(data.sessionId || '', 80),
            accepted: data.accepted !== false,
            link: sanitizeString(data.link || '', 500)
        });
    });

    socket.on('device-remark-backup', (data, ack) => {
        const targetDeviceId = sanitizeString(data?.targetDeviceId, 80);
        const remark = sanitizeString(data?.remark, 120);
        if (!isValidDeviceId(targetDeviceId) || targetDeviceId === currentDevice) {
            return typeof ack === 'function' && ack({ ok: false, error: 'invalid-target' });
        }
        const targets = emitToDevice(targetDeviceId, 'device-remark-backup', {
            ownerDeviceId: currentDevice,
            targetDeviceId,
            remark,
            updatedAt: Number(data?.updatedAt) || Date.now()
        });
        if (typeof ack === 'function') ack({ ok: true, delivered: targets.length > 0 });
    });

    socket.on('device-remark-restore-request', data => {
        const helperDeviceId = sanitizeString(data?.helperDeviceId, 80);
        if (!isValidDeviceId(helperDeviceId) || helperDeviceId === currentDevice) return;
        emitToDevice(helperDeviceId, 'device-remark-restore-request', {
            ownerDeviceId: currentDevice,
            helperDeviceId
        });
    });

    socket.on('device-remark-restore-response', data => {
        const ownerDeviceId = sanitizeString(data?.ownerDeviceId, 80);
        if (!isValidDeviceId(ownerDeviceId) || ownerDeviceId === currentDevice) return;
        emitToDevice(ownerDeviceId, 'device-remark-restore-response', {
            ownerDeviceId,
            helperDeviceId: currentDevice,
            remark: sanitizeString(data?.remark, 120),
            updatedAt: Number(data?.updatedAt) || Date.now()
        });
    });

    socket.on('nearby-presence', data => {
        const deviceId = data?.deviceId;
        if (!isValidDeviceId(deviceId) || socket.data?.deviceId !== deviceId) return;
        const latitude = Number(data?.latitude);
        const longitude = Number(data?.longitude);
        nearbyPresence.set(deviceId, {
            deviceId,
            deviceName: isValidDeviceName(data?.deviceName || '') ? sanitizeString(data.deviceName, 50) : `设备-${deviceId.slice(-4)}`,
            deviceModel: sanitizeString(data?.deviceModel || '', 80),
            localIp: sanitizeString(data?.localIp || '', 80),
            externalIp: clientIp,
            latitude: Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 ? latitude : null,
            longitude: Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 ? longitude : null,
            lastSeen: Date.now(),
            socketId: socket.id
        });
        socket.data.nearbyDeviceId = deviceId;
        emitNearbyCandidates(deviceId);
    });
    
    // 加入会话
    socket.on('join-session', (data) => {
        try {
            // 验证数据
            if (!data || typeof data !== 'object') {
                return socket.emit('error', { message: '无效的数据格式' });
            }
            
            const { sessionId, deviceId, deviceName } = data;
            const requestedShortCode = normalizeShortCode(data.shortCode);
            
            // 验证 sessionId
            if (!isValidSessionId(sessionId)) {
                return socket.emit('error', { message: '无效的会话ID' });
            }
            
            // 验证 deviceId
            if (!isValidDeviceId(deviceId)) {
                return socket.emit('error', { message: '无效的设备ID' });
            }
            
            // 验证 deviceName
            if (!isValidDeviceName(deviceName)) {
                return socket.emit('error', { message: '无效的设备名称' });
            }
            
            // 清理过期会话
            cleanupExpiredSessions();
            
            // 会话数量限制
            if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS) {
                return socket.emit('error', { message: '服务器会话已满' });
            }
            
            currentSession = sessionId;
            currentDevice = deviceId;
            const storedTunnel = infraStore?.getTunnel(sessionId);
            const storedRemark = sanitizeString(storedTunnel?.remark || '', 60);
            
            // 存储设备socket映射
            bindSocketToDevice(socket, deviceId);
            
            // 获取或创建会话
            if (!sessions.has(sessionId)) {
                sessions.set(sessionId, {
                devices: new Map(),
                editorAssets: new Map(),
                fileAssets: new Map(),
                history: [],
                deletedMessageIds: [],
                shortCode: createShortCode(sessionId, requestedShortCode),
                remark: storedRemark,
                historySize: 0,
                    createdAt: Date.now(),
                    lastActivity: Date.now()
                });
            }
            
            const session = sessions.get(sessionId);
            if (!session.remark && storedRemark) session.remark = storedRemark;
            if (!Array.isArray(session.deletedMessageIds)) session.deletedMessageIds = [];
            if (!session.shortCode) session.shortCode = createShortCode(sessionId, requestedShortCode);
            infraStore?.touchTunnel(sessionId, {
                shortCode: session.shortCode || '',
                createdAt: session.createdAt || Date.now(),
                lastActivity: Date.now()
            });
            
            // 设备数量限制
            const existingDevice = session.devices.get(deviceId);

            if (session.devices.size >= MAX_DEVICES_PER_SESSION && !existingDevice) {
                return socket.emit('error', { message: '会话设备数已满' });
            }
            
            // 添加设备到会话
            session.devices.set(deviceId, {
                deviceId,
                deviceName: sanitizeString(deviceName),
                socketId: socket.id,
                joinedAt: Date.now(),
                deviceModel: sanitizeString(data.deviceModel || existingDevice?.deviceModel || '', 80),
                localIp: sanitizeString(data.localIp || existingDevice?.localIp || '', 80),
                externalIp: clientIp,
                lastSeenAt: Date.now(),
                editorContent: existingDevice ? existingDevice.editorContent : '',
                editorUpdatedAt: existingDevice ? existingDevice.editorUpdatedAt : 0
            });
            accessDevices.delete(socketAccessKey);
            touchAccessDevice(deviceId, {
                deviceId,
                sessionId,
                deviceName: sanitizeString(deviceName),
                deviceModel: session.devices.get(deviceId)?.deviceModel || '',
                localIp: session.devices.get(deviceId)?.localIp || '',
                externalIp: clientIp,
                ip: clientIp,
                socketId: socket.id,
                userAgent: sanitizeString(socket.handshake.headers['user-agent'] || '', 160),
                online: true,
                active: true
            });

            historyLog('join-ready', {
                sessionId,
                deviceId,
                socketId: socket.id,
                reconnect: Boolean(existingDevice),
                onlineDeviceCount: session.devices.size,
                historyCount: session.history.length,
                historySize: session.historySize,
                clientIp
            });
            
            session.lastActivity = Date.now();
            
            // 加入Socket.io房间
            socket.join(sessionId);
            
            console.log(`Device ${deviceName} (${deviceId}) joined session ${sessionId}`);
            
            // 通知会话中的其他设备
            if (!existingDevice) {
                socket.to(sessionId).emit('device-joined', {
                    deviceId,
                    deviceName: sanitizeString(deviceName),
                    joinedAt: Date.now(),
                    deviceModel: session.devices.get(deviceId)?.deviceModel || '',
                    localIp: session.devices.get(deviceId)?.localIp || '',
                    externalIp: clientIp
                });
            } else {
                socket.to(sessionId).emit('device-updated', {
                    deviceId,
                    deviceName: sanitizeString(deviceName),
                    deviceModel: session.devices.get(deviceId)?.deviceModel || '',
                    localIp: session.devices.get(deviceId)?.localIp || '',
                    internalIp: session.devices.get(deviceId)?.localIp || '',
                    externalIp: clientIp,
                    refreshedAt: Date.now()
                });
            }
            
            // 发送当前会话中的所有设备信息给新设备
            const deviceList = getSessionDeviceList(session, deviceId);
            
            socket.emit('session-devices', {
                devices: deviceList
            });
            socket.emit('session-short-code', { shortCode: session.shortCode });
            socket.emit('session-remark', { remark: session.remark || '' });
            socket.emit('device-profile', {
                deviceId,
                deviceModel: session.devices.get(deviceId)?.deviceModel || '',
                internalIp: session.devices.get(deviceId)?.localIp || '',
                externalIp: clientIp
            });

            let latestRemoteEditor = null;
            session.devices.forEach((device, id) => {
                if (id === deviceId || isEditorContentEmpty(device.editorContent)) return;

                if (!latestRemoteEditor || device.editorUpdatedAt > latestRemoteEditor.updatedAt) {
                    latestRemoteEditor = {
                        content: device.editorContent,
                        updatedAt: device.editorUpdatedAt
                    };
                }
            });

            socket.emit('editor-state', {
                hasRemoteContent: Boolean(latestRemoteEditor),
                content: latestRemoteEditor ? latestRemoteEditor.content : ''
            });

            emitSessionSnapshot(socket, sessionId, session, deviceId, { clientIp, reason: 'join' });
            if (session.media?.camera) {
                socket.emit('camera-broadcast-start', {
                    broadcastId: session.media.camera.broadcastId,
                    from: session.media.camera.ownerDeviceId
                });
            }
        } catch (err) {
            console.error('join-session error:', err);
            socket.emit('error', { message: '服务器内部错误' });
        }
    });

    socket.on('join-by-short-code', data => {
        const shortCode = normalizeShortCode(data?.shortCode);
        if (!shortCode) return socket.emit('short-code-error', { message: '短码应为 5 位字母或数字' });
        const sessionId = infraStore?.findSessionIdByShortCode(shortCode) || shortCodes.get(shortCode);
        if (!sessionId || !isValidSessionId(sessionId)) {
            deleteShortCode(shortCode);
            return socket.emit('short-code-error', { message: '短码无效或会话已结束' });
        }
        socket.emit('short-code-session', { sessionId });
    });

    socket.on('session-remark-update', data => {
        try {
            const { sessionId } = data || {};
            if (sessionId !== currentSession || !currentDevice) return;
            const session = sessions.get(sessionId);
            if (!session || !session.devices.has(currentDevice)) return;
            const remark = sanitizeString(String(data.remark || '').trim(), 60);
            session.remark = remark;
            session.lastActivity = Date.now();
            infraStore?.setTunnelRemark(sessionId, remark, session.lastActivity);
            io.to(sessionId).emit('session-remark', { remark, updatedBy: currentDevice });
            historyLog('session-remark-updated', {
                sessionId,
                deviceId: currentDevice,
                socketId: socket.id,
                clientIp,
                remarkLength: remark.length
            });
        } catch (err) {
            console.error('session-remark-update error:', err);
        }
    });

    socket.on('register-session-codes', data => {
        try {
            const entries = Array.isArray(data?.entries) ? data.entries.slice(0, 200) : [];
            let acceptedCount = 0;
            let rejectedCount = 0;
            for (const entry of entries) {
                const sessionId = entry && entry.sessionId;
                const shortCode = normalizeShortCode(entry && entry.shortCode);
                if (!isValidSessionId(sessionId) || !shortCode) {
                    rejectedCount++;
                    continue;
                }
                const session = sessions.get(sessionId);
                if (session?.shortCode && session.shortCode !== shortCode) {
                    rejectedCount++;
                    continue;
                }
                const reserved = reserveShortCode(shortCode, sessionId);
                if (!reserved) {
                    rejectedCount++;
                    continue;
                }
                if (session && !session.shortCode) {
                    session.shortCode = shortCode;
                }
                acceptedCount++;
            }
            historyLog('session-codes-registered', {
                sessionId: currentSession,
                deviceId: currentDevice,
                socketId: socket.id,
                clientIp,
                submittedCount: entries.length,
                acceptedCount,
                rejectedCount
            });
        } catch (err) {
            console.error('register-session-codes error:', err);
        }
    });
    
    // 信令转发 (WebRTC)
    socket.on('session-history-request', data => {
        try {
            const { sessionId, reason } = data || {};
            if (sessionId !== currentSession || !currentDevice) return;
            const session = sessions.get(sessionId);
            if (!session || !session.devices.has(currentDevice)) return;
            emitSessionSnapshot(socket, sessionId, session, currentDevice, {
                clientIp,
                reason: sanitizeString(reason || 'client-request', 80)
            });
            socket.emit('session-devices', {
                devices: getSessionDeviceList(session, currentDevice),
                reason: 'history-request'
            });
        } catch (err) {
            console.error('session-history-request error:', err);
        }
    });

    socket.on('tunnel-heartbeat', data => {
        try {
            const { sessionId } = data || {};
            if (sessionId !== currentSession || !currentDevice) return;
            const session = sessions.get(sessionId);
            const device = session?.devices.get(currentDevice);
            if (!session || !device) return;

            device.lastSeenAt = Date.now();
            device.socketId = socket.id;
            device.deviceName = sanitizeString(data.deviceName || device.deviceName || '', 80);
            device.deviceModel = sanitizeString(data.deviceModel || device.deviceModel || '', 80);
            device.localIp = sanitizeString(data.localIp || device.localIp || '', 80);
            device.externalIp = clientIp;
            session.lastActivity = Date.now();
            bindSocketToDevice(socket, currentDevice);
            touchAccessDevice(currentDevice, {
                deviceId: currentDevice,
                sessionId,
                deviceName: device.deviceName || '',
                deviceModel: device.deviceModel,
                localIp: device.localIp,
                externalIp: device.externalIp,
                ip: clientIp,
                socketId: socket.id,
                userAgent: sanitizeString(socket.handshake.headers['user-agent'] || '', 160),
                online: true,
                active: true
            });
            socket.emit('session-devices', {
                devices: getSessionDeviceList(session, currentDevice),
                reason: 'heartbeat'
            });
            socket.to(sessionId).emit('device-updated', {
                deviceId: currentDevice,
                deviceName: device.deviceName,
                deviceModel: device.deviceModel,
                localIp: device.localIp,
                internalIp: device.localIp,
                externalIp: device.externalIp,
                refreshedAt: Date.now()
            });
            historyLog('tunnel-heartbeat', {
                sessionId,
                deviceId: currentDevice,
                socketId: socket.id,
                clientIp,
                reason: sanitizeString(data.reason || '', 80),
                onlineDeviceCount: session.devices.size
            });
        } catch (err) {
            console.error('tunnel-heartbeat error:', err);
        }
    });

    socket.on('signal', (data) => {
        if (!checkMessageRate()) {
            return socket.emit('error', { message: '消息发送过于频繁' });
        }
        
        try {
            if (!data || typeof data !== 'object') return;
            
            const { to, from, type, sdp, candidate } = data;
            
            // 验证目标设备ID
            if (!isValidDeviceId(to) || !isValidDeviceId(from)) {
                return;
            }
            
            // 验证信令类型
            if (!['offer', 'answer', 'ice-candidate'].includes(type)) {
                return;
            }
            
            // 验证当前设备
            if (from !== currentDevice) {
                return socket.emit('error', { message: '设备ID不匹配' });
            }
            
            const targetSocket = deviceSockets.get(to);
            if (targetSocket) {
                targetSocket.emit('signal', {
                    from,
                    type,
                    sdp,
                    candidate
                });
            }
        } catch (err) {
            console.error('signal error:', err);
        }
    });
    
    // 消息转发
    socket.on('message', (data) => {
        if (!checkMessageRate()) {
            return socket.emit('error', { message: '消息发送过于频繁' });
        }
        
        try {
            if (!data || typeof data !== 'object') return;
            
            const { sessionId, message } = data;
            
            if (!isValidSessionId(sessionId)) return;
            if (!message || typeof message !== 'object') return;
            if (message.sender !== currentDevice) return;
            
            const session = sessions.get(sessionId);
            if (!session) return;
            
            session.lastActivity = Date.now();
            
            // 验证消息内容大小
            const messageStr = JSON.stringify(message);
            if (messageStr.length > MAX_MESSAGE_SIZE) {
                return socket.emit('error', { message: '消息过大' });
            }

            const historyResult = addToSessionHistory(sessionId, session, message, {
                fromDeviceId: currentDevice,
                socketId: socket.id,
                clientIp
            });
            socket.emit('message-ack', {
                messageId: message.id,
                stored: Boolean(historyResult.stored),
                reason: historyResult.reason || null,
                serverTimestamp: Date.now()
            });
            historyLog('message-received', {
                sessionId,
                fromDeviceId: currentDevice,
                message: summarizeHistoryMessage(message),
                historyResult,
                socketId: socket.id,
                clientIp,
                broadcastRecipients: Math.max(session.devices.size - 1, 0)
            });
            
            // 广播给会话中的其他设备
            socket.to(sessionId).emit('message', { message });
            scheduleSessionHistoryBroadcast(sessionId, 'message-broadcast');
        } catch (err) {
            console.error('message error:', err);
        }
    });

    socket.on('forward-message', (data, ack) => {
        try {
            const targetSessionId = sanitizeString(data?.targetSessionId, 80);
            const message = data?.message;
            if (!isValidSessionId(targetSessionId) || !message || typeof message !== 'object') {
                return typeof ack === 'function' && ack({ ok: false, error: 'invalid-forward' });
            }
            if (!infraStore?.getTunnel(targetSessionId)) {
                return typeof ack === 'function' && ack({ ok: false, error: 'target-tunnel-not-found' });
            }
            if (message.sender !== currentDevice || JSON.stringify(message).length > MAX_MESSAGE_SIZE) {
                return typeof ack === 'function' && ack({ ok: false, error: 'invalid-forward-message' });
            }
            const targetSession = getOrCreateTelegramSession(
                targetSessionId,
                infraStore.findShortCodeForSession(targetSessionId)
            );
            const historyResult = addToSessionHistory(targetSessionId, targetSession, message, {
                fromDeviceId: currentDevice,
                socketId: socket.id,
                clientIp,
                source: 'cross-tunnel-forward'
            });
            io.to(targetSessionId).emit('message', { message });
            scheduleSessionHistoryBroadcast(targetSessionId, 'cross-tunnel-forward');
            if (typeof ack === 'function') ack({ ok: true, stored: Boolean(historyResult.stored) });
        } catch (err) {
            console.error('forward-message error:', err);
            if (typeof ack === 'function') ack({ ok: false, error: 'forward-failed' });
        }
    });

    socket.on('clipboard-update', data => {
        try {
            const { sessionId, text } = data || {};
            if (sessionId !== currentSession || typeof text !== 'string' || text.length > 50000) return;
            const session = sessions.get(sessionId);
            if (!session?.devices.has(currentDevice)) return;
            socket.to(sessionId).emit('clipboard-update', {
                from: currentDevice,
                deviceName: session.devices.get(currentDevice)?.deviceName || '设备',
                text,
                timestamp: Date.now()
            });
            historyLog('clipboard-updated', {
                sessionId, deviceId: currentDevice, socketId: socket.id, clientIp, textLength: text.length
            });
        } catch (err) {
            console.error('clipboard-update error:', err);
        }
    });

    socket.on('delete-message', data => {
        try {
            const { sessionId, messageId } = data || {};
            if (sessionId !== currentSession || !isValidDeviceId(messageId)) return;
            const session = sessions.get(sessionId);
            if (!session || !session.devices.has(currentDevice)) return;

            const historyIndex = session.history.findIndex(entry => entry.message.id === messageId);
            let fileId = null;
            let fileIds = [];
            let fileStillReferenced = false;
            if (historyIndex >= 0) {
                const [removed] = session.history.splice(historyIndex, 1);
                session.historySize = Math.max(0, session.historySize - removed.size);
                fileIds = removed.message?.type === 'collection' && Array.isArray(removed.message.collection?.files)
                    ? removed.message.collection.files.map(file => file?.id).filter(Boolean)
                    : [removed.message?.fileInfo?.id].filter(Boolean);
                fileId = fileIds[0] || null;
                for (const currentFileId of fileIds) {
                    const stillReferenced = isFileAssetStillReferenced(session, currentFileId);
                    fileStillReferenced = fileStillReferenced || stillReferenced;
                    if (!stillReferenced) session.fileAssets?.delete(currentFileId);
                }
            }

            if (!Array.isArray(session.deletedMessageIds)) session.deletedMessageIds = [];
            if (!session.deletedMessageIds.includes(messageId)) {
                session.deletedMessageIds.push(messageId);
                if (session.deletedMessageIds.length > MAX_HISTORY_MESSAGES) session.deletedMessageIds.shift();
            }
            session.lastActivity = Date.now();
            socket.to(sessionId).emit('message-deleted', { messageId });
            historyLog('message-deleted', {
                sessionId,
                deviceId: currentDevice,
                socketId: socket.id,
                clientIp,
                messageId,
                fileId,
                fileIds,
                fileStillReferenced,
                historyCount: session.history.length
            });
        } catch (err) {
            console.error('delete-message error:', err);
        }
    });

    socket.on('update-message', data => {
        try {
            const { sessionId, message } = data || {};
            if (sessionId !== currentSession || !message || !isValidDeviceId(message.id)) return;
            if (!['text', 'rich', 'file', 'collection'].includes(message.type)) return;
            const session = sessions.get(sessionId);
            if (!session || !session.devices.has(currentDevice)) return;

            const historyIndex = session.history.findIndex(entry => entry.message.id === message.id);
            if (historyIndex < 0) return;
            const historyMessage = preserveNewestTelegramFileIds(
                session.history[historyIndex].message,
                createHistoryMessage(message)
            );
            const size = Buffer.byteLength(JSON.stringify(historyMessage), 'utf8');
            if (size > MAX_HISTORY_SIZE) return;

            const previous = session.history[historyIndex];
            session.history[historyIndex] = { message: historyMessage, size };
            session.historySize = Math.max(0, session.historySize - previous.size + size);
            if (previous.message?.type === 'collection' && historyMessage.type === 'collection') {
                const nextIds = new Set((historyMessage.collection?.files || []).map(file => file?.id).filter(Boolean));
                const removedFileIds = (previous.message.collection?.files || [])
                    .map(file => file?.id)
                    .filter(fileId => fileId && !nextIds.has(fileId));
                removedFileIds.forEach(fileId => {
                    if (!isFileAssetStillReferenced(session, fileId)) session.fileAssets?.delete(fileId);
                });
            }
            session.lastActivity = Date.now();
            socket.to(sessionId).emit('message-updated', { message: historyMessage });
            scheduleSessionHistoryBroadcast(sessionId, 'message-updated');
            historyLog('message-updated', {
                sessionId,
                deviceId: currentDevice,
                socketId: socket.id,
                clientIp,
                message: summarizeHistoryMessage(historyMessage),
                historyCount: session.history.length
            });
        } catch (err) {
            console.error('update-message error:', err);
        }
    });

    socket.on('history-reconcile', data => {
        try {
            const { sessionId, messages } = data || {};
            if (sessionId !== currentSession || !Array.isArray(messages)) return;
            const session = sessions.get(sessionId);
            if (!session || !session.devices.has(currentDevice)) return;

            const deletedMessageIds = new Set(session.deletedMessageIds || []);
            let mergedCount = 0;
            let rejectedCount = 0;
            const candidates = messages.slice(-MAX_HISTORY_MESSAGES);

            for (const message of candidates) {
                if (!message || !isValidDeviceId(message.id) ||
                    !['text', 'rich', 'file', 'collection'].includes(message.type) ||
                    deletedMessageIds.has(message.id)) {
                    rejectedCount++;
                    continue;
                }
                const encoded = JSON.stringify(message);
                if (encoded.length > MAX_MESSAGE_SIZE) {
                    rejectedCount++;
                    continue;
                }
                const result = addToSessionHistory(sessionId, session, message, {
                    fromDeviceId: currentDevice,
                    socketId: socket.id,
                    clientIp,
                    source: 'history-reconcile'
                });
                if (result.stored) mergedCount++;
            }

            session.lastActivity = Date.now();
            const canonicalMessages = session.history.map(entry => entry.message);
            io.to(sessionId).emit('session-history', {
                messages: canonicalMessages,
                deletedMessageIds: session.deletedMessageIds || [],
                authoritative: true
            });
            historyLog('history-reconciled', {
                sessionId,
                deviceId: currentDevice,
                socketId: socket.id,
                clientIp,
                submittedCount: candidates.length,
                mergedCount,
                rejectedCount,
                canonicalMessageCount: canonicalMessages.length
            });
        } catch (err) {
            console.error('history-reconcile error:', err);
        }
    });

    socket.on('session-history-ack', (data) => {
        if (!data || typeof data !== 'object') return;

        const { sessionId, deviceId, receivedCount, restoredCount, duplicateCount, failedCount } = data;
        if (sessionId !== currentSession || deviceId !== currentDevice) return;

        historyLog('snapshot-acknowledged', {
            sessionId,
            deviceId,
            socketId: socket.id,
            clientIp,
            receivedCount,
            restoredCount,
            duplicateCount,
            failedCount
        });
    });

    socket.on('device-profile-update', data => {
        try {
            if (!data || data.sessionId !== currentSession || !currentDevice) return;
            const session = sessions.get(currentSession);
            const device = session?.devices.get(currentDevice);
            if (!session || !device) return;

            device.deviceModel = sanitizeString(data.deviceModel || device.deviceModel || '', 80);
            device.localIp = sanitizeString(data.localIp || device.localIp || '', 80);
            device.externalIp = clientIp;
            touchAccessDevice(currentDevice, {
                deviceId: currentDevice,
                sessionId: currentSession,
                deviceName: device.deviceName || '',
                deviceModel: device.deviceModel,
                localIp: device.localIp,
                externalIp: device.externalIp,
                ip: clientIp,
                socketId: socket.id,
                userAgent: sanitizeString(socket.handshake.headers['user-agent'] || '', 160),
                online: true,
                active: true
            });
            socket.emit('device-profile', {
                deviceId: currentDevice,
                deviceModel: device.deviceModel,
                internalIp: device.localIp,
                externalIp: device.externalIp
            });
            socket.to(currentSession).emit('device-updated', {
                deviceId: currentDevice,
                deviceName: device.deviceName,
                deviceModel: device.deviceModel,
                localIp: device.localIp,
                externalIp: device.externalIp
            });
            historyLog('device-profile-updated', {
                sessionId: currentSession,
                deviceId: currentDevice,
                socketId: socket.id,
                clientIp,
                deviceModel: device.deviceModel,
                localIp: device.localIp
            });
        } catch (err) {
            console.error('device-profile-update error:', err);
        }
    });

    socket.on('debug-log', (data) => {
        if (!HISTORY_DEBUG) return;
        if (!data || typeof data !== 'object') return;

        const { event, details, sessionId, deviceId, clientTimestamp } = data;
        if (sessionId !== currentSession || deviceId !== currentDevice || typeof event !== 'string') {
            recordDebugLog({
                source: 'server',
                event: 'client-debug-log-rejected',
                sessionId: currentSession,
                deviceId: currentDevice,
                socketId: socket.id,
                clientIp,
                details: { reportedSessionId: sessionId, reportedDeviceId: deviceId }
            });
            return;
        }

        const device = sessions.get(currentSession)?.devices.get(currentDevice);
        recordDebugLog({
            source: 'client',
            event,
            details,
            sessionId: currentSession,
            deviceId: currentDevice,
            deviceName: device && device.deviceName,
            socketId: socket.id,
            clientIp,
            clientTimestamp
        });
    });
    
    // 编辑器同步
    socket.on('editor-sync', (data) => {
        if (!checkMessageRate()) {
            historyLog('editor-sync-rejected', {
                sessionId: currentSession,
                deviceId: currentDevice,
                socketId: socket.id,
                clientIp,
                reason: 'rate-limited'
            });
            return socket.emit('error', { message: '同步过于频繁', code: 'EDITOR_SYNC_RATE_LIMITED' });
        }
        
        try {
            if (!data || typeof data !== 'object') return;
            
            const { sessionId, from, content } = data;
            
            if (!isValidSessionId(sessionId)) return;
            if (from !== currentDevice) return;
            if (typeof content !== 'string') return;
            const contentSize = Buffer.byteLength(content, 'utf8');
            if (contentSize > MAX_EDITOR_CONTENT_SIZE) {
                historyLog('editor-sync-rejected', {
                    sessionId,
                    deviceId: currentDevice,
                    socketId: socket.id,
                    clientIp,
                    reason: 'content-too-large',
                    contentSize,
                    maxContentSize: MAX_EDITOR_CONTENT_SIZE
                });
                return socket.emit('error', {
                    message: '协同编辑内容过大，无法同步',
                    code: 'EDITOR_CONTENT_TOO_LARGE',
                    contentSize,
                    maxContentSize: MAX_EDITOR_CONTENT_SIZE
                });
            }
            
            const session = sessions.get(sessionId);
            if (!session) return;

            const device = session.devices.get(currentDevice);
            if (!device || device.socketId !== socket.id) return;
            
            session.lastActivity = Date.now();
            const editorUpdatedAt = Date.now();
            session.devices.forEach((sessionDevice) => {
                sessionDevice.editorContent = content;
                sessionDevice.editorUpdatedAt = editorUpdatedAt;
            });
            
            // 广播给会话中的其他设备
            socket.to(sessionId).emit('editor-sync', { from, content });
            historyLog('editor-sync-accepted', {
                sessionId,
                deviceId: currentDevice,
                socketId: socket.id,
                clientIp,
                contentSize,
                recipientCount: Math.max(session.devices.size - 1, 0)
            });
        } catch (err) {
            console.error('editor-sync error:', err);
            historyLog('editor-sync-failed', {
                sessionId: currentSession,
                deviceId: currentDevice,
                socketId: socket.id,
                clientIp,
                error: err.message
            });
        }
    });

    socket.on('editor-asset-available', (data) => {
        try {
            if (!data || typeof data !== 'object') return;
            const { sessionId, asset } = data;
            if (sessionId !== currentSession || !isValidEditorAsset(asset)) return;

            const session = sessions.get(sessionId);
            if (!session || !session.devices.has(currentDevice)) return;
            if (!session.editorAssets) session.editorAssets = new Map();

            let record = session.editorAssets.get(asset.id);
            if (!record) {
                if (session.editorAssets.size >= MAX_EDITOR_ASSETS_PER_SESSION) {
                    return socket.emit('error', {
                        message: '协同编辑图片数量已达上限',
                        code: 'EDITOR_ASSET_LIMIT_REACHED'
                    });
                }
                record = {
                    metadata: {
                        id: asset.id,
                        name: sanitizeString(asset.name, 255),
                        type: sanitizeString(asset.type, 100),
                        size: asset.size
                    },
                    providers: new Set()
                };
                session.editorAssets.set(asset.id, record);
            }

            record.providers.add(currentDevice);
            session.lastActivity = Date.now();
            socket.to(sessionId).emit('editor-asset-available', {
                asset: record.metadata,
                from: currentDevice
            });
            historyLog('editor-asset-available', {
                sessionId,
                deviceId: currentDevice,
                socketId: socket.id,
                clientIp,
                asset: record.metadata,
                providerCount: record.providers.size
            });
        } catch (err) {
            console.error('editor-asset-available error:', err);
        }
    });

    socket.on('editor-asset-request', (data) => {
        try {
            if (!data || typeof data !== 'object') return;
            const { sessionId, assetId, preferredProviderId } = data;
            if (sessionId !== currentSession || !isValidDeviceId(assetId)) return;

            const session = sessions.get(sessionId);
            if (!session || !session.devices.has(currentDevice)) return;

            const providerDeviceId = getAvailableEditorAssetProvider(
                session,
                assetId,
                currentDevice,
                preferredProviderId
            );
            if (!providerDeviceId) {
                historyLog('editor-asset-unavailable', {
                    sessionId,
                    deviceId: currentDevice,
                    socketId: socket.id,
                    clientIp,
                    assetId,
                    reason: 'no-online-provider'
                });
                return socket.emit('editor-asset-unavailable', {
                    assetId,
                    reason: 'no-online-provider'
                });
            }

            const providerSocket = deviceSockets.get(providerDeviceId);
            const record = session.editorAssets.get(assetId);
            if (!providerSocket || !record) return;

            socket.emit('editor-asset-provider', {
                assetId,
                providerDeviceId
            });
            providerSocket.emit('editor-asset-request', {
                asset: record.metadata,
                from: currentDevice
            });
            historyLog('editor-asset-request-forwarded', {
                sessionId,
                deviceId: currentDevice,
                targetDeviceId: providerDeviceId,
                socketId: socket.id,
                clientIp,
                asset: record.metadata
            });
        } catch (err) {
            console.error('editor-asset-request error:', err);
        }
    });

    socket.on('editor-asset-unavailable', (data) => {
        try {
            if (!data || typeof data !== 'object') return;
            const { sessionId, assetId, to, reason } = data;
            if (sessionId !== currentSession || !isValidDeviceId(assetId) || !isValidDeviceId(to)) return;

            const session = sessions.get(sessionId);
            const record = session && session.editorAssets && session.editorAssets.get(assetId);
            if (record && reason === 'provider-missing-local-data') {
                record.providers.delete(currentDevice);
                const alternativeProviderId = getAvailableEditorAssetProvider(session, assetId, to, null);
                const alternativeSocket = alternativeProviderId && deviceSockets.get(alternativeProviderId);
                if (alternativeSocket) {
                    alternativeSocket.emit('editor-asset-request', {
                        asset: record.metadata,
                        from: to
                    });
                    return;
                }
                if (record.providers.size === 0) {
                    session.editorAssets.delete(assetId);
                }
            }

            const targetSocket = deviceSockets.get(to);
            if (targetSocket) {
                targetSocket.emit('editor-asset-unavailable', {
                    assetId,
                    from: currentDevice,
                    reason: sanitizeString(reason || 'provider-unavailable', 80)
                });
            }
        } catch (err) {
            console.error('editor-asset-unavailable error:', err);
        }
    });

    socket.on('editor-asset-relay-start', (data) => {
        try {
            if (!data || typeof data !== 'object') return;
            const { sessionId, to, asset } = data;
            if (sessionId !== currentSession || !isValidDeviceId(to) || !isValidEditorAsset(asset)) return;

            const session = sessions.get(sessionId);
            const target = session && session.devices.get(to);
            const targetSocket = target && deviceSockets.get(to);
            if (!targetSocket || to === currentDevice) return;

            const key = getEditorAssetRelayKey(sessionId, currentDevice, to, asset.id);
            editorAssetRelays.set(key, {
                sessionId,
                from: currentDevice,
                to,
                asset: {
                    id: asset.id,
                    name: sanitizeString(asset.name, 255),
                    type: sanitizeString(asset.type, 100),
                    size: asset.size
                },
                receivedSize: 0
            });
            targetSocket.emit('editor-asset-relay-start', {
                asset,
                from: currentDevice
            });
            historyLog('editor-asset-relay-started', {
                sessionId,
                deviceId: currentDevice,
                targetDeviceId: to,
                socketId: socket.id,
                clientIp,
                asset: { id: asset.id, name: asset.name, type: asset.type, size: asset.size }
            });
        } catch (err) {
            console.error('editor-asset-relay-start error:', err);
        }
    });

    socket.on('editor-asset-relay-chunk', (data) => {
        try {
            if (!data || typeof data !== 'object') return;
            const { sessionId, to, assetId, chunk } = data;
            if (sessionId !== currentSession || !isValidDeviceId(to) || !isValidDeviceId(assetId)) return;

            const key = getEditorAssetRelayKey(sessionId, currentDevice, to, assetId);
            const relay = editorAssetRelays.get(key);
            const size = getBinaryDataSize(chunk);
            if (!relay || size <= 0 || size > MAX_EDITOR_ASSET_RELAY_CHUNK_SIZE ||
                relay.receivedSize + size > relay.asset.size) {
                editorAssetRelays.delete(key);
                return;
            }

            const targetSocket = deviceSockets.get(to);
            if (!targetSocket) return;
            relay.receivedSize += size;
            targetSocket.emit('editor-asset-relay-chunk', {
                assetId,
                from: currentDevice,
                chunk
            });
        } catch (err) {
            console.error('editor-asset-relay-chunk error:', err);
        }
    });

    socket.on('editor-asset-relay-complete', (data) => {
        try {
            if (!data || typeof data !== 'object') return;
            const { sessionId, to, assetId } = data;
            if (sessionId !== currentSession || !isValidDeviceId(to) || !isValidDeviceId(assetId)) return;

            const key = getEditorAssetRelayKey(sessionId, currentDevice, to, assetId);
            const relay = editorAssetRelays.get(key);
            editorAssetRelays.delete(key);
            if (!relay || relay.receivedSize !== relay.asset.size) return;

            const targetSocket = deviceSockets.get(to);
            if (targetSocket) {
                targetSocket.emit('editor-asset-relay-complete', {
                    assetId,
                    from: currentDevice
                });
            }
            historyLog('editor-asset-relay-completed', {
                sessionId,
                deviceId: currentDevice,
                targetDeviceId: to,
                socketId: socket.id,
                clientIp,
                asset: relay.asset
            });
        } catch (err) {
            console.error('editor-asset-relay-complete error:', err);
        }
    });
    
    // 文件传输offer
    socket.on('file-offer', (data) => {
        if (!checkMessageRate()) {
            return socket.emit('error', { message: '请求过于频繁' });
        }
        
        try {
            if (!data || typeof data !== 'object') return;
            
            const { sessionId, from, fileInfo } = data;
            
            if (!isValidSessionId(sessionId)) return;
            if (from !== currentDevice) return;
            if (!fileInfo || typeof fileInfo !== 'object') return;
            
            // 验证文件信息
            if (typeof fileInfo.name !== 'string' || fileInfo.name.length > 255) return;
            if (typeof fileInfo.size !== 'number' || fileInfo.size < 0 || fileInfo.size > 10 * 1024 * 1024 * 1024) return; // 最大10GB
            if (typeof fileInfo.type !== 'string' || fileInfo.type.length > 100) return;
            
            const session = sessions.get(sessionId);
            if (!session) return;
            
            session.lastActivity = Date.now();
            
            // 广播给会话中的其他设备
            socket.to(sessionId).emit('file-offer', { 
                from, 
                fileInfo: {
                    id: fileInfo.id,
                    name: sanitizeString(fileInfo.name, 255),
                    size: fileInfo.size,
                    type: sanitizeString(fileInfo.type, 100)
                }
            });
        } catch (err) {
            console.error('file-offer error:', err);
        }
    });
    
    // 文件传输answer
    socket.on('file-answer', (data) => {
        try {
            if (!data || typeof data !== 'object') return;
            
            const { sessionId, to, from, fileId, accepted } = data;
            
            if (!isValidSessionId(sessionId)) return;
            if (!isValidDeviceId(to) || !isValidDeviceId(from)) return;
            if (from !== currentDevice) return;
            
            const targetSocket = deviceSockets.get(to);
            if (targetSocket) {
                targetSocket.emit('file-answer', {
                    from,
                    fileId,
                    accepted: !!accepted
                });
            }
        } catch (err) {
            console.error('file-answer error:', err);
        }
    });

    registerFileAssetHandlers(socket, {
        sessions,
        deviceSockets,
        getSessionId: () => currentSession,
        getDeviceId: () => currentDevice,
        isValidId: isValidDeviceId,
        sanitize: sanitizeString,
        historyLog,
        clientIp
    });

    registerMediaHandlers(socket, {
        sessions,
        deviceSockets,
        getSessionId: () => currentSession,
        getDeviceId: () => currentDevice,
        isValidId: isValidDeviceId,
        historyLog,
        clientIp
    });
    
    // 断开连接
    socket.on('disconnect', (reason) => {
        console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
        const nearbyDeviceId = socket.data?.nearbyDeviceId;
        if (nearbyDeviceId && nearbyPresence.get(nearbyDeviceId)?.socketId === socket.id) {
            nearbyPresence.delete(nearbyDeviceId);
        }
        
        // 清理IP连接记录
        ipSockets.delete(socket.id);
        if (ipSockets.size === 0) {
            ipConnections.delete(clientIp);
        }
        
        if (currentSession && currentDevice) {
            cleanupFileAssetRelays(currentSession, currentDevice);
            for (const [key, relay] of editorAssetRelays) {
                if (relay.sessionId === currentSession && (relay.from === currentDevice || relay.to === currentDevice)) {
                    editorAssetRelays.delete(key);
                }
            }
            const session = sessions.get(currentSession);
            if (session) {
                const device = session.devices.get(currentDevice);

                // A reloaded page may already have replaced this socket.
                if (device && device.socketId === socket.id) {
                    markAccessDeviceOffline(currentDevice, {
                        deviceId: currentDevice,
                        sessionId: currentSession,
                        deviceName: device.deviceName || '',
                        deviceModel: device.deviceModel || '',
                        localIp: device.localIp || '',
                        externalIp: clientIp,
                        ip: clientIp,
                        socketId: socket.id
                    });
                    session.devices.delete(currentDevice);

                    if (session.editorAssets) {
                        for (const [assetId, asset] of session.editorAssets) {
                            asset.providers.delete(currentDevice);
                            if (asset.providers.size === 0) {
                                session.editorAssets.delete(assetId);
                            }
                        }
                    }

                    if (session.fileAssets) {
                        for (const [assetId, asset] of session.fileAssets) {
                            if (asset.assignments) {
                                for (const [key, providerId] of asset.assignments) {
                                    if (providerId === currentDevice || key.endsWith(`:${currentDevice}`)) {
                                        const requesterId = key.slice(key.lastIndexOf(':') + 1);
                                        const provider = asset.assignments.get(key);
                                        asset.assignments.delete(key);
                                        const nextLoad = Math.max(0, (asset.providerLoads?.get(provider) || 1) - 1);
                                        if (nextLoad === 0) asset.providerLoads?.delete(provider);
                                        else asset.providerLoads?.set(provider, nextLoad);
                                    }
                                }
                            }
                            asset.providers.delete(currentDevice);
                            if (asset.providers.size === 0) session.fileAssets.delete(assetId);
                        }
                    }

                    cleanupMediaDevice(session, currentDevice, (event, payload) => socket.to(currentSession).emit(event, payload));

                    // 通知会话中的其他设备
                    socket.to(currentSession).emit('device-left', {
                        deviceId: currentDevice
                    });

                    // 如果会话为空，清理会话
                    if (session.devices.size === 0) {
                        session.lastActivity = Date.now();
                    }
                }
            }
            
            if (deviceSockets.get(currentDevice) === socket) {
                deviceSockets.delete(currentDevice);
            }
        } else if (profileDevice) {
            if (deviceSockets.get(profileDevice) === socket) {
                deviceSockets.delete(profileDevice);
            }
            markAccessDeviceOffline(profileDevice, {
                deviceId: profileDevice,
                ip: clientIp,
                externalIp: clientIp,
                socketId: socket.id
            });
        } else {
            markAccessDeviceOffline(socketAccessKey, {
                ip: clientIp,
                externalIp: clientIp,
                socketId: socket.id
            });
        }
    });
    
    // 错误处理
    socket.on('error', (err) => {
        console.error(`Socket ${socket.id} error:`, err);
    });
});

// ==================== 清理函数 ====================

function cleanupExpiredSessions() {
    const now = Date.now();
    let cleaned = 0;
    cleanupExpiredMagnets();
    pruneAccessDevices();
    
    for (const [sessionId, session] of sessions) {
        // Keep an empty session long enough for reconnecting devices to recover history.
        if (session.devices.size === 0 &&
            now - session.lastActivity > MAX_SESSION_AGE) {
            sessions.delete(sessionId);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} expired sessions`);
    }
}

// 定期清理 (每5分钟)
setInterval(cleanupExpiredSessions, 5 * 60 * 1000);

// ==================== 启动 ====================

function logStartup() {
    console.log(`🚀 即时传输隧道服务器运行中 (安全版本)`);
    console.log(`📱 Web/API: http://127.0.0.1:${WEB_PORT} and http://<LAN-IP>:${WEB_PORT}`);
    console.log(`🔌 Socket.IO: 与 Web/API 共用 ${WEB_PORT} 端口`);
    console.log(`🔒 Nginx should proxy public HTTP/HTTPS traffic to this upstream`);
    console.log(`🔒 CORS: ${ALLOWED_ORIGINS.join(', ')}`);
}

async function startServer() {
    infraStore = await createInfraStore({ dataDir: SERVER_DATA_DIR });
    migrateLegacyShortCodeStore();
    hydrateShortCodeCache();
    hydrateTelegramServerAssets();
    webServer.listen(WEB_PORT, '0.0.0.0', logStartup);
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

// 优雅关闭
function shutdown(signal) {
    console.log(`${signal} received, shutting down gracefully`);
    webServer.close(() => {
        console.log('Server closed');
        process.exit(0);
    });

    setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
