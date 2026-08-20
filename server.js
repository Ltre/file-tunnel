/**
 * 即时传输隧道 - Socket.io 服务器 (安全版本)
 * 用于会话管理和信令中转
 */

// ==================== 出站网络代理引导 ====================
// Node 的全局 fetch 只有在「进程启动时」设置了 NODE_USE_ENV_PROXY=1 才会读取
// HTTP_PROXY / HTTPS_PROXY 环境变量（运行期修改 process.env 无效）。
// 服务器若部署在无法直连 api.telegram.org 的网络环境（例如需要代理访问 Telegram），
// 则必须让 Telegram API 请求走代理。这里在启动阶段解析代理配置：如果已配置代理
// 但缺少该开关，则带着代理环境变量重新拉起一次本进程（仅一次），使 fetch 走代理。
// 代理统一使用两类环境变量：DR2T_PROXY（HTTP 代理）与 DR2T_ALL_PROXY（SOCKS/通用代理），
// 与 yt-dlp 的 buildYtDlpEnv 保持同一套命名；标准 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY 仅作兜底。
function resolveTelegramProxyUrl() {
    const candidates = [
        process.env.DR2T_PROXY,
        process.env.DR2T_ALL_PROXY,
        process.env.HTTPS_PROXY,
        process.env.HTTP_PROXY,
        process.env.ALL_PROXY
    ];
    for (const value of candidates) {
        const proxy = value && String(value).trim();
        if (proxy) return proxy;
    }
    return '';
}

if (!process.env.NODE_USE_ENV_PROXY && !process.env.DR2T_PROXY_REEXEC) {
    const telegramProxy = resolveTelegramProxyUrl();
    if (telegramProxy) {
        process.env.NODE_USE_ENV_PROXY = '1';
        process.env.DR2T_PROXY_REEXEC = '1';
        if (!process.env.HTTPS_PROXY && !process.env.https_proxy) process.env.HTTPS_PROXY = telegramProxy;
        if (!process.env.HTTP_PROXY && !process.env.http_proxy) process.env.HTTP_PROXY = telegramProxy;
        console.log(`🔌 检测到出站代理 ${telegramProxy}，以代理模式重新启动进程（Telegram API 将经代理访问）`);
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
            stdio: 'inherit',
            env: process.env,
            windowsHide: false
        });
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
            process.on(signal, () => { try { child.kill(signal); } catch (_) {} });
        }
        child.on('exit', (code, signal) => {
            process.exit(code ?? (signal ? 1 : 0));
        });
        // 父进程保持存活，等待子进程退出，以正确传递信号与退出码。
        setInterval(() => {}, 1 << 30);
        // 停止继续执行本模块，避免父进程再启动一份服务实例。
        return;
    }
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { spawn, spawnSync } = require('child_process');
const rateLimit = require('express-rate-limit');
const { registerFileAssetHandlers, cleanupFileAssetRelays, cleanupFileAssetAssignments } = require('./server/file-assets');
const { registerMediaHandlers, cleanupMediaDevice } = require('./server/media-session');
const { createInfraStore } = require('./server/infra-store');
const { createAdminAuth } = require('./server/admin-auth');
const { buildTelegramAudioMultipart } = require('./server/telegram-multipart');
const { normalizeLanguageCode, translateTelegramText, matchesTranslatedText } = require('./server/i18n');
const {
    createYoutubePremiumService,
    extractYoutubeMetadataYear,
    finalizeYoutubeMusicTrackNumber,
    findYoutubeMusicTrackPosition,
    rankYoutubeMusicAlbumCandidates,
    resolveYoutubeMusicOrdinalMetadata,
    getPreferredMusicAudioFormat,
    getPreferredPremiumVideoFormat,
    getSelectedFormatIds,
    normalizeYtDlpFormats,
    resolveYoutubePremiumMediaType,
    validateFormatSelection
} = require('./server/youtube-premium');

const app = express();
const PROJECT_CONFIG_PATH = path.join(__dirname, 'tunnel.config.json');
const MANIFEST_HOSTS_PATH = path.join(__dirname, 'manifest.hosts.json');
const SERVER_DATA_DIR = path.join(__dirname, '.tunnel-data');
const TELEGRAM_ASSET_DIR = path.join(SERVER_DATA_DIR, 'telegram-assets');
const SNS_MEDIA_WORK_DIR = path.join(SERVER_DATA_DIR, 'sns-media-work');
const SNS_MEDIA_TASK_DIR = path.join(SERVER_DATA_DIR, 'sns-media-tasks');
const YT_DLP_CACHE_DIR = path.join(SERVER_DATA_DIR, 'yt-dlp-cache');
const TELEGRAM_BOT_CONFIG_PATH = path.join(SERVER_DATA_DIR, 'telegram-bot.json');
const TELEGRAM_CHAT_TUNNELS_PATH = path.join(SERVER_DATA_DIR, 'telegram-chat-tunnels.json');
const TELEGRAM_PENDING_FILES_PATH = path.join(SERVER_DATA_DIR, 'telegram-pending-files.json');
const SNS_COOKIE_SYNC_CONFIG_PATH = path.join(SERVER_DATA_DIR, '.sns-cookie-sync.json');
const YOUTUBE_PREMIUM_COOKIE_PATH = path.join(SERVER_DATA_DIR, 'yt-premium-cookies.txt');
const YOUTUBE_PREMIUM_METADATA_CACHE_PATH = path.join(SERVER_DATA_DIR, 'youtube-premium-metadata-cache.json');
const SNS_COOKIE_FILES = Object.freeze({
    youtube: 'yt-cookies.txt',
    tiktok: 'tiktok-cookies.txt',
    facebook: 'facebook-cookies.txt',
    instagram: 'instagram-cookies.txt',
    thread: 'thread-cookies.txt',
    line: 'line-cookies.txt',
    twitter: 'twitter-cookies.txt',
    x: 'x-cookies.txt'
});
const SNS_COOKIE_DOMAINS = Object.freeze({
    youtube: ['youtube.com'],
    tiktok: ['tiktok.com'],
    facebook: ['facebook.com'],
    instagram: ['instagram.com'],
    thread: ['threads.com', 'threads.net', 'instagram.com'],
    line: ['line.me'],
    twitter: ['twitter.com', 'x.com'],
    x: ['x.com', 'twitter.com']
});
const SNS_COOKIE_LOGIN_NAMES = Object.freeze({
    youtube: /^(?:LOGIN_INFO|SID|HSID|SSID|APISID|SAPISID|__Secure-[13]P(?:SID|APISID)(?:TS|CC)?)$/,
    tiktok: /^(?:sessionid|sessionid_ss|sid_tt|sid_guard)$/i,
    facebook: /^(?:c_user|xs)$/i,
    instagram: /^(?:sessionid|ds_user_id)$/i,
    thread: /^(?:sessionid|ds_user_id)$/i,
    twitter: /^auth_token$/i,
    x: /^auth_token$/i
});
const LEGACY_SHORT_CODE_STORE_PATH = path.join(SERVER_DATA_DIR, 'short-codes.json');
const projectConfig = loadProjectConfig();
const manifestHostMap = loadManifestHostMap();
const FFMPEG_COMMAND = resolveMediaToolCommand('ffmpeg');
const FFPROBE_COMMAND = resolveMediaToolCommand('ffprobe');
let infraStore = null;
const adminAuth = createAdminAuth({ dataDir: SERVER_DATA_DIR, issuer: 'Instant Tunnel Admin' });
const youtubePremiumMetadataCache = loadYoutubePremiumMetadataCache();

function logYoutubePremiumTaskEvent(event = {}) {
    const taskId = String(event.taskId || '-').slice(0, 8);
    const elapsedSeconds = (Math.max(0, Number(event.elapsedMs) || 0) / 1000).toFixed(1);
    const prefix = `[YouTube Premium抓取][task:${taskId}][+${elapsedSeconds}s]`;
    const message = `${prefix} ${String(event.message || '任务事件')}`;
    const details = event.details && typeof event.details === 'object' ? event.details : {};
    const writer = event.level === 'error' ? console.error : event.level === 'warn' ? console.warn : console.log;
    if (Object.keys(details).length) writer.call(console, message, details);
    else writer.call(console, message);
}

const youtubePremiumService = createYoutubePremiumService({
    dataDir: SERVER_DATA_DIR,
    analyze: analyzeYoutubePremiumUrl,
    download: downloadYoutubePremiumTask,
    sanitizeError: sanitizeYoutubePremiumError,
    concurrency: Number(process.env.YOUTUBE_PREMIUM_DOWNLOAD_CONCURRENCY) || 1,
    onLog: logYoutubePremiumTaskEvent
});
const youtubePremiumCoverJobs = new Map();

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
    handler(req, res, next, options) {
        const language = normalizeLanguageCode(req.headers['accept-language'] || 'zh-Hans');
        res.status(options.statusCode).json({ error: translateTelegramText('请求过于频繁，请稍后再试', language) });
    },
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
const snsCookieSyncRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: { error: 'sns-cookie-sync-rate-limited' }
});
const youtubePremiumRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: { error: 'youtube-premium-rate-limited' }
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
const SUPPRESSED_HIGH_VOLUME_DEBUG_EVENTS = new Set([
    'file-asset-announced',
    'file-asset-available'
]);
const DEBUG_LOG_TOKEN = process.env.DEBUG_LOG_TOKEN || null;
const TELEGRAM_BOT_DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const TELEGRAM_REMARK_MAX_LENGTH = 2000;
const TELEGRAM_CLOUD_GET_FILE_MAX_SIZE = 20 * 1024 * 1024;
const TELEGRAM_GET_FILE_DOC_URL = 'https://core.telegram.org/bots/api#getfile';
let telegramConfig = loadTelegramBotConfig();

function normalizeTelegramBotConfig(config = {}) {
    const token = sanitizeString(config.token || '', 260);
    const webhookSecret = sanitizeString(config.webhookSecret || '', 160);
    const maxFileSize = Math.max(1, Number(config.maxFileSize || 500 * 1024 * 1024));
    const backupChatId = sanitizeString(config.backupChatId || '', 120);
    const songShareChannels = {
        base: sanitizeString(config.songShareChannels?.base || '', 120),
        pro: sanitizeString(config.songShareChannels?.pro || '', 120),
        ultimate: sanitizeString(config.songShareChannels?.ultimate || '', 120)
    };
    return {
        enabled: Boolean(token),
        token,
        webhookSecret,
        maxFileSize,
        backupChatId,
        songShareChannels
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

function writeDataFileAtomic(targetPath, content) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, content);
    try {
        fs.renameSync(tmpPath, targetPath);
    } catch (err) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
        fs.copyFileSync(tmpPath, targetPath);
        try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
}

function loadYoutubePremiumMetadataCache() {
    try {
        const stored = JSON.parse(fs.readFileSync(YOUTUBE_PREMIUM_METADATA_CACHE_PATH, 'utf8'));
        return new Map(Object.entries(stored && typeof stored === 'object' ? stored : {}));
    } catch (_) {
        return new Map();
    }
}

function setYoutubePremiumMetadataCache(url, patch) {
    const key = normalizeYoutubeSourceUrl(url);
    if (!key) return;
    youtubePremiumMetadataCache.set(key, {
        ...(youtubePremiumMetadataCache.get(key) || {}),
        ...patch,
        updatedAt: Date.now()
    });
    writeDataFileAtomic(YOUTUBE_PREMIUM_METADATA_CACHE_PATH, JSON.stringify(Object.fromEntries(youtubePremiumMetadataCache), null, 2));
}

function normalizeSnsCookiePlatform(platform) {
    const key = String(platform || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key === 'youtube' || key === 'yt' || key === 'ytmusic' || key === 'youtubemusic') {
        return 'youtube';
    }
    if (key === 'threads') return 'thread';
    if (Object.prototype.hasOwnProperty.call(SNS_COOKIE_FILES, key)) return key;
    return '';
}

function getSnsCookiePath(platform) {
    const normalized = normalizeSnsCookiePlatform(platform);
    const fileName = normalized ? SNS_COOKIE_FILES[normalized] : '';
    return fileName ? path.join(SERVER_DATA_DIR, fileName) : '';
}

function getSnsCookieFileForUrl(url) {
    const raw = String(url || '');
    if (/music\.youtube\.com/i.test(raw)) return getSnsCookiePath('youtube');
    if (/(?:youtube\.com|youtu\.be)/i.test(raw)) return getSnsCookiePath('youtube');
    if (/tiktok\.com/i.test(raw)) return getSnsCookiePath('tiktok');
    if (/(?:facebook\.com|fb\.watch)/i.test(raw)) return getSnsCookiePath('facebook');
    if (/instagram\.com/i.test(raw)) return getSnsCookiePath('instagram');
    if (/threads\.(?:com|net)/i.test(raw)) return getSnsCookiePath('thread');
    if (/line\.me/i.test(raw)) return getSnsCookiePath('line');
    if (/twitter\.com/i.test(raw)) return getSnsCookiePath('twitter');
    if (/x\.com/i.test(raw)) return getSnsCookiePath('x');
    return '';
}

function getSnsCookieEntries({ includeContent = false } = {}) {
    return Object.entries(SNS_COOKIE_FILES).map(([platform, fileName]) => {
        const filePath = path.join(SERVER_DATA_DIR, fileName);
        let content = '';
        let exists = false;
        let size = 0;
        let updatedAt = 0;
        try {
            const stat = fs.statSync(filePath);
            exists = stat.isFile() && stat.size > 0;
            size = stat.size;
            updatedAt = stat.mtimeMs;
            if (includeContent && stat.isFile()) content = fs.readFileSync(filePath, 'utf8');
        } catch (_) {}
        return { platform, fileName, exists, size, updatedAt, content };
    });
}

function getYoutubePremiumCookieStatus({ includeContent = false } = {}) {
    try {
        const stat = fs.statSync(YOUTUBE_PREMIUM_COOKIE_PATH);
        const status = {
            configured: stat.isFile() && stat.size > 0,
            fileName: path.basename(YOUTUBE_PREMIUM_COOKIE_PATH),
            size: stat.size,
            updatedAt: stat.mtimeMs
        };
        if (includeContent && stat.isFile()) status.content = fs.readFileSync(YOUTUBE_PREMIUM_COOKIE_PATH, 'utf8');
        return status;
    } catch (_) {
        return { configured: false, fileName: path.basename(YOUTUBE_PREMIUM_COOKIE_PATH), size: 0, updatedAt: 0, ...(includeContent ? { content: '' } : {}) };
    }
}

function saveYoutubePremiumCookies(rawContent) {
    const content = String(rawContent || '').replace(/\r\n?/g, '\n');
    if (!content.trim()) {
        try { fs.unlinkSync(YOUTUBE_PREMIUM_COOKIE_PATH); } catch (error) {
            if (error.code !== 'ENOENT') throw new Error('youtube-premium-cookie-save-failed');
        }
        return getYoutubePremiumCookieStatus();
    }
    const prepared = prepareSyncedSnsCookies('youtube', content);
    try {
        writeDataFileAtomic(YOUTUBE_PREMIUM_COOKIE_PATH, prepared.content);
    } catch (_) {
        throw new Error('youtube-premium-cookie-save-failed');
    }
    try { fs.chmodSync(YOUTUBE_PREMIUM_COOKIE_PATH, 0o600); } catch (_) {}
    return getYoutubePremiumCookieStatus();
}

function readSnsCookieSyncConfig() {
    try {
        const config = JSON.parse(fs.readFileSync(SNS_COOKIE_SYNC_CONFIG_PATH, 'utf8'));
        return /^[a-f0-9]{64}$/i.test(config?.tokenHash || '') ? config : null;
    } catch (_) {
        return null;
    }
}

function createSnsCookieSyncToken() {
    const token = crypto.randomBytes(32).toString('base64url');
    const config = {
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        createdAt: new Date().toISOString()
    };
    writeDataFileAtomic(SNS_COOKIE_SYNC_CONFIG_PATH, JSON.stringify(config, null, 2));
    try { fs.chmodSync(SNS_COOKIE_SYNC_CONFIG_PATH, 0o600); } catch (_) {}
    return { token, createdAt: config.createdAt };
}

function requireSnsCookieSyncToken(req, res, next) {
    const config = readSnsCookieSyncConfig();
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    const candidate = match?.[1] || '';
    if (!config || !candidate) return res.status(401).json({ error: 'sns-cookie-sync-auth-required' });
    const actual = crypto.createHash('sha256').update(candidate).digest();
    const expected = Buffer.from(config.tokenHash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        return res.status(401).json({ error: 'sns-cookie-sync-auth-invalid' });
    }
    next();
}

function prepareSyncedSnsCookies(platform, rawContent) {
    const normalizedPlatform = normalizeSnsCookiePlatform(platform);
    if (!normalizedPlatform) throw new Error('invalid-platform');
    const content = String(rawContent || '').replace(/\r\n?/g, '\n').trimEnd();
    if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw new Error('cookie-file-too-large');
    if (!/^# (?:Netscape )?HTTP Cookie File/im.test(content)) throw new Error('invalid-netscape-cookie-header');
    const rows = content.split('\n').flatMap(line => {
        if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) return [];
        const fields = line.split('\t');
        if (fields.length < 7) return [];
        return [{
            domain: String(fields[0] || '').replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase(),
            name: String(fields[5] || '')
        }];
    });
    const domains = SNS_COOKIE_DOMAINS[normalizedPlatform] || [];
    const platformRows = rows.filter(row => domains.some(domain => row.domain === domain || row.domain.endsWith(`.${domain}`)));
    if (!platformRows.length) throw new Error(`${normalizedPlatform}-cookie-domain-missing`);
    const loginPattern = SNS_COOKIE_LOGIN_NAMES[normalizedPlatform];
    if (loginPattern && !platformRows.some(row => loginPattern.test(row.name))) {
        throw new Error(`${normalizedPlatform}-login-cookie-missing`);
    }
    return {
        platform: normalizedPlatform,
        content: `${content}\n`,
        size: Buffer.byteLength(content, 'utf8')
    };
}

function saveSyncedSnsCookieFiles(entries) {
    entries.forEach(entry => writeDataFileAtomic(getSnsCookiePath(entry.platform), entry.content));
    sessions.forEach((session, sessionId) => {
        resumePendingSnsMetadataScans(sessionId, session.history.map(entry => entry.message));
    });
    return Object.fromEntries(entries.map(entry => [entry.platform, { size: entry.size }]));
}

function getSnsCookieSyncErrorStatus(message) {
    if (message === 'cookie-file-too-large') return 413;
    if (message === 'invalid-platform' || message === 'invalid-netscape-cookie-header' || /-(?:cookie-domain|login-cookie)-missing$/.test(message)) return 422;
    return 500;
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

function loadTelegramPendingFiles() {
    try {
        const entries = JSON.parse(fs.readFileSync(TELEGRAM_PENDING_FILES_PATH, 'utf8'));
        return new Map((Array.isArray(entries) ? entries : []).filter(entry =>
            Array.isArray(entry) && entry.length === 2 && entry[0] &&
            ['text', 'files'].includes(entry[1]?.kind)
        ));
    } catch (_) {
        return new Map();
    }
}

function persistTelegramPendingFiles() {
    writeDataFileAtomic(TELEGRAM_PENDING_FILES_PATH, JSON.stringify(Array.from(telegramPendingFiles.entries()), null, 2));
}

function setTelegramPendingFile(chatKey, pending) {
    telegramPendingFiles.set(String(chatKey), pending);
    persistTelegramPendingFiles();
}

function deleteTelegramPendingFile(chatKey) {
    const deleted = telegramPendingFiles.delete(String(chatKey));
    if (deleted) persistTelegramPendingFiles();
    return deleted;
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

function locateExecutable(command) {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    try {
        const result = spawnSync(locator, [command], {
            encoding: 'utf8',
            windowsHide: true,
            env: { ...process.env }
        });
        if (result.status !== 0) return '';
        return String(result.stdout || '').split(/\r?\n/).map(value => value.trim()).find(Boolean) || '';
    } catch (_) {
        return '';
    }
}

function getConfiguredFfmpegLocation() {
    if (process.env.FFMPEG_LOCATION) return String(process.env.FFMPEG_LOCATION).trim();

    const configured = projectConfig.ffmpegLocation ?? projectConfig.ffmpegPath;
    if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
        const profile = String(projectConfig.deployment?.profile || '').trim();
        return profile && typeof configured[profile] === 'string'
            ? configured[profile].trim()
            : '';
    }
    return typeof configured === 'string' ? configured.trim() : '';
}

function resolveMediaToolCommand(toolName) {
    const envValue = toolName === 'ffmpeg' ? process.env.FFMPEG_BIN : process.env.FFPROBE_BIN;
    const configValue = toolName === 'ffmpeg' ? projectConfig.ffmpegBin : projectConfig.ffprobeBin;
    const explicit = String(envValue || configValue || '').trim();
    if (explicit) return explicit;

    const location = getConfiguredFfmpegLocation();
    if (location) {
        try {
            const stat = fs.statSync(location);
            if (stat.isDirectory()) {
                return path.join(location, process.platform === 'win32' ? `${toolName}.exe` : toolName);
            }
            if (stat.isFile()) {
                if (path.basename(location).toLowerCase().startsWith(toolName)) return location;
                return path.join(path.dirname(location), process.platform === 'win32' ? `${toolName}.exe` : toolName);
            }
        } catch (_) {
            const looksLikeExecutable = path.extname(location) || path.basename(location).toLowerCase().startsWith('ffmpeg');
            if (looksLikeExecutable) {
                return toolName === 'ffmpeg'
                    ? location
                    : path.join(path.dirname(location), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
            }
            return path.join(location, process.platform === 'win32' ? `${toolName}.exe` : toolName);
        }
    }
    return locateExecutable(toolName) || toolName;
}

function getYtDlpFfmpegArgs() {
    const configuredLocation = getConfiguredFfmpegLocation();
    return configuredLocation ? ['--ffmpeg-location', configuredLocation] : [];
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
app.use(express.json({ limit: '2mb' }));

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
        const hadServerCopy = fs.existsSync(asset.path);
        await ensureTelegramServerAssetFile(asset);
        const stat = fs.statSync(asset.path);
        const totalSize = stat.size;
        let start = 0;
        let end = Math.max(0, totalSize - 1);
        let statusCode = 200;
        const range = String(req.headers.range || '');
        if (range) {
            const match = range.match(/^bytes=(\d*)-(\d*)$/);
            if (match) {
                if (match[1]) start = Math.min(Number(match[1]) || 0, end);
                if (match[2]) end = Math.min(Number(match[2]) || end, totalSize - 1);
                if (start > end || start >= totalSize) {
                    res.setHeader('Content-Range', `bytes */${totalSize}`);
                    return res.status(416).end();
                }
                statusCode = 206;
                res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
            }
        }
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Type', asset.type || 'application/octet-stream');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('X-Drop2Tunnel-Asset-Origin', hadServerCopy
            ? 'server-cache'
            : isRecoverableSnsAsset(asset) ? 'sns-refetch' : 'telegram-refetch');
        res.setHeader('Content-Length', String(end - start + 1));
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(asset.name || 'file')}"`);
        res.status(statusCode);
        telegramAssetReaders.set(assetId, (telegramAssetReaders.get(assetId) || 0) + 1);
        let released = false;
        const release = completed => {
            if (released) return;
            released = true;
            const readers = Math.max(0, (telegramAssetReaders.get(assetId) || 1) - 1);
            if (readers) telegramAssetReaders.set(assetId, readers);
            else telegramAssetReaders.delete(assetId);
            if (completed && !readers) removeConfirmedServerAssetFile(asset);
        };
        res.once('finish', () => release(true));
        res.once('close', () => release(res.writableFinished));
        fs.createReadStream(asset.path, { start, end }).on('error', err => {
            release(false);
            if (!res.headersSent) res.status(500).json({ error: 'Asset read failed' });
            else res.destroy(err);
        }).pipe(res);
    } catch (err) {
        console.warn(`Telegram/SNS asset ${assetId} fetch failed: ${err.message}`);
        if (!res.headersSent) {
            const message = String(err?.message || '');
            const error = /YouTube 要求登录验证|sign in to confirm you(?:'|’)?re not a bot|cookies?.*(?:no longer valid|rotated)/i.test(message)
                ? 'SNS 原链接重新获取失败：YouTube Cookie 已失效或不完整，请管理员在 /sns-cookies 重新保存有效 Cookie'
                : /YouTube 签名解析组件不可用/i.test(message)
                    ? message
                    : 'server-asset-fetch-failed';
            res.status(502).json({ error });
        }
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
    handleTelegramUpdate(req.body).catch(err => {
        recordExternalDependencyEvent('telegram-bot-api', 'webhook-update-handler', {
            level: 'error', endpoint: '/api/telegram/webhook', error: err,
            hint: 'Telegram webhook payload/semantics may have changed, or this update exposed an integration incompatibility.',
            details: { updateId: Number(req.body?.update_id) || undefined, updateKeys: Object.keys(req.body || {}).slice(0, 20) }
        });
    });
});
function normalizeStaticPath(filePath) {
    return filePath.replace(/\\/g, '/');
}

function shouldUseImmutableStaticCache(filePath) {
    const normalized = normalizeStaticPath(filePath);
    return /\/assets\/[^/]+\.[a-f0-9]{10}\.(?:min\.)?(?:js|css|json|svg|png|jpg|jpeg|webp|woff2?)$/i.test(normalized);
}

function shouldRevalidateStaticCache(filePath) {
    const normalized = normalizeStaticPath(filePath);
    return [
        '.html',
        '.webmanifest'
    ].some(ext => normalized.endsWith(ext)) ||
        normalized.endsWith('/service-worker.js') ||
        normalized.endsWith('/runtime-config.js') ||
        (!normalized.includes('/assets/') && normalized.endsWith('.js'));
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
    res.sendFile(path.join(__dirname, 'pages', 'admin-auth.html'));
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


app.post('/api/light-transfer/network/:taskId', async (req, res) => {
    const taskId = String(req.params.taskId || '').trim().toLowerCase();
    const providerDeviceId = String(req.query.provider || '').trim();
    const indices = [...new Set((Array.isArray(req.body?.indices) ? req.body.indices : [])
        .map(Number)
        .filter(index => Number.isInteger(index) && index >= 0 && index < 100000000))].slice(0, 32);
    if (!/^[a-f0-9]{64}$/.test(taskId) || !isValidDeviceId(providerDeviceId) || !indices.length) {
        return res.status(400).json({ error: 'invalid-light-network-request' });
    }
    const requestId = crypto.randomUUID();
    const targets = emitToDevice(providerDeviceId, 'light-network-chunks-request', { requestId, taskId, indices });
    if (!targets.length) return res.status(503).json({ error: 'light-provider-offline' });
    let settled = false;
    const finish = (status, payload) => {
        if (settled || res.headersSent) return;
        settled = true;
        const pending = lightNetworkPendingRequests.get(requestId);
        if (pending?.timer) clearTimeout(pending.timer);
        lightNetworkPendingRequests.delete(requestId);
        res.status(status).json(payload);
    };
    const timer = setTimeout(() => finish(504, { error: 'light-provider-timeout' }), 3500);
    lightNetworkPendingRequests.set(requestId, { providerDeviceId, taskId, timer, finish });
});

// ---- Download status report endpoint ----
// Receivers POST their progress here; the sender polls GET to see who's downloading
app.post('/api/light-transfer/report/:taskId', async (req, res) => {
    const taskId = String(req.params.taskId || '').trim().toLowerCase();
    const providerDeviceId = String(req.query.provider || '').trim();
    const body = req.body || {};
    const receiverId = String(body.receiverId || '').trim().slice(0, 64);
    if (!/^[a-f0-9]{64}$/.test(taskId) || !receiverId) {
        return res.status(400).json({ error: 'invalid-report-request' });
    }
    const now = Date.now();
    let reportMap = lightDownloadReports.get(taskId);
    if (!reportMap) { reportMap = new Map(); lightDownloadReports.set(taskId, reportMap); }
    // Purge stale entries
    for (const [id, entry] of reportMap) {
        if (now - entry.updatedAt > LIGHT_REPORT_TTL) reportMap.delete(id);
    }
    reportMap.set(receiverId, {
        receiverId,
        receiverName: String(body.receiverName || '').slice(0, 80),
        received: Number(body.received) || 0,
        blockCount: Number(body.blockCount) || 0,
        percent: Number(body.percent) || 0,
        receivedBytes: Number(body.receivedBytes) || 0,
        totalSize: Number(body.totalSize) || 0,
        status: String(body.status || 'receiving').slice(0, 20),
        updatedAt: now
    });
    // If status is terminal, schedule cleanup
    if (['completed', 'closed'].includes(String(body.status))) {
        setTimeout(() => {
            const m = lightDownloadReports.get(taskId);
            if (m) { m.delete(receiverId); if (!m.size) lightDownloadReports.delete(taskId); }
        }, 5000);
    }
    res.json({ ok: true });
});

app.get('/api/light-transfer/report/:taskId', async (req, res) => {
    const taskId = String(req.params.taskId || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(taskId)) {
        return res.status(400).json({ error: 'invalid-task-id' });
    }
    const now = Date.now();
    const reportMap = lightDownloadReports.get(taskId);
    const downloaders = [];
    if (reportMap) {
        for (const [id, entry] of reportMap) {
            if (now - entry.updatedAt > LIGHT_REPORT_TTL) { reportMap.delete(id); continue; }
            downloaders.push(entry);
        }
    }
    res.json({ taskId, downloaders });
});

app.get(['/light-file-parts', '/light-file-parts.html'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'pages', 'light-file-parts.html'));
});

app.get('/record/:sessionId/:messageId', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'pages', 'index.html'));
});

// 根路径 - 提供 pages/index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages', 'index.html'));
});

//禁止直接从pages目录，以无校验态访问管理页面
app.use([
    '/pages/admin.html',
    '/pages/tgbot.html',
    '/pages/sns-cookies.html',
    '/pages/youtube-premium-dl.html'
], adminAuth.requireAuth);

app.use(express.static(path.join(__dirname), {
    dotfiles: 'deny',
    index: false,
    setHeaders: (res, filePath) => {
        if (shouldUseImmutableStaticCache(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (shouldRevalidateStaticCache(filePath)) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
    }
}));

// 从 pages/ 目录提供 HTML 文件（显式路由，避免暴露 admin.html 和 tgbot.html）
app.get('/admin-auth.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages', 'admin-auth.html'));
});
app.get('/device.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages', 'device.html'));
});
app.get('/downloader.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages', 'downloader.html'));
});
app.get('/downloadList.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages', 'downloadList.html'));
});

// 管理后台API
app.get('/admin', (req, res) => {
    if (!adminAuth.isAuthenticated(req)) return adminAuth.requireAuth(req, res, () => {});
    res.sendFile(path.join(__dirname, 'pages', 'admin.html'));
});

