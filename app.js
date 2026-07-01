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
    contacts: new Map(),
    activeContactCall: null,
    pendingTunnelInviteReceipt: null,
    recentSessionId: null,
    sessionRemark: '',
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
let fileAssetPresenceRefreshTimer = null;
let mediaController = null;
let currentMobileWorkspaceView = 'chat';
let richViewerHistoryOpen = false;
let filePreviewHistoryOpen = false;
let filePreviewNestedHistoryOpen = false;
let mediaFullscreenHistoryOpen = false;
let mediaFullscreenItems = [];
let mediaFullscreenIndex = 0;
let mediaFullscreenPointerStart = null;
let filePreviewPointerStart = null;
let mediaFullscreenMovedMedia = null;
let mediaFullscreenMovedParent = null;
let mediaFullscreenMovedNextSibling = null;
let mediaFullscreenMovedPlaceholder = null;
let progressDrawerCollapsed = true;
let progressDrawerDragState = null;
let progressDrawerSuppressClick = false;
let progressDrawerIgnoreItemClicksUntil = 0;
let progressDrawerBlockPageClicksUntil = 0;
let adminTapCount = 0;
let adminTapResetTimer = null;
let lastAdminTapAt = 0;
const RICH_VIEWER_HISTORY_KEY = 'tunnelRichViewer';
const FILE_PREVIEW_HISTORY_KEY = 'tunnelFilePreview';
const MEDIA_FULLSCREEN_HISTORY_KEY = 'tunnelMediaFullscreen';
const fileObjectUrls = new Map();
const pendingHistoryMessageIds = new Set();
let lastLocalHistoryTimestamp = 0;

function nextHistoryTimestamp() {
    const now = Date.now();
    lastLocalHistoryTimestamp = Math.max(now, lastLocalHistoryTimestamp + 1);
    return lastLocalHistoryTimestamp;
}

function getHistorySortValue(messageOrElement) {
    if (!messageOrElement) return { timestamp: 0, localOrder: 0, id: '' };
    if (messageOrElement.dataset) {
        return {
            timestamp: Number(messageOrElement.dataset.messageTimestamp || 0),
            localOrder: Number(messageOrElement.dataset.messageLocalOrder || 0),
            id: messageOrElement.dataset.messageId || ''
        };
    }
    return {
        timestamp: Number(messageOrElement.timestamp || 0),
        localOrder: Number(messageOrElement.localOrder || messageOrElement.fileInfo?.localOrder || 0),
        id: messageOrElement.id || ''
    };
}

function compareHistoryMessages(a, b) {
    const left = getHistorySortValue(a);
    const right = getHistorySortValue(b);
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
    if (left.localOrder !== right.localOrder) return left.localOrder - right.localOrder;
    return String(left.id).localeCompare(String(right.id));
}

let sessionHistoryQueue = Promise.resolve();
let sessionHistoryFallbackTimers = [];
let tunnelHeartbeatTimer = null;
let clipboardShareTimer = null;
let lastClipboardText = null;
let remoteAudioContext = null;
let sharedFileImportInProgress = false;
const completedFileProgress = new Set();
const activeFileProgress = new Set();
const progressHideTimers = new Map();
const progressUiLastPaint = new Map();
const progressQueueSnapshot = {
    queueLength: 0,
    activeDownloads: 0,
    updatedAt: 0,
    expireTimer: null
};
const PROGRESS_QUEUE_SNAPSHOT_TTL = 15000;
const fileTransferProgressStates = new Map();
const PROGRESS_UI_MIN_INTERVAL = 120;
const FORCE_RESTORE_PROGRESS_THRESHOLD = 30;
const FORCE_RESTORE_STALL_MS = 12000;
const HISTORY_RECONCILE_MESSAGE_LIMIT = 1000;
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

function getProgressBaseFileId(progressKey) {
    return String(progressKey || '').split('::')[0];
}

function cssEscape(value) {
    if (window.CSS?.escape) return CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
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

function trackFileReceiveProgress(fileId, fileName, progress, transport, progressKey) {
    const route = String(transport || '');
    if (!fileId || (!route.includes('receiving') && !route.startsWith('received'))) return;
    if (progress >= 100) {
        fileTransferProgressStates.delete(fileId);
        return;
    }

    const now = Date.now();
    const previous = fileTransferProgressStates.get(fileId);
    const progressed = !previous || progress > previous.progress;
    fileTransferProgressStates.set(fileId, {
        fileId,
        fileName,
        progress,
        transport: route,
        progressKey,
        updatedAt: now,
        lastProgressAt: progressed ? now : (previous.lastProgressAt || now)
    });
}

function getFileReceiveProgressState(fileId) {
    const progressState = fileTransferProgressStates.get(fileId);
    if (!progressState) return null;
    const staleForMs = Date.now() - progressState.updatedAt;
    return {
        ...progressState,
        staleForMs,
        stalled: staleForMs >= FORCE_RESTORE_STALL_MS
    };
}

function shouldBlockForceRestore(fileId) {
    const progressState = getFileReceiveProgressState(fileId);
    return progressState &&
        progressState.progress >= FORCE_RESTORE_PROGRESS_THRESHOLD &&
        !progressState.stalled;
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
    const collectionFiles = Array.isArray(message?.collection?.files) ? message.collection.files : [];
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
        } : undefined,
        collection: collectionFiles.length ? {
            id: message.collection?.id,
            count: collectionFiles.length,
            totalSize: collectionFiles.reduce((sum, file) => sum + (Number(file?.size) || 0), 0)
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
    try {
        await initStorage();
        registerServiceWorker();
        if (!await initSession()) {
            initSessionLanding();
            return;
        }
        await startTunnelApplication();
    } catch (err) {
        console.error('Application startup failed:', err);
        showStartupFailure(err);
    }
});

async function startTunnelApplication() {
    document.getElementById('appShell').hidden = false;
    document.getElementById('tunnelTopbar')?.removeAttribute('hidden');
    document.getElementById('leaveTunnelBtn').hidden = false;
    document.getElementById('mobileForceRefreshBtn').hidden = false;
    initFileAssetTransfer();
    initMediaController();
    initUI();
    initEditor();
    initDragDrop();
    await loadContacts();
    await loadSessionData();
    initSocket();
    initAssetPresenceRefresh();
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' }).catch(err => {
        console.warn('Service worker registration failed:', err);
    });
}

function showStartupFailure(err) {
    const message = err?.message || '未知错误';
    const shell = document.getElementById('appShell');
    const landing = document.getElementById('sessionLanding');
    if (shell) shell.hidden = true;
    if (landing) landing.hidden = true;
    const panel = document.createElement('div');
    panel.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:9999',
        'display:grid',
        'place-items:center',
        'padding:22px',
        'background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)',
        'color:#26324d'
    ].join(';');
    panel.innerHTML = `
        <div style="width:min(92vw,420px);border-radius:12px;background:#fff;padding:22px;box-shadow:0 18px 48px rgba(25,32,56,.24);text-align:center;">
            <h2 style="margin:0 0 10px;font-size:1.2rem;">页面启动失败</h2>
            <p style="margin:0 0 16px;color:#62708a;line-height:1.6;">可能是浏览器缓存了旧资源。请先强制刷新应用资源。</p>
            <pre style="max-height:120px;overflow:auto;margin:0 0 16px;padding:10px;border-radius:6px;background:#f4f6fb;color:#a13f3f;text-align:left;white-space:pre-wrap;">${escapeHtml(message)}</pre>
            <button id="startupForceRefreshBtn" style="min-height:40px;border:0;border-radius:6px;background:#667eea;color:#fff;padding:0 16px;font-weight:700;">强制刷新</button>
        </div>
    `;
    document.body.appendChild(panel);
    document.getElementById('startupForceRefreshBtn')?.addEventListener('click', async () => {
        try {
            if ('serviceWorker' in navigator) {
                const registration = await navigator.serviceWorker.getRegistration();
                await registration?.unregister();
            }
            if ('caches' in window) {
                const names = await caches.keys();
                await Promise.all(names.filter(name => name.startsWith('instant-tunnel-')).map(name => caches.delete(name)));
            }
        } catch (refreshErr) {
            console.warn('Startup force refresh cleanup failed:', refreshErr);
        }
        const target = new URL(window.location.href);
        target.searchParams.set('_reload', Date.now().toString(36));
        window.location.replace(target.href);
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
            contains: (name) => ['sessions', 'messages', 'files', 'editorContent', 'shareQueue', 'contacts'].includes(name)
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
        const request = indexedDB.open('TunnelDB', 4);

        request.onerror = (event) => {
            console.error('IndexedDB open error:', event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = (event) => {
            state.db = event.target.result;
            console.log('IndexedDB opened successfully, version:', state.db.version);
            
            // 检查是否所有必需的对象存储都存在
            const requiredStores = ['sessions', 'messages', 'files', 'editorContent', 'shareQueue', 'contacts'];
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
                const recreateRequest = indexedDB.open('TunnelDB', 4);
                
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

    if (!db.objectStoreNames.contains('contacts')) {
        const contactStore = db.createObjectStore('contacts', { keyPath: 'deviceId' });
        contactStore.createIndex('followedAt', 'followedAt', { unique: false });
        contactStore.createIndex('lastSeenAt', 'lastSeenAt', { unique: false });
    }
}

async function saveToStore(storeName, data) {
    if (storeName === 'files' && data?.id && !Object.hasOwn(data, 'data') && data.cacheCleared !== true) {
        const existing = await getFromStore('files', data.id).catch(() => null);
        if (hasCompleteFileCache(existing, data)) {
            data = {
                ...data,
                data: existing.data,
                cacheCleared: false,
                restoreRequested: false,
                transferInterrupted: false,
                isPartial: false
            };
        }
    }

    // 如果使用内存存储
    if (state.db._isMemory) {
        if (!memoryStorage.has(storeName)) {
            memoryStorage.set(storeName, new Map());
        }
        const key = data.id || data.sessionId || data.deviceId || Date.now();
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
        const inviteId = entryUrl.searchParams.get('invite');
        const inviteFrom = entryUrl.searchParams.get('from');
        if (inviteId && inviteFrom) {
            state.pendingTunnelInviteReceipt = {
                invitationId: inviteId,
                to: inviteFrom,
                sessionId: hash,
                link: window.location.href
            };
        }
        const storedSession = await getFromStore('sessions', state.sessionId).catch(() => null);
        state.shortCode = normalizeLocalShortCode(storedSession?.shortCode);
        state.sessionRemark = String(storedSession?.remark || '').trim().slice(0, 60);
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
        state.sessionRemark = String(recent.remark || '').trim().slice(0, 60);
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
    document.getElementById('tunnelTopbar')?.setAttribute('hidden', '');
    document.getElementById('leaveTunnelBtn').hidden = true;
    document.getElementById('mobileForceRefreshBtn').hidden = true;
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
        input.addEventListener('beforeinput', event => {
            if (event.inputType !== 'insertText' || !event.data) return;
            const value = event.data.toUpperCase().replace(/[^A-Z0-9]/g, '');
            event.preventDefault();
            if (!value) return;
            if (value.length > 1) {
                fillCode(value);
                return;
            }
            input.value = value;
            if (inputs[index + 1]) inputs[index + 1].focus();
        });
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

let qrCodeLibraryPromise = null;

function ensureQRCodeLibrary() {
    if (window.QRCode) return Promise.resolve(window.QRCode);
    if (qrCodeLibraryPromise) return qrCodeLibraryPromise;

    qrCodeLibraryPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const timer = setTimeout(() => {
            reject(new Error('QRCode library load timed out'));
        }, 10000);
        const finish = () => {
            clearTimeout(timer);
            if (window.QRCode) resolve(window.QRCode);
            else reject(new Error('QRCode library did not expose window.QRCode'));
        };
        script.src = '/client/qrcode-1.0.0.min.js';
        script.async = true;
        script.dataset.qrcodeRetry = 'true';
        script.onload = finish;
        script.onerror = () => {
            clearTimeout(timer);
            reject(new Error('QRCode library request failed'));
        };
        document.head.appendChild(script);
    }).catch(err => {
        qrCodeLibraryPromise = null;
        throw err;
    });

    return qrCodeLibraryPromise;
}

function renderQRCodeFallback(qrContainer, message) {
    qrContainer.innerHTML = '';
    const fallback = document.createElement('div');
    fallback.style.cssText = [
        'display:grid',
        'place-items:center',
        'width:180px',
        'min-height:180px',
        'padding:12px',
        'border:1px dashed rgba(102,126,234,.45)',
        'border-radius:10px',
        'background:#fff',
        'color:#526079',
        'font-size:.86rem',
        'line-height:1.5',
        'text-align:center',
        'word-break:break-all'
    ].join(';');
    fallback.textContent = message;
    qrContainer.appendChild(fallback);
}

function generateQRCode() {
    const qrContainer = document.getElementById('qrcode');
    if (!qrContainer) return;
    qrContainer.innerHTML = '';

    const currentUrl = window.location.href;
    if (!window.QRCode) {
        renderQRCodeFallback(qrContainer, '二维码加载中...');
        ensureQRCodeLibrary()
            .then(() => generateQRCode())
            .catch(err => {
                historyLog('qrcode-library-load-failed', { error: err.message });
                renderQRCodeFallback(qrContainer, `二维码暂不可用\n${currentUrl}`);
            });
        return;
    }

    try {
        new window.QRCode(qrContainer, {
            text: currentUrl,
            width: 180,
            height: 180,
            colorDark: '#667eea',
            colorLight: '#ffffff',
            correctLevel: window.QRCode.CorrectLevel?.M
        });
    } catch (err) {
        historyLog('qrcode-render-failed', { error: err.message });
        renderQRCodeFallback(qrContainer, `二维码暂不可用\n${currentUrl}`);
    }
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
        scheduleSessionHistoryFallbacks();
        startTunnelHeartbeat();
        state.debugLogReady = true;
        flushClientDebugLogs();
        announceStoredEditorAssets();
        announceStoredFileAssets();
        hydrateEditorAssets(document.getElementById('editor'));
        consumePendingSharedFiles().catch(err => {
            historyLog('shared-file-import-failed', { error: err.message });
        });
        flushPendingTunnelInvites();
        sendPendingTunnelInviteReceipt();
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
        window.location.href = `${window.location.origin}/wasted?sessionId=${encodeURIComponent(data.sessionId)}`;
    });
    state.socket.on('device-profile', data => {
        state.selfNetworkInfo = data || null;
        updateDeviceList();
    });
    state.socket.on('device-updated', handleDeviceUpdated);

    state.socket.on('session-short-code', (data) => {
        updateShortCode(data?.shortCode).catch(err => historyLog('short-code-persist-failed', { error: err.message }));
    });
    state.socket.on('session-remark', (data) => {
        updateSessionRemark(data?.remark || '').catch(err => historyLog('session-remark-persist-failed', { error: err.message }));
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

    state.socket.on('message-ack', (data) => {
        if (data?.messageId) pendingHistoryMessageIds.delete(data.messageId);
        historyLog('realtime-message-ack', {
            messageId: data?.messageId,
            stored: data?.stored,
            reason: data?.reason
        });
    });

    state.socket.on('message-deleted', (data) => {
        if (data?.messageId) {
            deleteHistoryMessageLocal(data.messageId).catch(err => {
                historyLog('message-delete-sync-failed', { messageId: data.messageId, error: err.message });
            });
        }
    });

    state.socket.on('message-updated', (data) => {
        if (data?.message) {
            applyHistoryMessageUpdate(data.message, { remote: true }).catch(err => {
                historyLog('message-update-sync-failed', {
                    messageId: data.message?.id,
                    error: err.message
                });
            });
        }
    });

    state.socket.on('session-history', (data) => {
        clearSessionHistoryFallbacks();
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
    state.socket.on('file-asset-transfer-status', (data) => fileAssetTransfer?.handleTransferStatus(data));
    state.socket.on('file-asset-discovery', (data) => handleFileAssetDiscovery(data));
    state.socket.on('file-asset-relay-start', (data, ack) => {
        Promise.resolve(fileAssetTransfer?.handleRelayStart(data))
            .then(result => ack?.(result || { ok: true }))
            .catch(err => {
                historyLog('file-asset-relay-start-failed', { error: err.message });
                ack?.({ ok: false, reason: err.message });
            });
    });
    state.socket.on('file-asset-relay-chunk', (data, ack) => {
        Promise.resolve(fileAssetTransfer?.handleRelayChunk(data))
            .then(result => ack?.(result || { ok: true }))
            .catch(err => {
                historyLog('file-asset-relay-chunk-failed', { error: err.message });
                ack?.({ ok: false, reason: err.message });
            });
    });
    state.socket.on('file-asset-relay-complete', (data, ack) => {
        Promise.resolve(fileAssetTransfer?.handleRelayComplete(data))
            .then(result => ack?.(result || { ok: true }))
            .catch(err => {
                historyLog('file-asset-relay-complete-failed', { error: err.message });
                ack?.({ ok: false, reason: err.message });
            });
    });
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
    state.socket.on('contact-call-request', handleIncomingContactCall);
    state.socket.on('contact-call-accepted', (data) => mediaController?.handleContactCallAccepted(data).catch(err => historyLog('contact-call-accept-failed', { error: err.message })));
    state.socket.on('contact-call-rejected', (data) => mediaController?.handleContactCallRejected(data));
    state.socket.on('contact-call-ended', (data) => mediaController?.handleContactCallEnded(data));
    state.socket.on('contact-media-signal', (data) => mediaController?.handleSignal(data).catch(err => historyLog('contact-media-signal-failed', { error: err.message })));
    state.socket.on('media-signal', (data) => mediaController?.handleSignal(data).catch(err => historyLog('media-signal-failed', { error: err.message })));
    state.socket.on('intercom-stop', (data) => mediaController?.handleIntercomStop(data));
    state.socket.on('device-tunnel-invite', handleDeviceTunnelInvite);
    state.socket.on('device-tunnel-invite-ack', handleDeviceTunnelInviteAck);

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
        stopTunnelHeartbeat();
        console.log('Socket disconnected');
        historyLog('socket-disconnected');
    });
}

function requestSessionHistory(reason = 'manual') {
    if (!state.socket?.connected || !state.sessionId) return;
    state.socket.emit('session-history-request', {
        sessionId: state.sessionId,
        deviceId: state.deviceId,
        reason
    });
    historyLog('snapshot-requested', { reason });
}

function clearSessionHistoryFallbacks() {
    sessionHistoryFallbackTimers.forEach(timer => clearTimeout(timer));
    sessionHistoryFallbackTimers = [];
}

function scheduleSessionHistoryFallbacks() {
    clearSessionHistoryFallbacks();
    [0, 3000, 12000].forEach((delay, index) => {
        const timer = setTimeout(() => {
            requestSessionHistory(index === 0 ? 'join-immediate' : `join-fallback-${index}`);
        }, delay);
        sessionHistoryFallbackTimers.push(timer);
    });
}

function sendTunnelHeartbeat(reason = 'interval') {
    if (!state.socket?.connected || !state.sessionId || !state.deviceId) return;
    state.socket.emit('tunnel-heartbeat', {
        sessionId: state.sessionId,
        deviceId: state.deviceId,
        deviceName: state.deviceName,
        deviceModel: state.deviceModel,
        localIp: state.reportedLanIp,
        reason
    });
    historyLog('tunnel-heartbeat-emitted', { reason, knownDeviceCount: state.devices.size });
}

function startTunnelHeartbeat() {
    stopTunnelHeartbeat();
    sendTunnelHeartbeat('join');
    tunnelHeartbeatTimer = setInterval(() => sendTunnelHeartbeat('interval'), 15000);
}

function stopTunnelHeartbeat() {
    if (tunnelHeartbeatTimer) clearInterval(tunnelHeartbeatTimer);
    tunnelHeartbeatTimer = null;
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
        const assetType = String(asset.type || '');
        if (!assetType.startsWith('image/')) {
            historyLog('editor-asset-invalid-mime', {
                assetId,
                storedType: asset.type,
                storedSessionId: asset.sessionId,
                size: asset.data.byteLength || asset.size
            });
            setEditorAssetStatus(assetId, '图片暂时不可用（资源类型异常）', 'unavailable');
            return;
        }
        historyLog('editor-asset-cache-hit', {
            assetId,
            storedSessionId: asset.sessionId,
            size: asset.data.byteLength || asset.size
        });
        let url = editorAssetUrls.get(assetId);
        if (!url) {
            url = URL.createObjectURL(new Blob([asset.data], { type: assetType }));
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
            trackFileReceiveProgress(fileId, fileName, progress, route, progressKey);
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
            const now = Date.now();
            const lastPaintAt = progressUiLastPaint.get(progressKey) || 0;
            const shouldPaintProgress = terminal || progress === 0 ||
                now - lastPaintAt >= PROGRESS_UI_MIN_INTERVAL ||
                !document.getElementById(progressElementId(progressKey));
            if (shouldPaintProgress) {
                showProgress(progressKey, fileName, progress, status, { route });
                progressUiLastPaint.set(progressKey, now);
            }
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
            hideCompletedFileReceiveProgress(asset.id);
            if (asset.isDirectoryMirror) await applyDirectoryMirrorAsset(asset);
            else await refreshFileMessage(asset.id);
        },
        onUnavailable: (fileId, reason) => {
            hideCompletedFileReceiveProgress(fileId);
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
        },
        getContactSelfProfile: () => getSelfContactProfile(),
        onContactCallState: updateContactCallOverlay
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

async function unlockRemoteAudioPlayback() {
    try {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (AudioContextCtor) {
            if (!remoteAudioContext) remoteAudioContext = new AudioContextCtor();
            if (remoteAudioContext.state === 'suspended') await remoteAudioContext.resume();
        }
    } catch (err) {
        historyLog('remote-audio-context-unlock-failed', { error: err.message });
    }

    const audioElements = Array.from(document.querySelectorAll('#remoteAudio audio'));
    await Promise.all(audioElements.map(audio => audio.play().catch(() => {})));
    document.getElementById('remoteAudioUnlockBtn')?.remove();
}

function showRemoteAudioUnlockButton(reason = '') {
    const container = document.getElementById('remoteAudio');
    if (!container || document.getElementById('remoteAudioUnlockBtn')) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'remoteAudioUnlockBtn';
    button.className = 'remote-audio-unlock';
    button.textContent = '启用声音';
    button.title = reason || '浏览器阻止了自动播放，点击后播放对讲音频';
    button.addEventListener('click', () => {
        unlockRemoteAudioPlayback().catch(err => historyLog('remote-audio-unlock-click-failed', { error: err.message }));
    });
    container.appendChild(button);
}

function shouldShowPersistentAudioUnlock() {
    return /iPhone|iPad|iPod|MicroMessenger|OPR\//i.test(navigator.userAgent || '');
}

function initRemoteAudioUnlock() {
    const unlock = () => {
        unlockRemoteAudioPlayback().catch(err => historyLog('remote-audio-unlock-failed', { error: err.message }));
    };
    ['pointerdown', 'touchend', 'keydown'].forEach(eventName => {
        window.addEventListener(eventName, unlock, { passive: true });
    });
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
        audio.setAttribute('webkit-playsinline', '');
        container.appendChild(audio);
    }
    audio.muted = false;
    audio.volume = 1;
    audio.srcObject = stream;
    if (shouldShowPersistentAudioUnlock()) {
        showRemoteAudioUnlockButton('移动浏览器可能需要点按一次才能播放对讲声音');
    }
    audio.play()
        .then(() => document.getElementById('remoteAudioUnlockBtn')?.remove())
        .catch(err => {
            historyLog('remote-audio-play-blocked', { kind, sessionKey, peerId, error: err.message });
            showRemoteAudioUnlockButton(err.message);
        });
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

async function handleFileAssetDiscovery(data) {
    const { assetId, from, reason } = data || {};
    if (!fileAssetTransfer || !assetId || from === state.deviceId) return;
    try {
        const file = await getFromStore('files', assetId);
        const isCachedChatAsset = hasCompleteFileCache(file, file) && (file.isFileAsset || (!file.isEditorAsset && file.ownerDeviceId));
        if (!isCachedChatAsset) return;
        const asset = {
            ...file,
            isFileAsset: true,
            ownerDeviceId: file.ownerDeviceId || state.deviceId
        };
        await fileAssetTransfer.announce(asset);
        historyLog('file-asset-discovery-announced', {
            fileId: assetId,
            requesterDeviceId: from,
            reason
        });
    } catch (err) {
        historyLog('file-asset-discovery-announce-failed', {
            fileId: assetId,
            requesterDeviceId: from,
            reason,
            error: err.message
        });
    }
}

function scheduleStoredFileAssetAnnounce(reason, delay = 700) {
    if (fileAssetPresenceRefreshTimer) return;
    fileAssetPresenceRefreshTimer = setTimeout(() => {
        fileAssetPresenceRefreshTimer = null;
        if (!state.socket?.connected) return;
        announceStoredFileAssets().catch(err => historyLog('file-asset-presence-refresh-failed', {
            reason,
            error: err.message
        }));
        historyLog('file-asset-presence-refresh-requested', { reason });
    }, delay);
}

function initAssetPresenceRefresh() {
    let lastRefreshAt = 0;
    const refresh = (reason, options = {}) => {
        if (document.hidden && !options.allowHidden) return;
        if (!state.socket?.connected) return;
        const now = Date.now();
        if (now - lastRefreshAt < 5000) return;
        lastRefreshAt = now;
        announceStoredFileAssets().catch(err => historyLog('file-asset-presence-refresh-failed', {
            reason,
            error: err.message
        }));
        historyLog('file-asset-presence-refresh-requested', { reason });
    };
    document.addEventListener('visibilitychange', () => refresh('visibilitychange'));
    window.addEventListener('pageshow', () => refresh('pageshow'));
    window.addEventListener('focus', () => refresh('window-focus'));
    setInterval(() => refresh('presence-heartbeat', { allowHidden: true }), 30000);
}

async function sendFile(file, targetDeviceId = null, options = {}) {
    const { asset, fileInfo } = await createFileAsset(file, options);
    await saveToStore('files', asset);
    await fileAssetTransfer.announce(asset);

    if (options.collectionMessageId) {
        return fileInfo;
    }

    if (options.silent) {
        state.socket.emit('directory-mirror-asset', { sessionId: state.sessionId, assetId: fileInfo.id });
        historyLog('directory-mirror-asset-emitted', { assetId: fileInfo.id, folderName: options.folderName, entryCount: options.entryCount });
        return fileInfo.id;
    }

    const message = {
        id: generateId(),
        type: 'file',
        fileInfo: {
            ...fileInfo,
            ownerDeviceId: state.deviceId,
            isAsset: true
        },
        timestamp: nextHistoryTimestamp(),
        sender: state.deviceId,
        senderName: state.deviceName
    };

    await publishHistoryMessage(message);
    historyLog('file-asset-message-emitted', {
        message: summarizeHistoryMessage(message),
        targetDeviceId
    });

    return fileInfo.id;
}

function waitForMediaEvent(element, eventName, timeout = 8000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => cleanup(() => reject(new Error(`${eventName}-timeout`))), timeout);
        const cleanup = (done) => {
            clearTimeout(timer);
            element.removeEventListener(eventName, onEvent);
            element.removeEventListener('error', onError);
            done();
        };
        const onEvent = () => cleanup(resolve);
        const onError = () => cleanup(() => reject(new Error(`${eventName}-error`)));
        element.addEventListener(eventName, onEvent, { once: true });
        element.addEventListener('error', onError, { once: true });
    });
}

async function createVideoPosterFromBlob(blob, options = {}) {
    if (!blob || !String(blob.type || '').toLowerCase().startsWith('video/')) return '';
    if (typeof document === 'undefined') return '';
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = url;
    try {
        await waitForMediaEvent(video, 'loadedmetadata', options.metadataTimeout || 9000);
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        if (duration > 0.4) {
            video.currentTime = Math.min(Math.max(0.12, duration * 0.08), Math.max(0.12, duration - 0.1));
            await waitForMediaEvent(video, 'seeked', options.seekTimeout || 9000).catch(() => {});
        } else {
            await waitForMediaEvent(video, 'loadeddata', options.dataTimeout || 9000).catch(() => {});
        }
        const width = video.videoWidth || 320;
        const height = video.videoHeight || 180;
        const maxSide = options.maxSide || 480;
        const scale = Math.min(1, maxSide / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d');
        if (!context) return '';
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', options.quality || 0.72);
    } finally {
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
    }
}

async function ensureVideoPosterCache(storedFile, fileInfo = {}) {
    const type = String(fileInfo.type || storedFile?.type || '').toLowerCase();
    if (!type.startsWith('video/') || !hasCompleteFileCache(storedFile, fileInfo)) return '';
    if (storedFile.videoPoster) return storedFile.videoPoster;
    const poster = await createVideoPosterFromBlob(new Blob([storedFile.data], { type }))
        .catch(err => {
            historyLog('video-poster-cache-failed', {
                fileId: fileInfo.id || storedFile.id,
                fileName: fileInfo.name || storedFile.name,
                error: err.message
            });
            return '';
        });
    if (!poster) return '';
    await saveToStore('files', {
        ...storedFile,
        videoPoster: poster
    });
    return poster;
}

async function createFileAsset(file, options = {}) {
    const {
        fileId: optionFileId,
        silent,
        collectionMessageId,
        ...metadataOptions
    } = options;
    const fileId = optionFileId || generateId();
    const fileInfo = {
        id: fileId,
        name: file.name,
        size: file.size,
        type: file.type,
        timestamp: nextHistoryTimestamp(),
        sender: state.deviceId,
        senderName: state.deviceName,
        ...metadataOptions
    };

    const [data, videoPoster] = await Promise.all([
        fileToArrayBuffer(file),
        createVideoPosterFromBlob(file).catch(err => {
            historyLog('video-poster-create-failed', {
                fileName: file.name,
                fileSize: file.size,
                error: err.message
            });
            return '';
        })
    ]);
    const asset = {
        ...fileInfo,
        sessionId: state.sessionId,
        ownerDeviceId: state.deviceId,
        isFileAsset: true,
        ...(videoPoster ? { videoPoster } : {}),
        data
    };
    return {
        asset,
        fileInfo: {
            ...fileInfo,
            ownerDeviceId: state.deviceId,
            isAsset: true
        }
    };
}

async function sendFileCollection(files, options = {}) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    if (list.length === 1) {
        await sendFile(list[0], null, options);
        return;
    }

    const collectionId = generateId();
    const fileInfos = [];
    for (const file of list) {
        fileInfos.push(await sendFile(file, null, {
            ...options,
            collectionId,
            collectionMessageId: collectionId
        }));
    }

    const totalSize = fileInfos.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    const message = {
        id: generateId(),
        type: 'collection',
        collection: {
            id: collectionId,
            files: fileInfos,
            count: fileInfos.length,
            totalSize
        },
        timestamp: nextHistoryTimestamp(),
        sender: state.deviceId,
        senderName: state.deviceName
    };

    await publishHistoryMessage(message);
    historyLog('file-collection-message-emitted', {
        messageId: message.id,
        collectionId,
        fileCount: fileInfos.length,
        totalSize
    });
}

function askFileCollectionMode(files) {
    const list = Array.from(files || []);
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'send-mode-overlay';
        overlay.innerHTML = `
            <div class="send-mode-dialog" role="dialog" aria-modal="true" aria-label="多文件发送方式">
                <h3>发送 ${list.length} 个文件</h3>
                <p>以合辑发送会在传输记录里合并成一条，方便预览和批量保存；拆分发送则保持每个文件一条记录。</p>
                <div class="send-mode-actions">
                    <button class="btn btn-secondary" type="button" data-mode="split">拆分成多条</button>
                    <button class="btn btn-primary" type="button" data-mode="collection">以合辑发送</button>
                </div>
            </div>
        `;
        const finish = mode => {
            overlay.remove();
            resolve(mode);
        };
        overlay.addEventListener('click', event => {
            if (event.target === overlay) finish('split');
            const button = event.target.closest('[data-mode]');
            if (button) finish(button.dataset.mode);
        });
        document.body.appendChild(overlay);
        overlay.querySelector('[data-mode="collection"]')?.focus();
    });
}

