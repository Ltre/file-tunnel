/**
 * 即时传输隧道 - Socket.io 服务器
 * 用于会话管理和信令中转
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 存储会话信息 (内存存储，重启后清空)
const sessions = new Map(); // sessionId -> { devices: Set<deviceId>, createdAt }
const deviceSockets = new Map(); // deviceId -> socket

// 静态文件服务
app.use(express.static(path.join(__dirname)));

// 会话路由
app.get('/:sessionId', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.io 连接处理
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    let currentSession = null;
    let currentDevice = null;
    
    // 加入会话
    socket.on('join-session', (data) => {
        const { sessionId, deviceId, deviceName } = data;
        
        currentSession = sessionId;
        currentDevice = deviceId;
        
        // 存储设备socket映射
        deviceSockets.set(deviceId, socket);
        
        // 获取或创建会话
        if (!sessions.has(sessionId)) {
            sessions.set(sessionId, {
                devices: new Map(),
                createdAt: Date.now()
            });
        }
        
        const session = sessions.get(sessionId);
        
        // 添加设备到会话
        session.devices.set(deviceId, {
            deviceId,
            deviceName,
            socketId: socket.id,
            joinedAt: Date.now()
        });
        
        // 加入Socket.io房间
        socket.join(sessionId);
        
        console.log(`Device ${deviceName} (${deviceId}) joined session ${sessionId}`);
        
        // 通知会话中的其他设备
        socket.to(sessionId).emit('device-joined', {
            deviceId,
            deviceName,
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
    });
    
    // 信令转发 (WebRTC)
    socket.on('signal', (data) => {
        const { to, from, type, sdp, candidate } = data;
        
        const targetSocket = deviceSockets.get(to);
        if (targetSocket) {
            targetSocket.emit('signal', {
                from,
                type,
                sdp,
                candidate
            });
        }
    });
    
    // 消息转发
    socket.on('message', (data) => {
        const { sessionId, message } = data;
        
        // 广播给会话中的其他设备
        socket.to(sessionId).emit('message', { message });
    });
    
    // 编辑器同步
    socket.on('editor-sync', (data) => {
        const { sessionId, from, content } = data;
        
        // 广播给会话中的其他设备
        socket.to(sessionId).emit('editor-sync', { from, content });
    });
    
    // 文件传输offer
    socket.on('file-offer', (data) => {
        const { sessionId, from, fileInfo } = data;
        
        // 广播给会话中的其他设备
        socket.to(sessionId).emit('file-offer', { from, fileInfo });
    });
    
    // 文件传输answer
    socket.on('file-answer', (data) => {
        const { sessionId, to, from, fileId, accepted } = data;
        
        const targetSocket = deviceSockets.get(to);
        if (targetSocket) {
            targetSocket.emit('file-answer', {
                from,
                fileId,
                accepted
            });
        }
    });
    
    // 断开连接
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        
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
});

// 清理过期会话 (每30分钟)
setInterval(() => {
    const now = Date.now();
    const timeout = 30 * 60 * 1000; // 30分钟
    
    for (const [sessionId, session] of sessions) {
        if (now - session.createdAt > timeout && session.devices.size === 0) {
            sessions.delete(sessionId);
            console.log(`Session ${sessionId} cleaned up (expired)`);
        }
    }
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 即时传输隧道服务器运行中`);
    console.log(`📱 本机访问: http://localhost:${PORT}`);
    console.log(`🌐 局域网访问: http://10.8.0.16:${PORT}`);
    console.log(`⚠️  注意: 手机需要和电脑在同一网络才能访问`);
});