app.get('/tgbot', (req, res) => {
    if (!adminAuth.isAuthenticated(req)) return adminAuth.requireAuth(req, res, () => {});
    res.sendFile(path.join(__dirname, 'pages', 'tgbot.html'));
});

app.get(['/sns-cookies', '/sns-cookies.html'], (req, res) => {
    if (!adminAuth.isAuthenticated(req)) return adminAuth.requireAuth(req, res, () => {});
    res.sendFile(path.join(__dirname, 'pages', 'sns-cookies.html'));
});

app.get('/youtube-premium-dl', (req, res) => {
    if (!adminAuth.isAuthenticated(req)) return adminAuth.requireAuth(req, res, () => {});
    res.sendFile(path.join(__dirname, 'pages', 'youtube-premium-dl.html'));
});

app.get('/api/sns-cookies', adminAuth.requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        platforms: getSnsCookieEntries({ includeContent: true }),
        youtubePremium: getYoutubePremiumCookieStatus({ includeContent: true })
    });
});

app.post('/api/youtube-premium/cookies', adminAuth.requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        res.json({ ok: true, ...saveYoutubePremiumCookies(req.body?.content) });
    } catch (error) {
        res.status(getSnsCookieSyncErrorStatus(error.message)).json({ error: sanitizeYoutubePremiumError(error) });
    }
});

app.get('/api/youtube-premium/setup-status', adminAuth.requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const premiumCookie = getYoutubePremiumCookieStatus();
    const telegram = loadTelegramBotConfig();
    const channels = telegram.songShareChannels || {};
    const channelStatus = {
        base: Boolean(String(channels.base || '').trim()),
        pro: Boolean(String(channels.pro || '').trim()),
        ultimate: Boolean(String(channels.ultimate || '').trim())
    };
    const status = {
        youtubePremiumCookie: {
            configured: premiumCookie.configured,
            updatedAt: premiumCookie.updatedAt || 0
        },
        telegramBotToken: {
            configured: Boolean(telegram.token)
        },
        telegramSongShareChannels: {
            configured: Object.values(channelStatus).every(Boolean),
            channels: channelStatus
        }
    };
    res.json({
        ...status,
        complete: status.youtubePremiumCookie.configured
            && status.telegramBotToken.configured
            && status.telegramSongShareChannels.configured
    });
});

app.get('/api/sns-cookie-sync', adminAuth.requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const config = readSnsCookieSyncConfig();
    res.json({ configured: Boolean(config), createdAt: config?.createdAt || '' });
});

app.post('/api/sns-cookie-sync/token', adminAuth.requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, ...createSnsCookieSyncToken() });
});

app.delete('/api/sns-cookie-sync/token', adminAuth.requireAuth, (req, res) => {
    try { fs.unlinkSync(SNS_COOKIE_SYNC_CONFIG_PATH); } catch (err) {
        if (err.code !== 'ENOENT') return res.status(500).json({ error: 'sns-cookie-sync-revoke-failed' });
    }
    res.json({ ok: true });
});

app.post('/api/sns-cookie-sync', snsCookieSyncRateLimit, requireSnsCookieSyncToken, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const source = req.body?.platforms;
        if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('invalid-platform');
        const entries = Object.entries(source).map(([platform, content]) => prepareSyncedSnsCookies(platform, content));
        if (!entries.length) throw new Error('invalid-platform');
        const premium = Object.prototype.hasOwnProperty.call(req.body || {}, 'youtubePremium')
            ? saveYoutubePremiumCookies(req.body.youtubePremium)
            : null;
        res.json({
            ok: true,
            platforms: saveSyncedSnsCookieFiles(entries),
            youtubePremium: premium ? { configured: premium.configured, size: premium.size, updatedAt: premium.updatedAt } : null,
            updatedAt: Date.now()
        });
    } catch (err) {
        res.status(getSnsCookieSyncErrorStatus(err.message)).json({ error: err.message || 'sns-cookie-sync-save-failed' });
    }
});

app.post('/api/sns-cookie-sync/:platform', snsCookieSyncRateLimit, requireSnsCookieSyncToken, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const entry = prepareSyncedSnsCookies(req.params.platform, req.body?.content);
        const result = saveSyncedSnsCookieFiles([entry]);
        res.json({ ok: true, platform: entry.platform, size: result[entry.platform].size, updatedAt: Date.now() });
    } catch (err) {
        res.status(getSnsCookieSyncErrorStatus(err.message)).json({ error: err.message || 'sns-cookie-sync-save-failed' });
    }
});

app.post('/api/sns-cookies/:platform', adminAuth.requireAuth, (req, res) => {
    try {
        const platform = normalizeSnsCookiePlatform(req.params.platform);
        if (!platform) return res.status(400).json({ error: 'invalid-platform' });
        const filePath = getSnsCookiePath(platform);
        const content = String(req.body?.content || '').replace(/\r\n/g, '\n');
        if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
            return res.status(413).json({ error: 'cookie-file-too-large' });
        }
        if (content.trim()) {
            writeDataFileAtomic(filePath, content.endsWith('\n') ? content : `${content}\n`);
        } else {
            try { fs.unlinkSync(filePath); } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }
        }
        if (platform === 'youtube') {
            sessions.forEach((session, sessionId) => {
                resumePendingSnsMetadataScans(sessionId, session.history.map(entry => entry.message));
            });
        }
        res.json({ ok: true, platform, fileName: SNS_COOKIE_FILES[platform] });
    } catch (err) {
        console.error('sns-cookies-save error:', err);
        res.status(500).json({ error: 'save-failed', message: err.message });
    }
});

app.post('/api/youtube-premium/formats', adminAuth.requireAuth, youtubePremiumRateLimit, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const url = normalizeYoutubeSourceUrl(req.body?.url);
        const cacheField = req.body?.asMusic === true ? 'musicAnalysis' : 'analysis';
        let analysis = req.body?.refresh === true ? null : youtubePremiumMetadataCache.get(url)?.[cacheField];
        if (!analysis) {
            analysis = await analyzeYoutubePremiumUrl(req.body?.url, {
                includeFormats: true,
                forceMusic: req.body?.asMusic === true
            });
        } else {
            analysis = await enrichYoutubePremiumAnalysisOrdinals(analysis, {
                cookiePath: requireYoutubePremiumCookies()
            });
        }
        setYoutubePremiumMetadataCache(url, {
            [cacheField]: analysis,
            referenceInfo: analysis.referenceInfo
        });
        res.json(analysis);
    } catch (error) {
        res.status(422).json({ error: sanitizeYoutubePremiumError(error) });
    }
});

app.get('/api/youtube-premium/tasks', adminAuth.requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(youtubePremiumService.list(req.query.page, req.query.pageSize));
});

app.get('/api/youtube-premium/tasks/:taskId', adminAuth.requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const task = youtubePremiumService.get(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'youtube-premium-task-not-found' });
    res.json(task);
});

app.patch('/api/youtube-premium/tasks/:taskId', adminAuth.requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const task = youtubePremiumService.updateDetails(req.params.taskId, req.body);
    if (!task) return res.status(404).json({ error: 'youtube-premium-task-not-found' });
    res.json(task);
});

app.get('/api/youtube-premium/tasks/:taskId/song-metadata', adminAuth.requireAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const task = youtubePremiumService.get(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'youtube-premium-task-not-found' });
    if (task.mediaType !== 'song') return res.status(409).json({ error: 'youtube-premium-task-not-song' });
    try {
        let metadata = task.songMetadata;
        if (!metadata) {
            const file = youtubePremiumService.getFile(task.id);
            const tags = file ? (await probeMediaFile(file.path)).format?.tags || {} : {};
            metadata = normalizeEditableSongMetadata({
                ...tags,
                album_artist: tags.album_artist || tags.album_artist_sort,
                date: tags.date || tags.year
            });
        }
        const cacheKey = normalizeYoutubeSourceUrl(task.url);
        const forceRefresh = req.query.refresh === '1';
        let referenceInfo = forceRefresh ? null : youtubePremiumMetadataCache.get(cacheKey)?.referenceInfo;
        referenceInfo ||= forceRefresh ? null : youtubePremiumService.getReferenceInfo(task.id);
        if (!referenceInfo || referenceInfo.sourceLanguageCheckCompleted !== true) {
            referenceInfo = await collectYoutubeReferenceInfo(task.url, {
                cookiePath: requireYoutubePremiumCookies(),
                bypassCache: forceRefresh
            });
        }
        setYoutubePremiumMetadataCache(cacheKey, { referenceInfo });
        youtubePremiumService.setReferenceInfo(task.id, referenceInfo);
        res.json({ metadata, referenceInfo });
    } catch (error) {
        res.status(422).json({ error: sanitizeYoutubePremiumError(error) });
    }
});

app.put('/api/youtube-premium/tasks/:taskId/song-metadata', adminAuth.requireAuth, youtubePremiumRateLimit, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        res.json(await rewriteYoutubePremiumSongMetadata(req.params.taskId, req.body));
    } catch (error) {
        const status = error.message === 'youtube-premium-task-not-found' ? 404 : 422;
        res.status(status).json({ error: sanitizeYoutubePremiumError(error) });
    }
});

app.post('/api/youtube-premium/tasks', adminAuth.requireAuth, youtubePremiumRateLimit, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        res.status(202).json(youtubePremiumService.create(req.body));
    } catch (error) {
        res.status(422).json({ error: sanitizeYoutubePremiumError(error) });
    }
});

app.post('/api/youtube-premium/tasks/:taskId/cancel', adminAuth.requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const task = youtubePremiumService.cancel(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'youtube-premium-task-not-found' });
    res.json(task);
});

app.post('/api/youtube-premium/tasks/:taskId/clear', adminAuth.requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const task = youtubePremiumService.clear(req.params.taskId);
        if (!task) return res.status(404).json({ error: 'youtube-premium-task-not-found' });
        res.json(task);
    } catch (error) {
        res.status(409).json({ error: sanitizeYoutubePremiumError(error) });
    }
});

app.post('/api/youtube-premium/tasks/:taskId/retry', adminAuth.requireAuth, youtubePremiumRateLimit, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const task = youtubePremiumService.retry(req.params.taskId);
        if (!task) return res.status(404).json({ error: 'youtube-premium-task-not-found' });
        res.status(202).json(task);
    } catch (error) {
        res.status(409).json({ error: sanitizeYoutubePremiumError(error) });
    }
});

app.delete('/api/youtube-premium/tasks/:taskId', adminAuth.requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        if (!youtubePremiumService.remove(req.params.taskId)) return res.status(404).json({ error: 'youtube-premium-task-not-found' });
        res.json({ ok: true });
    } catch (error) {
        res.status(409).json({ error: sanitizeYoutubePremiumError(error) });
    }
});

app.get('/api/youtube-premium/tasks/:taskId/file', adminAuth.requireAuth, (req, res) => {
    const file = youtubePremiumService.getFile(req.params.taskId);
    if (!file) return res.status(404).json({ error: 'youtube-premium-file-not-found' });
    const stat = fs.statSync(file.path);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', `"ytp-${req.params.taskId}-${stat.size}-${Math.trunc(stat.mtimeMs)}"`);
    if (req.query.inline === '1') {
        res.type(file.name);
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        return res.sendFile(file.path);
    }
    res.download(file.path, file.name);
});

app.get('/api/youtube-premium/tasks/:taskId/info', adminAuth.requireAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const file = youtubePremiumService.getFile(req.params.taskId);
    if (!file) return res.status(404).json({ error: 'youtube-premium-file-not-found' });
    try {
        const probe = await probeMediaFile(file.path);
        const video = probe.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
        const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
        const [rateNumber, rateDivisor] = String(video?.avg_frame_rate || video?.r_frame_rate || '').split('/').map(Number);
        res.json({
            name: file.name,
            size: fs.statSync(file.path).size,
            mimeType: getMimeTypeFromFileName(file.name),
            container: String(probe.format?.format_long_name || probe.format?.format_name || ''),
            duration: Number(probe.format?.duration || video?.duration || audio?.duration) || 0,
            bitRate: Number(probe.format?.bit_rate) || 0,
            resolution: video?.width && video?.height ? `${video.width} × ${video.height}` : '',
            frameRate: rateNumber ? rateNumber / (rateDivisor || 1) : 0,
            videoCodec: String(video?.codec_long_name || video?.codec_name || ''),
            videoProfile: String(video?.profile || ''),
            pixelFormat: String(video?.pix_fmt || ''),
            videoBitRate: Number(video?.bit_rate) || 0,
            audioCodec: String(audio?.codec_long_name || audio?.codec_name || ''),
            audioBitRate: Number(audio?.bit_rate) || 0,
            sampleRate: Number(audio?.sample_rate) || 0,
            channels: Number(audio?.channels) || 0,
            channelLayout: String(audio?.channel_layout || '')
        });
    } catch (error) {
        res.status(422).json({ error: sanitizeYoutubePremiumError(error) });
    }
});

app.post('/api/youtube-premium/tasks/:taskId/thumbnail', adminAuth.requireAuth, youtubePremiumRateLimit, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let thumbnail;
    try {
        thumbnail = await downloadYoutubePremiumOriginalThumbnail(req.params.taskId);
        res.setHeader('X-Download-Name', encodeURIComponent(thumbnail.name));
        res.download(thumbnail.path, thumbnail.name, error => {
            thumbnail.cleanup();
            if (error && !res.headersSent) res.status(500).json({ error: sanitizeYoutubePremiumError(error) });
        });
    } catch (error) {
        thumbnail?.cleanup();
        res.status(error.message === 'youtube-premium-task-not-found' ? 404 : 422)
            .json({ error: sanitizeYoutubePremiumError(error) });
    }
});

app.post('/api/youtube-premium/tasks/:taskId/forward', adminAuth.requireAuth, youtubePremiumRateLimit, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let upload;
    try {
        const task = youtubePremiumService.get(req.params.taskId);
        if (!task) throw new Error('youtube-premium-file-not-found');
        const sessionId = req.query?.sessionId;
        if (!isValidSessionId(sessionId) || !infraStore?.getTunnel(sessionId)) {
            throw new Error('youtube-premium-target-tunnel-not-found');
        }
        upload = await receiveYoutubePremiumForwardUpload(req, task);
        res.status(201).json(await forwardYoutubePremiumTaskToTunnel(
            req.params.taskId,
            sessionId,
            upload
        ));
    } catch (error) {
        if (upload?.path) fs.rmSync(upload.path, { force: true });
        res.status(422).json({ error: sanitizeYoutubePremiumError(error) });
    }
});

app.get('/api/youtube-premium/tasks/:taskId/cover', adminAuth.requireAuth, async (req, res) => {
    try {
        const file = youtubePremiumService.getFile(req.params.taskId, 'cover') ||
            await ensureYoutubePremiumTaskCover(req.params.taskId);
        if (!file) return res.status(404).end();
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.sendFile(file.path);
    } catch (_) {
        res.status(404).end();
    }
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
        backupChatId: config.backupChatId || '',
        songShareChannels: config.songShareChannels || { base: '', pro: '', ultimate: '' }
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
            backupChatId: req.body?.backupChatId ?? currentConfig.backupChatId,
            songShareChannels: {
                base: req.body?.songShareChannels?.base ?? currentConfig.songShareChannels?.base ?? '',
                pro: req.body?.songShareChannels?.pro ?? currentConfig.songShareChannels?.pro ?? '',
                ultimate: req.body?.songShareChannels?.ultimate ?? currentConfig.songShareChannels?.ultimate ?? ''
            }
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
            await Promise.all(['en', 'ja', 'fr', 'ru', 'es', 'it', 'ko', 'ms', 'id', 'vi', 'th'].map(languageCode =>
                telegramApi('setMyCommands', {
                    language_code: languageCode,
                    commands: [
                        { command: 'tunnel', description: translateTelegramText('进入指定的传输隧道中转模式', languageCode) },
                        { command: 'leave_tunnel', description: translateTelegramText('退出当前隧道中转模式', languageCode) }
                    ]
                }, nextConfig.token)
            ));
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
            webhookRegistered,
            songShareChannels: config.songShareChannels || { base: '', pro: '', ultimate: '' }
        });
    } catch (err) {
        console.error('save telegram config error:', err);
        res.status(500).json({ ok: false, error: 'save-telegram-config-failed' });
    }
});

// ---- Telegram song share: send song file + captioned records to Base/Pro/Ultimate channels ----
function resolveTelegramChatId(input) {
    const value = String(input || '').trim();
    if (!value) return '';
    // @username format
    if (/^@[A-Za-z0-9_]{3,64}$/.test(value)) return value;
    // t.me/username format
    const match = value.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{3,64})/);
    if (match) return `@${match[1]}`;
    // numeric chat ID (e.g. -1001234567890)
    if (/^-?\d{5,20}$/.test(value)) return value;
    return value;
}

// ==================== Telegram 歌曲分享（转发到频道，带进度汇报） ====================
// POST 立即返回 jobId，实际发送在后台异步执行；前端轮询 GET /api/telegram/song-share/:jobId
// 查看每一步的细节/状态与最终结果（Telegram 消息链接）。最终结果持久化到任务记录的 telegramShare 字段。
const telegramSongShareJobs = new Map();
const SONG_SHARE_JOB_TTL_MS = 30 * 60 * 1000;

function pruneSongShareJobs() {
    const cutoff = Date.now() - SONG_SHARE_JOB_TTL_MS;
    for (const [jobId, job] of telegramSongShareJobs) {
        if (job.updatedAt < cutoff) telegramSongShareJobs.delete(jobId);
    }
}

function touchSongShareJob(job) {
    job.updatedAt = Date.now();
}

function formatSongShareBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let size = bytes;
    let unit = units[0];
    for (const candidate of units) {
        size /= 1024;
        unit = candidate;
        if (size < 1024 || candidate === units[units.length - 1]) break;
    }
    return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${unit}`;
}

function logSongShare(job, message, details) {
    const jobId = String(job?.jobId || '-').slice(0, 8);
    const taskId = String(job?.taskId || '-').slice(0, 8);
    const elapsedSeconds = job?.createdAt ? ((Date.now() - job.createdAt) / 1000).toFixed(1) : '0.0';
    const prefix = `[Telegram歌曲转发][job:${jobId}][task:${taskId}][+${elapsedSeconds}s]`;
    if (details && typeof details === 'object' && Object.keys(details).length) console.log(`${prefix} ${message}`, details);
    else console.log(`${prefix} ${message}`);
}

function setSongShareStep(job, key, patch) {
    const step = job.steps.find(s => s.key === key);
    if (step) {
        Object.assign(step, patch);
        if (patch?.status || patch?.detail) {
            logSongShare(job, `步骤「${step.label}」${patch.status ? ` → ${patch.status}` : ''}`, patch.detail ? { detail: patch.detail } : undefined);
        }
    }
    touchSongShareJob(job);
}

function createSongShareUploadReporter(job, totalBytes) {
    let lastPercentBucket = -1;
    let lastLogAt = 0;
    return (uploadedBytes, total = totalBytes) => {
        const safeTotal = Math.max(1, Number(total) || Number(totalBytes) || 1);
        const safeUploaded = Math.min(safeTotal, Math.max(0, Number(uploadedBytes) || 0));
        const percent = Math.min(100, safeUploaded / safeTotal * 100);
        const bucket = Math.floor(percent / 5);
        const now = Date.now();
        if (safeUploaded !== 0 && safeUploaded !== safeTotal && bucket <= lastPercentBucket && now - lastLogAt < 5000) return;
        lastPercentBucket = Math.max(lastPercentBucket, bucket);
        lastLogAt = now;
        const detail = `正在上传 Telegram 音频：${percent.toFixed(percent >= 10 ? 0 : 1)}%（${formatSongShareBytes(safeUploaded)} / ${formatSongShareBytes(safeTotal)}）`;
        const step = job.steps.find(item => item.key === 'base-audio');
        if (step?.status === 'running') {
            step.detail = detail;
            touchSongShareJob(job);
        }
        logSongShare(job, 'Telegram 音频上传进度', {
            percent: Number(percent.toFixed(1)),
            uploaded: formatSongShareBytes(safeUploaded),
            total: formatSongShareBytes(safeTotal)
        });
    };
}

function publicSongShareJob(job) {
    return {
        jobId: job.jobId,
        taskId: job.taskId,
        status: job.status,
        steps: job.steps,
        messages: job.messages,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt
    };
}

app.post('/api/telegram/song-share', adminAuth.requireAuth, async (req, res) => {
    if (!isTelegramBotEnabled()) return res.status(503).json({ error: 'telegram-bot-disabled' });
    const config = loadTelegramBotConfig();
    const channels = config.songShareChannels || {};
    const body = req.body || {};

    // Resolve channel targets
    const baseChat = resolveTelegramChatId(body.baseChannel || channels.base);
    const proChat = body.proChannel ? resolveTelegramChatId(body.proChannel) : resolveTelegramChatId(channels.pro);
    const ultimateChat = body.ultimateChannel ? resolveTelegramChatId(body.ultimateChannel) : resolveTelegramChatId(channels.ultimate);

    if (!baseChat) return res.status(400).json({ error: 'base-channel-not-configured' });
    const sendPro = Boolean(body.sendPro);
    const sendUltimate = Boolean(body.sendUltimate);
    if (sendUltimate && !sendPro) return res.status(400).json({ error: 'ultimate-requires-pro' });
    if (sendUltimate && !ultimateChat) return res.status(400).json({ error: 'ultimate-channel-not-configured' });
    if (sendPro && !proChat) return res.status(400).json({ error: 'pro-channel-not-configured' });

    // Ultimate mode: 'formal' (图文记录) or 'trial' (入选试行)
    const ultimateMode = body.ultimateMode === 'trial' ? 'trial' : 'formal';

    // Caption text: "艺术家 - 歌曲名"
    const captionBase = String(body.captionBase || '').trim().slice(0, 200) || '未知 - 未知';
    const captionPro = String(body.captionPro || '').trim().slice(0, 200) || captionBase;
    const captionUltimate = String(body.captionUltimate || '').trim().slice(0, 200) || captionBase;

    // Cover image: each channel level is independent.
    // Empty string means this level explicitly uses the task's square default cover;
    // a data URL means this level uses the resolved original/custom image.
    // Do not fall back Pro/Ultimate to Base here, otherwise an explicit square selection
    // would be overwritten by Base's original/custom cover.
    const coverBase = String(body.coverBase || '').trim();
    const coverPro = String(body.coverPro || '').trim();
    const coverUltimate = String(body.coverUltimate || '').trim();

    // Song file from YouTube Premium task
    const taskId = String(body.taskId || '').trim();
    if (!taskId) return res.status(400).json({ error: 'task-id-required' });

    // 构建进度步骤（根据是否勾选 Pro/Ultimate 动态决定步骤数）
    const steps = [
        { key: 'prepare', label: '读取歌曲文件与封面', status: 'pending', detail: '', link: '' },
        { key: 'base-audio', label: '发送歌曲到 Base 频道', status: 'pending', detail: '', link: '' },
        { key: 'base-tb', label: '发送 Base 图文记录', status: 'pending', detail: '', link: '' }
    ];
    if (sendPro) steps.push({ key: 'pro-tp', label: '发送 Pro 图文记录', status: 'pending', detail: '', link: '' });
    if (sendUltimate) steps.push({ key: 'ultimate', label: ultimateMode === 'trial' ? '发送 Ultimate 记录（入选试行）' : '发送 Ultimate 记录（正式图文）', status: 'pending', detail: '', link: '' });

    const job = {
        jobId: crypto.randomUUID(),
        taskId,
        status: 'running',
        steps,
        messages: [],
        error: '',
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    telegramSongShareJobs.set(job.jobId, job);
    pruneSongShareJobs();
    logSongShare(job, '已创建转发任务', {
        baseChannel: baseChat,
        proChannel: sendPro ? proChat : '未选择',
        ultimateChannel: sendUltimate ? ultimateChat : '未选择',
        ultimateMode: sendUltimate ? ultimateMode : '未选择',
        coverModes: {
            base: coverBase ? '原尺寸/自定义封面' : '任务方形封面',
            pro: sendPro ? (coverPro ? '原尺寸/自定义封面' : '任务方形封面') : '未发送',
            ultimate: sendUltimate ? (coverUltimate ? '原尺寸/自定义封面' : '任务方形封面') : '未发送'
        }
    });

    // 后台异步执行，不阻塞响应
    runSongShareJob(job, {
        baseChat, proChat, ultimateChat,
        sendPro, sendUltimate, ultimateMode,
        captionBase, captionPro, captionUltimate,
        coverBase, coverPro, coverUltimate
    }).catch(() => {});

    res.json({ ok: true, jobId: job.jobId });
});

app.get('/api/telegram/song-share/:jobId', adminAuth.requireAuth, (req, res) => {
    const job = telegramSongShareJobs.get(String(req.params.jobId || ''));
    if (!job) return res.status(404).json({ error: 'song-share-job-not-found' });
    res.json(publicSongShareJob(job));
});

async function runSongShareJob(job, params) {
    const {
        baseChat, proChat, ultimateChat,
        sendPro, sendUltimate, ultimateMode,
        captionBase, captionPro, captionUltimate,
        coverBase, coverPro, coverUltimate
    } = params;

    // 已创建消息日志：[{ role, label, chatId, messageId, link }]，仅记录实际创建成功的消息
    const createdMessages = [];

    async function rollback() {
        // Delete in reverse order
        logSongShare(job, '开始回滚已发送的 Telegram 消息', { count: createdMessages.length });
        for (let i = createdMessages.length - 1; i >= 0; i--) {
            const { chatId, messageId, label } = createdMessages[i];
            try {
                logSongShare(job, `回滚删除「${label}」`, { chatId, messageId });
                await telegramApi('deleteMessage', { chat_id: chatId, message_id: messageId });
            } catch (error) {
                logSongShare(job, `回滚删除「${label}」失败（继续处理其余消息）`, { error: describeTelegramNetworkError(error) });
            }
        }
    }

    async function sendPhotoWithCaption(chatId, photoData, caption, defaultCoverPath = '', role = '图文记录') {
        // Send photo with caption via multipart form
        const form = new FormData();
        form.set('chat_id', chatId);
        form.set('caption', caption);
        const effectiveCover = (photoData === 'original' || !photoData) ? defaultCoverPath : photoData;
        let coverBytes = 0;
        let coverSource = '无封面';
        if (effectiveCover) {
            if (effectiveCover.startsWith('data:')) {
                // base64 data URL
                const resp = await fetch(effectiveCover);
                const blob = await resp.blob();
                coverBytes = blob.size;
                coverSource = '浏览器上传/原尺寸封面';
                form.set('photo', blob, 'cover.jpg');
            } else if (fs.existsSync(effectiveCover)) {
                // file path
                const buffer = await fs.promises.readFile(effectiveCover);
                coverBytes = buffer.length;
                coverSource = 'YouTube Premium 任务封面';
                form.set('photo', new Blob([buffer]), 'cover.jpg');
            }
        }
        logSongShare(job, `开始上传 Telegram ${role}`, {
            chatId,
            coverSource,
            coverSize: formatSongShareBytes(coverBytes),
            captionChars: String(caption || '').length
        });
        const result = await telegramFetchJson('sendPhoto', {
            method: 'POST',
            body: form
        }, { operation: 'song-share-sendPhoto' });
        logSongShare(job, `Telegram ${role}上传完成`, { chatId, messageId: result.result?.message_id || '' });
        return result.result;
    }

    async function prepareTelegramAudioThumbnail(sourcePath) {
        if (!sourcePath || !fs.existsSync(sourcePath)) {
            logSongShare(job, '任务没有可用封面，Telegram 音频将不附带 thumbnail');
            return null;
        }
        fs.mkdirSync(SNS_MEDIA_WORK_DIR, { recursive: true });
        const outputPath = path.join(SNS_MEDIA_WORK_DIR, `telegram-audio-thumb-${crypto.randomBytes(8).toString('hex')}.jpg`);
        const qualityLevels = [5, 8, 12, 18, 24];
        try {
            for (const quality of qualityLevels) {
                logSongShare(job, '正在生成 Telegram 音频 thumbnail', { quality, source: path.basename(sourcePath) });
                await spawnCapture(FFMPEG_COMMAND, [
                    '-y', '-hide_banner', '-loglevel', 'error', '-i', sourcePath,
                    '-vf', 'scale=320:320:force_original_aspect_ratio=decrease',
                    '-frames:v', '1', '-q:v', String(quality), outputPath
                ], { timeoutMs: 60000, timeoutError: 'telegram-audio-thumbnail-timeout' });
                const thumbnailSize = fs.statSync(outputPath).size;
                logSongShare(job, 'Telegram 音频 thumbnail 已生成', { quality, size: formatSongShareBytes(thumbnailSize) });
                if (thumbnailSize < 200 * 1024) {
                    return {
                        path: outputPath,
                        cleanup: () => { try { fs.rmSync(outputPath, { force: true }); } catch (_) {} }
                    };
                }
            }
            throw new Error('telegram-audio-thumbnail-too-large');
        } catch (error) {
            try { fs.rmSync(outputPath, { force: true }); } catch (_) {}
            throw error;
        }
    }

    async function sendAudioFile(chatId, audioPath, fileName, caption, options = {}) {
        const request = buildTelegramAudioMultipart({
            fields: {
                chat_id: chatId,
                caption,
                performer: options.performer ? String(options.performer) : '',
                title: options.title ? String(options.title) : ''
            },
            audioPath,
            audioFileName: fileName,
            thumbnailPath: options.thumbnailPath || '',
            onAudioProgress: createSongShareUploadReporter(job, fs.statSync(audioPath).size)
        });
        logSongShare(job, '开始向 Telegram 上传歌曲文件', {
            chatId,
            fileName,
            audioSize: formatSongShareBytes(request.audioSize),
            thumbnailSize: formatSongShareBytes(request.thumbnailSize),
            requestSize: formatSongShareBytes(request.contentLength),
            performer: options.performer || '',
            title: options.title || ''
        });
        const result = await telegramFetchJson('sendAudio', {
            method: 'POST',
            headers: {
                'Content-Type': request.contentType,
                'Content-Length': String(request.contentLength)
            },
            body: request.body,
            duplex: 'half'
        }, { operation: 'song-share-sendAudio' });
        logSongShare(job, 'Telegram 歌曲文件上传完成并收到 API 响应', {
            chatId,
            messageId: result.result?.message_id || '',
            telegramFileSize: formatSongShareBytes(result.result?.audio?.file_size || request.audioSize)
        });
        return result.result;
    }

    function getMessageTmeLink(chatId, messageId) {
        // For public channels, chatId is @username; link is t.me/username/msgId
        if (typeof chatId === 'string' && chatId.startsWith('@')) {
            return `https://t.me/${chatId.slice(1)}/${messageId}`;
        }
        // For private channels (numeric -100...), link is t.me/c/internalId/msgId
        const match = String(chatId).match(/^-100(\d+)$/);
        if (match) return `https://t.me/c/${match[1]}/${messageId}`;
        return '';
    }

    try {
        // Step 1: Get the already-resolved YouTube information and song file from the
        // completed Premium task. Sharing must not execute yt-dlp or hit YouTube again.
        setSongShareStep(job, 'prepare', { status: 'running', detail: '正在获取 YouTube Premium 任务信息…' });
        const taskInfo = youtubePremiumService.get(job.taskId);
        if (!taskInfo) throw new Error('youtube-premium-task-not-found');
        logSongShare(job, '已获取 YouTube Premium 任务信息（读取任务缓存，不重复请求 YouTube）', {
            sourceUrl: taskInfo.url || '',
            title: taskInfo.title || '',
            mediaType: taskInfo.mediaType || '',
            status: taskInfo.status || '',
            artist: taskInfo.songMetadata?.artist || '',
            album: taskInfo.songMetadata?.album || ''
        });
        const fileResult = youtubePremiumService.getFile(job.taskId, 'output');
        if (!fileResult) throw new Error('song-file-not-found');
        const fileName = fileResult.name || 'song.m4a';
        const audioStat = await fs.promises.stat(fileResult.path);

        // Also try to get the cover image path
        const coverFileResult = youtubePremiumService.getFile(job.taskId, 'cover');
        const defaultCoverPath = coverFileResult?.path || '';
        logSongShare(job, '已确认待发送文件', {
            audioPath: fileResult.path,
            audioFileName: fileName,
            audioSize: formatSongShareBytes(audioStat.size),
            audioMime: getMimeTypeFromFileName(fileName),
            coverPath: defaultCoverPath || '无'
        });
        setSongShareStep(job, 'prepare', { status: 'done', detail: `已读取 ${fileName}（${formatSongShareBytes(audioStat.size)}）` });

        // Step 2: Send song file to Base channel
        setSongShareStep(job, 'base-audio', { status: 'running', detail: '正在生成 Telegram 音频封面并上传音频（可能较慢）…' });
        const telegramAudioThumbnail = await prepareTelegramAudioThumbnail(defaultCoverPath);
        let baseAudioMsg;
        try {
            baseAudioMsg = await sendAudioFile(baseChat, fileResult.path, fileName, '', {
                thumbnailPath: telegramAudioThumbnail?.path || '',
                performer: taskInfo?.songMetadata?.artist || '',
                title: taskInfo?.songMetadata?.title || taskInfo?.title || ''
            });
        } finally {
            telegramAudioThumbnail?.cleanup?.();
        }
        if (!baseAudioMsg?.message_id) throw new Error('base-audio-send-failed');
        const baseAudioLink = getMessageTmeLink(baseChat, baseAudioMsg.message_id);
        createdMessages.push({ role: 'base-audio', label: 'Base 音频', chatId: baseChat, messageId: baseAudioMsg.message_id, link: baseAudioLink });
        setSongShareStep(job, 'base-audio', {
            status: 'done',
            detail: baseAudioMsg.audio?.thumbnail ? '已发送（Telegram 已返回歌曲封面缩略图）' : '已发送（Telegram 未返回歌曲封面缩略图）',
            link: baseAudioLink
        });

        // Step 3: Send Tb (Base captioned record: cover + caption + baseAudioLink)
        setSongShareStep(job, 'base-tb', { status: 'running', detail: '正在发送图文记录…' });
        const tbCaption = `${captionBase}\n\n${baseAudioLink}`;
        const tbMsg = await sendPhotoWithCaption(baseChat, coverBase, tbCaption, defaultCoverPath, 'Base 图文记录');
        if (!tbMsg?.message_id) throw new Error('tb-send-failed');
        const tbLink = getMessageTmeLink(baseChat, tbMsg.message_id);
        createdMessages.push({ role: 'base-tb', label: 'Base 图文记录', chatId: baseChat, messageId: tbMsg.message_id, link: tbLink });
        setSongShareStep(job, 'base-tb', { status: 'done', detail: '已发送', link: tbLink });

        // Step 4: If Pro selected, send Tp (cover + caption + tbLink)
        if (sendPro) {
            setSongShareStep(job, 'pro-tp', { status: 'running', detail: '正在发送…' });
            const tpCaption = `${captionPro}\n\n${tbLink}`;
            const tpMsg = await sendPhotoWithCaption(proChat, coverPro, tpCaption, defaultCoverPath, 'Pro 图文记录');
            if (!tpMsg?.message_id) throw new Error('tp-send-failed');
            const tpLink = getMessageTmeLink(proChat, tpMsg.message_id);
            createdMessages.push({ role: 'pro-tp', label: 'Pro 图文记录', chatId: proChat, messageId: tpMsg.message_id, link: tpLink });
            setSongShareStep(job, 'pro-tp', { status: 'done', detail: '已发送', link: tpLink });

            // Step 5: If Ultimate selected
            if (sendUltimate) {
                setSongShareStep(job, 'ultimate', { status: 'running', detail: '正在发送…' });
                let ultMsg;
                if (ultimateMode === 'formal') {
                    // Formal: cover + caption + tpLink
                    const ultCaption = `${captionUltimate}\n\n${tpLink}`;
                    ultMsg = await sendPhotoWithCaption(ultimateChat, coverUltimate, ultCaption, defaultCoverPath, 'Ultimate 正式图文记录');
                    if (!ultMsg?.message_id) throw new Error('ultimate-formal-send-failed');
                    const ultLink = getMessageTmeLink(ultimateChat, ultMsg.message_id);
                    createdMessages.push({ role: 'ultimate', label: 'Ultimate 记录', chatId: ultimateChat, messageId: ultMsg.message_id, link: ultLink });
                    setSongShareStep(job, 'ultimate', { status: 'done', detail: '已发送', link: ultLink });
                } else {
                    // Trial: "入选试行：\n" + a Bot API text_link entity whose visible text is
                    // exactly the user-edited "艺术家 - 歌曲名" and whose URL is the Pro Tp.
                    // Do not rely on parse_mode here: explicit entities avoid HTML/Markdown
                    // parsing differences and let us verify that Telegram actually created the link.
                    if (!tpLink) throw new Error('telegram-pro-tp-link-unavailable');
                    const trialPrefix = '入选试行：\n';
                    const trialText = `${trialPrefix}${captionUltimate}`;
                    const trialEntity = {
                        type: 'text_link',
                        offset: trialPrefix.length,
                        length: captionUltimate.length,
                        url: tpLink
                    };
                    const trialMsg = await telegramApi('sendMessage', {
                        chat_id: ultimateChat,
                        text: trialText,
                        entities: [trialEntity],
                        link_preview_options: { is_disabled: true },
                        disable_web_page_preview: true
                    });
                    if (!trialMsg?.message_id) throw new Error('ultimate-trial-send-failed');
                    const returnedEntities = Array.isArray(trialMsg.entities) ? trialMsg.entities : [];
                    const linkedToTp = returnedEntities.some(entity =>
                        entity?.type === 'text_link' &&
                        Number(entity.offset) === trialEntity.offset &&
                        Number(entity.length) === trialEntity.length &&
                        String(entity.url || '') === tpLink
                    );
                    if (!linkedToTp) throw new Error('ultimate-trial-link-entity-missing');
                    const ultLink = getMessageTmeLink(ultimateChat, trialMsg.message_id);
                    createdMessages.push({ role: 'ultimate', label: 'Ultimate 记录', chatId: ultimateChat, messageId: trialMsg.message_id, link: ultLink });
                    setSongShareStep(job, 'ultimate', { status: 'done', detail: '已发送（文案已链接到 Pro Tp）', link: ultLink });
                }
            }
        }

        // 持久化发送结果到任务记录，供前端「已发到telegram」按钮展示链接
        const shareMessages = createdMessages.map(m => ({ role: m.role, label: m.label, link: m.link }));
        youtubePremiumService.setTelegramShare(job.taskId, { messages: shareMessages, sharedAt: Date.now() });

        job.status = 'completed';
        job.messages = shareMessages;
        touchSongShareJob(job);
        logSongShare(job, '转发任务全部完成', { messages: shareMessages });
    } catch (err) {
        const message = describeTelegramNetworkError(err) || 'song-share-failed';
        const runningStep = job.steps.find(s => s.status === 'running');
        if (runningStep) setSongShareStep(job, runningStep.key, { status: 'failed', detail: message });
        if (createdMessages.length) {
            await rollback();
            // 提示用户已回滚
            if (runningStep) setSongShareStep(job, runningStep.key, { status: 'failed', detail: `${message}（已回滚删除已发送的消息）` });
        }
        console.error(`[Telegram歌曲转发][job:${String(job.jobId).slice(0, 8)}][task:${String(job.taskId).slice(0, 8)}] 转发失败:`, err);
        job.status = 'failed';
        job.error = message;
        touchSongShareJob(job);
    }
}

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
        if (!isTelegramBotOriginAsset(asset)) {
            results.push({ assetId, valid: false, repairable: false, reason: 'not-telegram-bot-origin' });
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
    if (!isTelegramBotOriginAsset(asset)) return res.status(409).json({ error: 'not-telegram-bot-origin' });
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
    res.sendFile(path.join(__dirname, 'pages', 'downloader.html'));
});