async function sendSelectedFiles(files, options = {}) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    if (list.length === 1) {
        await sendFile(list[0], null, options);
        return;
    }

    const mode = await askFileCollectionMode(list);
    if (mode === 'collection') {
        await sendFileCollection(list, options);
        return;
    }
    for (const file of list) {
        await sendFile(file, null, options);
    }
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

        const existingMessage = await findCurrentSessionMessageByFileId(fileInfo.id);
        if (existingMessage) {
            await refreshFileMessage(fileInfo.id);
            historyLog('p2p-file-message-reused-locally', {
                message: summarizeHistoryMessage(existingMessage),
                emittedToSocketHistory: false
            });
        } else {
            // 添加消息到聊天记录
            const message = {
                id: generateId(),
                type: 'file',
                fileInfo: {
                    ...fileInfo,
                    isP2P: true
                },
                timestamp: nextHistoryTimestamp(),
                sender: state.deviceId,
                senderName: state.deviceName
            };

            await addMessageToChat(message, true, { forceScroll: true });

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
        }
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

                    const existingMessage = await findCurrentSessionMessageByFileId(msg.fileId);
                    if (existingMessage) {
                        await refreshFileMessage(msg.fileId);
                    } else {
                        // 添加消息
                        const message = {
                            id: generateId(),
                            type: 'file',
                            fileInfo: transfer.fileInfo,
                            timestamp: nextHistoryTimestamp(),
                            sender: transfer.from,
                            senderName: state.devices.get(transfer.from)?.name || '未知设备'
                        };

                        await addMessageToChat(message, false);
                        await saveToStore('messages', {
                            ...message,
                            sessionId: state.sessionId
                        });
                    }

                    hideProgress(msg.fileId);
                    fileTransfers.delete(msg.fileId);
                    console.log('File receive and save complete');
                    historyLog('p2p-file-message-stored-on-receiver', {
                        message: summarizeHistoryMessage(existingMessage || { type: 'file', fileInfo: transfer.fileInfo, sender: transfer.from }),
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

function shouldAutoRequestFileAssetCache(storedFile, fileInfo) {
    return fileInfo?.isAsset &&
        !hasCompleteFileCache(storedFile, fileInfo) &&
        (!storedFile?.cacheCleared || storedFile.restoreRequested);
}

async function fetchServerAssetCache(fileInfo, reason = '') {
    if (!fileInfo?.id || !fileInfo.serverAssetUrl) return false;
    const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
    if (hasCompleteFileCache(storedFile, fileInfo) && !storedFile?.cacheCleared) return true;
    if (storedFile?.cacheCleared && !storedFile.restoreRequested) return false;

    const response = await fetch(fileInfo.serverAssetUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`server-asset-fetch-${response.status}`);
    const buffer = await response.arrayBuffer();
    const nextFile = {
        ...(storedFile || {}),
        id: fileInfo.id,
        name: fileInfo.name,
        type: fileInfo.type || 'application/octet-stream',
        size: Number(fileInfo.size) || buffer.byteLength,
        sessionId: state.sessionId,
        ownerDeviceId: fileInfo.ownerDeviceId || fileInfo.sender || '',
        isFileAsset: true,
        isServerAsset: true,
        serverAssetUrl: fileInfo.serverAssetUrl,
        data: buffer,
        timestamp: fileInfo.timestamp || Date.now(),
        cacheCleared: false,
        restoreRequested: false,
        transferInterrupted: false,
        isPartial: false
    };
    const videoPoster = await ensureVideoPosterCache(nextFile, fileInfo);
    if (videoPoster) nextFile.videoPoster = videoPoster;
    await saveToStore('files', nextFile);
    fileObjectUrls.delete(fileInfo.id);
    await refreshFileMessage(fileInfo.id);
    historyLog('server-asset-cache-fetched', {
        reason,
        fileId: fileInfo.id,
        fileName: fileInfo.name,
        size: nextFile.size
    });
    return true;
}

async function requestMissingFileAssetCache(message, reason) {
    const fileInfo = message?.fileInfo;
    if (fileInfo?.isServerAsset && fileInfo.serverAssetUrl) {
        await fetchServerAssetCache(fileInfo, reason).catch(err => historyLog('server-asset-cache-fetch-failed', {
            reason,
            message: summarizeHistoryMessage(message),
            error: err.message
        }));
        return;
    }
    if (!fileAssetTransfer || !fileInfo?.id || !fileInfo.isAsset) return;
    const storedFile = await getFromStore('files', fileInfo.id);
    if (!shouldAutoRequestFileAssetCache(storedFile, fileInfo)) return;
    await fileAssetTransfer.request(
        fileInfo.id,
        fileInfo.ownerDeviceId || message.sender,
        fileInfo
    );
    historyLog('file-asset-cache-backfill-requested', {
        reason,
        message: summarizeHistoryMessage(message)
    });
}

async function requestMissingCollectionAssetCaches(message, reason) {
    const files = getCollectionFiles(message);
    for (const fileInfo of files) {
        if (fileInfo?.isServerAsset && fileInfo.serverAssetUrl) {
            await fetchServerAssetCache(fileInfo, reason).catch(err => historyLog('collection-server-asset-cache-fetch-failed', {
                reason,
                messageId: message?.id,
                fileId: fileInfo.id,
                error: err.message
            }));
            continue;
        }
        if (!fileAssetTransfer) continue;
        if (!fileInfo?.id || !fileInfo.isAsset) continue;
        const storedFile = await getFromStore('files', fileInfo.id);
        if (!shouldAutoRequestFileAssetCache(storedFile, fileInfo)) continue;
        await fileAssetTransfer.request(
            fileInfo.id,
            fileInfo.ownerDeviceId || message.sender,
            fileInfo
        ).catch(err => historyLog('collection-asset-cache-request-failed', {
            reason,
            messageId: message?.id,
            fileId: fileInfo.id,
            error: err.message
        }));
    }
    historyLog('collection-asset-cache-backfill-requested', {
        reason,
        messageId: message?.id,
        fileCount: files.length
    });
}

async function handleMessage(data) {
    const { message } = data;
    if (!message || typeof message.id !== 'string') return;

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
    const existing = await getFromStore('messages', message.id).catch(() => null);
    if (existing && existing.sessionId === state.sessionId) {
        if (!getMessageElement(message.id)) {
            await addMessageToChat(existing, existing.sender === state.deviceId, { autoRequestAsset: false });
        }
        if (message.type === 'file' && (message.fileInfo?.isAsset || message.fileInfo?.isServerAsset)) {
            await requestMissingFileAssetCache(message, 'realtime-duplicate');
        }
        if (message.type === 'collection') {
            await requestMissingCollectionAssetCaches(existing, 'realtime-collection-duplicate');
        }
        historyLog('realtime-message-skipped', {
            reason: 'already-in-indexeddb',
            message: summarizeHistoryMessage(message)
        });
        return;
    }

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

    await addMessageToChat(message, false, { autoRequestAsset: false });
    historyLog('realtime-message-rendered', {
        message: summarizeHistoryMessage(message)
    });

    if (message.type === 'file' && message.fileInfo?.isServerAsset) {
        await requestMissingFileAssetCache(message, 'realtime-server-asset');
    } else if (message.type === 'file' && message.fileInfo?.isAsset) {
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
    if (message.type === 'collection') {
        await requestMissingCollectionAssetCaches(message, 'realtime-collection');
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

    const messages = [...data.messages].sort(compareHistoryMessages);
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
                if (isAuthoritativeHistoryMessageChanged(existing, message)) {
                    await applyHistoryMessageUpdate(message, {
                        remote: true,
                        snapshot: true
                    });
                    historyLog('snapshot-message-updated', {
                        reason: 'authoritative-message-changed',
                        message: summarizeHistoryMessage(message)
                    });
                } else if (!getMessageElement(message.id)) {
                    await addMessageToChat(existing, existing.sender === state.deviceId, { autoRequestAsset: false });
                    historyLog('snapshot-message-rendered', {
                        reason: 'existing-not-rendered',
                        message: summarizeHistoryMessage(existing)
                    });
                }
                if (message.type === 'file' && (message.fileInfo?.isAsset || message.fileInfo?.isServerAsset)) {
                    await requestMissingFileAssetCache(message, 'snapshot-duplicate');
                }
                if (message.type === 'collection') {
                    await requestMissingCollectionAssetCaches(message, 'snapshot-collection-duplicate');
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
            if (message.type === 'file' && (message.fileInfo?.isAsset || message.fileInfo?.isServerAsset)) {
                await requestMissingFileAssetCache(message, 'snapshot-new');
            }
            if (message.type === 'collection') {
                await requestMissingCollectionAssetCaches(message, 'snapshot-collection-new');
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

    reorderRenderedMessages();

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

async function findCurrentSessionMessageByFileId(fileId) {
    if (!fileId) return null;
    const messages = await getCurrentSessionMessages();
    return messages.find(message => message?.type === 'file' && message.fileInfo?.id === fileId) ||
        messages.find(message => message?.type === 'collection' && getCollectionFiles(message).some(file => file.id === fileId)) ||
        null;
}

function createHistoryReconcileMessage(message) {
    const copy = JSON.parse(JSON.stringify(message));
    delete copy.sessionId;
    if (copy.fileInfo) delete copy.fileInfo.data;
    if (Array.isArray(copy.collection?.files)) {
        copy.collection.files.forEach(file => {
            if (file && typeof file === 'object') delete file.data;
        });
    }
    return copy;
}

function isAuthoritativeHistoryMessageChanged(existing, incoming) {
    if (!existing || !incoming || existing.id !== incoming.id) return false;
    return JSON.stringify(createHistoryReconcileMessage(existing)) !==
        JSON.stringify(createHistoryReconcileMessage(incoming));
}

async function reconcileLocalHistory(serverMessages, deletedMessageIds) {
    if (!state.socket?.connected) return;
    const deletedIds = new Set(Array.isArray(deletedMessageIds) ? deletedMessageIds : []);
    const localMessages = await getCurrentSessionMessages();
    const messages = localMessages
        .filter(message => message?.id && !deletedIds.has(message.id))
        .sort(compareHistoryMessages)
        .slice(-HISTORY_RECONCILE_MESSAGE_LIMIT)
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
    let retainedMissingCount = 0;

    for (const message of localMessages) {
        if (!message?.id || canonicalIds.has(message.id) || pendingHistoryMessageIds.has(message.id)) continue;
        if (deletedIds.has(message.id)) {
            await deleteHistoryMessageLocal(message.id);
            removedCount++;
        } else {
            retainedMissingCount++;
        }
    }
    messages.forEach(message => pendingHistoryMessageIds.delete(message?.id));
    historyLog('history-canonical-applied', {
        canonicalMessageCount: canonicalIds.size,
        removedCount,
        retainedMissingCount
    });
}

function isChatNearBottom(container) {
    return !container || container.scrollHeight - container.scrollTop - container.clientHeight < 120;
}

function getMessageElement(messageId) {
    if (!messageId) return null;
    return Array.from(document.querySelectorAll('.message[data-message-id]'))
        .find(element => element.dataset.messageId === messageId) || null;
}

function preserveChatScroll(callback) {
    const container = document.getElementById('chatMessages');
    if (!container) return callback();

    const wasNearBottom = isChatNearBottom(container);
    const distanceFromBottom = container.scrollHeight - container.scrollTop;
    const restore = () => {
        if (wasNearBottom) {
            container.scrollTop = container.scrollHeight;
        } else {
            container.scrollTop = Math.max(0, container.scrollHeight - distanceFromBottom);
        }
    };
    const result = callback();
    requestAnimationFrame(restore);
    return result;
}

function insertMessageElementByTimestamp(container, messageEl) {
    const messages = Array.from(container.querySelectorAll('.message'));
    const next = messages.find(element => compareHistoryMessages(element, messageEl) > 0);
    if (next) {
        container.insertBefore(messageEl, next);
    } else {
        container.appendChild(messageEl);
    }
}

function reorderRenderedMessages(container = document.getElementById('chatMessages')) {
    if (!container) return;
    const messages = Array.from(container.querySelectorAll('.message'));
    if (messages.length < 2) return;
    const ordered = [...messages].sort(compareHistoryMessages);
    const alreadyOrdered = ordered.every((element, index) => element === messages[index]);
    if (alreadyOrdered) return;
    preserveChatScroll(() => {
        const fragment = document.createDocumentFragment();
        ordered.forEach(element => fragment.appendChild(element));
        container.appendChild(fragment);
    });
}

function getCollectionFiles(message) {
    return Array.isArray(message?.collection?.files) ? message.collection.files.filter(file => file?.id) : [];
}

async function createCollectionTileHtml(fileInfo, index, total) {
    const type = String(fileInfo.type || '').toLowerCase();
    let body = `<span>${getFileIcon(fileInfo.type || '')}</span>`;
    const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
    if (hasCompleteFileCache(storedFile, fileInfo)) {
        const resolvedType = String(fileInfo.type || storedFile.type || '').toLowerCase();
        if (resolvedType.startsWith('image/')) {
            const url = getStoredFileUrl(fileInfo.id, storedFile);
            body = `<img src="${url}" alt="${escapeHtml(fileInfo.name || '')}" loading="lazy" decoding="async">`;
        } else if (resolvedType.startsWith('video/')) {
            const poster = await ensureVideoPosterCache(storedFile, fileInfo);
            body = poster
                ? `<img src="${poster}" alt="${escapeHtml(fileInfo.name || '')}" loading="lazy" decoding="async">`
                : `<span class="collection-video-placeholder" aria-label="视频文件">🎬</span>`;
        } else if (resolvedType.startsWith('audio/')) {
            body = `<span class="collection-video-placeholder" aria-label="音频文件">🎵</span>`;
        }
    } else if (type.startsWith('video/')) {
        body = `<span class="collection-video-placeholder" aria-label="视频文件">🎬</span>`;
    } else if (type.startsWith('audio/')) {
        body = `<span class="collection-video-placeholder" aria-label="音频文件">🎵</span>`;
    }
    const remaining = total > 4 && index === 3 ? `<span class="collection-more">更多文件...<br>+${total - 3}</span>` : '';
    return `<div class="collection-preview-tile">${body}${remaining}</div>`;
}

async function renderCollectionPreviewHtml(message) {
    const files = getCollectionFiles(message);
    const visible = files.slice(0, Math.min(files.length, 4));
    const tiles = [];
    for (let index = 0; index < visible.length; index++) {
        tiles.push(await createCollectionTileHtml(visible[index], index, files.length));
    }
    const totalSize = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    return `
        <div class="message-bubble collection-message">
            <div class="collection-preview">${tiles.join('')}</div>
            <div class="collection-meta">${files.length} 个文件 · ${formatFileSize(totalSize)}</div>
        </div>
    `;
}

async function addMessageToChat(message, isOwn, options = {}) {
    const container = document.getElementById('chatMessages');
    const shouldScroll = options.forceScroll || (options.scroll !== false && isChatNearBottom(container));
    const existingElement = getMessageElement(message?.id);
    if (existingElement) {
        if (shouldScroll) container.scrollTop = container.scrollHeight;
        historyLog('message-render-skipped', {
            reason: 'already-rendered',
            message: summarizeHistoryMessage(message)
        });
        return existingElement;
    }
    const existingFileElement = message?.type === 'file' && message.fileInfo?.id
        ? Array.from(container.querySelectorAll('.message[data-file-id]'))
            .find(element => element.dataset.fileId === message.fileInfo.id)
        : null;
    if (existingFileElement) {
        if (shouldScroll) container.scrollTop = container.scrollHeight;
        historyLog('message-render-skipped', {
            reason: 'file-already-rendered',
            message: summarizeHistoryMessage(message)
        });
        return existingFileElement;
    }

    // 移除空状态
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const messageEl = document.createElement('div');
    messageEl.className = `message ${isOwn ? 'own' : ''}`;
    messageEl.dataset.messageId = message.id;
    messageEl.dataset.messageTimestamp = String(message.timestamp || Date.now());
    messageEl.dataset.messageLocalOrder = String(message.localOrder || message.fileInfo?.localOrder || 0);
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
                        <img src="${fileUrl}" alt="${escapeHtml(fileInfo.name)}" loading="lazy" decoding="async">
                    </div>
                    <div class="file-size media-file-size">${formatFileSize(fileInfo.size)}</div>
                </div>
            `;
        } else if (isVideo && fileUrl) {
            const poster = storedFile ? await ensureVideoPosterCache(storedFile, fileInfo) : '';
            contentHtml = `
                <div class="message-bubble">
                    <div class="media-preview">
                        ${poster
                            ? `<img src="${poster}" alt="${escapeHtml(fileInfo.name)}" loading="lazy" decoding="async">`
                            : `<video muted playsinline preload="none" src="${fileUrl}"></video>`}
                    </div>
                    <div class="file-size media-file-size">${formatFileSize(fileInfo.size)}</div>
                </div>
            `;
        } else {
            // 文件消息（大文件、无法预览的文件，或文件数据已丢失）
            const sizeStr = formatFileSize(fileInfo.size);
            const hasLocalData = fileInfo.id && Boolean(fileUrl);
            const opacity = hasLocalData ? '' : 'opacity: 0.6;';

            const unavailableLabel = (fileInfo.isAsset || fileInfo.isServerAsset)
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
            cacheCleared: Boolean(storedFile?.cacheCleared),
            restoreRequested: Boolean(storedFile?.restoreRequested)
        };
    } else if (message.type === 'collection') {
        const files = getCollectionFiles(message);
        messageEl.classList.add('collection-record');
        messageEl.dataset.collectionId = message.collection?.id || message.id;
        messageEl.dataset.collectionCount = String(files.length);
        messageEl.dataset.collectionFileIds = files.map(file => file.id).join(',');
        contentHtml = await renderCollectionPreviewHtml(message);
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
        renderMessageRecordActions(messageEl, message);
    } else if (message.type === 'collection') {
        attachCollectionRecordInteractions(messageEl);
        renderMessageRecordActions(messageEl, message);
    } else if (message.type === 'text' || message.type === 'rich') {
        renderMessageRecordActions(messageEl, message);
    }

    insertMessageElementByTimestamp(container, messageEl);
    if (shouldScroll) {
        container.scrollTop = container.scrollHeight;
    }
    if (options.autoRequestAsset !== false && message.type === 'file' &&
        (message.fileInfo?.isAsset || message.fileInfo?.isServerAsset)) {
        requestMissingFileAssetCache(message, 'message-rendered')
            .catch(err => historyLog('file-asset-cache-backfill-failed', {
                reason: 'message-rendered',
                message: summarizeHistoryMessage(message),
                error: err.message
            }));
    }
    if (options.autoRequestAsset !== false && message.type === 'collection') {
        requestMissingCollectionAssetCaches(message, 'collection-rendered')
            .catch(err => historyLog('collection-asset-cache-backfill-failed', {
                reason: 'collection-rendered',
                messageId: message.id,
                error: err.message
            }));
    }
    return messageEl;
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
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        handler(event);
    });
    return button;
}

function renderMessageRecordActions(messageEl, message) {
    messageEl.querySelector('.message-record-actions')?.remove();
    const actions = document.createElement('div');
    actions.className = 'message-record-actions';
    actions.appendChild(createFileActionButton('删除', '从会话中删除此记录', () => {
        deleteHistoryMessage(message.id);
    }));
    messageEl.appendChild(actions);
    requestAnimationFrame(() => {
        const bubble = messageEl.querySelector('.message-bubble');
        if (!bubble || !actions.isConnected) return;
        actions.style.width = `${Math.ceil(bubble.getBoundingClientRect().width)}px`;
        actions.style.marginLeft = messageEl.classList.contains('own') ? 'auto' : '0';
    });
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

    if (fileInfo.isAsset || fileInfo.isServerAsset) {
        await restoreFileCache(messageId);
        alert('文件缓存正在还原，完成后请再次点击下载。');
        return;
    }

    alert('文件尚未缓存到本机，且没有可用的远程文件来源。');
}

async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
        copied = document.execCommand('copy');
    } finally {
        document.body.removeChild(textarea);
    }
    return copied;
}

async function shareFileMagnet(messageId) {
    const message = await getFromStore('messages', messageId);
    const fileInfo = message?.fileInfo;
    if (!fileInfo?.id) throw new Error('文件记录不存在');

    const storedFile = await getFromStore('files', fileInfo.id);
    if (!hasCompleteFileCache(storedFile, fileInfo)) {
        throw new Error('本设备没有完整缓存，不能注册为种子设备');
    }

    if (fileAssetTransfer) {
        await fileAssetTransfer.announce({
            ...storedFile,
            ownerDeviceId: storedFile.ownerDeviceId || fileInfo.ownerDeviceId || state.deviceId,
            isFileAsset: true
        });
    }

    let response = null;
    let result = {};
    for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch('/api/magnets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: state.sessionId,
                fileId: fileInfo.id,
                deviceId: state.deviceId,
                asset: {
                    id: fileInfo.id,
                    name: fileInfo.name || storedFile.name || 'file',
                    type: fileInfo.type || storedFile.type || 'application/octet-stream',
                    size: Number(fileInfo.size || storedFile.size || getBinaryDataSize(storedFile.data)),
                    ownerDeviceId: storedFile.ownerDeviceId || fileInfo.ownerDeviceId || state.deviceId,
                    isFolderArchive: fileInfo.isFolderArchive === true || storedFile.isFolderArchive === true,
                    isDirectoryMirror: fileInfo.isDirectoryMirror === true || storedFile.isDirectoryMirror === true,
                    folderName: fileInfo.folderName || storedFile.folderName,
                    entryCount: Number.isInteger(fileInfo.entryCount) ? fileInfo.entryCount : storedFile.entryCount
                }
            })
        });
        result = await response.json().catch(() => ({}));
        if (response.ok || attempt === 1) break;
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!response.ok || !result.url) {
        throw new Error(result.error || '服务端未返回磁链');
    }

    const copied = await copyTextToClipboard(result.url).catch(() => false);
    alert(copied ? `磁链已复制:\n${result.url}` : `磁链已生成，请手动复制:\n${result.url}`);
    historyLog('file-magnet-shared', {
        messageId,
        fileId: fileInfo.id,
        magnetId: result.id,
        copied
    });
}

function renderFileMessageActions(messageEl, fileInfo, cacheState = {}) {
    messageEl.querySelector('.file-actions')?.remove();
    messageEl.querySelector('.file-cache-retry')?.remove();

    if (!cacheState.hasLocalData && (fileInfo.isAsset || fileInfo.isServerAsset)) {
        const bubble = messageEl.querySelector('.message-bubble');
        if (bubble) {
            bubble.classList.add('file-cache-retry-target');
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'file-cache-retry';
            retry.title = cacheState.restoreRequested ? '正在拉取缓存，点击可重新请求' : '重新请求拉取缓存';
            retry.setAttribute('aria-label', retry.title);
            retry.innerHTML = '<span aria-hidden="true"></span>';
            retry.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                restoreFileCache(messageEl.dataset.messageId, { force: true }).catch(err => historyLog('file-cache-retry-failed', {
                    messageId: messageEl.dataset.messageId,
                    fileId: fileInfo.id,
                    error: err.message
                }));
            });
            bubble.appendChild(retry);
        }
    }
}

let activeFileDetailsMessageId = null;
let activeFileDetailsFileId = null;
let filePreviewReturnCollectionMessageId = '';
let collectionPreviewReturnState = null;
let activeFilePreviewMode = '';
let activeCollectionPreviewMessageId = '';
let activeFilePreviewFileId = '';
let activeFilePreviewMessageId = '';
let activeFilePreviewOwnerDeviceId = '';
let activeFilePreviewCanFullscreen = false;
let activeFilePreviewMediaType = '';

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
    activeFileDetailsFileId = null;
}

function closeFilePreview(options = {}) {
    if (mediaFullscreenHistoryOpen || document.getElementById('mediaFullscreenViewer')?.classList.contains('active')) {
        closeMediaFullscreen({ fromHistory: true, forceClose: true });
    }
    if (filePreviewReturnCollectionMessageId && !options.forceClose) {
        if (!options.fromHistory && filePreviewNestedHistoryOpen && history.state?.[FILE_PREVIEW_HISTORY_KEY] === true) {
            history.back();
            return;
        }
        const collectionMessageId = filePreviewReturnCollectionMessageId;
        filePreviewReturnCollectionMessageId = '';
        filePreviewNestedHistoryOpen = false;
        const restored = restoreCollectionPreviewReturnState(collectionMessageId);
        if (!restored) {
            openCollectionRecord(collectionMessageId, collectionPreviewReturnState || {}).catch(err => historyLog('collection-preview-restore-failed', {
                messageId: collectionMessageId,
                error: err.message
            }));
        }
        return;
    }
    const viewer = document.getElementById('filePreviewViewer');
    const wasActive = viewer?.classList.contains('active');
    const shouldGoBack = wasActive && filePreviewHistoryOpen && !options.fromHistory &&
        history.state?.[FILE_PREVIEW_HISTORY_KEY] === true;
    filePreviewHistoryOpen = false;
    filePreviewNestedHistoryOpen = false;
    filePreviewReturnCollectionMessageId = '';
    collectionPreviewReturnState = null;
    activeFilePreviewMode = '';
    activeCollectionPreviewMessageId = '';
    activeFilePreviewFileId = '';
    activeFilePreviewMessageId = '';
    activeFilePreviewOwnerDeviceId = '';
    activeFilePreviewCanFullscreen = false;
    activeFilePreviewMediaType = '';
    setFilePreviewFullscreenButton(false);
    viewer.classList.remove('active');
    filePreviewPointerStart = null;
    const content = document.getElementById('filePreviewContent');
    content?.replaceChildren();
    resetFilePreviewContentStage(content);
    document.getElementById('filePreviewActions')?.replaceChildren();
    if (shouldGoBack) history.back();
}

function captureCollectionPreviewReturnState(collectionMessageId, anchorFileId = '') {
    const content = document.getElementById('filePreviewContent');
    const actions = document.getElementById('filePreviewActions');
    const grid = content?.querySelector('.collection-file-grid');
    const contentFragment = document.createDocumentFragment();
    const actionsFragment = document.createDocumentFragment();
    if (content) {
        while (content.firstChild) contentFragment.appendChild(content.firstChild);
    }
    if (actions) {
        while (actions.firstChild) actionsFragment.appendChild(actions.firstChild);
    }
    collectionPreviewReturnState = {
        messageId: collectionMessageId,
        anchorFileId,
        scrollTop: grid ? grid.scrollTop : 0,
        title: document.getElementById('filePreviewTitle')?.textContent || '',
        contentFragment,
        actionsFragment,
        capturedAt: Date.now()
    };
}

function restoreCollectionPreviewReturnState(collectionMessageId) {
    const stateToRestore = collectionPreviewReturnState;
    if (!stateToRestore || stateToRestore.messageId !== collectionMessageId || !stateToRestore.contentFragment) return false;
    const title = document.getElementById('filePreviewTitle');
    const content = document.getElementById('filePreviewContent');
    const actions = document.getElementById('filePreviewActions');
    if (title) title.textContent = stateToRestore.title || '合辑';
    content?.replaceChildren(stateToRestore.contentFragment);
    actions?.replaceChildren(stateToRestore.actionsFragment);
    activeFilePreviewMode = 'collection';
    activeCollectionPreviewMessageId = collectionMessageId;
    activeFilePreviewFileId = '';
    activeFilePreviewMessageId = '';
    activeFilePreviewOwnerDeviceId = '';
    activeFilePreviewCanFullscreen = false;
    activeFilePreviewMediaType = '';
    setFilePreviewFullscreenButton(false);
    updateFilePreviewNavigationControls().catch(err => historyLog('file-preview-nav-update-failed', { error: err.message }));
    collectionPreviewReturnState = null;
    requestAnimationFrame(() => {
        const grid = content?.querySelector('.collection-file-grid');
        if (!grid) return;
        const anchor = stateToRestore.anchorFileId
            ? grid.querySelector(`.collection-file-card[data-file-id="${CSS.escape(stateToRestore.anchorFileId)}"]`)
            : null;
        if (anchor) {
            anchor.scrollIntoView({ block: 'center' });
            anchor.classList.add('collection-file-card--focused');
            setTimeout(() => anchor.classList.remove('collection-file-card--focused'), 900);
        } else {
            grid.scrollTop = stateToRestore.scrollTop || 0;
        }
    });
    historyLog('collection-preview-return-restored', { messageId: collectionMessageId, anchorFileId: stateToRestore.anchorFileId });
    return true;
}

function setFilePreviewActions(actions = []) {
    const container = document.getElementById('filePreviewActions');
    if (!container) return;
    container.replaceChildren();
    actions.forEach(action => container.appendChild(action));
}

function openFilePreviewHistory(viewer, options = {}) {
    if (!viewer) return;
    if (options.nested && viewer.classList.contains('active')) {
        if (!filePreviewNestedHistoryOpen) {
            const baseState = history.state && typeof history.state === 'object' ? history.state : {};
            history.pushState({ ...baseState, [FILE_PREVIEW_HISTORY_KEY]: true, filePreviewStage: 'file' }, '', window.location.href);
            filePreviewNestedHistoryOpen = true;
        }
        return;
    }
    if (!viewer.classList.contains('active')) {
        const baseState = history.state && typeof history.state === 'object' ? history.state : {};
        history.pushState({ ...baseState, [FILE_PREVIEW_HISTORY_KEY]: true, filePreviewStage: options.stage || 'preview' }, '', window.location.href);
        filePreviewHistoryOpen = true;
        viewer.classList.add('active');
    }
}

function resetFilePreviewContentStage(content = document.getElementById('filePreviewContent')) {
    content?.classList.remove('collection-stage', 'preview-media-stage', 'preview-metadata-stage', 'preview-loading-stage');
}

function setFilePreviewContentStage(stage) {
    const content = document.getElementById('filePreviewContent');
    if (!content) return null;
    resetFilePreviewContentStage(content);
    if (stage) content.classList.add(stage);
    return content;
}

function getPreviewMediaNaturalSize(media) {
    if (!media) return null;
    if (media.tagName === 'IMG') {
        const width = media.naturalWidth || 0;
        const height = media.naturalHeight || 0;
        return width > 0 && height > 0 ? { width, height } : null;
    }
    if (media.tagName === 'VIDEO') {
        const width = media.videoWidth || 0;
        const height = media.videoHeight || 0;
        return width > 0 && height > 0 ? { width, height } : null;
    }
    return null;
}

function fitPreviewMediaElement(media, content = document.getElementById('filePreviewContent')) {
    if (!media || !content) return;
    const applyFit = () => {
        const natural = getPreviewMediaNaturalSize(media);
        const rect = content.getBoundingClientRect();
        if (!natural || rect.width <= 0 || rect.height <= 0) return;
        const maxWidth = Math.max(1, rect.width - 16);
        const maxHeight = Math.max(1, rect.height * 0.9);
        const scale = Math.min(1, maxWidth / natural.width, maxHeight / natural.height);
        const width = Math.max(1, Math.floor(natural.width * scale));
        const height = Math.max(1, Math.floor(natural.height * scale));
        media.style.setProperty('--preview-media-width', `${width}px`);
        media.style.setProperty('--preview-media-height', `${height}px`);
        media.classList.add('preview-media-fit-ready');
    };

    requestAnimationFrame(applyFit);
    if (media.tagName === 'IMG' && !media.complete) {
        media.addEventListener('load', applyFit, { once: true });
    } else if (media.tagName === 'VIDEO' && !(media.videoWidth > 0 && media.videoHeight > 0)) {
        media.addEventListener('loadedmetadata', applyFit, { once: true });
        media.addEventListener('loadeddata', applyFit, { once: true });
    }

    if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => {
            if (!media.isConnected || !content.isConnected || !content.contains(media)) {
                observer.disconnect();
                return;
            }
            requestAnimationFrame(applyFit);
        });
        observer.observe(content);
        media.addEventListener('emptied', () => observer.disconnect(), { once: true });
    }
}

function renderFilePreviewLoading(content, fileInfo) {
    content.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'file-preview-loading';
    loading.innerHTML = `
        <div class="file-icon">${getFileIcon(fileInfo.type || '')}</div>
        <div>
            <div class="file-name">${escapeHtml(fileInfo.name || '文件预览')}</div>
            <div class="file-size">正在准备预览...</div>
        </div>
    `;
    content.appendChild(loading);
}

function isPreviewableFileType(type) {
    const value = String(type || '').toLowerCase();
    return value.startsWith('image/') || value.startsWith('video/') || value.startsWith('audio/');
}

function isVisualPreviewableType(type) {
    const value = String(type || '').toLowerCase();
    return value.startsWith('image/') || value.startsWith('video/');
}

function isFullscreenPreviewableType(type) {
    return isVisualPreviewableType(type);
}

function setFilePreviewFullscreenButton(visible) {
    const button = document.getElementById('filePreviewFullscreenBtn');
    if (!button) return;
    button.hidden = !visible;
    button.disabled = !visible;
}

function renderFileMetadataPreview(content, fileInfo, stateLabel = '') {
    setFilePreviewContentStage('preview-metadata-stage');
    content.replaceChildren();
    const panel = document.createElement('div');
    panel.className = 'file-preview-metadata';
    panel.innerHTML = `
        <div class="file-icon">${getFileIcon(fileInfo.type || '')}</div>
        <div class="file-info">
            <div class="file-name">${escapeHtml(fileInfo.name || '未知文件')}</div>
            <div class="file-size">${formatFileSize(Number(fileInfo.size) || 0)}${stateLabel ? ` (${escapeHtml(stateLabel)})` : ''}</div>
        </div>
    `;
    content.appendChild(panel);
}

function getMissingFileStateLabel(storedFile) {
    if (storedFile?.restoreRequested) return '正在还原';
    if (storedFile?.cacheCleared) return '缓存已清理';
    if (storedFile?.isPartial || storedFile?.transferInterrupted) return '传输中断';
    return '本机未缓存';
}

async function getActivePreviewFileInfo(fileId = activeFilePreviewFileId) {
    if (!fileId) return null;
    if (activeCollectionPreviewMessageId) {
        const message = await getFromStore('messages', activeCollectionPreviewMessageId).catch(() => null);
        const fileInfo = getCollectionFiles(message).find(file => file.id === fileId);
        if (fileInfo) return fileInfo;
    }
    if (activeFilePreviewMessageId) {
        const message = await getFromStore('messages', activeFilePreviewMessageId).catch(() => null);
        if (message?.fileInfo?.id === fileId) return message.fileInfo;
    }
    const messageEl = document.querySelector(`.message[data-file-id="${CSS.escape(fileId)}"]`);
    if (messageEl) return getFileInfoFromMessageElement(messageEl);
    const storedFile = await getFromStore('files', fileId).catch(() => null);
    return storedFile?.id ? storedFile : null;
}

function findCollectionPreviewRoot() {
    const roots = [];
    const liveContent = document.getElementById('filePreviewContent');
    if (liveContent) roots.push(liveContent);
    if (collectionPreviewReturnState?.contentFragment) roots.push(collectionPreviewReturnState.contentFragment);
    return roots;
}

async function refreshCollectionPreviewCardForFile(fileId, collectionMessageId = activeCollectionPreviewMessageId || collectionPreviewReturnState?.messageId || '') {
    if (!fileId || !collectionMessageId) return;
    const message = await getFromStore('messages', collectionMessageId).catch(() => null);
    const fileInfo = getCollectionFiles(message).find(file => file.id === fileId);
    if (!fileInfo) return;
    for (const root of findCollectionPreviewRoot()) {
        const card = root.querySelector?.(`.collection-file-card[data-file-id="${CSS.escape(fileId)}"]`);
        if (!card) continue;
        const nextCard = await createCollectionFileCard(fileInfo, collectionMessageId);
        card.replaceWith(nextCard);
    }
}


function getCollectionPreviewRootsForMessage(collectionMessageId) {
    const roots = [];
    const liveContent = document.getElementById('filePreviewContent');
    if (activeCollectionPreviewMessageId === collectionMessageId && liveContent) roots.push(liveContent);
    if (collectionPreviewReturnState?.messageId === collectionMessageId && collectionPreviewReturnState.contentFragment) {
        roots.push(collectionPreviewReturnState.contentFragment);
    }
    return roots;
}

async function updateCollectionMessageElement(message) {
    const messageEl = getMessageElement(message.id);
    if (!messageEl) {
        await addMessageToChat(message, message.sender === state.deviceId, { autoRequestAsset: false, scroll: false });
        return;
    }
    const files = getCollectionFiles(message);
    messageEl.classList.add('collection-record');
    messageEl.dataset.collectionId = message.collection?.id || message.id;
    messageEl.dataset.collectionCount = String(files.length);
    messageEl.dataset.collectionFileIds = files.map(file => file.id).join(',');
    const html = await renderCollectionPreviewHtml(message);
    preserveChatScroll(() => {
        const bubble = messageEl.querySelector('.message-bubble');
        if (bubble) bubble.outerHTML = html;
    });
}

async function applyCollectionPreviewIncrementalUpdate(previousMessage, nextMessage) {
    if (!previousMessage?.id || previousMessage.id !== nextMessage?.id) return;
    const collectionMessageId = nextMessage.id;
    const previousFiles = getCollectionFiles(previousMessage);
    const nextFiles = getCollectionFiles(nextMessage);
    const nextById = new Map(nextFiles.map(file => [file.id, file]));
    const nextIds = new Set(nextById.keys());
    const removedIds = previousFiles.map(file => file.id).filter(id => !nextIds.has(id));

    if (activeFilePreviewMode === 'file' && activeCollectionPreviewMessageId === collectionMessageId &&
        activeFilePreviewFileId && removedIds.includes(activeFilePreviewFileId)) {
        closeFilePreview();
        await new Promise(resolve => requestAnimationFrame(resolve));
    }

    const roots = getCollectionPreviewRootsForMessage(collectionMessageId);
    for (const root of roots) {
        const grid = root.querySelector?.('.collection-file-grid');
        if (!grid) continue;
        const scrollTop = grid.scrollTop;
        for (const fileId of removedIds) {
            grid.querySelector(`.collection-file-card[data-file-id="${CSS.escape(fileId)}"]`)?.remove();
        }
        for (let index = 0; index < nextFiles.length; index++) {
            const fileInfo = nextFiles[index];
            if (!fileInfo?.id || grid.querySelector(`.collection-file-card[data-file-id="${CSS.escape(fileInfo.id)}"]`)) continue;
            const card = await createCollectionFileCard(fileInfo, collectionMessageId);
            let before = null;
            for (let j = index + 1; j < nextFiles.length; j++) {
                before = grid.querySelector(`.collection-file-card[data-file-id="${CSS.escape(nextFiles[j].id)}"]`);
                if (before) break;
            }
            grid.insertBefore(card, before);
        }
        grid.dataset.collectionCount = String(nextFiles.length);
        requestAnimationFrame(() => {
            grid.scrollTop = Math.min(scrollTop, Math.max(0, grid.scrollHeight - grid.clientHeight));
        });
    }

    if (activeCollectionPreviewMessageId === collectionMessageId) {
        const title = document.getElementById('filePreviewTitle');
        if (title && (activeFilePreviewMode === 'collection' || !activeFilePreviewMode)) {
            title.textContent = `合辑 · ${nextFiles.length} 个文件`;
        }
    }
    historyLog('collection-preview-incrementally-updated', {
        messageId: collectionMessageId,
        removedCount: removedIds.length,
        nextCount: nextFiles.length,
        roots: roots.length
    });
}

async function refreshActiveFilePreviewForFile(fileId) {
    if (activeFilePreviewMode !== 'file' || activeFilePreviewFileId !== fileId) return;
    const fileInfo = await getActivePreviewFileInfo(fileId);
    if (!fileInfo?.id) return;
    await openFilePreviewForInfo(fileInfo, {
        messageId: activeFilePreviewMessageId || activeCollectionPreviewMessageId || '',
        collectionMessageId: activeCollectionPreviewMessageId || '',
        ownerDeviceId: activeFilePreviewOwnerDeviceId || fileInfo.ownerDeviceId || '',
        requestMissing: false
    });
}

async function cancelClearedCollectionDownloadsExcept(collectionMessageId, allowedFileId) {
    if (!collectionMessageId || !fileAssetTransfer) return;
    const message = await getFromStore('messages', collectionMessageId).catch(() => null);
    for (const fileInfo of getCollectionFiles(message)) {
        if (!fileInfo?.id || fileInfo.id === allowedFileId) continue;
        const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
        if (!hasCompleteFileCache(storedFile, fileInfo) && storedFile?.cacheCleared && !storedFile.restoreRequested) {
            fileAssetTransfer.cancel(fileInfo.id);
        }
    }
}

async function downloadFileByInfo(fileInfo, ownerDeviceId = '', options = {}) {
    const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
    if (hasCompleteFileCache(storedFile, fileInfo)) {
        await downloadFile(fileInfo.id);
        return;
    }
    if (fileInfo.isServerAsset && fileInfo.serverAssetUrl) {
        const fetched = await fetchServerAssetCache(fileInfo, 'manual-download');
        if (fetched) {
            await downloadFile(fileInfo.id);
            return;
        }
        alert('文件尚未缓存到本机，已尝试拉取缓存，完成后请再次下载。');
        return;
    }
    if (fileInfo.isAsset && fileAssetTransfer) {
        await cancelClearedCollectionDownloadsExcept(options.collectionMessageId || '', fileInfo.id);
        await saveToStore('files', {
            ...(storedFile || {}),
            id: fileInfo.id,
            name: fileInfo.name,
            type: fileInfo.type,
            size: fileInfo.size,
            sessionId: state.sessionId,
            ownerDeviceId: ownerDeviceId || fileInfo.ownerDeviceId,
            isFileAsset: true,
            cacheCleared: Boolean(storedFile?.cacheCleared),
            restoreRequested: true,
            transferInterrupted: false
        });
        await refreshCollectionPreviewCardForFile(fileInfo.id, options.collectionMessageId || activeCollectionPreviewMessageId || '');
        await refreshActiveFilePreviewForFile(fileInfo.id);
        await fileAssetTransfer.requestProviderDiscovery?.(fileInfo.id, 'manual-download');
        await fileAssetTransfer.request(fileInfo.id, ownerDeviceId || fileInfo.ownerDeviceId || null, fileInfo, { priority: true, force: true })
            .catch(err => historyLog('file-download-cache-request-failed', {
                fileId: fileInfo.id,
                error: err.message
            }));
        alert('文件尚未缓存到本机，已尝试拉取缓存，完成后请再次下载。');
        return;
    }
    alert('文件尚未缓存到本机，且没有可用的远程文件来源。');
}

async function restoreFileCacheByInfo(fileInfo, ownerDeviceId = '', messageId = '', options = {}) {
    if (fileInfo?.isServerAsset && fileInfo.serverAssetUrl) {
        await fetchServerAssetCache(fileInfo, options.force ? 'manual-force-restore' : 'manual-restore');
        await refreshCollectionPreviewCardForFile(fileInfo.id, options.collectionMessageId || activeCollectionPreviewMessageId || '');
        await refreshActiveFilePreviewForFile(fileInfo.id);
        return;
    }
    if (!fileInfo?.id || !fileInfo.isAsset || !fileAssetTransfer) {
        alert('此文件没有可用的远程文件来源，无法还原。');
        return;
    }
    if (options.force && shouldBlockForceRestore(fileInfo.id)) {
        const progressState = getFileReceiveProgressState(fileInfo.id);
        alert(`文件正在拉取中，当前约 ${progressState.progress}%，且最近仍在推进。暂不强制重拉，避免浪费已完成的传输。`);
        return;
    }
    if (options.force) {
        fileAssetTransfer.cancel(fileInfo.id);
        hideProgress(fileInfo.id);
        fileTransferProgressStates.delete(fileInfo.id);
    }
    await cancelClearedCollectionDownloadsExcept(options.collectionMessageId || '', fileInfo.id);
    const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
    if (hasCompleteFileCache(storedFile, fileInfo)) {
        await saveToStore('files', {
            ...storedFile,
            cacheCleared: false,
            restoreRequested: false,
            transferInterrupted: false,
            isPartial: false
        });
        await refreshFileMessage(fileInfo.id);
        return;
    }
    await saveToStore('files', {
        ...(storedFile || {}),
        id: fileInfo.id,
        name: fileInfo.name,
        type: fileInfo.type,
        size: fileInfo.size,
        sessionId: state.sessionId,
        ownerDeviceId: ownerDeviceId || fileInfo.ownerDeviceId || state.deviceId,
        isFileAsset: true,
        cacheCleared: true,
        restoreRequested: true,
        transferInterrupted: false,
        isPartial: false
    });
    showFileMessagePlaceholder(fileInfo.id, '正在请求还原', true, true);
    await refreshCollectionPreviewCardForFile(fileInfo.id, options.collectionMessageId || activeCollectionPreviewMessageId || '');
    await refreshActiveFilePreviewForFile(fileInfo.id);
    await fileAssetTransfer.requestProviderDiscovery?.(fileInfo.id, options.force ? 'manual-force-restore' : 'manual-restore');
    await fileAssetTransfer.request(fileInfo.id, ownerDeviceId || fileInfo.ownerDeviceId || null, fileInfo, {
        force: Boolean(options.force),
        priority: true
    });
    historyLog('file-cache-restore-requested-by-info', { messageId, fileId: fileInfo.id });
}

async function clearFileCacheByInfo(fileInfo, ownerDeviceId, messageId = '', options = {}) {
    if (!fileInfo?.id) return;
    if (state.devices.size === 0) {
        const ok = confirm('请确认这个文件在其它设备已缓存，否则将无法恢复。继续清除本机缓存吗？');
        if (!ok) return;
    }
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
        ownerDeviceId: ownerDeviceId || fileInfo.ownerDeviceId || state.deviceId,
        isFileAsset: Boolean(fileInfo.isAsset || fileInfo.isServerAsset),
        isServerAsset: Boolean(fileInfo.isServerAsset),
        serverAssetUrl: fileInfo.serverAssetUrl || '',
        cacheCleared: true,
        restoreRequested: false
    });
    const objectUrl = fileObjectUrls.get(fileInfo.id);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    fileObjectUrls.delete(fileInfo.id);
    showFileMessagePlaceholder(fileInfo.id, '本地缓存已清理', true, false);
    await refreshCollectionMessagesForFile(fileInfo.id);
    await refreshCollectionPreviewCardForFile(fileInfo.id, options.collectionMessageId || activeCollectionPreviewMessageId || '');
    await openFilePreviewForInfo(fileInfo, {
        messageId,
        collectionMessageId: options.collectionMessageId || '',
        ownerDeviceId,
        requestMissing: false
    });
    historyLog('file-cache-cleared', { messageId, fileId: fileInfo.id });
}

async function shareFileMagnetForInfo(fileInfo, ownerDeviceId, messageId = '') {
    const storedFile = await getFromStore('files', fileInfo.id);
    if (!hasCompleteFileCache(storedFile, fileInfo)) {
        throw new Error('本设备没有完整缓存，不能注册为种子设备');
    }
    if (fileAssetTransfer) {
        await fileAssetTransfer.announce({
            ...storedFile,
            ownerDeviceId: storedFile.ownerDeviceId || fileInfo.ownerDeviceId || ownerDeviceId || state.deviceId,
            isFileAsset: true
        });
    }
    const response = await fetch('/api/magnets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sessionId: state.sessionId,
            fileId: fileInfo.id,
            deviceId: state.deviceId,
            asset: {
                id: fileInfo.id,
                name: fileInfo.name || storedFile.name || 'file',
                type: fileInfo.type || storedFile.type || 'application/octet-stream',
                size: Number(fileInfo.size || storedFile.size || getBinaryDataSize(storedFile.data)),
                ownerDeviceId: storedFile.ownerDeviceId || fileInfo.ownerDeviceId || ownerDeviceId || state.deviceId,
                isFolderArchive: fileInfo.isFolderArchive === true || storedFile.isFolderArchive === true,
                isDirectoryMirror: fileInfo.isDirectoryMirror === true || storedFile.isDirectoryMirror === true,
                folderName: fileInfo.folderName || storedFile.folderName,
                entryCount: Number.isInteger(fileInfo.entryCount) ? fileInfo.entryCount : storedFile.entryCount
            }
        })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.url) throw new Error(result.error || '服务端未返回磁链');
    const copied = await copyTextToClipboard(result.url).catch(() => false);
    alert(copied ? `磁链已复制\n${result.url}` : `磁链已生成，请手动复制\n${result.url}`);
    historyLog('file-magnet-shared', { messageId, fileId: fileInfo.id, magnetId: result.id, copied });
}

async function renderSingleFilePreviewActions({ messageId, fileInfo, ownerDeviceId, collectionMessageId = '', hasLocalData = true, cacheCleared = false, restoreRequested = false }) {
    const isCollectionFile = Boolean(collectionMessageId);
    const deleteTitle = isCollectionFile ? '仅从合辑中删除此文件，并清理其缓存' : '从会话中删除此记录及所有设备的文件缓存';
    const cacheAction = hasLocalData
        ? createFileActionButton('清除缓存', '仅清理本设备保存的文件内容', () => {
            clearFileCacheByInfo(fileInfo, ownerDeviceId, messageId, { collectionMessageId });
        })
        : createFileActionButton(restoreRequested ? '正在还原' : '还原文件', restoreRequested ? '文件正在拉取，点击可重新请求' : '从其它在线设备还原此文件', () => {
            restoreFileCacheByInfo(fileInfo, ownerDeviceId, messageId, { collectionMessageId, force: true })
                .catch(err => {
                    alert(`还原文件失败: ${err.message}`);
                    historyLog('file-cache-restore-by-info-failed', { messageId, collectionMessageId, fileId: fileInfo.id, error: err.message });
                });
        });
    setFilePreviewActions([
        createFileActionButton('详情', '查看文件名、大小、来源设备等详细信息', () => {
            showFileDetailsForInfo(fileInfo, { messageId, sender: ownerDeviceId, senderName: '' })
                .catch(err => historyLog('file-details-open-failed', { messageId, fileId: fileInfo.id, error: err.message }));
        }),
        createFileActionButton('下载', '下载此文件', () => downloadFileByInfo(fileInfo, ownerDeviceId, { collectionMessageId })),
        createFileActionButton('分享链接', '生成可分享的磁力下载链接', () => {
            shareFileMagnetForInfo(fileInfo, ownerDeviceId, messageId).catch(err => {
                alert(`磁链生成失败: ${err.message}`);
                historyLog('file-magnet-share-failed', { messageId, fileId: fileInfo.id, error: err.message });
            });
        }),
        cacheAction,
        createFileActionButton('删除', deleteTitle, () => {
            (async () => {
                if (isCollectionFile) {
                    await deleteFileFromCollection(collectionMessageId, fileInfo.id);
                    return;
                }

                const maybeCollection = await getFromStore('messages', messageId).catch(() => null);
                if (maybeCollection?.type === 'collection' && getCollectionFiles(maybeCollection).some(file => file.id === fileInfo.id)) {
                    await deleteFileFromCollection(messageId, fileInfo.id);
                    return;
                }

                closeFilePreview({ forceClose: true });
                await deleteHistoryMessage(messageId);
            })().catch(err => historyLog(isCollectionFile ? 'collection-file-delete-failed' : 'file-delete-failed', {
                messageId: isCollectionFile ? collectionMessageId : messageId,
                fileId: fileInfo.id,
                error: err.message
            }));
        })
    ]);
}

function getStoredFileUrl(fileId, storedFile) {
    let url = fileObjectUrls.get(fileId);
    if (!url) {
        url = URL.createObjectURL(new Blob([storedFile.data], { type: storedFile.type }));
        fileObjectUrls.set(fileId, url);
    }
    return url;
}

function isInlineDocument() {
    // 传输记录中只有图片、视频、音频允许网页内预览；文本/PDF/CSV/JSON 等统一走元信息视图。
    return false;
}

async function openFilePreviewForInfo(fileInfo, options = {}) {
    if (!fileInfo?.id) return false;
    const title = document.getElementById('filePreviewTitle');
    const content = setFilePreviewContentStage('preview-loading-stage');
    if (!content || !title) return false;

    activeFilePreviewMode = 'file';
    activeCollectionPreviewMessageId = options.collectionMessageId || '';
    activeFilePreviewFileId = fileInfo.id;
    activeFilePreviewMessageId = options.messageId || '';
    const ownerDeviceId = options.ownerDeviceId || fileInfo.ownerDeviceId || options.sender || '';
    activeFilePreviewOwnerDeviceId = ownerDeviceId;
    activeFilePreviewCanFullscreen = false;
    activeFilePreviewMediaType = '';
    setFilePreviewFullscreenButton(false);

    title.textContent = fileInfo.name || '文件预览';
    renderFilePreviewLoading(content, fileInfo);
    const viewer = document.getElementById('filePreviewViewer');
    openFilePreviewHistory(viewer, {
        nested: Boolean(options.collectionMessageId),
        stage: options.collectionMessageId ? 'file' : 'file-root'
    });
    filePreviewReturnCollectionMessageId = options.collectionMessageId || '';

    const storedFile = await getFromStore('files', fileInfo.id);
    if (!hasCompleteFileCache(storedFile, fileInfo)) {
        if (options.requestMissing === true && fileInfo.isServerAsset && fileInfo.serverAssetUrl) {
            await fetchServerAssetCache(fileInfo, 'file-preview-request-missing')
                .catch(err => historyLog('file-preview-server-cache-request-failed', {
                    messageId: options.messageId,
                    fileId: fileInfo.id,
                    error: err.message
                }));
        } else if (options.requestMissing === true && fileInfo.isAsset && fileAssetTransfer) {
            await fileAssetTransfer.request(
                fileInfo.id,
                ownerDeviceId,
                fileInfo
            ).catch(err => historyLog('file-preview-cache-request-failed', {
                messageId: options.messageId,
                fileId: fileInfo.id,
                error: err.message
            }));
        }
        renderFileMetadataPreview(content, fileInfo, getMissingFileStateLabel(storedFile));
        await renderSingleFilePreviewActions({
            messageId: options.messageId || '',
            fileInfo,
            ownerDeviceId,
            collectionMessageId: options.collectionMessageId || '',
            hasLocalData: false,
            cacheCleared: Boolean(storedFile?.cacheCleared),
            restoreRequested: Boolean(storedFile?.restoreRequested)
        });
        historyLog('file-preview-opened-without-cache', {
            messageId: options.messageId,
            collectionMessageId: options.collectionMessageId,
            fileId: fileInfo.id
        });
        await updateFilePreviewNavigationControls();
        return true;
    }

    const type = String(fileInfo.type || storedFile.type || '').toLowerCase();
    if (!isPreviewableFileType(type)) {
        renderFileMetadataPreview(content, fileInfo, '不可直接预览');
        await renderSingleFilePreviewActions({
            messageId: options.messageId || '',
            fileInfo,
            ownerDeviceId,
            collectionMessageId: options.collectionMessageId || '',
            hasLocalData: true
        });
        historyLog('file-preview-opened-as-metadata', {
            messageId: options.messageId,
            collectionMessageId: options.collectionMessageId,
            fileId: fileInfo.id,
            type
        });
        await updateFilePreviewNavigationControls();
        return true;
    }

    setFilePreviewContentStage(isVisualPreviewableType(type) ? 'preview-media-stage' : 'preview-metadata-stage');
    content.replaceChildren();

    const url = getStoredFileUrl(fileInfo.id, storedFile);
    if (type.startsWith('image/')) {
        const image = document.createElement('img');
        image.src = url;
        image.alt = fileInfo.name || '图片预览';
        image.dataset.previewFileId = fileInfo.id;
        image.className = 'file-preview-media file-preview-media-image';
        content.appendChild(image);
        fitPreviewMediaElement(image, content);
    } else if (type.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = url;
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        video.preload = 'metadata';
        const poster = await ensureVideoPosterCache(storedFile, fileInfo);
        if (poster) video.poster = poster;
        video.dataset.previewFileId = fileInfo.id;
        video.className = 'file-preview-media file-preview-media-video';
        content.appendChild(video);
        fitPreviewMediaElement(video, content);
        video.play().catch(() => {});
    } else if (type.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.src = url;
        audio.controls = true;
        audio.autoplay = true;
        audio.dataset.previewFileId = fileInfo.id;
        audio.className = 'file-preview-media-audio';
        content.appendChild(audio);
        audio.play().catch(() => {});
    }

    activeFilePreviewCanFullscreen = isFullscreenPreviewableType(type);
    activeFilePreviewMediaType = type;
    setFilePreviewFullscreenButton(activeFilePreviewCanFullscreen);
    await renderSingleFilePreviewActions({
        messageId: options.messageId || '',
        fileInfo,
        ownerDeviceId,
        collectionMessageId: options.collectionMessageId || '',
        hasLocalData: true
    });
    historyLog('file-preview-opened', {
        messageId: options.messageId,
        collectionMessageId: options.collectionMessageId,
        fileId: fileInfo.id,
        type
    });
    await updateFilePreviewNavigationControls();
    return true;
}

async function openFileRecord(messageId) {
    const message = await getFromStore('messages', messageId);
    const fileInfo = message?.fileInfo;
    if (!fileInfo?.id) return;
    await openFilePreviewForInfo(fileInfo, {
        messageId,
        ownerDeviceId: fileInfo.ownerDeviceId || message?.sender,
        sender: message?.sender
    });
}

async function getFullscreenPreviewItems() {
    const items = [];
    if (activeCollectionPreviewMessageId) {
        const message = await getFromStore('messages', activeCollectionPreviewMessageId).catch(() => null);
        for (const fileInfo of getCollectionFiles(message)) {
            const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
            if (!hasCompleteFileCache(storedFile, fileInfo)) continue;
            const type = String(fileInfo.type || storedFile.type || '').toLowerCase();
            if (!isFullscreenPreviewableType(type)) continue;
            items.push({ fileInfo, storedFile, type, url: getStoredFileUrl(fileInfo.id, storedFile) });
        }
    } else if (activeFilePreviewFileId) {
        const fileInfo = await getActivePreviewFileInfo(activeFilePreviewFileId);
        const storedFile = await getFromStore('files', activeFilePreviewFileId).catch(() => null);
        const type = String(fileInfo?.type || storedFile?.type || '').toLowerCase();
        if (fileInfo?.id && hasCompleteFileCache(storedFile, fileInfo) && isFullscreenPreviewableType(type)) {
            items.push({ fileInfo, storedFile, type, url: getStoredFileUrl(fileInfo.id, storedFile) });
        }
    }
    return items;
}

function getActivePreviewMediaElement(fileId = activeFilePreviewFileId) {
    if (!fileId) return null;
    const content = document.getElementById('filePreviewContent');
    if (!content) return null;
    return content.querySelector(`img[data-preview-file-id="${CSS.escape(fileId)}"], video[data-preview-file-id="${CSS.escape(fileId)}"]`);
}

function restoreMovedFullscreenMedia(options = {}) {
    if (!mediaFullscreenMovedMedia) return;
    const media = mediaFullscreenMovedMedia;
    media.classList.remove('media-fullscreen-active-item');
    if (options.pause) {
        try { media.pause?.(); } catch (_) {}
    }
    if (mediaFullscreenMovedParent?.isConnected) {
        if (mediaFullscreenMovedPlaceholder?.parentNode === mediaFullscreenMovedParent) {
            mediaFullscreenMovedParent.insertBefore(media, mediaFullscreenMovedPlaceholder);
            mediaFullscreenMovedPlaceholder.remove();
        } else if (mediaFullscreenMovedNextSibling?.parentNode === mediaFullscreenMovedParent) {
            mediaFullscreenMovedParent.insertBefore(media, mediaFullscreenMovedNextSibling);
        } else {
            mediaFullscreenMovedParent.appendChild(media);
        }
    }
    mediaFullscreenMovedMedia = null;
    mediaFullscreenMovedParent = null;
    mediaFullscreenMovedNextSibling = null;
    mediaFullscreenMovedPlaceholder = null;
    if (media.isConnected && media.parentElement?.id === 'filePreviewContent') {
        fitPreviewMediaElement(media, media.parentElement);
    }
}

function createFullscreenMediaElement(item) {
    if (item.type.startsWith('image/')) {
        const image = document.createElement('img');
        image.src = item.url;
        image.alt = item.fileInfo.name || '图片预览';
        image.className = 'media-fullscreen-generated-item';
        return image;
    }
    if (item.type.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = item.url;
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.className = 'media-fullscreen-generated-item';
        video.addEventListener('canplay', () => video.play().catch(() => {}), { once: true });
        return video;
    }
    return null;
}

function renderMediaFullscreenItem() {
    const overlay = document.getElementById('mediaFullscreenViewer');
    const content = document.getElementById('mediaFullscreenContent');
    const title = document.getElementById('mediaFullscreenTitle');
    const counter = document.getElementById('mediaFullscreenCounter');
    const prevButton = document.getElementById('mediaFullscreenPrevBtn');
    const nextButton = document.getElementById('mediaFullscreenNextBtn');
    if (!overlay || !content) return;
    const item = mediaFullscreenItems[mediaFullscreenIndex];
    if (!item) {
        restoreMovedFullscreenMedia({ pause: true });
        content.replaceChildren();
        title.textContent = '没有可预览文件';
        counter.textContent = '';
        prevButton.hidden = true;
        nextButton.hidden = true;
        return;
    }
    title.textContent = item.fileInfo.name || '文件预览';
    counter.textContent = mediaFullscreenItems.length > 1 ? `${mediaFullscreenIndex + 1} / ${mediaFullscreenItems.length}` : '';
    prevButton.hidden = mediaFullscreenItems.length <= 1;
    nextButton.hidden = mediaFullscreenItems.length <= 1;

    const canReuseActiveMedia = item.fileInfo.id === activeFilePreviewFileId;
    const reusableMedia = canReuseActiveMedia
        ? (mediaFullscreenMovedMedia || getActivePreviewMediaElement(item.fileInfo.id))
        : null;

    if (reusableMedia) {
        if (mediaFullscreenMovedMedia && mediaFullscreenMovedMedia !== reusableMedia) {
            restoreMovedFullscreenMedia({ pause: true });
        }
        if (reusableMedia.parentNode !== content) {
            mediaFullscreenMovedParent = reusableMedia.parentNode;
            mediaFullscreenMovedNextSibling = reusableMedia.nextSibling;
            mediaFullscreenMovedPlaceholder = document.createElement('div');
            mediaFullscreenMovedPlaceholder.className = 'media-fullscreen-return-placeholder';
            mediaFullscreenMovedParent?.insertBefore(mediaFullscreenMovedPlaceholder, reusableMedia);
            content.replaceChildren();
            content.appendChild(reusableMedia);
            mediaFullscreenMovedMedia = reusableMedia;
        } else {
            Array.from(content.childNodes).forEach(node => {
                if (node !== reusableMedia) node.remove();
            });
        }
        reusableMedia.classList.add('media-fullscreen-active-item');
        fitPreviewMediaElement(reusableMedia, content);
    } else {
        restoreMovedFullscreenMedia({ pause: true });
        content.replaceChildren();
        const media = createFullscreenMediaElement(item);
        if (media) {
            content.appendChild(media);
            fitPreviewMediaElement(media, content);
            if (media.tagName === 'VIDEO') media.play().catch(() => {});
        }
    }

    historyLog('media-fullscreen-rendered', {
        fileId: item.fileInfo.id,
        index: mediaFullscreenIndex,
        count: mediaFullscreenItems.length,
        reusedActivePreviewMedia: Boolean(reusableMedia)
    });
}

function navigateMediaFullscreen(delta) {
    if (!document.getElementById('mediaFullscreenViewer')?.classList.contains('active')) return;
    if (mediaFullscreenItems.length <= 1) return;
    mediaFullscreenIndex = (mediaFullscreenIndex + delta + mediaFullscreenItems.length) % mediaFullscreenItems.length;
    renderMediaFullscreenItem();
}

async function openActivePreviewFullscreen() {
    if (!activeFilePreviewCanFullscreen || !activeFilePreviewFileId) return;
    mediaFullscreenItems = await getFullscreenPreviewItems();
    mediaFullscreenIndex = Math.max(0, mediaFullscreenItems.findIndex(item => item.fileInfo.id === activeFilePreviewFileId));
    if (!mediaFullscreenItems.length || mediaFullscreenIndex < 0) {
        alert('当前文件尚未缓存到本机，不能全屏预览。');
        return;
    }
    const overlay = document.getElementById('mediaFullscreenViewer');
    if (!overlay) return;
    overlay.classList.add('active');
    renderMediaFullscreenItem();
    if (!mediaFullscreenHistoryOpen) {
        const baseState = history.state && typeof history.state === 'object' ? history.state : {};
        history.pushState({ ...baseState, [MEDIA_FULLSCREEN_HISTORY_KEY]: true }, '', window.location.href);
        mediaFullscreenHistoryOpen = true;
    }
}

function closeMediaFullscreen(options = {}) {
    const overlay = document.getElementById('mediaFullscreenViewer');
    if (!overlay?.classList.contains('active') && !mediaFullscreenHistoryOpen) return;
    const shouldGoBack = mediaFullscreenHistoryOpen && !options.fromHistory && !options.forceClose &&
        history.state?.[MEDIA_FULLSCREEN_HISTORY_KEY] === true;
    mediaFullscreenHistoryOpen = false;
    overlay?.classList.remove('active');
    restoreMovedFullscreenMedia({ pause: false });
    const content = document.getElementById('mediaFullscreenContent');
    content?.querySelectorAll('video, audio').forEach(media => {
        try { media.pause(); } catch (_) {}
    });
    content?.replaceChildren();
    mediaFullscreenPointerStart = null;
    if (shouldGoBack) history.back();
}

async function getCollectionPreviewNavigationFiles() {
    if (!activeCollectionPreviewMessageId) return [];
    const message = await getFromStore('messages', activeCollectionPreviewMessageId).catch(() => null);
    return getCollectionFiles(message).filter(file => file?.id);
}

async function updateFilePreviewNavigationControls() {
    const prevButton = document.getElementById('filePreviewPrevBtn');
    const nextButton = document.getElementById('filePreviewNextBtn');
    if (!prevButton || !nextButton) return;
    const files = activeFilePreviewMode === 'file' && activeCollectionPreviewMessageId
        ? await getCollectionPreviewNavigationFiles()
        : [];
    const visible = files.length > 1 && files.some(file => file.id === activeFilePreviewFileId);
    prevButton.hidden = !visible;
    nextButton.hidden = !visible;
}

async function navigateFilePreview(delta) {
    if (mediaFullscreenHistoryOpen || document.getElementById('mediaFullscreenViewer')?.classList.contains('active')) return;
    if (activeFilePreviewMode !== 'file' || !activeCollectionPreviewMessageId || !activeFilePreviewFileId) return;
    const files = await getCollectionPreviewNavigationFiles();
    if (files.length <= 1) return;
    const currentIndex = files.findIndex(file => file.id === activeFilePreviewFileId);
    if (currentIndex < 0) return;
    const nextFile = files[(currentIndex + delta + files.length) % files.length];
    if (!nextFile?.id) return;
    await openFilePreviewForInfo(nextFile, {
        messageId: activeCollectionPreviewMessageId,
        collectionMessageId: activeCollectionPreviewMessageId,
        ownerDeviceId: nextFile.ownerDeviceId || activeFilePreviewOwnerDeviceId || '',
        requestMissing: false
    });
}

async function showFileDetailsForInfo(fileInfo, message = {}) {
    if (!fileInfo?.id) return;
    const storedFile = await getFromStore('files', fileInfo.id);
    const hasLocalData = hasCompleteFileCache(storedFile, fileInfo);
    activeFileDetailsMessageId = message.messageId || message.id || '';
    activeFileDetailsFileId = fileInfo.id;
    const details = [
        ['文件名', fileInfo.name || '未知文件'],
        ['扩展名', getFileExtension(fileInfo.name)],
        ['MIME 类型', fileInfo.type || 'application/octet-stream'],
        ['文件大小', formatFileSize(Number(fileInfo.size) || 0)],
        ['上传时间', formatDateTime(message.timestamp || fileInfo.timestamp || Date.now())],
        ['最初上传设备', message.senderName || fileInfo.senderName || '未知设备'],
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
    historyLog('file-details-opened', {
        messageId: activeFileDetailsMessageId,
        fileId: fileInfo.id,
        hasLocalData
    });
}

async function showFileDetails(messageId) {
    const message = await getFromStore('messages', messageId);
    const fileInfo = message?.fileInfo;
    if (fileInfo?.id) {
        await showFileDetailsForInfo(fileInfo, { ...message, messageId });
        return;
    }
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

async function createCollectionFileCard(fileInfo, collectionMessageId) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'collection-file-card';
    card.dataset.fileId = fileInfo.id;

    const thumb = document.createElement('div');
    thumb.className = 'collection-file-thumb';
    const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
    const hasLocalData = hasCompleteFileCache(storedFile, fileInfo);
    const type = String(fileInfo.type || storedFile?.type || '').toLowerCase();
    if (hasLocalData && type.startsWith('image/')) {
        const url = getStoredFileUrl(fileInfo.id, storedFile);
        const image = document.createElement('img');
        image.src = url;
        image.alt = fileInfo.name || '';
        image.loading = 'lazy';
        image.decoding = 'async';
        thumb.appendChild(image);
    } else if (hasLocalData && type.startsWith('video/')) {
        const poster = await ensureVideoPosterCache(storedFile, fileInfo);
        if (poster) {
            const image = document.createElement('img');
            image.src = poster;
            image.alt = fileInfo.name || '';
            image.loading = 'lazy';
            image.decoding = 'async';
            thumb.appendChild(image);
        }
    }
    if (!thumb.childNodes.length) {
        thumb.classList.add('collection-file-thumb--metadata');
        const stateLabel = hasLocalData
            ? (type.startsWith('video/') ? '视频' : type.startsWith('audio/') ? '音频' : '不可预览')
            : (storedFile?.cacheCleared ? '缓存已清理' : '本机未缓存');
        thumb.innerHTML = `
            <div class="file-icon">${getFileIcon(fileInfo.type || '')}</div>
            <div class="collection-file-state">${stateLabel}</div>
        `;
    }

    const name = document.createElement('div');
    name.className = 'collection-file-name';
    name.textContent = fileInfo.name || '未知文件';
    const size = document.createElement('div');
    size.className = 'collection-file-size';
    size.textContent = formatFileSize(Number(fileInfo.size) || 0);
    card.append(thumb, name, size);
    card.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        captureCollectionPreviewReturnState(collectionMessageId, fileInfo.id);
        openFilePreviewForInfo(fileInfo, {
            messageId: collectionMessageId,
            collectionMessageId,
            ownerDeviceId: fileInfo.ownerDeviceId,
            requestMissing: false
        }).catch(err => historyLog('collection-file-open-failed', {
            messageId: collectionMessageId,
            fileId: fileInfo.id,
            error: err.message
        }));
    });
    return card;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createCollectionDownloadDialog(totalCount, missingCount) {
    const overlay = document.createElement('div');
    overlay.className = 'collection-download-wait-overlay';
    overlay.innerHTML = `
        <div class="collection-download-wait-dialog" role="dialog" aria-modal="true" aria-label="合辑下载等待">
            <h3>正在准备合辑下载</h3>
            <p class="collection-download-wait-status">发现 ${missingCount} 个文件缺少本机缓存，正在拉取后打包。</p>
            <div class="collection-download-wait-bar"><span></span></div>
            <div class="collection-download-wait-detail"></div>
            <div class="collection-download-wait-actions">
                <button type="button" class="btn btn-secondary" data-action="cancel">取消</button>
                <button type="button" class="btn btn-primary" data-action="skip">不等了，先下载再说</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    const status = overlay.querySelector('.collection-download-wait-status');
    const detail = overlay.querySelector('.collection-download-wait-detail');
    const bar = overlay.querySelector('.collection-download-wait-bar span');
    let skipRequested = false;
    let cancelRequested = false;
    const waiters = [];
    const wakeWaiters = () => {
        while (waiters.length) waiters.pop()();
    };
    overlay.querySelector('[data-action="skip"]').addEventListener('click', () => {
        skipRequested = true;
        wakeWaiters();
    });
    overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        cancelRequested = true;
        wakeWaiters();
    });
    return {
        get skipRequested() { return skipRequested; },
        get cancelRequested() { return cancelRequested; },
        update(cachedCount) {
            const percent = totalCount > 0 ? Math.round((cachedCount / totalCount) * 100) : 100;
            status.textContent = cachedCount >= totalCount
                ? '缓存已就绪，正在生成 ZIP 压缩包。'
                : `正在拉取缺失缓存：${cachedCount}/${totalCount} 个文件已就绪。`;
            detail.textContent = cachedCount >= totalCount ? '请稍候，正在打包。' : '你也可以先下载当前已缓存的文件，ZIP 内可能不完整。';
            bar.style.width = `${Math.max(4, Math.min(100, percent))}%`;
        },
        setPacking() {
            status.textContent = '正在生成 ZIP 压缩包。';
            detail.textContent = '文件越多或越大，打包耗时越长。';
            bar.style.width = '100%';
        },
        async wait(ms) {
            if (skipRequested || cancelRequested) return;
            await Promise.race([
                sleep(ms),
                new Promise(resolve => waiters.push(resolve))
            ]);
        },
        close() {
            overlay.remove();
        }
    };
}

function uniqueZipPath(fileName, usedNames, index) {
    const rawName = String(fileName || `file-${index + 1}`).replace(/\\/g, '/').split('/').filter(Boolean).pop() || `file-${index + 1}`;
    if (!usedNames.has(rawName)) {
        usedNames.add(rawName);
        return rawName;
    }
    const dot = rawName.lastIndexOf('.');
    const base = dot > 0 ? rawName.slice(0, dot) : rawName;
    const ext = dot > 0 ? rawName.slice(dot) : '';
    let counter = 2;
    let next = `${base} (${counter})${ext}`;
    while (usedNames.has(next)) {
        counter++;
        next = `${base} (${counter})${ext}`;
    }
    usedNames.add(next);
    return next;
}

async function getCachedCollectionEntries(files) {
    const usedNames = new Set();
    const entries = [];
    for (let index = 0; index < files.length; index++) {
        const fileInfo = files[index];
        const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
        if (!hasCompleteFileCache(storedFile, fileInfo)) continue;
        const blob = new Blob([storedFile.data], { type: storedFile.type || fileInfo.type || 'application/octet-stream' });
        entries.push({
            name: fileInfo.name || storedFile.name || `file-${index + 1}`,
            path: uniqueZipPath(fileInfo.name || storedFile.name, usedNames, index),
            async arrayBuffer() { return blob.arrayBuffer(); }
        });
    }
    return entries;
}

function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function requestMissingCollectionFiles(files) {
    if (!fileAssetTransfer) return 0;
    let requested = 0;
    for (const fileInfo of files) {
        const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
        if (hasCompleteFileCache(storedFile, fileInfo) || !fileInfo.isAsset) continue;
        await saveToStore('files', {
            ...(storedFile || {}),
            id: fileInfo.id,
            name: fileInfo.name,
            type: fileInfo.type,
            size: fileInfo.size,
            sessionId: state.sessionId,
            ownerDeviceId: fileInfo.ownerDeviceId,
            isFileAsset: true,
            cacheCleared: Boolean(storedFile?.cacheCleared),
            restoreRequested: true,
            transferInterrupted: false,
            isPartial: false
        });
        fileAssetTransfer.requestProviderDiscovery?.(fileInfo.id, 'collection-download');
        fileAssetTransfer.request(fileInfo.id, fileInfo.ownerDeviceId || null, fileInfo, { priority: true, force: true })
            .catch(err => historyLog('collection-download-cache-request-failed', {
                fileId: fileInfo.id,
                error: err.message
            }));
        requested++;
    }
    return requested;
}

async function downloadCollectionFiles(files, collectionMessageId = '') {
    if (!window.FolderArchive?.createZip) {
        alert('当前页面缺少 ZIP 打包模块，无法下载合辑压缩包。');
        return;
    }
    const initialEntries = await getCachedCollectionEntries(files);
    const missingCount = Math.max(0, files.length - initialEntries.length);
    let entries = initialEntries;
    let dialog = null;
    if (missingCount > 0) {
        dialog = createCollectionDownloadDialog(files.length, missingCount);
        dialog.update(entries.length);
        await requestMissingCollectionFiles(files);
        const startedAt = Date.now();
        const maxWaitMs = 2 * 60 * 1000;
        while (!dialog.skipRequested && !dialog.cancelRequested && Date.now() - startedAt < maxWaitMs) {
            entries = await getCachedCollectionEntries(files);
            dialog.update(entries.length);
            if (entries.length >= files.length) break;
            await dialog.wait(500);
        }
        if (dialog.cancelRequested) {
            dialog.close();
            historyLog('collection-zip-download-cancelled', {
                messageId: collectionMessageId,
                totalCount: files.length,
                cachedCount: entries.length
            });
            return;
        }
        entries = await getCachedCollectionEntries(files);
        dialog.update(entries.length);
    }
    if (!entries.length) {
        dialog?.close();
        alert('当前没有任何已缓存文件可打包下载。');
        return;
    }
    dialog?.setPacking();
    const zipBlob = await window.FolderArchive.createZip(entries);
    dialog?.close();
    const suffix = entries.length === files.length ? '' : `-部分${entries.length}of${files.length}`;
    downloadBlob(zipBlob, `合辑-${collectionMessageId || Date.now()}${suffix}.zip`);
    if (entries.length < files.length) {
        alert(`已打包下载 ${entries.length} 个已缓存文件，另有 ${files.length - entries.length} 个文件仍未完成缓存。`);
    }
    historyLog('collection-zip-downloaded', { messageId: collectionMessageId, totalCount: files.length, zippedCount: entries.length });
}

async function openCollectionRecord(messageId, options = {}) {
    setFilePreviewFullscreenButton(false);
    activeFilePreviewCanFullscreen = false;
    activeFilePreviewMediaType = '';
    const message = await getFromStore('messages', messageId);
    const files = getCollectionFiles(message);
    if (!files.length) return;
    filePreviewReturnCollectionMessageId = '';
    activeFilePreviewMode = 'collection';
    activeCollectionPreviewMessageId = messageId;
    activeFilePreviewFileId = '';
    activeFilePreviewMessageId = '';
    activeFilePreviewOwnerDeviceId = '';
    updateFilePreviewNavigationControls().catch(err => historyLog('file-preview-nav-update-failed', { error: err.message }));

    const title = document.getElementById('filePreviewTitle');
    const content = setFilePreviewContentStage('collection-stage');
    title.textContent = `合辑 · ${files.length} 个文件`;
    content.replaceChildren();
    const grid = document.createElement('div');
    grid.className = 'collection-file-grid';
    for (const fileInfo of files) {
        grid.appendChild(await createCollectionFileCard(fileInfo, messageId));
    }
    content.appendChild(grid);
    requestAnimationFrame(() => {
        const anchorFileId = options.anchorFileId || '';
        const anchor = anchorFileId ? grid.querySelector(`.collection-file-card[data-file-id="${CSS.escape(anchorFileId)}"]`) : null;
        if (anchor) {
            anchor.scrollIntoView({ block: 'center' });
            anchor.classList.add('collection-file-card--focused');
            setTimeout(() => anchor.classList.remove('collection-file-card--focused'), 900);
        } else if (Number.isFinite(Number(options.scrollTop))) {
            grid.scrollTop = Number(options.scrollTop) || 0;
        }
    });
    setFilePreviewActions([
        createFileActionButton('下载全部', '拉取缺失缓存后打包下载整个合辑 ZIP', () => {
            downloadCollectionFiles(files, messageId).catch(err => {
                alert(`合辑下载失败: ${err.message}`);
                historyLog('collection-download-failed', { messageId, error: err.message });
            });
        })
    ]);
    openFilePreviewHistory(document.getElementById('filePreviewViewer'), { stage: 'collection' });
    historyLog('collection-preview-opened', { messageId, fileCount: files.length });
}

function attachCollectionRecordInteractions(messageEl) {
    const messageId = messageEl.dataset.messageId;
    messageEl.addEventListener('click', event => {
        if (event.target.closest('.file-cache-retry, .message-record-actions')) return;
        openCollectionRecord(messageId).catch(err => historyLog('collection-record-open-failed', {
            messageId,
            error: err.message
        }));
    });
}

function attachFileRecordInteractions(messageEl) {
    let longPressTimer = null;
    let suppressClickUntil = 0;
    let startPoint = null;
    const messageId = messageEl.dataset.messageId;
    const isAction = target => Boolean(target.closest('.file-actions, .file-cache-retry'));
    const cancelLongPress = () => {
        if (longPressTimer) clearTimeout(longPressTimer);
        longPressTimer = null;
        startPoint = null;
    };
    const clearSelection = () => {
        try {
            window.getSelection?.()?.removeAllRanges();
        } catch {}
    };

    messageEl.addEventListener('click', event => {
        if (isAction(event.target) || Date.now() < suppressClickUntil) return;
        openFileRecord(messageId).catch(err => historyLog('file-record-open-failed', { messageId, error: err.message }));
    });
    messageEl.addEventListener('contextmenu', event => {
        if (isAction(event.target)) return;
        event.preventDefault();
        clearSelection();
        suppressClickUntil = Date.now() + 500;
        showFileDetails(messageId).catch(err => historyLog('file-details-open-failed', { messageId, error: err.message }));
    });
    messageEl.addEventListener('selectstart', event => {
        if (!isAction(event.target)) event.preventDefault();
    });
    messageEl.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'touch' || isAction(event.target)) return;
        startPoint = { x: event.clientX, y: event.clientY };
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            suppressClickUntil = Date.now() + 700;
            clearSelection();
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

function showFileMessagePlaceholder(fileId, label, cacheCleared = false, restoreRequested = false) {
    preserveChatScroll(() => document.querySelectorAll(`.message[data-file-id="${fileId}"]`).forEach(messageEl => {
        const fileInfo = getFileInfoFromMessageElement(messageEl);
        const bubble = messageEl.querySelector('.message-bubble');
        if (!bubble) return;
        bubble.className = 'message-bubble file-message file-cache-retry-target';
        bubble.removeAttribute('onclick');
        bubble.style.opacity = '0.6';
        bubble.innerHTML = `
            <div class="file-icon">${getFileIcon(fileInfo.type)}</div>
            <div class="file-info">
                <div class="file-name">${escapeHtml(fileInfo.name)}</div>
                <div class="file-size">${formatFileSize(fileInfo.size)} (${label})</div>
            </div>
        `;
        renderFileMessageActions(messageEl, fileInfo, { hasLocalData: false, cacheCleared, restoreRequested });
    }));
}

async function refreshFileMessage(fileId) {
    const storedFile = await getFromStore('files', fileId);
    if (!hasCompleteFileCache(storedFile)) return;
    hideCompletedFileReceiveProgress(fileId);

    let url = fileObjectUrls.get(fileId);
    if (!url) {
        url = URL.createObjectURL(new Blob([storedFile.data], { type: storedFile.type }));
        fileObjectUrls.set(fileId, url);
    }

    const poster = String(storedFile.type || '').toLowerCase().startsWith('video/')
        ? await ensureVideoPosterCache(storedFile, storedFile)
        : '';

    preserveChatScroll(() => document.querySelectorAll(`.message[data-file-id="${fileId}"]`).forEach(messageEl => {
        const fileInfo = getFileInfoFromMessageElement(messageEl);
        const type = fileInfo.type || storedFile.type;
        const name = escapeHtml(fileInfo.name || storedFile.name);
        const bubble = messageEl.querySelector('.message-bubble');
        if (!bubble) return;

        if (type.startsWith('image/')) {
            bubble.innerHTML = `<div class="media-preview"><img src="${url}" alt="${name}" loading="lazy" decoding="async"></div><div class="file-size media-file-size">${formatFileSize(storedFile.size)}</div>`;
            bubble.classList.remove('file-message');
            bubble.style.opacity = '';
        } else if (type.startsWith('video/')) {
            bubble.innerHTML = `<div class="media-preview">${poster ? `<img src="${poster}" alt="${name}" loading="lazy" decoding="async">` : `<video muted playsinline preload="none" src="${url}"></video>`}</div><div class="file-size media-file-size">${formatFileSize(storedFile.size)}</div>`;
            bubble.classList.remove('file-message');
            bubble.style.opacity = '';
        } else {
            bubble.style.opacity = '';
            bubble.removeAttribute('onclick');
            const size = bubble.querySelector('.file-size');
            if (size) size.textContent = formatFileSize(storedFile.size);
        }
        renderFileMessageActions(messageEl, fileInfo, { hasLocalData: true, cacheCleared: false });
    }));
    await refreshCollectionMessagesForFile(fileId);
    await refreshCollectionPreviewCardForFile(fileId);
    await refreshActiveFilePreviewForFile(fileId);
}

async function refreshCollectionMessagesForFile(fileId) {
    const messageEls = Array.from(document.querySelectorAll('.message.collection-record'));
    for (const messageEl of messageEls) {
        const messageId = messageEl.dataset.messageId;
        const message = await getFromStore('messages', messageId).catch(() => null);
        if (!getCollectionFiles(message).some(file => file.id === fileId)) continue;
        const html = await renderCollectionPreviewHtml(message);
        preserveChatScroll(() => {
            const bubble = messageEl.querySelector('.message-bubble');
            if (bubble) bubble.outerHTML = html;
        });
    }
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

    if (state.devices.size === 0) {
        const ok = confirm('请确认这个文件在其它设备已缓存，否则将无法恢复。继续清除本机缓存吗？');
        if (!ok) return;
    }

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
        isFileAsset: Boolean(fileInfo.isAsset || fileInfo.isServerAsset),
        isServerAsset: Boolean(fileInfo.isServerAsset),
        serverAssetUrl: fileInfo.serverAssetUrl || '',
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
    showFileMessagePlaceholder(fileInfo.id, '本地缓存已清理', true, false);
    historyLog('file-cache-cleared', { messageId, fileId: fileInfo.id });
}

async function restoreFileCache(messageId, options = {}) {
    const message = await getFromStore('messages', messageId);
    const fileInfo = message?.fileInfo;
    if (fileInfo?.isServerAsset && fileInfo.serverAssetUrl) {
        await fetchServerAssetCache(fileInfo, options.force ? 'message-force-restore' : 'message-restore');
        await refreshFileMessage(fileInfo.id);
        historyLog('file-cache-server-restore-requested', { messageId, fileId: fileInfo.id });
        return;
    }
    if (!fileInfo?.id || !fileInfo.isAsset) {
        alert('此历史文件没有可用的远程文件来源，无法还原。');
        return;
    }

    if (options.force && shouldBlockForceRestore(fileInfo.id)) {
        const progressState = getFileReceiveProgressState(fileInfo.id);
        alert(`文件正在拉取中，当前约 ${progressState.progress}%，且最近仍在推进。暂不强制重拉，避免浪费已完成的传输。`);
        historyLog('file-cache-force-restore-blocked', {
            messageId,
            fileId: fileInfo.id,
            progress: progressState.progress,
            staleForMs: progressState.staleForMs,
            transport: progressState.transport
        });
        return;
    }

    if (options.force) {
        fileAssetTransfer?.cancel(fileInfo.id);
        hideProgress(fileInfo.id);
        fileTransferProgressStates.delete(fileInfo.id);
    }

    const storedFile = await getFromStore('files', fileInfo.id);
    if (hasCompleteFileCache(storedFile, fileInfo)) {
        await saveToStore('files', {
            ...storedFile,
            cacheCleared: false,
            restoreRequested: false,
            transferInterrupted: false,
            isPartial: false
        });
        await refreshFileMessage(fileInfo.id);
        historyLog('file-cache-restore-skipped-local-complete', { messageId, fileId: fileInfo.id });
        return;
    }
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
        restoreRequested: true,
        transferInterrupted: false
    });
    showFileMessagePlaceholder(fileInfo.id, '正在请求还原', true, true);
    await fileAssetTransfer.requestProviderDiscovery?.(fileInfo.id, options.force ? 'message-force-restore' : 'message-restore');
    await fileAssetTransfer.request(fileInfo.id, fileInfo.ownerDeviceId || message.sender || null, fileInfo, {
        force: Boolean(options.force),
        priority: true
    });
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

async function applyHistoryMessageUpdate(message, options = {}) {
    if (!message?.id) return;
    const previous = await getFromStore('messages', message.id).catch(() => null);
    if (previous?.type === 'collection' && message.type === 'collection') {
        const nextIds = new Set(getCollectionFiles(message).map(file => file.id));
        const removedFiles = getCollectionFiles(previous).filter(file => !nextIds.has(file.id));
        for (const fileInfo of removedFiles) {
            await deleteFileCacheIfUnreferenced(fileInfo.id, message.id);
        }
    }
    await saveToStore('messages', {
        ...message,
        sessionId: state.sessionId
    });

    const wasOwn = message.sender === state.deviceId;
    if (previous?.type === 'collection' && message.type === 'collection') {
        await updateCollectionMessageElement(message);
        await applyCollectionPreviewIncrementalUpdate(previous, message);
    } else {
        const existingElement = getMessageElement(message.id);
        const shouldScroll = Boolean(existingElement && isChatNearBottom(document.getElementById('chatMessages')));
        existingElement?.remove();
        await addMessageToChat(message, wasOwn, {
            scroll: shouldScroll,
            autoRequestAsset: !options.remote
        });
        if (activeCollectionPreviewMessageId === message.id) {
            if (activeFilePreviewMode === 'collection' ||
                (activeFilePreviewMode === 'file' && activeFilePreviewFileId && !getCollectionFiles(message).some(file => file.id === activeFilePreviewFileId))) {
                await openCollectionRecord(message.id).catch(err => historyLog('collection-preview-refresh-after-update-failed', {
                    messageId: message.id,
                    error: err.message
                }));
            }
        }
    }
    historyLog('history-message-updated-locally', {
        message: summarizeHistoryMessage(message),
        remote: Boolean(options.remote)
    });
}

async function updateHistoryMessage(message) {
    await applyHistoryMessageUpdate(message);
    state.socket?.emit('update-message', {
        sessionId: state.sessionId,
        message
    });
}

async function deleteFileCacheIfUnreferenced(fileId, excludingMessageId = null) {
    if (!fileId) return;
    fileAssetTransfer?.cancel(fileId);
    const stillReferenced = await isFileReferencedByRichContent(fileId, excludingMessageId);
    if (stillReferenced) return;
    await deleteFromStore('files', fileId);
    const objectUrl = fileObjectUrls.get(fileId);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    fileObjectUrls.delete(fileId);
}

async function deleteFileFromCollection(collectionMessageId, fileId) {
    const message = await getFromStore('messages', collectionMessageId);
    const files = getCollectionFiles(message);
    const removedFile = files.find(file => file.id === fileId);
    if (!message || !removedFile) return;
    if (!confirm('删除会同步移除所有设备中合辑里的这个文件，并清理其文件缓存。继续吗？')) return;

    const nextFiles = files.filter(file => file.id !== fileId);
    await deleteFileCacheIfUnreferenced(fileId, collectionMessageId);
    if (!nextFiles.length) {
        closeFilePreview({ forceClose: true });
        await deleteHistoryMessageLocal(collectionMessageId);
        state.socket?.emit('delete-message', { sessionId: state.sessionId, messageId: collectionMessageId });
        return;
    }

    const nextMessage = {
        ...message,
        collection: {
            ...message.collection,
            files: nextFiles,
            count: nextFiles.length,
            totalSize: nextFiles.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
        },
        updatedAt: Date.now()
    };
    await updateHistoryMessage(nextMessage);
    filePreviewReturnCollectionMessageId = '';
    historyLog('collection-file-deleted', {
        messageId: collectionMessageId,
        fileId,
        remainingCount: nextFiles.length
    });
}

async function deleteHistoryMessageLocal(messageId) {
    const message = await getFromStore('messages', messageId);
    if (message?.type === 'collection') {
        for (const fileInfo of getCollectionFiles(message)) {
            const fileId = fileInfo.id;
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
    }
    if (message?.type === 'rich') {
        const richFileIds = new Set([
            ...extractAssetIds(message.content),
            ...extractFileRefIds(message.content)
        ]);
        for (const fileId of richFileIds) {
            await deleteFileCacheIfUnreferenced(fileId, messageId);
        }
    }
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
    if (activeCollectionPreviewMessageId === messageId || activeFileDetailsMessageId === messageId) {
        closeFileDetails();
        closeFilePreview({ forceClose: true, fromHistory: true });
    }
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
        if (!message || message.id === excludingMessageId) continue;
        if (message.type === 'rich' && extractFileRefIds(message.content).includes(fileId)) return true;
        if (message.type === 'file' && message.fileInfo?.id === fileId) return true;
        if (message.type === 'collection' && getCollectionFiles(message).some(file => file.id === fileId)) return true;
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
        if (message.type === 'collection') {
            getCollectionFiles(message).forEach(file => referenced.add(file.id));
        }
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
    const dialog = document.createElement('div');
    dialog.className = 'modal-overlay active';
    dialog.innerHTML = `
        <div class="modal">
            <h3>清理垃圾缓存</h3>
            <p>正在扫描本机会话缓存...</p>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="cancelGarbageCleanup">关闭</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);
    dialog.querySelector('#cancelGarbageCleanup').addEventListener('click', () => dialog.remove());

    await new Promise(resolve => requestAnimationFrame(resolve));
    const files = await findGarbageFileCaches();
    if (!files.length) {
        dialog.querySelector('.modal').innerHTML = `
            <h3>清理垃圾缓存</h3>
            <p>没有发现可清理的游离文件缓存或中断传输缓存。</p>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="cancelGarbageCleanup">关闭</button>
            </div>
        `;
        dialog.querySelector('#cancelGarbageCleanup').addEventListener('click', () => dialog.remove());
        return;
    }
    const totalSize = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    const preview = files.slice(0, 20)
        .map(file => `<li>${escapeHtml(file.name || file.id)} (${formatFileSize(Number(file.size) || 0)})</li>`)
        .join('');
    const remaining = files.length > 20 ? `<p>另有 ${files.length - 20} 项未展开。</p>` : '';
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
    if (reference.kind === 'collection-file') return `合辑文件${time}`;
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
        if (message.type === 'collection') {
            getCollectionFiles(message).forEach(fileInfo => {
                if (!fileInfo?.id) return;
                upsertResource(fileInfo);
                addReference(fileInfo.id, {
                    kind: 'collection-file',
                    messageId: message.id,
                    timestamp: message.timestamp,
                    targetAssetId: fileInfo.id
                });
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
    if (hasCompleteFileCache(file, resource)) {
        await saveToStore('files', {
            ...file,
            cacheCleared: false,
            restoreRequested: false,
            transferInterrupted: false,
            isPartial: false
        });
        if (resource.isEditorAsset) {
            hydrateEditorAssets(document.getElementById('editor')).catch(() => {});
        } else {
            await refreshFileMessage(resource.id);
        }
        historyLog('resource-restore-skipped-local-complete', { resourceId: resource.id });
        return;
    }
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
    showFileMessagePlaceholder(resource.id, '正在请求还原', true, true);
    await fileAssetTransfer.request(resource.id, resource.ownerDeviceId, metadata, { force: true, priority: true });
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

async function publishHistoryMessage(message, options = {}) {
    if (!message.timestamp) message.timestamp = nextHistoryTimestamp();
    lastLocalHistoryTimestamp = Math.max(lastLocalHistoryTimestamp, Number(message.timestamp) || 0);
    await saveToStore('messages', {
        ...message,
        sessionId: state.sessionId
    });

    historyLog('local-message-stored', {
        message: summarizeHistoryMessage(message)
    });

    historyLog('realtime-message-emitted', {
        message: summarizeHistoryMessage(message)
    });
    pendingHistoryMessageIds.add(message.id);
    state.socket.emit('message', {
        sessionId: state.sessionId,
        message
    });
    setTimeout(() => {
        if (!pendingHistoryMessageIds.has(message.id)) return;
        historyLog('realtime-message-ack-timeout', {
            message: summarizeHistoryMessage(message)
        });
        requestSessionHistory('message-ack-timeout');
    }, 5000);

    await addMessageToChat(message, true, { forceScroll: options.forceScroll !== false });
}

async function sendText() {
    const input = document.getElementById('textInput');
    const text = input.value.trim();

    if (!text) return;

    const message = {
        id: generateId(),
        type: 'text',
        text,
        timestamp: nextHistoryTimestamp(),
        sender: state.deviceId,
        senderName: state.deviceName
    };

    await publishHistoryMessage(message);
    input.value = '';
}

// ==================== 协同编辑 ====================
function isEditorContentEmpty(content) {
    return !content || content
        .replace(/<br\s*\/?\s*>/gi, '')
        .replace(/&nbsp;/gi, '')
        .trim() === '';
}

function getPlainTextEditorMessage(content) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = content || '';
    const allowedTags = new Set(['DIV', 'P', 'BR']);
    const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
        if (!allowedTags.has(node.tagName) || node.attributes.length > 0) {
            return null;
        }
        node = walker.nextNode();
    }

    const lines = [];
    let currentLine = '';
    const appendNode = item => {
        if (item.nodeType === Node.TEXT_NODE) {
            currentLine += item.nodeValue || '';
            return;
        }
        if (item.nodeType !== Node.ELEMENT_NODE) return;
        if (item.tagName === 'BR') {
            lines.push(currentLine);
            currentLine = '';
            return;
        }
        const isBlock = item.tagName === 'DIV' || item.tagName === 'P';
        const beforeLength = currentLine.length;
        Array.from(item.childNodes).forEach(appendNode);
        if (isBlock && (currentLine.length > beforeLength || item.childNodes.length === 0)) {
            lines.push(currentLine);
            currentLine = '';
        }
    };
    Array.from(wrapper.childNodes).forEach(appendNode);
    if (currentLine) lines.push(currentLine);
    const text = lines.join('\n').replace(/\u00a0/g, ' ').trim();
    return text ? text : null;
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

async function getReferenceableSessionFiles() {
    let files = [];

    if (typeof IDBKeyRange !== 'undefined') {
        files = await getAllFromStore('files', 'sessionId', IDBKeyRange.only(state.sessionId));
    } else {
        const allFiles = await getAllFromStore('files');
        files = allFiles.filter(f => f.sessionId === state.sessionId);
    }

    return files
        .filter(file =>
            file &&
            !file.isEditorAsset &&
            !file.isPartial &&
            !file.transferInterrupted &&
            !file.cacheCleared &&
            hasCompleteFileCache(file, file)
        )
        .filter((file, index, list) => list.findIndex(item => item.id === file.id) === index);
}

function getFilePreviewObjectUrl(file) {
    if (!file?.id || !hasCompleteFileCache(file, file)) return '';
    let url = fileObjectUrls.get(file.id);
    if (!url) {
        url = URL.createObjectURL(new Blob([file.data], { type: file.type || 'application/octet-stream' }));
        fileObjectUrls.set(file.id, url);
    }
    return url;
}

function createEditorFilePickerIcon(file) {
    const icon = document.createElement('span');
    icon.className = 'editor-file-picker-icon';
    icon.textContent = getFileIcon(file?.type || '');
    return icon;
}

function updateEditorFileSelectButton(button, file) {
    button.replaceChildren();
    button.appendChild(createEditorFilePickerIcon(file));
    const name = document.createElement('span');
    name.className = 'editor-file-picker-name';
    name.textContent = `${file.name} (${formatFileSize(file.size)})`;
    name.title = name.textContent;
    const arrow = document.createElement('span');
    arrow.textContent = '▾';
    button.append(name, arrow);
}

function createEditorFileTile(file, selectedId, onSelect) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `editor-file-tile ${file.id === selectedId ? 'active' : ''}`.trim();
    tile.title = file.name;

    const preview = document.createElement('div');
    preview.className = 'editor-file-tile-preview';
    const type = String(file.type || '').toLowerCase();
    const url = getFilePreviewObjectUrl(file);
    if (url && type.startsWith('image/')) {
        const image = document.createElement('img');
        image.src = url;
        image.alt = file.name || 'preview';
        image.loading = 'lazy';
        preview.appendChild(image);
    } else if (url && type.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = url;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';
        preview.appendChild(video);
    } else {
        preview.textContent = getFileIcon(file.type || '');
    }

    const name = document.createElement('div');
    name.className = 'editor-file-tile-name';
    name.textContent = file.name;
    tile.append(preview, name);
    tile.addEventListener('click', () => onSelect(file));
    return tile;
}

function openEditorFileGrid(files, selectedId, onSelect) {
    const dialog = document.createElement('div');
    dialog.className = 'modal-overlay active';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.maxWidth = '760px';
    modal.style.width = 'min(94vw, 760px)';
    modal.style.textAlign = 'left';

    const title = document.createElement('h3');
    title.textContent = '选择引用文件';
    const grid = document.createElement('div');
    grid.className = 'editor-file-grid';
    files.forEach(file => {
        grid.appendChild(createEditorFileTile(file, selectedId, selected => {
            onSelect(selected);
            dialog.remove();
        }));
    });
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-secondary';
    close.textContent = '关闭';
    close.addEventListener('click', () => dialog.remove());
    actions.appendChild(close);
    modal.append(title, grid, actions);
    dialog.appendChild(modal);
    document.body.appendChild(dialog);
}

async function insertEditorReferencedFile(file, savedRange, insertEditorHtml, editor, syncEditorNow) {
    let refHtml = '';
    if (file.type.startsWith('image/')) {
        const asset = await createEditorAssetFromStoredFile(file);
        refHtml = createEditorAssetHtml(asset);
    } else {
        refHtml = `<span data-tunnel-file-ref-id="${escapeHtml(file.id)}" style="background: #667eea; color: white; padding: 5px 10px; border-radius: 5px; cursor: pointer;" onclick="downloadFile('${file.id}')">${getFileIcon(file.type)} ${escapeHtml(file.name)}</span>`;
    }

    if (getEditorContentSize(editor.innerHTML + refHtml) > MAX_EDITOR_CONTENT_SIZE) {
        historyLog('editor-file-reference-rejected', {
            reason: 'content-too-large',
            fileId: file.id,
            fileSize: file.size
        });
        throw new Error('引用内容过大，无法同步到其它设备');
    }

    insertEditorHtml(refHtml, savedRange);
    await hydrateEditorAssets(editor);
    await syncEditorNow(file.type.startsWith('image/') ? 'image-reference-inserted' : 'file-reference-inserted');
}

function openEditorFileReferenceDialog(files, savedRange, insertEditorHtml, editor, syncEditorNow) {
    let selectedFile = files[0];
    const dialog = document.createElement('div');
    dialog.className = 'modal-overlay active';
    const modal = document.createElement('div');
    modal.className = 'modal';

    const title = document.createElement('h3');
    title.textContent = '引用文件';

    const picker = document.createElement('div');
    picker.className = 'editor-file-reference-picker';
    const select = document.createElement('div');
    select.className = 'editor-file-select';
    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'editor-file-select-button';
    const menu = document.createElement('div');
    menu.className = 'editor-file-select-menu';

    const renderOptions = () => {
        menu.replaceChildren();
        files.forEach(file => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = `editor-file-option ${file.id === selectedFile.id ? 'active' : ''}`.trim();
            option.appendChild(createEditorFilePickerIcon(file));
            const name = document.createElement('span');
            name.className = 'editor-file-picker-name';
            name.textContent = `${file.name} (${formatFileSize(file.size)})`;
            name.title = name.textContent;
            option.appendChild(name);
            option.addEventListener('click', () => {
                selectedFile = file;
                updateEditorFileSelectButton(selectButton, selectedFile);
                renderOptions();
                select.classList.remove('open');
            });
            menu.appendChild(option);
        });
    };

    updateEditorFileSelectButton(selectButton, selectedFile);
    renderOptions();
    selectButton.addEventListener('click', () => select.classList.toggle('open'));
    select.append(selectButton, menu);

    const gridButton = document.createElement('button');
    gridButton.type = 'button';
    gridButton.className = 'editor-file-grid-button';
    gridButton.title = '以方阵查看文件';
    gridButton.setAttribute('aria-label', '以方阵查看文件');
    gridButton.textContent = '▦';
    gridButton.addEventListener('click', () => {
        openEditorFileGrid(files, selectedFile.id, file => {
            selectedFile = file;
            updateEditorFileSelectButton(selectButton, selectedFile);
            renderOptions();
        });
    });
    picker.append(select, gridButton);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-secondary';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => dialog.remove());
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary';
    confirm.textContent = '插入';
    confirm.addEventListener('click', async () => {
        try {
            await insertEditorReferencedFile(selectedFile, savedRange, insertEditorHtml, editor, syncEditorNow);
            dialog.remove();
        } catch (err) {
            alert(err.message);
        }
    });
    actions.append(cancel, confirm);
    modal.append(title, picker, actions);
    dialog.appendChild(modal);
    document.body.appendChild(dialog);
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
        const referenceFiles = await getReferenceableSessionFiles();
        if (referenceFiles.length === 0) {
            alert('暂无文件可引用');
            return;
        }
        openEditorFileReferenceDialog(referenceFiles, savedRange, insertEditorHtml, editor, syncEditorNow);
        return;
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
        if (isEditorContentEmpty(content)) {
            alert('请输入内容');
            return;
        }

        const plainText = getPlainTextEditorMessage(content);
        const message = plainText ? {
            id: generateId(),
            type: 'text',
            text: plainText,
            timestamp: nextHistoryTimestamp(),
            sender: state.deviceId,
            senderName: state.deviceName
        } : {
            id: generateId(),
            type: 'rich',
            content,
            timestamp: nextHistoryTimestamp(),
            sender: state.deviceId,
            senderName: state.deviceName
        };

        await publishHistoryMessage(message);
        if (message.type === 'rich') openSentRichRecord(message.id);
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
        internalIp: data.internalIp || data.localIp,
        externalIp: data.externalIp,
        joinedAt: Date.now()
    });

    updateDeviceList();

    // 尝试建立P2P连接
    connectToPeer(deviceId);
    scheduleStoredFileAssetAnnounce('device-joined');
    setTimeout(() => {
        reconcileLocalHistory([], [])
            .catch(err => historyLog('history-reconcile-on-device-joined-failed', {
                peerDeviceId: deviceId,
                error: err.message
            }));
    }, 600);
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
    const devices = Array.isArray(data?.devices) ? data.devices : [];
    const seenDeviceIds = new Set();

    devices.forEach(device => {
        if (device.deviceId !== state.deviceId) {
            seenDeviceIds.add(device.deviceId);
            state.devices.set(device.deviceId, {
                id: device.deviceId,
                name: device.deviceName,
                model: device.deviceModel,
                internalIp: device.internalIp || device.localIp,
                externalIp: device.externalIp,
                joinedAt: device.joinedAt
            });

            // 建立P2P连接
            connectToPeer(device.deviceId);
        }
    });
    Array.from(state.devices.keys()).forEach(deviceId => {
        if (!seenDeviceIds.has(deviceId)) {
            const pc = state.peers.get(deviceId);
            if (pc) pc.close();
            state.peers.delete(deviceId);
            state.dataChannels.delete(deviceId);
            state.pendingIceCandidates.delete(deviceId);
            state.devices.delete(deviceId);
        }
    });

    updateDeviceList();
    scheduleStoredFileAssetAnnounce('session-devices', 1200);
}

function handleDeviceUpdated(data) {
    if (!data?.deviceId || data.deviceId === state.deviceId) return;
    const existing = state.devices.get(data.deviceId);
    state.devices.set(data.deviceId, {
        ...(existing || {}),
        id: data.deviceId,
        name: data.deviceName || existing?.name || '未知设备',
        model: data.deviceModel || existing?.model || '',
        internalIp: data.internalIp || data.localIp || existing?.internalIp || null,
        externalIp: data.externalIp || existing?.externalIp || null
    });
    if (!existing) connectToPeer(data.deviceId);
    updateDeviceList();
    scheduleStoredFileAssetAnnounce('device-updated');
}

function getSelfContactProfile() {
    const profileUrl = getDeviceProfileUrl(state.deviceId);
    return {
        deviceId: state.deviceId,
        name: state.deviceName,
        model: state.selfNetworkInfo?.deviceModel || state.deviceModel || '',
        internalIp: state.selfNetworkInfo?.internalIp || state.reportedLanIp || '',
        externalIp: state.selfNetworkInfo?.externalIp || '',
        sessionId: state.sessionId,
        shortCode: state.shortCode || '',
        profileUrl
    };
}

function getDeviceProfileUrl(deviceId) {
    return deviceId ? `${window.location.origin}/device/${encodeURIComponent(deviceId)}` : '';
}

function normalizeContactProfile(device = {}) {
    const deviceId = device.deviceId || device.id;
    return {
        deviceId,
        name: device.name || device.deviceName || 'Unknown device',
        model: device.model || device.deviceModel || '',
        internalIp: device.internalIp || device.localIp || '',
        externalIp: device.externalIp || '',
        sessionId: device.sessionId || state.sessionId || '',
        shortCode: device.shortCode || state.shortCode || '',
        profileUrl: getDeviceProfileUrl(deviceId) || device.profileUrl || '',
        followedAt: device.followedAt || Date.now(),
        lastSeenAt: Date.now()
    };
}

async function loadContacts() {
    const contacts = await getAllFromStore('contacts').catch(() => []);
    state.contacts.clear();
    contacts
        .filter(contact => contact?.deviceId)
        .sort((a, b) => (b.lastSeenAt || b.followedAt || 0) - (a.lastSeenAt || a.followedAt || 0))
        .forEach(contact => state.contacts.set(contact.deviceId, contact));
    renderContacts();
}

async function followDevice(device) {
    const contact = normalizeContactProfile(device);
    if (!contact.deviceId || contact.deviceId === state.deviceId) return;
    const existing = await getFromStore('contacts', contact.deviceId).catch(() => null);
    const merged = {
        ...(existing || {}),
        ...contact,
        followedAt: existing?.followedAt || Date.now(),
        lastSeenAt: Date.now()
    };
    await saveToStore('contacts', merged);
    state.contacts.set(merged.deviceId, merged);
    renderContacts();
    historyLog('contact-followed', { contactDeviceId: merged.deviceId });
}

async function unfollowDevice(deviceId) {
    if (!deviceId) return;
    await deleteFromStore('contacts', deviceId);
    state.contacts.delete(deviceId);
    renderContacts();
    updateDeviceList();
    historyLog('contact-unfollowed', { contactDeviceId: deviceId });
}

async function startIntercomWithDevice(device) {
    try {
        if (!device?.deviceId) return;
        const recipients = mediaController?.intercom?.recipients || [];
        const directIntercomTargetId = recipients.length === 1 ? recipients[0] : null;
        if (device.deviceId === directIntercomTargetId) {
            mediaController.stopIntercom();
        } else {
            if (mediaController.intercom) mediaController.stopIntercom();
            await mediaController.startIntercom([device.deviceId]);
        }
    } catch (err) {
        alert(`无法启动对讲机: ${err.message}`);
        historyLog('intercom-start-failed', { peerDeviceId: device?.deviceId, error: err.message });
    }
}

function renderDeviceRow(device, options = {}) {
    const normalized = normalizeContactProfile(device);
    const isSelf = normalized.deviceId === state.deviceId;
    const dataChannelId = device.id || normalized.deviceId;
    const recipients = mediaController?.intercom?.recipients || [];
    const directIntercomTargetId = recipients.length === 1 ? recipients[0] : null;
    const el = document.createElement('div');
    el.className = options.contact ? 'contact-item device-item' : 'device-item';
    el.innerHTML = `
        <div class="icon">${isSelf ? '👤' : '📱'}</div>
        <div class="info">
            <div class="name"></div>
            <div class="status"></div>
        </div>
    `;
    const name = el.querySelector('.name');
    name.textContent = `${normalized.name || normalized.deviceId}${isSelf ? ' (我)' : ''}`;
    makeDeviceNameInteractive(name, normalized);
    const status = el.querySelector('.status');
    status.textContent = isSelf
        ? '在线'
        : (options.contact
            ? `${normalized.model || '未知设备'} · ${normalized.deviceId.slice(0, 8)}...`
            : `在线 · P2P${state.dataChannels.has(dataChannelId) ? '已连接' : '连接中'}`);

    if (!isSelf) {
        const actions = document.createElement('div');
        actions.className = 'device-actions';
        const intercomButton = document.createElement('button');
        intercomButton.className = 'icon-action';
        intercomButton.type = 'button';
        intercomButton.title = `${normalized.deviceId === directIntercomTargetId ? '关闭' : '发起'}对讲`;
        intercomButton.textContent = normalized.deviceId === directIntercomTargetId ? '×' : '📢';
        intercomButton.addEventListener('click', () => startIntercomWithDevice(normalized));
        actions.appendChild(intercomButton);
        el.appendChild(actions);
    }
    return el;
}

function renderContacts() {
    const container = document.getElementById('contactList');
    if (!container) return;
    container.innerHTML = '';
    const contacts = Array.from(state.contacts.values());
    if (!contacts.length) {
        const empty = document.createElement('div');
        empty.className = 'contact-meta';
        empty.textContent = '还没有关注设备。点击设备名称可查看资料并关注。';
        container.appendChild(empty);
        return;
    }
    contacts.forEach(contact => {
        container.appendChild(renderDeviceRow(contact, { contact: true }));
    });
}

function showDeviceProfile(device, options = {}) {
    const profile = normalizeContactProfile(device);
    const modal = document.getElementById('deviceProfileModal');
    const title = document.getElementById('deviceProfileTitle');
    const fields = document.getElementById('deviceProfileFields');
    const qr = document.getElementById('deviceProfileQr');
    const followButton = document.getElementById('followDeviceBtn');
    if (!modal || !title || !fields || !qr || !followButton) return;

    title.textContent = profile.name || '设备资料';
    fields.innerHTML = '';
    [
        ['设备ID', profile.deviceId || '-'],
        ['型号', profile.model || '-'],
        ['内网IP', profile.internalIp || '-'],
        ['外网IP', profile.externalIp || '-'],
        ['主页链接', profile.profileUrl || '-', 'link']
    ].forEach(([label, value, type]) => {
        const item = document.createElement('div');
        item.className = 'profile-field';
        const labelEl = document.createElement('strong');
        labelEl.textContent = label;
        item.appendChild(labelEl);
        if (type === 'link' && value && value !== '-') {
            const link = document.createElement('a');
            link.href = value;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = value;
            item.appendChild(link);
        } else {
            const valueEl = document.createElement('div');
            valueEl.className = 'profile-field-value';
            valueEl.textContent = value;
            item.appendChild(valueEl);
        }
        fields.appendChild(item);
    });
    qr.innerHTML = '';
    if (window.QRCode && profile.profileUrl) {
        new QRCode(qr, { text: profile.profileUrl, width: 112, height: 112, correctLevel: QRCode.CorrectLevel.M });
    } else {
        qr.textContent = 'QR';
    }
    const followed = state.contacts.has(profile.deviceId);
    followButton.textContent = followed ? '取消关注' : '关注';
    followButton.disabled = profile.deviceId === state.deviceId;
    followButton.onclick = async () => {
        if (state.contacts.has(profile.deviceId)) {
            await unfollowDevice(profile.deviceId);
            followButton.textContent = '关注';
        } else {
            await followDevice(profile);
            followButton.textContent = '取消关注';
        }
    };
    modal.classList.add('active');
    historyLog('device-profile-opened', { contactDeviceId: profile.deviceId, fromContactList: Boolean(options.contact) });
}

function closeDeviceProfile() {
    document.getElementById('deviceProfileModal')?.classList.remove('active');
}

async function startContactVoiceCall(contact) {
    try {
        await mediaController.startContactCall(contact);
    } catch (err) {
        alert(`无法发起语音通话: ${err.message}`);
        historyLog('contact-call-start-failed', { contactDeviceId: contact.deviceId, error: err.message });
    }
}

let contactCallTimer = null;

function setContactCallActions(buttons = []) {
    const actions = document.getElementById('contactCallActions');
    if (!actions) return;
    actions.innerHTML = '';
    buttons.forEach(button => actions.appendChild(button));
}

function makeCallButton(label, className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
}

function formatCallDuration(startedAt) {
    const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const minutes = String(Math.floor(total / 60)).padStart(2, '0');
    const seconds = String(total % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
}

function updateContactCallOverlay(call) {
    const overlay = document.getElementById('contactCallOverlay');
    const title = document.getElementById('contactCallTitle');
    const subtitle = document.getElementById('contactCallSubtitle');
    if (!overlay || !title || !subtitle) return;
    clearInterval(contactCallTimer);
    contactCallTimer = null;

    if (!call || call.state === 'idle') {
        overlay.hidden = true;
        state.activeContactCall = null;
        setContactCallActions([]);
        return;
    }

    state.activeContactCall = call;
    overlay.hidden = false;
    const contact = call.contact || call.caller || {};
    const name = contact.name || contact.deviceName || contact.deviceId || call.from || '联系人';

    if (call.state === 'incoming') {
        title.textContent = `${name} 正在呼叫`;
        subtitle.textContent = '不经过当前隧道的联系人语音通话';
        setContactCallActions([
            makeCallButton('拒接', 'btn btn-secondary', () => mediaController.rejectContactCall(call, 'rejected')),
            makeCallButton('接听', 'btn btn-primary', () => mediaController.acceptContactCall(call).catch(err => {
                alert(`无法接听: ${err.message}`);
                mediaController.rejectContactCall(call, 'failed');
            }))
        ]);
        return;
    }

    if (call.state === 'dialing') {
        title.textContent = `正在呼叫 ${name}`;
        subtitle.textContent = '等待对方接听...';
        setContactCallActions([
            makeCallButton('取消', 'btn btn-secondary', () => mediaController.endContactCall('cancelled'))
        ]);
        return;
    }

    if (call.state === 'active') {
        title.textContent = `正在与 ${name} 通话`;
        const startedAt = call.startedAt || Date.now();
        const tick = () => { subtitle.textContent = `通话时长 ${formatCallDuration(startedAt)}`; };
        tick();
        contactCallTimer = setInterval(tick, 1000);
        setContactCallActions([
            makeCallButton('挂断', 'btn btn-danger', () => mediaController.endContactCall('ended'))
        ]);
    }
}

function handleIncomingContactCall(data) {
    if (!data?.callId || !data?.from) return;
    updateContactCallOverlay({
        state: 'incoming',
        callId: data.callId,
        from: data.from,
        caller: data.caller || { deviceId: data.from },
        contact: data.caller || { deviceId: data.from }
    });
}

const TUNNEL_INVITE_QUEUE_KEY = 'deviceTunnelInviteQueue';

function getQueuedTunnelInvites() {
    try {
        const parsed = JSON.parse(localStorage.getItem(TUNNEL_INVITE_QUEUE_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.filter(item => item?.to && item?.sessionId && item?.invitationId) : [];
    } catch {
        return [];
    }
}

function setQueuedTunnelInvites(items) {
    localStorage.setItem(TUNNEL_INVITE_QUEUE_KEY, JSON.stringify(items.slice(-50)));
}

function sendTunnelInvite(invite) {
    return new Promise(resolve => {
        if (!state.socket?.connected) return resolve({ ok: false, delivered: false });
        state.socket.emit('device-tunnel-invite', invite, response => resolve(response || { ok: false, delivered: false }));
    });
}

async function flushPendingTunnelInvites() {
    const queued = getQueuedTunnelInvites();
    if (!queued.length || !state.socket?.connected) return;
    const remaining = [];
    for (const invite of queued) {
        const response = await sendTunnelInvite(invite);
        if (!response?.delivered) remaining.push(invite);
    }
    setQueuedTunnelInvites(remaining);
}

function sendPendingTunnelInviteReceipt() {
    const receipt = state.pendingTunnelInviteReceipt;
    if (!receipt || !state.socket?.connected) return;
    state.socket.emit('device-tunnel-invite-ack', {
        ...receipt,
        from: state.deviceId,
        accepted: true
    });
    state.pendingTunnelInviteReceipt = null;
}

const pendingDeviceTunnelInvites = new Map();
const deviceTunnelInvitePageId = `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const DEVICE_TUNNEL_INVITE_CLAIM_TTL = 10 * 60 * 1000;

function getDeviceTunnelInviteSenderName(invite) {
    return invite?.sender?.name || invite?.sender?.deviceName || invite?.from?.slice(0, 8) || '对方设备';
}

async function claimDeviceTunnelInvite(invite) {
    const invitationId = invite?.invitationId;
    if (!invitationId) return false;
    const key = `deviceTunnelInviteClaim:${invitationId}`;
    const now = Date.now();
    try {
        const existing = JSON.parse(localStorage.getItem(key) || 'null');
        if (existing?.owner && existing.owner !== deviceTunnelInvitePageId && existing.expiresAt > now) {
            return false;
        }
        localStorage.setItem(key, JSON.stringify({
            owner: deviceTunnelInvitePageId,
            expiresAt: now + DEVICE_TUNNEL_INVITE_CLAIM_TTL
        }));
        await new Promise(resolve => setTimeout(resolve, 45 + Math.random() * 80));
        const confirmed = JSON.parse(localStorage.getItem(key) || 'null');
        return confirmed?.owner === deviceTunnelInvitePageId;
    } catch {
        return true;
    }
}

function isDeviceTunnelInviteInteractive() {
    return document.visibilityState === 'visible' && document.hasFocus();
}

function sendDeviceTunnelInviteAck(invite, accepted) {
    state.socket?.emit('device-tunnel-invite-ack', {
        invitationId: invite.invitationId,
        from: state.deviceId,
        to: invite.from,
        sessionId: invite.sessionId,
        accepted,
        link: invite.link
    });
}

function acceptDeviceTunnelInvite(invite) {
    pendingDeviceTunnelInvites.delete(invite.invitationId);
    document.getElementById(`deviceTunnelInvitePrompt-${invite.invitationId}`)?.remove();
    sendDeviceTunnelInviteAck(invite, true);
    window.location.href = invite.link;
}

function showDeviceTunnelInvitePrompt(invite) {
    if (!invite?.invitationId) return;
    const name = getDeviceTunnelInviteSenderName(invite);
    pendingDeviceTunnelInvites.set(invite.invitationId, invite);
    document.getElementById(`deviceTunnelInvitePrompt-${invite.invitationId}`)?.remove();

    const prompt = document.createElement('div');
    prompt.id = `deviceTunnelInvitePrompt-${invite.invitationId}`;
    prompt.style.cssText = [
        'position:fixed',
        'right:18px',
        'top:calc(var(--app-header-height, 56px) + 16px)',
        'z-index:10020',
        'width:min(360px, calc(100vw - 32px))',
        'padding:14px',
        'border:1px solid rgba(134,148,178,.28)',
        'border-radius:14px',
        'background:rgba(255,255,255,.96)',
        'box-shadow:0 18px 48px rgba(20,27,45,.18)',
        'backdrop-filter:blur(14px)',
        'color:#24304a',
        'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    ].join(';');
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:800;font-size:15px;margin-bottom:6px;';
    title.textContent = '传输隧道邀请';
    const body = document.createElement('div');
    body.style.cssText = 'color:#526079;margin-bottom:12px;';
    body.textContent = `${name} 想和你建立一个传输隧道`;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';
    const rejectButton = document.createElement('button');
    rejectButton.type = 'button';
    rejectButton.textContent = '暂不进入';
    rejectButton.className = 'btn btn-secondary';
    const acceptButton = document.createElement('button');
    acceptButton.type = 'button';
    acceptButton.textContent = '进入隧道';
    acceptButton.className = 'btn';
    rejectButton.addEventListener('click', () => {
        pendingDeviceTunnelInvites.delete(invite.invitationId);
        prompt.remove();
        sendDeviceTunnelInviteAck(invite, false);
    });
    acceptButton.addEventListener('click', () => acceptDeviceTunnelInvite(invite));
    actions.append(rejectButton, acceptButton);
    if ('Notification' in window && Notification.permission === 'default') {
        const notifyButton = document.createElement('button');
        notifyButton.type = 'button';
        notifyButton.textContent = '开启后台通知';
        notifyButton.className = 'btn btn-secondary';
        notifyButton.addEventListener('click', () => Notification.requestPermission().catch(() => null));
        actions.prepend(notifyButton);
    }
    prompt.append(title, body, actions);
    document.body.appendChild(prompt);
}

function promptDeviceTunnelInvite(invite) {
    return showDeviceTunnelInvitePrompt(invite);
    const name = getDeviceTunnelInviteSenderName(invite);
    const accepted = confirm(`${name} 邀请你开始一个传输隧道，是否进入？`);
    if (accepted) acceptDeviceTunnelInvite(invite);
    else {
        pendingDeviceTunnelInvites.delete(invite.invitationId);
        sendDeviceTunnelInviteAck(invite, false);
    }
}

async function showDeviceTunnelInviteNotification(invite) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;
    const name = getDeviceTunnelInviteSenderName(invite);
    const title = '传输隧道邀请';
    const options = {
        body: `${name} 想和你建立一个传输隧道`,
        tag: `device-tunnel-invite-${invite.invitationId}`,
        renotify: true,
        requireInteraction: true,
        icon: '/tunnel-icon.svg',
        badge: '/tunnel-icon.svg',
        data: { url: invite.link, invitationId: invite.invitationId }
    };
    try {
        if (navigator.serviceWorker?.ready) {
            const registration = await navigator.serviceWorker.ready;
            await registration.showNotification(title, options);
            return true;
        }
    } catch (err) {
        historyLog('device-tunnel-notification-sw-failed', { error: err.message });
    }
    try {
        const notification = new Notification(title, options);
        notification.onclick = () => {
            window.focus();
            acceptDeviceTunnelInvite(invite);
            notification.close();
        };
        return true;
    } catch (err) {
        historyLog('device-tunnel-notification-failed', { error: err.message });
        return false;
    }
}

async function handleDeviceTunnelInvite(invite) {
    if (!invite?.link || !invite?.from || !invite?.invitationId) return;
    if (!(await claimDeviceTunnelInvite(invite))) return;
    if (!isDeviceTunnelInviteInteractive()) {
        pendingDeviceTunnelInvites.set(invite.invitationId, invite);
        const notified = await showDeviceTunnelInviteNotification(invite);
        if (notified) return;
        historyLog('device-tunnel-invite-pending-unfocused', {
            invitationId: invite.invitationId,
            fromDeviceId: invite.from,
            notificationPermission: 'Notification' in window ? Notification.permission : 'unsupported'
        });
        return;
    }
    promptDeviceTunnelInvite(invite);
}

function flushPendingDeviceTunnelInvitePrompt() {
    if (!isDeviceTunnelInviteInteractive() || pendingDeviceTunnelInvites.size === 0) return;
    const invite = pendingDeviceTunnelInvites.values().next().value;
    if (invite) promptDeviceTunnelInvite(invite);
}

document.addEventListener('visibilitychange', flushPendingDeviceTunnelInvitePrompt);
window.addEventListener('focus', flushPendingDeviceTunnelInvitePrompt);

function handleDeviceTunnelInviteAck(data) {
    if (!data?.invitationId) return;
    const status = data.accepted === false ? '对方拒绝了隧道邀请' : '对方已收到并打开隧道邀请';
    historyLog('device-tunnel-invite-ack', {
        invitationId: data.invitationId,
        fromDeviceId: data.from,
        accepted: data.accepted !== false,
        sessionId: data.sessionId
    });
    if (data.accepted !== false) {
        console.info(status, data);
    }
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
    element.title = '查看设备资料';
    const show = () => showDeviceProfile(device);
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
    document.getElementById('onlineCount').textContent = count;

    container.innerHTML = '';

    container.appendChild(renderDeviceRow({
        deviceId: state.deviceId,
        name: state.deviceName,
        model: state.selfNetworkInfo?.deviceModel || state.deviceModel,
        internalIp: state.selfNetworkInfo?.internalIp || state.reportedLanIp,
        externalIp: state.selfNetworkInfo?.externalIp,
        sessionId: state.sessionId,
        shortCode: state.shortCode
    }));

    state.devices.forEach(device => {
        container.appendChild(renderDeviceRow(device));
    });
    renderContacts();
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

function isAnyBlockingOverlayOpen() {
    return Boolean(
        document.querySelector('.modal-overlay.active') ||
        document.getElementById('filePreviewViewer')?.classList.contains('active') ||
        document.getElementById('mediaFullscreenViewer')?.classList.contains('active') ||
        document.getElementById('richViewer')?.classList.contains('active') ||
        (document.getElementById('downloadCacheOverlay') && !document.getElementById('downloadCacheOverlay').hidden) ||
        document.getElementById('resourceBrowserLayer')?.classList.contains('active')
    );
}

function shouldIgnoreWorkspaceSwipeTarget(target) {
    return Boolean(target?.closest?.(
        '#editor, [contenteditable="true"], input, textarea, select, button, a, .toolbar, .editor-toolbar, .file-preview-actions, .mobile-workspace-nav, .tunnel-topbar'
    ));
}

function getAdjacentWorkspaceView(delta) {
    const views = ['devices', 'chat', 'editor'];
    const currentIndex = Math.max(0, views.indexOf(currentMobileWorkspaceView));
    const nextIndex = Math.min(views.length - 1, Math.max(0, currentIndex + delta));
    return views[nextIndex];
}

function initWorkspaceSwipeNavigation() {
    const appShell = document.getElementById('appShell');
    if (!appShell) return;
    let swipeStart = null;
    appShell.addEventListener('pointerdown', event => {
        if (!window.matchMedia('(max-width: 767px)').matches) return;
        if (event.pointerType !== 'touch') return;
        if (isAnyBlockingOverlayOpen() || shouldIgnoreWorkspaceSwipeTarget(event.target)) return;
        swipeStart = { x: event.clientX, y: event.clientY, target: event.target };
    });
    appShell.addEventListener('pointerup', event => {
        if (!swipeStart) return;
        const start = swipeStart;
        swipeStart = null;
        if (isAnyBlockingOverlayOpen() || shouldIgnoreWorkspaceSwipeTarget(start.target)) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.abs(dx) < 68 || Math.abs(dx) < Math.abs(dy) * 1.35) return;
        const nextView = getAdjacentWorkspaceView(dx < 0 ? 1 : -1);
        if (nextView !== currentMobileWorkspaceView) setMobileWorkspaceView(nextView);
    });
    ['pointercancel', 'pointerleave'].forEach(eventName => {
        appShell.addEventListener(eventName, () => {
            swipeStart = null;
        });
    });
}

async function showJoinedSessionSwitcher() {
    const sessions = (await getAllFromStore('sessions').catch(() => []))
        .filter(session => session?.sessionId)
        .sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId), undefined, { numeric: true }));
    const dialog = document.createElement('div');
    dialog.className = 'modal-overlay active';
    const list = sessions.length
        ? sessions.map(session => {
            const id = escapeHtml(session.sessionId);
            const time = new Date(session.lastActive || session.createdAt || Date.now()).toLocaleString('zh-CN');
            const currentClass = session.sessionId === state.sessionId ? ' is-current' : '';
            const remark = escapeHtml(String(session.remark || '').trim());
            return `<button class="session-tool session-switch-item${currentClass}" data-session-id="${id}" style="width:100%;justify-content:flex-start;margin:6px 0;"><strong>${remark || id}</strong><br><small>${remark ? id + ' · ' : ''}${time}</small></button>`;
        }).join('')
        : '<p>本设备还没有加入过其它隧道。</p>';
    dialog.innerHTML = `
        <div class="modal">
            <h3>切换隧道</h3>
            <div style="max-height: 55vh; overflow: auto; text-align: left;">${list}</div>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="closeSessionSwitcher">关闭</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);
    dialog.querySelector('#closeSessionSwitcher').addEventListener('click', () => dialog.remove());
    dialog.querySelectorAll('[data-session-id]').forEach(button => {
        button.addEventListener('click', () => {
            const sessionId = button.dataset.sessionId;
            if (sessionId && sessionId !== state.sessionId) {
                window.location.href = `${window.location.origin}/#${sessionId}`;
                setTimeout(() => window.location.reload(), 80);
            } else {
                dialog.remove();
            }
        });
    });
}

