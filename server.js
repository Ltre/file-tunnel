/**
 * 即时传输隧道 - Socket.io 服务器 (安全版本)
 * 用于会话管理和信令中转
 */

const express = require('express');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();

// ==================== 安全配置 ====================

const SSL_KEY = process.env.SSL_KEY_PATH;
const SSL_CERT = process.env.SSL_CERT_PATH;
const SERVER_PROTOCOL = SSL_KEY && SSL_CERT ? 'https' : 'http';
const DEFAULT_WEB_PORT = process.env.NODE_ENV === 'development' || process.env.npm_lifecycle_event === 'dev'
    ? 3000
    : (SERVER_PROTOCOL === 'https' ? 443 : 80);
const WEB_PORT = Number(process.env.WEB_PORT || process.env.PORT || DEFAULT_WEB_PORT);
const webServer = createWebServer();

const TEST_HOST_PATTERN = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.0\.\d{1,3})$/;

function splitEnvList(value) {
    return value.split(',').map(item => item.trim()).filter(Boolean);
}

function createWebServer() {
    if (SERVER_PROTOCOL === 'https') {
        return https.createServer({
            key: fs.readFileSync(SSL_KEY),
            cert: fs.readFileSync(SSL_CERT)
        }, app);
    }

    return http.createServer(app);
}

// 允许的域名
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
    ? splitEnvList(process.env.ALLOWED_ORIGINS)
    : [
        'http://localhost',
        'http://localhost:3000',
        'http://127.0.0.1',
        'http://127.0.0.1:3000',
        'http://0.0.0.0:3000',
        'https://localhost:3000',
        'https://127.0.0.1:3000',
        'https://0.0.0.0:3000',
        'https://x-tx-sl.miku.us',
        'http://x-tx-sl.miku.us',
        'https://x-tx-sl.miku.us:3000',
        'http://x-tx-sl.miku.us:3000',
		'http://10.0.0.40:3000',
        'http://tun.miku.us',
		'https://tun.miku.us',  //正式生产环境（WEB，非socket）
        'http://tun-socket.miku.us',
        'https://tun-socket.miku.us'
      ];

function isAllowedOrigin(origin) {
    if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
        return true;
    }

    try {
        const url = new URL(origin);
        return url.port === '3000' && TEST_HOST_PATTERN.test(url.hostname);
    } catch (err) {
        return false;
    }
}

// 速率限制配置
const RATE_LIMIT = {
    windowMs: 15 * 60 * 1000, // 15分钟
    max: 100, // 每个IP最多100个请求
    message: { error: '请求过于频繁，请稍后再试' }
};

// 会话限制
const MAX_SESSIONS = 1000;
const MAX_DEVICES_PER_SESSION = 10;
const MAX_SESSION_AGE = 2 * 60 * 60 * 1000; // 2小时
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB

// ==================== Express 中间件 ====================

// 基础安全头
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// 速率限制
app.use(rateLimit(RATE_LIMIT));

// 静态文件服务 (限制目录遍历)
app.use(express.static(path.join(__dirname), {
    dotfiles: 'deny',
    index: ['index.html']
}));

