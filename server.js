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

const app = express();
const PROJECT_CONFIG_PATH = path.join(__dirname, 'tunnel.config.json');
const SERVER_DATA_DIR = path.join(__dirname, '.tunnel-data');
const LEGACY_SHORT_CODE_STORE_PATH = path.join(SERVER_DATA_DIR, 'short-codes.json');
const projectConfig = loadProjectConfig();
let infraStore = null;

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

// 会话限制
const MAX_SESSIONS = 1000;
const MAX_DEVICES_PER_SESSION = 10;
const MAX_SESSION_AGE = 2 * 60 * 60 * 1000; // 2小时
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB
const MAX_EDITOR_CONTENT_SIZE = 512 * 1024; // Keep editor updates well below Socket.IO's 1MB buffer.
const MAX_EDITOR_ASSET_SIZE = 20 * 1024 * 1024;
const MAX_EDITOR_ASSETS_PER_SESSION = 100;
const MAX_EDITOR_ASSET_RELAY_CHUNK_SIZE = 64 * 1024;
const MAX_HISTORY_MESSAGES = 100;
const MAX_HISTORY_SIZE = 2 * 1024 * 1024; // 2MB per session
const HISTORY_DEBUG = process.env.HISTORY_DEBUG !== undefined
    ? process.env.HISTORY_DEBUG !== 'false'
    : projectConfig.debugLogsEnabled === true;
const MAX_DEBUG_LOGS = 5000;
const MAX_DEBUG_STRING_LENGTH = 500;
const DEBUG_LOG_TOKEN = process.env.DEBUG_LOG_TOKEN || null;

function loadProjectConfig() {
    try {
        const raw = fs.readFileSync(PROJECT_CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
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
        `window.TUNNEL_CONFIG=${JSON.stringify({ HISTORY_DEBUG })};`
    );
});

function shouldDisableStaticCache(filePath) {
    return [
        '.html',
        '.js',
        '.webmanifest',
        '.svg'
    ].some(ext => filePath.endsWith(ext));
}

// 静态文件服务 (限制目录遍历)
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
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/downloader', (req, res) => {
    res.sendFile(path.join(__dirname, 'downloader.html'));
});

app.get('/downloadList', (req, res) => {
    res.sendFile(path.join(__dirname, 'downloadList.html'));
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
        const { sessionId, fileId, deviceId } = req.body || {};
        if (!isValidSessionId(sessionId) || !isValidDeviceId(fileId)) {
            return res.status(400).json({ error: 'Invalid magnet payload' });
        }

        const session = sessions.get(sessionId);
        const record = session?.fileAssets?.get(fileId);
        if (!session || !record) {
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

app.get('/api/magnets', (req, res) => {
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
app.get('/api/sessions', (req, res) => {
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
            const fileCount = messages.filter(message => message.type === 'file' || message.fileInfo).length;
            totalMessages += messageCount;
            totalFiles += fileCount;
            const current = sessionMap.get(sessionId) || {
                id: sessionId,
                createdAt: session.createdAt,
                shortCode: session.shortCode || '',
                messageCount: 0,
                fileCount: 0
            };
            sessionMap.set(sessionId, {
                ...current,
                deviceCount: session.devices.size,
                createdAt: current.createdAt || session.createdAt,
                lastActivity: session.lastActivity,
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

app.get('/api/devices', (req, res) => {
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

app.delete('/api/sessions/:sessionId', (req, res) => {
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

app.get('/api/debug-logs', (req, res) => {
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
const SHORT_CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_MAGNETS = 1000;
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
        entry.message?.type === 'rich' && extractFileReferenceIds(entry.message.content).has(fileId)
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

    return historyMessage;
}

function summarizeHistoryMessage(message) {
    const fileInfo = message.fileInfo;
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
            
            // 存储设备socket映射
            deviceSockets.set(deviceId, socket);
            
            // 获取或创建会话
            if (!sessions.has(sessionId)) {
                sessions.set(sessionId, {
                devices: new Map(),
                editorAssets: new Map(),
                fileAssets: new Map(),
                history: [],
                deletedMessageIds: [],
                shortCode: createShortCode(sessionId, requestedShortCode),
                historySize: 0,
                    createdAt: Date.now(),
                    lastActivity: Date.now()
                });
            }
            
            const session = sessions.get(sessionId);
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
            }
            
            // 发送当前会话中的所有设备信息给新设备
            const deviceList = [];
            session.devices.forEach((d, id) => {
                if (id !== deviceId) {
                    deviceList.push({
                        deviceId: d.deviceId,
                        deviceName: d.deviceName,
                        joinedAt: d.joinedAt,
                        deviceModel: d.deviceModel,
                        localIp: d.localIp,
                        externalIp: d.externalIp
                    });
                }
            });
            
            socket.emit('session-devices', {
                devices: deviceList
            });
            socket.emit('session-short-code', { shortCode: session.shortCode });
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

            const historyMessages = session.history.map(entry => entry.message);
            historyLog('snapshot-sent', {
                sessionId,
                targetDeviceId: deviceId,
                targetSocketId: socket.id,
                clientIp,
                messageCount: historyMessages.length,
                messages: historyMessages.map(summarizeHistoryMessage)
            });
            socket.emit('session-history', {
                messages: historyMessages,
                deletedMessageIds: session.deletedMessageIds
            });
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
        } catch (err) {
            console.error('message error:', err);
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
            let fileStillReferenced = false;
            if (historyIndex >= 0) {
                const [removed] = session.history.splice(historyIndex, 1);
                session.historySize = Math.max(0, session.historySize - removed.size);
                fileId = removed.message?.fileInfo?.id || null;
                fileStillReferenced = isFileAssetStillReferenced(session, fileId);
                if (fileId && !fileStillReferenced) session.fileAssets?.delete(fileId);
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
                fileStillReferenced,
                historyCount: session.history.length
            });
        } catch (err) {
            console.error('delete-message error:', err);
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
                    !['text', 'rich', 'file'].includes(message.type) ||
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
