/**
 * 即时传输隧道 - 主应用
 * 功能：P2P文件传输、协同编辑、本地存储
 */

// ==================== 配置 ====================
function getRuntimeConfig() {
    return window.TUNNEL_CONFIG || {};
}

function buildSocketServerUrl() {
    const runtimeConfig = getRuntimeConfig();

    if (runtimeConfig.SOCKET_SERVER) {
        return runtimeConfig.SOCKET_SERVER;
    }

    return window.location.origin;
}

const CONFIG = {
    // Socket.io 服务器地址 (自动检测)
    // 开发环境: 使用当前页面地址
    // 生产环境: 可配置为固定地址
    SOCKET_SERVER: buildSocketServerUrl(),
    
    // 备用服务器地址 (当自动检测失败时使用)
    // 例如: 'http://10.8.0.16:3000'
    FALLBACK_SERVER: null,
    // 小文件大小阈值。Base64 和消息元数据也会占用 Socket.IO 的 1MB 上限。
    SMALL_FILE_THRESHOLD: 512 * 1024,
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
    pendingIceCandidates: new Map(), // deviceId -> RTCIceCandidate[]
    devices: new Map(), // deviceId -> deviceInfo
    messages: [],
    pendingFiles: new Map(), // fileId -> fileInfo
    editorContent: '',
    isSyncing: false,
    debugLogQueue: [],
    debugLogReady: false,
    db: null // IndexedDB实例
};

const HISTORY_DEBUG = getRuntimeConfig().HISTORY_DEBUG !== false;
const MAX_CLIENT_DEBUG_LOGS = 1000;
const MAX_EDITOR_CONTENT_SIZE = 512 * 1024;
const MAX_EDITOR_ASSET_SIZE = 20 * 1024 * 1024;
const EDITOR_ASSET_CHUNK_SIZE = 64 * 1024;
const EDITOR_ASSET_BUFFER_LIMIT = 512 * 1024;
const EDITOR_ASSET_P2P_TIMEOUT = 1500;
const EDITOR_ASSET_P2P_COOLDOWN = 5 * 60 * 1000;
const editorAssetUrls = new Map();
const editorAssetRequests = new Map();
const editorAssetTransfers = new Map();
const editorAssetRetryCounts = new Map();
const editorAssetP2PUnavailablePeers = new Map();
const editorAssetCacheVersions = new Map();
let fileAssetTransfer = null;
let mediaController = null;
const fileObjectUrls = new Map();
const pendingHistoryMessageIds = new Set();
let sessionHistoryQueue = Promise.resolve();

window.addEventListener('beforeunload', () => {
    editorAssetUrls.forEach(url => URL.revokeObjectURL(url));
    fileObjectUrls.forEach(url => URL.revokeObjectURL(url));
});

function summarizeHistoryMessage(message) {
    const fileInfo = message && message.fileInfo;
    return {
        id: message && message.id,
        type: message && message.type,
        sender: message && message.sender,
        timestamp: message && message.timestamp,
        file: fileInfo ? {
            id: fileInfo.id,
            name: fileInfo.name,
            size: fileInfo.size,
            isSmall: fileInfo.isSmall,
            hasInlineData: Boolean(fileInfo.data)
        } : undefined
    };
}

function historyLog(event, details = {}) {
    if (!HISTORY_DEBUG) return;

    const entry = {
        event,
        details,
        clientTimestamp: new Date().toISOString()
    };

    console.log(`[debug][client][${event}]`, {
        sessionId: state.sessionId,
        deviceId: state.deviceId,
        clientTimestamp: entry.clientTimestamp,
        ...details
    });

    if (!sendClientDebugLog(entry)) {
        state.debugLogQueue.push(entry);
        if (state.debugLogQueue.length > MAX_CLIENT_DEBUG_LOGS) {
            state.debugLogQueue.splice(0, state.debugLogQueue.length - MAX_CLIENT_DEBUG_LOGS);
        }
    }
}

function sendClientDebugLog(entry) {
    if (!state.socket || !state.socket.connected || !state.debugLogReady) {
        return false;
    }

    state.socket.emit('debug-log', {
        sessionId: state.sessionId,
        deviceId: state.deviceId,
        event: entry.event,
        details: entry.details,
        clientTimestamp: entry.clientTimestamp
    });
    return true;
}

function flushClientDebugLogs() {
    const queuedLogs = state.debugLogQueue.splice(0);
    for (let index = 0; index < queuedLogs.length; index++) {
        if (!sendClientDebugLog(queuedLogs[index])) {
            state.debugLogQueue.unshift(...queuedLogs.slice(index));
            return;
        }
    }
}

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', async () => {
    await initStorage();
    initSession();
    initFileAssetTransfer();
    initMediaController();
    initUI();
    initEditor();
    initDragDrop();
    await loadSessionData();
    initSocket();
});

// ==================== 存储管理 (IndexedDB + 内存备用) ====================

// 内存存储备用方案 (当 IndexedDB 不可用时)
const memoryStorage = new Map();

function createMemoryDB() {
    console.log('Creating memory storage fallback');
    return {
        _isMemory: true,
        objectStoreNames: {
            contains: (name) => ['sessions', 'messages', 'files'].includes(name)
        }
    };
}

async function initStorage() {
    return new Promise((resolve, reject) => {
        // 检查 IndexedDB 支持
        if (!window.indexedDB) {
            console.warn('IndexedDB not supported, falling back to memory storage');
            // 创建一个内存中的模拟对象
            state.db = createMemoryDB();
            resolve();
            return;
        }

        console.log('Opening IndexedDB...');
        // 增加数据库版本号以强制升级，确保所有对象存储都存在
        const request = indexedDB.open('TunnelDB', 2); // 从1升级到2

        request.onerror = (event) => {
            console.error('IndexedDB open error:', event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = (event) => {
            state.db = event.target.result;
            console.log('IndexedDB opened successfully, version:', state.db.version);
            
            // 检查是否所有必需的对象存储都存在
            const requiredStores = ['sessions', 'messages', 'files', 'editorContent'];
            const existingStores = Array.from(state.db.objectStoreNames);
            
            let missingStores = [];
            requiredStores.forEach(store => {
                if (!existingStores.includes(store)) {
                    missingStores.push(store);
                }
            });
            
            if (missingStores.length > 0) {
                console.log('Found missing stores, recreating database...');
                // 如果有任何必需的存储缺失，删除数据库并重新创建
                state.db.close();
                indexedDB.deleteDatabase('TunnelDB');
                
                // 重新打开数据库
                const recreateRequest = indexedDB.open('TunnelDB', 2);
                
                recreateRequest.onerror = (e) => reject(e.target.error);
                recreateRequest.onsuccess = (e) => {
                    state.db = e.target.result;
                    console.log('IndexedDB recreated with all stores');
                    resolve();
                };
                recreateRequest.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    createRequiredStores(db);
                };
            } else {
                resolve();
            }
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            createRequiredStores(db);
        };
    });
}

// 辅助函数：创建所有必需的对象存储
function createRequiredStores(db) {
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
    
    // 编辑器内容存储
    if (!db.objectStoreNames.contains('editorContent')) {
        const editorStore = db.createObjectStore('editorContent', { keyPath: 'id' });
        editorStore.createIndex('sessionId', 'sessionId', { unique: false });
    }
}

async function saveToStore(storeName, data) {
    // 如果使用内存存储
    if (state.db._isMemory) {
        if (!memoryStorage.has(storeName)) {
            memoryStorage.set(storeName, new Map());
        }
        const key = data.id || data.sessionId || Date.now();
        memoryStorage.get(storeName).set(key, data);
        return;
    }

    return new Promise((resolve, reject) => {
        try {
            const transaction = state.db.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);
            store.put(data);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error(`IndexedDB ${storeName} write aborted`));
        } catch (err) {
            console.error('saveToStore error:', err);
            reject(err);
        }
    });
}

async function getFromStore(storeName, key) {
    // 如果使用内存存储
    if (state.db._isMemory) {
        const store = memoryStorage.get(storeName);
        return store ? store.get(key) : undefined;
    }

    return new Promise((resolve, reject) => {
        try {
            const transaction = state.db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        } catch (err) {
            console.error('getFromStore error:', err);
            reject(err);
        }
    });
}

async function getAllFromStore(storeName, indexName, keyRange) {
    // 如果使用内存存储
    if (state.db._isMemory) {
        const store = memoryStorage.get(storeName);
        if (!store) return [];

        let results = Array.from(store.values());

        // 简单的过滤 (模拟索引)
        if (keyRange && keyRange.lower === state.sessionId) {
            results = results.filter(item => item.sessionId === state.sessionId);
        }

        return results;
    }

    return new Promise((resolve, reject) => {
        try {
            const transaction = state.db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const source = indexName ? store.index(indexName) : store;
            const request = keyRange ? source.getAll(keyRange) : source.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        } catch (err) {
            console.error('getAllFromStore error:', err);
            reject(err);
        }
    });
}

async function deleteFromStore(storeName, key) {
    // 如果使用内存存储
    if (state.db._isMemory) {
        const store = memoryStorage.get(storeName);
        if (store) store.delete(key);
        return;
    }

    return new Promise((resolve, reject) => {
        try {
            const transaction = state.db.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        } catch (err) {
            console.error('deleteFromStore error:', err);
            reject(err);
        }
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
        state.debugLogReady = false;
        console.log('Socket connected');
        historyLog('socket-connected', {
            socketId: state.socket.id,
            socketServer: CONFIG.SOCKET_SERVER
        });
        historyLog('join-emitted', {
            socketId: state.socket.id,
            deviceName: state.deviceName
        });
        state.socket.emit('join-session', {
            sessionId: state.sessionId,
            deviceId: state.deviceId,
            deviceName: state.deviceName
        });
        state.debugLogReady = true;
        flushClientDebugLogs();
        announceStoredEditorAssets();
        announceStoredFileAssets();
        hydrateEditorAssets(document.getElementById('editor'));
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
        historyLog('realtime-message-event', {
            message: summarizeHistoryMessage(data && data.message)
        });
        handleMessage(data);
    });

    state.socket.on('message-deleted', (data) => {
        if (data?.messageId) {
            deleteHistoryMessageLocal(data.messageId).catch(err => {
                historyLog('message-delete-sync-failed', { messageId: data.messageId, error: err.message });
            });
        }
    });

    state.socket.on('session-history', (data) => {
        const messages = data && Array.isArray(data.messages) ? data.messages : [];
        historyLog('snapshot-received', {
            messageCount: messages.length,
            messages: messages.map(summarizeHistoryMessage)
        });
        sessionHistoryQueue = sessionHistoryQueue
            .then(() => handleSessionHistory(data))
            .catch(err => historyLog('snapshot-processing-failed', { error: err.message }));
    });

    state.socket.on('editor-sync', (data) => {
        handleEditorSync(data);
    });

    state.socket.on('editor-state', (data) => {
        handleEditorState(data);
    });

    state.socket.on('editor-asset-request', (data) => {
        handleEditorAssetRequest(data);
    });

    state.socket.on('editor-asset-available', (data) => {
        handleEditorAssetAvailable(data);
    });

    state.socket.on('editor-asset-provider', (data) => {
        handleEditorAssetProvider(data);
    });

    state.socket.on('editor-asset-unavailable', (data) => {
        handleEditorAssetUnavailable(data);
    });

    state.socket.on('editor-asset-relay-start', (data) => {
        handleEditorAssetRelayStart(data);
    });

    state.socket.on('editor-asset-relay-chunk', (data) => {
        handleEditorAssetRelayChunk(data);
    });

    state.socket.on('editor-asset-relay-complete', (data) => {
        handleEditorAssetRelayComplete(data);
    });

    state.socket.on('file-asset-request', (data) => fileAssetTransfer?.handleRequest(data));
    state.socket.on('file-asset-available', (data) => fileAssetTransfer?.handleAvailable(data));
    state.socket.on('file-asset-unavailable', (data) => fileAssetTransfer?.handleUnavailable(data));
    state.socket.on('file-asset-relay-start', (data) => fileAssetTransfer?.handleRelayStart(data));
    state.socket.on('file-asset-relay-chunk', (data) => fileAssetTransfer?.handleRelayChunk(data));
    state.socket.on('file-asset-relay-complete', (data) => fileAssetTransfer?.handleRelayComplete(data));

    state.socket.on('camera-broadcast-start', (data) => mediaController?.handleCameraBroadcastStart(data));
    state.socket.on('camera-broadcast-stop', (data) => mediaController?.handleCameraBroadcastStop(data));
    state.socket.on('camera-viewer-ready', (data) => mediaController?.handleCameraViewerReady(data));
    state.socket.on('voice-state', (data) => mediaController?.handleVoiceState(data));
    state.socket.on('voice-peer-joined', (data) => mediaController?.handleVoicePeerJoined(data));
    state.socket.on('voice-peer-left', (data) => mediaController?.handleVoicePeerLeft(data));
    state.socket.on('media-signal', (data) => mediaController?.handleSignal(data).catch(err => historyLog('media-signal-failed', { error: err.message })));
    state.socket.on('intercom-stop', (data) => mediaController?.handleIntercomStop(data));

    state.socket.on('error', (data) => {
        const message = data && data.message ? data.message : '服务器返回错误';
        console.error('Socket error:', data);
        historyLog('socket-error-received', { code: data && data.code, message });

        if (data && typeof data.code === 'string' && data.code.startsWith('EDITOR_')) {
            document.getElementById('collabStatus').textContent = message;
        }
    });

    state.socket.on('file-offer', (data) => {
        handleFileOffer(data);
    });

    state.socket.on('file-answer', (data) => {
        handleFileAnswer(data);
    });

    state.socket.on('disconnect', () => {
        state.debugLogReady = false;
        console.log('Socket disconnected');
        historyLog('socket-disconnected');
    });
}