app.get('/downloadList', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages', 'downloadList.html'));
});

app.get('/device/:deviceId', (req, res) => {
    if (!isValidDeviceId(req.params.deviceId)) return res.status(400).send('Invalid device id');
    res.sendFile(path.join(__dirname, 'pages', 'device.html'));
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
        oldestRetainedAt: debugLogs[0]?.timestamp || null,
        newestRetainedAt: debugLogs[debugLogs.length - 1]?.timestamp || null,
        matchedCount: logs.length,
        returnedCount: Math.min(logs.length, limit),
        logs: logs.slice(-limit)
    });
});

app.get('/api/admin/external-dependencies', adminAuth.requireAuth, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const logs = debugLogs.filter(entry => entry.source === 'external-dependency').slice(-limit);
    res.json({
        generatedAt: new Date().toISOString(),
        dependencies: EXTERNAL_DEPENDENCY_REGISTRY,
        recentEvents: logs
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
const EXTERNAL_DEPENDENCY_REGISTRY = Object.freeze([
    {
        id: 'telegram-bot-api',
        kind: 'remote-api',
        systems: ['api.telegram.org', 'Telegram Bot API / file API / webhook'],
        integrationPoints: ['telegramApi', 'sendPhoto', 'sendAudio', 'sendDocument', 'downloadTelegramFile', '/api/telegram/webhook'],
        impact: 'Bot API schema/limits/auth/network changes can break tunnel forwarding, backups and song-channel publishing.'
    },
    {
        id: 'youtube-yt-dlp',
        kind: 'remote-crawler',
        systems: ['youtube.com', 'music.youtube.com', 'yt-dlp YouTube extractor'],
        integrationPoints: ['runYtDlpJson', 'spawnYtDlpCapture', 'YouTube Premium analysis/download', 'YouTube metadata/reference lookup'],
        impact: 'YouTube page/player/signature/cookie/extractor changes can break parsing, formats, metadata and downloads.'
    },
    {
        id: 'sns-yt-dlp',
        kind: 'remote-crawler',
        systems: ['TikTok', 'Facebook', 'Instagram', 'Threads', 'LINE', 'Twitter/X', 'yt-dlp extractors'],
        integrationPoints: ['SNS URL parse/metadata scan', 'runYtDlpJson', 'runYtDlpDownload'],
        impact: 'Third-party page/API/login/extractor changes can break SNS parsing or media recovery.'
    },
    {
        id: 'yt-dlp-remote-components',
        kind: 'remote-component',
        systems: ['yt-dlp remote JS components', 'configured component provider (for example GitHub)'],
        integrationPoints: ['getYtDlpRemoteComponentArgs'],
        impact: 'Remote component availability/version changes can break YouTube signature solving.'
    },
    {
        id: 'webrtc-ice-services',
        kind: 'remote-network-service',
        systems: ['Google public STUN', 'Cloudflare public STUN', 'stunprotocol.org public STUN', 'runtime-configured STUN/TURN services'],
        integrationPoints: ['app.js createPeerConnection', 'client/media.js RTC config', 'client/device-camera.js RTC config'],
        impact: 'STUN/TURN availability, DNS, credentials or policy changes can reduce or prevent WebRTC connectivity.'
    },
    {
        id: 'local-media-toolchain',
        kind: 'external-runtime',
        systems: ['yt-dlp', 'yt-dlp-ejs/JS runtime', 'ffmpeg', 'ffprobe'],
        integrationPoints: ['getYtDlpInvocation', 'spawnYtDlpCapture', 'spawnCapture', 'probeMediaFile'],
        impact: 'Missing/incompatible executable versions can break crawler extraction, remuxing, thumbnails and probing.'
    }
]);
const editorAssetRelays = new Map();
const shortCodes = new Map();
const magnets = new Map();
const accessDevices = new Map();
const nearbyPresence = new Map();
const sessionHistoryBroadcastTimers = new Map();
const telegramPendingFiles = loadTelegramPendingFiles();
const telegramChatTunnels = loadTelegramChatTunnels();
const telegramServerAssets = new Map();
const telegramMediaGroups = new Map();
const telegramProcessedUpdates = new Map();
const telegramAwaitingTunnelCode = new Set();
const telegramChatLanguages = new Map();
const telegramAssetDownloads = new Map();
const telegramAssetReaders = new Map();
const snsMediaTasks = new Map();
const snsMetadataScans = new Set();
const snsMediaTaskWaiters = [];
let activeSnsMediaTasks = 0;

async function acquireSnsMediaTaskSlot() {
    const limit = Math.max(1, Math.min(8, Number(process.env.SOCIAL_MAX_CONCURRENT_TASKS || 2)));
    if (activeSnsMediaTasks < limit) {
        activeSnsMediaTasks++;
    } else {
        await new Promise(resolve => snsMediaTaskWaiters.push(resolve));
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const next = snsMediaTaskWaiters.shift();
        if (next) {
            next();
        } else {
            activeSnsMediaTasks = Math.max(0, activeSnsMediaTasks - 1);
        }
    };
}

const DEFAULT_TUNNEL_PERMISSIONS = Object.freeze({
    read: true,
    sendText: true,
    sendRich: true,
    sendFile: true,
    delete: true,
    collaborativeEdit: true,
    globalIntercom: true,
    groupVoice: true
});

function normalizeTunnelPermissions(value = {}) {
    return Object.fromEntries(Object.keys(DEFAULT_TUNNEL_PERMISSIONS)
        .map(key => [key, value?.[key] !== false]));
}

function normalizeTunnelAdminRecords(value = {}) {
    const records = {};
    if (!value || typeof value !== 'object') return records;
    Object.entries(value).forEach(([rawDeviceId, rawRecord]) => {
        const deviceId = sanitizeString(rawDeviceId, 80);
        if (!isValidDeviceId(deviceId)) return;
        const source = rawRecord && typeof rawRecord === 'object' ? rawRecord : {};
        records[deviceId] = {
            deviceId,
            deviceName: sanitizeString(source.deviceName || source.name || '', 80),
            permissions: normalizeTunnelPermissions(source.permissions || source),
            grantedBy: sanitizeString(source.grantedBy || '', 80),
            createdAt: Number(source.createdAt) || Date.now(),
            updatedAt: Number(source.updatedAt) || Date.now()
        };
    });
    return records;
}

function parseStoredTunnelAccess(value) {
    try {
        const parsed = typeof value === 'string' && value ? JSON.parse(value) : (value || {});
        if (parsed && typeof parsed === 'object' && (parsed.permissions || parsed.admins)) {
            return {
                permissions: normalizeTunnelPermissions(parsed.permissions || {}),
                admins: normalizeTunnelAdminRecords(parsed.admins || {})
            };
        }
        return { permissions: normalizeTunnelPermissions(parsed), admins: {} };
    } catch {
        return { permissions: normalizeTunnelPermissions(), admins: {} };
    }
}

function parseStoredTunnelPermissions(value) {
    return parseStoredTunnelAccess(value).permissions;
}

function parseStoredTunnelAdmins(value) {
    return parseStoredTunnelAccess(value).admins;
}

function serializeTunnelAccess(permissions = {}, admins = {}) {
    return {
        permissions: normalizeTunnelPermissions(permissions),
        admins: normalizeTunnelAdminRecords(admins)
    };
}

function getTunnelAdminRecord(session, deviceId) {
    if (!session || !deviceId || !session.admins) return null;
    return session.admins[deviceId] || null;
}

function canManageTunnel(session, deviceId) {
    return Boolean(session && deviceId && (!session.ownerDeviceId || session.ownerDeviceId === deviceId));
}

function canUseTunnelCapability(session, deviceId, capability) {
    if (!session || !deviceId) return false;
    if (!session.ownerDeviceId || session.ownerDeviceId === deviceId) return true;
    const adminRecord = getTunnelAdminRecord(session, deviceId);
    if (adminRecord) return adminRecord.permissions?.[capability] !== false;
    return session.permissions?.[capability] !== false;
}

function getSessionPermissionPayload(session, deviceId = '') {
    const admins = normalizeTunnelAdminRecords(session?.admins || {});
    return {
        ownerDeviceId: session?.ownerDeviceId || '',
        permissions: normalizeTunnelPermissions(session?.permissions || {}),
        adminDevices: Object.values(admins).map(record => ({
            deviceId: record.deviceId,
            deviceName: record.deviceName || session?.devices?.get(record.deviceId)?.deviceName || '',
            permissions: normalizeTunnelPermissions(record.permissions),
            grantedBy: record.grantedBy || '',
            createdAt: record.createdAt || Date.now(),
            updatedAt: record.updatedAt || Date.now()
        })),
        isOwner: Boolean(session && deviceId && (!session.ownerDeviceId || session.ownerDeviceId === deviceId)),
        isAdmin: Boolean(deviceId && admins[deviceId]),
        selfAdminPermissions: deviceId && admins[deviceId] ? normalizeTunnelPermissions(admins[deviceId].permissions) : null
    };
}

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

const lightNetworkPendingRequests = new Map();
// Download status reports: taskId → Map(receiverId → { ...report, updatedAt })
const lightDownloadReports = new Map();
const LIGHT_REPORT_TTL = 5 * 60 * 1000;
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
    const normalizedEvent = sanitizeString(event, 120);
    if (SUPPRESSED_HIGH_VOLUME_DEBUG_EVENTS.has(normalizedEvent)) return null;
    const entry = {
        timestamp: new Date().toISOString(),
        source,
        event: normalizedEvent,
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

function describeExternalEndpoint(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, MAX_DEBUG_STRING_LENGTH);
    } catch (_) {
        return raw.replace(/bot\d+:[^/\s]+/gi, 'bot[redacted]').slice(0, MAX_DEBUG_STRING_LENGTH);
    }
}

function recordExternalDependencyEvent(dependency, operation, options = {}) {
    const level = ['info', 'warn', 'error'].includes(options.level) ? options.level : 'warn';
    const dependencyId = sanitizeString(dependency || 'unknown-external', 80);
    const operationName = sanitizeString(operation || 'unknown-operation', 100);
    const error = options.error;
    const details = {
        dependency: dependencyId,
        operation: operationName,
        level,
        endpoint: describeExternalEndpoint(options.endpoint),
        upstreamStatus: Number(options.upstreamStatus) || undefined,
        errorCode: sanitizeString(error?.cause?.code || error?.code || options.errorCode || '', 80),
        error: sanitizeString(error?.message || options.message || '', 500),
        hint: sanitizeString(options.hint || '', 500),
        ...sanitizeDebugValue(options.details || {})
    };
    const entry = recordDebugLog({
        source: 'external-dependency',
        event: `${dependencyId}:${operationName}:${level}`,
        details
    });
    const method = level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'info');
    console[method](`[external-dependency][${dependencyId}][${operationName}]`, details);
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

function isTelegramBotOriginAsset(asset) {
    const source = String(asset?.source || '');
    if (asset?.snsTaskId || asset?.snsMediaItemId || /^sns(?:-|$)/.test(source)) return false;
    return source === 'telegram-bot' || Boolean(asset?.fileId || asset?.fileUniqueId || asset?.fileIdHistory?.length);
}

function isRecoverableSnsAsset(asset) {
    if (!/^sns(?:-|$)/.test(String(asset?.source || '')) || !asset?.sourceUrl || !asset?.snsTaskId) return false;
    const task = readSnsTask(asset.snsTaskId);
    return Boolean(task?.sourceUrl && task?.sessionId === asset.sessionId);
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
        source: sanitizeString(asset.source || '', 40),
        sourceUrl: sanitizeString(asset.sourceUrl || '', 1000),
        sourceMessageId: sanitizeString(asset.sourceMessageId || '', 80),
        snsMediaItemId: sanitizeString(asset.snsMediaItemId || '', 80),
        snsTaskId: sanitizeString(asset.snsTaskId || '', 80),
        youtubeVideoId: sanitizeString(asset.youtubeVideoId || '', 80),
        mediaKind: sanitizeString(asset.mediaKind || '', 40),
        fileId: asset.fileId || '',
        fileUniqueId: asset.fileUniqueId || '',
        fileIdUpdatedAt: Number(asset.fileIdUpdatedAt) || 0,
        lastFileIdCheckedAt: Number(asset.lastFileIdCheckedAt) || 0,
        cacheConfirmedAt: Number(asset.cacheConfirmedAt) || 0,
        cacheConfirmedBy: sanitizeString(asset.cacheConfirmedBy || '', 80),
        temporaryFileRemovedAt: Number(asset.temporaryFileRemovedAt) || 0,
        fileIdHistory: Array.isArray(asset.fileIdHistory) ? asset.fileIdHistory.slice(-20) : []
    }));
}

function resolveTelegramServerAsset(assetId) {
    if (!isValidServerAssetId(assetId)) return null;
    const cached = telegramServerAssets.get(assetId);
    if (cached && (cached.fileId || fs.existsSync(cached.path) || isRecoverableSnsAsset(cached))) return cached;

    const assetPath = path.join(TELEGRAM_ASSET_DIR, assetId);
    let metadata = {};
    try {
        metadata = JSON.parse(fs.readFileSync(getTelegramAssetMetadataPath(assetId), 'utf8'));
    } catch (_) {
        // Assets created before metadata persistence remain downloadable.
    }
    const hasFile = fs.existsSync(assetPath) && fs.statSync(assetPath).isFile();
    if (!hasFile && !metadata.fileId && !isRecoverableSnsAsset(metadata)) return null;
    const stat = hasFile ? fs.statSync(assetPath) : null;
    const asset = {
        id: assetId,
        path: assetPath,
        name: sanitizeString(metadata.name || assetId, 180) || assetId,
        type: sanitizeString(metadata.type || 'application/octet-stream', 100) || 'application/octet-stream',
        size: Number(metadata.size) || stat?.size || 0,
        sessionId: isValidSessionId(metadata.sessionId) ? metadata.sessionId : '',
        createdAt: Number(metadata.createdAt) || stat?.birthtimeMs || stat?.mtimeMs || Date.now(),
        source: sanitizeString(metadata.source || '', 40),
        sourceUrl: sanitizeString(metadata.sourceUrl || '', 1000),
        sourceMessageId: sanitizeString(metadata.sourceMessageId || '', 80),
        snsMediaItemId: sanitizeString(metadata.snsMediaItemId || '', 80),
        snsTaskId: sanitizeString(metadata.snsTaskId || '', 80),
        youtubeVideoId: sanitizeString(metadata.youtubeVideoId || '', 80),
        mediaKind: sanitizeString(metadata.mediaKind || '', 40),
        fileId: typeof metadata.fileId === 'string' ? metadata.fileId : '',
        fileUniqueId: typeof metadata.fileUniqueId === 'string' ? metadata.fileUniqueId : '',
        fileIdUpdatedAt: Number(metadata.fileIdUpdatedAt) || 0,
        lastFileIdCheckedAt: Number(metadata.lastFileIdCheckedAt) || 0,
        cacheConfirmedAt: Number(metadata.cacheConfirmedAt) || 0,
        cacheConfirmedBy: sanitizeString(metadata.cacheConfirmedBy || '', 80),
        temporaryFileRemovedAt: Number(metadata.temporaryFileRemovedAt) || 0,
        fileIdHistory: Array.isArray(metadata.fileIdHistory) ? metadata.fileIdHistory.slice(-20) : []
    };
    telegramServerAssets.set(assetId, asset);
    return asset;
}

async function ensureTelegramServerAssetFile(asset) {
    if (fs.existsSync(asset.path)) return asset.path;
    if (!asset.fileId && !isRecoverableSnsAsset(asset)) throw new Error('server-asset-source-missing');
    const downloadKey = asset.fileId ? asset.id : `sns:${asset.snsTaskId || asset.id}`;
    let download = telegramAssetDownloads.get(downloadKey);
    if (!download) {
        download = (async () => {
            if (asset.fileId) {
                const data = await downloadTelegramFile(asset.fileId, TELEGRAM_CLOUD_GET_FILE_MAX_SIZE);
                fs.mkdirSync(TELEGRAM_ASSET_DIR, { recursive: true });
                fs.writeFileSync(asset.path, data);
                asset.size = data.length;
                resetRestoredServerAsset(asset);
            } else {
                await restoreSnsServerAssetFile(asset);
            }
            return asset.path;
        })().finally(() => telegramAssetDownloads.delete(downloadKey));
        telegramAssetDownloads.set(downloadKey, download);
    }
    await download;
    if (!fs.existsSync(asset.path)) throw new Error('server-asset-restore-missing');
    return asset.path;
}

function resetRestoredServerAsset(asset) {
    asset.cacheConfirmedAt = 0;
    asset.cacheConfirmedBy = '';
    asset.temporaryFileRemovedAt = 0;
    persistTelegramServerAsset(asset);
    updateTelegramAssetMetadataInSession(asset);
    const task = asset.snsTaskId ? readSnsTask(asset.snsTaskId) : null;
    const messageId = task?.generatedMessageId || task?.generatedMessage?.id;
    const message = sessions.get(asset.sessionId)?.history.find(entry => entry.message?.id === messageId)?.message;
    if (task) persistSnsTask({ ...task, ...(message ? { generatedMessage: message } : {}), status: 'ready', error: '' });
}

async function restoreSnsServerAssetFile(asset) {
    const task = readSnsTask(asset.snsTaskId);
    if (!task || task.sessionId !== asset.sessionId || !task.sourceUrl) throw new Error('sns-asset-source-missing');

    try {
        if (task.mediaKind === 'song') {
            const files = task.generatedMessage?.collection?.files || [];
            const audioInfo = files.find(file => file.id === task.audioAssetId) || {};
            const item = {
                sourceUrl: task.sourceUrl,
                mediaUrl: task.sourceUrl,
                mediaKind: 'song',
                title: audioInfo.audioTitle || audioInfo.name || task.youtubeVideoId,
                youtubeVideoId: task.youtubeVideoId || '',
                songMetadata: {
                    track: audioInfo.audioTitle || '',
                    artist: audioInfo.audioArtist || '',
                    album: audioInfo.audioAlbum || '',
                    year: audioInfo.audioYear || ''
                }
            };
            const song = await downloadAndProcessYoutubeSong(item, task, () => {}, () => {});
            for (const [assetId, sourcePath] of [[task.coverAssetId, song.squareCover], [task.audioAssetId, song.finalAudio]]) {
                const target = assetId === asset.id ? asset : resolveTelegramServerAsset(assetId);
                if (!target || fs.existsSync(target.path)) continue;
                moveSnsFileToAsset(sourcePath, assetId);
                target.size = fs.statSync(target.path).size;
                resetRestoredServerAsset(target);
            }
        } else {
            const downloadedPath = await runYtDlpDownload(task.sourceUrl, asset.id, undefined, task.playlistItem);
            const probe = await probeMediaFile(downloadedPath);
            if (!probe.streams?.some(stream => stream.codec_type === 'video')) throw new Error('sns-restored-video-invalid');
            moveSnsFileToAsset(downloadedPath, asset.id);
            asset.size = fs.statSync(asset.path).size;
            resetRestoredServerAsset(asset);
        }
    } finally {
        cleanupSnsWorkFiles(task.mediaKind === 'song' ? `${task.id}.` : `${asset.id}.`);
    }
}

function removeTelegramAssetTemporaryFile(asset) {
    try {
        if (fs.existsSync(asset.path)) fs.unlinkSync(asset.path);
        return true;
    } catch (err) {
        console.warn(`Unable to remove Telegram temporary asset ${asset.id}: ${err.message}`);
        return false;
    }
}

function removeConfirmedServerAssetFile(asset) {
    if (!asset?.cacheConfirmedAt || (telegramAssetReaders.get(asset.id) || 0) > 0) return false;
    if (asset.source === 'youtube-premium') return false;
    if (/^sns(?:-|$)/.test(String(asset.source || '')) && !isRecoverableSnsAsset(asset)) return false;
    if (!removeTelegramAssetTemporaryFile(asset)) return false;
    asset.temporaryFileRemovedAt = Date.now();
    persistTelegramServerAsset(asset);
    return true;
}