// 管理后台API
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// API: 获取所有会话信息
app.get('/api/sessions', (req, res) => {
    try {
        const sessionList = [];
        let totalDevices = 0;
        
        sessions.forEach((session, sessionId) => {
            totalDevices += session.devices.size;
            sessionList.push({
                id: sessionId,
                deviceCount: session.devices.size,
                createdAt: session.createdAt,
                lastActivity: session.lastActivity,
                isActive: Date.now() - session.lastActivity < 5 * 60 * 1000
            });
        });
        
        // 按最后活动时间排序
        sessionList.sort((a, b) => b.lastActivity - a.lastActivity);
        
        res.json({
            sessions: sessionList,
            totalDevices,
            totalMessages: 0, // 服务器不存储消息
            totalFiles: 0     // 服务器不存储文件
        });
    } catch (err) {
        console.error('API error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== Socket.io 配置 ====================

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

// ==================== 验证函数 ====================

function sanitizeString(str, maxLength = 100) {
    if (typeof str !== 'string') return '';
    return str.slice(0, maxLength).replace(/[<>"']/g, '');
}

function isValidSessionId(id) {
    return typeof id === 'string' && 
           /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

function isValidDeviceId(id) {
    return typeof id === 'string' && 
           /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function isValidDeviceName(name) {
    return typeof name === 'string' && 
           name.length > 0 && 
           name.length <= 50;
}

// ==================== Socket.io 连接处理 ====================

io.on('connection', (socket) => {
    const clientIp = socket.handshake.address || 
                     socket.handshake.headers['x-forwarded-for'] || 
                     'unknown';
    
    console.log(`Client connected: ${socket.id} from ${clientIp}`);
    
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
                    createdAt: Date.now(),
                    lastActivity: Date.now()
                });
            }
            
            const session = sessions.get(sessionId);
            
            // 设备数量限制
            if (session.devices.size >= MAX_DEVICES_PER_SESSION) {
                return socket.emit('error', { message: '会话设备数已满' });
            }
            
            // 添加设备到会话
            session.devices.set(deviceId, {
                deviceId,
                deviceName: sanitizeString(deviceName),
                socketId: socket.id,
                joinedAt: Date.now()
            });
            
            session.lastActivity = Date.now();
            
            // 加入Socket.io房间
            socket.join(sessionId);
            
            console.log(`Device ${deviceName} (${deviceId}) joined session ${sessionId}`);
            
            // 通知会话中的其他设备
            socket.to(sessionId).emit('device-joined', {
                deviceId,
                deviceName: sanitizeString(deviceName),
                joinedAt: Date.now()
            });
            
            // 发送当前会话中的所有设备信息给新设备
            const deviceList = [];
            session.devices.forEach((d, id) => {
                if (id !== deviceId) {
                    deviceList.push({
                        deviceId: d.deviceId,
                        deviceName: d.deviceName,
                        joinedAt: d.joinedAt
                    });
                }
            });
            
            socket.emit('session-devices', {
                devices: deviceList
            });
        } catch (err) {
            console.error('join-session error:', err);
            socket.emit('error', { message: '服务器内部错误' });
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
            
            // 广播给会话中的其他设备
            socket.to(sessionId).emit('message', { message });
        } catch (err) {
            console.error('message error:', err);
        }
    });
    
    // 编辑器同步
    socket.on('editor-sync', (data) => {
        if (!checkMessageRate()) {
            return socket.emit('error', { message: '同步过于频繁' });
        }
        
        try {
            if (!data || typeof data !== 'object') return;
            
            const { sessionId, from, content } = data;
            
            if (!isValidSessionId(sessionId)) return;
            if (from !== currentDevice) return;
            if (typeof content !== 'string') return;
            if (content.length > 100000) return; // 限制内容大小
            
            const session = sessions.get(sessionId);
            if (!session) return;
            
            session.lastActivity = Date.now();
            
            // 广播给会话中的其他设备
            socket.to(sessionId).emit('editor-sync', { from, content });
        } catch (err) {
            console.error('editor-sync error:', err);
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
    
    // 断开连接
    socket.on('disconnect', (reason) => {
        console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
        
        // 清理IP连接记录
        ipSockets.delete(socket.id);
        if (ipSockets.size === 0) {
            ipConnections.delete(clientIp);
        }
        
        if (currentSession && currentDevice) {
            const session = sessions.get(currentSession);
            if (session) {
                session.devices.delete(currentDevice);
                
                // 通知会话中的其他设备
                socket.to(currentSession).emit('device-left', {
                    deviceId: currentDevice
                });
                
                // 如果会话为空，清理会话
                if (session.devices.size === 0) {
                    sessions.delete(currentSession);
                    console.log(`Session ${currentSession} removed (empty)`);
                }
            }
            
            deviceSockets.delete(currentDevice);
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
    
    for (const [sessionId, session] of sessions) {
        // 清理空会话或过期会话
        if (session.devices.size === 0 && 
            (now - session.createdAt > 60000 || // 空会话1分钟后清理
             now - session.lastActivity > MAX_SESSION_AGE)) { // 活跃会话2小时后清理
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

function formatLocalUrl(protocol, port) {
    const defaultPort = (protocol === 'http' && port === 80) || (protocol === 'https' && port === 443);
    return `${protocol}://localhost${defaultPort ? '' : `:${port}`}`;
}

function logStartup() {
    console.log(`🚀 即时传输隧道服务器运行中 (安全版本)`);
    console.log(`📱 Web/API: ${formatLocalUrl(SERVER_PROTOCOL, WEB_PORT)}`);
    console.log(`🔌 Socket.IO: 与 Web/API 共用 ${WEB_PORT} 端口`);
    console.log(`🔒 CORS: ${ALLOWED_ORIGINS.join(', ')}`);
}

webServer.listen(WEB_PORT, '0.0.0.0', logStartup);

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