// ==================== WebRTC P2P ====================
async function createPeerConnection(deviceId) {
    const config = {
        iceServers: [
            // Google STUN servers
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            // Other public STUN servers
            { urls: 'stun:stun.cloudflare.com:3478' },
            { urls: 'stun:stun.stunprotocol.org:3478' }
        ],
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        // Enable DTLS for secure connections
        rtcpMuxPolicy: 'require',
        iceCandidatePoolSize: 10 // Pre-generate candidates
    };
    
    const pc = new RTCPeerConnection(config);

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('Sending ICE candidate to', deviceId);
            state.socket.emit('signal', {
                to: deviceId,
                from: state.deviceId,
                type: 'ice-candidate',
                candidate: event.candidate
            });
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log('ICE connection state for', deviceId, ':', pc.iceConnectionState);
        historyLog('p2p-ice-state', {
            peerDeviceId: deviceId,
            iceConnectionState: pc.iceConnectionState
        });
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            console.log('P2P connection established with', deviceId);
        } else if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            console.warn('P2P connection failed/disconnected with', deviceId);
            if (pc.iceConnectionState === 'failed') {
                editorAssetP2PUnavailablePeers.set(deviceId, Date.now() + EDITOR_ASSET_P2P_COOLDOWN);
            }
            // Attempt to restart ICE
            if (pc.iceConnectionState === 'failed') {
                console.log('Attempting ICE restart...');
                try {
                    pc.restartIce();
                } catch (e) {
                    console.error('Failed to restart ICE:', e);
                }
            }
        }
    };

    pc.onconnectionstatechange = () => {
        console.log('Connection state for', deviceId, ':', pc.connectionState);
        historyLog('p2p-connection-state', {
            peerDeviceId: deviceId,
            connectionState: pc.connectionState
        });
        if (pc.connectionState === 'failed') {
            console.warn('Connection failed, attempting to reconnect...');
            editorAssetP2PUnavailablePeers.set(deviceId, Date.now() + EDITOR_ASSET_P2P_COOLDOWN);
            // Remove the failed connection so it can be recreated
            state.peers.delete(deviceId);
        }
    };

    pc.ondatachannel = (event) => {
        const channel = event.channel;
        console.log('Received data channel from', deviceId);
        if (fileAssetTransfer?.handleIncomingChannel(deviceId, channel)) return;
        setupDataChannel(deviceId, channel);
    };

    state.peers.set(deviceId, pc);
    return pc;
}

async function connectToPeer(deviceId) {
    console.log('Connecting to peer:', deviceId);
    
    // 检查是否已有连接
    if (state.peers.has(deviceId)) {
        const existingPC = state.peers.get(deviceId);
        
        // 检查连接状态
        if (existingPC.connectionState === 'connected' || existingPC.iceConnectionState === 'connected' || existingPC.iceConnectionState === 'completed') {
            console.log('Already connected to', deviceId);
            return existingPC;
        }
        
        // 如果连接失败，关闭旧连接
        if (existingPC.connectionState === 'failed' || existingPC.iceConnectionState === 'failed' || existingPC.iceConnectionState === 'disconnected') {
            console.log('Existing connection in failed state, closing it');
            existingPC.close();
            state.peers.delete(deviceId);
        } else {
            // 如果连接正在进行中，等待其完成
            console.log('Connection already in progress with', deviceId);
            return existingPC;
        }
    }

    const pc = await createPeerConnection(deviceId);

    if (!shouldInitiatePeerConnection(deviceId)) {
        console.log('Waiting for peer to initiate connection:', deviceId);
        return pc;
    }

    // 创建数据通道
    const channel = pc.createDataChannel('fileTransfer', {
        ordered: true,
        maxRetransmits: 0  // 使用可靠传输
    });
    setupDataChannel(deviceId, channel);

    // 创建offer
    const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
        iceRestart: false
    });
    
    await pc.setLocalDescription(offer);
    console.log('Set local description, sending offer to', deviceId);

    state.socket.emit('signal', {
        to: deviceId,
        from: state.deviceId,
        type: 'offer',
        sdp: offer
    });
    
    return pc;
}

function shouldInitiatePeerConnection(deviceId) {
    return state.deviceId.localeCompare(deviceId) < 0;
}

function queueIceCandidate(deviceId, candidate) {
    if (!state.pendingIceCandidates.has(deviceId)) {
        state.pendingIceCandidates.set(deviceId, []);
    }

    state.pendingIceCandidates.get(deviceId).push(candidate);
    historyLog('p2p-ice-queued', {
        peerDeviceId: deviceId,
        pendingCandidateCount: state.pendingIceCandidates.get(deviceId).length
    });
}

async function flushPendingIceCandidates(deviceId, pc) {
    const candidates = state.pendingIceCandidates.get(deviceId) || [];
    state.pendingIceCandidates.delete(deviceId);

    historyLog('p2p-ice-flushing', {
        peerDeviceId: deviceId,
        candidateCount: candidates.length
    });

    for (const candidate of candidates) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
}

async function handleSignal(data) {
    const { from, type, sdp, candidate } = data;

    historyLog('p2p-signal-received', {
        peerDeviceId: from,
        signalType: type,
        hasSdp: Boolean(sdp),
        hasCandidate: Boolean(candidate)
    });

    let pc = state.peers.get(from);
    if (!pc) {
        pc = await createPeerConnection(from);
    }

    try {
        if (type === 'offer') {
            if (pc.signalingState === 'have-local-offer') {
                if (shouldInitiatePeerConnection(from)) {
                    console.warn('Ignoring competing offer from', from);
                    historyLog('p2p-offer-ignored', {
                        peerDeviceId: from,
                        reason: 'local-device-is-designated-initiator'
                    });
                    return;
                }

                await pc.setLocalDescription({ type: 'rollback' });
            }
            
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            await flushPendingIceCandidates(from, pc);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            state.socket.emit('signal', {
                to: from,
                from: state.deviceId,
                type: 'answer',
                sdp: answer
            });
        } else if (type === 'answer') {
            // 检查连接状态
            if (pc.signalingState === 'stable') {
                console.warn('Connection already stable, ignoring answer');
                return;
            }
            
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            await flushPendingIceCandidates(from, pc);
        } else if (type === 'ice-candidate') {
            if (pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } else {
                queueIceCandidate(from, candidate);
            }
        }
    } catch (err) {
        console.error('Signal handling error:', err);
        historyLog('p2p-signal-failed', {
            peerDeviceId: from,
            signalType: type,
            error: err.message
        });
    }
}

function setupDataChannel(deviceId, channel) {
    if (channel.label && channel.label.startsWith('editor-asset:')) {
        const assetId = channel.label.slice('editor-asset:'.length);
        setupEditorAssetDataChannel(deviceId, assetId, channel);
        return;
    }
    if (fileAssetTransfer?.handleIncomingChannel(deviceId, channel)) return;

    state.dataChannels.set(deviceId, channel);

    channel.onopen = () => {
        console.log('Data channel opened with', deviceId);
        editorAssetP2PUnavailablePeers.delete(deviceId);
        historyLog('p2p-data-channel-opened', { peerDeviceId: deviceId });
    };

    channel.onmessage = (event) => {
        handleDataChannelMessage(deviceId, event.data);
    };

    channel.onclose = () => {
        console.log('Data channel closed with', deviceId);
        historyLog('p2p-data-channel-closed', { peerDeviceId: deviceId });
        state.dataChannels.delete(deviceId);
    };
}

// ==================== Editor image assets ====================
function getEditorAssetMetadata(asset) {
    return {
        id: asset.id,
        name: asset.name,
        type: asset.type,
        size: asset.size,
        ownerDeviceId: asset.ownerDeviceId
    };
}

function createEditorAssetHtml(asset) {
    return `<img data-tunnel-asset-id="${asset.id}" data-tunnel-asset-owner="${asset.ownerDeviceId}" data-tunnel-asset-name="${escapeHtml(asset.name)}" data-tunnel-asset-type="${escapeHtml(asset.type)}" data-tunnel-asset-size="${asset.size}" alt="${escapeHtml(asset.name)}" style="max-width: 100%; border-radius: 8px;">`;
}

function getEditorAssetTransportLabel(transport) {
    return transport === 'p2p' ? 'P2P 直连' : 'Socket.IO 中继';
}

function getEditorAssetPlaceholder(image) {
    const assetId = image.dataset.tunnelAssetId;
    let placeholder = image.nextElementSibling;
    if (!placeholder || placeholder.dataset.tunnelAssetPlaceholder !== assetId) {
        placeholder = document.createElement('span');
        placeholder.dataset.tunnelAssetPlaceholder = assetId;
        placeholder.contentEditable = 'false';
        placeholder.setAttribute('role', 'status');
        placeholder.style.cssText = 'display: inline-flex; align-items: center; max-width: 100%; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 6px; color: #475569; background: #f8fafc; font-size: 13px; line-height: 1.4;';
        image.insertAdjacentElement('afterend', placeholder);
    }
    return placeholder;
}

function setEditorAssetStatus(assetId, message, state = 'loading') {
    document.querySelectorAll(`img[data-tunnel-asset-id="${assetId}"]`).forEach(image => {
        image.removeAttribute('src');
        if (!image.hasAttribute('data-tunnel-asset-display')) {
            image.dataset.tunnelAssetDisplay = image.style.display || '';
        }
        image.style.display = 'none';
        image.dataset.tunnelAssetState = state;
        image.alt = message;
        image.title = message;
        getEditorAssetPlaceholder(image).textContent = message;
    });
}