function showTunnelRemarkDialog() {
    document.getElementById('tunnelRemarkDialog')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'tunnelRemarkDialog';
    overlay.className = 'modal-overlay active';
    overlay.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-label="修改隧道备注名">
            <h3>修改隧道备注名</h3>
            <p>备注会同步给当前在线的同隧道设备。</p>
            <input id="tunnelRemarkInput" type="text" maxlength="60" placeholder="例如：公司资料、家庭相册" style="width:100%;height:40px;margin-bottom:14px;padding:0 10px;border:1px solid #d7dce8;border-radius:6px;">
            <div class="modal-actions">
                <button class="btn btn-secondary" id="cancelTunnelRemarkBtn" type="button">取消</button>
                <button class="btn btn-primary" id="saveTunnelRemarkBtn" type="button">保存</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#tunnelRemarkInput');
    input.value = state.sessionRemark || '';
    input.focus();
    input.select();
    const close = () => overlay.remove();
    overlay.addEventListener('click', event => {
        if (event.target === overlay) close();
    });
    overlay.querySelector('#cancelTunnelRemarkBtn').addEventListener('click', close);
    overlay.querySelector('#saveTunnelRemarkBtn').addEventListener('click', async () => {
        const remark = input.value.trim().slice(0, 60);
        await updateSessionRemark(remark);
        state.socket?.emit('session-remark-update', { sessionId: state.sessionId, remark });
        close();
    });
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') overlay.querySelector('#saveTunnelRemarkBtn').click();
        if (event.key === 'Escape') close();
    });
}