function hydrateTelegramServerAssets() {
    fs.mkdirSync(TELEGRAM_ASSET_DIR, { recursive: true });
    let restored = 0;
    for (const entry of fs.readdirSync(TELEGRAM_ASSET_DIR, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const assetId = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : entry.name;
        if (telegramServerAssets.has(assetId)) continue;
        const asset = resolveTelegramServerAsset(assetId);
        if (!asset) continue;
        restored += 1;
        if (asset.cacheConfirmedAt) removeConfirmedServerAssetFile(asset);
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

const SUPPORTED_SOCIAL_HOSTS = Object.freeze({
    'youtube.com': 'youtube',
    'www.youtube.com': 'youtube',
    'm.youtube.com': 'youtube',
    'youtu.be': 'youtube',
    'music.youtube.com': 'ytmusic',
    'www.music.youtube.com': 'ytmusic',
    'tiktok.com': 'tiktok',
    'www.tiktok.com': 'tiktok',
    'facebook.com': 'facebook',
    'www.facebook.com': 'facebook',
    'fb.watch': 'facebook',
    'instagram.com': 'instagram',
    'www.instagram.com': 'instagram',
    'threads.com': 'threads',
    'www.threads.com': 'threads',
    'threads.net': 'threads',
    'www.threads.net': 'threads',
    'line.me': 'line',
    'www.line.me': 'line',
    'twitter.com': 'twitter',
    'www.twitter.com': 'twitter',
    'x.com': 'x',
    'www.x.com': 'x'
});

function normalizeSocialUrl(url = '') {
    return String(url || '')
        .trim()
        .replace(/[)\].,，。!?！？;；]+$/g, '');
}

function parseSupportedSocialUrl(value = '') {
    const raw = normalizeSocialUrl(value);
    if (!raw) return null;
    try {
        const parsed = new URL(raw);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
        const platform = SUPPORTED_SOCIAL_HOSTS[hostname];
        if (!platform) return null;
        return { raw, parsed, hostname, platform };
    } catch (_) {
        return null;
    }
}

function isSupportedSocialUrl(url = '') {
    return Boolean(parseSupportedSocialUrl(url));
}

function extractSupportedSocialUrls(text = '') {
    const urls = String(text || '').match(/https?:\/\/[^\s<>"']+/gi) || [];
    const seen = new Set();
    return urls
        .map(normalizeSocialUrl)
        .filter(url => {
            const parsed = parseSupportedSocialUrl(url);
            if (!parsed) return false;
            const key = parsed.parsed.href;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, 20);
}

function extractSupportedSocialUrl(text = '') {
    return extractSupportedSocialUrls(text)[0] || '';
}

function getSocialPlatform(url = '') {
    return parseSupportedSocialUrl(url)?.platform || 'sns';
}

function isYouTubeUrl(url = '') {
    const platform = getSocialPlatform(url);
    return platform === 'youtube' || platform === 'ytmusic';
}

function isYouTubePlaylistOnly(url = '') {
    const parsed = parseSupportedSocialUrl(url)?.parsed;
    if (!parsed || !isYouTubeUrl(url)) return false;
    if (parsed.hostname === 'youtu.be') return !parsed.pathname.replace(/^\/+/, '');
    return Boolean(parsed.searchParams.get('list')) && !parsed.searchParams.get('v');
}

function getMessageSnsText(message = {}) {
    if (message.type === 'text') return String(message.text || '');
    if (message.type === 'rich') {
        const html = String(message.content || '');
        const decodeEntities = value => String(value || '')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>');
        const hrefs = Array.from(html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi), match => decodeEntities(match[1]));
        const visibleText = html
            .replace(/<br\s*\/?\s*>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>');
        return [visibleText, ...hrefs].join('\n');
    }
    return String(message.remark || message.fileInfo?.remark || message.collection?.remark || '');
}

function createStableSnsId(...parts) {
    return crypto.createHash('sha1')
        .update(parts.map(part => String(part || '')).join('\n'))
        .digest('base64url')
        .slice(0, 18);
}

function getStructuredArtistValue(meta = {}) {
    if (Array.isArray(meta.artists)) {
        const artists = meta.artists.map(value => String(value || '').trim()).filter(Boolean);
        if (artists.length) return artists.join('/');
    }
    if (typeof meta.artist === 'string' && meta.artist.trim()) return meta.artist.trim();
    if (typeof meta.artists === 'string' && meta.artists.trim()) return meta.artists.trim();
    return '';
}

function normalizeArtistValue(meta = {}) {
    const structuredArtist = getStructuredArtistValue(meta);
    if (structuredArtist) return structuredArtist;
    return String(meta.uploader || meta.channel || '').trim();
}

function getYoutubeMusicDescriptionCredits(meta = {}) {
    const description = String(meta.description || meta.caption || '').trim();
    if (!description) return { composers: [], genres: [] };
    const categories = Array.isArray(meta.categories) ? meta.categories.map(value => String(value || '').toLowerCase()) : [];
    const looksLikeMusic = Boolean(meta.track || meta.album || categories.includes('music')
        || /(?:Provided to YouTube by|Auto-generated by YouTube|℗)/i.test(description));
    if (!looksLikeMusic) return { composers: [], genres: [] };

    const composers = [];
    const genres = [];
    const pushUnique = (target, value) => {
        const normalized = String(value || '').trim();
        if (normalized && !target.some(item => item.toLocaleLowerCase() === normalized.toLocaleLowerCase())) target.push(normalized);
    };
    for (const rawLine of description.split(/\r?\n/)) {
        const match = rawLine.match(/^\s*([^:：]{1,100})\s*[:：]\s*(.+?)\s*$/);
        if (!match) continue;
        const label = match[1].trim();
        const value = match[2].trim();
        if (/\bcomposer\b|作曲(?:者|家)?|작곡/i.test(label)) pushUnique(composers, value);
        if (/\bgenre\b|ジャンル|曲[风風]|流派|장르/i.test(label)) pushUnique(genres, value);
    }
    return { composers, genres };
}

function getYoutubeComposerValue(meta = {}) {
    if (Array.isArray(meta.composers)) {
        const composers = meta.composers.map(value => String(value || '').trim()).filter(Boolean);
        if (composers.length) return composers.join('/');
    }
    if (typeof meta.composers === 'string' && meta.composers.trim()) return meta.composers.trim();
    if (typeof meta.composer === 'string' && meta.composer.trim()) return meta.composer.trim();
    const descriptionCredits = getYoutubeMusicDescriptionCredits(meta);
    if (descriptionCredits.composers.length) return descriptionCredits.composers.join('/');
    return '';
}

function getYoutubeGenreValue(meta = {}) {
    if (Array.isArray(meta.genres)) {
        const genres = meta.genres.map(value => String(value || '').trim()).filter(Boolean);
        if (genres.length) return genres.join(', ');
    }
    if (typeof meta.genres === 'string' && meta.genres.trim()) return meta.genres.trim();
    if (typeof meta.genre === 'string' && meta.genre.trim()) return meta.genre.trim();
    const descriptionCredits = getYoutubeMusicDescriptionCredits(meta);
    if (descriptionCredits.genres.length) return descriptionCredits.genres.join(', ');
    return '';
}

function extractMediaYear(value) {
    return extractYoutubeMetadataYear(value);
}

function extractUploadYear(meta = {}) {
    const calendarYear = extractMediaYear(meta.upload_date || meta.release_timestamp || meta.timestamp);
    if (calendarYear) return calendarYear;
    const timestamp = Number(meta.timestamp || meta.release_timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    const year = new Date(timestamp * (timestamp < 1e12 ? 1000 : 1)).getUTCFullYear();
    return year >= 1900 && year <= 2100 ? String(year) : '';
}

function normalizeYoutubeSourceUrl(value) {
    try {
        const url = new URL(String(value || ''));
        for (const key of [...url.searchParams.keys()]) {
            if (key === 'si' || key === 'is' || key === 'feature' || key === 'pp' || key === 'ab_channel' || key.startsWith('utm_')) {
                url.searchParams.delete(key);
            }
        }
        url.hash = '';
        return url.href;
    } catch (_) {
        return String(value || '').trim();
    }
}

function getYoutubeMusicAlbumCandidateUrl(entry = {}) {
    const values = [entry.webpage_url, entry.original_url, entry.url].map(value => String(value || '').trim()).filter(Boolean);
    for (const value of values) {
        if (/^https?:\/\//i.test(value) && /(?:music\.)?youtube\.com|youtu\.be/i.test(value)) return value;
        if (/^\/browse\/[^/?#]+/i.test(value)) return `https://music.youtube.com${value}`;
        if (/^browse\/[^/?#]+/i.test(value)) return `https://music.youtube.com/${value}`;
    }
    const browseId = String(entry.id || '').trim();
    if (/^MP(?:RE|AD|ED|CL|TR)?[A-Za-z0-9_-]+$/i.test(browseId)) {
        return `https://music.youtube.com/browse/${encodeURIComponent(browseId)}`;
    }
    const playlistId = String(entry.playlist_id || '').trim();
    if (/^OLAK5uy_/i.test(playlistId)) {
        return `https://music.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
    }
    return '';
}

async function findYoutubeMusicTrackNumberByAlbumSearch(meta = {}, sourceUrl = '', options = {}) {
    const album = String(meta.album || '').trim();
    if (!album || !meta.id) return '';
    const albumArtist = String(
        meta.album_artist || (Array.isArray(meta.album_artists) ? meta.album_artists.join(' ') : meta.album_artists) ||
        getStructuredArtistValue(meta) || meta.artist || ''
    ).trim();
    const query = [album, albumArtist].filter(Boolean).join(' ');
    const searchUrl = `https://music.youtube.com/search?q=${encodeURIComponent(query)}#albums`;
    let searchMeta;
    try {
        searchMeta = await runYtDlpJson(searchUrl, {
            noPlaylist: false,
            flatPlaylist: true,
            cookiePath: options.cookiePath,
            allowIgnoreNoFormatsFallback: false,
            signal: options.signal,
            timeoutMs: Math.min(Number(options.timeoutMs) || 45000, 60000),
            operation: 'youtube-music-album-search'
        });
    } catch (error) {
        recordExternalDependencyEvent('youtube-yt-dlp', 'youtube-music-album-search', {
            level: 'warn', endpoint: searchUrl, error,
            hint: 'Track number fallback could not search YouTube Music albums; the song remains usable and Track will fall back to 1.'
        });
        return '';
    }

    const candidates = rankYoutubeMusicAlbumCandidates(meta, searchMeta?.entries).slice(0, 8);
    const visited = new Set();
    for (const candidate of candidates) {
        const candidateUrl = getYoutubeMusicAlbumCandidateUrl(candidate);
        if (!candidateUrl || visited.has(candidateUrl)) continue;
        visited.add(candidateUrl);
        try {
            const albumMeta = await runYtDlpJson(candidateUrl, {
                noPlaylist: false,
                flatPlaylist: true,
                cookiePath: options.cookiePath,
                allowIgnoreNoFormatsFallback: false,
                signal: options.signal,
                timeoutMs: Math.min(Number(options.timeoutMs) || 45000, 60000),
                operation: 'youtube-music-album-traverse'
            });
            const trackNumber = findYoutubeMusicTrackPosition(meta, albumMeta?.entries);
            if (trackNumber) {
                recordExternalDependencyEvent('youtube-yt-dlp', 'youtube-music-track-number-resolved', {
                    level: 'info', endpoint: candidateUrl,
                    details: { videoId: String(meta.id), album, trackNumber, strategy: 'album-search-traverse' }
                });
                return trackNumber;
            }
        } catch (error) {
            recordExternalDependencyEvent('youtube-yt-dlp', 'youtube-music-album-traverse', {
                level: 'warn', endpoint: candidateUrl, error,
                hint: 'A candidate album could not be expanded; remaining candidates will still be tried.'
            });
        }
    }
    return '';
}

async function enrichYoutubeMusicOrdinalMetadata(meta = {}, sourceUrl = '', options = {}) {
    let ordinal = resolveYoutubeMusicOrdinalMetadata(meta, sourceUrl);
    if (!ordinal.trackNumber && ordinal.albumPlaylistId && meta.id) {
        try {
            const playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(ordinal.albumPlaylistId)}`;
            const playlistMeta = await runYtDlpJson(playlistUrl, {
                noPlaylist: false,
                flatPlaylist: true,
                cookiePath: options.cookiePath,
                allowIgnoreNoFormatsFallback: false,
                signal: options.signal,
                operation: 'youtube-music-known-album-traverse'
            });
            ordinal = resolveYoutubeMusicOrdinalMetadata(meta, sourceUrl, playlistMeta?.entries);
        } catch (error) {
            recordExternalDependencyEvent('youtube-yt-dlp', 'youtube-music-known-album-traverse', {
                level: 'warn', endpoint: `https://www.youtube.com/playlist?list=${ordinal.albumPlaylistId}`, error,
                hint: 'Known album playlist traversal failed; album search fallback will still be attempted.'
            });
        }
    }
    if (!ordinal.trackNumber && meta.album && meta.id) {
        const searchedTrackNumber = await findYoutubeMusicTrackNumberByAlbumSearch(meta, sourceUrl, options);
        if (searchedTrackNumber) ordinal = { ...ordinal, trackNumber: searchedTrackNumber };
    }
    const trackNumber = finalizeYoutubeMusicTrackNumber(meta, ordinal.trackNumber);
    if (!meta.track_number && !ordinal.trackNumber) {
        recordExternalDependencyEvent('youtube-yt-dlp', 'youtube-music-track-number-defaulted', {
            level: 'warn', endpoint: sourceUrl,
            message: 'No native or album-derived Track number was available; Track=1 was applied.',
            details: { videoId: String(meta.id || ''), album: String(meta.album || ''), fallbackTrackNumber: '1' }
        });
    }
    return {
        ...meta,
        track_number: trackNumber,
        disc_number: meta.disc_number || ordinal.discNumber || '1'
    };
}

function normalizeYoutubeLanguageCode(value) {
    const raw = String(value || '').trim().toLowerCase().replace('_', '-');
    if (!raw) return '';
    const primary = raw.split('-')[0];
    return /^[a-z]{2,3}$/.test(primary) ? primary : '';
}

function guessYoutubeSourceLanguage(meta = {}) {
    const explicit = normalizeYoutubeLanguageCode(meta.language || meta.audio_language || meta.original_language);
    if (explicit) return explicit;
    const text = [
        meta.track, meta.title, meta.fulltitle, getStructuredArtistValue(meta), meta.album,
        Array.isArray(meta.album_artists) ? meta.album_artists.join(' ') : meta.album_artists
    ].filter(Boolean).join(' ');
    if (/[ぁ-ゟ゠-ヿ]/u.test(text)) return 'ja';
    if (/[가-힣]/u.test(text)) return 'ko';
    if (/[ก-๙]/u.test(text)) return 'th';
    if (/[؀-ۿ]/u.test(text)) return 'ar';
    if (/[֐-׿]/u.test(text)) return 'he';
    if (/[ऀ-ॿ]/u.test(text)) return 'hi';
    if (/[Ѐ-ӿ]/u.test(text)) return 'ru';
    if (/\p{Script=Han}/u.test(text)) return 'zh';
    return '';
}

function getYoutubeSourceLanguageFields(meta = {}) {
    const artist = normalizeArtistValue(meta);
    const albumArtist = String(meta.album_artist || (Array.isArray(meta.album_artists)
        ? meta.album_artists.map(value => String(value || '').trim()).filter(Boolean).join('/')
        : meta.album_artists) || '').trim();
    return {
        sourceTitle: sanitizeString(meta.track || meta.title || meta.fulltitle || '', 500),
        sourceTrack: sanitizeString(meta.track || '', 500),
        sourceAlbum: sanitizeString(meta.album || '', 500),
        sourceArtist: sanitizeString(artist, 500),
        sourceAlbumArtist: sanitizeString(albumArtist, 500)
    };
}

function buildYoutubeReferenceInfo(meta = {}, sourceUrl = '', sourceLanguageMeta = null) {
    const uploaderId = String(meta.uploader_id || '').trim();
    const authorUrl = uploaderId.startsWith('@')
        ? `https://www.youtube.com/${uploaderId}`
        : String(meta.uploader_url || meta.channel_url || '').trim();
    return {
        webpageUrl: normalizeYoutubeSourceUrl(meta.webpage_url || meta.original_url || sourceUrl),
        title: sanitizeString(meta.title || meta.fulltitle || '', 500),
        description: sanitizeString(meta.description || meta.caption || '', 12000),
        authorName: sanitizeString(normalizeArtistValue(meta) || meta.creator || meta.channel || meta.uploader || '', 500),
        authorHandle: sanitizeString(uploaderId.startsWith('@') ? uploaderId : '', 200),
        authorUrl: sanitizeString(authorUrl, 1000),
        videoId: sanitizeString(meta.id || '', 100),
        channelId: sanitizeString(meta.channel_id || '', 200),
        playlistId: sanitizeString(meta.playlist_id || '', 200),
        playlistTitle: sanitizeString(meta.playlist_title || '', 500),
        album: sanitizeString(meta.album || meta.playlist_title || '', 500),
        albumArtist: sanitizeString(meta.album_artist || (Array.isArray(meta.album_artists) ? meta.album_artists.map(value => String(value || '').trim()).filter(Boolean).join('/') : meta.album_artists) || '', 500),
        track: sanitizeString(meta.track || meta.title || '', 500),
        composer: sanitizeString(getYoutubeComposerValue(meta), 500),
        genre: sanitizeString(getYoutubeGenreValue(meta), 500),
        trackNumber: sanitizeString(meta.track_number || '', 40),
        discNumber: sanitizeString(meta.disc_number || '', 40),
        albumYear: extractMediaYear(meta.album_release_year || meta.album_year || (meta.album ? meta.release_year || meta.release_date : '')),
        songYear: extractMediaYear(meta.track_year || meta.release_year || meta.release_date || meta.year),
        uploadYear: extractUploadYear(meta),
        uploadDate: sanitizeString(meta.upload_date || '', 40),
        releaseDate: sanitizeString(meta.release_date || '', 40),
        duration: Number(meta.duration) || 0,
        language: sanitizeString(meta.language || '', 100),
        categories: sanitizeString(Array.isArray(meta.categories) ? meta.categories.join(', ') : '', 1000),
        tags: sanitizeString(Array.isArray(meta.tags) ? meta.tags.join(', ') : '', 3000),
        license: sanitizeString(meta.license || '', 300),
        availability: sanitizeString(meta.availability || '', 100),
        viewCount: Number(meta.view_count) || 0,
        likeCount: Number(meta.like_count) || 0,
        channelFollowerCount: Number(meta.channel_follower_count) || 0,
        sourceLanguage: guessYoutubeSourceLanguage(sourceLanguageMeta || meta),
        sourceLanguageVersionAttempted: Boolean(sourceLanguageMeta),
        sourceLanguageVersionResolved: Boolean(sourceLanguageMeta),
        sourceLanguageCheckCompleted: false,
        ...getYoutubeSourceLanguageFields(sourceLanguageMeta || meta)
    };
}

async function collectYoutubeReferenceInfo(rawUrl, options = {}) {
    let meta = options.meta || await runYtDlpJson(rawUrl, {
        noPlaylist: true,
        cookiePath: options.cookiePath,
        allowIgnoreNoFormatsFallback: false,
        bypassCache: options.bypassCache === true,
        signal: options.signal
    });
    if (classifySnsMedia(rawUrl, meta) === 'song') {
        meta = await enrichYoutubeMusicOrdinalMetadata(meta, rawUrl, {
            cookiePath: options.cookiePath,
            signal: options.signal
        });
    }
    const language = guessYoutubeSourceLanguage(meta);
    let sourceLanguageMeta = null;
    if (language) {
        try {
            sourceLanguageMeta = await runYtDlpJson(rawUrl, {
                noPlaylist: true,
                cookiePath: options.cookiePath,
                allowIgnoreNoFormatsFallback: false,
                bypassCache: options.bypassCache === true,
                youtubeLanguage: language,
                signal: options.signal
            });
        } catch (_) {
            sourceLanguageMeta = null;
        }
    }
    const reference = buildYoutubeReferenceInfo(meta, rawUrl, sourceLanguageMeta || meta);
    reference.sourceLanguageVersionAttempted = Boolean(language);
    reference.sourceLanguageVersionResolved = Boolean(sourceLanguageMeta);
    reference.sourceLanguageCheckCompleted = true;
    return reference;
}

function buildYoutubeSongMetadata(meta = {}, sourceUrl = '') {
    const reference = buildYoutubeReferenceInfo(meta, sourceUrl);
    const artist = normalizeArtistValue(meta) || reference.authorName || '未知艺术家';
    const albumArtist = String(meta.album_artist || (Array.isArray(meta.album_artists) ? meta.album_artists.map(value => String(value || '').trim()).filter(Boolean).join('/') : meta.album_artists) || artist).trim();
    const description = reference.description.replace(/\s+/g, ' ').trim();
    const comment = [
        reference.webpageUrl,
        reference.authorUrl ? `作者主页：${reference.authorUrl}` : '',
        reference.authorName ? `作者：${reference.authorName}` : '',
        reference.title ? `标题：${reference.title}` : '',
        description ? `简介：${description.slice(0, 1000)}${description.length > 1000 ? '…' : ''}` : ''
    ].filter(Boolean).join('\n');
    return {
        title: sanitizeString(meta.track || meta.title || meta.fulltitle || '未知曲名', 240),
        artist: sanitizeString(artist, 240),
        album: sanitizeString(meta.album || meta.playlist_title || meta.channel || meta.uploader || 'YouTube', 240),
        album_artist: sanitizeString(albumArtist, 240),
        composer: sanitizeString(getYoutubeComposerValue(meta), 240),
        genre: sanitizeString(getYoutubeGenreValue(meta), 240),
        track: sanitizeString(meta.track_number || '', 40),
        disc: sanitizeString(meta.disc_number || '1', 40),
        date: reference.albumYear || reference.songYear || reference.uploadYear,
        comment: sanitizeString(comment, 4000),
        lyrics: sanitizeString(meta.lyrics || '', 12000)
    };
}

function getYtDlpInvocation(args = []) {
    const command = process.env.YT_DLP_BIN || 'yt-dlp';
    const prefixArgs = String(process.env.YT_DLP_BIN_ARGS || '').split(/\s+/).filter(Boolean);
    return { command, args: [...prefixArgs, ...args] };
}

function copyYtDlpCookies(args) {
    const index = args.indexOf('--cookies');
    if (index < 0 || !args[index + 1]) return { args, cleanup() {} };
    fs.mkdirSync(SNS_MEDIA_WORK_DIR, { recursive: true });
    const tempPath = path.join(SNS_MEDIA_WORK_DIR, `.cookies-${process.pid}-${crypto.randomBytes(6).toString('hex')}.txt`);
    fs.copyFileSync(args[index + 1], tempPath);
    const copiedArgs = [...args];
    copiedArgs[index + 1] = tempPath;
    return {
        args: copiedArgs,
        cleanup() { try { fs.unlinkSync(tempPath); } catch (_) {} }
    };
}

function getYtDlpFailureMessage(stderr, fallback) {
    const output = String(stderr || '').trim();
    const lines = output.split(/\r?\n/).filter(Boolean).reverse();
    const errorLine = lines.find(line => /^ERROR:\s*/i.test(line)) || lines[0] || '';
    if (/challenge solver|signature solving failed/i.test(output) &&
        /requested format is not available|only images are available/i.test(errorLine)) {
        return 'YouTube 签名解析组件不可用，请确认服务端使用包含 yt-dlp-ejs 的 yt-dlp（pip 请安装 "yt-dlp[default]"）并重启服务';
    }
    if (/sign in to confirm you(?:'|’)?re not a bot|cookies?.*(?:no longer valid|rotated)/i.test(output)) {
        return 'YouTube 要求登录验证；当前 cookies 无效或不完整，请在 SNS cookies 管理页重新导出包含 HttpOnly 登录态的完整 Netscape cookies.txt';
    }
    if (/page needs to be reloaded|must be reloaded|reload the page/i.test(output)) {
        return 'YouTube 返回"页面需要重新加载"（通常是 cookies 已失效/被轮换，或触发机器人校验）。请在 /sns-cookies 重新导出包含 VISITOR_INFO1_LIVE、SOCS、LOGIN_INFO 等完整登录态的 cookies.txt 后重试；若仍失败请稍等片刻或更换代理出口节点';
    }
    if (/unable to extract|extractor(?:\s+)?error|no video formats found|failed to extract/i.test(output)) {
        return `外部平台页面/API 或 yt-dlp extractor 可能已经变化：${String(errorLine || fallback).replace(/^ERROR:\s*/i, '')}`;
    }
    if (/requested format is not available|only images are available/i.test(errorLine)) {
        return `YouTube 当前登录态/播放器客户端返回的可用格式集合不完整，或原先选择的格式已经变化：${String(errorLine || fallback).replace(/^ERROR:\s*/i, '')}。系统会对自动模式尝试可用格式降级；若仍失败，请重新导出有效 Premium cookies（建议按 yt-dlp 官方方式在新的隐私/无痕会话中导出后立即关闭该会话）`;
    }
    if (/HTTP Error\s+(?:403|429)|Too Many Requests|rate.?limit/i.test(output)) {
        return `外部平台拒绝或限制了抓取请求（可能是登录态、频率、IP策略或接口规则变化）：${String(errorLine || fallback).replace(/^ERROR:\s*/i, '')}`;
    }
    return String(errorLine || fallback).replace(/^ERROR:\s*/i, '');
}

function getYtDlpDependencyId(url) {
    return isYouTubeUrl(url) ? 'youtube-yt-dlp' : 'sns-yt-dlp';
}

function buildYtDlpEnv() {
    const env = { ...process.env };
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';
    const proxy = env.DR2T_PROXY || env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || '';
    const allProxy = env.DR2T_ALL_PROXY || env.ALL_PROXY || proxy;
    if (proxy) {
        env.HTTP_PROXY ||= proxy;
        env.HTTPS_PROXY ||= proxy;
        env.http_proxy ||= env.HTTP_PROXY;
        env.https_proxy ||= env.HTTPS_PROXY;
    }
    if (allProxy) {
        env.ALL_PROXY ||= allProxy;
        env.all_proxy ||= env.ALL_PROXY;
    }
    return env;
}

function classifySnsMedia(sourceUrl, meta = {}) {
    if (!isYouTubeUrl(sourceUrl)) return 'video';
    if (isYouTubePlaylistOnly(sourceUrl)) return 'unsupported';
    if (getSocialPlatform(sourceUrl) === 'ytmusic') return 'song';
    const track = String(meta.track || '').trim();
    const artist = getStructuredArtistValue(meta);
    return track && artist ? 'song' : 'video';
}

function runYtDlpJson(url, options = {}) {
    return new Promise((resolve, reject) => {
        const dependencyId = getYtDlpDependencyId(url);
        const operation = options.operation || (options.flatPlaylist ? 'metadata-flat-playlist' : 'metadata-json');
        const args = [
            '--dump-single-json',
            '--skip-download'
        ];
        if (options.bypassCache === true) {
            args.push(
                '--no-cache-dir',
                '--add-headers', 'Cache-Control:no-cache',
                '--add-headers', 'Pragma:no-cache'
            );
        } else {
            args.push('--cache-dir', YT_DLP_CACHE_DIR);
        }
        if (options.ignoreNoFormats === true) args.push('--ignore-no-formats-error');
        if (options.flatPlaylist === true) args.push('--flat-playlist');
        args.push(options.noPlaylist === false ? '--yes-playlist' : '--no-playlist');
        args.push(...getYtDlpRemoteComponentArgs(url));
        args.push(...getYtDlpFfmpegArgs());
        if (options.formatSelector) args.push('-f', String(options.formatSelector));
        if (options.youtubeLanguage) args.push('--extractor-args', `youtube:lang=${String(options.youtubeLanguage).trim()}`);
        if (options.playerClient) args.push('--extractor-args', `youtube:player_client=${String(options.playerClient).trim()}`);
        args.push(url);
        const cookiePath = String(options.cookiePath || getSnsCookieFileForUrl(url) || '');
        if (cookiePath && fs.existsSync(cookiePath)) {
            try {
                if (fs.statSync(cookiePath).size > 0) {
                    args.splice(args.length - 1, 0, '--cookies', cookiePath);
                }
            } catch (_) {}
        }
        const cookies = copyYtDlpCookies(args);
        const invocation = getYtDlpInvocation(cookies.args);
        const child = spawn(invocation.command, invocation.args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: buildYtDlpEnv()
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const signal = options.signal;
        const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            cookies.cleanup();
        };
        const abort = () => {
            if (settled) return;
            settled = true;
            child.kill('SIGTERM');
            finish();
            reject(new Error('download-cancelled'));
        };
        const defaultTimeoutMs = Number(process.env.SOCIAL_YTDLP_TIMEOUT_MS) || 90000;
        const timeoutMs = Math.max(1000, Number(options.timeoutMs) || defaultTimeoutMs);
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGTERM');
            finish();
            const detail = getYtDlpFailureMessage(stderr, '');
            const error = new Error(`yt-dlp-timeout-${timeoutMs}ms${detail ? `: ${detail}` : ''}`);
            recordExternalDependencyEvent(dependencyId, operation, {
                level: 'error', endpoint: url, error,
                hint: 'External crawler timed out; check upstream availability, cookies/proxy and yt-dlp compatibility.'
            });
            reject(error);
        }, timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) return abort();
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', err => {
            if (settled) return;
            settled = true;
            finish();
            const error = new Error(err.code === 'ENOENT' ? 'yt-dlp-not-found' : err.message);
            error.code = err.code;
            recordExternalDependencyEvent('local-media-toolchain', 'yt-dlp-spawn', {
                level: 'error', endpoint: url, error,
                hint: 'yt-dlp executable/runtime is missing or could not be started.'
            });
            reject(error);
        });
        child.on('close', code => {
            if (settled) return;
            settled = true;
            finish();
            if (code !== 0) {
                if (options.formatSelector && options.formatSelectionFallback !== false &&
                    /requested format is not available|only images are available/i.test(stderr)) {
                    recordExternalDependencyEvent(dependencyId, `${operation}-fallback-format-metadata`, {
                        level: 'warn', endpoint: url,
                        message: getYtDlpFailureMessage(stderr, 'yt-dlp format selection became unavailable'),
                        details: { requestedSelector: String(options.formatSelector).slice(0, 500) },
                        hint: 'The authenticated YouTube client returned a different/limited format set; retrying metadata extraction without forcing a format.'
                    });
                    return runYtDlpJson(url, {
                        ...options,
                        formatSelector: '',
                        ignoreNoFormats: true,
                        formatSelectionFallback: false
                    }).then(resolve, reject);
                }
                if (options.allowIgnoreNoFormatsFallback !== false && options.ignoreNoFormats !== true &&
                    ((/challenge solver|signature solving failed/i.test(stderr) &&
                        /requested format is not available|only images are available/i.test(stderr)) ||
                        /sign in to confirm you(?:'|’)?re not a bot/i.test(stderr))) {
                    recordExternalDependencyEvent(dependencyId, `${operation}-fallback-ignore-no-formats`, {
                        level: 'warn', endpoint: url,
                        message: getYtDlpFailureMessage(stderr, 'yt-dlp extractor/challenge fallback'),
                        hint: 'Upstream extraction changed or requires authentication; retrying metadata-only fallback.'
                    });
                    return runYtDlpJson(url, { ...options, ignoreNoFormats: true }).then(resolve, reject);
                }
                if (options.playerClientFallback !== false && !options.playerClient && /page needs to be reloaded/i.test(stderr)) {
                    recordExternalDependencyEvent(dependencyId, `${operation}-fallback-player-client`, {
                        level: 'warn', endpoint: url,
                        message: getYtDlpFailureMessage(stderr, 'YouTube player client fallback'),
                        hint: 'YouTube requested a reload; retrying alternate player clients without cache.'
                    });
                    return runYtDlpJson(url, { ...options, playerClient: 'web_embedded,android,tv_embedded', bypassCache: true, playerClientFallback: false }).then(resolve, reject);
                }
                const error = new Error(getYtDlpFailureMessage(stderr, `yt-dlp-exit-${code}`));
                recordExternalDependencyEvent(dependencyId, operation, {
                    level: 'error', endpoint: url, error,
                    details: { exitCode: code, platform: getSocialPlatform(url) || 'unknown' },
                    hint: 'External site/extractor/authentication behavior may have changed; inspect this log before treating it as an internal bug.'
                });
                return reject(error);
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (err) {
                const error = new Error(`yt-dlp-json-parse-failed: ${err.message}`);
                recordExternalDependencyEvent(dependencyId, `${operation}-json-parse`, {
                    level: 'error', endpoint: url, error,
                    hint: 'yt-dlp output contract may have changed or non-JSON diagnostics reached stdout.'
                });
                reject(error);
            }
        });
    });
}

function getYtDlpRemoteComponentArgs(url) {
    if (!/(?:youtube\.com|youtu\.be|music\.youtube\.com)/i.test(String(url || ''))) return [];
    const args = ['--js-runtimes', process.env.SOCIAL_YTDLP_JS_RUNTIME || 'node'];
    const remoteComponents = String(process.env.SOCIAL_YTDLP_REMOTE_COMPONENTS || '').trim();
    if (remoteComponents && remoteComponents !== 'false') {
        args.push('--remote-components', remoteComponents);
    }
    return args;
}

function getYtDlpCookieArgs(url, cookiePathOverride = '') {
    const cookiePath = cookiePathOverride || getSnsCookieFileForUrl(url);
    if (!cookiePath || !fs.existsSync(cookiePath)) return [];
    try {
        if (fs.statSync(cookiePath).size > 0) return ['--cookies', cookiePath];
    } catch (_) {}
    return [];
}

function getYtDlpAudioFormatSelector() {
    return [
        'bestaudio[acodec^=mp4a][abr>=245][abr<=265]',
        'bestaudio[ext=m4a][abr>=245][abr<=265]',
        'bestaudio[abr>=245][abr<=265]',
        'bestaudio[acodec^=mp4a][abr>=120][abr<=136]',
        'bestaudio[ext=m4a][abr>=120][abr<=136]',
        'bestaudio[abr>=120][abr<=136]',
        'bestaudio[acodec^=mp4a][abr>=192][abr<=320]',
        'bestaudio[ext=m4a][abr>=192][abr<=320]',
        'bestaudio[abr>=192][abr<=320]',
        'bestaudio[acodec^=mp4a][abr>=96][abr<192]',
        'bestaudio[ext=m4a][abr>=96][abr<192]',
        'bestaudio[abr>=96][abr<192]',
        'bestaudio[acodec^=mp4a]',
        'bestaudio[ext=m4a]',
        'bestaudio'
    ].join('/');
}

function getYtDlpFormatSelector(url) {
    if (!isYouTubeUrl(url)) return 'bv*+ba/best';
    const audio = getYtDlpAudioFormatSelector();
    if (/music\.youtube\.com/i.test(String(url || ''))) return audio;
    return [
        `bestvideo[vcodec^=avc1][height<=1080]+(${audio})`,
        `bestvideo[vcodec^=av01][height<=1080]+(${audio})`,
        `bestvideo[height<=1080]+(${audio})`,
        'best[height<=1080][vcodec^=avc1][vcodec!=none][acodec!=none]',
        'best[height<=1080][vcodec!=none][acodec!=none]'
    ].join('/');
}

function buildSnsMediaItemFromMeta(messageId, source, meta, mediaIndex = 0) {
    const mediaKind = classifySnsMedia(source.sourceUrl, meta);
    let mediaUrl = normalizeSocialUrl(meta?.webpage_url || meta?.original_url || meta?.url || source.sourceUrl);
    if (mediaUrl && !/^https?:\/\//i.test(mediaUrl) && /(?:youtube\.com|youtu\.be|music\.youtube\.com)/i.test(source.sourceUrl)) {
        mediaUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(mediaUrl)}`;
    }
    if (getSocialPlatform(source.sourceUrl) === 'ytmusic') mediaUrl = source.sourceUrl;
    const mediaId = createStableSnsId(messageId, source.id, mediaUrl, mediaIndex);
    return {
        id: mediaId,
        sourceId: source.id,
        messageId,
        sourceUrl: source.sourceUrl,
        mediaUrl,
        title: sanitizeString(meta?.title || meta?.fulltitle || source.title || 'SNS 媒体文件', 240),
        coverUrl: sanitizeString(meta?.thumbnail || meta?.thumbnails?.slice(-1)?.[0]?.url || source.coverUrl || '', 1000),
        duration: Number(meta?.duration) || 0,
        platform: getSocialPlatform(source.sourceUrl),
        mediaKind,
        youtubeVideoId: sanitizeString(meta?.id || '', 80),
        acquisitionTaskId: createStableSnsId('sns-task', messageId, mediaId, meta?.id || mediaUrl),
        songMetadata: mediaKind === 'song' ? buildYoutubeSongMetadata(meta, mediaUrl || source.sourceUrl) : null,
        mediaIndex,
        playlistItem: Math.max(1, Math.trunc(Number(meta?.playlist_index) || mediaIndex + 1)),
        serverState: 'not_fetched',
        serverProgress: 0,
        serverAssetId: '',
        generatedMessageId: '',
        serverError: ''
    };
}

async function buildSnsMetadata(rawText, messageId) {
    const urls = extractSupportedSocialUrls(rawText);
    if (!urls.length) return { sources: [], items: [] };
    const sources = [];
    const items = [];
    for (let sourceOrder = 0; sourceOrder < urls.length; sourceOrder++) {
        const sourceUrl = urls[sourceOrder];
        const source = {
            id: createStableSnsId(messageId, sourceUrl, sourceOrder),
            messageId,
            sourceUrl,
            sourceType: 'single',
            title: sourceUrl,
            coverUrl: '',
            sourceOrder,
            parseStatus: 'pending',
            parseError: '',
            mediaItemIds: []
        };
        try {
            if (isYouTubePlaylistOnly(sourceUrl)) {
                source.sourceType = 'unsupported';
                source.parseStatus = 'failed';
                source.parseError = '暂不支持获取整个播放列表，请发送具体视频或歌曲链接';
                sources.push(source);
                continue;
            }
            const youtube = isYouTubeUrl(sourceUrl);
            const meta = await runYtDlpJson(sourceUrl, {
                flatPlaylist: !youtube,
                noPlaylist: youtube
            });
            const entries = youtube ? [] : (Array.isArray(meta?.entries) ? meta.entries.filter(Boolean).slice(0, 100) : []);
            source.title = sanitizeString(meta?.title || meta?.fulltitle || sourceUrl, 240);
            source.coverUrl = sanitizeString(meta?.thumbnail || meta?.thumbnails?.slice(-1)?.[0]?.url || '', 1000);
            source.sourceType = entries.length ? 'collection' : 'single';
            const mediaMetas = entries.length ? entries : [meta];
            mediaMetas.forEach((entry, mediaIndex) => {
                const item = buildSnsMediaItemFromMeta(messageId, source, entry, mediaIndex);
                item.sourceType = source.sourceType;
                source.mediaItemIds.push(item.id);
                items.push(item);
            });
            source.parseStatus = 'ready';
        } catch (err) {
            source.parseStatus = 'failed';
            source.parseError = sanitizeString(err.message || 'sns-parse-failed', 240);
        }
        sources.push(source);
    }
    return { sources, items };
}

function createSnsPlaceholderMetadata(rawText, messageId) {
    const urls = extractSupportedSocialUrls(rawText);
    return {
        sources: urls.map((sourceUrl, sourceOrder) => ({
            id: createStableSnsId(messageId, sourceUrl, sourceOrder),
            messageId,
            sourceUrl,
            sourceType: isYouTubePlaylistOnly(sourceUrl) ? 'unsupported' : 'single',
            title: sourceUrl,
            coverUrl: '',
            sourceOrder,
            parseStatus: isYouTubePlaylistOnly(sourceUrl) ? 'failed' : 'pending',
            parseError: isYouTubePlaylistOnly(sourceUrl) ? '暂不支持获取整个播放列表，请发送具体视频或歌曲链接' : '',
            mediaItemIds: []
        })),
        items: []
    };
}

function queueSnsMetadataScan(sessionId, messageId, rawText) {
    if (!extractSupportedSocialUrls(rawText).length) return;
    const scanKey = `${sessionId}:${messageId}`;
    if (snsMetadataScans.has(scanKey)) return;
    snsMetadataScans.add(scanKey);
    setTimeout(async () => {
        try {
            const session = sessions.get(sessionId);
            const entry = getHistoryMessageEntry(session, messageId);
            if (!session || !entry?.message) return;
            if (entry.message.snsAcquisition) {
                if (entry.message.snsSources || entry.message.snsMediaItems) {
                    delete entry.message.snsSources;
                    delete entry.message.snsMediaItems;
                    replaceHistoryMessage(sessionId, session, entry.message, 'sns-result-metadata-cleanup');
                }
                return;
            }
            const metadata = await buildSnsMetadata(rawText, messageId);
            entry.message.snsSources = metadata.sources;
            entry.message.snsMediaItems = metadata.items;
            replaceHistoryMessage(sessionId, session, entry.message, 'sns-media-parsed');
        } catch (err) {
            console.warn('sns metadata scan failed:', err.message);
            const session = sessions.get(sessionId);
            const entry = getHistoryMessageEntry(session, messageId);
            if (!session || !entry?.message || !Array.isArray(entry.message.snsSources)) return;
            entry.message.snsSources = entry.message.snsSources.map(source => ({
                ...source,
                parseStatus: 'failed',
                parseError: sanitizeString(err.message || 'sns-parse-failed', 240)
            }));
            replaceHistoryMessage(sessionId, session, entry.message, 'sns-media-parse-failed');
        } finally {
            snsMetadataScans.delete(scanKey);
        }
    }, 10);
}

function resumePendingSnsMetadataScans(sessionId, messages = []) {
    messages.forEach(message => {
        if (message?.snsAcquisition) {
            if (message.snsSources || message.snsMediaItems) {
                const session = sessions.get(sessionId);
                delete message.snsSources;
                delete message.snsMediaItems;
                if (session) replaceHistoryMessage(sessionId, session, message, 'sns-result-metadata-cleanup');
            }
            return;
        }
        const rawText = getMessageSnsText(message);
        if (!extractSupportedSocialUrls(rawText).length) return;
        const sources = Array.isArray(message.snsSources) ? message.snsSources : [];
        if (sources.length && !sources.some(source =>
            source?.parseStatus === 'pending' ||
            (source?.parseStatus === 'failed' && /challenge solver|signature solving failed|requested format is not available|only images are available|sign in to confirm|YouTube 要求登录验证/i.test(String(source.parseError || '')))
        )) return;
        queueSnsMetadataScan(sessionId, message.id, rawText);
    });
}

// Compatibility aliases keep the Telegram publishing path on the shared SNS pipeline.
const createTelegramSnsPlaceholderMetadata = createSnsPlaceholderMetadata;
const queueTelegramSnsMetadataScan = queueSnsMetadataScan;

async function buildSocialLinkRemark(text) {
    const sourceUrl = extractSupportedSocialUrl(text);
    if (!sourceUrl) return null;
    const meta = await runYtDlpJson(sourceUrl);
    const title = sanitizeString(meta.title || meta.fulltitle || '社媒链接', 240);
    const uploader = sanitizeString(meta.uploader || meta.channel || meta.creator || meta.artist || '', 160);
    const description = sanitizeString(meta.description || meta.caption || text || '', 1500);
    const webpageUrl = sanitizeString(meta.webpage_url || meta.original_url || sourceUrl, 800);
    const lines = [title, uploader, description, webpageUrl].filter(Boolean);
    return lines.join('\n\n').trim().slice(0, TELEGRAM_REMARK_MAX_LENGTH);
}

async function buildTelegramRemarkWithSocialMetadata(rawRemark) {
    const remark = String(rawRemark || '').trim();
    return remark.slice(0, TELEGRAM_REMARK_MAX_LENGTH);
}

function getTelegramFileFromMessage(message = {}) {
    const remark = String(message.caption || '').trim().slice(0, TELEGRAM_REMARK_MAX_LENGTH);
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
        const published = await publishTelegramPending(chatId, shortCode, pending);
        if (published) deleteTelegramPendingFile(chatId);
    }
    return true;
}

function getTelegramCollectionRemark(message = {}) {
    const caption = String(message.caption || '').trim();
    return caption.slice(0, TELEGRAM_REMARK_MAX_LENGTH);
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
            if (await rejectTelegramCloudOversizedFiles(chatId, group.files)) return;
            if (group.targetShortCode) {
                await publishTelegramCollectionToTunnel(chatId, group.targetShortCode, group.files, group.remark);
            } else {
                setTelegramPendingFile(chatId, { kind: 'files', files: group.files, remark: group.remark, createdAt: Date.now() });
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
        const chatKey = String(callback.message?.chat?.id || callback.from?.id || '');
        if (callback.data === 'cancel_pending') deleteTelegramPendingFile(chatKey);
        await telegramApi('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: translateTelegramText('已放弃发送', telegramChatLanguages.get(chatKey) || 'zh-Hans')
        });
        return;
    }
    const message = update.message || update.edited_message;
    const chatId = message?.chat?.id;
    if (!chatId) return;
    const chatKey = String(chatId);
    const telegramLanguage = normalizeLanguageCode(message?.from?.language_code || message?.chat?.language_code || '');
    if (telegramLanguage) telegramChatLanguages.set(chatKey, telegramLanguage);
    const textPayload = getTelegramTextPayload(message);
    const text = textPayload.text || '';
    const trimmed = text.trim();
    if (matchesTranslatedText(trimmed, '放弃发送')) {
        deleteTelegramPendingFile(chatKey);
        telegramAwaitingTunnelCode.delete(chatKey);
        await telegramSendMessage(chatId, '已放弃待发送内容。', { remove_keyboard: true });
        return;
    }
    if (isLeaveTunnelCommand(text)) {
        const hadTunnel = telegramChatTunnels.delete(chatKey);
        if (hadTunnel) persistTelegramChatTunnels();
        deleteTelegramPendingFile(chatKey);
        telegramAwaitingTunnelCode.delete(chatKey);
        await telegramSendMessage(chatId, hadTunnel ? '已离开隧道中转模式。' : '当前不在隧道中转模式。', { remove_keyboard: true });
        return;
    }
    if (/^\/tunnel(?:@\w+)?\s*$/i.test(trimmed)) {
        telegramAwaitingTunnelCode.add(chatKey);
        await telegramSendMessage(chatId, '请输入 5 位隧道暗号。', { force_reply: true, input_field_placeholder: translateTelegramText('输入 5 位隧道暗号', telegramChatLanguages.get(chatKey) || 'zh-Hans') });
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
        const published = await publishTelegramPending(chatId, normalizeShortCode(trimmed), pending);
        if (published) {
            deleteTelegramPendingFile(chatKey);
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
        if (await rejectTelegramCloudOversizedFiles(chatId, telegramFile)) return;
        if (targetShortCode) await publishTelegramFileToTunnel(chatId, targetShortCode, telegramFile);
        else {
            setTelegramPendingFile(chatKey, { kind: 'files', files: [telegramFile], createdAt: Date.now() });
            await promptTelegramShortCode(chatId);
        }
        return;
    }
    if (boundTunnel?.shortCode && trimmed) {
        await publishTelegramTextToTunnel(chatId, boundTunnel.shortCode, textPayload);
        return;
    }
    if (trimmed && !trimmed.startsWith('/')) {
        setTelegramPendingFile(chatKey, { kind: 'text', textPayload, createdAt: Date.now() });
        await promptTelegramShortCode(chatId);
    }
}

function describeTelegramNetworkError(error) {
    const code = String(error?.cause?.code || error?.code || '');
    const message = String(error?.message || error?.cause?.message || '');
    if (/UND_ERR_CONNECT_TIMEOUT|ConnectTimeoutError|ETIMEDOUT/.test(code) || /connect timeout/i.test(message)) {
        return '无法连接 Telegram API（连接超时）。请确认服务器能访问 api.telegram.org，或配置出站代理后重启服务（环境变量 DR2T_PROXY / DR2T_ALL_PROXY）';
    }
    if (/ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|UND_ERR_SOCKET/.test(code)) {
        return `无法连接 Telegram API（${code}）。请检查服务器网络或配置出站代理后重试`;
    }
    return message || 'telegram-request-failed';
}

async function telegramFetchJson(method, init = {}, options = {}) {
    const token = options.token || getTelegramBotToken();
    if (!token) throw new Error('telegram-bot-disabled');
    const endpoint = `https://api.telegram.org/bot[redacted]/${method}`;
    let response;
    try {
        response = await fetch(`https://api.telegram.org/bot${token}/${method}`, init);
    } catch (cause) {
        const error = new Error(describeTelegramNetworkError(cause));
        error.cause = cause;
        recordExternalDependencyEvent('telegram-bot-api', options.operation || method, {
            level: 'error', endpoint, error,
            hint: 'Telegram API network/DNS/proxy availability may have changed.'
        });
        throw error;
    }
    let payload;
    try {
        payload = await response.json();
    } catch (cause) {
        const error = new Error(`Telegram Bot API 返回了无法解析的响应（HTTP ${response.status}），外部 API/代理响应格式可能已经变化`);
        error.cause = cause;
        recordExternalDependencyEvent('telegram-bot-api', `${options.operation || method}-response-parse`, {
            level: 'error', endpoint, upstreamStatus: response.status, error,
            hint: 'Expected Telegram Bot API JSON but received another response format.'
        });
        throw error;
    }
    if (!response.ok || payload?.ok === false) {
        const error = new Error(payload?.description || `telegram-${method}-${response.status}`);
        recordExternalDependencyEvent('telegram-bot-api', options.operation || method, {
            level: 'error', endpoint, upstreamStatus: response.status, error,
            details: { telegramErrorCode: Number(payload?.error_code) || undefined },
            hint: 'Telegram Bot API rejected the request; permissions, limits or API behavior may have changed.'
        });
        throw error;
    }
    if (!payload || payload.ok !== true) {
        const error = new Error(`telegram-${method}-unexpected-response`);
        recordExternalDependencyEvent('telegram-bot-api', `${options.operation || method}-schema`, {
            level: 'error', endpoint, upstreamStatus: response.status, error,
            hint: 'Telegram Bot API response contract did not contain the expected ok=true marker.'
        });
        throw error;
    }
    return payload;
}

async function telegramApi(method, payload, token = getTelegramBotToken()) {
    const result = await telegramFetchJson(method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
    }, { token, operation: method });
    return result.result;
}

async function uploadTelegramAssetBackup(asset, data) {
    if (!data?.length) throw new Error('repair-file-content-empty');
    const form = new FormData();
    form.set('chat_id', telegramConfig.backupChatId);
    form.set('caption', `Drop2Tunnel backup · ${asset.id}`);
    form.set('document', new Blob([data], { type: asset.type || 'application/octet-stream' }), asset.name || 'file');
    const payload = await telegramFetchJson('sendDocument', {
        method: 'POST',
        body: form
    }, { operation: 'asset-backup-sendDocument' });
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
    const record = session.fileAssets?.get(asset.id);
    if (record?.metadata) Object.assign(record.metadata, {
        name: asset.name,
        type: asset.type,
        size: asset.size
    });
    for (let index = 0; index < session.history.length; index++) {
        const previous = session.history[index];
        const message = previous.message;
        let changed = false;
        const patch = fileInfo => {
            if (!fileInfo || fileInfo.id !== asset.id) return;
            fileInfo.name = asset.name;
            fileInfo.size = asset.size;
            fileInfo.type = asset.type;
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
        emitToReadableSessionDevices(session, 'message-updated', { message: historyMessage });
    }
    scheduleSessionHistoryBroadcast(asset.sessionId, 'telegram-file-id-repaired');
}

async function telegramSendMessage(chatId, text, replyMarkup = undefined) {
    if (!chatId || !isTelegramBotEnabled()) return;
    const language = telegramChatLanguages.get(String(chatId)) || 'zh-Hans';
    const localizedText = translateTelegramText(text, language);
    const localizeMarkup = value => {
        if (Array.isArray(value)) return value.map(localizeMarkup);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
            if ((key === 'text' || key === 'input_field_placeholder') && typeof entry === 'string') {
                return [key, translateTelegramText(entry, language)];
            }
            return [key, localizeMarkup(entry)];
        }));
    };
    await telegramApi('sendMessage', {
        chat_id: chatId,
        text: localizedText,
        reply_markup: localizeMarkup(replyMarkup)
    }).catch(err => {
        console.warn(`telegram sendMessage failed: ${err.message}`);
    });
}

function getTelegramCloudOversizedFiles(files) {
    return (Array.isArray(files) ? files : [files]).filter(file =>
        file && Number(file.size) > TELEGRAM_CLOUD_GET_FILE_MAX_SIZE
    );
}

async function rejectTelegramCloudOversizedFiles(chatId, files) {
    const oversized = getTelegramCloudOversizedFiles(files);
    if (!oversized.length) return false;
    recordExternalDependencyEvent('telegram-bot-api', 'getFile-size-policy-block', {
        level: 'warn',
        endpoint: TELEGRAM_GET_FILE_DOC_URL,
        message: 'A file was blocked by the locally enforced Telegram Bot API getFile size limit.',
        details: {
            configuredLimitBytes: TELEGRAM_CLOUD_GET_FILE_MAX_SIZE,
            blockedCount: oversized.length,
            largestBlockedBytes: Math.max(...oversized.map(file => Number(file?.size) || 0))
        },
        hint: 'This limit mirrors an external Telegram API rule; re-check the upstream Bot API documentation if Telegram changes the limit.'
    });
    const names = oversized.slice(0, 3).map(file => file.name || 'telegram-file').join('\n');
    const remaining = oversized.length > 3 ? `\n……以及另外 ${oversized.length - 3} 个文件` : '';
    await telegramSendMessage(chatId,
        `以下文件超过 20MB，已拦截，无法通过 Telegram 官方云端 Bot API 转发到隧道：\n${names}${remaining}\n\n` +
        `Telegram 官方说明：Bot API 的 getFile 目前只能下载不超过 20MB 的文件。\n${TELEGRAM_GET_FILE_DOC_URL}`
    );
    return true;
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

async function downloadTelegramFile(fileId, maxSize = TELEGRAM_CLOUD_GET_FILE_MAX_SIZE) {
    const file = await telegramApi('getFile', { file_id: fileId });
    if (!file?.file_path) throw new Error('telegram-file-path-missing');
    const expectedSize = Number(file.file_size) || 0;
    if (expectedSize > maxSize) {
        const err = new Error('telegram-file-too-large-before-download');
        err.fileSize = expectedSize;
        throw err;
    }
    const endpoint = 'https://api.telegram.org/file/bot[redacted]/<file_path>';
    let response;
    try {
        response = await fetch(`https://api.telegram.org/file/bot${getTelegramBotToken()}/${file.file_path}`);
    } catch (cause) {
        const error = new Error(describeTelegramNetworkError(cause));
        error.cause = cause;
        recordExternalDependencyEvent('telegram-bot-api', 'file-download', {
            level: 'error', endpoint, error,
            hint: 'Telegram file API could not be reached; check network/proxy and upstream availability.'
        });
        throw error;
    }
    if (!response.ok) {
        const error = new Error(`telegram-file-download-${response.status}`);
        recordExternalDependencyEvent('telegram-bot-api', 'file-download', {
            level: 'error', endpoint, upstreamStatus: response.status, error,
            hint: 'Telegram file API rejected the stored file path; file lifetime/limits/API behavior may have changed.'
        });
        throw error;
    }
    return Buffer.from(await response.arrayBuffer());
}

function getOrCreateTelegramSession(sessionId, shortCode = '') {
    let session = sessions.get(sessionId);
    if (!session) {
        const storedTunnel = infraStore?.getTunnel(sessionId);
        session = {
            devices: new Map(),
            editorAssets: new Map(),
            fileAssets: new Map(),
            history: [],
            deletedMessageIds: [],
            shortCode: normalizeShortCode(shortCode),
            remark: sanitizeString(storedTunnel?.remark || '', 60),
            ownerDeviceId: sanitizeString(storedTunnel?.owner_device_id || '', 80),
            permissions: parseStoredTunnelPermissions(storedTunnel?.permissions_json),
            admins: parseStoredTunnelAdmins(storedTunnel?.permissions_json),
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

async function receiveYoutubePremiumForwardUpload(req, task) {
    const expected = Number(task.outputFileSize) || 0;
    const declared = Number(req.get('X-Drop2Tunnel-File-Size')) || 0;
    const expectedVersion = `${Number(task.completedAt) || 0}-${expected}`;
    if (!req.is('application/octet-stream')) throw new Error('youtube-premium-forward-upload-required');
    if (!expected || declared !== expected) throw new Error('youtube-premium-forward-size-mismatch');
    if (req.get('X-Drop2Tunnel-Cache-Version') !== expectedVersion) {
        throw new Error('youtube-premium-forward-cache-stale');
    }
    fs.mkdirSync(TELEGRAM_ASSET_DIR, { recursive: true });
    const uploadPath = path.join(TELEGRAM_ASSET_DIR, `.premium-upload-${crypto.randomUUID()}`);
    let received = 0;
    try {
        await pipeline(
            req,
            async function* validateUpload(source) {
                for await (const chunk of source) {
                    received += chunk.length;
                    if (received > expected) throw new Error('youtube-premium-forward-size-mismatch');
                    yield chunk;
                }
            },
            fs.createWriteStream(uploadPath, { flags: 'wx' })
        );
        if (received !== expected) throw new Error('youtube-premium-forward-size-mismatch');
        return { path: uploadPath, size: received };
    } catch (error) {
        fs.rmSync(uploadPath, { force: true });
        throw error;
    }
}

async function forwardYoutubePremiumTaskToTunnel(taskId, sessionId, upload) {
    const task = youtubePremiumService.get(taskId);
    const tunnel = isValidSessionId(sessionId) ? infraStore?.getTunnel(sessionId) : null;
    if (!task || !upload?.path || Number(upload.size) !== Number(task.outputFileSize)) {
        throw new Error('youtube-premium-file-not-found');
    }
    if (!tunnel) throw new Error('youtube-premium-target-tunnel-not-found');

    const assetId = createServerAssetId();
    const assetPath = path.join(TELEGRAM_ASSET_DIR, assetId);
    try {
        await fs.promises.rename(upload.path, assetPath);
    } catch (error) {
        fs.rmSync(upload.path, { force: true });
        fs.rmSync(assetPath, { force: true });
        throw error;
    }
    const asset = {
        id: assetId,
        path: assetPath,
        name: sanitizeString(task.outputFileName || 'youtube-premium-media', 180),
        type: getMimeTypeFromFileName(task.outputFileName),
        size: upload.size,
        sessionId,
        createdAt: Date.now(),
        source: 'youtube-premium'
    };
    persistTelegramServerAsset(asset);

    const shortCode = normalizeShortCode(tunnel.short_code || findShortCodeForSession(sessionId));
    const session = getOrCreateTelegramSession(sessionId, shortCode);
    const remark = String(task.url || '').slice(0, TELEGRAM_REMARK_MAX_LENGTH);
    const message = {
        id: crypto.randomUUID(),
        type: 'file',
        fileInfo: {
            id: asset.id, name: asset.name, size: asset.size, type: asset.type, timestamp: Date.now(),
            sender: TELEGRAM_BOT_DEVICE_ID, senderName: 'YouTube Premium', ownerDeviceId: TELEGRAM_BOT_DEVICE_ID,
            isAsset: false, isServerAsset: true, serverAssetUrl: `/api/server-assets/${asset.id}`,
            sourceChannel: 'youtube-premium', remark
        },
        timestamp: Date.now(), sender: TELEGRAM_BOT_DEVICE_ID, senderName: 'YouTube Premium', sessionId, remark
    };
    addToSessionHistory(sessionId, session, message, { fromDeviceId: TELEGRAM_BOT_DEVICE_ID, source: 'youtube-premium' });
    session.lastActivity = Date.now();
    emitToReadableSessionDevices(session, 'message', { message });
    scheduleSessionHistoryBroadcast(sessionId, 'youtube-premium-forward', 300);
    return { ok: true, messageId: message.id, sessionId, shortCode };
}

async function publishTelegramFileToTunnel(chatId, shortCode, telegramFile) {
    const sessionId = infraStore?.findSessionIdByShortCode(shortCode) || shortCodes.get(shortCode);
    if (!sessionId || !isValidSessionId(sessionId)) {
        await telegramSendMessage(chatId, '没有找到这个隧道暗号，请确认 5 位暗号是否正确。');
        return false;
    }
    if (await rejectTelegramCloudOversizedFiles(chatId, telegramFile)) return false;
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
        source: 'telegram-bot',
        fileId: telegramFile.fileId,
        fileUniqueId: telegramFile.fileUniqueId || '',
        fileIdUpdatedAt: Date.now()
    };
    persistTelegramServerAsset(asset);
    const session = getOrCreateTelegramSession(sessionId, shortCode);
    const messageId = crypto.randomUUID();
    const messageRemark = await buildTelegramRemarkWithSocialMetadata(telegramFile.remark);
    const snsMetadata = createTelegramSnsPlaceholderMetadata(telegramFile.remark, messageId);
    const message = {
        id: messageId,
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
            remark: messageRemark,
            telegramFileId: asset.fileId,
            telegramFileUniqueId: asset.fileUniqueId,
            telegramFileIdUpdatedAt: asset.fileIdUpdatedAt
        },
        timestamp: Date.now(),
        sender: TELEGRAM_BOT_DEVICE_ID,
        senderName: 'Telegram Bot',
        sessionId,
        remark: messageRemark,
        snsSources: snsMetadata.sources,
        snsMediaItems: snsMetadata.items
    };
    addToSessionHistory(sessionId, session, message, {
        fromDeviceId: TELEGRAM_BOT_DEVICE_ID,
        source: 'telegram-bot'
    });
    session.lastActivity = Date.now();
    emitToReadableSessionDevices(session, 'message', { message });
    scheduleSessionHistoryBroadcast(sessionId, 'telegram-bot-file', 300);
    queueTelegramSnsMetadataScan(sessionId, messageId, telegramFile.remark);
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
        source: 'telegram-bot',
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
        remark: String(telegramFile.remark || '').trim().slice(0, TELEGRAM_REMARK_MAX_LENGTH),
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
    if (await rejectTelegramCloudOversizedFiles(chatId, telegramFiles)) return false;
    const fileInfos = [];
    for (const telegramFile of telegramFiles.slice(0, 100)) {
        fileInfos.push(await prepareTelegramCollectionAsset(sessionId, telegramFile));
    }
    if (!fileInfos.length) return false;
    const session = getOrCreateTelegramSession(sessionId, shortCode);
    const messageId = crypto.randomUUID();
    const messageRemark = await buildTelegramRemarkWithSocialMetadata(remark);
    const snsMetadata = createTelegramSnsPlaceholderMetadata(remark, messageId);
    const message = {
        id: messageId,
        type: 'collection',
        collection: {
            id: crypto.randomUUID(),
            files: fileInfos,
            count: fileInfos.length,
            totalSize: fileInfos.reduce((sum, file) => sum + file.size, 0),
            remark: messageRemark
        },
        timestamp: Date.now(),
        sender: TELEGRAM_BOT_DEVICE_ID,
        senderName: 'Telegram Bot',
        sessionId,
        remark: messageRemark,
        snsSources: snsMetadata.sources,
        snsMediaItems: snsMetadata.items
    };
    addToSessionHistory(sessionId, session, message, { fromDeviceId: TELEGRAM_BOT_DEVICE_ID, source: 'telegram-bot-album' });
    session.lastActivity = Date.now();
    emitToReadableSessionDevices(session, 'message', { message });
    scheduleSessionHistoryBroadcast(sessionId, 'telegram-bot-album', 300);
    queueTelegramSnsMetadataScan(sessionId, messageId, remark);
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
    const snsMetadata = createTelegramSnsPlaceholderMetadata(text, message.id);
    if (snsMetadata.sources.length || snsMetadata.items.length) {
        message.snsSources = snsMetadata.sources;
        message.snsMediaItems = snsMetadata.items;
    }
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
        emitToReadableSessionDevices(session, 'message', { message });
        scheduleSessionHistoryBroadcast(sessionId, 'telegram-bot-text', 300);
        queueTelegramSnsMetadataScan(sessionId, message.id, text);
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

function getHistoryMessageEntry(session, messageId) {
    if (!session || !messageId) return null;
    return session.history.find(entry => entry.message?.id === messageId) || null;
}

function replaceHistoryMessage(sessionId, session, message, reason = 'message-updated') {
    const historyIndex = session.history.findIndex(entry => entry.message?.id === message.id);
    if (historyIndex < 0) return false;
    const historyMessage = createHistoryMessage(message);
    const size = Buffer.byteLength(JSON.stringify(historyMessage), 'utf8');
    const previous = session.history[historyIndex];
    session.history[historyIndex] = { message: historyMessage, size };
    session.historySize = Math.max(0, session.historySize - previous.size + size);
    session.lastActivity = Date.now();
    emitToReadableSessionDevices(session, 'message-updated', { message: historyMessage });
    scheduleSessionHistoryBroadcast(sessionId, reason, 500);
    return true;
}

function updateSnsMediaItem(sessionId, messageId, mediaItemId, patch, reason = 'sns-media-updated') {
    const session = sessions.get(sessionId);
    const entry = getHistoryMessageEntry(session, messageId);
    const message = entry?.message;
    if (!message || !Array.isArray(message.snsMediaItems)) return null;
    const index = message.snsMediaItems.findIndex(item => item?.id === mediaItemId);
    if (index < 0) return null;
    const nextItem = {
        ...message.snsMediaItems[index],
        ...patch,
        updatedAt: Date.now()
    };
    message.snsMediaItems[index] = nextItem;
    replaceHistoryMessage(sessionId, session, message, reason);
    return nextItem;
}

function getMimeTypeFromFileName(fileName = '') {
    const ext = path.extname(fileName).slice(1).toLowerCase();
    if (['jpg', 'jpeg'].includes(ext)) return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'mp4') return 'video/mp4';
    if (ext === 'webm') return 'video/webm';
    if (ext === 'mkv') return 'video/x-matroska';
    if (ext === 'mov') return 'video/quicktime';
    if (ext === 'mp3') return 'audio/mpeg';
    if (ext === 'm4a') return 'audio/mp4';
    if (ext === 'aac') return 'audio/aac';
    if (ext === 'ogg') return 'audio/ogg';
    if (ext === 'opus') return 'audio/ogg';
    if (ext === 'wav') return 'audio/wav';
    if (ext === 'flac') return 'audio/flac';
    return 'application/octet-stream';
}

function getSnsTaskPath(taskId) {
    return path.join(SNS_MEDIA_TASK_DIR, `${taskId}.json`);
}

function readSnsTask(taskId) {
    if (!/^[a-zA-Z0-9_-]{12,80}$/.test(String(taskId || ''))) return null;
    try {
        return JSON.parse(fs.readFileSync(getSnsTaskPath(taskId), 'utf8'));
    } catch (_) {
        return null;
    }
}

function persistSnsTask(task) {
    fs.mkdirSync(SNS_MEDIA_TASK_DIR, { recursive: true });
    const next = { ...task, updatedAt: Date.now() };
    writeDataFileAtomic(getSnsTaskPath(next.id), JSON.stringify(next, null, 2));
    return next;
}

function listSnsWorkFiles(prefix) {
    if (!fs.existsSync(SNS_MEDIA_WORK_DIR)) return [];
    return fs.readdirSync(SNS_MEDIA_WORK_DIR)
        .filter(name => name.startsWith(prefix) && !name.endsWith('.part') && !name.endsWith('.ytdl'))
        .map(name => path.join(SNS_MEDIA_WORK_DIR, name))
        .filter(filePath => {
            try { return fs.statSync(filePath).isFile(); } catch (_) { return false; }
        });
}

function cleanupSnsWorkFiles(prefix) {
    if (!fs.existsSync(SNS_MEDIA_WORK_DIR)) return;
    fs.readdirSync(SNS_MEDIA_WORK_DIR)
        .filter(name => name.startsWith(prefix))
        .map(name => path.join(SNS_MEDIA_WORK_DIR, name))
        .forEach(filePath => {
            try { fs.unlinkSync(filePath); } catch (_) {}
        });
}

function findDownloadedSnsFile(prefix, predicate = () => true) {
    return listSnsWorkFiles(prefix)
        .filter(predicate)
        .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0] || '';
}

function spawnCapture(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const commandName = path.basename(String(command || '')).toLowerCase();
        const externallyManagedTool = options.ytDlp || /^(?:ffmpeg|ffprobe)(?:\.exe)?$/.test(commandName);
        const reportToolFailure = (operation, error, extra = {}) => {
            if (!externallyManagedTool || String(error?.message || '') === 'download-cancelled') return;
            recordExternalDependencyEvent('local-media-toolchain', operation, {
                level: 'error', error,
                details: { command: commandName, ...extra },
                hint: 'An external executable failed. Check installation/version compatibility before treating this as an application logic failure.'
            });
        };
        const child = spawn(command, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: options.env || { ...process.env }
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer = null;
        const signal = options.signal;
        const finish = () => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        };
        const abort = () => {
            if (settled) return;
            settled = true;
            child.kill('SIGTERM');
            finish();
            reject(new Error('download-cancelled'));
        };
        const maxOutput = Number(options.maxOutput || 2 * 1024 * 1024);
        const append = (current, chunk) => (current + String(chunk || '')).slice(-maxOutput);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            stdout = append(stdout, chunk);
            options.onOutput?.(chunk);
        });
        child.stderr.on('data', chunk => {
            stderr = append(stderr, chunk);
            options.onOutput?.(chunk);
        });
        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGTERM');
            finish();
            const error = new Error(options.timeoutError || `${path.basename(command)}-timeout`);
            reportToolFailure(`${commandName || 'tool'}-timeout`, error);
            reject(error);
        }, Math.max(1000, Number(options.timeoutMs) || 10 * 60 * 1000));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) return abort();
        child.on('error', err => {
            if (settled) return;
            settled = true;
            finish();
            const error = new Error(err.code === 'ENOENT' ? `${path.basename(command)}-not-found` : err.message);
            error.code = err.code;
            reportToolFailure(`${commandName || 'tool'}-spawn`, error);
            reject(error);
        });
        child.on('close', code => {
            if (settled) return;
            settled = true;
            finish();
            if (code !== 0) {
                const fallback = stderr.trim().slice(-1000) || `${path.basename(command)}-exit-${code}`;
                const error = new Error(options.ytDlp ? getYtDlpFailureMessage(stderr, fallback) : fallback);
                reportToolFailure(`${commandName || 'tool'}-exit`, error, { exitCode: code });
                return reject(error);
            }
            resolve({ stdout, stderr });
        });
    });
}