function setEditorAssetReady(image) {
    // Older clients could record their own temporary "none" as the original display.
    image.style.display = image.dataset.tunnelAssetDisplay === 'none' ? '' : (image.dataset.tunnelAssetDisplay || '');
    delete image.dataset.tunnelAssetDisplay;
    delete image.dataset.tunnelAssetState;
    image.removeAttribute('title');
    image.alt = image.dataset.tunnelAssetName || '';

    const placeholder = image.nextElementSibling;
    if (placeholder && placeholder.dataset.tunnelAssetPlaceholder === image.dataset.tunnelAssetId) {
        placeholder.remove();
    }
}

function getEditorAssetRenderTarget(image) {
    if (image.closest('#editor')) return 'editor';
    if (image.closest('#richViewerContent')) return 'rich-viewer';
    return image.isConnected ? 'other' : 'detached';
}

function getEditorAssetIdsFromContent(content) {
    return Array.from(String(content || '').matchAll(/data-tunnel-asset-id="([^"]+)"/g), match => match[1]);
}

function renderEditorAssetImage(image, assetId, url) {
    let rendered = false;
    const finishRendering = () => {
        if (rendered) return;
        rendered = true;
        image.onload = null;
        image.onerror = null;
        setEditorAssetReady(image);
        historyLog('editor-asset-rendered', {
            assetId,
            target: getEditorAssetRenderTarget(image),
            connected: image.isConnected,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight
        });
    };

    image.onload = finishRendering;
    image.onerror = () => {
        image.onload = null;
        image.onerror = null;
        historyLog('editor-asset-render-failed', {
            assetId,
            target: getEditorAssetRenderTarget(image),
            connected: image.isConnected
        });
        setEditorAssetStatus(assetId, '图片暂时不可用（本地渲染失败）', 'unavailable');
    };
    image.src = url;

    if (image.complete && image.naturalWidth > 0) {
        finishRendering();
    }
}

function serializeEditorContent(content) {
    const container = document.createElement('div');
    container.innerHTML = content;
    container.querySelectorAll('[data-tunnel-asset-placeholder]').forEach(placeholder => placeholder.remove());
    container.querySelectorAll('img[data-tunnel-asset-id]').forEach(image => {
        image.removeAttribute('src');
        image.removeAttribute('data-tunnel-asset-state');
        image.removeAttribute('data-tunnel-asset-display');
        image.style.removeProperty('display');
        image.removeAttribute('title');
        image.alt = image.dataset.tunnelAssetName || '';
    });
    return container.innerHTML;
}

async function createEditorAsset(name, type, data) {
    const size = data.byteLength;
    if (!type.startsWith('image/')) {
        throw new Error('Only image files can be inserted into the editor');
    }
    if (size <= 0 || size > MAX_EDITOR_ASSET_SIZE) {
        throw new Error('Image exceeds the editor asset size limit');
    }

    const asset = {
        id: generateId(),
        name,
        type,
        size,
        ownerDeviceId: state.deviceId,
        isEditorAsset: true,
        sessionId: state.sessionId,
        data,
        timestamp: Date.now()
    };
    await saveToStore('files', asset);
    announceEditorAsset(asset);
    historyLog('editor-asset-created', { asset: getEditorAssetMetadata(asset) });
    return asset;
}

async function createEditorAssetFromFile(file) {
    return createEditorAsset(file.name, file.type, await fileToArrayBuffer(file));
}

async function createEditorAssetFromStoredFile(file) {
    return createEditorAsset(file.name, file.type, file.data.slice(0));
}

function announceEditorAsset(asset) {
    if (!state.socket || !state.socket.connected) return;
    state.socket.emit('editor-asset-available', {
        sessionId: state.sessionId,
        asset: getEditorAssetMetadata(asset)
    });
    historyLog('editor-asset-announced', { asset: getEditorAssetMetadata(asset) });
}

async function announceStoredEditorAssets() {
    try {
        let files = [];
        if (typeof IDBKeyRange !== 'undefined') {
            files = await getAllFromStore('files', 'sessionId', IDBKeyRange.only(state.sessionId));
        } else {
            files = (await getAllFromStore('files')).filter(file => file.sessionId === state.sessionId);
        }
        files.filter(file => file.isEditorAsset && file.data).forEach(announceEditorAsset);
    } catch (err) {
        console.error('Failed to announce editor assets:', err);
        historyLog('editor-asset-announce-failed', { error: err.message });
    }
}

function setEditorAssetUnavailable(assetId, reason) {
    const message = reason === 'no-online-provider'
        ? '图片暂时不可用（来源设备不在线）'
        : '图片暂时不可用（传输失败）';
    setEditorAssetStatus(assetId, message, 'unavailable');
}

async function hydrateEditorAssetImage(image) {
    const assetId = image.dataset.tunnelAssetId;
    if (!assetId) return;

    const cacheVersion = editorAssetCacheVersions.get(assetId) || 0;
    const asset = await getFromStore('files', assetId);
    if (cacheVersion !== (editorAssetCacheVersions.get(assetId) || 0)) {
        historyLog('editor-asset-hydration-stale', {
            assetId,
            target: getEditorAssetRenderTarget(image)
        });
        return hydrateEditorAssetImage(image);
    }

    if (asset && asset.data) {
        historyLog('editor-asset-cache-hit', {
            assetId,
            storedSessionId: asset.sessionId,
            size: asset.data.byteLength || asset.size
        });
        let url = editorAssetUrls.get(assetId);
        if (!url) {
            url = URL.createObjectURL(new Blob([asset.data], { type: asset.type }));
            editorAssetUrls.set(assetId, url);
        }
        renderEditorAssetImage(image, assetId, url);
        return;
    }

    historyLog('editor-asset-cache-miss', { assetId });
    setEditorAssetStatus(assetId, '正在获取图片（正在选择传输链路）');
    requestEditorAsset(assetId, image.dataset.tunnelAssetOwner);
}

async function hydrateEditorAssets(container) {
    if (!container) return;
    const images = Array.from(container.querySelectorAll('img[data-tunnel-asset-id]'));
    historyLog('editor-asset-hydration-started', {
        target: container.id || container.className || 'other',
        assetIds: images.map(image => image.dataset.tunnelAssetId)
    });
    await Promise.all(images.map(hydrateEditorAssetImage));
}

function requestEditorAsset(assetId, preferredProviderId) {
    if (!state.socket || !state.socket.connected || editorAssetRequests.has(assetId)) return;

    setEditorAssetStatus(assetId, '正在获取图片（正在寻找来源设备）');
    editorAssetRequests.set(assetId, Date.now());
    state.socket.emit('editor-asset-request', {
        sessionId: state.sessionId,
        assetId,
        preferredProviderId
    });
    historyLog('editor-asset-requested', { assetId, preferredProviderId });

    setTimeout(() => {
        if (editorAssetRequests.has(assetId)) {
            editorAssetRequests.delete(assetId);
        }
    }, 30000);
}

function setupEditorAssetDataChannel(deviceId, assetId, channel) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
        historyLog('editor-asset-channel-opened', { assetId, peerDeviceId: deviceId });
    };
    channel.onmessage = event => {
        handleEditorAssetDataChannelMessage(deviceId, assetId, event.data, channel).catch(err => {
            console.error('Editor asset channel message failed:', err);
            editorAssetTransfers.delete(assetId);
            historyLog('editor-asset-receive-failed', { assetId, peerDeviceId: deviceId, error: err.message });
            channel.close();
        });
    };
    channel.onclose = () => {
        historyLog('editor-asset-channel-closed', { assetId, peerDeviceId: deviceId });
    };
    channel.onerror = () => {
        historyLog('editor-asset-channel-failed', { assetId, peerDeviceId: deviceId });
    };
}

function waitForEditorAssetChannel(channel, timeout = 20000) {
    if (channel.readyState === 'open') return Promise.resolve(true);
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), timeout);
        channel.addEventListener('open', () => {
            clearTimeout(timer);
            resolve(true);
        }, { once: true });
        channel.addEventListener('close', () => {
            clearTimeout(timer);
            resolve(false);
        }, { once: true });
    });
}