async function renderShortCodeSwitchMenu() {
    const menu = document.getElementById('shortCodeSwitchMenu');
    if (!menu) return;
    const sessions = (await getAllFromStore('sessions').catch(() => []))
        .filter(session => session?.sessionId)
        .sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId), undefined, { numeric: true }));

    if (!sessions.length) {
        menu.innerHTML = '<div class="short-code-switch-item">暂无可切换隧道</div>';
        return;
    }

    menu.replaceChildren(...sessions.map(session => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `short-code-switch-item${session.sessionId === state.sessionId ? ' is-current' : ''}`;
        button.dataset.sessionId = session.sessionId;
        const code = normalizeLocalShortCode(session.shortCode) || '-----';
        button.innerHTML = `<strong>${escapeHtml(code)}</strong><small>${escapeHtml(session.sessionId)}</small>`;
        button.addEventListener('click', () => {
            if (session.sessionId === state.sessionId) {
                closeShortCodeSwitchMenu();
                return;
            }
            window.location.href = `${window.location.origin}/#${session.sessionId}`;
            setTimeout(() => window.location.reload(), 80);
        });
        return button;
    }));
}

function closeShortCodeSwitchMenu() {
    const button = document.getElementById('shortCodeSwitchBtn');
    const menu = document.getElementById('shortCodeSwitchMenu');
    if (button) button.setAttribute('aria-expanded', 'false');
    if (menu) menu.hidden = true;
}

