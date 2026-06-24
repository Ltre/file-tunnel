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
    deviceModel: null,
    reportedLanIp: null,
    selfNetworkInfo: null,
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
    shortCode: '',
    remoteClipboardText: '',
    clipboardShareEnabled: false,
    recentSessionId: null,
    pendingSharedFileCount: 0,
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
let currentMobileWorkspaceView = 'chat';
let richViewerHistoryOpen = false;
const RICH_VIEWER_HISTORY_KEY = 'tunnelRichViewer';
const fileObjectUrls = new Map();
const pendingHistoryMessageIds = new Set();
let sessionHistoryQueue = Promise.resolve();
let clipboardShareTimer = null;
let lastClipboardText = null;
let sharedFileImportInProgress = false;
const completedFileProgress = new Set();
const activeFileProgress = new Set();
const progressHideTimers = new Map();
const directoryMirror = {
    handle: null,
    timer: null,
    signature: '',
    skipSignature: '',
    busy: false
};

window.addEventListener('beforeunload', () => {
    editorAssetUrls.forEach(url => URL.revokeObjectURL(url));
    fileObjectUrls.forEach(url => URL.revokeObjectURL(url));
});

function getFileProgressKey(fileId, transport = '') {
    const route = String(transport || '');
    if (!route.startsWith('sending')) return fileId;
    return `${fileId}::${route.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function progressElementId(progressKey) {
    return `progress-${String(progressKey).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function getFileProgressStatus(transport = '') {
    const route = String(transport || '');
    if (route.startsWith('sending-multi-source-relay')) return 'multi-source Socket.IO relay';
    if (route.startsWith('receiving-multi-source') || route.startsWith('sending-multi-source')) return 'multi-source P2P';
    if (route.startsWith('sending-relay') || route.startsWith('receiving-relay')) return 'Socket.IO relay';
    if (route.startsWith('sending') || route.startsWith('receiving') || route === 'p2p') return 'P2P';
    return '';
}

function getBinaryDataSize(data) {
    if (!data) return 0;
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
    return 0;
}

function hasCompleteFileCache(storedFile, fileInfo = null) {
    const size = getBinaryDataSize(storedFile?.data);
    if (size <= 0) return false;
    const expectedSize = Number(fileInfo?.size ?? storedFile?.size);
    return !Number.isFinite(expectedSize) || expectedSize <= 0 || size === expectedSize;
}

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
    registerServiceWorker();
    if (!await initSession()) {
        initSessionLanding();
        return;
    }
    await startTunnelApplication();
});

async function startTunnelApplication() {
    document.getElementById('appShell').hidden = false;
    document.getElementById('leaveTunnelBtn').hidden = false;
    document.getElementById('mobileForceRefreshBtn').hidden = false;
    initFileAssetTransfer();
    initMediaController();
    initUI();
    initEditor();
    initDragDrop();
    await loadSessionData();
    initSocket();
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' }).catch(err => {
        console.warn('Service worker registration failed:', err);
    });
}

// ==================== 存储管理 (IndexedDB + 内存备用) ====================

// 内存存储备用方案 (当 IndexedDB 不可用时)
const memoryStorage = new Map();