function spawnYtDlpCapture(args, options = {}) {
    const cookies = copyYtDlpCookies(args);
    const invocation = getYtDlpInvocation(cookies.args);
    return spawnCapture(invocation.command, invocation.args, {
        ...options,
        ytDlp: true,
        env: buildYtDlpEnv()
    }).catch(error => {
        if (options.sourceUrl && error?.message !== 'download-cancelled') {
            recordExternalDependencyEvent(getYtDlpDependencyId(options.sourceUrl), options.operation || 'media-download', {
                level: 'error', endpoint: options.sourceUrl, error,
                hint: 'External media download failed; upstream site behavior, authentication, formats or extractor compatibility may have changed.'
            });
        }
        throw error;
    }).finally(cookies.cleanup);
}

async function probeMediaFile(filePath, options = {}) {
    const result = await spawnCapture(FFPROBE_COMMAND, [
        '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath
    ], { timeoutMs: 30000, timeoutError: 'ffprobe-timeout', signal: options.signal });
    try {
        return JSON.parse(result.stdout);
    } catch (err) {
        throw new Error(`ffprobe-json-parse-failed: ${err.message}`);
    }
}

function parseYtDlpProgress(chunk, onProgress, state) {
    const text = String(chunk || '');
    const percentMatch = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (!percentMatch) return;
    const now = Date.now();
    if (now - state.lastAt < 900 && Number(percentMatch[1]) < 99.9) return;
    state.lastAt = now;
    const sizeMatch = text.match(/of\s+~?\s*([0-9.]+)(\w+i?B)/i);
    const speedMatch = text.match(/at\s+([0-9.]+\w+i?B\/s)/i);
    const etaMatch = text.match(/ETA\s+([0-9:]+)/i);
    const percent = Math.max(0, Math.min(100, Number(percentMatch[1]) || 0));
    onProgress({
        percent,
        downloadedText: sizeMatch ? `${(Number(sizeMatch[1]) * percent / 100).toFixed(1)}${sizeMatch[2]}` : '',
        totalText: sizeMatch ? `${sizeMatch[1]}${sizeMatch[2]}` : '',
        speedText: speedMatch?.[1] || '',
        etaText: etaMatch?.[1] || ''
    });
}