async function toggleShortCodeSwitchMenu(event) {
    event?.stopPropagation();
    const button = document.getElementById('shortCodeSwitchBtn');
    const menu = document.getElementById('shortCodeSwitchMenu');
    if (!button || !menu) return;
    const willOpen = menu.hidden;
    if (!willOpen) {
        closeShortCodeSwitchMenu();
        return;
    }
    await renderShortCodeSwitchMenu();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
}

function initMobileWorkspace() {
    const viewButtons = Array.from(document.querySelectorAll('.mobile-workspace-button[data-mobile-view]'));
    viewButtons.forEach(button => {
        button.addEventListener('click', event => {
            if (button.dataset.mobileView === 'chat' && currentMobileWorkspaceView === 'chat') {
                event.preventDefault();
                showJoinedSessionSwitcher().catch(err => historyLog('session-switcher-open-failed', { error: err.message }));
                return;
            }
            setMobileWorkspaceView(button.dataset.mobileView);
        });
    });
    const tunnelButton = document.querySelector('.mobile-workspace-button[data-mobile-view="chat"]');
    if (tunnelButton) {
        let longPressTimer = null;
        let suppressNextClick = false;
        const cancel = () => {
            if (longPressTimer) clearTimeout(longPressTimer);
            longPressTimer = null;
        };
        tunnelButton.addEventListener('contextmenu', event => {
            event.preventDefault();
            showTunnelRemarkDialog();
        });
        tunnelButton.addEventListener('pointerdown', event => {
            if (event.pointerType !== 'touch') return;
            cancel();
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                suppressNextClick = true;
                showTunnelRemarkDialog();
            }, 600);
        });
        tunnelButton.addEventListener('click', event => {
            if (!suppressNextClick) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            suppressNextClick = false;
        }, true);
        ['pointerup', 'pointercancel', 'pointerleave', 'pointermove'].forEach(eventName => {
            tunnelButton.addEventListener(eventName, cancel);
        });
    }

    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const syncViewport = () => setMobileWorkspaceView(currentMobileWorkspaceView, { log: false });
    if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', syncViewport);
    else mediaQuery.addListener(syncViewport);
    syncViewport();
    initWorkspaceSwipeNavigation();
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