async function waitForEditorAssetBuffer(channel) {
    if (channel.bufferedAmount <= EDITOR_ASSET_BUFFER_LIMIT) return;
    await new Promise(resolve => {
        const timer = setTimeout(resolve, 1000);
        channel.bufferedAmountLowThreshold = EDITOR_ASSET_BUFFER_LIMIT / 2;
        channel.addEventListener('bufferedamountlow', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

async function sendEditorAssetViaDataChannel(channel, asset) {
    const metadata = getEditorAssetMetadata(asset);
    channel.send(JSON.stringify({ type: 'editor-asset-start', asset: metadata }));

    for (let offset = 0; offset < asset.data.byteLength; offset += EDITOR_ASSET_CHUNK_SIZE) {
        if (channel.readyState !== 'open') throw new Error('Editor asset channel closed');
        await waitForEditorAssetBuffer(channel);
        channel.send(asset.data.slice(offset, Math.min(offset + EDITOR_ASSET_CHUNK_SIZE, asset.data.byteLength)));
    }

    channel.send(JSON.stringify({ type: 'editor-asset-complete', assetId: asset.id }));
    historyLog('editor-asset-sent', { asset: metadata });
}

async function sendEditorAssetViaSocketRelay(deviceId, asset) {
    const metadata = getEditorAssetMetadata(asset);
    state.socket.emit('editor-asset-relay-start', {
        sessionId: state.sessionId,
        to: deviceId,
        asset: metadata
    });

    for (let offset = 0; offset < asset.data.byteLength; offset += EDITOR_ASSET_CHUNK_SIZE) {
        state.socket.emit('editor-asset-relay-chunk', {
            sessionId: state.sessionId,
            to: deviceId,
            assetId: asset.id,
            chunk: asset.data.slice(offset, Math.min(offset + EDITOR_ASSET_CHUNK_SIZE, asset.data.byteLength))
        });
        await new Promise(resolve => setTimeout(resolve, 1));
    }

    state.socket.emit('editor-asset-relay-complete', {
        sessionId: state.sessionId,
        to: deviceId,
        assetId: asset.id
    });
    historyLog('editor-asset-relayed', { asset: metadata, peerDeviceId: deviceId });
}

async function handleEditorAssetRequest(data) {
    const { asset, from } = data || {};
    if (!asset || !asset.id || !from) return;

    const storedAsset = await getFromStore('files', asset.id);
    if (!storedAsset || !storedAsset.data) {
        state.socket.emit('editor-asset-unavailable', {
            sessionId: state.sessionId,
            assetId: asset.id,
            to: from,
            reason: 'provider-missing-local-data'
        });
        return;
    }

    try {
        const unavailableUntil = editorAssetP2PUnavailablePeers.get(from);
        if (unavailableUntil && unavailableUntil > Date.now()) {
            throw new Error('Peer is in editor asset P2P cooldown');
        }
        await connectToPeer(from);
        if (!await waitForDataChannel(from, EDITOR_ASSET_P2P_TIMEOUT)) {
            throw new Error('Peer connection timed out');
        }

        const peer = state.peers.get(from);
        if (!peer || peer.connectionState !== 'connected') {
            throw new Error('Peer connection is not ready');
        }

        const channel = peer.createDataChannel(`editor-asset:${asset.id}`, { ordered: true });
        setupEditorAssetDataChannel(from, asset.id, channel);
        if (!await waitForEditorAssetChannel(channel)) {
            throw new Error('Editor asset channel timed out');
        }

        await sendEditorAssetViaDataChannel(channel, storedAsset);
    } catch (err) {
        console.error('Failed to provide editor asset:', err);
        historyLog('editor-asset-send-failed', { assetId: asset.id, peerDeviceId: from, error: err.message });
        try {
            await sendEditorAssetViaSocketRelay(from, storedAsset);
        } catch (relayError) {
            console.error('Failed to relay editor asset:', relayError);
            state.socket.emit('editor-asset-unavailable', {
                sessionId: state.sessionId,
                assetId: asset.id,
                to: from,
                reason: 'asset-transfer-failed'
            });
        }
    }
}

function beginEditorAssetTransfer(assetId, asset, deviceId, transport) {
    if (!asset || asset.id !== assetId || typeof asset.type !== 'string' ||
        !asset.type.startsWith('image/') || typeof asset.size !== 'number' ||
        asset.size <= 0 || asset.size > MAX_EDITOR_ASSET_SIZE) {
        throw new Error('Invalid editor asset metadata');
    }

    editorAssetTransfers.set(assetId, {
        asset,
        chunks: [],
        receivedSize: 0,
        from: deviceId,
        transport,
        pendingChunks: Promise.resolve()
    });
    setEditorAssetStatus(assetId, `正在获取图片（${getEditorAssetTransportLabel(transport)}，0%）`, 'transferring');
    historyLog('editor-asset-receiving', { asset, peerDeviceId: deviceId, transport });
}

async function appendEditorAssetChunk(assetId, data) {
    const transfer = editorAssetTransfers.get(assetId);
    if (!transfer) return;

    let chunk = data instanceof Blob ? await data.arrayBuffer() : data;
    if (ArrayBuffer.isView(chunk)) {
        chunk = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    }
    if (!(chunk instanceof ArrayBuffer)) {
        throw new Error('Invalid editor asset chunk');
    }

    transfer.chunks.push(chunk);
    transfer.receivedSize += chunk.byteLength;
    if (transfer.receivedSize > transfer.asset.size) {
        editorAssetTransfers.delete(assetId);
        throw new Error('Editor asset exceeded advertised size');
    }

    const progress = Math.min(99, Math.floor((transfer.receivedSize / transfer.asset.size) * 100));
    setEditorAssetStatus(
        assetId,
        `正在获取图片（${getEditorAssetTransportLabel(transfer.transport)}，${progress}%）`,
        'transferring'
    );
}

function queueEditorAssetChunk(assetId, data) {
    const transfer = editorAssetTransfers.get(assetId);
    if (!transfer) return Promise.resolve();

    transfer.pendingChunks = transfer.pendingChunks.then(() => appendEditorAssetChunk(assetId, data));
    return transfer.pendingChunks;
}

async function completeEditorAssetTransfer(assetId, deviceId, transport) {
    const transfer = editorAssetTransfers.get(assetId);
    if (!transfer || transfer.from !== deviceId) {
        throw new Error('Editor asset size mismatch');
    }
    await transfer.pendingChunks;
    if (editorAssetTransfers.get(assetId) !== transfer || transfer.receivedSize !== transfer.asset.size) {
        throw new Error('Editor asset size mismatch');
    }

    setEditorAssetStatus(assetId, `正在获取图片（${getEditorAssetTransportLabel(transport)}，100%）`, 'transferring');

    const combined = new Uint8Array(transfer.receivedSize);
    let offset = 0;
    transfer.chunks.forEach(chunk => {
        combined.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
    });
    const storedAsset = {
        ...transfer.asset,
        isEditorAsset: true,
        sessionId: state.sessionId,
        data: combined.buffer,
        timestamp: Date.now()
    };
    await saveToStore('files', storedAsset);
    const cachedAsset = await getFromStore('files', assetId);
    if (!cachedAsset || !cachedAsset.data || cachedAsset.data.byteLength !== storedAsset.data.byteLength) {
        throw new Error('Editor asset was not persisted to IndexedDB');
    }
    historyLog('editor-asset-cache-verified', {
        assetId,
        size: cachedAsset.data.byteLength,
        sessionId: cachedAsset.sessionId
    });
    editorAssetCacheVersions.set(assetId, (editorAssetCacheVersions.get(assetId) || 0) + 1);
    editorAssetTransfers.delete(assetId);
    editorAssetRequests.delete(assetId);
    editorAssetRetryCounts.delete(assetId);
    announceEditorAsset(storedAsset);
    await hydrateEditorAssets(document.getElementById('editor'));
    await hydrateEditorAssets(document.getElementById('richViewerContent'));
    historyLog('editor-asset-post-hydration', {
        assetId,
        editorAssetIds: getEditorAssetIdsFromContent(document.getElementById('editor')?.innerHTML),
        richViewerAssetIds: getEditorAssetIdsFromContent(document.getElementById('richViewerContent')?.innerHTML)
    });
    historyLog('editor-asset-received', {
        asset: getEditorAssetMetadata(storedAsset),
        peerDeviceId: deviceId,
        transport
    });
}

async function handleEditorAssetDataChannelMessage(deviceId, assetId, data, channel) {
    if (typeof data === 'string') {
        let message;
        try {
            message = JSON.parse(data);
        } catch (err) {
            channel.close();
            return;
        }
        if (message.type === 'editor-asset-start') {
            try {
                beginEditorAssetTransfer(assetId, message.asset, deviceId, 'p2p');
            } catch (err) {
                channel.close();
            }
            return;
        }

        if (message.type === 'editor-asset-complete' && message.assetId === assetId) {
            await completeEditorAssetTransfer(assetId, deviceId, 'p2p');
            channel.close();
        }
        return;
    }

    try {
        await queueEditorAssetChunk(assetId, data);
    } catch (err) {
        channel.close();
        throw err;
    }
}

function handleEditorAssetRelayStart(data) {
    const { asset, from } = data || {};
    if (!asset || !asset.id || !from) return;
    try {
        beginEditorAssetTransfer(asset.id, asset, from, 'socket-relay');
    } catch (err) {
        historyLog('editor-asset-relay-rejected', { assetId: asset.id, error: err.message });
    }
}

function handleEditorAssetRelayChunk(data) {
    const { assetId, chunk } = data || {};
    if (!assetId || !chunk) return;
    queueEditorAssetChunk(assetId, chunk).catch(err => {
        editorAssetTransfers.delete(assetId);
        historyLog('editor-asset-relay-failed', { assetId, error: err.message });
    });
}

function handleEditorAssetRelayComplete(data) {
    const { assetId, from } = data || {};
    if (!assetId || !from) return;
    completeEditorAssetTransfer(assetId, from, 'socket-relay').catch(err => {
        editorAssetTransfers.delete(assetId);
        historyLog('editor-asset-relay-failed', { assetId, error: err.message });
    });
}

function handleEditorAssetUnavailable(data) {
    const { assetId, reason } = data || {};
    if (!assetId) return;
    editorAssetRequests.delete(assetId);
    setEditorAssetUnavailable(assetId, reason);
    historyLog('editor-asset-unavailable', { assetId, reason });

    const retryCount = editorAssetRetryCounts.get(assetId) || 0;
    if (reason === 'p2p-transfer-failed' && retryCount < 2) {
        editorAssetRetryCounts.set(assetId, retryCount + 1);
        setTimeout(() => {
            const image = document.querySelector(`img[data-tunnel-asset-id="${assetId}"]`);
            requestEditorAsset(assetId, image && image.dataset.tunnelAssetOwner);
        }, 2000);
    }
}

function handleEditorAssetAvailable(data) {
    const asset = data && data.asset;
    if (!asset || !asset.id) return;

    document.querySelectorAll(`img[data-tunnel-asset-id="${asset.id}"]`).forEach(image => {
        hydrateEditorAssetImage(image);
    });
}

function handleEditorAssetProvider(data) {
    const { assetId, providerDeviceId } = data || {};
    if (!assetId || !providerDeviceId) return;

    const unavailableUntil = editorAssetP2PUnavailablePeers.get(providerDeviceId);
    const status = unavailableUntil && unavailableUntil > Date.now()
        ? '正在获取图片（Socket.IO 中继，P2P 直连暂不可用）'
        : '正在获取图片（P2P 直连，正在建立连接）';
    setEditorAssetStatus(assetId, status);
    historyLog('editor-asset-provider-selected', { assetId, providerDeviceId });
    connectToPeer(providerDeviceId).catch(err => {
        historyLog('editor-asset-peer-connect-failed', { assetId, providerDeviceId, error: err.message });
    });
}

// ==================== 文件传输 ====================
const fileTransfers = new Map(); // fileId -> transferInfo

function initFileAssetTransfer() {
    if (!window.FileAssetTransfer) {
        throw new Error('File asset transfer module failed to load');
    }

    fileAssetTransfer = new window.FileAssetTransfer({
        getSocket: () => state.socket,
        getSessionId: () => state.sessionId,
        getPeer: deviceId => state.peers.get(deviceId),
        connectPeer: connectToPeer,
        waitForDataChannel,
        load: fileId => getFromStore('files', fileId),
        store: file => saveToStore('files', file),
        log: historyLog,
        onProgress: (fileId, fileName, progress) => {
            showProgress(fileId, fileName, progress);
            if (progress >= 100) setTimeout(() => hideProgress(fileId), 800);
        },
        onReceived: async (asset) => {
            await refreshFileMessage(asset.id);
        },
        onUnavailable: (fileId, reason) => {
            updateFileMessageAvailability(fileId, reason);
        }
    });
}

function initMediaController() {
    if (!window.MediaController) {
        throw new Error('Media module failed to load');
    }

    mediaController = new window.MediaController({
        getSocket: () => state.socket,
        getSessionId: () => state.sessionId,
        getDeviceId: () => state.deviceId,
        log: historyLog,
        onLocalCamera: (stream, active) => showCameraStream(stream, active, true),
        onRemoteCamera: stream => showCameraStream(stream, Boolean(stream), false),
        onRemoteAudio: (kind, sessionKey, peerId, stream) => playRemoteAudio(kind, sessionKey, peerId, stream),
        onVoiceState: active => updateMediaButtons({ voice: active }),
        onIntercomState: active => updateMediaButtons({ intercom: active })
    });
}

function showCameraStream(stream, active, isLocal) {
    const stage = document.getElementById('cameraStage');
    const video = document.getElementById('cameraVideo');
    video.srcObject = stream || null;
    video.muted = Boolean(isLocal);
    stage.style.display = active ? 'block' : 'none';
    updateMediaButtons({ camera: active });
}

function playRemoteAudio(kind, sessionKey, peerId, stream) {
    const container = document.getElementById('remoteAudio');
    const id = `remote-audio-${kind}-${sessionKey}-${peerId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    let audio = document.getElementById(id);
    if (!audio) {
        audio = document.createElement('audio');
        audio.id = id;
        audio.autoplay = true;
        audio.playsInline = true;
        container.appendChild(audio);
    }
    audio.srcObject = stream;
    audio.play().catch(() => {});
}

function updateMediaButtons(stateUpdate = {}) {
    const camera = document.getElementById('cameraBroadcastBtn');
    const voice = document.getElementById('voiceChatBtn');
    const intercom = document.getElementById('globalIntercomBtn');
    if (camera && Object.hasOwn(stateUpdate, 'camera')) {
        camera.textContent = stateUpdate.camera ? '关闭摄像头' : '摄像头';
    }
    if (voice && Object.hasOwn(stateUpdate, 'voice')) {
        voice.textContent = stateUpdate.voice ? '退出语音' : '语音聊天';
    }
    if (intercom && Object.hasOwn(stateUpdate, 'intercom')) {
        intercom.textContent = stateUpdate.intercom ? '关闭对讲机' : '全局对讲';
    }
}

async function announceStoredFileAssets() {
    if (!fileAssetTransfer) return;
    try {
        const files = typeof IDBKeyRange !== 'undefined'
            ? await getAllFromStore('files', 'sessionId', IDBKeyRange.only(state.sessionId))
            : (await getAllFromStore('files')).filter(file => file.sessionId === state.sessionId);
        for (const file of files) {
            const isCachedChatAsset = file.data && (file.isFileAsset || (!file.isEditorAsset && file.ownerDeviceId));
            if (!isCachedChatAsset) continue;
            if (!file.isFileAsset) {
                file.isFileAsset = true;
                await saveToStore('files', file);
                historyLog('file-asset-cache-migrated', { fileId: file.id });
            }
            await fileAssetTransfer.announce(file);
        }
    } catch (err) {
        historyLog('file-asset-announce-failed', { error: err.message });
    }
}

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

    const data = await fileToArrayBuffer(file);
    const asset = {
        ...fileInfo,
        sessionId: state.sessionId,
        ownerDeviceId: state.deviceId,
        isFileAsset: true,
        data
    };
    await saveToStore('files', asset);
    await fileAssetTransfer.announce(asset);

    const message = {
        id: generateId(),
        type: 'file',
        fileInfo: {
            ...fileInfo,
            ownerDeviceId: state.deviceId,
            isAsset: true
        },
        timestamp: Date.now(),
        sender: state.deviceId,
        senderName: state.deviceName
    };

    await saveToStore('messages', { ...message, sessionId: state.sessionId });
    await addMessageToChat(message, true);
    pendingHistoryMessageIds.add(message.id);
    state.socket.emit('message', { sessionId: state.sessionId, message });
    historyLog('file-asset-message-emitted', {
        message: summarizeHistoryMessage(message),
        targetDeviceId
    });

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
    console.log('Received file offer from', from, 'file:', fileInfo.name);

    // 显示确认对话框
    showConfirmModal(fileInfo, async (accepted) => {
        console.log('File offer response:', accepted ? 'accepted' : 'rejected');

        if (accepted) {
            console.log('Connecting to peer for file transfer...');
            
            // 先建立P2P连接
            await connectToPeer(from);
            
            // 等待DataChannel就绪
            const ready = await waitForDataChannel(from, 15000);
            
            if (ready) {
                // 准备接收文件
                fileTransfers.set(fileInfo.id, {
                    chunks: [],
                    receivedSize: 0,
                    fileInfo,
                    from,
                    status: 'receiving'
                });

                showProgress(fileInfo.id, fileInfo.name, 0);
            } else {
                console.error('Data channel not ready after timeout');
                alert('连接超时，无法接收文件');
                state.socket.emit('file-answer', {
                    sessionId: state.sessionId,
                    to: from,
                    from: state.deviceId,
                    fileId: fileInfo.id,
                    accepted: false
                });
                return;
            }
        }

        // 发送响应
        state.socket.emit('file-answer', {
            sessionId: state.sessionId,
            to: from,
            from: state.deviceId,
            fileId: fileInfo.id,
            accepted
        });

        if (!accepted) {
            console.log('File offer rejected');
        }
    });
}

// 等待DataChannel建立
async function waitForDataChannel(deviceId, timeout) {
    return new Promise((resolve) => {
        const checkInterval = 100;
        const maxAttempts = timeout / checkInterval;
        let attempts = 0;

        const check = () => {
            const channel = state.dataChannels.get(deviceId);
            if (channel && channel.readyState === 'open') {
                console.log('Data channel ready for', deviceId);
                resolve(true);
            } else {
                const peer = state.peers.get(deviceId);
                if (peer && (peer.connectionState === 'failed' || peer.connectionState === 'closed' ||
                    peer.iceConnectionState === 'failed' || peer.iceConnectionState === 'closed')) {
                    console.warn('Data channel unavailable because the peer connection failed:', deviceId);
                    resolve(false);
                    return;
                }
            }

            if (attempts >= maxAttempts) {
                console.warn('Data channel timeout for', deviceId);
                resolve(false);
            } else {
                attempts++;
                setTimeout(check, checkInterval);
            }
        };

        check();
    });
}

async function handleFileAnswer(data) {
    const { from, fileId, accepted } = data;
    console.log('Received file answer from', from, 'fileId:', fileId, 'accepted:', accepted);

    const transfer = fileTransfers.get(fileId);
    if (!transfer) {
        console.warn('No transfer found for fileId:', fileId);
        return;
    }

    if (accepted) {
        console.log('File accepted, waiting for P2P connection...');

        // 确保P2P连接已建立
        await connectToPeer(from);

        // 等待DataChannel就绪
        const ready = await waitForDataChannel(from, 20000);

        if (ready) {
            console.log('Starting file transfer via DataChannel');
            await sendFileViaDataChannel(from, transfer.file, transfer.fileInfo);
        } else {
            console.error('Data channel not ready, cannot send file');
            alert('连接超时，文件传输失败');
            hideProgress(fileId);
        }
    } else {
        fileTransfers.delete(fileId);
        alert(`对方拒绝了文件: ${transfer.fileInfo.name}`);
    }
}

async function sendFileViaDataChannel(deviceId, file, fileInfo) {
    const channel = state.dataChannels.get(deviceId);
    if (!channel || channel.readyState !== 'open') {
        console.error('Data channel not ready for device:', deviceId);
        console.log('Available channels:', Array.from(state.dataChannels.keys()));
        alert('数据传输通道未就绪');
        return;
    }

    console.log('Starting file transfer via DataChannel:', fileInfo.name, 'size:', fileInfo.size);

    try {
        // 发送文件元数据
        channel.send(JSON.stringify({
            type: 'file-start',
            fileId: fileInfo.id,
            fileInfo
        }));
        console.log('Sent file-start metadata');

        // 分块发送文件
        const buffer = await fileToArrayBuffer(file);
        const totalChunks = Math.ceil(buffer.byteLength / CONFIG.CHUNK_SIZE);

        console.log('File split into', totalChunks, 'chunks');
        showProgress(fileInfo.id, fileInfo.name, 0);

        for (let i = 0; i < totalChunks; i++) {
            const start = i * CONFIG.CHUNK_SIZE;
            const end = Math.min(start + CONFIG.CHUNK_SIZE, buffer.byteLength);
            const chunk = buffer.slice(start, end);

            // 检查channel状态
            if (channel.readyState !== 'open') {
                console.error('Data channel closed during transfer');
                alert('传输中断：数据通道已关闭');
                hideProgress(fileInfo.id);
                return;
            }

            channel.send(chunk);

            const progress = Math.round(((i + 1) / totalChunks) * 100);
            updateProgress(fileInfo.id, progress);

            // 避免阻塞，每发送一块稍微延迟
            await new Promise(r => setTimeout(r, 5));
        }

        // 发送完成标记
        channel.send(JSON.stringify({
            type: 'file-complete',
            fileId: fileInfo.id
        }));
        console.log('File transfer complete:', fileInfo.name);

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

        await addMessageToChat(message, true);

        // 保存消息
        await saveToStore('messages', {
            ...message,
            sessionId: state.sessionId
        });

        console.log('File message saved to chat');
        historyLog('p2p-file-message-stored-locally', {
            message: summarizeHistoryMessage(message),
            emittedToSocketHistory: false
        });
    } catch (err) {
        console.error('Error sending file:', err);
        alert('文件传输失败: ' + err.message);
        hideProgress(fileInfo.id);
    }
}

async function handleDataChannelMessage(deviceId, data) {
    if (typeof data === 'string') {
        try {
            const msg = JSON.parse(data);
            console.log('Received control message:', msg.type, 'fileId:', msg.fileId);

            if (msg.type === 'file-start') {
                // 初始化接收
                console.log('Starting file receive:', msg.fileInfo.name);
                const transfer = fileTransfers.get(msg.fileId);
                if (transfer) {
                    transfer.chunks = [];
                    transfer.receivedSize = 0;
                    transfer.totalSize = msg.fileInfo.size;
                    transfer.status = 'receiving';
                    showProgress(msg.fileId, msg.fileInfo.name, 0);
                } else {
                    // 如果没有transfer记录，创建一个
                    console.log('Creating new transfer record for file');
                    fileTransfers.set(msg.fileId, {
                        chunks: [],
                        receivedSize: 0,
                        totalSize: msg.fileInfo.size,
                        fileInfo: msg.fileInfo,
                        from: deviceId,
                        status: 'receiving'
                    });
                    showProgress(msg.fileId, msg.fileInfo.name, 0);
                }
            } else if (msg.type === 'file-complete') {
                // 文件接收完成
                console.log('File receive complete:', msg.fileId);
                const transfer = fileTransfers.get(msg.fileId);
                if (transfer) {
                    // 合并块
                    const totalSize = transfer.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
                    console.log('Merging', transfer.chunks.length, 'chunks, total size:', totalSize);

                    const combined = new Uint8Array(totalSize);
                    let offset = 0;

                    for (const chunk of transfer.chunks) {
                        combined.set(new Uint8Array(chunk), offset);
                        offset += chunk.byteLength;
                    }

                    // 保存文件
                    console.log('Saving received file to storage');
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

                    await addMessageToChat(message, false);
                    await saveToStore('messages', {
                        ...message,
                        sessionId: state.sessionId
                    });

                    hideProgress(msg.fileId);
                    fileTransfers.delete(msg.fileId);
                    console.log('File receive and save complete');
                    historyLog('p2p-file-message-stored-on-receiver', {
                        message: summarizeHistoryMessage(message),
                        emittedToSocketHistory: false
                    });
                } else {
                    console.warn('No transfer found for file-complete:', msg.fileId);
                }
            }
        } catch (err) {
            console.error('Error parsing control message:', err);
        }
    } else {
        // 接收文件块
        let found = false;
        for (const [fileId, transfer] of fileTransfers) {
            if (transfer.from === deviceId && transfer.status === 'receiving') {
                transfer.chunks.push(data);
                transfer.receivedSize += data.byteLength;

                const progress = Math.round((transfer.receivedSize / transfer.totalSize) * 100);
                updateProgress(fileId, progress);
                found = true;

                // 每10%打印一次日志
                if (progress % 10 === 0) {
                    console.log('Receiving file:', fileId, 'progress:', progress + '%');
                }
                break;
            }
        }

        if (!found) {
            console.warn('Received chunk but no matching transfer found for device:', deviceId);
            console.log('Active transfers:', Array.from(fileTransfers.keys()));
        }
    }
}

// ==================== 消息处理 ====================
async function storeInlineFileData(message, source) {
    if (message.type !== 'file' || !message.fileInfo?.isSmall || !message.fileInfo.data) {
        return false;
    }

    const base64Data = message.fileInfo.data.split(',')[1];
    if (!base64Data) {
        throw new Error('Invalid inline file data');
    }

    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    await saveToStore('files', {
        id: message.fileInfo.id,
        name: message.fileInfo.name,
        size: message.fileInfo.size,
        type: message.fileInfo.type,
        sessionId: state.sessionId,
        data: bytes.buffer,
        timestamp: message.timestamp
    });
    historyLog('inline-file-stored', {
        source,
        message: summarizeHistoryMessage(message)
    });
    return true;
}

async function handleMessage(data) {
    const { message } = data;

    if (message.sender === state.deviceId) {
        historyLog('realtime-message-skipped', {
            reason: 'own-message',
            message: summarizeHistoryMessage(message)
        });
        return;
    }

    historyLog('realtime-message-processing', {
        message: summarizeHistoryMessage(message)
    });

    // 如果是小文件消息，提取base64数据保存到files存储
    if (message.type === 'file' && message.fileInfo && message.fileInfo.isSmall && message.fileInfo.data) {
        try {
            await storeInlineFileData(message, 'realtime');
            console.log('Saved received file to IndexedDB:', message.fileInfo.id);
            historyLog('realtime-file-stored', {
                message: summarizeHistoryMessage(message)
            });
        } catch (err) {
            console.error('保存接收的文件失败:', err);
            historyLog('realtime-file-store-failed', {
                message: summarizeHistoryMessage(message),
                error: err.message
            });
        }
    }

    // 保存消息
    await saveToStore('messages', {
        ...message,
        sessionId: state.sessionId
    });
    historyLog('realtime-message-stored', {
        message: summarizeHistoryMessage(message)
    });

    await addMessageToChat(message, false);
    historyLog('realtime-message-rendered', {
        message: summarizeHistoryMessage(message)
    });

    if (message.type === 'file' && message.fileInfo?.isAsset) {
        const requestAsset = async () => {
            await fileAssetTransfer.request(
                message.fileInfo.id,
                message.fileInfo.ownerDeviceId || message.sender
            );
        };
        if (message.fileInfo.size <= CONFIG.SMALL_FILE_THRESHOLD) {
            await requestAsset();
        } else {
            showConfirmModal(message.fileInfo, async (accepted) => {
                if (accepted) await requestAsset();
            });
        }
    }
}

async function handleSessionHistory(data) {
    if (!data || !Array.isArray(data.messages)) {
        historyLog('snapshot-skipped', { reason: 'invalid-payload' });
        return;
    }

    const deletedMessageIds = Array.isArray(data.deletedMessageIds)
        ? data.deletedMessageIds.filter(id => typeof id === 'string')
        : [];
    for (const messageId of deletedMessageIds) {
        await deleteHistoryMessageLocal(messageId);
    }

    const messages = [...data.messages].sort((a, b) => a.timestamp - b.timestamp);
    let restored = 0;
    let duplicates = 0;
    let failed = 0;

    historyLog('snapshot-processing-started', {
        messageCount: messages.length
    });

    for (const message of messages) {
        if (!message || typeof message.id !== 'string') {
            failed++;
            historyLog('snapshot-message-skipped', {
                reason: 'missing-message-id',
                message: summarizeHistoryMessage(message)
            });
            continue;
        }

        try {
            const existing = await getFromStore('messages', message.id);
            if (existing) {
                duplicates++;
                historyLog('snapshot-message-skipped', {
                    reason: 'already-in-indexeddb',
                    message: summarizeHistoryMessage(message)
                });
                if (message.type === 'file' && message.fileInfo?.isAsset && message.sender !== state.deviceId) {
                    const storedFile = await getFromStore('files', message.fileInfo.id);
                    if (!storedFile?.data && (!storedFile?.cacheCleared || storedFile.restoreRequested)) {
                        await fileAssetTransfer.request(
                            message.fileInfo.id,
                            message.fileInfo.ownerDeviceId || message.sender
                        );
                        historyLog('snapshot-file-asset-backfill-requested', {
                            message: summarizeHistoryMessage(message)
                        });
                    }
                }
                continue;
            }

            if (message.type === 'file' && message.fileInfo?.isSmall && message.fileInfo.data) {
                await storeInlineFileData(message, 'snapshot');
                historyLog('snapshot-inline-file-stored', {
                    message: summarizeHistoryMessage(message)
                });
            }

            await saveToStore('messages', {
                ...message,
                sessionId: state.sessionId
            });
            historyLog('snapshot-message-stored', {
                message: summarizeHistoryMessage(message)
            });

            await addMessageToChat(message, message.sender === state.deviceId);
            historyLog('snapshot-message-rendered', {
                message: summarizeHistoryMessage(message)
            });
            if (message.type === 'file' && message.fileInfo?.isAsset && message.sender !== state.deviceId) {
                const storedFile = await getFromStore('files', message.fileInfo.id);
                if (!storedFile?.cacheCleared || storedFile.restoreRequested) {
                    await fileAssetTransfer.request(
                        message.fileInfo.id,
                        message.fileInfo.ownerDeviceId || message.sender
                    );
                }
            }
            restored++;
        } catch (err) {
            failed++;
            console.error('Failed to restore session history message:', err);
            historyLog('snapshot-message-failed', {
                message: summarizeHistoryMessage(message),
                error: err.message
            });
        }
    }

    const result = {
        receivedCount: messages.length,
        restoredCount: restored,
        duplicateCount: duplicates,
        failedCount: failed
    };
    historyLog('snapshot-processing-completed', result);

    if (data.authoritative) {
        await pruneLocalHistoryToCanonicalSnapshot(messages, deletedMessageIds);
    } else {
        await reconcileLocalHistory(messages, deletedMessageIds);
    }

    if (state.socket) {
        state.socket.emit('session-history-ack', {
            sessionId: state.sessionId,
            deviceId: state.deviceId,
            ...result
        });
        historyLog('snapshot-ack-emitted', result);
    }
}

async function getCurrentSessionMessages() {
    if (typeof IDBKeyRange !== 'undefined') {
        return getAllFromStore('messages', 'sessionId', IDBKeyRange.only(state.sessionId));
    }
    return (await getAllFromStore('messages')).filter(message => message.sessionId === state.sessionId);
}

function createHistoryReconcileMessage(message) {
    const copy = JSON.parse(JSON.stringify(message));
    if (copy.fileInfo) delete copy.fileInfo.data;
    return copy;
}

async function reconcileLocalHistory(serverMessages, deletedMessageIds) {
    if (!state.socket?.connected) return;
    const localMessages = await getCurrentSessionMessages();
    const messages = localMessages
        .filter(message => message?.id && !deletedIds.has(message.id))
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-100)
        .map(createHistoryReconcileMessage);

    state.socket.emit('history-reconcile', { sessionId: state.sessionId, messages });
    historyLog('history-reconcile-emitted', {
        localMessageCount: localMessages.length,
        serverMessageCount: serverMessages.length,
        submittedMessageCount: messages.length
    });
}

async function pruneLocalHistoryToCanonicalSnapshot(messages, deletedMessageIds) {
    const canonicalIds = new Set(messages.map(message => message?.id).filter(Boolean));
    const deletedIds = new Set(deletedMessageIds);
    const localMessages = await getCurrentSessionMessages();
    let removedCount = 0;

    for (const message of localMessages) {
        if (!message?.id || canonicalIds.has(message.id) || pendingHistoryMessageIds.has(message.id)) continue;
        await deleteHistoryMessageLocal(message.id);
        removedCount++;
    }
    messages.forEach(message => pendingHistoryMessageIds.delete(message?.id));
    historyLog('history-canonical-applied', {
        canonicalMessageCount: canonicalIds.size,
        removedCount
    });
}

async function addMessageToChat(message, isOwn) {
    const container = document.getElementById('chatMessages');

    // 移除空状态
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const messageEl = document.createElement('div');
    messageEl.className = `message ${isOwn ? 'own' : ''}`;
    messageEl.dataset.messageId = message.id;
    if (message.type === 'file' && message.fileInfo?.id) {
        messageEl.dataset.fileId = message.fileInfo.id;
        messageEl.dataset.fileName = message.fileInfo.name;
        messageEl.dataset.fileType = message.fileInfo.type;
        messageEl.dataset.fileSize = String(message.fileInfo.size || 0);
        messageEl.dataset.fileOwnerId = message.fileInfo.ownerDeviceId || message.sender || '';
        messageEl.dataset.fileIsAsset = String(Boolean(message.fileInfo.isAsset));
    }

    let contentHtml = '';
    let fileRenderState = null;

    if (message.type === 'text') {
        contentHtml = `<div class="message-bubble">${escapeHtml(message.text)}</div>`;
    } else if (message.type === 'file') {
        const fileInfo = message.fileInfo;
        console.log('Rendering file message:', fileInfo.id, fileInfo.name, 'isSmall:', fileInfo.isSmall);

        const isImage = fileInfo.type.startsWith('image/');
        const isVideo = fileInfo.type.startsWith('video/');
        const isAudio = fileInfo.type.startsWith('audio/');

        // 检查是否是本地已存储的文件（刷新后从IndexedDB加载）
        let fileUrl = fileInfo.data || null;
        let storedFile = null;

        if (fileInfo.id) {
            try {
                storedFile = await getFromStore('files', fileInfo.id);

                if (!fileUrl && storedFile?.data) {
                    fileUrl = fileObjectUrls.get(fileInfo.id);
                    if (!fileUrl) {
                        fileUrl = URL.createObjectURL(new Blob([storedFile.data], { type: storedFile.type }));
                        fileObjectUrls.set(fileInfo.id, fileUrl);
                    }
                }
            } catch (err) {
                console.error('Error loading file from IndexedDB:', err);
            }
        }

        if (isImage && fileUrl) {
            // 直接显示小图片或已存储的图片
            contentHtml = `
                <div class="message-bubble">
                    <div class="media-preview">
                        <img src="${fileUrl}" alt="${escapeHtml(fileInfo.name)}"
                             onclick="downloadFile('${fileInfo.id}')" style="cursor: pointer;">
                    </div>
                    <div class="file-size media-file-size">${formatFileSize(fileInfo.size)}</div>
                </div>
            `;
        } else if (isVideo && fileUrl) {
            contentHtml = `
                <div class="message-bubble">
                    <div class="media-preview">
                        <video controls src="${fileUrl}"></video>
                    </div>
                    <div class="file-size media-file-size">${formatFileSize(fileInfo.size)}</div>
                </div>
            `;
        } else if (isAudio && fileUrl) {
            contentHtml = `
                <div class="message-bubble">
                    <div class="media-preview">
                        <audio controls src="${fileUrl}"></audio>
                    </div>
                    <div class="file-size media-file-size">${formatFileSize(fileInfo.size)}</div>
                </div>
            `;
        } else {
            // 文件消息（大文件、无法预览的文件，或文件数据已丢失）
            const sizeStr = formatFileSize(fileInfo.size);
            const canDownload = fileInfo.id && Boolean(fileUrl);
            const clickHandler = canDownload ? `onclick="downloadFile('${fileInfo.id}')"` : '';
            const opacity = canDownload ? '' : 'opacity: 0.6;';

            const unavailableLabel = fileInfo.isAsset
                ? ' (等待接收)'
                : fileInfo.isP2P || !fileInfo.isSmall
                    ? ' (未同步到本机)'
                    : ' (文件数据不可用)';
            contentHtml = `
                <div class="message-bubble file-message" ${clickHandler} style="${opacity}">
                    <div class="file-icon">${getFileIcon(fileInfo.type)}</div>
                    <div class="file-info">
                        <div class="file-name">${fileInfo.name}</div>
                        <div class="file-size">${sizeStr}${!canDownload ? unavailableLabel : ''}</div>
                    </div>
                </div>
            `;
        }
        fileRenderState = {
            fileInfo,
            hasLocalData: Boolean(fileUrl),
            cacheCleared: Boolean(storedFile?.cacheCleared)
        };
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

    if (fileRenderState) {
        renderFileMessageActions(messageEl, fileRenderState.fileInfo, fileRenderState);
    }

    container.appendChild(messageEl);
    container.scrollTop = container.scrollHeight;
}

function getFileInfoFromMessageElement(messageEl) {
    return {
        id: messageEl.dataset.fileId,
        name: messageEl.dataset.fileName || '未知文件',
        type: messageEl.dataset.fileType || 'application/octet-stream',
        size: Number(messageEl.dataset.fileSize || 0),
        ownerDeviceId: messageEl.dataset.fileOwnerId || '',
        isAsset: messageEl.dataset.fileIsAsset === 'true'
    };
}

function createFileActionButton(label, title, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-action';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', handler);
    return button;
}

function renderFileMessageActions(messageEl, fileInfo, cacheState = {}) {
    messageEl.querySelector('.file-actions')?.remove();
    const actions = document.createElement('div');
    actions.className = 'file-actions';

    if (cacheState.hasLocalData) {
        actions.appendChild(createFileActionButton('清除缓存', '仅清理本设备保存的文件内容', () => {
            clearFileCache(messageEl.dataset.messageId);
        }));
    }
    if (cacheState.cacheCleared) {
        actions.appendChild(createFileActionButton('还原文件', '从当前在线设备重新获取文件内容', () => {
            restoreFileCache(messageEl.dataset.messageId);
        }));
    }
    actions.appendChild(createFileActionButton('删除', '从会话中删除此记录及所有设备的文件缓存', () => {
        deleteHistoryMessage(messageEl.dataset.messageId);
    }));
    messageEl.appendChild(actions);
}

function showFileMessagePlaceholder(fileId, label, cacheCleared = false) {
    document.querySelectorAll(`.message[data-file-id="${fileId}"]`).forEach(messageEl => {
        const fileInfo = getFileInfoFromMessageElement(messageEl);
        const bubble = messageEl.querySelector('.message-bubble');
        if (!bubble) return;
        bubble.className = 'message-bubble file-message';
        bubble.removeAttribute('onclick');
        bubble.style.opacity = '0.6';
        bubble.innerHTML = `
            <div class="file-icon">${getFileIcon(fileInfo.type)}</div>
            <div class="file-info">
                <div class="file-name">${escapeHtml(fileInfo.name)}</div>
                <div class="file-size">${formatFileSize(fileInfo.size)} (${label})</div>
            </div>
        `;
        renderFileMessageActions(messageEl, fileInfo, { hasLocalData: false, cacheCleared });
    });
}

async function refreshFileMessage(fileId) {
    const storedFile = await getFromStore('files', fileId);
    if (!storedFile?.data) return;

    let url = fileObjectUrls.get(fileId);
    if (!url) {
        url = URL.createObjectURL(new Blob([storedFile.data], { type: storedFile.type }));
        fileObjectUrls.set(fileId, url);
    }

    document.querySelectorAll(`.message[data-file-id="${fileId}"]`).forEach(messageEl => {
        const fileInfo = getFileInfoFromMessageElement(messageEl);
        const type = fileInfo.type || storedFile.type;
        const name = escapeHtml(fileInfo.name || storedFile.name);
        const bubble = messageEl.querySelector('.message-bubble');
        if (!bubble) return;

        if (type.startsWith('image/')) {
            bubble.innerHTML = `<div class="media-preview"><img src="${url}" alt="${name}" onclick="downloadFile('${fileId}')" style="cursor: pointer;"></div><div class="file-size media-file-size">${formatFileSize(storedFile.size)}</div>`;
            bubble.classList.remove('file-message');
            bubble.style.opacity = '';
        } else if (type.startsWith('video/')) {
            bubble.innerHTML = `<div class="media-preview"><video controls src="${url}"></video></div><div class="file-size media-file-size">${formatFileSize(storedFile.size)}</div>`;
            bubble.classList.remove('file-message');
            bubble.style.opacity = '';
        } else if (type.startsWith('audio/')) {
            bubble.innerHTML = `<div class="media-preview"><audio controls src="${url}"></audio></div><div class="file-size media-file-size">${formatFileSize(storedFile.size)}</div>`;
            bubble.classList.remove('file-message');
            bubble.style.opacity = '';
        } else {
            bubble.style.opacity = '';
            bubble.setAttribute('onclick', `downloadFile('${fileId}')`);
            const size = bubble.querySelector('.file-size');
            if (size) size.textContent = formatFileSize(storedFile.size);
        }
        renderFileMessageActions(messageEl, fileInfo, { hasLocalData: true, cacheCleared: false });
    });
}

function updateFileMessageAvailability(fileId, reason) {
    const label = reason === 'no-online-provider' ? '文件来源设备不在线' : '文件暂时不可用';
    document.querySelectorAll(`.message[data-file-id="${fileId}"]`).forEach(messageEl => {
        const size = messageEl.querySelector('.file-size');
        if (size) size.textContent = `${formatFileSize(Number(messageEl.dataset.fileSize || 0))} (${label})`;
    });
}

async function clearFileCache(messageId) {
    const message = await getFromStore('messages', messageId);
    const fileInfo = message?.fileInfo;
    if (!fileInfo?.id) return;

    fileAssetTransfer?.cancel(fileInfo.id);
    const storedFile = await getFromStore('files', fileInfo.id);
    const { data, ...metadata } = storedFile || {};
    await saveToStore('files', {
        ...metadata,
        id: fileInfo.id,
        name: fileInfo.name,
        type: fileInfo.type,
        size: fileInfo.size,
        sessionId: state.sessionId,
        ownerDeviceId: fileInfo.ownerDeviceId || message.sender,
        isFileAsset: Boolean(fileInfo.isAsset),
        cacheCleared: true,
        restoreRequested: false
    });

    if (Object.hasOwn(fileInfo, 'data')) {
        delete fileInfo.data;
        await saveToStore('messages', message);
    }
    const objectUrl = fileObjectUrls.get(fileInfo.id);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    fileObjectUrls.delete(fileInfo.id);
    showFileMessagePlaceholder(fileInfo.id, '本地缓存已清理', true);
    historyLog('file-cache-cleared', { messageId, fileId: fileInfo.id });
}

async function restoreFileCache(messageId) {
    const message = await getFromStore('messages', messageId);
    const fileInfo = message?.fileInfo;
    if (!fileInfo?.id || !fileInfo.isAsset) {
        alert('此历史文件没有可用的远程文件来源，无法还原。');
        return;
    }

    const storedFile = await getFromStore('files', fileInfo.id);
    await saveToStore('files', {
        ...(storedFile || {}),
        id: fileInfo.id,
        name: fileInfo.name,
        type: fileInfo.type,
        size: fileInfo.size,
        sessionId: state.sessionId,
        ownerDeviceId: fileInfo.ownerDeviceId || message.sender,
        isFileAsset: true,
        cacheCleared: true,
        restoreRequested: true
    });
    showFileMessagePlaceholder(fileInfo.id, '正在请求还原', true);
    await fileAssetTransfer.request(fileInfo.id, fileInfo.ownerDeviceId || message.sender);
    historyLog('file-cache-restore-requested', { messageId, fileId: fileInfo.id });
}

async function deleteHistoryMessage(messageId) {
    if (!state.socket?.connected) {
        alert('当前未连接到会话，无法同步删除记录。');
        return;
    }
    if (!confirm('删除会同步移除所有设备中的这条传输记录，并清理其文件缓存。此操作不可撤销，继续吗？')) return;
    await deleteHistoryMessageLocal(messageId);
    state.socket.emit('delete-message', { sessionId: state.sessionId, messageId });
}

async function deleteHistoryMessageLocal(messageId) {
    const message = await getFromStore('messages', messageId);
    if (message?.fileInfo?.id) {
        const fileId = message.fileInfo.id;
        fileAssetTransfer?.cancel(fileId);
        await deleteFromStore('files', fileId);
        const objectUrl = fileObjectUrls.get(fileId);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        fileObjectUrls.delete(fileId);
    }
    await deleteFromStore('messages', messageId);
    pendingHistoryMessageIds.delete(messageId);
    document.querySelector(`.message[data-message-id="${messageId}"]`)?.remove();
    historyLog('history-message-deleted-locally', { messageId, fileId: message?.fileInfo?.id });
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

    historyLog('local-message-stored', {
        message: summarizeHistoryMessage(message)
    });

    // 发送到其他设备
    historyLog('realtime-message-emitted', {
        message: summarizeHistoryMessage(message)
    });
    pendingHistoryMessageIds.add(message.id);
    state.socket.emit('message', {
        sessionId: state.sessionId,
        message
    });

    addMessageToChat(message, true);
    input.value = '';
}

// ==================== 协同编辑 ====================
function isEditorContentEmpty(content) {
    return !content || content
        .replace(/<br\s*\/?\s*>/gi, '')
        .replace(/&nbsp;/gi, '')
        .trim() === '';
}

async function persistEditorContent(content) {
    state.editorContent = content;
    await saveToStore('editorContent', {
        id: 'current',
        sessionId: state.sessionId,
        content,
        timestamp: Date.now()
    });
}

function getEditorContentSize(content) {
    return new TextEncoder().encode(content).length;
}

async function syncEditorContent(content) {
    content = serializeEditorContent(content);
    await persistEditorContent(content);

    const contentSize = getEditorContentSize(content);
    if (contentSize > MAX_EDITOR_CONTENT_SIZE) {
        historyLog('editor-sync-skipped', {
            reason: 'content-too-large',
            contentSize,
            maxContentSize: MAX_EDITOR_CONTENT_SIZE
        });
        return { emitted: false, contentSize, reason: 'content-too-large' };
    }

    if (!state.socket || !state.socket.connected) {
        historyLog('editor-sync-skipped', { reason: 'socket-not-connected', contentSize });
        return { emitted: false, contentSize, reason: 'socket-not-connected' };
    }

    state.socket.emit('editor-sync', {
        sessionId: state.sessionId,
        from: state.deviceId,
        content
    });
    historyLog('editor-sync-emitted', { contentSize });
    return { emitted: true, contentSize };
}

function initEditor() {
    const editor = document.getElementById('editor');
    let syncTimeout;

    const getEditorSelectionRange = () => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;

        const range = selection.getRangeAt(0);
        return editor.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
    };

    const insertEditorHtml = (html, savedRange = null) => {
        const range = savedRange || getEditorSelectionRange();
        if (!range) {
            editor.insertAdjacentHTML('beforeend', html);
            return;
        }

        const template = document.createElement('template');
        template.innerHTML = html;
        const lastNode = template.content.lastChild;

        range.deleteContents();
        range.insertNode(template.content);
        if (lastNode) {
            range.setStartAfter(lastNode);
            range.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        }
        editor.focus();
    };

    const getEditorDropRange = (event) => {
        let range = null;
        if (document.caretRangeFromPoint) {
            range = document.caretRangeFromPoint(event.clientX, event.clientY);
        } else if (document.caretPositionFromPoint) {
            const position = document.caretPositionFromPoint(event.clientX, event.clientY);
            if (position) {
                range = document.createRange();
                range.setStart(position.offsetNode, position.offset);
                range.collapse(true);
            }
        }
        return range && editor.contains(range.commonAncestorContainer) ? range : null;
    };

    const insertEditorImageFile = async (file, savedRange, reason) => {
        const asset = await createEditorAssetFromFile(file);
        insertEditorHtml(createEditorAssetHtml(asset), savedRange);
        await hydrateEditorAssets(editor);
        await syncEditorNow(reason);
    };

    const syncEditorNow = async (reason) => {
        clearTimeout(syncTimeout);
        state.isSyncing = true;
        document.getElementById('collabStatus').textContent = '编辑中...';

        const assetIds = Array.from(editor.querySelectorAll('img[data-tunnel-asset-id]'))
            .map(image => image.dataset.tunnelAssetId);
        historyLog('editor-sync-started', { reason, assetIds });
        const result = await syncEditorContent(editor.innerHTML);
        state.isSyncing = false;
        document.getElementById('collabStatus').textContent = result.emitted
            ? '已同步'
            : result.reason === 'content-too-large'
                ? '内容过大，未同步'
                : '等待连接后同步';
        return result;
    };

    const queueEditorSync = () => {
        clearTimeout(syncTimeout);
        syncTimeout = setTimeout(() => {
            syncEditorNow('input-debounced');
        }, 500);
    };

    // 工具栏按钮
    document.querySelectorAll('.toolbar-btn[data-cmd]').forEach(btn => {
        btn.addEventListener('click', () => {
            const cmd = btn.dataset.cmd;
            document.execCommand(cmd, false, null);
            editor.focus();
            queueEditorSync();
        });
    });

    // 插入图片
    document.getElementById('insertImageBtn').addEventListener('click', async () => {
        editor.focus();
        const savedRange = getEditorSelectionRange();
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (file) {
                try {
                    await insertEditorImageFile(file, savedRange, 'image-inserted');
                } catch (err) {
                    alert(`图片无法插入: ${err.message}`);
                    historyLog('editor-image-rejected', {
                        fileName: file.name,
                        fileSize: file.size,
                        error: err.message
                    });
                }
            }
        };
        input.click();
    });

    editor.addEventListener('dragover', (event) => {
        if (Array.from(event.dataTransfer?.files || []).some(file => file.type.startsWith('image/'))) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        }
    });

    editor.addEventListener('drop', async (event) => {
        const imageFile = Array.from(event.dataTransfer?.files || [])
            .find(file => file.type.startsWith('image/'));
        if (!imageFile) return;

        event.preventDefault();
        event.stopPropagation();
        const dropRange = getEditorDropRange(event);
        try {
            await insertEditorImageFile(imageFile, dropRange, 'image-dropped');
        } catch (err) {
            alert(`图片无法插入: ${err.message}`);
            historyLog('editor-image-drop-rejected', {
                fileName: imageFile.name,
                fileSize: imageFile.size,
                error: err.message
            });
        }
    });

    // 引用文件
    document.getElementById('insertFileBtn').addEventListener('click', async () => {
        editor.focus();
        const savedRange = getEditorSelectionRange();
        // 获取当前会话的所有文件 - 兼容性处理
        let files = [];
        
        if (typeof IDBKeyRange !== 'undefined') {
            // 现代浏览器
            files = await getAllFromStore('files', 'sessionId', IDBKeyRange.only(state.sessionId));
        } else {
            // 旧版浏览器回退
            const allFiles = await getAllFromStore('files');
            files = allFiles.filter(f => f.sessionId === state.sessionId);
        }

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
                    try {
                        const asset = await createEditorAssetFromStoredFile(file);
                        refHtml = createEditorAssetHtml(asset);
                    } catch (err) {
                        alert(`图片无法引用: ${err.message}`);
                        return;
                    }
                } else {
                    refHtml = `<span style="background: #667eea; color: white; padding: 5px 10px; border-radius: 5px; cursor: pointer;" onclick="downloadFile('${fileId}')">📎 ${file.name}</span>`;
                }

                if (getEditorContentSize(editor.innerHTML + refHtml) > MAX_EDITOR_CONTENT_SIZE) {
                    alert('引用的内容过大，无法同步到其他设备');
                    historyLog('editor-file-reference-rejected', {
                        reason: 'content-too-large',
                        fileId,
                        fileSize: file.size
                    });
                    return;
                }

                insertEditorHtml(refHtml, savedRange);
                await hydrateEditorAssets(editor);
                await syncEditorNow(file.type.startsWith('image/') ? 'image-reference-inserted' : 'file-reference-inserted');
            }

            dialog.remove();
        });
    });

    // 内容变化同步 + 本地持久化
    editor.addEventListener('input', queueEditorSync);

    // 发送富文本
    document.getElementById('sendRichBtn').addEventListener('click', async () => {
        const content = serializeEditorContent(editor.innerHTML);
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

        historyLog('local-message-stored', {
            message: summarizeHistoryMessage(message)
        });

        // 发送到其他设备
        historyLog('realtime-message-emitted', {
            message: summarizeHistoryMessage(message)
        });
        pendingHistoryMessageIds.add(message.id);
        state.socket.emit('message', {
            sessionId: state.sessionId,
            message
        });

        addMessageToChat(message, true);
        clearTimeout(syncTimeout);
        editor.innerHTML = '';
        await syncEditorContent('');
        document.getElementById('collabStatus').textContent = '已发送';
    });

    // 清空编辑器
    document.getElementById('clearEditorBtn').addEventListener('click', () => {
        editor.innerHTML = '';
        editor.focus();
        queueEditorSync();
    });
}

async function handleEditorSync(data) {
    const { from, content } = data;

    if (from === state.deviceId) return;

    console.log('Received editor sync from', from, 'content length:', content.length);
    const syncedAssetIds = Array.from(content.matchAll(/data-tunnel-asset-id="([^"]+)"/g), match => match[1]);
    historyLog('editor-sync-received', {
        from,
        contentSize: getEditorContentSize(content),
        assetIds: syncedAssetIds
    });
    
    const editor = document.getElementById('editor');
    
    // 避免不必要的更新
    const changed = serializeEditorContent(editor.innerHTML) !== content;
    if (changed) {
        editor.innerHTML = content;
    }

    await persistEditorContent(content);
    await hydrateEditorAssets(editor);
    if (changed) {
        document.getElementById('collabStatus').textContent = '已同步';
        console.log('Editor updated from sync');
    }
}

async function handleEditorState(data) {
    if (!data || typeof data !== 'object') return;

    const editor = document.getElementById('editor');
    if (!editor) return;

    historyLog('editor-state-received', {
        hasRemoteContent: Boolean(data.hasRemoteContent),
        contentSize: getEditorContentSize(data.content || ''),
        assetIds: getEditorAssetIdsFromContent(data.content)
    });

    if (data.hasRemoteContent && !isEditorContentEmpty(data.content)) {
        const changed = serializeEditorContent(editor.innerHTML) !== data.content;
        if (changed) {
            editor.innerHTML = data.content;
        }
        historyLog('editor-state-applied', {
            changed,
            editorAssetIds: getEditorAssetIdsFromContent(editor.innerHTML)
        });
        await persistEditorContent(data.content);
        await hydrateEditorAssets(editor);
        document.getElementById('collabStatus').textContent = '已同步';
        return;
    }

    // Other online devices are empty, so only a non-empty local draft is authoritative.
    // Never broadcast an empty draft during session initialization: a reconnecting
    // device must not erase an image another device just inserted.
    if (isEditorContentEmpty(editor.innerHTML)) {
        historyLog('editor-state-empty-local-draft-ignored');
        return;
    }

    const result = await syncEditorContent(editor.innerHTML);
    document.getElementById('collabStatus').textContent = result.emitted
        ? '已同步'
        : result.reason === 'content-too-large'
            ? '内容过大，未同步'
            : '等待连接后同步';
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
    state.pendingIceCandidates.delete(deviceId);
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
        const intercomButton = document.createElement('button');
        intercomButton.className = 'toolbar-btn';
        intercomButton.type = 'button';
        intercomButton.title = `与 ${device.name} 对讲`;
        intercomButton.textContent = '对讲机';
        intercomButton.addEventListener('click', async () => {
            try {
                if (mediaController.intercom) mediaController.stopIntercom();
                else await mediaController.startIntercom([device.id]);
            } catch (err) {
                alert(`无法启动对讲机: ${err.message}`);
                historyLog('intercom-start-failed', { peerDeviceId: device.id, error: err.message });
            }
        });
        el.appendChild(intercomButton);
        container.appendChild(el);
    });
}

// ==================== UI 初始化 ====================
function initUI() {
    document.getElementById('cameraBroadcastBtn').addEventListener('click', async () => {
        try {
            if (mediaController.camera) {
                mediaController.stopCamera();
                return;
            }
            if (mediaController.cameraBroadcast && !confirm('发起新的摄像头广播会中止其它正在进行的广播。是否继续？')) return;
            await mediaController.startCamera();
        } catch (err) {
            alert(`无法启动摄像头: ${err.message}`);
            historyLog('camera-start-failed', { error: err.message });
        }
    });

    document.getElementById('voiceChatBtn').addEventListener('click', async () => {
        try {
            if (mediaController.voice) mediaController.leaveVoice();
            else await mediaController.joinVoice();
        } catch (err) {
            alert(`无法加入语音聊天: ${err.message}`);
            historyLog('voice-join-failed', { error: err.message });
        }
    });

    document.getElementById('globalIntercomBtn').addEventListener('click', async () => {
        try {
            if (mediaController.intercom) {
                mediaController.stopIntercom();
            } else {
                await mediaController.startIntercom(Array.from(state.devices.keys()));
            }
        } catch (err) {
            alert(`无法启动对讲机: ${err.message}`);
            historyLog('intercom-start-failed', { error: err.message });
        }
    });

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
    } else {
        updateProgress(fileId, progress);
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
        const container = document.getElementById('richViewerContent');
        container.innerHTML = message.content;
        await hydrateEditorAssets(container);
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
    console.log('Loading session data for:', state.sessionId);

    try {
        // 加载历史消息 - 兼容性处理
        let messages = [];

        if (typeof IDBKeyRange !== 'undefined') {
            // 现代浏览器
            messages = await getAllFromStore('messages', 'sessionId', IDBKeyRange.only(state.sessionId));
        } else {
            // 旧版浏览器回退
            console.log('IDBKeyRange not available, using fallback');
            const allMessages = await getAllFromStore('messages');
            messages = allMessages.filter(msg => msg.sessionId === state.sessionId);
        }

        console.log('Loaded messages:', messages.length);
        messages.sort((a, b) => a.timestamp - b.timestamp);
        historyLog('indexeddb-history-loaded', {
            messageCount: messages.length,
            messages: messages.map(summarizeHistoryMessage)
        });

        // 使用 for...of 确保按顺序异步处理
        for (const msg of messages) {
            try {
                const isOwn = msg.sender === state.deviceId;
                await addMessageToChat(msg, isOwn);
            } catch (err) {
                console.error('Failed to render stored message:', msg && msg.id, err);
                historyLog('indexeddb-history-message-render-failed', {
                    message: summarizeHistoryMessage(msg),
                    error: err.message
                });
            }
        }
        historyLog('indexeddb-history-rendered', {
            messageCount: messages.length
        });

        // 加载协同编辑内容
        console.log('Loading editor content...');
        const editorContent = await getFromStore('editorContent', 'current');
        if (editorContent && editorContent.sessionId === state.sessionId && editorContent.content) {
            console.log('Restoring editor content');
            const editor = document.getElementById('editor');
            if (editor && editorContent.content.trim() && editorContent.content !== '<br>') {
                editor.innerHTML = editorContent.content;
                state.editorContent = editorContent.content;
                await hydrateEditorAssets(editor);
            }
        }

        // 更新会话活动时间
        await saveToStore('sessions', {
            sessionId: state.sessionId,
            lastActive: Date.now(),
            deviceId: state.deviceId
        });
    } catch (err) {
        console.error('Error loading session data:', err);
    }
}

// ==================== 工具函数 ====================
function fileToBase64(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(file);
    });
}

function blobToBase64(blob) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
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