function createMemoryDB() {
    console.log('Creating memory storage fallback');
    return {
        _isMemory: true,
        objectStoreNames: {
            contains: (name) => ['sessions', 'messages', 'files', 'editorContent', 'shareQueue'].includes(name)
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
        const request = indexedDB.open('TunnelDB', 3);

        request.onerror = (event) => {
            console.error('IndexedDB open error:', event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = (event) => {
            state.db = event.target.result;
            console.log('IndexedDB opened successfully, version:', state.db.version);
            
            // 检查是否所有必需的对象存储都存在
            const requiredStores = ['sessions', 'messages', 'files', 'editorContent', 'shareQueue'];
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
                const recreateRequest = indexedDB.open('TunnelDB', 3);
                
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

    if (!db.objectStoreNames.contains('shareQueue')) {
        const shareStore = db.createObjectStore('shareQueue', { keyPath: 'id' });
        shareStore.createIndex('createdAt', 'createdAt', { unique: false });
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
async function initSession() {
    // 生成或获取设备ID
    state.deviceId = localStorage.getItem('deviceId') || generateId();
    localStorage.setItem('deviceId', state.deviceId);

    // 生成设备名称
    const deviceTypes = ['📱', '💻', '🖥️', '⌚', '📱'];
    const type = /Mobile|Android|iPhone|iPad/i.test(navigator.userAgent) ? 0 : 1;
    state.deviceName = `${deviceTypes[type]} 设备-${state.deviceId.slice(-4)}`;
    state.deviceModel = detectDeviceModel();

    // A shared hash always wins. A plain home page resumes the most recent local
    // session, unless it was opened as a PWA share target and needs a destination.
    const entryUrl = new URL(window.location.href);
    const hash = entryUrl.hash.slice(1);
    if (hash && /^[a-zA-Z0-9_-]{8,}$/.test(hash)) {
        state.sessionId = hash;
        const storedSession = await getFromStore('sessions', state.sessionId).catch(() => null);
        state.shortCode = normalizeLocalShortCode(storedSession?.shortCode);
        if (entryUrl.search) {
            history.replaceState(null, '', `${window.location.pathname}#${state.sessionId}`);
        }
    } else {
        const [storedSessions, sharedFiles] = await Promise.all([
            getAllFromStore('sessions'),
            getAllFromStore('shareQueue').catch(() => [])
        ]);
        const recent = storedSessions
            .filter(session => /^[a-zA-Z0-9_-]{8,64}$/.test(session.sessionId))
            .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))[0];
        state.recentSessionId = recent?.sessionId || null;
        state.pendingSharedFileCount = sharedFiles.length;

        if (entryUrl.searchParams.has('leave') || state.pendingSharedFileCount > 0 || !state.recentSessionId) return false;

        state.sessionId = state.recentSessionId;
        state.shortCode = normalizeLocalShortCode(recent.shortCode);
        history.replaceState(null, '', `${window.location.pathname}#${state.sessionId}`);
    }

    updateSessionIdentityUi();
    return true;
}

function normalizeLocalShortCode(value) {
    const shortCode = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return /^[A-Z0-9]{5}$/.test(shortCode) ? shortCode : '';
}

function updateSessionIdentityUi() {
    document.getElementById('sessionId').textContent = state.sessionId.slice(0, 8) + '...';
    document.getElementById('deviceId').textContent = state.deviceId.slice(0, 8) + '...';
    generateQRCode();
}

function initSessionLanding() {
    const landing = document.getElementById('sessionLanding');
    const note = document.getElementById('landingNote');
    const recentButton = document.getElementById('landingRecentBtn');
    const sharedFilesNotice = document.getElementById('sharedFilesNotice');
    const inputs = Array.from(document.querySelectorAll('#tunnelCodeInputs input'));
    landing.hidden = false;
    document.getElementById('leaveTunnelBtn').hidden = true;
    if (!window.location.hash && window.location.search) {
        history.replaceState(null, '', window.location.pathname);
    }

    if (state.pendingSharedFileCount > 0) {
        sharedFilesNotice.hidden = false;
        sharedFilesNotice.textContent = `已收到 ${state.pendingSharedFileCount} 个分享文件，请选择要发送到的传输隧道。`;
    }
    if (state.recentSessionId) {
        recentButton.hidden = false;
        recentButton.addEventListener('click', () => openSession(state.recentSessionId));
    }

    const fillCode = value => {
        const characters = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, inputs.length);
        characters.split('').forEach((character, index) => { inputs[index].value = character; });
        const focusIndex = Math.min(characters.length, inputs.length - 1);
        inputs[focusIndex].focus();
    };
    const join = async () => {
        const shortCode = inputs.map(input => input.value).join('').toUpperCase();
        if (!/^[A-Z0-9]{5}$/.test(shortCode)) {
            note.textContent = '请输入完整的 5 位隧道暗号。';
            return;
        }
        note.textContent = '正在查找传输隧道...';
        try {
            const response = await fetch(`/api/short-codes/${encodeURIComponent(shortCode)}`);
            if (!response.ok) throw new Error('没有找到该传输隧道，或它已经被删除。');
            const data = await response.json();
            if (!/^[a-zA-Z0-9_-]{8,64}$/.test(data.sessionId || '')) throw new Error('传输隧道响应无效。');
            openSession(data.sessionId);
        } catch (err) {
            note.textContent = err.message;
        }
    };

    inputs.forEach((input, index) => {
        input.addEventListener('input', event => {
            const value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
            event.target.value = value.slice(-1);
            if (value.length > 1) fillCode(value);
            else if (event.target.value && inputs[index + 1]) inputs[index + 1].focus();
        });
        input.addEventListener('keydown', event => {
            if (event.key === 'Backspace' && !input.value && inputs[index - 1]) inputs[index - 1].focus();
            if (event.key === 'Enter') join();
        });
        input.addEventListener('paste', event => {
            event.preventDefault();
            fillCode(event.clipboardData?.getData('text'));
        });
    });
    document.getElementById('landingJoinBtn').addEventListener('click', join);
    document.getElementById('landingCreateBtn').addEventListener('click', () => openSession(generateId()));
    inputs[0].focus();
}

function openSession(sessionId) {
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(sessionId)) return;
    const target = new URL(`${window.location.origin}${window.location.pathname}`);
    // A changed query forces a new document load. A hash-only assignment would
    // otherwise keep the chooser page alive without running application startup.
    target.searchParams.set('open', '1');
    target.hash = sessionId;
    window.location.assign(target.href);
}

async function leaveTunnel() {
    const existing = await getFromStore('sessions', state.sessionId).catch(() => null);
    await saveToStore('sessions', {
        ...(existing || {}),
        sessionId: state.sessionId,
        deviceId: state.deviceId,
        entryState: 'left',
        lastLeftAt: Date.now()
    }).catch(err => historyLog('session-leave-state-failed', { error: err.message }));
    state.socket?.disconnect();
    const target = new URL(`${window.location.origin}${window.location.pathname}`);
    target.searchParams.set('leave', '1');
    window.location.assign(target.href);
}

function generateId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function detectDeviceModel() {
    const userAgent = navigator.userAgent || '';
    const androidModel = /Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|;|\))/i.exec(userAgent);
    if (androidModel?.[1]) return androidModel[1].trim().slice(0, 120);
    if (/iPhone/i.test(userAgent)) return 'iPhone';
    if (/iPad/i.test(userAgent)) return 'iPad';
    if (/Macintosh/i.test(userAgent)) return 'Mac';
    if (/Windows/i.test(userAgent)) return 'Windows PC';
    if (/Linux/i.test(userAgent)) return 'Linux device';
    return navigator.platform || '未知设备';
}

function isPrivateNetworkIp(value) {
    const ip = String(value || '').replace(/^::ffff:/i, '');
    return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
        /^127\./.test(ip) || /^169\.254\./.test(ip) || /^fc/i.test(ip) || /^fd/i.test(ip) || /^fe80:/i.test(ip);
}

function discoverLocalNetworkIp(timeout = 1200) {
    if (!window.RTCPeerConnection) return Promise.resolve(null);
    return new Promise(resolve => {
        const connection = new RTCPeerConnection({ iceServers: [] });
        let finished = false;
        const finish = value => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            connection.close();
            resolve(value || null);
        };
        const timer = setTimeout(() => finish(null), timeout);
        connection.createDataChannel('network-probe');
        connection.onicecandidate = event => {
            const candidate = event.candidate?.candidate || '';
            const match = /candidate:\S+\s+\d+\s+\S+\s+([0-9a-f:.]+)\s+\d+\s+typ\s+host/i.exec(candidate);
            if (match && isPrivateNetworkIp(match[1])) finish(match[1]);
            if (!event.candidate) finish(null);
        };
        connection.createOffer()
            .then(offer => connection.setLocalDescription(offer))
            .catch(() => finish(null));
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

    state.socket.on('connect', async () => {
        state.debugLogReady = false;
        console.log('Socket connected');
        historyLog('socket-connected', {
            socketId: state.socket.id,
            socketServer: CONFIG.SOCKET_SERVER
        });
        await announceKnownSessionCodes();
        historyLog('join-emitted', {
            socketId: state.socket.id,
            deviceName: state.deviceName
        });
        state.socket.emit('join-session', {
            sessionId: state.sessionId,
            deviceId: state.deviceId,
            deviceName: state.deviceName,
            deviceModel: state.deviceModel,
            localIp: state.reportedLanIp,
            shortCode: state.shortCode
        });
        state.debugLogReady = true;
        flushClientDebugLogs();
        announceStoredEditorAssets();
        announceStoredFileAssets();
        hydrateEditorAssets(document.getElementById('editor'));
        consumePendingSharedFiles().catch(err => {
            historyLog('shared-file-import-failed', { error: err.message });
        });
        discoverLocalNetworkIp().then(localIp => {
            if (!localIp || localIp === state.reportedLanIp || !state.socket?.connected) return;
            state.reportedLanIp = localIp;
            state.socket.emit('device-profile-update', {
                sessionId: state.sessionId,
                deviceModel: state.deviceModel,
                localIp
            });
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
    state.socket.on('session-deleted', async data => {
        if (data?.sessionId !== state.sessionId) return;
        await purgeLocalSession(data.sessionId);
        alert('当前传输隧道已由管理员删除。');
        window.location.href = `${window.location.origin}${window.location.pathname}`;
    });
    state.socket.on('device-profile', data => {
        state.selfNetworkInfo = data || null;
        updateDeviceList();
    });
    state.socket.on('device-updated', handleDeviceUpdated);

    state.socket.on('session-short-code', (data) => {
        updateShortCode(data?.shortCode).catch(err => historyLog('short-code-persist-failed', { error: err.message }));
    });
    state.socket.on('short-code-session', (data) => {
        if (data?.sessionId && data.sessionId !== state.sessionId) {
            window.location.hash = data.sessionId;
            window.location.reload();
        }
    });
    state.socket.on('short-code-error', (data) => alert(data?.message || '短码无法加入会话'));
    state.socket.on('clipboard-update', (data) => receiveSharedClipboard(data));

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
    state.socket.on('file-asset-manifest', (data) => fileAssetTransfer?.handleManifest(data));
    state.socket.on('file-asset-unavailable', (data) => fileAssetTransfer?.handleUnavailable(data));
    state.socket.on('file-asset-relay-start', (data) => fileAssetTransfer?.handleRelayStart(data));
    state.socket.on('file-asset-relay-chunk', (data) => fileAssetTransfer?.handleRelayChunk(data));
    state.socket.on('file-asset-relay-complete', (data) => fileAssetTransfer?.handleRelayComplete(data));
    state.socket.on('directory-mirror-asset', data => {
        const asset = data?.asset;
        if (asset?.id && data.from !== state.deviceId) {
            fileAssetTransfer?.request(asset.id, asset.ownerDeviceId || data.from, asset);
            historyLog('directory-mirror-requested', { assetId: asset.id, from: data.from, folderName: asset.folderName });
        }
    });

    state.socket.on('camera-broadcast-start', (data) => {
        mediaController?.handleCameraBroadcastStart(data);
        if (data?.from && data.from !== state.deviceId) updateMediaButtons({ cameraMode: 'remote' });
    });
    state.socket.on('camera-broadcast-stop', (data) => {
        mediaController?.handleCameraBroadcastStop(data);
        if (!mediaController?.camera && !mediaController?.cameraBroadcast) updateMediaButtons({ cameraMode: 'idle' });
    });
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
        ownerDeviceId: asset.ownerDeviceId,
        sourceFileId: asset.sourceFileId
    };
}

function createEditorAssetHtml(asset) {
    const sourceFileAttr = asset.sourceFileId ? ` data-tunnel-source-file-id="${escapeHtml(asset.sourceFileId)}"` : '';
    return `<img data-tunnel-asset-id="${asset.id}" data-tunnel-asset-owner="${asset.ownerDeviceId}" data-tunnel-asset-name="${escapeHtml(asset.name)}" data-tunnel-asset-type="${escapeHtml(asset.type)}" data-tunnel-asset-size="${asset.size}"${sourceFileAttr} alt="${escapeHtml(asset.name)}" style="max-width: 100%; border-radius: 8px;">`;
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

async function cloneBinaryData(data) {
    if (data instanceof ArrayBuffer) return data.slice(0);
    if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data.arrayBuffer();
    throw new Error('File data is unavailable');
}

async function createEditorAsset(name, type, data, options = {}) {
    const size = getBinaryDataSize(data);
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
        sourceFileId: options.sourceFileId,
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
    if (file?.isEditorAsset) return file;
    if (!hasCompleteFileCache(file, file)) {
        throw new Error('Referenced file is not cached on this device');
    }

    const files = typeof IDBKeyRange !== 'undefined'
        ? await getAllFromStore('files', 'sessionId', IDBKeyRange.only(state.sessionId))
        : (await getAllFromStore('files')).filter(item => item.sessionId === state.sessionId);
    const existing = files.find(item =>
        item.isEditorAsset &&
        item.sourceFileId === file.id &&
        item.type === file.type &&
        item.size === file.size &&
        hasCompleteFileCache(item, item)
    );
    if (existing) {
        announceEditorAsset(existing);
        historyLog('editor-asset-reference-reused', {
            sourceFileId: file.id,
            asset: getEditorAssetMetadata(existing)
        });
        return existing;
    }

    return createEditorAsset(file.name, file.type, await cloneBinaryData(file.data), { sourceFileId: file.id });
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
        onProgress: (fileId, fileName, progress, transport) => {
            const route = String(transport || '');
            const progressKey = getFileProgressKey(fileId, route);
            const status = getFileProgressStatus(route);
            const terminal = progress >= 100;
            if (progress < 100) {
                activeFileProgress.add(progressKey);
                completedFileProgress.delete(progressKey);
                const timer = progressHideTimers.get(progressKey);
                if (timer) clearTimeout(timer);
                progressHideTimers.delete(progressKey);
            } else if (terminal && completedFileProgress.has(progressKey)) {
                return;
            } else if (terminal && !activeFileProgress.has(progressKey)) {
                completedFileProgress.add(progressKey);
                hideProgress(progressKey);
                historyLog('file-progress-terminal-suppressed', {
                    fileId,
                    fileName,
                    transport: route,
                    reason: 'no-active-progress'
                });
                return;
            }
            showProgress(progressKey, fileName, progress, status);
            if (terminal) {
                activeFileProgress.delete(progressKey);
                completedFileProgress.add(progressKey);
                const timer = setTimeout(() => {
                    hideProgress(progressKey);
                    progressHideTimers.delete(progressKey);
                }, 800);
                progressHideTimers.set(progressKey, timer);
            }
        },
        onQueue: (fileId, queueLength, activeDownloads) => showQueuedFileTransfer(fileId, queueLength, activeDownloads),
        onReceived: async (asset) => {
            if (asset.isDirectoryMirror) await applyDirectoryMirrorAsset(asset);
            else await refreshFileMessage(asset.id);
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
        onIntercomState: active => {
            updateMediaButtons({ intercom: active });
            updateDeviceList();
        }
    });
}

function showCameraStream(stream, active, isLocal) {
    const stage = document.getElementById('cameraStage');
    const video = document.getElementById('cameraVideo');
    video.srcObject = stream || null;
    video.muted = Boolean(isLocal);
    stage.style.display = active ? 'block' : 'none';
    updateMediaButtons({ cameraMode: active ? (isLocal ? 'local' : 'remote') : 'idle' });
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
    if (camera && Object.hasOwn(stateUpdate, 'cameraMode')) {
        camera.textContent = stateUpdate.cameraMode === 'local'
            ? '关闭摄像头'
            : stateUpdate.cameraMode === 'remote'
                ? '顶号开播'
                : '摄像头';
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
            const isCachedChatAsset = hasCompleteFileCache(file, file) && (file.isFileAsset || (!file.isEditorAsset && file.ownerDeviceId));
            if (!isCachedChatAsset) continue;
            if (!file.isFileAsset) {
                file.isFileAsset = true;
                await saveToStore('files', file);
                historyLog('file-asset-cache-migrated', { fileId: file.id });
            }
            await fileAssetTransfer.announce(file);
        }
        fileAssetTransfer.resumePending();
    } catch (err) {
        historyLog('file-asset-announce-failed', { error: err.message });
    }
}

async function sendFile(file, targetDeviceId = null, options = {}) {
    const fileId = generateId();
    const fileInfo = {
        id: fileId,
        name: file.name,
        size: file.size,
        type: file.type,
        timestamp: Date.now(),
        sender: state.deviceId,
        senderName: state.deviceName,
        ...options
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

    if (options.silent) {
        state.socket.emit('directory-mirror-asset', { sessionId: state.sessionId, assetId: fileId });
        historyLog('directory-mirror-asset-emitted', { assetId: fileId, folderName: options.folderName, entryCount: options.entryCount });
        return fileId;
    }

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

async function consumePendingSharedFiles() {
    if (sharedFileImportInProgress || !state.sessionId) return;
    const queued = await getAllFromStore('shareQueue').catch(() => []);
    if (!queued.length) return;

    sharedFileImportInProgress = true;
    try {
        for (const item of queued.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
            if (!(item.data instanceof ArrayBuffer) && !ArrayBuffer.isView(item.data)) continue;
            const bytes = item.data instanceof ArrayBuffer
                ? item.data
                : item.data.buffer.slice(item.data.byteOffset, item.data.byteOffset + item.data.byteLength);
            let file;
            try {
                file = new File([bytes], item.name || 'shared-file', {
                    type: item.type || 'application/octet-stream',
                    lastModified: item.lastModified || Date.now()
                });
            } catch (err) {
                file = new Blob([bytes], { type: item.type || 'application/octet-stream' });
                file.name = item.name || 'shared-file';
                file.lastModified = item.lastModified || Date.now();
            }
            await sendFile(file);
            await deleteFromStore('shareQueue', item.id);
            historyLog('shared-file-imported', { name: item.name, size: item.size, sessionId: state.sessionId });
        }
        state.pendingSharedFileCount = 0;
    } finally {
        sharedFileImportInProgress = false;
    }
}

async function purgeLocalSession(sessionId) {
    const [messages, files, editorContent] = await Promise.all([
        typeof IDBKeyRange !== 'undefined'
            ? getAllFromStore('messages', 'sessionId', IDBKeyRange.only(sessionId))
            : getAllFromStore('messages').then(items => items.filter(item => item.sessionId === sessionId)),
        typeof IDBKeyRange !== 'undefined'
            ? getAllFromStore('files', 'sessionId', IDBKeyRange.only(sessionId))
            : getAllFromStore('files').then(items => items.filter(item => item.sessionId === sessionId)),
        getFromStore('editorContent', 'current')
    ]);
    await Promise.all([
        ...messages.map(message => deleteFromStore('messages', message.id)),
        ...files.map(file => deleteFromStore('files', file.id)),
        deleteFromStore('sessions', sessionId),
        editorContent?.sessionId === sessionId ? deleteFromStore('editorContent', 'current') : Promise.resolve()
    ]);
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
                message.fileInfo.ownerDeviceId || message.sender,
                message.fileInfo
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
                    if (!hasCompleteFileCache(storedFile, message.fileInfo) && (!storedFile?.cacheCleared || storedFile.restoreRequested)) {
                        await fileAssetTransfer.request(
                            message.fileInfo.id,
                            message.fileInfo.ownerDeviceId || message.sender,
                            message.fileInfo
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
                if (!hasCompleteFileCache(storedFile, message.fileInfo) && (!storedFile?.cacheCleared || storedFile.restoreRequested)) {
                    await fileAssetTransfer.request(
                        message.fileInfo.id,
                        message.fileInfo.ownerDeviceId || message.sender,
                        message.fileInfo
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
        const localMessages = await getCurrentSessionMessages();
        if (messages.length === 0 && deletedMessageIds.length === 0 && localMessages.length > 0) {
            historyLog('history-canonical-empty-ignored', {
                localMessageCount: localMessages.length
            });
            await reconcileLocalHistory(messages, deletedMessageIds);
        } else {
            await pruneLocalHistoryToCanonicalSnapshot(messages, deletedMessageIds);
        }
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
    const deletedIds = new Set(Array.isArray(deletedMessageIds) ? deletedMessageIds : []);
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
        messageEl.classList.add('file-record');
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

        // 检查是否是本地已存储的文件（刷新后从IndexedDB加载）
        let fileUrl = fileInfo.data || null;
        let storedFile = null;

        if (fileInfo.id) {
            try {
                storedFile = await getFromStore('files', fileInfo.id);

                if (!fileUrl && hasCompleteFileCache(storedFile, fileInfo)) {
                    fileUrl = fileObjectUrls.get(fileInfo.id);
                    if (!fileUrl) {
                        fileUrl = URL.createObjectURL(new Blob([storedFile.data], { type: storedFile.type || fileInfo.type }));
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
                        <img src="${fileUrl}" alt="${escapeHtml(fileInfo.name)}">
                    </div>
                    <div class="file-size media-file-size">${formatFileSize(fileInfo.size)}</div>
                </div>
            `;
        } else if (isVideo && fileUrl) {
            contentHtml = `
                <div class="message-bubble">
                    <div class="media-preview">
                        <video muted playsinline preload="metadata" src="${fileUrl}"></video>
                    </div>
                    <div class="file-size media-file-size">${formatFileSize(fileInfo.size)}</div>
                </div>
            `;
        } else {
            // 文件消息（大文件、无法预览的文件，或文件数据已丢失）
            const sizeStr = formatFileSize(fileInfo.size);
            const hasLocalData = fileInfo.id && Boolean(fileUrl);
            const opacity = hasLocalData ? '' : 'opacity: 0.6;';

            const unavailableLabel = fileInfo.isAsset
                ? ' (等待接收)'
                : fileInfo.isP2P || !fileInfo.isSmall
                    ? ' (未同步到本机)'
                    : ' (文件数据不可用)';
            contentHtml = `
                <div class="message-bubble file-message" style="${opacity}">
                    <div class="file-icon">${getFileIcon(fileInfo.type)}</div>
                    <div class="file-info">
                        <div class="file-name">${escapeHtml(fileInfo.name)}</div>
                        <div class="file-size">${sizeStr}${!hasLocalData ? unavailableLabel : ''}</div>
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
        attachFileRecordInteractions(messageEl);
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

async function downloadFileFromMessage(messageId) {
    const message = await getFromStore('messages', messageId);
    const fileInfo = message?.fileInfo;
    if (!fileInfo?.id) return;

    const storedFile = await getFromStore('files', fileInfo.id);
    if (hasCompleteFileCache(storedFile, fileInfo)) {
        await downloadFile(fileInfo.id);
        return;
    }

    if (fileInfo.isAsset) {
        await restoreFileCache(messageId);
        alert('文件缓存正在还原，完成后请再次点击下载。');
        return;
    }

    alert('文件尚未缓存到本机，且没有可用的远程文件来源。');
}

function renderFileMessageActions(messageEl, fileInfo, cacheState = {}) {
    messageEl.querySelector('.file-actions')?.remove();
    const actions = document.createElement('div');
    actions.className = 'file-actions';

    actions.appendChild(createFileActionButton('详情', '查看文件名、大小、来源设备等详细信息', () => {
        showFileDetails(messageEl.dataset.messageId).catch(err => historyLog('file-details-open-failed', {
            messageId: messageEl.dataset.messageId,
            fileId: fileInfo.id,
            error: err.message
        }));
    }));
    actions.appendChild(createFileActionButton('下载', '下载此文件；本机无缓存时会先尝试还原', () => {
        downloadFileFromMessage(messageEl.dataset.messageId).catch(err => historyLog('file-download-from-message-failed', {
            messageId: messageEl.dataset.messageId,
            fileId: fileInfo.id,
            error: err.message
        }));
    }));
    const clearCacheButton = createFileActionButton('清除缓存', '仅清理本设备保存的文件内容', () => {
        clearFileCache(messageEl.dataset.messageId);
    });
    if (!cacheState.hasLocalData) {
        clearCacheButton.disabled = true;
        clearCacheButton.title = cacheState.cacheCleared ? '本机缓存已清理' : '本机暂无可清理的文件缓存';
    }
    actions.appendChild(clearCacheButton);
    actions.appendChild(createFileActionButton('删除', '从会话中删除此记录及所有设备的文件缓存', () => {
        deleteHistoryMessage(messageEl.dataset.messageId);
    }));
    messageEl.appendChild(actions);
}

let activeFileDetailsMessageId = null;

function getFileExtension(fileName) {
    const name = String(fileName || '');
    const index = name.lastIndexOf('.');
    return index > 0 && index < name.length - 1 ? name.slice(index + 1).toUpperCase() : '无扩展名';
}

function formatDateTime(timestamp) {
    return new Date(timestamp || Date.now()).toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function isLikelyTouchDevice() {
    return window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}

function closeFileDetails() {
    document.getElementById('fileDetailsViewer').classList.remove('active');
    activeFileDetailsMessageId = null;
}

function closeFilePreview() {
    const viewer = document.getElementById('filePreviewViewer');
    viewer.classList.remove('active');
    document.getElementById('filePreviewContent').replaceChildren();
}

function getStoredFileUrl(fileId, storedFile) {
    let url = fileObjectUrls.get(fileId);
    if (!url) {
        url = URL.createObjectURL(new Blob([storedFile.data], { type: storedFile.type }));
        fileObjectUrls.set(fileId, url);
    }
    return url;
}

function isInlineDocument(fileInfo) {
    const type = String(fileInfo.type || '').toLowerCase();
    return type === 'application/pdf' || type.startsWith('text/') ||
        ['application/json', 'application/xml', 'application/javascript'].includes(type);
}

async function openFileRecord(messageId) {
    const message = await getFromStore('messages', messageId);
    const fileInfo = message?.fileInfo;
    if (!fileInfo?.id) return;

    const storedFile = await getFromStore('files', fileInfo.id);
    if (!hasCompleteFileCache(storedFile, fileInfo)) {
        alert('文件尚未缓存到本机，请先使用“还原文件”获取内容。');
        return;
    }

    const type = String(fileInfo.type || storedFile.type || '').toLowerCase();
    const canPreviewDocument = isInlineDocument({ type });
    const textPreviewTooLarge = type !== 'application/pdf' && canPreviewDocument &&
        getBinaryDataSize(storedFile.data) > 5 * 1024 * 1024;
    if (!type.startsWith('image/') && !type.startsWith('video/') && !type.startsWith('audio/') && (!canPreviewDocument || textPreviewTooLarge)) {
        const shouldDownload = window.confirm(`“${fileInfo.name}”无法在当前浏览器中直接打开。是否下载？`);
        if (shouldDownload) await downloadFile(fileInfo.id);
        return;
    }

    const title = document.getElementById('filePreviewTitle');
    const content = document.getElementById('filePreviewContent');
    title.textContent = fileInfo.name || '文件预览';
    content.replaceChildren();

    const url = getStoredFileUrl(fileInfo.id, storedFile);
    if (type.startsWith('image/')) {
        const image = document.createElement('img');
        image.src = url;
        image.alt = fileInfo.name || '图片预览';
        content.appendChild(image);
    } else if (type.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = url;
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        content.appendChild(video);
        video.play().catch(() => {});
    } else if (type.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.src = url;
        audio.controls = true;
        audio.autoplay = true;
        content.appendChild(audio);
        audio.play().catch(() => {});
    } else if (type === 'application/pdf') {
        const frame = document.createElement('iframe');
        frame.src = url;
        frame.title = fileInfo.name || 'PDF 文档';
        content.appendChild(frame);
    } else {
        const text = document.createElement('pre');
        text.textContent = await new Blob([storedFile.data], { type: storedFile.type }).text();
        content.appendChild(text);
    }

    document.getElementById('filePreviewViewer').classList.add('active');
    historyLog('file-preview-opened', { messageId, fileId: fileInfo.id, type });
}

async function showFileDetails(messageId) {
    const message = await getFromStore('messages', messageId);
    const fileInfo = message?.fileInfo;
    if (!fileInfo?.id) return;

    const storedFile = await getFromStore('files', fileInfo.id);
    const hasLocalData = hasCompleteFileCache(storedFile, fileInfo);
    activeFileDetailsMessageId = messageId;
    const details = [
        ['文件名', fileInfo.name || '未知文件'],
        ['扩展名', getFileExtension(fileInfo.name)],
        ['MIME 类型', fileInfo.type || 'application/octet-stream'],
        ['文件大小', formatFileSize(Number(fileInfo.size) || 0)],
        ['上传时间', formatDateTime(message.timestamp)],
        ['最初上传设备', message.senderName || '未知设备'],
        ['设备 ID', fileInfo.ownerDeviceId || message.sender || '未知'],
        ['本机状态', hasLocalData ? '已缓存，可下载或预览' : (storedFile?.cacheCleared ? '缓存已清理' : '本机未缓存')],
        ['提示', isLikelyTouchDevice() ? '手指长按文件旁边的空白处，即可查看详情' : '在文件旁边的空白处点击右键即可查看详情']
    ];
    const list = document.getElementById('fileDetailsList');
    list.replaceChildren();
    details.forEach(([label, value]) => {
        const row = document.createElement('div');
        row.className = 'file-details-row';
        const term = document.createElement('dt');
        term.textContent = label;
        const description = document.createElement('dd');
        description.textContent = value;
        description.title = value;
        row.append(term, description);
        list.appendChild(row);
    });
    const downloadButton = document.getElementById('downloadFileDetailsBtn');
    downloadButton.disabled = false;
    downloadButton.title = hasLocalData ? `下载 ${fileInfo.name}` : '本机无缓存时会先尝试还原文件';
    document.getElementById('fileDetailsViewer').classList.add('active');
    historyLog('file-details-opened', { messageId, fileId: fileInfo.id, hasLocalData });
}

function attachFileRecordInteractions(messageEl) {
    let longPressTimer = null;
    let suppressClickUntil = 0;
    let startPoint = null;
    const messageId = messageEl.dataset.messageId;
    const isAction = target => Boolean(target.closest('.file-actions'));
    const cancelLongPress = () => {
        if (longPressTimer) clearTimeout(longPressTimer);
        longPressTimer = null;
        startPoint = null;
    };

    messageEl.addEventListener('click', event => {
        if (isAction(event.target) || Date.now() < suppressClickUntil) return;
        openFileRecord(messageId).catch(err => historyLog('file-record-open-failed', { messageId, error: err.message }));
    });
    messageEl.addEventListener('contextmenu', event => {
        if (isAction(event.target)) return;
        event.preventDefault();
        suppressClickUntil = Date.now() + 500;
        showFileDetails(messageId).catch(err => historyLog('file-details-open-failed', { messageId, error: err.message }));
    });
    messageEl.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'touch' || isAction(event.target)) return;
        startPoint = { x: event.clientX, y: event.clientY };
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            suppressClickUntil = Date.now() + 700;
            navigator.vibrate?.(12);
            showFileDetails(messageId).catch(err => historyLog('file-details-open-failed', { messageId, error: err.message }));
        }, 550);
    });
    messageEl.addEventListener('pointermove', event => {
        if (!startPoint || event.pointerType !== 'touch') return;
        if (Math.hypot(event.clientX - startPoint.x, event.clientY - startPoint.y) > 12) cancelLongPress();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(eventName => {
        messageEl.addEventListener(eventName, cancelLongPress);
    });
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
    if (!hasCompleteFileCache(storedFile)) return;

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
            bubble.innerHTML = `<div class="media-preview"><img src="${url}" alt="${name}"></div><div class="file-size media-file-size">${formatFileSize(storedFile.size)}</div>`;
            bubble.classList.remove('file-message');
            bubble.style.opacity = '';
        } else if (type.startsWith('video/')) {
            bubble.innerHTML = `<div class="media-preview"><video muted playsinline preload="metadata" src="${url}"></video></div><div class="file-size media-file-size">${formatFileSize(storedFile.size)}</div>`;
            bubble.classList.remove('file-message');
            bubble.style.opacity = '';
        } else {
            bubble.style.opacity = '';
            bubble.removeAttribute('onclick');
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
    await fileAssetTransfer.request(fileInfo.id, fileInfo.ownerDeviceId || message.sender, fileInfo);
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
        const stillReferenced = await isFileReferencedByRichContent(fileId, messageId);
        if (stillReferenced) {
            const storedFile = await getFromStore('files', fileId);
            if (storedFile) {
                await saveToStore('files', {
                    ...storedFile,
                    referencedAfterHistoryDelete: true,
                    isFileAsset: false,
                    timestamp: storedFile.timestamp || Date.now()
                });
            }
        } else {
            await deleteFromStore('files', fileId);
            const objectUrl = fileObjectUrls.get(fileId);
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            fileObjectUrls.delete(fileId);
        }
    }
    await deleteFromStore('messages', messageId);
    pendingHistoryMessageIds.delete(messageId);
    document.querySelector(`.message[data-message-id="${messageId}"]`)?.remove();
    historyLog('history-message-deleted-locally', { messageId, fileId: message?.fileInfo?.id });
}

function extractAssetIds(content) {
    return Array.from(String(content || '').matchAll(/data-tunnel-asset-id="([^"]+)"/g), match => match[1]);
}

function extractFileRefIds(content) {
    const html = String(content || '');
    const ids = new Set([
        ...Array.from(html.matchAll(/data-tunnel-file-ref-id="([^"]+)"/g), match => match[1]),
        ...Array.from(html.matchAll(/downloadFile\(['"]([^'"]+)['"]\)/g), match => match[1])
    ]);
    return Array.from(ids);
}

async function isFileReferencedByRichContent(fileId, excludingMessageId = null) {
    const [messages, editorContent] = await Promise.all([
        getCurrentSessionMessages(),
        getFromStore('editorContent', 'current')
    ]);
    for (const message of messages) {
        if (!message || message.id === excludingMessageId || message.type !== 'rich') continue;
        if (extractFileRefIds(message.content).includes(fileId)) return true;
    }
    if (editorContent?.sessionId === state.sessionId &&
        extractFileRefIds(editorContent.content).includes(fileId)) {
        return true;
    }
    const editor = document.getElementById('editor');
    return Boolean(editor && extractFileRefIds(editor.innerHTML).includes(fileId));
}

async function findGarbageFileCaches() {
    const [messages, files, editorContent] = await Promise.all([
        getCurrentSessionMessages(),
        typeof IDBKeyRange !== 'undefined'
            ? getAllFromStore('files', 'sessionId', IDBKeyRange.only(state.sessionId))
            : getAllFromStore('files').then(items => items.filter(item => item.sessionId === state.sessionId)),
        getFromStore('editorContent', 'current')
    ]);
    const referenced = new Set();
    messages.forEach(message => {
        if (message.fileInfo?.id) referenced.add(message.fileInfo.id);
        if (message.type === 'rich') {
            extractAssetIds(message.content).forEach(id => referenced.add(id));
            extractFileRefIds(message.content).forEach(id => referenced.add(id));
        }
    });
    if (editorContent?.sessionId === state.sessionId) {
        extractAssetIds(editorContent.content).forEach(id => referenced.add(id));
        extractFileRefIds(editorContent.content).forEach(id => referenced.add(id));
    }
    return files.filter(file => !referenced.has(file.id) || file.isPartial || file.transferInterrupted);
}

async function clearGarbageFileCaches(files) {
    for (const file of files) {
        fileAssetTransfer?.cancel(file.id);
        await deleteFromStore('files', file.id);
        const objectUrl = fileObjectUrls.get(file.id);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        fileObjectUrls.delete(file.id);
    }
    historyLog('garbage-file-caches-cleared', { count: files.length, fileIds: files.map(file => file.id) });
}

async function showGarbageCleanupDialog() {
    const files = await findGarbageFileCaches();
    if (!files.length) {
        alert('没有发现可清理的游离文件缓存或中断传输缓存。');
        return;
    }
    const totalSize = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    const preview = files.slice(0, 20)
        .map(file => `<li>${escapeHtml(file.name || file.id)} (${formatFileSize(Number(file.size) || 0)})</li>`)
        .join('');
    const remaining = files.length > 20 ? `<p>另有 ${files.length - 20} 项未展开。</p>` : '';
    const dialog = document.createElement('div');
    dialog.className = 'modal-overlay active';
    dialog.innerHTML = `
        <div class="modal">
            <h3>清理垃圾缓存</h3>
            <p>发现 ${files.length} 项未被聊天记录、富文本或当前协同编辑引用的缓存，共 ${formatFileSize(totalSize)}。</p>
            <ul style="max-height: 200px; overflow: auto; padding-left: 20px; text-align: left;">${preview}</ul>
            ${remaining}
            <div class="modal-actions">
                <button class="btn btn-secondary" id="cancelGarbageCleanup">取消</button>
                <button class="btn btn-primary" id="confirmGarbageCleanup">清理 ${files.length} 项</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);
    dialog.querySelector('#cancelGarbageCleanup').addEventListener('click', () => dialog.remove());
    dialog.querySelector('#confirmGarbageCleanup').addEventListener('click', async () => {
        await clearGarbageFileCaches(files);
        dialog.remove();
    });
}

async function getCurrentSessionFiles() {
    if (typeof IDBKeyRange !== 'undefined') {
        return getAllFromStore('files', 'sessionId', IDBKeyRange.only(state.sessionId));
    }
    return (await getAllFromStore('files')).filter(file => file.sessionId === state.sessionId);
}

function getEditorAssetEntries(content) {
    const container = document.createElement('div');
    container.innerHTML = String(content || '');
    return Array.from(container.querySelectorAll('img[data-tunnel-asset-id]')).map(image => ({
        id: image.dataset.tunnelAssetId,
        name: image.dataset.tunnelAssetName || '',
        type: image.dataset.tunnelAssetType || 'image/*',
        size: Number(image.dataset.tunnelAssetSize || 0),
        ownerDeviceId: image.dataset.tunnelAssetOwner || '',
        isEditorAsset: true
    })).filter(asset => asset.id);
}

function getResourceReferenceKey(reference) {
    return [
        reference.kind,
        reference.messageId || '',
        reference.targetAssetId || '',
        reference.resourceId || ''
    ].join(':');
}

function getResourceReferenceLabel(reference) {
    const time = reference.timestamp ? ` ${formatTime(reference.timestamp)}` : '';
    if (reference.kind === 'chat-file') return `聊天文件${time}`;
    if (reference.kind === 'rich-message') return `富文本消息${time}`;
    return '协同编辑器';
}

async function getSessionResourceInventory() {
    const [messages, files, editorContent] = await Promise.all([
        getCurrentSessionMessages(),
        getCurrentSessionFiles(),
        getFromStore('editorContent', 'current')
    ]);
    const resources = new Map();

    const upsertResource = (candidate, storedFile = false) => {
        const id = candidate?.id;
        if (!id) return null;
        let resource = resources.get(id);
        if (!resource) {
            resource = {
                id,
                name: '',
                type: 'application/octet-stream',
                size: 0,
                ownerDeviceId: '',
                sourceFileId: '',
                isEditorAsset: false,
                isFileAsset: false,
                file: null,
                references: [],
                derivedCopies: [],
                referenceKeys: new Set()
            };
            resources.set(id, resource);
        }
        if (candidate.name) resource.name = candidate.name;
        if (candidate.type) resource.type = candidate.type;
        if (Number.isFinite(Number(candidate.size)) && Number(candidate.size) >= 0) resource.size = Number(candidate.size);
        if (candidate.ownerDeviceId) resource.ownerDeviceId = candidate.ownerDeviceId;
        if (candidate.sourceFileId) resource.sourceFileId = candidate.sourceFileId;
        resource.isEditorAsset = resource.isEditorAsset || candidate.isEditorAsset === true;
        resource.isFileAsset = resource.isFileAsset || candidate.isFileAsset === true || candidate.isAsset === true;
        if (storedFile) resource.file = candidate;
        return resource;
    };

    const addReference = (resourceId, reference) => {
        const resource = upsertResource({ id: resourceId });
        if (!resource) return;
        const normalized = { ...reference, resourceId };
        const key = getResourceReferenceKey(normalized);
        if (resource.referenceKeys.has(key)) return;
        resource.referenceKeys.add(key);
        resource.references.push(normalized);
    };

    files.forEach(file => upsertResource(file, true));

    messages.forEach(message => {
        if (message.fileInfo?.id) {
            upsertResource(message.fileInfo);
            addReference(message.fileInfo.id, {
                kind: 'chat-file',
                messageId: message.id,
                timestamp: message.timestamp
            });
        }
        if (message.type !== 'rich') return;

        getEditorAssetEntries(message.content).forEach(asset => {
            upsertResource(asset);
            addReference(asset.id, {
                kind: 'rich-message',
                messageId: message.id,
                timestamp: message.timestamp,
                targetAssetId: asset.id
            });
        });
        extractFileRefIds(message.content).forEach(fileId => {
            addReference(fileId, {
                kind: 'rich-message',
                messageId: message.id,
                timestamp: message.timestamp,
                targetAssetId: fileId
            });
        });
    });

    const editor = document.getElementById('editor');
    const currentEditorContent = editor?.innerHTML ||
        (editorContent?.sessionId === state.sessionId ? editorContent.content : '');
    getEditorAssetEntries(currentEditorContent).forEach(asset => {
        upsertResource(asset);
        addReference(asset.id, { kind: 'editor', targetAssetId: asset.id });
    });
    extractFileRefIds(currentEditorContent).forEach(fileId => {
        addReference(fileId, { kind: 'editor', targetAssetId: fileId });
    });

    Array.from(resources.values()).forEach(resource => {
        if (!resource.sourceFileId || resource.references.length === 0) return;
        const source = resources.get(resource.sourceFileId);
        if (!source || source.derivedCopies.some(copy => copy.id === resource.id)) return;
        source.derivedCopies.push({
            id: resource.id,
            name: resource.name,
            referenceCount: resource.references.length
        });
    });

    return Array.from(resources.values()).map(resource => {
        resource.name = resource.name || `未命名资源 ${resource.id.slice(0, 8)}`;
        resource.hasLocalData = hasCompleteFileCache(resource.file, resource);
        resource.cacheCleared = Boolean(resource.file?.cacheCleared);
        resource.isPartial = Boolean(resource.file?.isPartial || resource.file?.transferInterrupted);
        resource.timestamp = Number(resource.file?.timestamp || 0);
        resource.references.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        delete resource.referenceKeys;
        return resource;
    }).sort((a, b) => {
        if (a.references.length !== b.references.length) return b.references.length - a.references.length;
        return b.timestamp - a.timestamp || a.name.localeCompare(b.name, 'zh-CN');
    });
}

function flashResourceTarget(target) {
    if (!target) return;
    target.classList.remove('resource-focus-flash');
    void target.offsetWidth;
    target.classList.add('resource-focus-flash');
    setTimeout(() => target.classList.remove('resource-focus-flash'), 1700);
}

function openSentRichRecord(messageId) {
    if (window.matchMedia('(max-width: 767px)').matches) {
        setMobileWorkspaceView('chat');
    }
    requestAnimationFrame(() => {
        const message = document.querySelector(`.message[data-message-id="${messageId}"]`);
        if (!message) return;
        message.scrollIntoView({ behavior: 'smooth', block: 'center' });
        flashResourceTarget(message);
    });
}

function getResourceTargetInEditor(editor, assetId) {
    return Array.from(editor.querySelectorAll('[data-tunnel-asset-id], [data-tunnel-file-ref-id]'))
        .find(element => element.dataset.tunnelAssetId === assetId || element.dataset.tunnelFileRefId === assetId);
}

function focusResourceReference(reference) {
    if (reference.kind === 'editor') {
        const editor = document.getElementById('editor');
        if (!editor) return;
        editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const target = getResourceTargetInEditor(editor, reference.targetAssetId || reference.resourceId);
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            flashResourceTarget(target);
        } else {
            editor.focus();
            flashResourceTarget(editor);
        }
        return;
    }

    const message = document.querySelector(`.message[data-message-id="${reference.messageId}"]`);
    if (!message) return;
    message.scrollIntoView({ behavior: 'smooth', block: 'center' });
    message.tabIndex = -1;
    message.focus({ preventScroll: true });
    flashResourceTarget(message);
}

function closeResourceBrowser() {
    const layer = document.getElementById('resourceBrowserLayer');
    if (!layer) return;
    layer.replaceChildren();
    layer.hidden = true;
}

async function clearResourceCache(resource) {
    const file = await getFromStore('files', resource.id);
    if (!file || !hasCompleteFileCache(file, resource)) return;
    if (!confirm(`仅清除此设备保存的“${resource.name}”内容吗？引用与传输记录会保留。`)) return;

    fileAssetTransfer?.cancel(resource.id);
    const { data, ...metadata } = file;
    await saveToStore('files', {
        ...metadata,
        id: resource.id,
        name: resource.name,
        type: resource.type,
        size: resource.size,
        sessionId: state.sessionId,
        ownerDeviceId: resource.ownerDeviceId,
        isFileAsset: resource.isFileAsset,
        cacheCleared: true,
        restoreRequested: false,
        isPartial: false,
        transferInterrupted: false
    });

    const fileUrl = fileObjectUrls.get(resource.id);
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileObjectUrls.delete(resource.id);
    const editorUrl = editorAssetUrls.get(resource.id);
    if (editorUrl) URL.revokeObjectURL(editorUrl);
    editorAssetUrls.delete(resource.id);

    if (resource.isEditorAsset) {
        editorAssetCacheVersions.set(resource.id, (editorAssetCacheVersions.get(resource.id) || 0) + 1);
        setEditorAssetStatus(resource.id, '本地缓存已清理，可在资源浏览器中还原图片', 'unavailable');
    } else {
        showFileMessagePlaceholder(resource.id, '本地缓存已清理', true);
    }
    historyLog('resource-cache-cleared', { resourceId: resource.id, isEditorAsset: resource.isEditorAsset });
}

async function restoreResourceCache(resource) {
    const file = await getFromStore('files', resource.id);
    const metadata = {
        ...(file || {}),
        id: resource.id,
        name: resource.name,
        type: resource.type,
        size: resource.size,
        sessionId: state.sessionId,
        ownerDeviceId: resource.ownerDeviceId,
        cacheCleared: true,
        restoreRequested: true
    };
    await saveToStore('files', metadata);

    if (resource.isEditorAsset) {
        requestEditorAsset(resource.id, resource.ownerDeviceId);
        historyLog('resource-editor-asset-restore-requested', { resourceId: resource.id });
        return;
    }

    if (!fileAssetTransfer) {
        alert('文件传输尚未初始化。');
        return;
    }
    metadata.isFileAsset = true;
    await saveToStore('files', metadata);
    showFileMessagePlaceholder(resource.id, '正在请求还原', true);
    await fileAssetTransfer.request(resource.id, resource.ownerDeviceId, metadata);
    historyLog('resource-file-restore-requested', { resourceId: resource.id });
}

async function deleteUnreferencedResource(resource) {
    if (resource.references.length > 0) {
        alert('该资源仍有引用，不能从资源浏览器删除。请先删除引用位置，或只清除本机缓存。');
        return;
    }
    if (!confirm(`从本设备移除未引用资源“${resource.name}”吗？此操作不会删除其它设备的缓存。`)) return;

    fileAssetTransfer?.cancel(resource.id);
    await deleteFromStore('files', resource.id);
    const fileUrl = fileObjectUrls.get(resource.id);
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileObjectUrls.delete(resource.id);
    const editorUrl = editorAssetUrls.get(resource.id);
    if (editorUrl) URL.revokeObjectURL(editorUrl);
    editorAssetUrls.delete(resource.id);
    historyLog('unreferenced-resource-deleted', { resourceId: resource.id });
}

function createResourceBrowserButton(label, title, handler, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `resource-action ${className}`.trim();
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', handler);
    return button;
}

async function showResourceBrowser() {
    const layer = document.getElementById('resourceBrowserLayer');
    if (!layer) throw new Error('资源浏览器容器不存在');
    layer.replaceChildren();
    layer.hidden = false;
    const modal = document.createElement('section');
    modal.className = 'modal resource-browser-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', '会话资源浏览器');

    const header = document.createElement('div');
    header.className = 'resource-browser-header';
    const title = document.createElement('h3');
    title.textContent = '会话资源浏览器';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'resource-browser-close';
    closeButton.textContent = '×';
    closeButton.title = '关闭资源浏览器';
    closeButton.addEventListener('click', closeResourceBrowser);
    header.append(title, closeButton);

    const controls = document.createElement('div');
    controls.className = 'resource-browser-controls';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = '按名称或格式筛选资源';
    searchInput.setAttribute('aria-label', '筛选资源');
    const filter = document.createElement('select');
    filter.setAttribute('aria-label', '资源状态筛选');
    [
        ['all', '全部资源'],
        ['referenced', '有引用'],
        ['orphaned', '未引用'],
        ['missing', '缓存缺失']
    ].forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        filter.appendChild(option);
    });
    controls.append(searchInput, filter);

    const summary = document.createElement('div');
    summary.className = 'resource-browser-summary';
    const list = document.createElement('div');
    list.className = 'resource-browser-list';
    modal.append(header, controls, summary, list);
    layer.appendChild(modal);

    const render = async () => {
        const resources = await getSessionResourceInventory();
        const query = searchInput.value.trim().toLocaleLowerCase('zh-CN');
        const mode = filter.value;
        const visible = resources.filter(resource => {
            const matchesQuery = !query || `${resource.name} ${resource.type}`.toLocaleLowerCase('zh-CN').includes(query);
            if (!matchesQuery) return false;
            if (mode === 'referenced') return resource.references.length > 0;
            if (mode === 'orphaned') return resource.references.length === 0;
            if (mode === 'missing') return !resource.hasLocalData;
            return true;
        });
        const cachedSize = resources.reduce((sum, resource) => sum + (resource.hasLocalData ? resource.size : 0), 0);
        summary.textContent = `共 ${resources.length} 项资源，本机缓存 ${formatFileSize(cachedSize)}，当前显示 ${visible.length} 项。`;
        list.replaceChildren();

        if (!visible.length) {
            const empty = document.createElement('div');
            empty.className = 'resource-browser-empty';
            empty.textContent = '没有符合条件的资源。';
            list.appendChild(empty);
            return;
        }

        visible.forEach(resource => {
            const item = document.createElement('article');
            item.className = 'resource-browser-item';
            const main = document.createElement('div');
            main.className = 'resource-browser-main';
            const detail = document.createElement('div');
            detail.style.minWidth = '0';
            const name = document.createElement('div');
            name.className = 'resource-browser-name';
            name.textContent = resource.name;
            name.title = resource.name;
            const meta = document.createElement('div');
            meta.className = 'resource-browser-meta';
            meta.textContent = `${formatFileSize(resource.size)} · ${resource.type || '未知格式'}`;
            detail.append(name, meta);

            const tags = document.createElement('div');
            tags.className = 'resource-browser-tags';
            const addTag = (text, className = '') => {
                const tag = document.createElement('span');
                tag.className = `resource-tag ${className}`.trim();
                tag.textContent = text;
                tags.appendChild(tag);
            };
            addTag(resource.isEditorAsset ? '协同图片' : '文件');
            if (resource.references.length) addTag(`引用 ${resource.references.length}`, 'protected');
            else addTag('未引用', 'warning');
            if (resource.derivedCopies.length) addTag(`引用副本 ${resource.derivedCopies.length}`, 'protected');
            if (resource.hasLocalData) addTag('已缓存');
            else if (resource.isPartial) addTag('传输中断', 'warning');
            else if (resource.cacheCleared) addTag('缓存已清理', 'warning');
            else addTag('本机无缓存', 'warning');
            main.append(detail, tags);
            item.appendChild(main);

            if (resource.references.length) {
                const references = document.createElement('div');
                references.className = 'resource-browser-references';
                const referenceTitle = document.createElement('div');
                referenceTitle.className = 'resource-reference-title';
                referenceTitle.textContent = '引用位置';
                const referenceList = document.createElement('div');
                referenceList.className = 'resource-reference-list';
                resource.references.forEach(reference => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'resource-reference-button';
                    button.textContent = getResourceReferenceLabel(reference);
                    button.title = '定位到引用位置';
                    button.addEventListener('click', () => focusResourceReference(reference));
                    referenceList.appendChild(button);
                });
                references.append(referenceTitle, referenceList);
                item.appendChild(references);
            }

            if (resource.derivedCopies.length) {
                const copies = document.createElement('div');
                copies.className = 'resource-browser-references';
                const copyTitle = document.createElement('div');
                copyTitle.className = 'resource-reference-title';
                copyTitle.textContent = `已生成 ${resource.derivedCopies.length} 个独立协同图片副本；删除原聊天记录不会影响这些副本。`;
                copies.appendChild(copyTitle);
                item.appendChild(copies);
            }

            const actions = document.createElement('div');
            actions.className = 'resource-browser-actions';
            if (resource.hasLocalData) {
                actions.appendChild(createResourceBrowserButton('下载', '下载本机已缓存的资源', () => downloadFile(resource.id)));
                actions.appendChild(createResourceBrowserButton('清除缓存', '仅清理本设备保存的文件内容', async () => {
                    await clearResourceCache(resource);
                    await render();
                }));
            } else if (resource.cacheCleared || resource.isPartial) {
                actions.appendChild(createResourceBrowserButton(
                    resource.isEditorAsset ? '还原图片' : '还原文件',
                    '从当前在线设备重新获取资源内容',
                    async () => {
                        await restoreResourceCache(resource);
                        await render();
                    }
                ));
            }
            if (resource.references.length === 0) {
                actions.appendChild(createResourceBrowserButton('移除资源', '仅从本设备移除未引用资源', async () => {
                    await deleteUnreferencedResource(resource);
                    await render();
                }, 'danger'));
            }
            if (actions.childElementCount) item.appendChild(actions);
            list.appendChild(item);
        });
    };

    searchInput.addEventListener('input', () => render().catch(err => alert(`加载资源失败: ${err.message}`)));
    filter.addEventListener('change', () => render().catch(err => alert(`加载资源失败: ${err.message}`)));
    try {
        await render();
    } catch (err) {
        closeResourceBrowser();
        throw err;
    }
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

        files = files
            .filter(file =>
                file &&
                !file.isEditorAsset &&
                !file.isPartial &&
                !file.transferInterrupted &&
                !file.cacheCleared &&
                hasCompleteFileCache(file, file)
            )
            .filter((file, index, list) => list.findIndex(item => item.id === file.id) === index);

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
                    refHtml = `<span data-tunnel-file-ref-id="${escapeHtml(fileId)}" style="background: #667eea; color: white; padding: 5px 10px; border-radius: 5px; cursor: pointer;" onclick="downloadFile('${fileId}')">📎 ${escapeHtml(file.name)}</span>`;
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

        await addMessageToChat(message, true);
        openSentRichRecord(message.id);
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
        model: data.deviceModel,
        internalIp: data.internalIp,
        externalIp: data.externalIp,
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
                model: device.deviceModel,
                internalIp: device.internalIp,
                externalIp: device.externalIp,
                joinedAt: device.joinedAt
            });

            // 建立P2P连接
            connectToPeer(device.deviceId);
        }
    });

    updateDeviceList();
}

function handleDeviceUpdated(data) {
    if (!data?.deviceId || data.deviceId === state.deviceId) return;
    const existing = state.devices.get(data.deviceId);
    if (!existing) return;
    state.devices.set(data.deviceId, {
        ...existing,
        name: data.deviceName || existing.name,
        model: data.deviceModel || existing.model,
        internalIp: data.internalIp || null,
        externalIp: data.externalIp || null
    });
    updateDeviceList();
}

function showDeviceDetailsToast(device, anchor) {
    document.getElementById('deviceDetailsToast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'deviceDetailsToast';
    toast.className = 'device-details-toast';
    const lines = [
        `型号：${device.model || '未知设备'}`,
        `内网 IP：${device.internalIp || '浏览器未提供'}`,
        `外网 IP：${device.externalIp || '服务器未观察到'}`
    ];
    lines.forEach(line => {
        const item = document.createElement('div');
        item.textContent = line;
        toast.appendChild(item);
    });
    document.body.appendChild(toast);
    const rect = anchor.getBoundingClientRect();
    toast.style.top = `${Math.min(window.innerHeight - toast.offsetHeight - 12, Math.max(12, rect.bottom + 6))}px`;
    toast.style.left = `${Math.min(window.innerWidth - toast.offsetWidth - 12, Math.max(12, rect.left))}px`;
    setTimeout(() => toast.remove(), 4000);
}

function makeDeviceNameInteractive(element, device) {
    element.classList.add('device-name-interactive');
    element.tabIndex = 0;
    element.title = '查看设备信息';
    const show = () => showDeviceDetailsToast(device, element);
    element.addEventListener('click', show);
    element.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            show();
        }
    });
}

function updateDeviceList() {
    const container = document.getElementById('deviceList');
    const count = state.devices.size + 1;
    const intercomRecipients = mediaController?.intercom?.recipients || [];
    const directIntercomTargetId = intercomRecipients.length === 1 ? intercomRecipients[0] : null;
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
    makeDeviceNameInteractive(selfEl.querySelector('.name'), {
        model: state.selfNetworkInfo?.deviceModel || state.deviceModel,
        internalIp: state.selfNetworkInfo?.internalIp || state.reportedLanIp,
        externalIp: state.selfNetworkInfo?.externalIp
    });
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
        makeDeviceNameInteractive(el.querySelector('.name'), device);
        const intercomButton = document.createElement('button');
        intercomButton.className = 'toolbar-btn';
        intercomButton.type = 'button';
        intercomButton.title = `与 ${device.name} 对讲`;
        intercomButton.textContent = device.id === directIntercomTargetId ? '关闭对讲' : '对讲机';
        intercomButton.addEventListener('click', async () => {
            try {
                if (device.id === directIntercomTargetId) {
                    mediaController.stopIntercom();
                } else {
                    if (mediaController.intercom) mediaController.stopIntercom();
                    await mediaController.startIntercom([device.id]);
                }
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
function setMobileWorkspaceView(view, options = {}) {
    if (!['chat', 'devices', 'editor'].includes(view)) return;
    const appShell = document.getElementById('appShell');
    if (!appShell) return;

    currentMobileWorkspaceView = view;
    appShell.dataset.mobileView = view;
    document.querySelectorAll('.mobile-workspace-button[data-mobile-view]').forEach(button => {
        const active = button.dataset.mobileView === view;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });

    if (options.log !== false) {
        historyLog('mobile-workspace-view-changed', { view });
    }
}

function initMobileWorkspace() {
    const viewButtons = Array.from(document.querySelectorAll('.mobile-workspace-button[data-mobile-view]'));
    viewButtons.forEach(button => {
        button.addEventListener('click', () => setMobileWorkspaceView(button.dataset.mobileView));
    });

    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const syncViewport = () => setMobileWorkspaceView(currentMobileWorkspaceView, { log: false });
    if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', syncViewport);
    else mediaQuery.addListener(syncViewport);
    syncViewport();
}

async function forceMobileRefresh() {
    const button = document.getElementById('mobileForceRefreshBtn');
    if (button?.disabled) return;
    button?.classList.add('is-refreshing');
    if (button) button.disabled = true;

    if (!navigator.onLine) {
        historyLog('mobile-force-refresh-offline-reload');
        window.location.reload();
        return;
    }

    const version = Date.now().toString(36);
    try {
        if ('serviceWorker' in navigator) {
            const registration = await navigator.serviceWorker.getRegistration();
            await registration?.update();
            [navigator.serviceWorker.controller, registration?.waiting, registration?.active]
                .filter(Boolean)
                .forEach(worker => worker.postMessage({ type: 'tunnel-force-refresh' }));
        }
        if ('caches' in window) {
            const cacheNames = await caches.keys();
            await Promise.all(cacheNames
                .filter(name => name.startsWith('instant-tunnel-'))
                .map(name => caches.delete(name)));
        }
    } catch (err) {
        historyLog('mobile-force-refresh-cache-clear-failed', { error: err.message });
    }

    historyLog('mobile-force-refresh-requested', { version });
    const target = new URL(window.location.href);
    target.searchParams.set('_reload', version);
    window.location.replace(target.href);
}

function initUI() {
    initMobileWorkspace();
    document.getElementById('leaveTunnelBtn').addEventListener('click', leaveTunnel);
    document.getElementById('mobileForceRefreshBtn').addEventListener('click', forceMobileRefresh);
    document.getElementById('joinShortCodeBtn').addEventListener('click', joinByShortCode);
    document.getElementById('shortCodeInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') joinByShortCode();
    });
    document.getElementById('clipboardShareBtn').addEventListener('click', toggleClipboardShare);
    document.getElementById('copySharedClipboardBtn').addEventListener('click', copySharedClipboard);
    document.getElementById('garbageCleanupBtn').addEventListener('click', showGarbageCleanupDialog);
    document.getElementById('resourceBrowserBtn').addEventListener('click', () => {
        showResourceBrowser().catch(err => {
            historyLog('resource-browser-open-failed', { error: err.message });
            alert(`无法打开资源浏览器: ${err.message}`);
        });
    });
    document.getElementById('folderUploadBtn').addEventListener('click', () => document.getElementById('folderInput').click());
    document.getElementById('folderInput').addEventListener('change', async event => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;
        try {
            await sendFolder(files);
        } catch (err) {
            alert(`文件夹发送失败：${err.message}`);
            historyLog('folder-archive-failed', { error: err.message });
        } finally {
            event.target.value = '';
        }
    });
    document.getElementById('directorySyncBtn').addEventListener('click', startDirectoryMirror);

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

    document.getElementById('closeFileDetailsBtn').addEventListener('click', closeFileDetails);
    document.getElementById('fileDetailsViewer').addEventListener('click', event => {
        if (event.target === event.currentTarget) closeFileDetails();
    });
    document.getElementById('downloadFileDetailsBtn').addEventListener('click', async () => {
        if (!activeFileDetailsMessageId) return;
        await downloadFileFromMessage(activeFileDetailsMessageId);
    });
    document.getElementById('closeFilePreviewBtn').addEventListener('click', closeFilePreview);
    document.getElementById('filePreviewViewer').addEventListener('click', event => {
        if (event.target === event.currentTarget) closeFilePreview();
    });

    document.getElementById('closeRichViewer').addEventListener('click', () => {
        closeRichViewer();
    });

    // 点击遮罩关闭
    document.getElementById('richViewer').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            closeRichViewer();
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
function showQueuedFileTransfer(fileId, queueLength, activeDownloads) {
    const messageEl = document.querySelector(`.message[data-file-id="${fileId}"]`);
    const fileName = messageEl?.dataset.fileName || '文件';
    showProgress(fileId, fileName, 0, `等待队列（进行中 ${activeDownloads}，排队 ${queueLength}）`);
}

async function updateShortCode(shortCode) {
    state.shortCode = normalizeLocalShortCode(shortCode);
    const element = document.getElementById('shortCode');
    if (element) element.textContent = state.shortCode || '-';
    if (!state.sessionId || !state.shortCode) return;
    const existing = await getFromStore('sessions', state.sessionId).catch(() => null);
    await saveToStore('sessions', {
        ...(existing || {}),
        sessionId: state.sessionId,
        deviceId: state.deviceId,
        shortCode: state.shortCode,
        lastActive: existing?.lastActive || Date.now()
    });
}

async function announceKnownSessionCodes() {
    const socket = state.socket;
    if (!socket?.connected) return;
    const sessions = await getAllFromStore('sessions').catch(() => []);
    const entries = sessions
        .map(session => ({
            sessionId: session.sessionId,
            shortCode: normalizeLocalShortCode(session.shortCode)
        }))
        .filter(entry => /^[a-zA-Z0-9_-]{8,64}$/.test(entry.sessionId || '') && entry.shortCode);

    if (state.sessionId && state.shortCode && !entries.some(entry => entry.sessionId === state.sessionId)) {
        entries.push({ sessionId: state.sessionId, shortCode: state.shortCode });
    }
    socket.emit('register-session-codes', { entries });
    historyLog('session-code-directory-announced', { entryCount: entries.length });
}

function joinByShortCode() {
    const input = document.getElementById('shortCodeInput');
    const shortCode = input.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(shortCode)) {
        alert('请输入 5 位字母或数字组成的隧道暗号。');
        return;
    }
    state.socket?.emit('join-by-short-code', { shortCode });
}

async function pollClipboard() {
    if (!state.clipboardShareEnabled || !navigator.clipboard?.readText) return;
    try {
        const text = await navigator.clipboard.readText();
        if (!text || text === lastClipboardText) return;
        lastClipboardText = text;
        state.socket?.emit('clipboard-update', { sessionId: state.sessionId, text });
        historyLog('clipboard-shared', { textLength: text.length });
    } catch (err) {
        historyLog('clipboard-read-failed', { error: err.message });
    }
}

async function toggleClipboardShare() {
    const button = document.getElementById('clipboardShareBtn');
    if (state.clipboardShareEnabled) {
        state.clipboardShareEnabled = false;
        clearInterval(clipboardShareTimer);
        clipboardShareTimer = null;
        button.textContent = '启用粘贴板共享';
        return;
    }
    if (!window.isSecureContext || !navigator.clipboard?.readText) {
        alert('粘贴板共享需要 HTTPS（或 localhost）以及浏览器粘贴板权限。');
        return;
    }
    state.clipboardShareEnabled = true;
    lastClipboardText = null;
    button.textContent = '关闭粘贴板共享';
    await pollClipboard();
    clipboardShareTimer = setInterval(pollClipboard, 1500);
}

function receiveSharedClipboard(data) {
    if (!data?.text || data.from === state.deviceId) return;
    state.remoteClipboardText = data.text;
    const notice = document.getElementById('clipboardNotice');
    const text = document.getElementById('clipboardNoticeText');
    text.textContent = `${data.deviceName || '设备'}：${data.text}`;
    notice.style.display = 'flex';
    historyLog('clipboard-received', { from: data.from, textLength: data.text.length });
}

async function copySharedClipboard() {
    if (!state.remoteClipboardText) return;
    try {
        await navigator.clipboard.writeText(state.remoteClipboardText);
    } catch (err) {
        alert(state.remoteClipboardText);
    }
}

async function sendFolder(files) {
    if (!files.length || !window.FolderArchive) return;
    const paths = Array.from(files, file => file.webkitRelativePath || file.name);
    const folderName = (paths[0] || 'folder').split('/')[0] || 'folder';
    const zipBlob = await window.FolderArchive.createZip(Array.from(files));
    const zipFile = new File([zipBlob], `${folderName}.zip`, { type: 'application/zip' });
    await sendFile(zipFile, null, {
        isFolderArchive: true,
        folderName,
        entryCount: files.length
    });
    historyLog('folder-archive-sent', { folderName, entryCount: files.length, size: zipFile.size });
}

async function collectDirectoryFiles(handle, prefix = '') {
    const files = [];
    for await (const [name, entry] of handle.entries()) {
        const path = `${prefix}${name}`;
        if (entry.kind === 'directory') {
            files.push(...await collectDirectoryFiles(entry, `${path}/`));
        } else if (entry.kind === 'file') {
            const file = await entry.getFile();
            files.push({
                name: file.name,
                path,
                size: file.size,
                lastModified: file.lastModified,
                arrayBuffer: () => file.arrayBuffer()
            });
        }
    }
    return files;
}

async function startDirectoryMirror() {
    const button = document.getElementById('directorySyncBtn');
    if (directoryMirror.handle) {
        clearInterval(directoryMirror.timer);
        directoryMirror.handle = null;
        directoryMirror.timer = null;
        directoryMirror.signature = '';
        button.textContent = '同步目录';
        return;
    }
    if (!window.showDirectoryPicker || !window.FolderArchive) {
        alert('目录镜像需要 Chromium 的 File System Access API。Firefox 和移动浏览器请使用“发送文件夹”。');
        return;
    }
    directoryMirror.handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    button.textContent = '关闭目录同步';
    await syncDirectoryMirror(true);
    directoryMirror.timer = setInterval(() => syncDirectoryMirror(false), 5000);
}

function getDirectorySignature(files) {
    return files
        .map(file => `${file.path}:${file.size}:${file.lastModified || 0}`)
        .sort()
        .join('|');
}

async function syncDirectoryMirror(force) {
    if (!directoryMirror.handle || directoryMirror.busy) return;
    directoryMirror.busy = true;
    try {
        const files = await collectDirectoryFiles(directoryMirror.handle);
        const signature = getDirectorySignature(files);
        if (!force && signature === directoryMirror.signature) return;
        directoryMirror.signature = signature;
        if (!force && signature === directoryMirror.skipSignature) {
            directoryMirror.skipSignature = '';
            return;
        }
        if (!files.length) return;
        const archive = await window.FolderArchive.createZip(files);
        const archiveFile = new File([archive], `${directoryMirror.handle.name}-snapshot.zip`, { type: 'application/zip' });
        await sendFile(archiveFile, null, {
            isFolderArchive: true,
            isDirectoryMirror: true,
            folderName: directoryMirror.handle.name,
            entryCount: files.length,
            silent: true
        });
        historyLog('directory-mirror-snapshot-sent', {
            directoryName: directoryMirror.handle.name, entryCount: files.length, size: archiveFile.size
        });
    } catch (err) {
        historyLog('directory-mirror-sync-failed', { error: err.message });
    } finally {
        directoryMirror.busy = false;
    }
}

async function applyDirectoryMirrorAsset(asset) {
    if (!directoryMirror.handle || asset.folderName !== directoryMirror.handle.name || !window.FolderArchive) return;
    directoryMirror.busy = true;
    try {
        const entries = await window.FolderArchive.extractZip(new Blob([asset.data], { type: asset.type }));
        for (const entry of entries) {
            const parts = entry.path.split('/').filter(part => part && part !== '.' && part !== '..');
            if (!parts.length) continue;
            const fileName = parts.pop();
            let parent = directoryMirror.handle;
            for (const part of parts) parent = await parent.getDirectoryHandle(part, { create: true });
            const fileHandle = await parent.getFileHandle(fileName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(entry.data);
            await writable.close();
        }
        const files = await collectDirectoryFiles(directoryMirror.handle);
        directoryMirror.signature = getDirectorySignature(files);
        directoryMirror.skipSignature = directoryMirror.signature;
        historyLog('directory-mirror-applied', { assetId: asset.id, entryCount: entries.length, folderName: asset.folderName });
    } catch (err) {
        historyLog('directory-mirror-apply-failed', { assetId: asset.id, error: err.message });
    } finally {
        directoryMirror.busy = false;
    }
}

function showProgress(fileId, fileName, progress, status = '') {
    const container = document.getElementById('transferProgress');
    const list = document.getElementById('progressList');
    const elementId = progressElementId(fileId);

    container.style.display = 'block';

    let item = document.getElementById(elementId);
    if (!item) {
        item = document.createElement('div');
        item.id = elementId;
        item.className = 'progress-item';
        item.innerHTML = `
            <div class="progress-info">
                <span>${fileName}</span>
                <span class="progress-text">${progress}%${status ? ` · ${status}` : ''}</span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${progress}%"></div>
            </div>
        `;
        list.appendChild(item);
    } else {
        updateProgress(fileId, progress, status);
    }
}

function updateProgress(fileId, progress, status = '') {
    const item = document.getElementById(progressElementId(fileId));
    if (item) {
        item.querySelector('.progress-text').textContent = `${progress}%${status ? ` · ${status}` : ''}`;
        item.querySelector('.progress-fill').style.width = `${progress}%`;
    }
}

function hideProgress(fileId) {
    activeFileProgress.delete(fileId);
    const timer = progressHideTimers.get(fileId);
    if (timer) {
        clearTimeout(timer);
        progressHideTimers.delete(fileId);
    }

    const item = document.getElementById(progressElementId(fileId));
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
function closeRichViewer(options = {}) {
    const viewer = document.getElementById('richViewer');
    if (!viewer?.classList.contains('active')) return;
    viewer.classList.remove('active');

    const shouldGoBack = richViewerHistoryOpen && !options.fromHistory &&
        history.state?.[RICH_VIEWER_HISTORY_KEY] === true;
    richViewerHistoryOpen = false;
    if (shouldGoBack) history.back();
}

window.addEventListener('popstate', () => {
    if (!richViewerHistoryOpen) return;
    richViewerHistoryOpen = false;
    closeRichViewer({ fromHistory: true });
});

async function viewRichContent(messageId) {
    const message = await getFromStore('messages', messageId);
    if (message && message.type === 'rich') {
        const container = document.getElementById('richViewerContent');
        container.innerHTML = message.content;
        await hydrateEditorAssets(container);
        const viewer = document.getElementById('richViewer');
        if (!viewer.classList.contains('active')) {
            const baseState = history.state && typeof history.state === 'object' ? history.state : {};
            history.pushState({ ...baseState, [RICH_VIEWER_HISTORY_KEY]: true }, '', window.location.href);
            richViewerHistoryOpen = true;
            viewer.classList.add('active');
        }
    }
}

// 暴露到全局
window.viewRichContent = viewRichContent;

// ==================== 文件下载 ====================
async function downloadFile(fileId) {
    const file = await getFromStore('files', fileId);
    if (!hasCompleteFileCache(file)) {
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
        const storedSession = await getFromStore('sessions', state.sessionId);
        await saveToStore('sessions', {
            ...(storedSession || {}),
            sessionId: state.sessionId,
            lastActive: Date.now(),
            lastJoinedAt: Date.now(),
            entryState: 'joined',
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