function openDownloadCacheOverlay() {
    const overlay = document.getElementById('downloadCacheOverlay');
    const frame = document.getElementById('downloadCacheFrame');
    if (!overlay || !frame) {
        window.open('/downloadList', '_blank', 'noopener');
        return;
    }
    frame.src = `/downloadList?embedded=1&_=${Date.now().toString(36)}`;
    overlay.hidden = false;
}

function closeDownloadCacheOverlay() {
    const overlay = document.getElementById('downloadCacheOverlay');
    const frame = document.getElementById('downloadCacheFrame');
    if (overlay) overlay.hidden = true;
    if (frame) frame.src = 'about:blank';
}

async function exitTunnelAndClearCache() {
    const ok = confirm('退出当前隧道，将清理这个隧道的所有缓存数据。\n如需再进此隧道，将重新拉取全部远程文件。\n确定退出吗？');
    if (!ok) return;
    try {
        state.socket?.disconnect();
        await purgeLocalSession(state.sessionId);
        window.location.href = `${window.location.origin}${window.location.pathname}?leave=1`;
    } catch (err) {
        historyLog('exit-tunnel-clear-failed', { error: err.message });
        alert(`退出隧道失败：${err.message}`);
    }
}

function handleTopbarAdminTap(event) {
    if (event.target.closest('button')) return;
    const now = Date.now();
    adminTapCount = lastAdminTapAt && now - lastAdminTapAt <= 520 ? adminTapCount + 1 : 1;
    lastAdminTapAt = now;
    clearTimeout(adminTapResetTimer);
    adminTapResetTimer = setTimeout(() => {
        adminTapCount = 0;
        lastAdminTapAt = 0;
    }, 700);
    if (adminTapCount >= 7) {
        adminTapCount = 0;
        lastAdminTapAt = 0;
        window.open('/admin', '_blank', 'noopener');
    }
}