function getYtDlpDownloadSelectionArgs(playlistItem = 0) {
    playlistItem = Math.trunc(Number(playlistItem));
    return playlistItem > 0
        ? ['--yes-playlist', '--playlist-items', String(playlistItem)]
        : ['--no-playlist'];
}

function isYtDlpRequestedFormatUnavailable(error) {
    return /requested format is not available|only images are available/i.test(String(error?.message || error || ''));
}

async function runYtDlpDownload(url, assetId, onProgress = () => {}, playlistItem = 0, options = {}) {
    fs.mkdirSync(SNS_MEDIA_WORK_DIR, { recursive: true });
    cleanupSnsWorkFiles(`${assetId}.`);
    const progressState = { lastAt: 0 };
    const maxFileSize = options.maxFileSize === null ? 0 : Number(options.maxFileSize || getTelegramMaxFileSize());
    let merging = false;
    const primarySelector = options.formatSelector || getYtDlpFormatSelector(url);
    const selectors = [primarySelector];
    if (isYouTubeUrl(url) && options.allowFormatFallback === true) {
        selectors.push(getYtDlpFormatSelector(url), 'bv*+ba/best');
    }
    const uniqueSelectors = [...new Set(selectors.filter(Boolean))];
    let lastFormatError = null;
    for (let attempt = 0; attempt < uniqueSelectors.length; attempt++) {
        const selector = uniqueSelectors[attempt];
        options.onDetail?.({
            message: '启动 yt-dlp 媒体下载',
            details: {
                attempt: attempt + 1,
                attempts: uniqueSelectors.length,
                formatSelector: selector,
                mergeOutputFormat: options.mergeOutputFormat || 'mp4',
                downloadSections: options.downloadSections || '完整媒体'
            }
        });
        cleanupSnsWorkFiles(`${assetId}.`);
        const args = [
            '--newline', ...getYtDlpDownloadSelectionArgs(playlistItem), '--cache-dir', YT_DLP_CACHE_DIR,
            ...getYtDlpRemoteComponentArgs(url),
            ...getYtDlpFfmpegArgs(),
            '-f', selector,
            '--merge-output-format', options.mergeOutputFormat || 'mp4',
            '-o', path.join(SNS_MEDIA_WORK_DIR, `${assetId}.%(ext)s`),
            ...getYtDlpCookieArgs(url, options.cookiePath),
            url
        ];
        if (options.downloadSections) args.splice(args.length - 1, 0, '--download-sections', String(options.downloadSections));
        if (maxFileSize > 0) args.splice(args.indexOf('-o'), 0, '--max-filesize', String(maxFileSize));
        try {
            await spawnYtDlpCapture(args, {
                sourceUrl: url,
                operation: attempt ? 'sns-media-download-format-fallback' : 'sns-media-download',
                timeoutMs: Number(process.env.SOCIAL_YTDLP_DOWNLOAD_TIMEOUT_MS || 30 * 60 * 1000),
                timeoutError: 'yt-dlp-download-timeout',
                signal: options.signal,
                onOutput: chunk => {
                    parseYtDlpProgress(chunk, onProgress, progressState);
                    if (!merging && /\[(?:Merger|VideoRemuxer|Fixup)/i.test(String(chunk || ''))) {
                        merging = true;
                        options.onStage?.('merging');
                    }
                }
            });
            lastFormatError = null;
            options.onDetail?.({
                message: 'yt-dlp 媒体下载命令执行成功',
                details: { attempt: attempt + 1, formatSelector: selector }
            });
            break;
        } catch (error) {
            if (!isYtDlpRequestedFormatUnavailable(error) || attempt >= uniqueSelectors.length - 1) throw error;
            lastFormatError = error;
            options.onDetail?.({
                level: 'warn',
                message: '当前格式选择不可用，准备使用备用选择器重试',
                details: { failedSelector: selector, nextSelector: uniqueSelectors[attempt + 1] }
            });
            recordExternalDependencyEvent('youtube-yt-dlp', 'youtube-premium-download-format-fallback', {
                level: 'warn', endpoint: url, error,
                details: { failedSelector: selector, nextSelector: uniqueSelectors[attempt + 1] },
                hint: 'Authenticated YouTube format inventory changed between parse/download; retrying an automatic selector instead of failing the task immediately.'
            });
        }
    }
    if (lastFormatError) throw lastFormatError;
    const filePath = findDownloadedSnsFile(`${assetId}.`);
    if (!filePath) throw new Error('yt-dlp-output-missing');
    options.onDetail?.({
        message: '已找到 yt-dlp 下载输出',
        details: { filePath, fileSize: fs.statSync(filePath).size }
    });
    return filePath;
}

function sanitizeMediaFilePart(value, fallback) {
    const replacements = { '\\': '＼', '/': '／', ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜' };
    const result = String(value || '')
        .replace(/[\\/:*?"<>|]/g, char => replacements[char])
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[. ]+$/g, '')
        .trim()
        .slice(0, 110);
    return result || fallback;
}

function formatMediaDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours > 0
        ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function getAudioProbeSummary(probe = {}) {
    const audio = probe.streams?.find(stream => stream.codec_type === 'audio') || {};
    const format = probe.format || {};
    const bitRate = Number(audio.bit_rate || format.bit_rate) || 0;
    const codecName = String(audio.codec_name || '').toUpperCase();
    const profile = String(audio.profile || '').trim();
    return {
        codecName: String(audio.codec_name || '').toLowerCase(),
        formatLabel: [codecName === 'AAC' ? 'AAC' : codecName, profile].filter(Boolean).join(' ').trim() || '未知',
        bitRate,
        bitRateLabel: bitRate > 0 ? `${Math.round(bitRate / 1000)}kbps` : '未知',
        duration: Number(audio.duration || format.duration) || 0,
        durationLabel: formatMediaDuration(audio.duration || format.duration)
    };
}

async function createSquareCover(sourcePath, outputPath, options = {}) {
    const probe = await probeMediaFile(sourcePath, options);
    const image = probe.streams?.find(stream => stream.codec_type === 'video');
    const width = Number(image?.width) || 0;
    const height = Number(image?.height) || 0;
    if (!width || !height) throw new Error('song-cover-dimensions-missing');
    let crop = null;
    if (width > height) {
        try {
            const detection = await spawnCapture(FFMPEG_COMMAND, [
                '-hide_banner', '-loglevel', 'info', '-loop', '1', '-i', sourcePath,
                '-t', '0.15', '-vf', 'cropdetect=24:2:0', '-f', 'null', '-'
            ], { timeoutMs: 30000, timeoutError: 'song-cover-cropdetect-timeout', signal: options.signal });
            const matches = Array.from(detection.stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g));
            const values = matches.at(-1)?.slice(1).map(Number);
            if (values?.length === 4) {
                const [detectedWidth, detectedHeight, detectedX, detectedY] = values;
                const centered = Math.abs(detectedX - (width - detectedWidth) / 2) <= Math.max(8, width * 0.03);
                const mostlySquare = detectedWidth / detectedHeight >= 0.82 && detectedWidth / detectedHeight <= 1.18;
                if (centered && mostlySquare) {
                    const side = Math.min(detectedWidth, detectedHeight);
                    crop = { side, x: Math.round(detectedX + (detectedWidth - side) / 2), y: Math.round(detectedY + (detectedHeight - side) / 2) };
                }
            }
        } catch (_) {
            // Center-crop below is the safe fallback when black-border detection is inconclusive.
        }
    }
    if (!crop) {
        const side = Math.min(width, height);
        crop = { side, x: Math.round((width - side) / 2), y: Math.round((height - side) / 2) };
    }
    await spawnCapture(FFMPEG_COMMAND, [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', sourcePath,
        '-vf', `crop=${crop.side}:${crop.side}:${crop.x}:${crop.y}`,
        '-frames:v', '1', '-q:v', '2', outputPath
    ], { timeoutMs: 60000, timeoutError: 'song-cover-process-timeout', signal: options.signal });
    const finalProbe = await probeMediaFile(outputPath, options);
    const finalImage = finalProbe.streams?.find(stream => stream.codec_type === 'video');
    if (!finalImage || Number(finalImage.width) !== Number(finalImage.height)) throw new Error('song-cover-not-square');
    return outputPath;
}

async function downloadAndProcessYoutubeSong(item, taskRecord, onProgress, onStage, options = {}) {
    const url = item.sourceUrl || item.mediaUrl;
    const prefix = `${taskRecord.id}.source.`;
    fs.mkdirSync(SNS_MEDIA_WORK_DIR, { recursive: true });
    cleanupSnsWorkFiles(prefix);
    const progressState = { lastAt: 0 };
    onStage('fetching_song');
    const maxFileSize = options.maxFileSize === null ? 0 : Number(options.maxFileSize || getTelegramMaxFileSize());
    const primarySelector = options.formatSelector || getYtDlpAudioFormatSelector();
    const selectors = [primarySelector];
    if (options.strictFormatSelection !== true) {
        selectors.push(getYtDlpAudioFormatSelector(), 'bestaudio/best[acodec!=none]/best');
    }
    const uniqueSelectors = [...new Set(selectors.filter(Boolean))];
    let downloaded = false;
    let lastFormatError = null;
    for (let attempt = 0; attempt < uniqueSelectors.length; attempt++) {
        const selector = uniqueSelectors[attempt];
        options.onDetail?.({
            message: '启动 yt-dlp 歌曲与封面下载',
            details: {
                attempt: attempt + 1,
                attempts: uniqueSelectors.length,
                formatSelector: selector,
                strictFormatSelection: options.strictFormatSelection === true,
                downloadSections: options.downloadSections || '完整媒体'
            }
        });
        cleanupSnsWorkFiles(prefix);
        const args = [
            '--newline', '--no-playlist', '--cache-dir', YT_DLP_CACHE_DIR,
            ...getYtDlpRemoteComponentArgs(url),
            ...getYtDlpFfmpegArgs(),
            '-f', selector,
            '--write-thumbnail', '--convert-thumbnails', 'jpg',
            '-o', path.join(SNS_MEDIA_WORK_DIR, `${prefix}%(ext)s`),
            ...getYtDlpCookieArgs(url, options.cookiePath),
            url
        ];
        if (options.downloadSections) args.splice(args.length - 1, 0, '--download-sections', String(options.downloadSections));
        if (maxFileSize > 0) args.splice(args.indexOf('--write-thumbnail'), 0, '--max-filesize', String(maxFileSize));
        try {
            await spawnYtDlpCapture(args, {
                sourceUrl: url,
                operation: attempt ? 'youtube-song-download-format-fallback' : 'youtube-song-download',
                timeoutMs: Number(process.env.SOCIAL_YTDLP_DOWNLOAD_TIMEOUT_MS || 30 * 60 * 1000),
                timeoutError: 'yt-dlp-song-download-timeout',
                signal: options.signal,
                onOutput: chunk => parseYtDlpProgress(chunk, onProgress, progressState)
            });
            downloaded = true;
            lastFormatError = null;
            options.onDetail?.({
                message: 'yt-dlp 歌曲与封面下载命令执行成功',
                details: { attempt: attempt + 1, formatSelector: selector }
            });
            break;
        } catch (error) {
            if (!isYtDlpRequestedFormatUnavailable(error) || attempt >= uniqueSelectors.length - 1) throw error;
            lastFormatError = error;
            options.onDetail?.({
                level: 'warn',
                message: '歌曲格式选择不可用，准备使用备用音频选择器重试',
                details: { failedSelector: selector, nextSelector: uniqueSelectors[attempt + 1] }
            });
            recordExternalDependencyEvent('youtube-yt-dlp', 'youtube-song-download-format-fallback', {
                level: 'warn', endpoint: url, error,
                details: { failedSelector: selector, nextSelector: uniqueSelectors[attempt + 1] },
                hint: 'YouTube logged-in cookie/player-client format availability changed; retrying with a broader audio/combined selector.'
            });
        }
    }
    if (!downloaded && lastFormatError) throw lastFormatError;
    const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
    const sourceAudio = findDownloadedSnsFile(prefix, filePath => !imageExts.has(path.extname(filePath).toLowerCase()));
    const sourceCover = findDownloadedSnsFile(prefix, filePath => imageExts.has(path.extname(filePath).toLowerCase()));
    if (!sourceAudio) throw new Error('yt-dlp-song-audio-missing');
    if (!sourceCover) throw new Error('yt-dlp-song-cover-missing');
    if (maxFileSize > 0 && fs.statSync(sourceAudio).size > maxFileSize) throw new Error('sns-media-file-too-large');
    options.onDetail?.({
        message: '已取得歌曲源文件与 YouTube 封面',
        details: {
            sourceAudio,
            sourceAudioSize: fs.statSync(sourceAudio).size,
            sourceCover,
            sourceCoverSize: fs.statSync(sourceCover).size
        }
    });

    onStage('processing_cover');
    const squareCover = path.join(SNS_MEDIA_WORK_DIR, `${taskRecord.id}.cover.jpg`);
    options.onDetail?.({ message: '开始裁切并验证方形歌曲封面', details: { sourceCover, squareCover } });
    await createSquareCover(sourceCover, squareCover, options);
    options.onDetail?.({ message: '方形歌曲封面处理完成', details: { squareCover, size: fs.statSync(squareCover).size } });
    const sourceProbe = await probeMediaFile(sourceAudio, options);
    const sourceSummary = getAudioProbeSummary(sourceProbe);
    options.onDetail?.({ message: '源音频探测完成', details: sourceSummary });
    const sourceUrl = normalizeYoutubeSourceUrl(item.sourceUrl || item.mediaUrl || '');
    const providedMetadata = item.songMetadata || {};
    const metadata = {
        title: sanitizeString(providedMetadata.title || providedMetadata.track || item.title || item.youtubeVideoId || '未知曲名', 240),
        artist: sanitizeString(providedMetadata.artist || '未知艺术家', 240),
        album: sanitizeString(providedMetadata.album || '', 240),
        album_artist: sanitizeString(providedMetadata.album_artist || providedMetadata.albumArtist || providedMetadata.artist || '未知艺术家', 240),
        composer: sanitizeString(providedMetadata.composer || '', 240),
        genre: sanitizeString(providedMetadata.genre || '', 240),
        track: sanitizeString(providedMetadata.trackNumber || (providedMetadata.title ? providedMetadata.track : '') || '', 40),
        disc: sanitizeString(providedMetadata.disc || providedMetadata.discNumber || '', 40),
        date: extractMediaYear(providedMetadata.date || providedMetadata.year),
        comment: sanitizeString(providedMetadata.comment || sourceUrl, 4000),
        lyrics: sanitizeString(providedMetadata.lyrics || '', 12000)
    };
    const finalAudio = path.join(SNS_MEDIA_WORK_DIR, `${taskRecord.id}.final.m4a`);
    const audioCodecArgs = sourceSummary.codecName === 'aac'
        ? ['-c:a', 'copy']
        : ['-c:a', 'aac', '-b:a', `${Math.max(96, Math.min(256, Math.round((sourceSummary.bitRate || 128000) / 1000)))}k`];
    onStage('writing_metadata');
    options.onDetail?.({
        message: '开始写入歌曲元信息并嵌入封面',
        details: {
            output: finalAudio,
            audioMode: sourceSummary.codecName === 'aac' ? '复制 AAC 音轨' : `转码 ${audioCodecArgs.at(-1)}`,
            metadata: {
                title: metadata.title,
                artist: metadata.artist,
                album: metadata.album,
                albumArtist: metadata.album_artist,
                composer: metadata.composer,
                genre: metadata.genre,
                track: metadata.track,
                disc: metadata.disc,
                date: metadata.date,
                hasComment: Boolean(metadata.comment),
                hasLyrics: Boolean(metadata.lyrics)
            }
        }
    });
    await spawnCapture(FFMPEG_COMMAND, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', sourceAudio, '-i', squareCover,
        '-map', '0:a:0', '-map', '1:v:0',
        ...audioCodecArgs, '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic',
        ...Object.entries(metadata).flatMap(([key, value]) => ['-metadata', `${key}=${value}`]),
        '-metadata:s:v:0', 'title=Album cover', '-metadata:s:v:0', 'comment=Cover (front)',
        '-movflags', '+faststart', finalAudio
    ], { timeoutMs: 10 * 60 * 1000, timeoutError: 'song-metadata-write-timeout', signal: options.signal });

    const finalProbe = await probeMediaFile(finalAudio, options);
    const finalAudioStream = finalProbe.streams?.find(stream => stream.codec_type === 'audio');
    const coverStream = finalProbe.streams?.find(stream => stream.codec_type === 'video' && Number(stream.disposition?.attached_pic) === 1);
    const formatName = String(finalProbe.format?.format_name || '');
    if (!finalAudioStream || !/(?:mov|mp4|m4a)/i.test(formatName)) throw new Error('song-final-m4a-invalid');
    if (!coverStream) throw new Error('song-cover-not-embedded');
    const finalSummary = getAudioProbeSummary(finalProbe);
    const tags = finalProbe.format?.tags || {};
    options.onDetail?.({
        message: '歌曲成品校验完成',
        details: { finalAudio, fileSize: fs.statSync(finalAudio).size, embeddedCover: true, ...finalSummary }
    });
    return {
        finalAudio,
        squareCover,
        fileName: `${sanitizeMediaFilePart(metadata.artist, '未知艺术家')} - ${sanitizeMediaFilePart(metadata.title, '未知曲名')}.m4a`,
        coverName: `${sanitizeMediaFilePart(metadata.artist, '未知艺术家')} - ${sanitizeMediaFilePart(metadata.title, '未知曲名')} - 封面.jpg`,
        metadata: {
            title: String(tags.title || metadata.title),
            artist: String(tags.artist || metadata.artist),
            album: String(tags.album || metadata.album),
            album_artist: String(tags.album_artist || metadata.album_artist),
            composer: String(tags.composer || metadata.composer),
            genre: String(tags.genre || metadata.genre),
            track: String(tags.track || metadata.track),
            disc: String(tags.disc || metadata.disc),
            date: String(tags.date || metadata.date),
            comment: String(tags.comment || metadata.comment),
            lyrics: String(tags.lyrics || metadata.lyrics)
        },
        probe: finalSummary
    };
}

function requireYoutubePremiumCookies() {
    const status = getYoutubePremiumCookieStatus();
    if (!status.configured) throw new Error('youtube-premium-cookie-required');
    return YOUTUBE_PREMIUM_COOKIE_PATH;
}

async function downloadYoutubePremiumOriginalThumbnail(taskId) {
    const task = youtubePremiumService.get(taskId);
    if (!task) throw new Error('youtube-premium-task-not-found');
    const workDir = path.join(SNS_MEDIA_WORK_DIR, `premium-thumbnail-${task.id}-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(workDir, { recursive: true });
    const cleanup = () => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {} };
    try {
        await spawnYtDlpCapture([
            '--no-playlist', '--skip-download', '--write-thumbnail', '--cache-dir', YT_DLP_CACHE_DIR,
            ...getYtDlpRemoteComponentArgs(task.url),
            '-o', path.join(workDir, 'thumbnail.%(ext)s'),
            ...getYtDlpCookieArgs(task.url, requireYoutubePremiumCookies()),
            task.url
        ], {
            sourceUrl: task.url,
            operation: 'youtube-premium-original-cover',
            timeoutMs: Number(process.env.YOUTUBE_PREMIUM_THUMBNAIL_TIMEOUT_MS || 5 * 60 * 1000),
            timeoutError: 'youtube-premium-thumbnail-timeout'
        });
        const fileName = fs.readdirSync(workDir).find(name => !name.endsWith('.part') && !name.endsWith('.ytdl'));
        if (!fileName) throw new Error('youtube-premium-thumbnail-missing');
        const extension = path.extname(fileName);
        return {
            path: path.join(workDir, fileName),
            name: `${sanitizeMediaFilePart(task.title, 'youtube')} - 原尺寸封面${extension}`,
            cleanup
        };
    } catch (error) {
        cleanup();
        throw error;
    }
}

async function enrichYoutubePremiumAnalysisOrdinals(analysis, options = {}) {
    if (!analysis || analysis.mediaType !== 'song' || !analysis.songMetadata) return analysis;
    const currentTrack = String(analysis.songMetadata.track || '').trim();
    const currentDisc = String(analysis.songMetadata.disc || '').trim();
    if (currentTrack && currentDisc) return analysis;
    const enriched = await enrichYoutubeMusicOrdinalMetadata({
        id: analysis.youtubeVideoId || '',
        track_number: currentTrack,
        disc_number: currentDisc,
        playlist_id: analysis.referenceInfo?.playlistId || ''
    }, analysis.url, options);
    const nextTrack = currentTrack || String(enriched.track_number || '');
    const nextDisc = currentDisc || String(enriched.disc_number || '1');
    return {
        ...analysis,
        songMetadata: { ...analysis.songMetadata, track: nextTrack, disc: nextDisc },
        referenceInfo: analysis.referenceInfo ? {
            ...analysis.referenceInfo,
            trackNumber: analysis.referenceInfo.trackNumber || nextTrack,
            discNumber: analysis.referenceInfo.discNumber || nextDisc
        } : analysis.referenceInfo
    };
}

async function analyzeYoutubePremiumUrl(rawUrl, options = {}) {
    const parsed = parseSupportedSocialUrl(String(rawUrl || '').trim());
    if (!parsed || !['youtube', 'ytmusic'].includes(parsed.platform) || isYouTubePlaylistOnly(parsed.parsed.href)) {
        throw new Error('youtube-url-required');
    }
    const url = parsed.parsed.href;
    const report = (message, details = {}, level = 'info') => options.onDetail?.({ message, details, level });
    report('已规范化 YouTube 地址', { sourceUrl: url, platform: parsed.platform });
    const cookiePath = requireYoutubePremiumCookies();
    report('已确认私人 YouTube Premium cookies 可用，准备获取基础元信息', {
        cookieConfigured: true,
        includeFormats: options.includeFormats === true,
        forceMusic: options.forceMusic === true
    });
    // Metadata parsing must not fail merely because yt-dlp's default/current format
    // selector cannot be satisfied. Logged-in YouTube cookies can expose a different or
    // temporarily reduced format set depending on the player client, so first collect the
    // raw metadata/format inventory with --ignore-no-formats-error.
    let baseMeta = await runYtDlpJson(url, {
        noPlaylist: true,
        cookiePath,
        ignoreNoFormats: true,
        allowIgnoreNoFormatsFallback: false,
        signal: options.signal
    });
    report('基础元信息与格式库存获取完成', {
        youtubeVideoId: sanitizeString(baseMeta.id || '', 80),
        title: sanitizeString(baseMeta.title || baseMeta.fulltitle || '', 240),
        extractor: sanitizeString(baseMeta.extractor_key || baseMeta.extractor || '', 80),
        durationSeconds: Number(baseMeta.duration) || 0,
        rawFormatCount: Array.isArray(baseMeta.formats) ? baseMeta.formats.length : 0,
        hasThumbnail: Boolean(baseMeta.thumbnail || baseMeta.thumbnails?.length)
    });
    const detectedMediaType = options.forceMusic === true ? 'song' : classifySnsMedia(url, baseMeta);
    if (detectedMediaType === 'unsupported') throw new Error('youtube-playlist-not-supported');
    const defaultSelector = detectedMediaType === 'song' ? getYtDlpAudioFormatSelector() : getYtDlpFormatSelector(url);
    report('媒体类型识别与默认格式策略已确定', { detectedMediaType, defaultSelector });
    // For songs, do not run a second metadata command with -f. It is unnecessary and was
    // the direct source of "Requested format is not available" during parsing when an
    // authenticated browser cookie caused YouTube to return a limited client format set.
    let selectedMeta = baseMeta;
    if (detectedMediaType !== 'song') {
        report('正在按默认视频格式策略确认可下载轨道', { formatSelector: defaultSelector });
        selectedMeta = await runYtDlpJson(url, {
            noPlaylist: true,
            cookiePath,
            formatSelector: defaultSelector,
            allowIgnoreNoFormatsFallback: true,
            signal: options.signal
        });
        report('默认视频轨道确认完成', {
            requestedFormats: Array.isArray(selectedMeta.requested_formats)
                ? selectedMeta.requested_formats.map(format => String(format?.format_id || '')).filter(Boolean)
                : [String(selectedMeta.format_id || '')].filter(Boolean),
            rawFormatCount: Array.isArray(selectedMeta.formats) ? selectedMeta.formats.length : 0
        });
    }
    let formats = normalizeYtDlpFormats(selectedMeta.formats?.length ? selectedMeta.formats : baseMeta.formats);
    let preferredMusicFormat = getPreferredMusicAudioFormat(formats);
    report('格式库存已标准化', {
        normalizedFormatCount: formats.length,
        audioFormats: formats.filter(format => format.kind === 'audio').length,
        videoFormats: formats.filter(format => format.kind === 'video').length,
        combinedFormats: formats.filter(format => format.kind === 'video_audio').length,
        preferredMusicFormatId: preferredMusicFormat?.id || ''
    });
    // Some logged-in YouTube sessions currently expose only a narrow client set. If the
    // initial authenticated metadata has no audio at all, make one cache-bypassed probe with
    // alternate clients. This is best-effort and never replaces the original metadata fields.
    if (detectedMediaType === 'song' && !preferredMusicFormat) {
        try {
            report('主播放器客户端没有可用纯音频，开始备用客户端探测', {
                playerClients: 'web_safari,web,android_vr,tv_embedded'
            }, 'warn');
            const alternateMeta = await runYtDlpJson(url, {
                noPlaylist: true,
                cookiePath,
                ignoreNoFormats: true,
                playerClient: 'web_safari,web,android_vr,tv_embedded',
                playerClientFallback: false,
                bypassCache: true,
                allowIgnoreNoFormatsFallback: false,
                operation: 'youtube-premium-audio-format-probe',
                signal: options.signal
            });
            const alternateFormats = normalizeYtDlpFormats(alternateMeta.formats);
            const alternatePreferred = getPreferredMusicAudioFormat(alternateFormats);
            if (alternatePreferred) {
                formats = alternateFormats;
                preferredMusicFormat = alternatePreferred;
                selectedMeta = alternateMeta;
                report('备用播放器客户端已恢复音频格式', {
                    recoveredFormatId: alternatePreferred.id,
                    recoveredFormatCount: alternateFormats.length
                }, 'warn');
                recordExternalDependencyEvent('youtube-yt-dlp', 'youtube-premium-audio-format-probe-recovered', {
                    level: 'warn', endpoint: url,
                    message: 'Primary authenticated player-client format inventory had no usable audio; alternate client probe recovered audio formats.',
                    details: { recoveredFormatId: alternatePreferred.id },
                    hint: 'Browser-exported YouTube cookies can alter/limit the available logged-in player clients. Consider refreshing cookies if this recurs frequently.'
                });
            }
        } catch (probeError) {
            report('备用播放器客户端探测失败，将继续使用现有格式库存', {
                error: sanitizeYoutubePremiumError(probeError)
            }, 'warn');
            recordExternalDependencyEvent('youtube-yt-dlp', 'youtube-premium-audio-format-probe-failed', {
                level: 'warn', endpoint: url, error: probeError,
                hint: 'Alternate player-client probing is best-effort; the normal missing-audio fallback will handle the result.'
            });
        }
    }
    const automaticIds = detectedMediaType === 'song'
        ? [preferredMusicFormat?.id].filter(Boolean)
        : getSelectedFormatIds(selectedMeta);
    const formatById = new Map(formats.map(format => [format.id, format]));
    const preferredVideoFormat = getPreferredPremiumVideoFormat(formats);
    const preferredVideoAudio = automaticIds.map(id => formatById.get(id)).find(format => format?.kind === 'audio') ||
        formats.filter(format => format.kind === 'audio' && (format.ext === 'm4a' || /^(?:mp4a|aac)/i.test(format.audioCodec)))
            .sort((a, b) => (b.audioBitrate || b.totalBitrate) - (a.audioBitrate || a.totalBitrate))[0];
    const requestedIds = Array.isArray(options.selectedFormatIds) && options.selectedFormatIds.length
        ? options.selectedFormatIds
        : (options.forceMusic === true
            ? [preferredMusicFormat?.id].filter(Boolean)
            : (detectedMediaType === 'video' && preferredVideoFormat && preferredVideoAudio
                ? [preferredVideoFormat.id, preferredVideoAudio.id]
                : automaticIds));
    if (options.forceMusic === true && !requestedIds.length) throw new Error('youtube-premium-audio-format-missing');
    const selection = validateFormatSelection(formats, requestedIds, detectedMediaType, options.forceMusic === true);
    const mediaType = resolveYoutubePremiumMediaType(detectedMediaType, selection, options.forceMusic === true);
    report('最终格式选择已通过校验', {
        requestedIds,
        selectedIds: selection.ids,
        mediaType,
        formatSelector: selection.formatSelector,
        outputContainer: selection.outputContainer,
        summary: selection.summary
    });
    if (mediaType === 'song') {
        report('正在补充 YouTube Music 专辑曲序与唱片编号', {});
        baseMeta = await enrichYoutubeMusicOrdinalMetadata(baseMeta, url, { cookiePath, signal: options.signal });
        report('歌曲专辑序号补充完成', {
            track: String(baseMeta.track_number || baseMeta.track || ''),
            disc: String(baseMeta.disc_number || baseMeta.disc || '')
        });
    }
    const artist = normalizeArtistValue(baseMeta);
    const track = String(baseMeta.track || baseMeta.title || baseMeta.fulltitle || '').trim();
    const fallbackArtist = artist || String(baseMeta.creator || baseMeta.channel || baseMeta.uploader || baseMeta.uploader_id || 'YouTube').trim();
    const analysis = {
        url,
        title: sanitizeString(baseMeta.title || baseMeta.fulltitle || track || 'YouTube 媒体', 240),
        cover: sanitizeString(baseMeta.thumbnail || baseMeta.thumbnails?.slice(-1)?.[0]?.url || '', 1000),
        duration: Number(baseMeta.duration) || 0,
        mediaType,
        youtubeVideoId: sanitizeString(baseMeta.id || '', 80),
        songMetadata: mediaType === 'song' ? buildYoutubeSongMetadata({
            ...baseMeta,
            track: track || baseMeta.id || '未知曲名',
            artist: fallbackArtist || 'YouTube'
        }, url) : null,
        referenceInfo: buildYoutubeReferenceInfo(baseMeta, url),
        musicFormatId: preferredMusicFormat?.id || '',
        selection,
        formats: options.includeFormats ? formats : []
    };
    const enrichedAnalysis = await enrichYoutubePremiumAnalysisOrdinals(analysis, { cookiePath, signal: options.signal });
    report('YouTube Premium 解析结果已组装', {
        title: enrichedAnalysis.title,
        youtubeVideoId: enrichedAnalysis.youtubeVideoId,
        mediaType: enrichedAnalysis.mediaType,
        selectedFormatIds: enrichedAnalysis.selection?.ids || [],
        artist: enrichedAnalysis.songMetadata?.artist || '',
        album: enrichedAnalysis.songMetadata?.album || '',
        date: enrichedAnalysis.songMetadata?.date || '',
        track: enrichedAnalysis.songMetadata?.track || '',
        disc: enrichedAnalysis.songMetadata?.disc || ''
    });
    return enrichedAnalysis;
}

function moveYoutubePremiumOutput(sourcePath, targetPath) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    try {
        fs.renameSync(sourcePath, targetPath);
    } catch (_) {
        fs.copyFileSync(sourcePath, targetPath);
        try { fs.unlinkSync(sourcePath); } catch (_) {}
    }
    return targetPath;
}

async function downloadYoutubePremiumTask({ task, analysis, taskDir, signal, onProgress, onStage, onDetail }) {
    const workId = `premium-${task.id}`;
    const customSelector = task.mode === 'custom' ? analysis.selection.formatSelector : '';
    const singleTrack = task.mode === 'custom' && analysis.selection.formats.length === 1
        ? analysis.selection.formats[0].kind
        : '';
    try {
        onDetail?.({
            message: '已进入 Premium 成品处理器',
            details: {
                mediaType: analysis.mediaType,
                mode: task.mode,
                asMusic: task.asMusic === true,
                singleTrack: singleTrack || '否',
                customSelector: customSelector || '',
                taskDir
            }
        });
        if (analysis.mediaType === 'song' && (task.mode !== 'custom' || ['audio', 'video_audio'].includes(singleTrack))) {
            onDetail?.({
                message: '采用歌曲工作流：下载音频与封面、裁切封面、写入元信息',
                details: { formatSelector: customSelector || (task.asMusic ? analysis.selection.formatSelector : getYtDlpAudioFormatSelector()) }
            });
            const song = await downloadAndProcessYoutubeSong({
                sourceUrl: analysis.url,
                mediaUrl: analysis.url,
                title: analysis.title,
                youtubeVideoId: analysis.youtubeVideoId,
                songMetadata: analysis.songMetadata
            }, { id: workId }, onProgress, stage => {
                onStage(stage === 'writing_metadata' || stage === 'processing_cover' ? 'metadata' : 'downloading');
            }, {
                cookiePath: YOUTUBE_PREMIUM_COOKIE_PATH,
                formatSelector: customSelector || (task.asMusic ? analysis.selection.formatSelector : getYtDlpAudioFormatSelector()),
                strictFormatSelection: Boolean(customSelector),
                downloadSections: task.downloadSections || '',
                maxFileSize: null,
                signal,
                onDetail
            });
            const outputFileName = song.fileName;
            const outputPath = moveYoutubePremiumOutput(song.finalAudio, path.join(taskDir, outputFileName));
            const coverPath = moveYoutubePremiumOutput(song.squareCover, path.join(taskDir, 'cover.jpg'));
            onDetail?.({
                message: '歌曲与封面已移入任务成品目录',
                details: { outputPath, coverPath, outputFileName, outputFileSize: fs.statSync(outputPath).size }
            });
            return {
                outputPath,
                coverPath,
                outputFileName,
                outputFileSize: fs.statSync(outputPath).size,
                title: song.metadata.title || analysis.title,
                songMetadata: song.metadata
            };
        }

        onStage('downloading');
        onDetail?.({
            message: '采用视频/单轨工作流',
            details: {
                formatSelector: customSelector || analysis.selection.formatSelector || getYtDlpFormatSelector(analysis.url),
                outputContainer: analysis.selection.outputContainer || 'mp4',
                singleTrack: singleTrack || '自动音视频组合'
            }
        });
        const downloadedPath = await runYtDlpDownload(analysis.url, workId, onProgress, 0, {
            cookiePath: YOUTUBE_PREMIUM_COOKIE_PATH,
            formatSelector: customSelector || analysis.selection.formatSelector || getYtDlpFormatSelector(analysis.url),
            allowFormatFallback: !customSelector,
            mergeOutputFormat: analysis.selection.outputContainer || 'mp4',
            downloadSections: task.downloadSections || '',
            maxFileSize: null,
            signal,
            onStage,
            onDetail
        });
        onDetail?.({ message: '开始使用 ffprobe 校验下载成品轨道', details: { downloadedPath } });
        const probe = await probeMediaFile(downloadedPath, { signal });
        if (!probe.streams?.some(stream => stream.codec_type === (singleTrack === 'audio' ? 'audio' : 'video'))) {
            throw new Error(singleTrack === 'audio' ? 'youtube-premium-audio-stream-missing' : 'youtube-premium-video-stream-missing');
        }
        const extension = path.extname(downloadedPath) || `.${analysis.selection.outputContainer || 'mp4'}`;
        const outputFileName = `${sanitizeMediaFilePart(analysis.title, 'youtube-video')}${extension}`;
        const outputPath = moveYoutubePremiumOutput(downloadedPath, path.join(taskDir, outputFileName));
        onDetail?.({
            message: '视频/单轨成品校验并移动完成',
            details: {
                outputPath,
                outputFileName,
                outputFileSize: fs.statSync(outputPath).size,
                streams: (probe.streams || []).map(stream => ({
                    type: stream.codec_type || '',
                    codec: stream.codec_name || '',
                    width: Number(stream.width) || 0,
                    height: Number(stream.height) || 0
                }))
            }
        });
        return {
            outputPath,
            outputFileName,
            outputFileSize: fs.statSync(outputPath).size,
            title: analysis.title
        };
    } finally {
        cleanupSnsWorkFiles(`${workId}.`);
    }
}

function normalizeEditableSongMetadata(input = {}, fallback = {}) {
    const value = (key, max = 4000) => sanitizeString(input[key] ?? fallback[key] ?? '', max);
    return {
        title: value('title', 240) || '未知曲名',
        album: value('album', 240),
        artist: value('artist', 240) || '未知艺术家',
        album_artist: value('album_artist', 240) || value('artist', 240) || '未知艺术家',
        composer: value('composer', 240),
        genre: value('genre', 240),
        track: value('track', 40),
        disc: value('disc', 40) || '1',
        date: value('date', 40),
        comment: value('comment', 4000),
        lyrics: value('lyrics', 12000)
    };
}

async function rewriteYoutubePremiumSongMetadata(taskId, input) {
    const task = youtubePremiumService.get(taskId);
    const file = youtubePremiumService.getFile(taskId);
    if (!task || !file) throw new Error('youtube-premium-task-not-found');
    if (task.mediaType !== 'song') throw new Error('youtube-premium-task-not-song');
    const metadata = normalizeEditableSongMetadata(input, task.songMetadata || {});
    const temporaryPath = path.join(path.dirname(file.path), `.metadata-${crypto.randomBytes(6).toString('hex')}.m4a`);
    try {
        await spawnCapture(FFMPEG_COMMAND, [
            '-y', '-hide_banner', '-loglevel', 'error', '-i', file.path,
            '-map', '0', '-map_metadata', '0', '-c', 'copy',
            ...Object.entries(metadata).flatMap(([key, value]) => ['-metadata', `${key}=${value}`]),
            '-movflags', '+faststart', temporaryPath
        ], { timeoutMs: 10 * 60 * 1000, timeoutError: 'song-metadata-write-timeout' });
        const outputFileName = `${sanitizeMediaFilePart(metadata.artist, '未知艺术家')} - ${sanitizeMediaFilePart(metadata.title, '未知曲名')}.m4a`;
        const outputPath = path.join(path.dirname(file.path), outputFileName);
        fs.copyFileSync(temporaryPath, outputPath);
        if (path.resolve(outputPath) !== path.resolve(file.path)) fs.rmSync(file.path, { force: true });
        const probe = await probeMediaFile(outputPath);
        if (!probe.streams?.some(stream => stream.codec_type === 'audio')) throw new Error('song-final-m4a-invalid');
        return youtubePremiumService.setSongMetadata(taskId, metadata, {
            outputPath,
            outputFileName,
            outputFileSize: fs.statSync(outputPath).size
        });
    } finally {
        fs.rmSync(temporaryPath, { force: true });
    }
}

function ensureYoutubePremiumTaskCover(taskId) {
    if (youtubePremiumService.getFile(taskId, 'cover')) return Promise.resolve(youtubePremiumService.getFile(taskId, 'cover'));
    if (youtubePremiumCoverJobs.has(taskId)) return youtubePremiumCoverJobs.get(taskId);
    const job = (async () => {
        const thumbnail = await downloadYoutubePremiumOriginalThumbnail(taskId);
        try {
            const taskDir = youtubePremiumService.getTaskDirectory(taskId);
            if (!taskDir) throw new Error('youtube-premium-task-not-found');
            fs.mkdirSync(taskDir, { recursive: true });
            const extension = path.extname(thumbnail.path) || '.jpg';
            const coverPath = path.join(taskDir, `cover${extension}`);
            fs.copyFileSync(thumbnail.path, coverPath);
            youtubePremiumService.setCoverPath(taskId, coverPath);
            return youtubePremiumService.getFile(taskId, 'cover');
        } finally {
            thumbnail.cleanup();
        }
    })().finally(() => youtubePremiumCoverJobs.delete(taskId));
    youtubePremiumCoverJobs.set(taskId, job);
    return job;
}

function sanitizeYoutubePremiumError(error) {
    const message = String(error?.message || 'youtube-premium-download-failed')
        .replaceAll(YOUTUBE_PREMIUM_COOKIE_PATH, '[private-cookie]')
        .replaceAll(SERVER_DATA_DIR, '[server-data]')
        .replace(/--cookies\s+\S+/gi, '--cookies [private-cookie]')
        .replace(/YouTube 要求登录验证[^\n]*/i, '私人 YouTube Premium Cookie 已失效或不完整，请在 /sns-cookies 重新保存')
        .trim();
    const labels = {
        'youtube-url-required': '请输入有效的单个 YouTube 或 YT Music URL',
        'youtube-playlist-not-supported': '私人下载页暂不支持整张播放列表',
        'youtube-premium-cookie-required': '请先在 /sns-cookies 配置私人 YouTube Premium Cookie',
        'youtube-premium-cookie-save-failed': '私人 YouTube Premium Cookie 保存失败',
        'youtube-premium-thumbnail-missing': 'yt-dlp 没有返回可下载的封面',
        'youtube-premium-thumbnail-timeout': '获取原尺寸封面超时，请稍后重试',
        'youtube-premium-task-not-song': '只有音乐类型任务可以编辑歌曲元数据',
        'youtube-premium-task-active': '任务仍在运行，请先取消并等待任务停止',
        'custom-format-required': '自定义模式至少选择一个媒体格式',
        'custom-format-count-invalid': '只能选择一个媒体格式，或一个视频格式加一个音频格式',
        'custom-format-not-found': '所选媒体格式已失效，请重新解析',
        'custom-single-format-invalid': '单选编号必须包含音频或视频轨',
        'custom-music-format-invalid': '以音乐形式下载时只能选择一个纯音频媒体编号',
        'youtube-premium-audio-format-missing': '没有找到可用于音乐下载的纯音频媒体编号',
        'custom-video-format-conflict': '请选择一个纯视频格式和一个纯音频格式',
        'youtube-premium-audio-stream-missing': '下载结果中没有找到音频轨',
        'yt-dlp-song-download-timeout': '歌曲下载超时，请检查服务器网络或代理后重新抓取',
        'yt-dlp-song-audio-missing': 'yt-dlp 未下载到音频文件（网络或代理波动可能导致下载中断），请检查网络/代理后重新抓取',
        'yt-dlp-song-cover-missing': 'yt-dlp 未下载到封面文件，请检查网络或代理后重新抓取',
        'youtube-premium-target-tunnel-not-found': '目标隧道不存在或已退出',
        'youtube-premium-forward-upload-required': '请先将成品缓存到浏览器，再从浏览器缓存转发',
        'youtube-premium-forward-size-mismatch': '浏览器缓存大小与任务成品不一致，请重新缓存后再转发',
        'youtube-premium-forward-cache-stale': '浏览器缓存版本已过期，请重新缓存后再转发',
        'download-cancelled': '任务已取消'
    };
    return labels[message] || message.slice(0, 500);
}

function moveSnsFileToAsset(sourcePath, assetId) {
    fs.mkdirSync(TELEGRAM_ASSET_DIR, { recursive: true });
    const targetPath = path.join(TELEGRAM_ASSET_DIR, assetId);
    try {
        fs.renameSync(sourcePath, targetPath);
    } catch (_) {
        fs.copyFileSync(sourcePath, targetPath);
        try { fs.unlinkSync(sourcePath); } catch (_) {}
    }
    return targetPath;
}

function createServerAssetFileInfo(asset, extra = {}) {
    return {
        id: asset.id, name: asset.name, size: asset.size, type: asset.type,
        timestamp: Date.now(), sender: TELEGRAM_BOT_DEVICE_ID, senderName: 'SNS 媒体文件',
        ownerDeviceId: TELEGRAM_BOT_DEVICE_ID, isAsset: false, isServerAsset: true,
        serverAssetUrl: `/api/server-assets/${asset.id}`,
        ...extra
    };
}

function buildSongRemark(fileName, metadata, probe) {
    return [
        fileName,
        `    - Track name：${metadata.title || '未知'}`,
        `    - Performer：${metadata.artist || '未知'}`,
        `    - Recorded date：${metadata.date || '未知'}`,
        `    - Bit Rate：${probe.bitRateLabel || '未知'}`,
        `    - Fomat：${probe.formatLabel || '未知'}`,
        `    - Duration：${probe.durationLabel || '未知'}`,
        `    - Comment：${metadata.comment || '未知'}`
    ].join('\n').slice(0, TELEGRAM_REMARK_MAX_LENGTH);
}

function ensureGeneratedSnsMessage(sessionId, session, taskRecord) {
    const generatedMessage = taskRecord.generatedMessage;
    if (!generatedMessage?.id) throw new Error('sns-generated-message-missing');
    const result = addToSessionHistory(sessionId, session, generatedMessage, {
        fromDeviceId: TELEGRAM_BOT_DEVICE_ID,
        source: generatedMessage.type === 'collection' ? 'sns-song-download' : 'sns-media-download'
    });
    if (result.stored) emitToReadableSessionDevices(session, 'message', { message: generatedMessage });
    session.lastActivity = Date.now();
    scheduleSessionHistoryBroadcast(sessionId, 'sns-media-file-generated', 300);
    return generatedMessage;
}

async function fetchSnsMediaIntoTunnel(sessionId, messageId, mediaItemId) {
    const session = sessions.get(sessionId);
    const entry = getHistoryMessageEntry(session, messageId);
    const message = entry?.message;
    let item = message?.snsMediaItems?.find(candidate => candidate?.id === mediaItemId);
    if (!session || !message || !item) throw new Error('sns-media-not-found');
    if (item.mediaKind === 'unsupported') throw new Error('sns-media-unsupported');
    if (item.generatedMessageId && (item.serverAssetId || item.serverAssetIds?.length) && getHistoryMessageEntry(session, item.generatedMessageId)) return item;
    const maxDuration = Math.max(60, Number(process.env.SOCIAL_MAX_DURATION_SECONDS || 6 * 60 * 60));
    if (Number(item.duration) > maxDuration) throw new Error('sns-media-duration-limit-exceeded');

    const taskId = createStableSnsId('sns-task', sessionId, messageId, mediaItemId, item.youtubeVideoId || item.mediaUrl);
    const taskKey = `${sessionId}:${messageId}:${mediaItemId}`;
    if (snsMediaTasks.has(taskKey)) return snsMediaTasks.get(taskKey);

    const task = (async () => {
        let taskRecord = readSnsTask(taskId) || {
            id: taskId,
            sessionId,
            sourceMessageId: messageId,
            sourceRecordId: messageId,
            mediaItemId,
            sourceUrl: item.sourceUrl || item.mediaUrl,
            youtubeVideoId: item.youtubeVideoId || '',
            mediaKind: item.mediaKind || 'video',
            status: 'pending',
            createdAt: Date.now(),
            generatedMessageId: crypto.randomUUID(),
            audioAssetId: item.mediaKind === 'song' ? createServerAssetId() : '',
            coverAssetId: item.mediaKind === 'song' ? createServerAssetId() : '',
            videoAssetId: item.mediaKind === 'song' ? '' : createServerAssetId()
        };
        taskRecord = persistSnsTask({
            ...taskRecord,
            playlistItem: item.sourceType === 'collection'
                ? Math.max(1, Math.trunc(Number(item.playlistItem) || Number(item.mediaIndex) + 1 || 1))
                : 0
        });
        let lastStateEmit = 0;
        const updateItem = (patch, reason = 'sns-media-status') => {
            const now = Date.now();
            if (reason === 'sns-media-progress' && now - lastStateEmit < 1200) return item;
            lastStateEmit = now;
            item = updateSnsMediaItem(sessionId, messageId, mediaItemId, {
                acquisitionTaskId: taskId,
                ...patch
            }, reason) || item;
            return item;
        };
        const updateTask = patch => {
            taskRecord = persistSnsTask({ ...taskRecord, ...patch });
            return taskRecord;
        };
        const updateStage = stage => {
            updateTask({ status: stage });
            updateItem({ serverState: 'fetching', serverStage: stage }, 'sns-media-stage');
        };

        updateItem({ serverState: 'fetching', serverStage: 'queued', serverProgress: 0 }, 'sns-media-queued');
        const releaseTaskSlot = await acquireSnsMediaTaskSlot();
        try {
            if (taskRecord.status === 'ready' && taskRecord.generatedMessage) {
                const generated = ensureGeneratedSnsMessage(sessionId, session, taskRecord);
                const resultFileName = generated.type === 'collection'
                    ? generated.collection?.files?.find(file => String(file.type || '').startsWith('audio/'))?.name
                    : generated.fileInfo?.name;
                return updateItem({
                    serverState: 'ready', serverStage: 'completed', serverProgress: 100,
                    serverProgressText: '', serverAssetId: taskRecord.audioAssetId || taskRecord.videoAssetId,
                    serverAssetIds: [taskRecord.coverAssetId, taskRecord.audioAssetId || taskRecord.videoAssetId].filter(Boolean),
                    generatedMessageId: generated.id, generatedMessageType: generated.type,
                    resultFileName: resultFileName || '', serverError: ''
                }, 'sns-media-ready-restored');
            }

            updateItem({
                serverState: 'fetching', serverStage: 'parsing', serverProgress: 0,
                serverError: '', generatedMessageId: ''
            }, 'sns-media-fetch-started');

            if (!taskRecord.generatedMessage) {
                if (item.mediaKind === 'song') {
                    const song = await downloadAndProcessYoutubeSong(item, taskRecord, progress => {
                        updateTask({ status: 'fetching_song', progress: progress.percent, progressText: [progress.speedText, progress.etaText ? `ETA ${progress.etaText}` : ''].filter(Boolean).join(' · ') });
                        updateItem({
                            serverState: 'fetching', serverStage: 'fetching_song', serverProgress: progress.percent,
                            serverProgressText: [progress.speedText, progress.etaText ? `ETA ${progress.etaText}` : ''].filter(Boolean).join(' · ')
                        }, 'sns-media-progress');
                    }, updateStage);
                    updateStage('creating_collection');
                    const coverPath = moveSnsFileToAsset(song.squareCover, taskRecord.coverAssetId);
                    const audioPath = moveSnsFileToAsset(song.finalAudio, taskRecord.audioAssetId);
                    cleanupSnsWorkFiles(`${taskRecord.id}.source.`);
                    const coverAsset = {
                        id: taskRecord.coverAssetId, path: coverPath, name: song.coverName, type: 'image/jpeg',
                        size: fs.statSync(coverPath).size, sessionId, createdAt: Date.now(), source: 'sns-youtube-song-cover',
                        sourceUrl: item.sourceUrl, sourceMessageId: messageId, snsMediaItemId: mediaItemId,
                        snsTaskId: taskId, youtubeVideoId: item.youtubeVideoId, mediaKind: 'song-cover'
                    };
                    const audioAsset = {
                        id: taskRecord.audioAssetId, path: audioPath, name: song.fileName, type: 'audio/mp4',
                        size: fs.statSync(audioPath).size, sessionId, createdAt: Date.now(), source: 'sns-youtube-song',
                        sourceUrl: item.sourceUrl, sourceMessageId: messageId, snsMediaItemId: mediaItemId,
                        snsTaskId: taskId, youtubeVideoId: item.youtubeVideoId, mediaKind: 'song'
                    };
                    persistTelegramServerAsset(coverAsset);
                    persistTelegramServerAsset(audioAsset);
                    const remark = buildSongRemark(song.fileName, song.metadata, song.probe);
                    const timestamp = Date.now();
                    taskRecord.generatedMessage = {
                        id: taskRecord.generatedMessageId, type: 'collection',
                        collection: {
                            id: crypto.randomUUID(),
                            files: [
                                createServerAssetFileInfo(coverAsset, { sourceMessageId: messageId, snsMediaItemId: mediaItemId, snsSourceUrl: item.sourceUrl, snsTaskId: taskId }),
                                createServerAssetFileInfo(audioAsset, { sourceMessageId: messageId, snsMediaItemId: mediaItemId, snsSourceUrl: item.sourceUrl, snsTaskId: taskId, audioTitle: song.metadata.title, audioArtist: song.metadata.artist, audioAlbum: song.metadata.album, audioYear: song.metadata.date })
                            ],
                            count: 2, totalSize: coverAsset.size + audioAsset.size, remark
                        },
                        timestamp, sender: TELEGRAM_BOT_DEVICE_ID, senderName: 'SNS 媒体文件', sessionId, remark,
                        snsAcquisition: { source: item.platform || 'youtube', mediaKind: 'song', taskId, sourceMessageId: messageId, sourceRecordId: messageId, mediaItemId, sourceUrl: item.sourceUrl, youtubeVideoId: item.youtubeVideoId, coverAssetId: coverAsset.id, audioAssetId: audioAsset.id }
                    };
                } else {
                    updateStage('fetching_video');
                    const downloadedPath = await runYtDlpDownload(
                        taskRecord.playlistItem ? item.sourceUrl : (item.mediaUrl || item.sourceUrl),
                        taskRecord.videoAssetId,
                        progress => {
                            updateTask({ status: 'fetching_video', progress: progress.percent, progressText: [progress.speedText, progress.etaText ? `ETA ${progress.etaText}` : ''].filter(Boolean).join(' · ') });
                            updateItem({
                                serverState: 'fetching', serverStage: 'fetching_video', serverProgress: progress.percent,
                                serverProgressText: [progress.speedText, progress.etaText ? `ETA ${progress.etaText}` : ''].filter(Boolean).join(' · ')
                            }, 'sns-media-progress');
                        },
                        taskRecord.playlistItem
                    );
                    if (fs.statSync(downloadedPath).size > getTelegramMaxFileSize()) {
                        cleanupSnsWorkFiles(`${taskRecord.videoAssetId}.`);
                        throw new Error('sns-media-file-too-large');
                    }
                    const downloadedProbe = await probeMediaFile(downloadedPath);
                    if (!downloadedProbe.streams?.some(stream => stream.codec_type === 'video')) {
                        cleanupSnsWorkFiles(`${taskRecord.videoAssetId}.`);
                        throw new Error('未获取到有效视频流，请检查 cookies、代理或 yt-dlp 格式可用性');
                    }
                    const ext = path.extname(downloadedPath) || '.mp4';
                    const fileName = `${sanitizeMediaFilePart(item.title, 'sns-media')}${ext}`;
                    const assetPath = moveSnsFileToAsset(downloadedPath, taskRecord.videoAssetId);
                    const asset = {
                        id: taskRecord.videoAssetId, path: assetPath, name: fileName, type: getMimeTypeFromFileName(fileName),
                        size: fs.statSync(assetPath).size, sessionId, createdAt: Date.now(), source: 'sns',
                        sourceUrl: item.mediaUrl || item.sourceUrl, sourceMessageId: messageId, snsMediaItemId: mediaItemId,
                        snsTaskId: taskId, youtubeVideoId: item.youtubeVideoId, mediaKind: 'video'
                    };
                    persistTelegramServerAsset(asset);
                    const remark = String(item.sourceUrl || item.mediaUrl || '').slice(0, TELEGRAM_REMARK_MAX_LENGTH);
                    taskRecord.generatedMessage = {
                        id: taskRecord.generatedMessageId, type: 'file',
                        fileInfo: createServerAssetFileInfo(asset, { remark, sourceMessageId: messageId, snsMediaItemId: mediaItemId, snsSourceUrl: item.sourceUrl, snsTaskId: taskId }),
                        timestamp: Date.now(), sender: TELEGRAM_BOT_DEVICE_ID, senderName: 'SNS 媒体文件', sessionId, remark,
                        snsAcquisition: { source: item.platform || 'sns', mediaKind: 'video', taskId, sourceMessageId: messageId, sourceRecordId: messageId, mediaItemId, sourceUrl: item.sourceUrl, youtubeVideoId: item.youtubeVideoId, videoAssetId: asset.id }
                    };
                }
                updateTask({ status: 'processed', generatedMessage: taskRecord.generatedMessage });
            }

            const generatedMessage = ensureGeneratedSnsMessage(sessionId, session, taskRecord);
            updateTask({ status: 'ready', generatedMessage, error: '' });
            const resultFileName = generatedMessage.type === 'collection'
                ? generatedMessage.collection?.files?.find(file => String(file.type || '').startsWith('audio/'))?.name
                : generatedMessage.fileInfo?.name;
            return updateItem({
                serverState: 'ready', serverStage: 'completed', serverProgress: 100, serverProgressText: '',
                serverAssetId: taskRecord.audioAssetId || taskRecord.videoAssetId,
                serverAssetIds: [taskRecord.coverAssetId, taskRecord.audioAssetId || taskRecord.videoAssetId].filter(Boolean),
                generatedMessageId: generatedMessage.id, generatedMessageType: generatedMessage.type,
                resultFileName: resultFileName || '', serverError: ''
            }, 'sns-media-ready');
        } catch (err) {
            cleanupSnsWorkFiles(`${taskRecord.id}.`);
            updateTask({ status: 'failed', error: sanitizeString(err.message || 'sns-media-download-failed', 500) });
            const failedItem = updateItem({
                serverState: 'failed', serverStage: 'failed',
                serverError: sanitizeString(err.message || 'sns-media-download-failed', 240)
            }, 'sns-media-failed');
            throw Object.assign(err, { snsMediaItem: failedItem });
        } finally {
            releaseTaskSlot();
        }
    })().finally(() => snsMediaTasks.delete(taskKey));
    snsMediaTasks.set(taskKey, task);
    return task;
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

function emitToReadableSessionDevices(session, event, payload, excludeDeviceId = '') {
    if (!session?.devices) return;
    session.devices.forEach((device, deviceId) => {
        if (deviceId === excludeDeviceId || !canUseTunnelCapability(session, deviceId, 'read')) return;
        const target = deviceSockets.get(deviceId);
        if (target) target.emit(event, payload);
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
        emitToReadableSessionDevices(session, 'session-history', {
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
    let socketLanguage = normalizeLanguageCode(
        socket.handshake.auth?.language || socket.handshake.headers['accept-language'] || 'zh-Hans'
    );
    const socketText = text => translateTelegramText(text, socketLanguage);
    const emitSocketError = (event, message, details = {}) => socket.emit(event, {
        ...details,
        message: socketText(message)
    });
    socket.on('set-language', data => {
        socketLanguage = normalizeLanguageCode(data?.language || socketLanguage);
    });
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
        emitSocketError('error', '连接数超限');
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

    socket.on('device-camera-request', data => {
        const from = data?.from;
        const to = data?.to;
        const requestId = sanitizeString(data?.requestId || '', 100);
        const mode = data?.mode === 'share-mine' ? 'share-mine' : 'open-remote';
        if (!isValidDeviceId(from) || !isValidDeviceId(to) || !requestId || socket.data?.deviceId !== from) return;
        emitToDevice(to, 'device-camera-request', {
            requestId,
            from,
            to,
            mode,
            senderName: sanitizeString(data?.senderName || '', 80),
            createdAt: Number(data?.createdAt) || Date.now()
        });
        historyLog('device-camera-request', { deviceId: from, targetDeviceId: to, requestId, mode, socketId: socket.id, clientIp });
    });

    socket.on('device-camera-response', data => {
        const from = data?.from;
        const to = data?.to;
        const requestId = sanitizeString(data?.requestId || '', 100);
        if (!isValidDeviceId(from) || !isValidDeviceId(to) || !requestId || socket.data?.deviceId !== from) return;
        emitToDevice(to, 'device-camera-response', {
            requestId,
            from,
            to,
            mode: data?.mode === 'share-mine' ? 'share-mine' : 'open-remote',
            accepted: data?.accepted !== false
        });
    });

    socket.on('device-camera-signal', data => {
        const from = data?.from;
        const to = data?.to;
        const requestId = sanitizeString(data?.requestId || '', 100);
        const kind = ['offer', 'answer', 'ice'].includes(data?.kind) ? data.kind : '';
        if (!isValidDeviceId(from) || !isValidDeviceId(to) || !requestId || !kind || socket.data?.deviceId !== from) return;
        const payload = { requestId, from, to, kind };
        if (kind === 'ice') payload.candidate = data?.candidate || null;
        else payload.description = data?.description || null;
        emitToDevice(to, 'device-camera-signal', payload);
    });

    socket.on('device-camera-stop', data => {
        const from = data?.from;
        const to = data?.to;
        const requestId = sanitizeString(data?.requestId || '', 100);
        if (!isValidDeviceId(from) || !isValidDeviceId(to) || !requestId || socket.data?.deviceId !== from) return;
        emitToDevice(to, 'device-camera-stop', { requestId, from, to });
    });


    socket.on('light-network-chunks-response', data => {
        const requestId = sanitizeString(data?.requestId || '', 100);
        const pending = lightNetworkPendingRequests.get(requestId);
        if (!pending || socket.data?.deviceId !== pending.providerDeviceId) return;
        const chunks = (Array.isArray(data?.chunks) ? data.chunks : []).slice(0, 32).map(chunk => ({
            s: Number(chunk?.s),
            c: Number(chunk?.c) || 1,
            x: sanitizeString(chunk?.x || '', 16),
            p: typeof chunk?.p === 'string' && chunk.p.length <= 65536 ? chunk.p : ''
        })).filter(chunk => Number.isInteger(chunk.s) && chunk.s >= 0 && chunk.p);
        pending.finish(200, { taskId: pending.taskId, chunks, unavailable: Boolean(data?.unavailable) });
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
                return emitSocketError('error', '无效的数据格式');
            }
            
            const { sessionId, deviceId, deviceName } = data;
            const requestedShortCode = normalizeShortCode(data.shortCode);
            
            // 验证 sessionId
            if (!isValidSessionId(sessionId)) {
                return emitSocketError('error', '无效的会话ID');
            }
            
            // 验证 deviceId
            if (!isValidDeviceId(deviceId)) {
                return emitSocketError('error', '无效的设备ID');
            }
            
            // 验证 deviceName
            if (!isValidDeviceName(deviceName)) {
                return emitSocketError('error', '无效的设备名称');
            }
            
            // 清理过期会话
            cleanupExpiredSessions();
            
            // 会话数量限制
            if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS) {
                return emitSocketError('error', '服务器会话已满');
            }
            
            currentSession = sessionId;
            currentDevice = deviceId;
            const storedTunnel = infraStore?.getTunnel(sessionId);
            const storedRemark = sanitizeString(storedTunnel?.remark || '', 60);
            const storedOwnerDeviceId = sanitizeString(storedTunnel?.owner_device_id || '', 80);
            const storedAccess = parseStoredTunnelAccess(storedTunnel?.permissions_json);
            const storedPermissions = storedAccess.permissions;
            const storedAdmins = storedAccess.admins;
            
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
                ownerDeviceId: storedOwnerDeviceId || deviceId,
                permissions: storedPermissions,
                admins: storedAdmins,
                historySize: 0,
                    createdAt: Date.now(),
                    lastActivity: Date.now()
                });
            }
            
            const session = sessions.get(sessionId);
            if (!session.remark && storedRemark) session.remark = storedRemark;
            if (!session.ownerDeviceId) session.ownerDeviceId = storedOwnerDeviceId || deviceId;
            if (!session.permissions) session.permissions = storedPermissions;
            if (!session.admins) session.admins = storedAdmins;
            if (!Array.isArray(session.deletedMessageIds)) session.deletedMessageIds = [];
            if (!session.shortCode) session.shortCode = createShortCode(sessionId, requestedShortCode);
            infraStore?.touchTunnel(sessionId, {
                shortCode: session.shortCode || '',
                createdAt: session.createdAt || Date.now(),
                lastActivity: Date.now()
            });
            infraStore?.setTunnelAccess(sessionId, session.ownerDeviceId, session.permissions, Date.now(), session.admins);
            
            // 设备数量限制
            const existingDevice = session.devices.get(deviceId);
            const reconnected = Boolean(existingDevice && existingDevice.socketId !== socket.id);

            if (session.devices.size >= MAX_DEVICES_PER_SESSION && !existingDevice) {
                return emitSocketError('error', '会话设备数已满');
            }

            if (reconnected) {
                cleanupFileAssetRelays(sessionId, deviceId);
                cleanupFileAssetAssignments(session, deviceId);
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
                    reconnected,
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
            socket.emit('session-permissions', getSessionPermissionPayload(session, deviceId));
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

            if (canUseTunnelCapability(session, deviceId, 'read')) {
                emitSessionSnapshot(socket, sessionId, session, deviceId, { clientIp, reason: 'join' });
            } else {
                socket.emit('session-history', { messages: [], deletedMessageIds: [], authoritative: true });
            }
            if (session.media?.camera) {
                socket.emit('camera-broadcast-start', {
                    broadcastId: session.media.camera.broadcastId,
                    from: session.media.camera.ownerDeviceId
                });
            }
        } catch (err) {
            console.error('join-session error:', err);
            emitSocketError('error', '服务器内部错误');
        }
    });

    socket.on('join-by-short-code', data => {
        const shortCode = normalizeShortCode(data?.shortCode);
        if (!shortCode) return emitSocketError('short-code-error', '短码应为 5 位字母或数字');
        const sessionId = infraStore?.findSessionIdByShortCode(shortCode) || shortCodes.get(shortCode);
        if (!sessionId || !isValidSessionId(sessionId)) {
            deleteShortCode(shortCode);
            return emitSocketError('short-code-error', '短码无效或会话已结束');
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

    socket.on('session-permissions-update', (data, ack) => {
        const respond = typeof ack === 'function' ? ack : () => {};
        try {
            const sessionId = data?.sessionId;
            const session = sessions.get(sessionId);
            if (sessionId !== currentSession || !session || !canManageTunnel(session, currentDevice)) {
                return respond({ ok: false, error: 'owner-required' });
            }
            session.permissions = normalizeTunnelPermissions(data?.permissions);
            session.lastActivity = Date.now();
            infraStore?.setTunnelAccess(sessionId, session.ownerDeviceId, session.permissions, session.lastActivity, session.admins);
            session.devices.forEach((_, deviceId) => {
                const target = deviceSockets.get(deviceId);
                if (target) target.emit('session-permissions', getSessionPermissionPayload(session, deviceId));
            });
            respond({ ok: true, ...getSessionPermissionPayload(session, currentDevice) });
        } catch (err) {
            console.error('session-permissions-update error:', err);
            respond({ ok: false, error: 'internal-error' });
        }
    });

    socket.on('session-admins-update', (data, ack) => {
        const respond = typeof ack === 'function' ? ack : () => {};
        try {
            const sessionId = data?.sessionId;
            const session = sessions.get(sessionId);
            if (sessionId !== currentSession || !session || !canManageTunnel(session, currentDevice)) {
                return respond({ ok: false, error: 'owner-required' });
            }
            const records = normalizeTunnelAdminRecords(data?.admins || {});
            delete records[session.ownerDeviceId];
            Object.values(records).forEach(record => {
                if (!record.deviceName && session.devices?.has(record.deviceId)) {
                    record.deviceName = session.devices.get(record.deviceId).deviceName || '';
                }
                record.grantedBy = currentDevice;
                record.updatedAt = Date.now();
                record.createdAt = Number(record.createdAt) || record.updatedAt;
            });
            session.admins = records;
            session.lastActivity = Date.now();
            infraStore?.setTunnelAccess(sessionId, session.ownerDeviceId, session.permissions, session.lastActivity, session.admins);
            session.devices.forEach((_, deviceId) => {
                const target = deviceSockets.get(deviceId);
                if (target) target.emit('session-permissions', getSessionPermissionPayload(session, deviceId));
            });
            respond({ ok: true, ...getSessionPermissionPayload(session, currentDevice) });
            historyLog('session-admins-updated', {
                sessionId,
                deviceId: currentDevice,
                adminCount: Object.keys(records).length
            });
        } catch (err) {
            console.error('session-admins-update error:', err);
            respond({ ok: false, error: 'internal-error' });
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
            const primarySocket = deviceSockets.get(currentDevice);
            if (!primarySocket?.connected || primarySocket === socket) {
                device.socketId = socket.id;
                bindSocketToDevice(socket, currentDevice);
            }
            device.deviceName = sanitizeString(data.deviceName || device.deviceName || '', 80);
            device.deviceModel = sanitizeString(data.deviceModel || device.deviceModel || '', 80);
            device.localIp = sanitizeString(data.localIp || device.localIp || '', 80);
            device.externalIp = clientIp;
            session.lastActivity = Date.now();
            touchAccessDevice(currentDevice, {
                deviceId: currentDevice,
                sessionId,
                deviceName: device.deviceName || '',
                deviceModel: device.deviceModel,
                localIp: device.localIp,
                externalIp: device.externalIp,
                ip: clientIp,
                socketId: device.socketId,
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
            return emitSocketError('error', '消息发送过于频繁');
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
                return emitSocketError('error', '设备ID不匹配');
            }
            
            const signal = { from, type, sdp, candidate };
            const targetSocket = deviceSockets.get(to);
            if (targetSocket) targetSocket.emit('signal', signal);
            else setTimeout(() => {
                if (deviceSockets.get(from) === socket) deviceSockets.get(to)?.emit('signal', signal);
            }, 500);
        } catch (err) {
            console.error('signal error:', err);
        }
    });
    
    // 消息转发
    socket.on('message', (data) => {
        if (!checkMessageRate()) {
            return emitSocketError('error', '消息发送过于频繁');
        }
        
        try {
            if (!data || typeof data !== 'object') return;
            
            const { sessionId, message } = data;
            
            if (!isValidSessionId(sessionId)) return;
            if (!message || typeof message !== 'object') return;
            if (message.sender !== currentDevice) return;
            const session = sessions.get(sessionId);
            if (!session) return;
            const requiredCapability = message.type === 'text'
                ? 'sendText'
                : message.type === 'rich'
                    ? 'sendRich'
                    : 'sendFile';
            if (!canUseTunnelCapability(session, currentDevice, requiredCapability)) {
                return socket.emit('permission-denied', { capability: requiredCapability });
            }

            const snsText = getMessageSnsText(message);
            const snsMetadata = createSnsPlaceholderMetadata(snsText, message.id);
            if (snsMetadata.sources.length) {
                message.snsSources = snsMetadata.sources;
                message.snsMediaItems = [];
                message.snsOrigin = 'client';
            } else {
                delete message.snsSources;
                delete message.snsMediaItems;
                delete message.snsOrigin;
            }
            
            session.lastActivity = Date.now();
            
            // 验证消息内容大小
            const messageStr = JSON.stringify(message);
            if (messageStr.length > MAX_MESSAGE_SIZE) {
                return emitSocketError('error', '消息过大');
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
            emitToReadableSessionDevices(session, 'message', { message }, currentDevice);
            scheduleSessionHistoryBroadcast(sessionId, 'message-broadcast');
            if (historyResult.stored && snsMetadata.sources.length) {
                queueSnsMetadataScan(sessionId, message.id, snsText);
            }
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
            const forwardCapability = message.type === 'text' ? 'sendText' : message.type === 'rich' ? 'sendRich' : 'sendFile';
            if (!canUseTunnelCapability(targetSession, currentDevice, forwardCapability)) {
                return typeof ack === 'function' && ack({ ok: false, error: 'permission-denied' });
            }
            const historyResult = addToSessionHistory(targetSessionId, targetSession, message, {
                fromDeviceId: currentDevice,
                socketId: socket.id,
                clientIp,
                source: 'cross-tunnel-forward'
            });
            emitToReadableSessionDevices(targetSession, 'message', { message });
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
            if (!canUseTunnelCapability(session, currentDevice, 'delete')) {
                return socket.emit('permission-denied', { capability: 'delete' });
            }

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
            emitToReadableSessionDevices(session, 'message-deleted', { messageId }, currentDevice);
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
            const existingMessage = session.history[historyIndex].message;
            if (existingMessage.type === 'rich' && message.content !== existingMessage.content) {
                return socket.emit('permission-denied', { capability: 'versionedRichEdit' });
            }
            if (existingMessage.type === 'collection' && message.type === 'collection' &&
                (message.collection?.files?.length || 0) < (existingMessage.collection?.files?.length || 0) &&
                !canUseTunnelCapability(session, currentDevice, 'delete')) {
                return socket.emit('permission-denied', { capability: 'delete' });
            }
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
            emitToReadableSessionDevices(session, 'message-updated', { message: historyMessage }, currentDevice);
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

    socket.on('sns-media-fetch', async (data, ack) => {
        const respond = typeof ack === 'function' ? ack : () => {};
        try {
            const { sessionId, messageId, mediaItemId } = data || {};
            const session = sessions.get(sessionId);
            if (sessionId !== currentSession || !session?.devices.has(currentDevice)) {
                return respond({ ok: false, error: 'invalid-session' });
            }
            if (!canUseTunnelCapability(session, currentDevice, 'read')) {
                return respond({ ok: false, error: 'permission-denied' });
            }
            if (!canUseTunnelCapability(session, currentDevice, 'sendFile')) {
                return respond({ ok: false, error: 'permission-denied' });
            }
            if (!isValidDeviceId(messageId) || typeof mediaItemId !== 'string' || mediaItemId.length > 80) {
                return respond({ ok: false, error: 'invalid-sns-media' });
            }
            const entry = getHistoryMessageEntry(session, messageId);
            const item = entry?.message?.snsMediaItems?.find(candidate => candidate?.id === mediaItemId);
            if (!item) return respond({ ok: false, error: 'sns-media-not-found' });
            fetchSnsMediaIntoTunnel(sessionId, messageId, mediaItemId).catch(err => {
                console.error('sns-media-fetch task error:', err);
            });
            respond({ ok: true, item, started: true });
        } catch (err) {
            console.error('sns-media-fetch error:', err);
            respond({
                ok: false,
                error: sanitizeString(err.message || 'sns-media-fetch-failed', 240),
                item: err.snsMediaItem || null
            });
        }
    });

    socket.on('rich-message-edit', (data, ack) => {
        const respond = typeof ack === 'function' ? ack : () => {};
        try {
            const { sessionId, messageId, content } = data || {};
            const baseVersion = Number(data?.baseVersion) || 1;
            const session = sessions.get(sessionId);
            if (sessionId !== currentSession || !session?.devices.has(currentDevice)) {
                return respond({ ok: false, error: 'invalid-session' });
            }
            if (!canUseTunnelCapability(session, currentDevice, 'sendRich')) {
                return respond({ ok: false, error: 'permission-denied' });
            }
            if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_EDITOR_CONTENT_SIZE) {
                return respond({ ok: false, error: 'content-too-large' });
            }
            const historyIndex = session.history.findIndex(entry => entry.message.id === messageId);
            if (historyIndex < 0 || session.history[historyIndex].message.type !== 'rich') {
                return respond({ ok: false, error: 'message-not-found' });
            }
            const previous = session.history[historyIndex];
            const currentMessage = previous.message;
            const currentVersion = Number(currentMessage.richVersion) || 1;
            if (baseVersion !== currentVersion) {
                return respond({ ok: false, conflict: true, message: currentMessage });
            }
            const history = Array.isArray(currentMessage.richHistory) && currentMessage.richHistory.length
                ? currentMessage.richHistory.slice()
                : [{
                    version: currentVersion,
                    content: currentMessage.content,
                    editorDeviceId: currentMessage.sender || '',
                    editorDeviceName: currentMessage.senderName || '',
                    editedAt: currentMessage.timestamp || Date.now()
                }];
            const nextVersion = currentVersion + 1;
            history.push({
                version: nextVersion,
                content,
                editorDeviceId: currentDevice,
                editorDeviceName: session.devices.get(currentDevice)?.deviceName || '',
                editedAt: Date.now()
            });
            const updated = createHistoryMessage({
                ...currentMessage,
                content,
                richVersion: nextVersion,
                richHistory: history,
                updatedAt: Date.now(),
                updatedBy: currentDevice
            });
            const size = Buffer.byteLength(JSON.stringify(updated), 'utf8');
            if (size > MAX_HISTORY_SIZE) return respond({ ok: false, error: 'history-too-large' });
            session.history[historyIndex] = { message: updated, size };
            session.historySize = Math.max(0, session.historySize - previous.size + size);
            session.lastActivity = Date.now();
            emitToReadableSessionDevices(session, 'message-updated', { message: updated });
            scheduleSessionHistoryBroadcast(sessionId, 'rich-message-edited');
            respond({ ok: true, message: updated });
        } catch (err) {
            console.error('rich-message-edit error:', err);
            respond({ ok: false, error: 'internal-error' });
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
            resumePendingSnsMetadataScans(sessionId, canonicalMessages);
            emitToReadableSessionDevices(session, 'session-history', {
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

    socket.on('server-asset-cache-confirmed', data => {
        const assetId = sanitizeString(data?.assetId || '', 80);
        const asset = resolveTelegramServerAsset(assetId);
        const session = sessions.get(currentSession);
        const registeredProvider = session?.fileAssets?.get(assetId)?.providers?.has(currentDevice);
        if (!asset || data?.sessionId !== currentSession || asset.sessionId !== currentSession || !registeredProvider) return;
        const confirmedSize = Number(data?.size) || 0;
        if (asset.size > 0 && confirmedSize > 0 && confirmedSize !== asset.size) return;
        asset.cacheConfirmedAt = Date.now();
        asset.cacheConfirmedBy = currentDevice;
        persistTelegramServerAsset(asset);
        removeConfirmedServerAssetFile(asset);
        historyLog('server-asset-cache-confirmed', {
            sessionId: currentSession,
            deviceId: currentDevice,
            assetId,
            source: asset.source || (asset.fileId ? 'telegram' : 'server')
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
        if (!data || typeof data !== 'object') return;

        const { event, details, sessionId, deviceId, clientTimestamp } = data;
        const isExternalDependencyEvent = typeof event === 'string' && event.startsWith('external-dependency-');
        if (!HISTORY_DEBUG && !isExternalDependencyEvent) return;
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
            source: isExternalDependencyEvent ? 'external-dependency' : 'client',
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
            return emitSocketError('error', '同步过于频繁', { code: 'EDITOR_SYNC_RATE_LIMITED' });
        }
        
        try {
            if (!data || typeof data !== 'object') return;
            
            const { sessionId, from, content } = data;
            const session = sessions.get(sessionId);
            if (!canUseTunnelCapability(session, currentDevice, 'collaborativeEdit')) {
                return socket.emit('permission-denied', { capability: 'collaborativeEdit' });
            }
            
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
                    message: socketText('协同编辑内容过大，无法同步'),
                    code: 'EDITOR_CONTENT_TOO_LARGE',
                    contentSize,
                    maxContentSize: MAX_EDITOR_CONTENT_SIZE
                });
            }
            
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
                        message: socketText('协同编辑图片数量已达上限'),
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
            return emitSocketError('error', '请求过于频繁');
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
        isValidAssetId: isValidServerAssetId,
        isValidDeviceId,
        isValidSessionId,
        sanitize: sanitizeString,
        historyLog,
        clientIp,
        translateText: socketText
    });

    registerMediaHandlers(socket, {
        sessions,
        deviceSockets,
        getSessionId: () => currentSession,
        getDeviceId: () => currentDevice,
        isValidId: isValidDeviceId,
        canUseCapability: canUseTunnelCapability,
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
            const session = sessions.get(currentSession);
            if (session) {
                const device = session.devices.get(currentDevice);

                // A reloaded page may already have replaced this socket.
                if (device && device.socketId === socket.id) {
                    cleanupFileAssetRelays(currentSession, currentDevice);
                    for (const [key, relay] of editorAssetRelays) {
                        if (relay.sessionId === currentSession && (relay.from === currentDevice || relay.to === currentDevice)) {
                            editorAssetRelays.delete(key);
                        }
                    }
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
                        cleanupFileAssetAssignments(session, currentDevice);
                        for (const [assetId, asset] of session.fileAssets) {
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
    console.log(`🎞️ Media tools: ffmpeg=${FFMPEG_COMMAND}; ffprobe=${FFPROBE_COMMAND}; yt-dlp ffmpeg-location=${getYtDlpFfmpegArgs()[1] || '(PATH)'}`);
    console.log(`⚠️ External dependency audit: GET /api/admin/external-dependencies ; logs: /api/debug-logs?source=external-dependency`);
}

function auditExternalRuntimeDependencies() {
    const checks = [];
    const ytDlpInvocation = getYtDlpInvocation(['--version']);
    checks.push({ name: 'yt-dlp', command: ytDlpInvocation.command, args: ytDlpInvocation.args });
    checks.push({ name: 'ffmpeg', command: FFMPEG_COMMAND, args: ['-version'] });
    checks.push({ name: 'ffprobe', command: FFPROBE_COMMAND, args: ['-version'] });

    for (const check of checks) {
        let result;
        try {
            result = spawnSync(check.command, check.args, {
                encoding: 'utf8', windowsHide: true, env: buildYtDlpEnv(), timeout: 10000
            });
        } catch (error) {
            recordExternalDependencyEvent('local-media-toolchain', `startup-${check.name}`, {
                level: 'error', error,
                hint: `${check.name} could not be executed; related media/crawler features will fail.`
            });
            continue;
        }
        if (result.error || result.status !== 0) {
            const error = result.error || new Error(
                String(result.stderr || result.stdout || `${check.name}-exit-${result.status}`).trim().slice(-500)
            );
            recordExternalDependencyEvent('local-media-toolchain', `startup-${check.name}`, {
                level: 'error', error,
                details: { status: result.status },
                hint: `${check.name} is missing or incompatible; related features will fail until the runtime is repaired.`
            });
            continue;
        }
        const version = String(result.stdout || result.stderr || '').split(/\r?\n/).map(value => value.trim()).find(Boolean) || 'available';
        recordExternalDependencyEvent('local-media-toolchain', `startup-${check.name}`, {
            level: 'info', details: { version: version.slice(0, 180) }
        });
    }

    const jsRuntime = String(process.env.SOCIAL_YTDLP_JS_RUNTIME || 'node').trim();
    if (jsRuntime === 'node') {
        recordExternalDependencyEvent('local-media-toolchain', 'startup-yt-dlp-js-runtime', {
            level: 'info', details: { runtime: 'node', version: process.version }
        });
    } else {
        const runtimeCommand = jsRuntime.split(':')[0].trim();
        const executable = runtimeCommand ? locateExecutable(runtimeCommand) : '';
        recordExternalDependencyEvent('local-media-toolchain', 'startup-yt-dlp-js-runtime', {
            level: executable ? 'info' : 'error',
            message: executable ? '' : `Configured yt-dlp JS runtime not found: ${runtimeCommand || jsRuntime}`,
            details: { runtime: jsRuntime, executable: executable || '' },
            hint: executable ? '' : 'YouTube signature solving may fail when the configured JS runtime is unavailable.'
        });
    }

    const remoteComponents = String(process.env.SOCIAL_YTDLP_REMOTE_COMPONENTS || '').trim();
    if (remoteComponents && remoteComponents !== 'false') {
        recordExternalDependencyEvent('yt-dlp-remote-components', 'startup-configured', {
            level: 'warn', details: { remoteComponents },
            hint: 'This feature intentionally depends on a remote component provider; provider availability/version changes can break YouTube extraction.'
        });
    }
}

async function startServer() {
    infraStore = await createInfraStore({ dataDir: SERVER_DATA_DIR });
    cleanupSnsWorkFiles('.cookies-');
    migrateLegacyShortCodeStore();
    hydrateShortCodeCache();
    hydrateTelegramServerAssets();
    auditExternalRuntimeDependencies();
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
