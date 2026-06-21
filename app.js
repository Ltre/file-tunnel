/**
 * 即时传输隧道 - 主应用
 * 功能：P2P文件传输、协同编辑、本地存储
 */

// ==================== 配置 ====================
const CONFIG = {
    // Socket.io 服务器地址 (自动检测)
    // 开发环境: 使用当前页面地址
    // 生产环境: 可配置为固定地址
    SOCKET_SERVER: window.location.origin,
    
    // 备用服务器地址 (当自动检测失败时使用)
    // 例如: 'http://10.8.0.16:3000'
    FALLBACK_SERVER: null,
    // 小文件大小阈值 (5MB)
    SMALL_FILE_THRESHOLD: 5 * 1024 * 1024,
    // 分块大小 (64KB)
    CHUNK_SIZE: 64 * 1024,
    // 存储键前缀
    STORAGE_PREFIX: 'tunnel_',
    // 会话超时 (30分钟)
    SESSION_TIMEOUT: 30 * 60 * 1000
};

// ==================== 全局状态 ====================
const state = {
    sessionId: null,
    deviceId: null,
    deviceName: null,
    socket: null,
    peers: new Map(), // deviceId -> RTCPeerConnection
    dataChannels: new Map(), // deviceId -> RTCDataChannel
    devices: new Map(), // deviceId -> deviceInfo
    messages: [],
    pendingFiles: new Map(), // fileId -> fileInfo
    editorContent: '',
    isSyncing: false,
    db: null // IndexedDB实例
};

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', async () => {
    await initStorage();
    initSession();
    initSocket();
    initUI();
    initEditor();
    initDragDrop();
    loadSessionData();
});

// ==================== 存储管理 (IndexedDB) ====================
async function initStorage() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('TunnelDB', 1);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            state.db = request.result;
            resolve();
        };
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            
            // 会话存储
            if (!db.objectStoreNames.contains('sessions')) {
                const sessionStore = db.createObjectStore('sessions', { keyPath: 'sessionId' });
                sessionStore.createIndex('lastActive', 'lastActive', { unique: false });
            }
            
            // 消息存储
            if (!db.objectStoreNames.contains('messages')) {
                const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
                msgStore.createIndex('sessionId', 'sessionId', { unique: false });
                msgStore.createIndex('timestamp', 'timestamp', { unique: false });
            }
            
            // 文件存储
            if (!db.objectStoreNames.contains('files')) {
                const fileStore = db.createObjectStore('files', { keyPath: 'id' });
                fileStore.createIndex('sessionId', 'sessionId', { unique: false });
            }
        };
    });
}