function applyTheme(theme) {
    const selected = ['classic', 'graphite', 'atelier'].includes(theme) ? theme : 'classic';
    document.body.dataset.theme = selected;
    localStorage.setItem('uiTheme', selected);
    document.querySelectorAll('.theme-option[data-theme]').forEach(button => {
        button.classList.toggle('active', button.dataset.theme === selected);
    });
}

function initThemeSwitcher() {
    applyTheme(localStorage.getItem('uiTheme') || 'classic');
    document.getElementById('themeSwitcher')?.addEventListener('click', event => {
        const button = event.target.closest?.('.theme-option[data-theme]');
        if (!button) return;
        applyTheme(button.dataset.theme);
        historyLog('theme-changed', { theme: button.dataset.theme });
    });
    document.getElementById('cycleThemeBtn')?.addEventListener('click', () => {
        const themes = ['classic', 'graphite', 'atelier'];
        const current = document.body.dataset.theme || 'classic';
        const next = themes[(themes.indexOf(current) + 1) % themes.length];
        applyTheme(next);
        historyLog('theme-changed', { theme: next, source: 'topbar-cycle' });
    });
}

function initUI() {
    initThemeSwitcher();
    initMobileWorkspace();
    initProgressDrawer();
    initRemoteAudioUnlock();
    document.getElementById('tunnelTopbar').addEventListener('click', handleTopbarAdminTap);
    document.getElementById('leaveTunnelBtn').addEventListener('click', leaveTunnel);
    document.getElementById('leaveTunnelPanelBtn')?.addEventListener('click', leaveTunnel);
    document.getElementById('mobileForceRefreshBtn').addEventListener('click', forceMobileRefresh);
    document.getElementById('magnetCacheBtn').addEventListener('click', openDownloadCacheOverlay);
    document.getElementById('closeDownloadCacheOverlayBtn')?.addEventListener('click', closeDownloadCacheOverlay);
    document.getElementById('downloadCacheOverlay')?.addEventListener('click', event => {
        if (event.target.id === 'downloadCacheOverlay') closeDownloadCacheOverlay();
    });
    document.getElementById('refreshContactsBtn')?.addEventListener('click', () => loadContacts());
    document.getElementById('closeDeviceProfileBtn')?.addEventListener('click', closeDeviceProfile);
    document.getElementById('deviceProfileModal')?.addEventListener('click', event => {
        if (event.target.id === 'deviceProfileModal') closeDeviceProfile();
    });
    document.getElementById('exitTunnelBtn')?.addEventListener('click', () => {
        exitTunnelAndClearCache().catch(err => historyLog('exit-tunnel-failed', { error: err.message }));
    });
    document.getElementById('shortCodeSwitchBtn')?.addEventListener('click', event => {
        toggleShortCodeSwitchMenu(event).catch(err => historyLog('short-code-switch-open-failed', { error: err.message }));
    });
    document.addEventListener('click', event => {
        if (!event.target.closest?.('.short-code-switch')) closeShortCodeSwitchMenu();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeShortCodeSwitchMenu();
    });
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
        const files = Array.from(e.target.files || []);
        await sendSelectedFiles(files);
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
        if (activeFileDetailsFileId) {
            await downloadFile(activeFileDetailsFileId);
            return;
        }
        if (!activeFileDetailsMessageId) return;
        await downloadFileFromMessage(activeFileDetailsMessageId);
    });
    document.getElementById('closeFilePreviewBtn').addEventListener('click', closeFilePreview);
    document.getElementById('filePreviewFullscreenBtn')?.addEventListener('click', () => {
        openActivePreviewFullscreen().catch(err => historyLog('media-fullscreen-open-failed', { error: err.message }));
    });
    document.getElementById('filePreviewPrevBtn')?.addEventListener('click', () => {
        navigateFilePreview(-1).catch(err => historyLog('file-preview-navigate-failed', { direction: -1, error: err.message }));
    });
    document.getElementById('filePreviewNextBtn')?.addEventListener('click', () => {
        navigateFilePreview(1).catch(err => historyLog('file-preview-navigate-failed', { direction: 1, error: err.message }));
    });
    document.getElementById('filePreviewViewer').addEventListener('click', event => {
        if (event.target === event.currentTarget) closeFilePreview();
    });
    document.getElementById('filePreviewViewer')?.addEventListener('pointerdown', event => {
        if (!document.getElementById('filePreviewViewer')?.classList.contains('active')) return;
        if (event.target.closest?.('button, input, textarea, select, a, .file-preview-actions')) return;
        filePreviewPointerStart = { x: event.clientX, y: event.clientY };
    });
    document.getElementById('filePreviewViewer')?.addEventListener('pointerup', event => {
        if (!filePreviewPointerStart) return;
        const dx = event.clientX - filePreviewPointerStart.x;
        const dy = event.clientY - filePreviewPointerStart.y;
        filePreviewPointerStart = null;
        if (Math.abs(dx) > 54 && Math.abs(dx) > Math.abs(dy) * 1.25) {
            navigateFilePreview(dx < 0 ? 1 : -1).catch(err => historyLog('file-preview-swipe-navigate-failed', { error: err.message }));
        }
    });
    document.getElementById('mediaFullscreenCloseBtn')?.addEventListener('click', () => closeMediaFullscreen());
    document.getElementById('mediaFullscreenPrevBtn')?.addEventListener('click', () => navigateMediaFullscreen(-1));
    document.getElementById('mediaFullscreenNextBtn')?.addEventListener('click', () => navigateMediaFullscreen(1));
    document.getElementById('mediaFullscreenViewer')?.addEventListener('pointerdown', event => {
        mediaFullscreenPointerStart = { x: event.clientX, y: event.clientY };
    });
    document.getElementById('mediaFullscreenViewer')?.addEventListener('pointerup', event => {
        if (!mediaFullscreenPointerStart) return;
        const dx = event.clientX - mediaFullscreenPointerStart.x;
        const dy = event.clientY - mediaFullscreenPointerStart.y;
        mediaFullscreenPointerStart = null;
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.2) {
            navigateMediaFullscreen(dx < 0 ? 1 : -1);
        }
    });
    document.addEventListener('keydown', event => {
        if (!document.getElementById('mediaFullscreenViewer')?.classList.contains('active')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeMediaFullscreen();
        } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            navigateMediaFullscreen(-1);
        } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            navigateMediaFullscreen(1);
        }
    });
    document.addEventListener('keydown', event => {
        if (document.getElementById('mediaFullscreenViewer')?.classList.contains('active')) return;
        if (!document.getElementById('filePreviewViewer')?.classList.contains('active')) return;
        if (activeFilePreviewMode !== 'file' || !activeCollectionPreviewMessageId) return;
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            navigateFilePreview(-1).catch(err => historyLog('file-preview-key-navigate-failed', { direction: -1, error: err.message }));
        } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            navigateFilePreview(1).catch(err => historyLog('file-preview-key-navigate-failed', { direction: 1, error: err.message }));
        }
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
        const files = Array.from(e.dataTransfer.files || []);
        await sendSelectedFiles(files);
    }, false);
}

// ==================== 进度显示 ====================
function showQueuedFileTransfer(fileId, queueLength, activeDownloads) {
    progressQueueSnapshot.queueLength = Math.max(0, Number(queueLength) || 0);
    progressQueueSnapshot.activeDownloads = Math.max(0, Number(activeDownloads) || 0);
    progressQueueSnapshot.updatedAt = Date.now();
    scheduleProgressQueueSnapshotExpiry();
    const list = document.getElementById('progressList');
    const container = document.getElementById('transferProgress');
    if (progressQueueSnapshot.activeDownloads <= 0 && (!list || list.children.length === 0)) {
        updateProgressDrawerSummary();
        return;
    }
    if (container) {
        container.style.display = 'block';
        setProgressDrawerCollapsed(progressDrawerCollapsed);
    }
    updateProgressDrawerSummary();
}

function clearProgressQueueSnapshot() {
    progressQueueSnapshot.queueLength = 0;
    progressQueueSnapshot.activeDownloads = 0;
    progressQueueSnapshot.updatedAt = 0;
    if (progressQueueSnapshot.expireTimer) {
        clearTimeout(progressQueueSnapshot.expireTimer);
        progressQueueSnapshot.expireTimer = null;
    }
}

function scheduleProgressQueueSnapshotExpiry() {
    if (progressQueueSnapshot.expireTimer) clearTimeout(progressQueueSnapshot.expireTimer);
    progressQueueSnapshot.expireTimer = setTimeout(() => {
        if (Date.now() - progressQueueSnapshot.updatedAt < PROGRESS_QUEUE_SNAPSHOT_TTL) {
            scheduleProgressQueueSnapshotExpiry();
            return;
        }
        clearProgressQueueSnapshot();
        updateProgressDrawerSummary();
        const list = document.getElementById('progressList');
        const container = document.getElementById('transferProgress');
        if (list && container && list.children.length === 0) {
            container.style.display = 'none';
        }
    }, PROGRESS_QUEUE_SNAPSHOT_TTL + 50);
}

const PROGRESS_ACTIVITY_RANK = {
    moving: 0,
    starting: 1,
    queued: 2,
    sending: 3,
    completed: 4,
    idle: 5
};
const PROGRESS_MOVING_RECENT_MS = 15000;

function getProgressDirection(route, progressKey) {
    const normalizedRoute = String(route || '');
    if (normalizedRoute.startsWith('sending') || String(progressKey || '').includes('::sending')) return 'send';
    if (
        normalizedRoute.includes('receiving') ||
        normalizedRoute.startsWith('received') ||
        normalizedRoute === 'queued' ||
        normalizedRoute === 'p2p' ||
        normalizedRoute === 'socket-relay' ||
        normalizedRoute.includes('relay') ||
        normalizedRoute.includes('multi-source')
    ) {
        return 'receive';
    }
    return 'unknown';
}

function resolveProgressActivity(item, progress, status = '', meta = {}) {
    if (meta.activity) return meta.activity;

    const route = String(meta.route || '');
    const progressKey = item?.dataset.progressKey || '';
    const statusText = String(status || '');
    const direction = getProgressDirection(route, progressKey);

    if (progress >= 100) return 'completed';
    if (route === 'queued' || /queued|queue|等待|排队/.test(statusText)) return 'queued';
    if (direction === 'receive' || direction === 'send') {
        return progress > 0 ? 'moving' : 'starting';
    }
    return progress > 0 ? 'moving' : 'starting';
}

function getProgressItemRank(item) {
    const activity = item?.dataset.progressActivity || 'idle';
    if (activity === 'moving' && !isProgressItemActivelyMoving(item)) {
        return PROGRESS_ACTIVITY_RANK.starting;
    }
    return PROGRESS_ACTIVITY_RANK[activity] ?? PROGRESS_ACTIVITY_RANK.idle;
}

function isProgressItemActivelyMoving(item) {
    if (!item || item.dataset.progressActivity !== 'moving') return false;
    const lastMovedAt = Number(item.dataset.progressLastMovedAt || 0);
    return lastMovedAt > 0 && Date.now() - lastMovedAt <= PROGRESS_MOVING_RECENT_MS;
}

function positionProgressItem(item) {
    const list = item?.parentElement;
    if (!list) return;

    const rank = getProgressItemRank(item);
    const lastMovedAt = Number(item.dataset.progressLastMovedAt || item.dataset.progressUpdatedAt || 0);
    const siblings = Array.from(list.children).filter(child => child !== item);
    const next = siblings.find(other => {
        const otherRank = getProgressItemRank(other);
        if (rank < otherRank) return true;
        if (rank !== otherRank || rank !== PROGRESS_ACTIVITY_RANK.moving) return false;
        const otherMovedAt = Number(other.dataset.progressLastMovedAt || other.dataset.progressUpdatedAt || 0);
        return lastMovedAt > otherMovedAt;
    });

    if (next) list.insertBefore(item, next);
    else list.appendChild(item);
}

function updateProgressItemState(item, progress, status = '', meta = {}) {
    const normalizedProgress = Math.max(0, Math.min(100, Number(progress) || 0));
    const previousProgress = Number(item.dataset.progressValue || 0);
    const now = Date.now();
    const route = String(meta.route || '');
    const direction = meta.direction || getProgressDirection(route, item.dataset.progressKey);
    const activity = resolveProgressActivity(item, normalizedProgress, status, meta);
    const directionIcon = item.querySelector('.progress-direction-icon');
    if (directionIcon) {
        directionIcon.dataset.direction = direction;
        directionIcon.textContent = direction === 'send' ? '▲' : direction === 'receive' ? '▼' : '';
        directionIcon.title = direction === 'send' ? '上传' : direction === 'receive' ? '下载' : '';
    }

    item.dataset.progressValue = String(normalizedProgress);
    item.dataset.progressStatus = String(status || '');
    item.dataset.progressRoute = route;
    item.dataset.progressDirection = direction;
    item.dataset.progressActivity = activity;
    item.dataset.fileId = getProgressBaseFileId(item.dataset.progressKey);
    item.dataset.progressUpdatedAt = String(now);
    if ((direction === 'receive' || direction === 'send') && activity === 'moving' && normalizedProgress > previousProgress) {
        item.dataset.progressLastMovedAt = String(now);
    }
    positionProgressItem(item);
}

function updateProgressDrawerSummary() {
    const list = document.getElementById('progressList');
    const summary = document.getElementById('progressDrawerSummary');
    if (!list || !summary) return;

    const snapshotFresh = Date.now() - progressQueueSnapshot.updatedAt <= PROGRESS_QUEUE_SNAPSHOT_TTL;
    const queuedSnapshot = snapshotFresh ? progressQueueSnapshot.queueLength : 0;

    const items = Array.from(list.children);
    const taskItems = items;
    const count = taskItems.length + queuedSnapshot;
    if (!count) {
        summary.textContent = '';
        return;
    }

    const moving = taskItems.filter(isProgressItemActivelyMoving).length;
    const stalled = taskItems.filter(item => item.dataset.progressActivity === 'moving' && !isProgressItemActivelyMoving(item)).length;
    const starting = taskItems.filter(item => item.dataset.progressActivity === 'starting').length;
    const queued = queuedSnapshot;
    const parts = [`${count} 个任务`];
    if (moving) parts.push(`进行中 ${moving}`);
    if (stalled) parts.push(`${stalled} 个停滞`);
    if (starting) parts.push(`${starting} 个建链中`);
    if (queued) parts.push(`${queued} 个等待`);
    summary.textContent = parts.join(' · ');
}

function setProgressDrawerCollapsed(collapsed) {
    const wasCollapsed = progressDrawerCollapsed;
    progressDrawerCollapsed = Boolean(collapsed);
    const container = document.getElementById('transferProgress');
    const toggle = document.getElementById('progressDrawerToggle');
    if (!container || !toggle) return;

    container.classList.toggle('collapsed', progressDrawerCollapsed);
    toggle.setAttribute('aria-expanded', String(!progressDrawerCollapsed));
    toggle.title = progressDrawerCollapsed ? '点击展开；按住可拖动位置' : '点击收起传输进度';
    if (wasCollapsed && !progressDrawerCollapsed) {
        progressDrawerIgnoreItemClicksUntil = Date.now() + 450;
        progressDrawerBlockPageClicksUntil = Date.now() + 450;
    }
    if (!progressDrawerCollapsed) {
        container.style.left = '';
        container.style.top = '';
        container.style.right = '';
        container.style.bottom = '';
        container.removeAttribute('data-dragged');
    }
}

function initProgressDrawer() {
    const toggle = document.getElementById('progressDrawerToggle');
    const container = document.getElementById('transferProgress');
    if (!toggle || !container) return;

    document.addEventListener('click', event => {
        if (Date.now() >= progressDrawerBlockPageClicksUntil) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
    }, true);

    toggle.addEventListener('click', () => {
        if (progressDrawerSuppressClick) {
            progressDrawerSuppressClick = false;
            return;
        }
        setProgressDrawerCollapsed(!progressDrawerCollapsed);
    });
    toggle.addEventListener('pointerdown', event => {
        if (!progressDrawerCollapsed || event.button > 0) return;
        const rect = container.getBoundingClientRect();
        progressDrawerDragState = {
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            width: rect.width,
            height: rect.height,
            startX: event.clientX,
            startY: event.clientY,
            moved: false
        };
        try {
            toggle.setPointerCapture?.(event.pointerId);
        } catch {}
    });
    toggle.addEventListener('pointermove', event => {
        const drag = progressDrawerDragState;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const movedDistance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (movedDistance <= 6 && !drag.moved) return;
        if (!drag.moved) {
            drag.moved = true;
            progressDrawerSuppressClick = true;
            container.classList.add('dragging');
            try {
                toggle.setPointerCapture?.(event.pointerId);
            } catch {}
        }
        const maxLeft = Math.max(8, window.innerWidth - drag.width - 8);
        const maxTop = Math.max(8, window.innerHeight - drag.height - 8);
        const nextLeft = Math.min(maxLeft, Math.max(8, event.clientX - drag.offsetX));
        const nextTop = Math.min(maxTop, Math.max(8, event.clientY - drag.offsetY));
        container.style.left = `${nextLeft}px`;
        container.style.top = `${nextTop}px`;
        container.style.right = 'auto';
        container.style.bottom = 'auto';
        container.dataset.dragged = 'true';
        event.preventDefault();
    });
    const endDrag = event => {
        const drag = progressDrawerDragState;
        if (!drag || drag.pointerId !== event.pointerId) return;
        progressDrawerDragState = null;
        container.classList.remove('dragging');
        try {
            toggle.releasePointerCapture?.(event.pointerId);
        } catch {}
        if (drag.moved) {
            progressDrawerSuppressClick = true;
            setTimeout(() => { progressDrawerSuppressClick = false; }, 250);
            return;
        }
        if (progressDrawerCollapsed) {
            progressDrawerSuppressClick = true;
            setProgressDrawerCollapsed(false);
            setTimeout(() => { progressDrawerSuppressClick = false; }, 250);
        }
    };
    toggle.addEventListener('pointerup', endDrag);
    toggle.addEventListener('pointercancel', endDrag);
    setProgressDrawerCollapsed(progressDrawerCollapsed);
    updateProgressDrawerSummary();
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

async function updateSessionRemark(remark) {
    state.sessionRemark = String(remark || '').trim().slice(0, 60);
    if (!state.sessionId) return;
    const existing = await getFromStore('sessions', state.sessionId).catch(() => null);
    await saveToStore('sessions', {
        ...(existing || {}),
        sessionId: state.sessionId,
        deviceId: state.deviceId,
        shortCode: state.shortCode || existing?.shortCode || '',
        remark: state.sessionRemark,
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

function showProgress(fileId, fileName, progress, status = '', meta = {}) {
    const container = document.getElementById('transferProgress');
    const list = document.getElementById('progressList');
    const elementId = progressElementId(fileId);

    container.style.display = 'block';
    setProgressDrawerCollapsed(progressDrawerCollapsed);

    let item = document.getElementById(elementId);
    if (!item) {
        item = document.createElement('div');
        item.id = elementId;
        item.className = 'progress-item';
        item.dataset.progressKey = String(fileId);
        item.dataset.fileId = getProgressBaseFileId(fileId);
        item.dataset.progressCreatedAt = String(Date.now());
        item.title = '点击定位到传输记录';
        item.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (progressDrawerCollapsed || Date.now() < progressDrawerIgnoreItemClicksUntil) {
                return;
            }
            locateProgressFile(item.dataset.progressKey);
        });

        const info = document.createElement('div');
        info.className = 'progress-info';
        const left = document.createElement('span');
        left.className = 'progress-info-left';
        const directionIcon = document.createElement('span');
        directionIcon.className = 'progress-direction-icon';
        directionIcon.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.className = 'progress-name';
        name.textContent = fileName;
        const text = document.createElement('span');
        text.className = 'progress-text';
        text.textContent = `${progress}%${status ? ` · ${status}` : ''}`;
        left.append(directionIcon, name);
        info.append(left, text);

        const bar = document.createElement('div');
        bar.className = 'progress-bar';
        const fill = document.createElement('div');
        fill.className = 'progress-fill';
        fill.style.width = `${progress}%`;
        bar.appendChild(fill);

        item.append(info, bar);
        list.appendChild(item);
        updateProgressItemState(item, progress, status, meta);
        updateProgressDrawerSummary();
    } else {
        updateProgress(fileId, progress, status, meta);
    }
}

function updateProgress(fileId, progress, status = '', meta = {}) {
    const item = document.getElementById(progressElementId(fileId));
    if (item) {
        item.querySelector('.progress-text').textContent = `${progress}%${status ? ` · ${status}` : ''}`;
        item.querySelector('.progress-fill').style.width = `${progress}%`;
        updateProgressItemState(item, progress, status, meta);
    }
    updateProgressDrawerSummary();
}

function locateProgressFile(progressKey) {
    const fileId = getProgressBaseFileId(progressKey);
    if (!fileId) return;
    let message = document.querySelector(`.message[data-file-id="${cssEscape(fileId)}"]`);
    if (!message) {
        message = Array.from(document.querySelectorAll('.message.collection-record'))
            .find(messageEl => {
                const fileIds = (messageEl.dataset.collectionFileIds || '').split(',').filter(Boolean);
                return fileIds.includes(fileId);
            });
    }
    if (!message) {
        historyLog('progress-anchor-missing', { progressKey, fileId });
        if (typeof showToast === 'function') {
            showToast('传输记录尚未渲染到列表中，请稍后再试');
        }
        return;
    }
    setMobileWorkspaceView('chat', { log: false });
    message.scrollIntoView({ behavior: 'smooth', block: 'center' });
    message.classList.add('progress-anchor-highlight');
    setTimeout(() => message.classList.remove('progress-anchor-highlight'), 1600);
    historyLog('progress-anchor-located', { progressKey, fileId });
}

function hideProgress(fileId) {
    activeFileProgress.delete(fileId);
    progressUiLastPaint.delete(fileId);
    const timer = progressHideTimers.get(fileId);
    if (timer) {
        clearTimeout(timer);
        progressHideTimers.delete(fileId);
    }

    const item = document.getElementById(progressElementId(fileId));
    if (item) {
        item.remove();
    }
    updateProgressDrawerSummary();

    const list = document.getElementById('progressList');
    if (list.children.length === 0) {
        clearProgressQueueSnapshot();
        updateProgressDrawerSummary();
        document.getElementById('transferProgress').style.display = 'none';
    }
}

function hideCompletedFileReceiveProgress(fileId) {
    if (!fileId) return;
    fileTransferProgressStates.delete(fileId);
    completedFileProgress.add(fileId);
    hideProgress(fileId);
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
    if (mediaFullscreenHistoryOpen || document.getElementById('mediaFullscreenViewer')?.classList.contains('active')) {
        closeMediaFullscreen({ fromHistory: true });
        return;
    }
    if (filePreviewHistoryOpen || document.getElementById('filePreviewViewer')?.classList.contains('active')) {
        closeFilePreview({ fromHistory: true });
        return;
    }
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
        messages.sort(compareHistoryMessages);
        historyLog('indexeddb-history-loaded', {
            messageCount: messages.length,
            messages: messages.map(summarizeHistoryMessage)
        });

        const chatMessages = document.getElementById('chatMessages');
        chatMessages?.classList.add('history-loading');
        try {
            // 使用 for...of 确保按顺序异步处理，但不要每条都滚动，避免刷新时列表抖动。
            for (const msg of messages) {
                try {
                    const isOwn = msg.sender === state.deviceId;
                    await addMessageToChat(msg, isOwn, { scroll: false });
                } catch (err) {
                    console.error('Failed to render stored message:', msg && msg.id, err);
                    historyLog('indexeddb-history-message-render-failed', {
                        message: summarizeHistoryMessage(msg),
                        error: err.message
                    });
                }
            }
        } finally {
            if (chatMessages) {
                chatMessages.scrollTop = chatMessages.scrollHeight;
                requestAnimationFrame(() => chatMessages.classList.remove('history-loading'));
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