async function saveToStore(storeName, data) {
    return new Promise((resolve, reject) => {
        const transaction = state.db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.put(data);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function getFromStore(storeName, key) {
    return new Promise((resolve, reject) => {
        const transaction = state.db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function getAllFromStore(storeName, indexName, keyRange) {
    return new Promise((resolve, reject) => {
        const transaction = state.db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const source = indexName ? store.index(indexName) : store;
        const request = keyRange ? source.getAll(keyRange) : source.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function deleteFromStore(storeName, key) {
    return new Promise((resolve, reject) => {
        const transaction = state.db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.delete(key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// ==================== 会话管理 ====================
function initSession() {
    // 生成或获取设备ID
    state.deviceId = localStorage.getItem('deviceId') || generateId();
    localStorage.setItem('deviceId', state.deviceId);
    
    // 生成设备名称
    const deviceTypes = ['📱', '💻', '🖥️', '⌚', '📱'];
    const type = /Mobile|Android|iPhone|iPad/i.test(navigator.userAgent) ? 0 : 1;
    state.deviceName = `${deviceTypes[type]} 设备-${state.deviceId.slice(-4)}`;
    
    // 从URL hash获取或创建会话ID
    const hash = window.location.hash.slice(1);
    if (hash && /^[a-zA-Z0-9_-]{8,}$/.test(hash)) {
        state.sessionId = hash;
    } else {
        state.sessionId = generateId();
        window.location.hash = state.sessionId;
    }
    
    // 更新UI
    document.getElementById('sessionId').textContent = state.sessionId.slice(0, 8) + '...';
    document.getElementById('deviceId').textContent = state.deviceId.slice(0, 8) + '...';
    
    // 生成二维码
    generateQRCode();
}

function generateId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function generateQRCode() {
    const qrContainer = document.getElementById('qrcode');
    qrContainer.innerHTML = '';
    
    const currentUrl = window.location.href;
    new QRCode(qrContainer, {
        text: currentUrl,
        width: 180,
        height: 180,
        colorDark: '#667eea',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });
}

// ==================== Socket.io 连接 ====================
function initSocket() {
    state.socket = io(CONFIG.SOCKET_SERVER, {
        transports: ['websocket', 'polling']
    });
    
    state.socket.on('connect', () => {
        console.log('Socket connected');
        state.socket.emit('join-session', {
            sessionId: state.sessionId,
            deviceId: state.deviceId,
            deviceName: state.deviceName
        });
    });
    
    state.socket.on('device-joined', (data) => {
        handleDeviceJoined(data);
    });
    
    state.socket.on('device-left', (data) => {
        handleDeviceLeft(data);
    });
    
    state.socket.on('session-devices', (data) => {
        handleSessionDevices(data);
    });
    
    state.socket.on('signal', (data) => {
        handleSignal(data);
    });
    
    state.socket.on('message', (data) => {
        handleMessage(data);
    });
    
    state.socket.on('editor-sync', (data) => {
        handleEditorSync(data);
    });
    
    state.socket.on('file-offer', (data) => {
        handleFileOffer(data);
    });
    
    state.socket.on('file-answer', (data) => {
        handleFileAnswer(data);
    });
    
    state.socket.on('disconnect', () => {
        console.log('Socket disconnected');
    });
}

// ==================== WebRTC P2P ====================
async function createPeerConnection(deviceId) {
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    });
    
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            state.socket.emit('signal', {
                to: deviceId,
                from: state.deviceId,
                type: 'ice-candidate',
                candidate: event.candidate
            });
        }
    };
    
    pc.ondatachannel = (event) => {
        const channel = event.channel;
        setupDataChannel(deviceId, channel);
    };
    
    state.peers.set(deviceId, pc);
    return pc;
}

async function connectToPeer(deviceId) {
    if (state.peers.has(deviceId)) return;
    
    const pc = await createPeerConnection(deviceId);
    
    // 创建数据通道
    const channel = pc.createDataChannel('fileTransfer', {
        ordered: true
    });
    setupDataChannel(deviceId, channel);
    
    // 创建offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    state.socket.emit('signal', {
        to: deviceId,
        from: state.deviceId,
        type: 'offer',
        sdp: offer
    });
}

async function handleSignal(data) {
    const { from, type, sdp, candidate } = data;
    
    let pc = state.peers.get(from);
    if (!pc) {
        pc = await createPeerConnection(from);
    }
    
    try {
        if (type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            
            state.socket.emit('signal', {
                to: from,
                from: state.deviceId,
                type: 'answer',
                sdp: answer
            });
        } else if (type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } else if (type === 'ice-candidate') {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    } catch (err) {
        console.error('Signal handling error:', err);
    }
}

function setupDataChannel(deviceId, channel) {
    state.dataChannels.set(deviceId, channel);
    
    channel.onopen = () => {
        console.log('Data channel opened with', deviceId);
    };
    
    channel.onmessage = (event) => {
        handleDataChannelMessage(deviceId, event.data);
    };
    
    channel.onclose = () => {
        console.log('Data channel closed with', deviceId);
        state.dataChannels.delete(deviceId);
    };
}

// ==================== 文件传输 ====================
const fileTransfers = new Map(); // fileId -> transferInfo

async function sendFile(file, targetDeviceId = null) {
    const fileId = generateId();
    const fileInfo = {
        id: fileId,
        name: file.name,
        size: file.size,
        type: file.type,
        timestamp: Date.now(),
        sender: state.deviceId,
        senderName: state.deviceName
    };
    
    // 保存文件到本地存储
    await saveToStore('files', {
        ...fileInfo,
        sessionId: state.sessionId,
        data: await fileToArrayBuffer(file)
    });
    
    // 小文件直接通过socket发送
    if (file.size <= CONFIG.SMALL_FILE_THRESHOLD) {
        const base64Data = await fileToBase64(file);
        const message = {
            id: generateId(),
            type: 'file',
            fileInfo: {
                ...fileInfo,
                data: base64Data,
                isSmall: true
            },
            timestamp: Date.now(),
            sender: state.deviceId,
            senderName: state.deviceName
        };
        
        state.socket.emit('message', {
            sessionId: state.sessionId,
            message
        });
        
        addMessageToChat(message, true);
    } else {
        // 大文件通过P2P发送
        sendFileOffer(fileInfo, file, targetDeviceId);
    }
    
    return fileId;
}

async function sendFileOffer(fileInfo, file, targetDeviceId) {
    // 广播文件offer
    state.socket.emit('file-offer', {
        sessionId: state.sessionId,
        from: state.deviceId,
        fileInfo: {
            id: fileInfo.id,
            name: fileInfo.name,
            size: fileInfo.size,
            type: fileInfo.type
        }
    });
    
    // 等待接受后通过P2P发送
    fileTransfers.set(fileInfo.id, {
        file,
        fileInfo,
        status: 'offered'
    });
}

async function handleFileOffer(data) {
    const { from, fileInfo } = data;
    
    // 显示确认对话框
    showConfirmModal(fileInfo, async (accepted) => {
        state.socket.emit('file-answer', {
            sessionId: state.sessionId,
            to: from,
            from: state.deviceId,
            fileId: fileInfo.id,
            accepted
        });
        
        if (accepted) {
            // 初始化P2P连接
            await connectToPeer(from);
            
            // 准备接收文件
            fileTransfers.set(fileInfo.id, {
                chunks: [],
                receivedSize: 0,
                fileInfo,
                from
            });
            
            showProgress(fileInfo.id, fileInfo.name, 0);
        }
    });
}

async function handleFileAnswer(data) {
    const { from, fileId, accepted } = data;
    
    const transfer = fileTransfers.get(fileId);
    if (!transfer) return;
    
    if (accepted) {
        // 建立P2P连接并开始发送
        await connectToPeer(from);
        
        // 等待数据通道就绪
        setTimeout(() => {
            sendFileViaDataChannel(from, transfer.file, transfer.fileInfo);
        }, 1000);
    } else {
        fileTransfers.delete(fileId);
        alert(`对方拒绝了文件: ${transfer.fileInfo.name}`);
    }
}

async function sendFileViaDataChannel(deviceId, file, fileInfo) {
    const channel = state.dataChannels.get(deviceId);
    if (!channel || channel.readyState !== 'open') {
        console.error('Data channel not ready');
        return;
    }
    
    // 发送文件元数据
    channel.send(JSON.stringify({
        type: 'file-start',
        fileId: fileInfo.id,
        fileInfo
    }));
    
    // 分块发送文件
    const buffer = await fileToArrayBuffer(file);
    const totalChunks = Math.ceil(buffer.byteLength / CONFIG.CHUNK_SIZE);
    
    showProgress(fileInfo.id, fileInfo.name, 0);
    
    for (let i = 0; i < totalChunks; i++) {
        const start = i * CONFIG.CHUNK_SIZE;
        const end = Math.min(start + CONFIG.CHUNK_SIZE, buffer.byteLength);
        const chunk = buffer.slice(start, end);
        
        channel.send(chunk);
        
        const progress = Math.round(((i + 1) / totalChunks) * 100);
        updateProgress(fileInfo.id, progress);
        
        // 避免阻塞，每发送一块稍微延迟
        await new Promise(r => setTimeout(r, 10));
    }
    
    // 发送完成标记
    channel.send(JSON.stringify({
        type: 'file-complete',
        fileId: fileInfo.id
    }));
    
    hideProgress(fileInfo.id);
    
    // 添加消息到聊天记录
    const message = {
        id: generateId(),
        type: 'file',
        fileInfo: {
            ...fileInfo,
            isP2P: true
        },
        timestamp: Date.now(),
        sender: state.deviceId,
        senderName: state.deviceName
    };
    
    addMessageToChat(message, true);
}

async function handleDataChannelMessage(deviceId, data) {
    if (typeof data === 'string') {
        const msg = JSON.parse(data);
        
        if (msg.type === 'file-start') {
            // 初始化接收
            const transfer = fileTransfers.get(msg.fileId);
            if (transfer) {
                transfer.chunks = [];
                transfer.receivedSize = 0;
            }
        } else if (msg.type === 'file-complete') {
            // 文件接收完成
            const transfer = fileTransfers.get(msg.fileId);
            if (transfer) {
                // 合并块
                const totalSize = transfer.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
                const combined = new Uint8Array(totalSize);
                let offset = 0;
                
                for (const chunk of transfer.chunks) {
                    combined.set(new Uint8Array(chunk), offset);
                    offset += chunk.byteLength;
                }
                
                // 保存文件
                await saveToStore('files', {
                    ...transfer.fileInfo,
                    sessionId: state.sessionId,
                    data: combined.buffer
                });
                
                // 添加消息
                const message = {
                    id: generateId(),
                    type: 'file',
                    fileInfo: transfer.fileInfo,
                    timestamp: Date.now(),
                    sender: transfer.from,
                    senderName: state.devices.get(transfer.from)?.name || '未知设备'
                };
                
                addMessageToChat(message, false);
                hideProgress(msg.fileId);
                fileTransfers.delete(msg.fileId);
            }
        }
    } else {
        // 接收文件块
        for (const [fileId, transfer] of fileTransfers) {
            if (transfer.from === deviceId) {
                transfer.chunks.push(data);
                transfer.receivedSize += data.byteLength;
                
                const progress = Math.round((transfer.receivedSize / transfer.fileInfo.size) * 100);
                updateProgress(fileId, progress);
                break;
            }
        }
    }
}

// ==================== 消息处理 ====================
function handleMessage(data) {
    const { message } = data;
    
    if (message.sender === state.deviceId) return;
    
    // 保存消息
    saveToStore('messages', {
        ...message,
        sessionId: state.sessionId
    });
    
    addMessageToChat(message, false);
}

function addMessageToChat(message, isOwn) {
    const container = document.getElementById('chatMessages');
    
    // 移除空状态
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
    
    const messageEl = document.createElement('div');
    messageEl.className = `message ${isOwn ? 'own' : ''}`;
    
    let contentHtml = '';
    
    if (message.type === 'text') {
        contentHtml = `<div class="message-bubble">${escapeHtml(message.text)}</div>`;
    } else if (message.type === 'file') {
        const fileInfo = message.fileInfo;
        const isImage = fileInfo.type.startsWith('image/');
        const isVideo = fileInfo.type.startsWith('video/');
        const isAudio = fileInfo.type.startsWith('audio/');
        
        if (isImage && fileInfo.isSmall) {
            // 直接显示小图片
            contentHtml = `
                <div class="message-bubble">
                    <div class="media-preview">
                        <img src="${fileInfo.data}" alt="${fileInfo.name}" 
                             onclick="downloadFile('${fileInfo.id}')">
                    </div>
                </div>
            `;
        } else if (isVideo && fileInfo.isSmall) {
            contentHtml = `
                <div class="message-bubble">
                    <div class="media-preview">
                        <video controls src="${fileInfo.data}"></video>
                    </div>
                </div>
            `;
        } else if (isAudio && fileInfo.isSmall) {
            contentHtml = `
                <div class="message-bubble">
                    <div class="media-preview">
                        <audio controls src="${fileInfo.data}"></audio>
                    </div>
                </div>
            `;
        } else {
            // 文件消息
            const sizeStr = formatFileSize(fileInfo.size);
            contentHtml = `
                <div class="message-bubble file-message" onclick="downloadFile('${fileInfo.id}')">
                    <div class="file-icon">${getFileIcon(fileInfo.type)}</div>
                    <div class="file-info">
                        <div class="file-name">${fileInfo.name}</div>
                        <div class="file-size">${sizeStr}</div>
                    </div>
                </div>
            `;
        }
    } else if (message.type === 'rich') {
        // 富文本消息
        const preview = message.content.replace(/<[^>]+>/g, '').slice(0, 100);
        contentHtml = `
            <div class="rich-preview" onclick="viewRichContent('${message.id}')">
                <div class="rich-preview-title">
                    <span>📝</span>
                    <span>富文本消息</span>
                </div>
                <div class="rich-preview-content">${escapeHtml(preview)}${preview.length >= 100 ? '...' : ''}</div>
            </div>
        `;
    }
    
    messageEl.innerHTML = `
        <div class="message-header">
            <span>${message.senderName}</span>
            <span>${formatTime(message.timestamp)}</span>
        </div>
        ${contentHtml}
    `;
    
    container.appendChild(messageEl);
    container.scrollTop = container.scrollHeight;
}

async function sendText() {
    const input = document.getElementById('textInput');
    const text = input.value.trim();
    
    if (!text) return;
    
    const message = {
        id: generateId(),
        type: 'text',
        text,
        timestamp: Date.now(),
        sender: state.deviceId,
        senderName: state.deviceName
    };
    
    // 保存到本地
    await saveToStore('messages', {
        ...message,
        sessionId: state.sessionId
    });
    
    // 发送到其他设备
    state.socket.emit('message', {
        sessionId: state.sessionId,
        message
    });
    
    addMessageToChat(message, true);
    input.value = '';
}

// ==================== 协同编辑 ====================
function initEditor() {
    const editor = document.getElementById('editor');
    let syncTimeout;
    
    // 工具栏按钮
    document.querySelectorAll('.toolbar-btn[data-cmd]').forEach(btn => {
        btn.addEventListener('click', () => {
            const cmd = btn.dataset.cmd;
            document.execCommand(cmd, false, null);
            editor.focus();
        });
    });
    
    // 插入图片
    document.getElementById('insertImageBtn').addEventListener('click', async () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (file) {
                const base64 = await fileToBase64(file);
                const img = `<img src="${base64}" style="max-width: 100%; border-radius: 8px;">`;
                document.execCommand('insertHTML', false, img);
            }
        };
        input.click();
    });
    
    // 引用文件
    document.getElementById('insertFileBtn').addEventListener('click', async () => {
        // 获取当前会话的所有文件
        const files = await getAllFromStore('files', 'sessionId', IDBKeyRange.only(state.sessionId));
        
        if (files.length === 0) {
            alert('暂无文件可引用');
            return;
        }
        
        // 创建文件选择对话框
        const fileList = files.map(f => 
            `<option value="${f.id}">${f.name} (${formatFileSize(f.size)})</option>`
        ).join('');
        
        const dialog = document.createElement('div');
        dialog.className = 'modal-overlay active';
        dialog.innerHTML = `
            <div class="modal">
                <h3>📎 引用文件</h3>
                <select id="fileSelect" style="width: 100%; padding: 10px; margin: 15px 0; border-radius: 8px; border: 1px solid #ddd;">
                    ${fileList}
                </select>
                <div class="modal-actions">
                    <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
                    <button class="btn btn-primary" id="confirmInsertFile">插入</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);
        
        document.getElementById('confirmInsertFile').addEventListener('click', async () => {
            const fileId = document.getElementById('fileSelect').value;
            const file = await getFromStore('files', fileId);
            
            if (file) {
                let refHtml = '';
                if (file.type.startsWith('image/')) {
                    const blob = new Blob([file.data]);
                    const url = URL.createObjectURL(blob);
                    refHtml = `<img src="${url}" style="max-width: 200px; border-radius: 8px; cursor: pointer;" onclick="downloadFile('${fileId}')">`;
                } else {
                    refHtml = `<span style="background: #667eea; color: white; padding: 5px 10px; border-radius: 5px; cursor: pointer;" onclick="downloadFile('${fileId}')">📎 ${file.name}</span>`;
                }
                document.execCommand('insertHTML', false, refHtml);
            }
            
            dialog.remove();
        });
    });
    
    // 内容变化同步
    editor.addEventListener('input', () => {
        state.isSyncing = true;
        document.getElementById('collabStatus').textContent = '编辑中...';
        
        clearTimeout(syncTimeout);
        syncTimeout = setTimeout(() => {
            const content = editor.innerHTML;
            state.socket.emit('editor-sync', {
                sessionId: state.sessionId,
                from: state.deviceId,
                content
            });
            state.isSyncing = false;
            document.getElementById('collabStatus').textContent = '已同步';
        }, 500);
    });
    
    // 发送富文本
    document.getElementById('sendRichBtn').addEventListener('click', async () => {
        const content = editor.innerHTML;
        if (!content.trim() || content === '<br>') {
            alert('请输入内容');
            return;
        }
        
        const message = {
            id: generateId(),
            type: 'rich',
            content,
            timestamp: Date.now(),
            sender: state.deviceId,
            senderName: state.deviceName
        };
        
        // 保存到本地
        await saveToStore('messages', {
            ...message,
            sessionId: state.sessionId
        });
        
        // 发送到其他设备
        state.socket.emit('message', {
            sessionId: state.sessionId,
            message
        });
        
        addMessageToChat(message, true);
        editor.innerHTML = '';
    });
    
    // 清空编辑器
    document.getElementById('clearEditorBtn').addEventListener('click', () => {
        editor.innerHTML = '';
    });
}

function handleEditorSync(data) {
    const { from, content } = data;
    
    if (from === state.deviceId) return;
    
    const editor = document.getElementById('editor');
    const currentContent = editor.innerHTML;
    
    // 简单的内容合并策略
    if (content !== currentContent) {
        editor.innerHTML = content;
        document.getElementById('collabStatus').textContent = '已同步';
    }
}

// ==================== 设备管理 ====================
function handleDeviceJoined(data) {
    const { deviceId, deviceName } = data;
    
    if (deviceId === state.deviceId) return;
    
    state.devices.set(deviceId, {
        id: deviceId,
        name: deviceName,
        joinedAt: Date.now()
    });
    
    updateDeviceList();
    
    // 尝试建立P2P连接
    connectToPeer(deviceId);
}

function handleDeviceLeft(data) {
    const { deviceId } = data;
    
    state.devices.delete(deviceId);
    
    // 清理P2P连接
    const pc = state.peers.get(deviceId);
    if (pc) {
        pc.close();
        state.peers.delete(deviceId);
    }
    
    state.dataChannels.delete(deviceId);
    updateDeviceList();
}

function handleSessionDevices(data) {
    const { devices } = data;
    
    devices.forEach(device => {
        if (device.deviceId !== state.deviceId) {
            state.devices.set(device.deviceId, {
                id: device.deviceId,
                name: device.deviceName,
                joinedAt: device.joinedAt
            });
            
            // 建立P2P连接
            connectToPeer(device.deviceId);
        }
    });
    
    updateDeviceList();
}

function updateDeviceList() {
    const container = document.getElementById('deviceList');
    const count = state.devices.size + 1;
    document.getElementById('onlineCount').textContent = count;
    
    container.innerHTML = '';
    
    // 添加自己
    const selfEl = document.createElement('div');
    selfEl.className = 'device-item';
    selfEl.innerHTML = `
        <div class="icon">👤</div>
        <div class="info">
            <div class="name">${state.deviceName} (我)</div>
            <div class="status">在线</div>
        </div>
    `;
    container.appendChild(selfEl);
    
    // 添加其他设备
    state.devices.forEach(device => {
        const el = document.createElement('div');
        el.className = 'device-item';
        el.innerHTML = `
            <div class="icon">📱</div>
            <div class="info">
                <div class="name">${device.name}</div>
                <div class="status">在线 · P2P${state.dataChannels.has(device.id) ? '已连接' : '连接中'}</div>
            </div>
        `;
        container.appendChild(el);
    });
}

// ==================== UI 初始化 ====================
function initUI() {
    // 发送文本
    document.getElementById('sendTextBtn').addEventListener('click', sendText);
    document.getElementById('textInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendText();
    });
    
    // 文件上传
    document.getElementById('dropZone').addEventListener('click', () => {
        document.getElementById('fileInput').click();
    });
    
    document.getElementById('fileInput').addEventListener('change', async (e) => {
        const files = e.target.files;
        for (const file of files) {
            await sendFile(file);
        }
        e.target.value = '';
    });
    
    // 模态框关闭
    document.getElementById('rejectFileBtn').addEventListener('click', () => {
        document.getElementById('confirmModal').classList.remove('active');
    });
    
    document.getElementById('closeRichViewer').addEventListener('click', () => {
        document.getElementById('richViewer').classList.remove('active');
    });
    
    // 点击遮罩关闭
    document.getElementById('richViewer').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            e.target.classList.remove('active');
        }
    });
}

// ==================== 拖拽上传 ====================
function initDragDrop() {
    const dropZone = document.getElementById('dropZone');
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });
    
    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.add('dragover');
        }, false);
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.remove('dragover');
        }, false);
    });
    
    dropZone.addEventListener('drop', async (e) => {
        const files = e.dataTransfer.files;
        for (const file of files) {
            await sendFile(file);
        }
    }, false);
}

// ==================== 进度显示 ====================
function showProgress(fileId, fileName, progress) {
    const container = document.getElementById('transferProgress');
    const list = document.getElementById('progressList');
    
    container.style.display = 'block';
    
    let item = document.getElementById(`progress-${fileId}`);
    if (!item) {
        item = document.createElement('div');
        item.id = `progress-${fileId}`;
        item.className = 'progress-item';
        item.innerHTML = `
            <div class="progress-info">
                <span>${fileName}</span>
                <span class="progress-text">${progress}%</span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${progress}%"></div>
            </div>
        `;
        list.appendChild(item);
    }
}

function updateProgress(fileId, progress) {
    const item = document.getElementById(`progress-${fileId}`);
    if (item) {
        item.querySelector('.progress-text').textContent = `${progress}%`;
        item.querySelector('.progress-fill').style.width = `${progress}%`;
    }
}

function hideProgress(fileId) {
    const item = document.getElementById(`progress-${fileId}`);
    if (item) {
        item.remove();
    }
    
    const list = document.getElementById('progressList');
    if (list.children.length === 0) {
        document.getElementById('transferProgress').style.display = 'none';
    }
}

// ==================== 模态框 ====================
let confirmCallback = null;

function showConfirmModal(fileInfo, callback) {
    confirmCallback = callback;
    
    document.getElementById('confirmFileInfo').innerHTML = `
        <strong>${fileInfo.name}</strong><br>
        大小: ${formatFileSize(fileInfo.size)}<br>
        来自: 其他设备
    `;
    
    document.getElementById('confirmModal').classList.add('active');
}

document.getElementById('acceptFileBtn').addEventListener('click', () => {
    document.getElementById('confirmModal').classList.remove('active');
    if (confirmCallback) {
        confirmCallback(true);
        confirmCallback = null;
    }
});

document.getElementById('rejectFileBtn').addEventListener('click', () => {
    document.getElementById('confirmModal').classList.remove('active');
    if (confirmCallback) {
        confirmCallback(false);
        confirmCallback = null;
    }
});

// ==================== 富文本查看 ====================
async function viewRichContent(messageId) {
    const message = await getFromStore('messages', messageId);
    if (message && message.type === 'rich') {
        document.getElementById('richViewerContent').innerHTML = message.content;
        document.getElementById('richViewer').classList.add('active');
    }
}

// 暴露到全局
window.viewRichContent = viewRichContent;

// ==================== 文件下载 ====================
async function downloadFile(fileId) {
    const file = await getFromStore('files', fileId);
    if (!file) {
        alert('文件不存在');
        return;
    }
    
    const blob = new Blob([file.data], { type: file.type });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    URL.revokeObjectURL(url);
}

// 暴露到全局
window.downloadFile = downloadFile;

// ==================== 会话数据加载 ====================
async function loadSessionData() {
    // 加载历史消息
    const messages = await getAllFromStore('messages', 'sessionId', IDBKeyRange.only(state.sessionId));
    messages.sort((a, b) => a.timestamp - b.timestamp);
    
    messages.forEach(msg => {
        const isOwn = msg.sender === state.deviceId;
        addMessageToChat(msg, isOwn);
    });
    
    // 更新会话活动时间
    await saveToStore('sessions', {
        sessionId: state.sessionId,
        lastActive: Date.now(),
        deviceId: state.deviceId
    });
}

// ==================== 工具函数 ====================
function fileToBase64(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(file);
    });
}

function fileToArrayBuffer(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsArrayBuffer(file);
    });
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getFileIcon(mimeType) {
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('video/')) return '🎬';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.includes('pdf')) return '📄';
    if (mimeType.includes('zip') || mimeType.includes('rar')) return '📦';
    if (mimeType.includes('doc')) return '📝';
    if (mimeType.includes('xls')) return '📊';
    if (mimeType.includes('ppt')) return '📽️';
    return '📎';
}
