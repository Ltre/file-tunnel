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

function isWeChatEmbeddedBrowser() {
    return /MicroMessenger/i.test(navigator.userAgent || '');
}

async function blockWeChatEmbeddedBrowser() {
    const url = window.location.href;
    let copied = false;
    try {
        if (navigator.clipboard?.writeText && window.isSecureContext) {
            await navigator.clipboard.writeText(url);
            copied = true;
        }
    } catch (_) {}
    document.body.innerHTML = '';
    const layer = document.createElement('div');
    layer.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'display:grid',
        'place-items:center',
        'padding:24px',
        'background:#f2f4f7',
        'color:#172033',
        'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    ].join(';');
    layer.innerHTML = `
        <section style="width:min(92vw,440px);border-radius:18px;background:#fff;padding:24px;box-shadow:0 18px 54px rgba(22,32,51,.18);">
            <h1 style="margin:0 0 10px;font-size:1.28rem;">请使用系统浏览器打开</h1>
            <p style="margin:0 0 14px;line-height:1.65;color:#58657a;">微信内置浏览器会限制文件、音视频、PWA、剪贴板和本地缓存能力，无法稳定使用 Drop2Tunnel。</p>
            <p style="margin:0 0 12px;line-height:1.6;color:#58657a;">${copied ? '当前页面地址已复制到剪贴板，请在 Safari、Chrome 或系统浏览器中粘贴打开。' : '请复制下面地址，在 Safari、Chrome 或系统浏览器中打开。'}</p>
            <textarea readonly style="box-sizing:border-box;width:100%;min-height:74px;padding:10px;border:1px solid #d8deea;border-radius:10px;color:#34415a;background:#f7f9fc;">${escapeHtml(url)}</textarea>
            <button id="wechatCopyUrlBtn" style="width:100%;height:42px;margin-top:14px;border:0;border-radius:10px;background:#1877f2;color:#fff;font-weight:800;">复制页面地址</button>
        </section>
    `;
    document.body.appendChild(layer);
    document.getElementById('wechatCopyUrlBtn')?.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(url);
            alert('页面地址已复制，请用系统浏览器打开。');
        } catch (_) {
            alert(url);
        }
    });
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
    SESSION_TIMEOUT: 30 * 60 * 1000,
	// 用于增加数据库版本号以强制升级，确保所有对象存储都存在
	TUNNEL_DB_VER: 7
};
const RECORD_REMARK_MAX_LENGTH = 2000;

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
    nearbyDevices: new Map(),
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
    sessionOwnerDeviceId: '',
    sessionPermissions: null,
    sessionAdminDevices: new Map(),
    sessionSelfAdminPermissions: null,
    sessionIsAdmin: false,
    pendingSharedFileCount: 0,
    pendingSharedFileError: false,
    pendingRecordId: '',
    pendingRecordDetails: false,
    isExitingTunnel: false,
    db: null // IndexedDB实例
};

window.addEventListener('drop2tunnel-language-changed', event => {
    const language = event.detail?.language || 'zh-Hans';
    if (!state.socket) return;
    state.socket.auth = { ...(state.socket.auth || {}), language };
    if (state.socket.connected) state.socket.emit('set-language', { language });
});

const HISTORY_DEBUG = getRuntimeConfig().HISTORY_DEBUG !== false;
const MAX_CLIENT_DEBUG_LOGS = 1000;
const MAX_EDITOR_CONTENT_SIZE = 512 * 1024;
const MAX_EDITOR_ASSET_SIZE = 20 * 1024 * 1024;
const EDITOR_ASSET_CHUNK_SIZE = 64 * 1024;
const EDITOR_ASSET_BUFFER_LIMIT = 512 * 1024;
const EDITOR_ASSET_P2P_TIMEOUT = 1500;
const EDITOR_ASSET_P2P_COOLDOWN = 5 * 60 * 1000;
const EDITOR_ASSET_RELAY_IDLE_TIMEOUT = 45000;
const editorAssetUrls = new Map();
const editorAssetRequests = new Map();
const editorAssetTransfers = new Map();
const editorAssetRetryCounts = new Map();
const editorAssetP2PUnavailablePeers = new Map();
const editorAssetCacheVersions = new Map();
const peerSignalQueues = new Map();
let fileAssetTransfer = null;
let fileCacheStore = null;
let fileAssetPresenceRefreshTimer = null;
let mediaController = null;
let currentMobileWorkspaceView = 'chat';
let richViewerHistoryOpen = false;
let activeRichMessageId = '';
let filePreviewHistoryOpen = false;
let filePreviewNestedHistoryOpen = false;
let mediaFullscreenHistoryOpen = false;
let suppressNextFilePreviewPopstate = false;
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
let lanP2pGuideTimer = null;
let progressDrawerSuppressClick = false;
let progressDrawerIgnoreItemClicksUntil = 0;
let progressDrawerBlockPageClicksUntil = 0;
let chatScrollAnchorMessageId = '';
let chatScrollAnchorHoldUntil = 0;
let chatScrollAnchorSaveTimer = null;
let chatScrollPinnedToBottom = false;
let chatScrollAnchorPinFrame = 0;
let chatScrollAnchorPinMode = '';
let chatScrollAnchorPinnedTop = 0;
let chatScrollSuppressUntil = 0;
let adminTapCount = 0;
let adminTapResetTimer = null;
let lastAdminTapAt = 0;
const RICH_VIEWER_HISTORY_KEY = 'tunnelRichViewer';
const FILE_PREVIEW_HISTORY_KEY = 'tunnelFilePreview';
const MEDIA_FULLSCREEN_HISTORY_KEY = 'tunnelMediaFullscreen';
const MUSIC_PLAYER_HISTORY_KEY = 'tunnelMusicPlayer';
const MUSIC_QUEUE_HISTORY_KEY = 'tunnelMusicQueue';
const HOME_GUARD_HISTORY_KEY = 'tunnelHomeGuard';
const fileObjectUrls = new Map();
const pendingHistoryMessageIds = new Set();
const pendingFileCacheCleanupIds = new Set();
let fileCacheCleanupTimer = null;
let fileCacheCleanupIdleHandle = null;
let fileCacheCleanupRunning = false;
let lastLocalHistoryTimestamp = 0;
const MUSIC_PLAYER_STORAGE_KEY = 'tunnelMusicPlayerQueue:v1';
const MUSIC_LIBRARY_STORAGE_KEY = 'tunnelMusicLibrary:v1';
const SESSION_DIRECTORY_STORAGE_KEY = 'tunnelSessionDirectory:v1';
const LAST_FORWARD_SESSION_STORAGE_KEY = 'tunnelLastForwardSession:v1';
const PENDING_RICH_EDITS_STORAGE_KEY = 'tunnelPendingRichEdits:v1';
const EXTERNAL_FILE_HANDLE_MIN_SIZE = 30 * 1024 * 1024;
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
const TUNNEL_PERMISSION_LABELS = Object.freeze({
    read: '读取传输记录',
    sendText: '发送文本',
    sendRich: '发送富文本',
    sendFile: '发送文件',
    delete: '删除记录',
    collaborativeEdit: '协同编辑',
    globalIntercom: '全局对讲机发声',
    groupVoice: '群语音通话'
});
let musicPlayerPersistTimer = null;
let musicPlayerDurablePersistTimer = null;
let musicPlayerLastPersistAt = 0;
let homeHistoryGuardReady = false;
let nearbyPresenceTimer = null;
let nearbyLocation = null;
let deviceCameraBridge = null;
let tunnelCodeScannerState = null;

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

const sessionHistoryQueue = {
    pending: null,
    running: false,
    recoveryPending: null,
    recoveryRunning: false
};
let sessionHistoryFallbackTimers = [];
let tunnelHeartbeatTimer = null;
let clipboardShareTimer = null;
let lastClipboardText = null;
let pendingClipboardImageFiles = [];
let clipboardImageAvailable = false;
let clipboardImageSignature = '';
let clipboardImageConsumedSignature = '';
let clipboardImagePermissionStatus = null;
let clipboardImageProbeRunning = false;
let clipboardImageSendInProgress = false;
let clipboardImageReadAllowed = false;
let clipboardImagePermissionRequested = false;
let clipboardImagePermissionRetryAt = 0;
let clipboardImageMonitorTimer = null;
let clipboardImageChangeSequence = 0;
const CLIPBOARD_IMAGE_POLL_INTERVAL = 2000;
let remoteAudioContext = null;
const remoteAudioPipelines = new Map();
const CALL_RINGTONE_STORAGE_KEY = 'drop2tunnel.callRingtone:v1';
const CALL_RINGTONE_DB_NAME = 'Drop2TunnelCallSettings';
const CALL_RINGTONE_STORE_NAME = 'audio';
const CALL_RINGTONE_FILE_ID = 'ringtone';
let contactCallToneGeneration = 0;
let contactCallToneState = null;
let callRingtoneDbPromise = null;
let callRingtonePreviewing = false;
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
    if (route.startsWith('sending-multi-source')) return `${fileId}::sending-multi-source`;
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

function clearSelection() {
    try {
        window.getSelection?.()?.removeAllRanges?.();
        document.getSelection?.()?.removeAllRanges?.();
    } catch (err) {
        // Selection APIs can be unavailable or locked during native touch gestures.
    }
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
    const expectedSize = Number(fileInfo?.size ?? storedFile?.size);
    if (size > 0) return !Number.isFinite(expectedSize) || expectedSize <= 0 || size === expectedSize;
    if (!storedFile?.cacheStoreUnavailable && fileCacheStore?.isCompleteReference?.(storedFile, fileInfo)) return true;
    const ref = storedFile?.cacheStoreRef;
    return !storedFile?.cacheStoreUnavailable && Boolean(ref?.complete) &&
        (!Number.isFinite(expectedSize) || expectedSize <= 0 || Number(ref.size) === expectedSize);
}

async function initFileCacheStore() {
    if (!window.createDrop2TunnelCacheStore) return;
    fileCacheStore = await window.createDrop2TunnelCacheStore({ log: historyLog })
        .catch(err => {
            historyLog('cache-store-init-failed', { error: err.message });
            return null;
        });
}

async function materializeCachedFileRecord(storedFile) {
    if (!storedFile || getBinaryDataSize(storedFile.data) > 0) return storedFile;
    if (!fileCacheStore?.isCompleteReference?.(storedFile, storedFile)) return storedFile;
    return fileCacheStore.materialize(storedFile).catch(err => {
        historyLog('cache-store-materialize-failed', { fileId: storedFile.id, error: err.message });
        return { ...storedFile, cacheStoreUnavailable: true };
    });
}

async function deleteCacheStoreReference(storedFile, reason = 'cache-delete') {
    if (!storedFile?.cacheStoreRef || !fileCacheStore?.deleteReference) return false;
    return fileCacheStore.deleteReference(storedFile)
        .then(deleted => {
            if (deleted) historyLog('cache-store-reference-deleted', { fileId: storedFile.id, reason });
            return deleted;
        })
        .catch(err => {
            historyLog('cache-store-reference-delete-failed', { fileId: storedFile.id, reason, error: err.message });
            return false;
        });
}

function getExternalFileSourceState(storedFile, readableFile, fileInfo = null) {
    const hasHandle = Boolean(storedFile?.externalFileHandle?.getFile);
    const browserDataSize = getBinaryDataSize(storedFile?.data) ||
        (storedFile?.cacheStoreRef?.complete ? Number(storedFile.cacheStoreRef.size) || 0 : 0);
    const hasBrowserCache = hasCompleteFileCache(storedFile, fileInfo);
    const handleReadable = hasHandle && readableFile?.externalFileAvailable === true &&
        hasCompleteFileCache(readableFile, fileInfo);
    return {
        hasHandle,
        browserDataSize,
        hasBrowserCache,
        handleReadable,
        handleSourceOnly: handleReadable && browserDataSize === 0
    };
}

async function persistExternalFileReadState(storedFile, readableFile) {
    if (!storedFile?.externalFileHandle?.getFile) return false;
    const next = {
        externalFileAvailable: readableFile?.externalFileAvailable === true,
        externalFilePermissionRequired: readableFile?.externalFilePermissionRequired === true,
        externalFileMissing: readableFile?.externalFileMissing === true
    };
    const changed = Object.entries(next).some(([key, value]) => storedFile[key] !== value);
    if (!changed) return false;
    await saveToStore('files', { ...storedFile, ...next });
    return true;
}

async function syncExternalFileSourceUi(fileId, storedFile, readableFile, fileInfo = null) {
    const sourceState = getExternalFileSourceState(storedFile, readableFile, fileInfo || storedFile);
    await persistExternalFileReadState(storedFile, readableFile).catch(err => {
        historyLog('external-file-state-persist-failed', { fileId, error: err.message });
    });
    syncRenderedExternalFileSource(fileId, sourceState.handleReadable);
    if (storedFile?.externalFileHandle && !sourceState.handleReadable && sourceState.hasBrowserCache) {
        await saveToStore('files', {
            ...storedFile,
            externalFileAvailable: false,
            externalFileMissing: readableFile?.externalFileMissing === true,
            externalFilePermissionRequired: readableFile?.externalFilePermissionRequired === true,
            hasSafetyCopy: false,
            safetyCopyState: 'promoted-after-handle-loss',
            sourceMode: 'browser-cache',
            cacheCleared: false,
            restoreRequested: false
        }).catch(err => historyLog('external-file-safety-copy-promote-failed', { fileId, error: err.message }));
    }
    if (storedFile?.externalFileHandle && !sourceState.handleSourceOnly && !sourceState.hasBrowserCache) {
        const objectUrl = fileObjectUrls.get(fileId);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        fileObjectUrls.delete(fileId);
        showFileMessagePlaceholder(
            fileId,
            readableFile?.externalFilePermissionRequired ? '需要重新授权本机原文件' : '本机原文件无法读取',
            true,
            false
        );
    }
    return sourceState;
}

async function validateVisibleExternalFileSources() {
    const ids = new Set(Array.from(document.querySelectorAll('.message[data-file-id]'))
        .map(messageEl => messageEl.dataset.fileId)
        .filter(Boolean));
    document.querySelectorAll('.message[data-collection-file-ids]').forEach(messageEl => {
        String(messageEl.dataset.collectionFileIds || '').split(',').filter(Boolean).forEach(fileId => ids.add(fileId));
    });
    for (const fileId of ids) {
        const storedFile = await getFromStore('files', fileId).catch(() => null);
        if (!storedFile?.externalFileHandle?.getFile) continue;
        const readableFile = await materializeExternalFileRecord(storedFile);
        await syncExternalFileSourceUi(fileId, storedFile, readableFile, storedFile);
        await refreshCollectionMessagesForFile(fileId).catch(() => {});
    }
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

function externalDependencyClientLog(event, details = {}) {
    const normalizedEvent = `external-dependency-${String(event || 'unknown').slice(0, 80)}`;
    const entry = {
        event: normalizedEvent,
        details,
        clientTimestamp: new Date().toISOString()
    };
    console.warn(`[external-dependency][client][${event}]`, {
        sessionId: state.sessionId,
        deviceId: state.deviceId,
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
        if (isWeChatEmbeddedBrowser()) {
            await blockWeChatEmbeddedBrowser();
            return;
        }
        await initStorage();
        await initFileCacheStore();
        registerServiceWorker();
        if (!await initSession()) {
            initLandingNearbyPresence();
            initSessionLanding();
            return;
        }
        await startTunnelApplication();
    } catch (err) {
        console.error('Application startup failed:', err);
        showStartupFailure(err);
    }
});

function initLandingNearbyPresence() {
    if (state.socket?.connected) return;
    state.socket = io(CONFIG.SOCKET_SERVER, {
        transports: ['websocket', 'polling'],
        auth: { language: window.TunnelI18n?.currentLanguage?.() || navigator.language || 'zh-Hans' }
    });

    configureLightTransfer();
    ensureDeviceCameraBridge();
    state.socket.on('light-network-chunks-request', data => {
        getLightTransferApi()?.handleNetworkChunkRequest(data, result => {
            state.socket?.emit('light-network-chunks-response', { requestId: data?.requestId, ...(result || {}) });
        });
    });
    state.socket.on('connect', () => {
        state.socket.emit('register-profile-device', {
            deviceId: state.deviceId,
            deviceName: state.deviceName,
            deviceModel: state.deviceModel,
            localIp: state.reportedLanIp || '',
            sessionId: ''
        }, () => announceNearbyPresence());
        if (nearbyPresenceTimer) clearInterval(nearbyPresenceTimer);
        nearbyPresenceTimer = setInterval(announceNearbyPresence, 25000);
    });
}

async function startTunnelApplication() {
    document.getElementById('appShell').hidden = false;
    document.getElementById('tunnelTopbar')?.removeAttribute('hidden');
    document.getElementById('leaveTunnelBtn').hidden = false;
    document.getElementById('mobileForceRefreshBtn').hidden = false;
    initFileAssetTransfer();
    initMediaController();
    initUI();
    await restoreMusicPlayerState();
    initEditor();
    initDragDrop();
    initClipboardImagePaste();
    await loadContacts();
    await loadSessionData();
    initSocket();
    initAssetPresenceRefresh();
    ensureHomeHistoryGuard();
    handlePendingRecordNavigation().catch(err => historyLog('record-deep-link-failed', { error: err.message }));
    handlePendingDeviceCallOrIntercom().catch(err => historyLog('device-call-deep-link-failed', { error: err.message }));
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
            contains: (name) => ['sessions', 'messages', 'files', 'editorContent', 'shareQueue', 'contacts', 'mounts'].includes(name)
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
        const request = indexedDB.open('TunnelDB', CONFIG.TUNNEL_DB_VER);

        request.onerror = (event) => {
            console.error('IndexedDB open error:', event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = (event) => {
            state.db = event.target.result;
            console.log('IndexedDB opened successfully, version:', state.db.version);
            
            // 检查是否所有必需的对象存储都存在
            const requiredStores = ['sessions', 'messages', 'files', 'editorContent', 'shareQueue', 'contacts', 'mounts'];
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
                const recreateRequest = indexedDB.open('TunnelDB', 5);
                
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

    if (!db.objectStoreNames.contains('mounts')) {
        const mountStore = db.createObjectStore('mounts', { keyPath: 'id' });
        mountStore.createIndex('sessionId', 'sessionId', { unique: false });
        mountStore.createIndex('kind', 'kind', { unique: false });
    }
}

async function saveToStore(storeName, data) {
    if (storeName === 'sessions' && state.isExitingTunnel && data?.sessionId === state.sessionId) return;
    if (storeName === 'sessions' && data?.sessionId) updateSessionDirectoryCache(data);
    if (storeName === 'files' && data?.id && !Object.hasOwn(data, 'data') && data.cacheCleared !== true) {
        const existing = await getFromStore('files', data.id).catch(() => null);
        if (hasCompleteFileCache(existing, data)) {
            data = {
                ...data,
                data: existing.data,
                cacheStoreRef: existing.cacheStoreRef,
                cacheStorage: existing.cacheStorage,
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

async function countFromStore(storeName) {
    if (state.db._isMemory) return memoryStorage.get(storeName)?.size || 0;
    return new Promise((resolve, reject) => {
        try {
            const transaction = state.db.transaction([storeName], 'readonly');
            const request = transaction.objectStore(storeName).count();
            request.onsuccess = () => resolve(Number(request.result) || 0);
            request.onerror = () => reject(request.error);
        } catch (err) {
            reject(err);
        }
    });
}

async function deleteFromStore(storeName, key) {
    if (storeName === 'sessions') updateSessionDirectoryCache(null, key);
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

function readSessionDirectoryCache() {
    try {
        const parsed = JSON.parse(localStorage.getItem(SESSION_DIRECTORY_STORAGE_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function updateSessionDirectoryCache(session, deletedSessionId = '') {
    const entries = readSessionDirectoryCache();
    const sessionId = deletedSessionId || session?.sessionId || '';
    const next = entries.filter(entry => entry?.sessionId !== sessionId);
    const shortCode = normalizeLocalShortCode(session?.shortCode);
    if (session?.sessionId && shortCode) {
        next.push({
            sessionId: session.sessionId,
            shortCode,
            remark: String(session.remark || '').trim().slice(0, 60),
            lastActive: Number(session.lastActive || session.createdAt || Date.now())
        });
    }
    localStorage.setItem(SESSION_DIRECTORY_STORAGE_KEY, JSON.stringify(next.slice(-500)));
}

function replaceSessionDirectoryCache(sessions = []) {
    const entries = Array.from(sessions || [])
        .filter(session => /^[a-zA-Z0-9_-]{8,64}$/.test(session?.sessionId || '') && normalizeLocalShortCode(session.shortCode))
        .map(session => ({
            sessionId: session.sessionId,
            shortCode: normalizeLocalShortCode(session.shortCode),
            remark: String(session.remark || '').trim().slice(0, 60),
            lastActive: Number(session.lastActive || session.createdAt || Date.now())
        }))
        .slice(-500);
    localStorage.setItem(SESSION_DIRECTORY_STORAGE_KEY, JSON.stringify(entries));
    return entries;
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
    const recordRouteMatch = entryUrl.pathname.match(/^\/record\/([^/]+)\/([^/]+)\/?$/);
    const routeSessionId = recordRouteMatch ? decodeURIComponent(recordRouteMatch[1]) : '';
    state.pendingRecordId = recordRouteMatch
        ? decodeURIComponent(recordRouteMatch[2])
        : String(entryUrl.searchParams.get('record') || '').trim();
    state.pendingRecordDetails = Boolean(recordRouteMatch);
    const hash = routeSessionId || entryUrl.hash.slice(1);
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
        let storedSessions = readSessionDirectoryCache();
        const pendingSharedFileCount = await countFromStore('shareQueue').catch(() => 0);
        const shareEntryRequested = entryUrl.searchParams.has('share');
        const shareFallbackRoute = entryUrl.searchParams.get('shareRoute') || '';
        const shareErrorReported = entryUrl.searchParams.has('shareError') || entryUrl.searchParams.has('shareEmpty') || Boolean(shareFallbackRoute);
        if (!storedSessions.length) {
            storedSessions = await getAllFromStore('sessions').catch(() => []);
            storedSessions = replaceSessionDirectoryCache(storedSessions);
        }
        const recent = storedSessions
            .filter(session => /^[a-zA-Z0-9_-]{8,64}$/.test(session.sessionId) && normalizeLocalShortCode(session.shortCode))
            .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))[0];
        state.recentSessionId = recent?.sessionId || null;
        state.pendingSharedFileCount = pendingSharedFileCount;
        state.pendingSharedFileError = shareEntryRequested && pendingSharedFileCount === 0 && shareErrorReported;

        if (!entryUrl.searchParams.has('leave') && state.pendingSharedFileCount === 0 && !state.pendingSharedFileError && state.recentSessionId) {
            state.sessionId = state.recentSessionId;
            state.shortCode = normalizeLocalShortCode(recent.shortCode);
            state.sessionRemark = String(recent.remark || '').trim().slice(0, 60);
            history.replaceState(null, '', `${window.location.pathname}#${state.sessionId}`);
            updateSessionIdentityUi();
            return true;
        }

        return false;
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
    const shortCode = document.getElementById('shortCode');
    if (shortCode) shortCode.textContent = state.shortCode || '-';
    const row = document.getElementById('sessionRemarkRow');
    const value = document.getElementById('sessionRemark');
    if (row && value) {
        value.textContent = state.sessionRemark || '-';
        row.hidden = !state.sessionRemark;
    }
    generateQRCode();
}

function initSessionLanding() {
    const landing = document.getElementById('sessionLanding');
    const note = document.getElementById('landingNote');
    const recentButton = document.getElementById('landingRecentBtn');
    const sessionPicker = document.getElementById('landingSessionPicker');
    const sessionSelect = document.getElementById('landingSessionSelect');
    const sharedFilesNotice = document.getElementById('sharedFilesNotice');
    const inputs = Array.from(document.querySelectorAll('#tunnelCodeInputs input'));
    let joinInProgress = false;
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
    } else if (state.pendingSharedFileError) {
        sharedFilesNotice.hidden = false;
        sharedFilesNotice.textContent = '已打开系统分享入口，但没有收到文件内容。请先强制刷新或重新安装 PWA 后再试；部分软件会走 /share 或 /share/，本版本已兼容这两种入口。';
    }
    const renderSessionPicker = sessions => {
        const validSessions = sessions
            .filter(session => /^[a-zA-Z0-9_-]{8,64}$/.test(session.sessionId) && normalizeLocalShortCode(session.shortCode))
            .sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId), undefined, { numeric: true, sensitivity: 'base' }));
        if (!validSessions.length || !sessionPicker || !sessionSelect) return;
        sessionSelect.replaceChildren();
        const recentId = state.recentSessionId || validSessions.slice().sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))[0]?.sessionId || '';
        validSessions.forEach(session => {
            const option = document.createElement('option');
            option.value = session.sessionId;
            const code = normalizeLocalShortCode(session.shortCode);
            const remark = String(session.remark || '').trim();
            option.textContent = `${code || session.sessionId.slice(0, 8)}${remark ? ` · ${remark}` : ''}${session.sessionId === recentId ? ' · 最近使用' : ''}`;
            if (session.sessionId === recentId) option.selected = true;
            sessionSelect.appendChild(option);
        });
        sessionPicker.hidden = false;
        state.recentSessionId = recentId || state.recentSessionId;
        if (recentButton) {
            recentButton.hidden = false;
            recentButton.textContent = '进入所选隧道';
        }
    };
    renderSessionPicker(readSessionDirectoryCache());
    getAllFromStore('sessions').then(sessions => {
        const entries = replaceSessionDirectoryCache(sessions);
        renderSessionPicker(entries);
    }).catch(err => historyLog('landing-session-picker-load-failed', { error: err.message }));

    if (state.recentSessionId) {
        recentButton.hidden = false;
        recentButton.addEventListener('click', () => {
            const selected = sessionSelect?.value || state.recentSessionId;
            openSession(selected);
        });
    }

    const getCodeValue = () => inputs.map(input => input.value).join('').toUpperCase();
    const maybeAutoJoin = () => {
        if (!joinInProgress && /^[A-Z0-9]{5}$/.test(getCodeValue())) {
            window.setTimeout(join, 0);
        }
    };
    const fillCode = value => {
        const characters = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, inputs.length);
        inputs.forEach(input => { input.value = ''; });
        characters.split('').forEach((character, index) => { inputs[index].value = character; });
        const focusIndex = Math.min(characters.length, inputs.length - 1);
        inputs[focusIndex].focus();
        maybeAutoJoin();
    };
    const join = async () => {
        if (joinInProgress) return;
        const shortCode = getCodeValue();
        if (!/^[A-Z0-9]{5}$/.test(shortCode)) {
            note.textContent = '请输入完整的 5 位隧道暗号。';
            return;
        }
        note.textContent = '正在查找传输隧道...';
        joinInProgress = true;
        try {
            const response = await fetch(`/api/short-codes/${encodeURIComponent(shortCode)}`);
            if (!response.ok) throw new Error('没有找到该传输隧道，或它已经被删除。');
            const data = await response.json();
            if (!/^[a-zA-Z0-9_-]{8,64}$/.test(data.sessionId || '')) throw new Error('传输隧道响应无效。');
            openSession(data.sessionId);
        } catch (err) {
            note.textContent = err.message;
            joinInProgress = false;
        }
    };

    inputs.forEach((input, index) => {
        input.addEventListener('input', event => {
            const value = String(event.data || event.target.value).toUpperCase().replace(/[^A-Z0-9]/g, '');
            event.target.value = value.slice(-1);
            if (event.target.value && inputs[index + 1]) {
                window.setTimeout(() => {
                    if (document.activeElement === input) inputs[index + 1].focus();
                }, 0);
            }
            maybeAutoJoin();
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
    document.getElementById('landingCreateBtn').addEventListener('click', () => {
        openSession(generateId());
    });
    if (window.matchMedia('(min-width: 768px)').matches) {
        requestAnimationFrame(() => inputs[0]?.focus());
    }
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

// ==================== 光媒分享 / 接收 ====================
function getLightTransferApi() {
    return window.Drop2TunnelLightTransfer || null;
}

function setFilePreviewLightShareButton(visible) {
    const button = document.getElementById('filePreviewLightShareBtn');
    if (!button) return;
    button.hidden = !visible;
}

async function readFileBytesForLight(fileInfo) {
    if (!fileInfo?.id) throw new Error('文件信息无效');
    const persisted = await getFromStore('files', fileInfo.id).catch(() => null);
    let stored = await materializeCachedFileRecord(persisted);
    if (stored?.externalFileHandle) {
        stored = await materializeExternalFileRecord(stored, { requestPermission: true });
    }
    if (!hasCompleteFileCache(stored, fileInfo)) {
        throw new Error(`“${fileInfo.name || fileInfo.id}”在本机没有完整数据，请先还原该文件`);
    }
    const bytes = await getStoredFileBytes(stored);
    if (bytes.byteLength !== Number(fileInfo.size || stored?.size || bytes.byteLength)) {
        historyLog('light-share-size-difference', { fileId: fileInfo.id, declaredSize: fileInfo.size, actualSize: bytes.byteLength });
    }
    return bytes;
}

function buildStandaloneLightFileRecord(message, fileInfo) {
    return {
        id: fileInfo?.id ? `light-source-${fileInfo.id}` : message?.id || '',
        type: 'file',
        fileInfo: { ...(fileInfo || {}) },
        timestamp: Number(message?.timestamp) || Date.now(),
        sender: message?.sender || '',
        senderName: message?.senderName || '',
        remark: String(fileInfo?.remark || message?.remark || '').slice(0, RECORD_REMARK_MAX_LENGTH)
    };
}

async function buildLightBundleFromMessage(message, onlyFileInfo = null) {
    if (!message) throw new Error('找不到传输记录');
    const collectionFiles = message.type === 'collection' ? getCollectionFiles(message) : [];
    const selectedFiles = onlyFileInfo
        ? [onlyFileInfo]
        : message.type === 'collection'
            ? collectionFiles
            : message.fileInfo?.id ? [message.fileInfo] : [];
    if (!selectedFiles.length) throw new Error('此记录没有可分享的文件');
    const files = [];
    for (const fileInfo of selectedFiles) {
        files.push({ fileInfo: { ...fileInfo }, bytes: await readFileBytesForLight(fileInfo) });
    }
    const isWholeCollection = message.type === 'collection' && !onlyFileInfo;
    const record = isWholeCollection
        ? createHistoryReconcileMessage(message)
        : buildStandaloneLightFileRecord(message, selectedFiles[0]);
    return {
        kind: isWholeCollection ? 'collection' : 'file',
        tunnelId: state.sessionId,
        shortCode: state.shortCode || '',
        sourceMessageId: isWholeCollection || message.type === 'file' ? message.id : '',
        title: isWholeCollection
            ? (message.collection?.name || message.remark || `合辑 · ${selectedFiles.length} 个文件`)
            : selectedFiles[0].name || '光媒文件',
        record,
        files,
        createdAt: Number(message.timestamp) || Date.now()
    };
}

function getLightNetworkProviderUrl(taskId, providerDeviceId) {
    if (!state.socket?.connected || !taskId || !providerDeviceId) return '';
    return `${location.origin}/api/light-transfer/network/${encodeURIComponent(taskId)}?provider=${encodeURIComponent(providerDeviceId)}`;
}

function getLightReportUrl(taskId, providerDeviceId) {
    if (!taskId || !providerDeviceId) return '';
    return `${location.origin}/api/light-transfer/report/${encodeURIComponent(taskId)}?provider=${encodeURIComponent(providerDeviceId)}`;
}

async function shareHistoryMessageViaLight(messageId) {
    const api = getLightTransferApi();
    if (!api) throw new Error('光媒模块未加载');
    const message = await getFromStore('messages', messageId);
    const bundle = await buildLightBundleFromMessage(message);
    return api.openSender(bundle);
}

async function shareCurrentPreviewViaLight() {
    const api = getLightTransferApi();
    if (!api) throw new Error('光媒模块未加载');
    const fileInfo = await getActivePreviewFileInfo();
    if (!fileInfo?.id) throw new Error('当前没有可分享的文件');
    const messageId = activeFilePreviewMessageId || activeCollectionPreviewMessageId;
    const sourceMessage = messageId ? await getFromStore('messages', messageId) : null;
    const message = sourceMessage || { id: '', type: 'file', fileInfo, timestamp: Date.now(), sender: state.deviceId, senderName: state.deviceName };
    const bundle = await buildLightBundleFromMessage(message, fileInfo);
    return api.openSender(bundle);
}

function createLightReceivedMessageId(taskId) {
    const h = String(taskId || '').replace(/[^a-f0-9]/gi, '').padEnd(32, '0');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function createLightReceivedFileId(taskId, order = 0) {
    const orderHex = Math.max(0, Number(order) || 0).toString(16).padStart(8, '0').slice(-8);
    const seed = `${String(taskId || '').replace(/[^a-f0-9]/gi, '').slice(0, 24)}${orderHex}`.padEnd(32, '0');
    return `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-8${seed.slice(17, 20)}-${seed.slice(20, 32)}`;
}

async function finalizeReceivedLightTransfer({ manifest, files }) {
    if (!manifest?.taskId || !Array.isArray(files) || !files.length) throw new Error('光媒任务数据不完整');
    const targetSessionId = String(manifest.tunnelId || state.sessionId || '');
    const sourceMessageId = String(manifest.sourceMessageId || '');
    for (const item of files) {
        const fileInfo = { ...(item.fileInfo || {}) };
        if (!fileInfo.id) fileInfo.id = createLightReceivedFileId(manifest.taskId, item.order);
        const bytes = item.bytes instanceof Uint8Array ? item.bytes : new Uint8Array(item.bytes || 0);
        const existing = await getFromStore('files', fileInfo.id).catch(() => null);
        await saveToStore('files', {
            ...(existing || {}),
            ...fileInfo,
            id: fileInfo.id,
            sessionId: targetSessionId,
            size: bytes.byteLength,
            data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            receivedSize: bytes.byteLength,
            isPartial: false,
            transferInterrupted: false,
            cacheCleared: false,
            restoreRequested: false,
            isFileAsset: true,
            lightTransferTaskId: manifest.taskId
        });
        if (targetSessionId === state.sessionId && fileAssetTransfer) {
            await fileAssetTransfer.announce({
                ...fileInfo,
                id: fileInfo.id,
                size: bytes.byteLength,
                ownerDeviceId: fileInfo.ownerDeviceId || state.deviceId,
                isFileAsset: true
            }).catch(err => historyLog('light-file-asset-announce-failed', { fileId: fileInfo.id, error: err.message }));
        }
    }

    const existingSource = sourceMessageId ? await getFromStore('messages', sourceMessageId).catch(() => null) : null;
    if (existingSource && existingSource.sessionId === targetSessionId) {
        await saveToStore('messages', {
            ...existingSource,
            lightTransfer: {
                ...(existingSource.lightTransfer || {}),
                taskId: manifest.taskId,
                receivedAt: Date.now(),
                sourceMessageId
            }
        });
        if (targetSessionId === state.sessionId) {
            await applyHistoryMessageUpdate({
                ...existingSource,
                lightTransfer: {
                    ...(existingSource.lightTransfer || {}),
                    taskId: manifest.taskId,
                    receivedAt: Date.now(),
                    sourceMessageId
                }
            }, { remote: false }).catch(err => historyLog('light-existing-record-refresh-failed', { messageId: existingSource.id, error: err.message }));
        }
        return { messageId: existingSource.id, recordUrl: `/record/${encodeURIComponent(targetSessionId)}/${encodeURIComponent(existingSource.id)}` };
    }

    const sourceRecord = manifest.record && typeof manifest.record === 'object' ? JSON.parse(JSON.stringify(manifest.record)) : {};
    const receivedFiles = files.map(item => ({ ...(item.fileInfo || {}), size: Number(item.bytes?.byteLength ?? item.fileInfo?.size ?? 0) }));
    const isCollection = manifest.kind === 'collection';
    const message = {
        ...sourceRecord,
        id: createLightReceivedMessageId(manifest.taskId),
        type: isCollection ? 'collection' : 'file',
        timestamp: nextHistoryTimestamp(),
        sender: state.deviceId,
        senderName: state.deviceName,
        lightTransfer: {
            taskId: manifest.taskId,
            sourceMessageId,
            sourceSender: sourceRecord.sender || '',
            sourceSenderName: sourceRecord.senderName || '',
            receivedAt: Date.now()
        }
    };
    if (isCollection) {
        message.collection = {
            ...(sourceRecord.collection || {}),
            id: sourceRecord.collection?.id || `light-${manifest.taskId.slice(0, 24)}`,
            files: receivedFiles,
            count: receivedFiles.length,
            totalSize: receivedFiles.reduce((sum, file) => sum + Number(file.size || 0), 0)
        };
        delete message.fileInfo;
    } else {
        message.fileInfo = receivedFiles[0];
        delete message.collection;
    }

    if (targetSessionId === state.sessionId && state.socket?.connected) {
        await publishHistoryMessage(message, { autoRequestAsset: false });
    } else {
        await saveToStore('messages', { ...message, sessionId: targetSessionId });
        const known = await getFromStore('sessions', targetSessionId).catch(() => null);
        if (!known) {
            await saveToStore('sessions', {
                sessionId: targetSessionId,
                shortCode: String(manifest.shortCode || ''),
                timestamp: Date.now(),
                lastAccess: Date.now(),
                source: 'light-transfer'
            }).catch(() => {});
        }
    }
    historyLog('light-transfer-finalized', { taskId: manifest.taskId, sessionId: targetSessionId, messageId: message.id, fileCount: receivedFiles.length });
    return { messageId: message.id, recordUrl: `/record/${encodeURIComponent(targetSessionId)}/${encodeURIComponent(message.id)}` };
}

function configureLightTransfer() {
    const api = getLightTransferApi();
    if (!api) return;
    api.configure({
        getDeviceId: () => state.deviceId || '',
        getDeviceName: () => state.deviceName || '',
        getNetworkUrl: (taskId, providerDeviceId) => getLightNetworkProviderUrl(taskId, providerDeviceId || state.deviceId),
        getReportUrl: (taskId, providerDeviceId) => getLightReportUrl(taskId, providerDeviceId || state.deviceId),
        toast: message => showAppToast(message),
        finalizeTask: finalizeReceivedLightTransfer
    });
}

function ensureDeviceCameraBridge() {
    if (deviceCameraBridge || !window.DeviceCameraBridge || !state.socket) return deviceCameraBridge;
    deviceCameraBridge = new window.DeviceCameraBridge({
        getSocket: () => state.socket,
        getSelfDeviceId: () => state.deviceId,
        getSelfDeviceName: () => state.deviceName,
        externalLog: (event, details) => externalDependencyClientLog(event, details),
        toast: message => showAppToast(message)
    });
    return deviceCameraBridge;
}

function closeTunnelCodeScanner() {
    const scanner = tunnelCodeScannerState;
    tunnelCodeScannerState = null;
    if (!scanner) return;
    clearInterval(scanner.timer);
    scanner.stream?.getTracks?.().forEach(track => track.stop());
    scanner.layer?.remove();
}

function applyScannedTunnelCode(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) return false;
    try {
        const url = new URL(raw, location.origin);
        if (url.origin === location.origin && (url.hash || url.searchParams.get('code') || url.searchParams.get('shortCode'))) {
            closeTunnelCodeScanner();
            const newHash = url.hash;
            const currentHash = window.location.hash;
            // If only the hash differs (same path + no new query params), a plain
            // location.assign() would just update the URL bar without reloading —
            // the app's DOMContentLoaded listener only fires once on initial load
            // and there is no hashchange listener that re-initialises the session.
            // Force a full page reload so the new tunnel session takes effect.
            if (newHash && newHash !== currentHash && url.pathname === window.location.pathname && !url.search) {
                location.hash = newHash;
                location.reload();
                return true;
            }
            location.assign(url.href);
            location.reload();
            return true;
        }
    } catch (_) {}
    if (/^[A-Z0-9]{5}$/i.test(raw)) {
        const input = document.getElementById('shortCodeInput');
        if (input) input.value = raw.toUpperCase();
        closeTunnelCodeScanner();
        joinByShortCode();
        return true;
    }
    return false;
}

async function openTunnelCodeScanner() {
    closeTunnelCodeScanner();
    if (!('BarcodeDetector' in window)) throw new Error('当前浏览器不支持二维码扫描，请使用支持 BarcodeDetector 的 Chromium 浏览器');
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    const layer = document.createElement('div');
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483100;background:#05070a;color:#fff;display:flex;flex-direction:column;padding:max(14px,env(safe-area-inset-top)) 14px 18px;';
    layer.innerHTML = '<div style="display:flex;align-items:center;gap:12px"><strong style="flex:1">扫描隧道码</strong><button data-close type="button" style="border:0;border-radius:999px;width:38px;height:38px;font-size:22px">×</button></div><div style="flex:1;min-height:0;display:grid;place-items:center"><video data-video playsinline muted style="width:min(92vw,680px);max-height:72vh;border-radius:18px;background:#000;object-fit:cover"></video></div><div data-status style="text-align:center;color:#cbd5e1">将隧道二维码置于扫描框内</div>';
    document.body.appendChild(layer);
    const video = layer.querySelector('[data-video]');
    video.srcObject = stream;
    await video.play();
    layer.querySelector('[data-close]').onclick = closeTunnelCodeScanner;
    const timer = setInterval(async () => {
        if (!tunnelCodeScannerState || video.readyState < 2) return;
        try {
            const results = await detector.detect(video);
            for (const result of results || []) if (applyScannedTunnelCode(result.rawValue)) return;
        } catch (_) {}
    }, 180);
    tunnelCodeScannerState = { layer, stream, timer };
}

// ==================== Socket.io 连接 ====================
function initSocket() {
    state.socket = io(CONFIG.SOCKET_SERVER, {
        transports: ['websocket', 'polling'],
        auth: { language: window.TunnelI18n?.currentLanguage?.() || navigator.language || 'zh-Hans' }
    });

    configureLightTransfer();
    ensureDeviceCameraBridge();
    state.socket.on('light-network-chunks-request', data => {
        getLightTransferApi()?.handleNetworkChunkRequest(data, result => {
            state.socket?.emit('light-network-chunks-response', { requestId: data?.requestId, ...(result || {}) });
        });
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
        announceNearbyPresence();
        if (nearbyPresenceTimer) clearInterval(nearbyPresenceTimer);
        nearbyPresenceTimer = setInterval(announceNearbyPresence, 25000);
        scheduleSessionHistoryFallbacks();
        startTunnelHeartbeat();
        state.debugLogReady = true;
        flushClientDebugLogs();
        announceStoredEditorAssets();
        announceStoredFileAssets({ resumePending: true });
        hydrateEditorAssets(document.getElementById('editor'));
        consumePendingSharedFiles().catch(err => {
            historyLog('shared-file-import-failed', { error: err.message });
        });
        flushPendingTunnelInvites();
        sendPendingTunnelInviteReceipt();
        setTimeout(() => reconcilePendingRichEdits().catch(err => historyLog('pending-rich-edit-reconcile-failed', { error: err.message })), 1200);
        discoverLocalNetworkIp().then(localIp => {
            if (!localIp || localIp === state.reportedLanIp || !state.socket?.connected) return;
            state.reportedLanIp = localIp;
            state.socket.emit('device-profile-update', {
                sessionId: state.sessionId,
                deviceModel: state.deviceModel,
                localIp
            });
            announceNearbyPresence();
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
    state.socket.on('nearby-devices', data => {
        state.nearbyDevices = new Map((Array.isArray(data?.devices) ? data.devices : [])
            .filter(device => device?.deviceId && device.deviceId !== state.deviceId)
            .map(device => [device.deviceId, device]));
        renderNearbyDevices();
        scheduleLanP2pGuide();
    });

    state.socket.on('session-short-code', (data) => {
        updateShortCode(data?.shortCode).catch(err => historyLog('short-code-persist-failed', { error: err.message }));
    });
    state.socket.on('session-remark', (data) => {
        updateSessionRemark(data?.remark || '').catch(err => historyLog('session-remark-persist-failed', { error: err.message }));
    });
    state.socket.on('session-permissions', data => {
        state.sessionOwnerDeviceId = String(data?.ownerDeviceId || '');
        state.sessionPermissions = { ...DEFAULT_TUNNEL_PERMISSIONS, ...(data?.permissions || {}) };
        state.sessionIsAdmin = data?.isAdmin === true;
        state.sessionSelfAdminPermissions = data?.selfAdminPermissions
            ? { ...DEFAULT_TUNNEL_PERMISSIONS, ...data.selfAdminPermissions }
            : null;
        state.sessionAdminDevices = new Map((Array.isArray(data?.adminDevices) ? data.adminDevices : [])
            .filter(record => record?.deviceId)
            .map(record => [record.deviceId, {
                ...record,
                permissions: { ...DEFAULT_TUNNEL_PERMISSIONS, ...(record.permissions || {}) }
            }]));
        applyTunnelPermissionUi();
    });
    state.socket.on('permission-denied', data => {
        showAppToast(`操作被隧道权限阻止：${TUNNEL_PERMISSION_LABELS[data?.capability] || data?.capability || '未知权限'}`);
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
        queuePeerSignal(data);
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
            }).then(() => {
                const detailsLayer = document.getElementById('transferRecordDetailsLayer');
                if (detailsLayer?.dataset.messageId === data.message.id) {
                    showTransferRecordDetails(data.message.id).catch(err => {
                        historyLog('message-update-detail-refresh-failed', {
                            messageId: data.message.id,
                            error: err.message
                        });
                    });
                }
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
        enqueueSessionHistory(data);
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
    state.socket.on('remote-preview-cache-check', (data) => handleRemotePreviewCacheCheck(data).catch(err => historyLog('remote-preview-cache-check-failed', { error:err.message })));
    state.socket.on('remote-preview-cache-result', handleRemotePreviewCacheResult);
    state.socket.on('remote-preview-open', (data) => handleRemotePreviewOpen(data).catch(err => historyLog('remote-preview-open-failed', { error:err.message })));
    state.socket.on('remote-preview-open-result', handleRemotePreviewOpenResult);
    state.socket.on('remote-preview-control', (data) => handleRemotePreviewControl(data).catch(err => historyLog('remote-preview-control-failed', { error:err.message })));
    state.socket.on('remote-preview-control-result', handleRemotePreviewControlResult);
    state.socket.on('remote-preview-control-ended', handleRemotePreviewControlEnded);
    state.socket.on('media-signal', (data) => mediaController?.handleSignal(data).catch(err => historyLog('media-signal-failed', { error: err.message })));
    state.socket.on('intercom-stop', (data) => mediaController?.handleIntercomStop(data));
    state.socket.on('device-tunnel-invite', handleDeviceTunnelInvite);
    state.socket.on('device-tunnel-invite-ack', handleDeviceTunnelInviteAck);
    state.socket.on('device-remark-backup', handleDeviceRemarkBackup);
    state.socket.on('device-remark-restore-request', handleDeviceRemarkRestoreRequest);
    state.socket.on('device-remark-restore-response', handleDeviceRemarkRestoreResponse);

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
    const reportExternalIceDependency = (event, details) => {
        if (typeof externalDependencyClientLog === 'function') {
            externalDependencyClientLog(event, details);
        } else {
            console.warn(`[external-dependency][webrtc-ice-services][${event}]`, details);
        }
    };
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

    pc.onicecandidateerror = (event) => {
        reportExternalIceDependency('webrtc-ice-server-error', {
            dependency: 'webrtc-ice-services',
            peerDeviceId: deviceId,
            url: event.url || '',
            errorCode: Number(event.errorCode) || 0,
            errorText: event.errorText || '',
            warning: '公共 STUN/TURN 服务、DNS、浏览器策略或网络环境可能已变化；P2P 可能降级或失败。'
        });
    };

    pc.oniceconnectionstatechange = () => {
        console.log('ICE connection state for', deviceId, ':', pc.iceConnectionState);
        historyLog('p2p-ice-state', {
            peerDeviceId: deviceId,
            iceConnectionState: pc.iceConnectionState
        });
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            console.log('P2P connection established with', deviceId);
        } else if (pc.iceConnectionState === 'disconnected') {
            console.info('P2P connection temporarily disconnected with', deviceId);
        } else if (pc.iceConnectionState === 'failed') {
            console.warn('P2P connection failed with', deviceId);
            reportExternalIceDependency('webrtc-ice-failed', {
                dependency: 'webrtc-ice-services',
                peerDeviceId: deviceId,
                iceConnectionState: pc.iceConnectionState,
                warning: 'ICE 已失败；请检查公共 STUN 可达性、NAT/防火墙以及浏览器网络策略变化。'
            });
            if (pc.iceConnectionState === 'failed') {
                editorAssetP2PUnavailablePeers.set(deviceId, Date.now() + EDITOR_ASSET_P2P_COOLDOWN);
            }
            // Attempt to restart ICE
            console.log('Attempting ICE restart...');
            try {
                pc.restartIce();
            } catch (e) {
                console.error('Failed to restart ICE:', e);
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
    if (state.devices.get(deviceId)?.clientType === 'vclient') {
        throw new Error('Cache nodes use Socket.IO relay instead of WebRTC');
    }
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
        if (existingPC.connectionState === 'failed' || existingPC.iceConnectionState === 'failed' || existingPC.connectionState === 'closed' || existingPC.iceConnectionState === 'closed') {
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

async function connectToPeerForFileAsset(deviceId) {
    if (state.devices.get(deviceId)?.clientType === 'vclient') {
        throw new Error('Cache node requires Socket.IO relay');
    }
    let pc = state.peers.get(deviceId);
    console.info('[file-asset-route]', {
        phase: 'app-connect-peer-for-file-asset-start',
        peerDeviceId: deviceId,
        peer: pc ? {
            connectionState: pc.connectionState,
            iceConnectionState: pc.iceConnectionState,
            signalingState: pc.signalingState,
            iceGatheringState: pc.iceGatheringState
        } : null
    });
    if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'closed' ||
        pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed')) {
        pc.close();
        state.peers.delete(deviceId);
        pc = null;
    }

    if (!pc) {
        pc = await createPeerConnection(deviceId);
    }

    console.info('[file-asset-route]', {
        phase: 'app-connect-peer-for-file-asset-return',
        peerDeviceId: deviceId,
        peer: {
            connectionState: pc.connectionState,
            iceConnectionState: pc.iceConnectionState,
            signalingState: pc.signalingState,
            iceGatheringState: pc.iceGatheringState
        }
    });
    if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        return pc;
    }

    return pc;
}

async function ensurePeerOfferForFileAsset(deviceId) {
    const pc = state.peers.get(deviceId);
    if (!pc) throw new Error('Peer connection missing');
    console.info('[file-asset-route]', {
        phase: 'app-ensure-offer-start',
        peerDeviceId: deviceId,
        peer: {
            connectionState: pc.connectionState,
            iceConnectionState: pc.iceConnectionState,
            signalingState: pc.signalingState,
            iceGatheringState: pc.iceGatheringState
        }
    });
    if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        console.info('[file-asset-route]', { phase: 'app-ensure-offer-skip-connected', peerDeviceId: deviceId });
        return pc;
    }
    if (pc.localDescription && pc.remoteDescription) {
        console.info('[file-asset-route]', { phase: 'app-ensure-offer-skip-negotiated', peerDeviceId: deviceId });
        return pc;
    }
    if (pc.signalingState !== 'stable') {
        console.info('[file-asset-route]', {
            phase: 'app-ensure-offer-skip-signaling-busy',
            peerDeviceId: deviceId,
            signalingState: pc.signalingState
        });
        return pc;
    }
    if (pc._fileAssetOfferPromise) return pc._fileAssetOfferPromise;
    pc._fileAssetOfferPromise = (async () => {
        const offer = await pc.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: false,
            iceRestart: false
        });
        if (state.peers.get(deviceId) !== pc || pc.signalingState !== 'stable') return pc;
        await pc.setLocalDescription(offer);
        state.socket.emit('signal', {
            to: deviceId,
            from: state.deviceId,
            type: 'offer',
            sdp: offer
        });
        historyLog('p2p-file-asset-offer-sent', { peerDeviceId: deviceId });
        console.info('[file-asset-route]', {
            phase: 'app-ensure-offer-sent',
            peerDeviceId: deviceId,
            signalingState: pc.signalingState,
            iceGatheringState: pc.iceGatheringState
        });
        return pc;
    })();
    try {
        return await pc._fileAssetOfferPromise;
    } finally {
        pc._fileAssetOfferPromise = null;
    }
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

function queuePeerSignal(data) {
    const peerDeviceId = data?.from;
    if (!peerDeviceId) {
        handleSignal(data);
        return;
    }
    const previous = peerSignalQueues.get(peerDeviceId) || Promise.resolve();
    const next = previous
        .catch(() => {})
        .then(() => handleSignal(data));
    peerSignalQueues.set(peerDeviceId, next);
    next.finally(() => {
        if (peerSignalQueues.get(peerDeviceId) === next) {
            peerSignalQueues.delete(peerDeviceId);
        }
    });
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
            if (pc.signalingState !== 'have-remote-offer') {
                historyLog('p2p-answer-skipped-stale-offer', {
                    peerDeviceId: from,
                    signalingState: pc.signalingState
                });
                return;
            }
            const answer = await pc.createAnswer();
            if (pc.signalingState !== 'have-remote-offer') {
                historyLog('p2p-answer-skipped-after-create', {
                    peerDeviceId: from,
                    signalingState: pc.signalingState
                });
                return;
            }
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

function getRichMessageContent(message) {
    return typeof message?.content === 'string' ? message.content : '';
}

function getRichMessagePreviewText(message) {
    const container = document.createElement('div');
    container.innerHTML = getRichMessageContent(message);
    return (container.textContent || '').replace(/\s+/g, ' ').trim();
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
            clearEditorAssetTransfer(assetId);
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

    if (data.transportHint === 'relay-only') {
        try {
            await sendEditorAssetViaSocketRelay(from, storedAsset);
        } catch (relayError) {
            historyLog('editor-asset-send-failed', {
                assetId: asset.id,
                peerDeviceId: from,
                transport: 'socket-relay',
                error: relayError.message
            });
            state.socket.emit('editor-asset-unavailable', {
                sessionId: state.sessionId,
                assetId: asset.id,
                to: from,
                reason: 'asset-transfer-failed'
            });
        }
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

    const transfer = {
        asset,
        chunks: [],
        receivedSize: 0,
        from: deviceId,
        transport,
        pendingChunks: Promise.resolve(),
        idleTimer: null
    };
    editorAssetTransfers.set(assetId, transfer);
    armEditorAssetTransferIdle(assetId, transfer);
    setEditorAssetStatus(assetId, `正在获取图片（${getEditorAssetTransportLabel(transport)}，0%）`, 'transferring');
    historyLog('editor-asset-receiving', { asset, peerDeviceId: deviceId, transport });
}

function clearEditorAssetTransfer(assetId) {
    const transfer = editorAssetTransfers.get(assetId);
    if (transfer?.idleTimer) clearTimeout(transfer.idleTimer);
    editorAssetTransfers.delete(assetId);
}

function armEditorAssetTransferIdle(assetId, transfer) {
    if (!transfer || editorAssetTransfers.get(assetId) !== transfer) return;
    if (transfer.idleTimer) clearTimeout(transfer.idleTimer);
    transfer.idleTimer = setTimeout(() => {
        if (editorAssetTransfers.get(assetId) !== transfer) return;
        clearEditorAssetTransfer(assetId);
        editorAssetRequests.delete(assetId);
        setEditorAssetUnavailable(assetId, 'relay-idle-timeout');
        historyLog('editor-asset-relay-timeout', {
            assetId,
            peerDeviceId: transfer.from,
            receivedSize: transfer.receivedSize
        });
    }, EDITOR_ASSET_RELAY_IDLE_TIMEOUT);
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
    armEditorAssetTransferIdle(assetId, transfer);
    if (transfer.receivedSize > transfer.asset.size) {
        clearEditorAssetTransfer(assetId);
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
    clearEditorAssetTransfer(assetId);
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
        clearEditorAssetTransfer(assetId);
        historyLog('editor-asset-relay-failed', { assetId, error: err.message });
    });
}

function handleEditorAssetRelayComplete(data) {
    const { assetId, from } = data || {};
    if (!assetId || !from) return;
    completeEditorAssetTransfer(assetId, from, 'socket-relay').catch(err => {
        clearEditorAssetTransfer(assetId);
        historyLog('editor-asset-relay-failed', { assetId, error: err.message });
    });
}

function handleEditorAssetUnavailable(data) {
    const { assetId, reason } = data || {};
    if (!assetId) return;
    clearEditorAssetTransfer(assetId);
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
    if (state.devices.get(providerDeviceId)?.clientType === 'vclient') return;
    connectToPeer(providerDeviceId).catch(err => {
        historyLog('editor-asset-peer-connect-failed', { assetId, providerDeviceId, error: err.message });
    });
}

// ==================== 文件传输 ====================
const fileTransfers = new Map(); // fileId -> transferInfo

async function materializeExternalFileRecord(storedFile, options = {}) {
    if (!storedFile?.externalFileHandle?.getFile) return storedFile;
    try {
        let permission = storedFile.externalFileHandle.queryPermission
            ? await storedFile.externalFileHandle.queryPermission({ mode: 'read' })
            : 'granted';
        if (permission !== 'granted' && options.requestPermission && storedFile.externalFileHandle.requestPermission) {
            permission = await storedFile.externalFileHandle.requestPermission({ mode: 'read' });
        }
        if (permission !== 'granted') {
            return {
                ...storedFile,
                externalFileAvailable: false,
                externalFilePermissionRequired: true,
                externalFileMissing: false
            };
        }
        const file = await storedFile.externalFileHandle.getFile();
        if (Number(storedFile.size) > 0 && file.size !== Number(storedFile.size)) {
            historyLog('external-file-size-changed', { fileId: storedFile.id, expected: storedFile.size, actual: file.size });
        }
        return {
            ...storedFile,
            name: file.name || storedFile.name,
            type: file.type || storedFile.type || 'application/octet-stream',
            size: file.size,
            data: file,
            externalFileAvailable: true,
            externalFilePermissionRequired: false,
            externalFileMissing: false
        };
    } catch (err) {
        historyLog('external-file-read-failed', { fileId: storedFile.id, error: err.message });
        return {
            ...storedFile,
            externalFileAvailable: false,
            externalFilePermissionRequired: false,
            externalFileMissing: true
        };
    }
}

function initFileAssetTransfer() {
    if (!window.FileAssetTransfer) {
        throw new Error('File asset transfer module failed to load');
    }

    fileAssetTransfer = new window.FileAssetTransfer({
        getSocket: () => state.socket,
        getSessionId: () => state.sessionId,
        getPeer: deviceId => state.peers.get(deviceId),
        connectPeer: connectToPeerForFileAsset,
        ensurePeerOffer: ensurePeerOfferForFileAsset,
        waitForDataChannel,
        load: async fileId => materializeExternalFileRecord(await materializeCachedFileRecord(await getFromStore('files', fileId))),
        beginCacheWrite: async file => fileCacheStore?.beginWrite
            ? fileCacheStore.beginWrite(file)
            : null,
        store: async file => {
            const existing = await getFromStore('files', file.id).catch(() => null);
            return saveToStore('files', { ...(existing || {}), ...file });
        },
        log: historyLog,
        onProgress: (fileId, fileName, progress, transport) => {
            const route = String(transport || '');
            const progressKey = getFileProgressKey(fileId, route);
            const status = getFileProgressStatus(route);
            const terminal = progress >= 100;
            if (!terminal && route.includes('relay')) maybeShowLanP2pGuide('relay');
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
        onDownloadIdle: (fileId, reason) => {
            fileTransferProgressStates.delete(fileId);
            hideProgress(fileId);
            historyLog('file-download-attempt-ui-cleared', { fileId, reason: reason || '' });
        },
        onReceived: async (asset) => {
            hideCompletedFileReceiveProgress(asset.id);
            const sourceInfo = serverAssetRecoveries.metadata.get(asset.id);
            let storedFile = await getFromStore('files', asset.id).catch(() => null);
            if (hasCompleteFileCache(storedFile, asset)) {
                storedFile = {
                    ...storedFile,
                    ...(sourceInfo ? { isServerAsset: true, serverAssetUrl: sourceInfo.serverAssetUrl } : {}),
                    cacheCleared: false,
                    restoreRequested: false,
                    transferInterrupted: false,
                    isPartial: false
                };
                await saveToStore('files', storedFile);
            }
            clearFileMessageAvailability(asset.id);
            const staleUrl = fileObjectUrls.get(asset.id);
            if (staleUrl) URL.revokeObjectURL(staleUrl);
            fileObjectUrls.delete(asset.id);
            clearServerAssetRecoveryStage(asset.id);
            if (asset.isDirectoryMirror) await applyDirectoryMirrorAsset(asset);
            else await refreshFileMessage(asset.id);
            notifyMusicLibraryAssetAvailable(asset, storedFile);
            if (sourceInfo) {
                confirmServerAssetCache(sourceInfo, storedFile);
                serverAssetRecoveries.metadata.delete(asset.id);
            }
            refreshOpenSnsMediaClientStates();
        },
        onUnavailable: (fileId, reason) => {
            hideCompletedFileReceiveProgress(fileId);
            updateFileMessageAvailability(fileId, reason);
            const sourceInfo = serverAssetRecoveries.metadata.get(fileId);
            if (sourceInfo) {
                scheduleServerAssetRecovery(sourceInfo, sourceInfo.ownerDeviceId || '', `peer-unavailable-${reason || 'unknown'}`, {
                    serverOnly: true
                });
            }
            refreshOpenSnsMediaClientStates();
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
        externalLog: (event, details) => externalDependencyClientLog(event, details),
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

function getCallRingtoneChoice() {
    const value = localStorage.getItem(CALL_RINGTONE_STORAGE_KEY) || 'classic';
    return ['classic', 'gentle', 'digital', 'custom'].includes(value) ? value : 'classic';
}

function openCallRingtoneDatabase() {
    if (!window.indexedDB) return Promise.reject(new Error('当前浏览器不支持保存自定义铃声'));
    if (!callRingtoneDbPromise) {
        callRingtoneDbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(CALL_RINGTONE_DB_NAME, 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(CALL_RINGTONE_STORE_NAME)) {
                    request.result.createObjectStore(CALL_RINGTONE_STORE_NAME, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('打开铃声存储失败'));
        });
    }
    return callRingtoneDbPromise;
}

async function readCustomCallRingtone() {
    const db = await openCallRingtoneDatabase();
    return new Promise((resolve, reject) => {
        const request = db.transaction(CALL_RINGTONE_STORE_NAME).objectStore(CALL_RINGTONE_STORE_NAME).get(CALL_RINGTONE_FILE_ID);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('读取自定义铃声失败'));
    });
}

async function saveCustomCallRingtone(file) {
    if (!(file instanceof Blob) || !file.size || file.size > 20 * 1024 * 1024) throw new Error('请选择不超过 20MB 的音频文件');
    if (file.type && !file.type.startsWith('audio/')) throw new Error('所选文件不是浏览器可识别的音频');
    const db = await openCallRingtoneDatabase();
    await new Promise((resolve, reject) => {
        const transaction = db.transaction(CALL_RINGTONE_STORE_NAME, 'readwrite');
        transaction.objectStore(CALL_RINGTONE_STORE_NAME).put({
            id: CALL_RINGTONE_FILE_ID,
            blob: file,
            name: String(file.name || '本地音频').slice(0, 220),
            type: file.type || 'application/octet-stream',
            size: file.size,
            updatedAt: Date.now()
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('保存自定义铃声失败'));
        transaction.onabort = () => reject(transaction.error || new Error('保存自定义铃声失败'));
    });
}

function stopContactCallTone() {
    contactCallToneGeneration += 1;
    const tone = contactCallToneState;
    contactCallToneState = null;
    callRingtonePreviewing = false;
    if (!tone) return;
    tone.timers?.forEach(timer => clearInterval(timer));
    tone.timeouts?.forEach(timer => clearTimeout(timer));
    tone.nodes?.forEach(node => { try { node.stop(); } catch (_) {} });
    if (tone.audio) {
        tone.audio.pause();
        tone.audio.src = '';
    }
    if (tone.objectUrl) URL.revokeObjectURL(tone.objectUrl);
    const previewButton = document.getElementById('previewCallRingtoneBtn');
    if (previewButton) previewButton.textContent = '试听';
}

async function ensureCallAudioContext() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error('当前浏览器不支持通话提示音');
    if (!remoteAudioContext) remoteAudioContext = new AudioContextCtor();
    if (remoteAudioContext.state === 'suspended') await remoteAudioContext.resume();
    if (remoteAudioContext.state !== 'running') {
        throw new Error('浏览器尚未授权播放通话音频');
    }
    return remoteAudioContext;
}

function scheduleCallToneChord(context, state, frequencies, offsetSeconds, durationSeconds, volume = 0.045) {
    const startAt = context.currentTime + Math.max(0.015, offsetSeconds);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.025);
    gain.gain.setValueAtTime(volume, startAt + Math.max(0.04, durationSeconds - 0.045));
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSeconds);
    gain.connect(context.destination);
    for (const frequency of frequencies) {
        const oscillator = context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, startAt);
        oscillator.connect(gain);
        oscillator.start(startAt);
        oscillator.stop(startAt + durationSeconds + 0.02);
        state.nodes.push(oscillator);
    }
}

async function startSynthesizedCallTone(kind, style = 'classic', preview = false) {
    stopContactCallTone();
    const generation = contactCallToneGeneration;
    const context = await ensureCallAudioContext();
    if (generation !== contactCallToneGeneration) return;
    const state = { kind, style, preview, timers: [], timeouts: [], nodes: [], audio: null, objectUrl: '' };
    contactCallToneState = state;
    callRingtonePreviewing = preview;
    const schedule = () => {
        if (contactCallToneState !== state) return;
        if (kind === 'ringback') {
            scheduleCallToneChord(context, state, [440, 480], 0, 1.05, 0.032);
        } else if (style === 'gentle') {
            scheduleCallToneChord(context, state, [523.25], 0, .28, .04);
            scheduleCallToneChord(context, state, [659.25], .34, .34, .035);
        } else if (style === 'digital') {
            [0, .18, .36].forEach((offset, index) => scheduleCallToneChord(context, state, [740 + index * 95], offset, .11, .038));
        } else {
            scheduleCallToneChord(context, state, [440, 480], 0, .72, .04);
            scheduleCallToneChord(context, state, [440, 480], .94, .72, .04);
        }
    };
    schedule();
    const cycleMs = kind === 'ringback' ? 4000 : (style === 'gentle' ? 3000 : style === 'digital' ? 2400 : 3600);
    state.timers.push(setInterval(schedule, cycleMs));
    if (preview) {
        const button = document.getElementById('previewCallRingtoneBtn');
        if (button) button.textContent = '停止试听';
        state.timeouts.push(setTimeout(() => { if (contactCallToneState === state) stopContactCallTone(); }, 7000));
    }
}

async function startIncomingCallRingtone(preview = false) {
    const choice = getCallRingtoneChoice();
    if (choice !== 'custom') return startSynthesizedCallTone('ringtone', choice, preview);
    stopContactCallTone();
    const generation = contactCallToneGeneration;
    const record = await readCustomCallRingtone().catch(() => null);
    if (generation !== contactCallToneGeneration) return;
    if (!record?.blob) return startSynthesizedCallTone('ringtone', 'classic', preview);
    const objectUrl = URL.createObjectURL(record.blob);
    const audio = new Audio(objectUrl);
    audio.loop = true;
    audio.volume = .9;
    audio.playsInline = true;
    const state = { kind: 'ringtone', style: 'custom', preview, timers: [], timeouts: [], nodes: [], audio, objectUrl };
    contactCallToneState = state;
    callRingtonePreviewing = preview;
    try {
        await audio.play();
        if (preview) {
            const button = document.getElementById('previewCallRingtoneBtn');
            if (button) button.textContent = '停止试听';
            state.timeouts.push(setTimeout(() => { if (contactCallToneState === state) stopContactCallTone(); }, 7000));
        }
    } catch (error) {
        stopContactCallTone();
        showRemoteAudioUnlockButton('浏览器阻止了来电铃声自动播放，请点按启用声音');
        historyLog('contact-ringtone-play-blocked', { error: error.message });
    }
}

function syncContactCallTone(call) {
    const desired = call?.state === 'dialing' ? 'ringback' : call?.state === 'incoming' ? 'ringtone' : '';
    if (!desired) return stopContactCallTone();
    if (contactCallToneState?.kind === desired && !contactCallToneState.preview) return;
    const start = desired === 'ringback'
        ? startSynthesizedCallTone('ringback', 'classic', false)
        : startIncomingCallRingtone(false);
    start.catch(error => historyLog('contact-call-tone-failed', { desired, error: error.message }));
}

async function refreshCallRingtoneSettingsUi() {
    const select = document.getElementById('callRingtoneSelect');
    const status = document.getElementById('callRingtoneFileStatus');
    if (!select || !status) return;
    const choice = getCallRingtoneChoice();
    select.value = choice;
    if (choice !== 'custom') {
        status.textContent = '当前使用内置铃声。';
        return;
    }
    const record = await readCustomCallRingtone().catch(() => null);
    status.textContent = record?.blob
        ? `当前本地铃声：${record.name}（${formatFileSize(record.size)}）`
        : '尚未选择本地音频；来电时将暂用经典双音铃。';
}

function initCallRingtoneSettings() {
    const select = document.getElementById('callRingtoneSelect');
    const chooseButton = document.getElementById('chooseCallRingtoneBtn');
    const previewButton = document.getElementById('previewCallRingtoneBtn');
    const fileInput = document.getElementById('callRingtoneFileInput');
    if (!select || select.dataset.initialized === '1') return;
    select.dataset.initialized = '1';
    select.addEventListener('change', async () => {
        localStorage.setItem(CALL_RINGTONE_STORAGE_KEY, select.value);
        stopContactCallTone();
        await refreshCallRingtoneSettingsUi();
        if (select.value === 'custom' && !(await readCustomCallRingtone().catch(() => null))) fileInput?.click();
    });
    chooseButton?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        try {
            await saveCustomCallRingtone(file);
            localStorage.setItem(CALL_RINGTONE_STORAGE_KEY, 'custom');
            select.value = 'custom';
            await refreshCallRingtoneSettingsUi();
            showAppToast('本地来电铃声已保存');
        } catch (error) {
            showAppToast(error.message);
        } finally {
            fileInput.value = '';
        }
    });
    previewButton?.addEventListener('click', async () => {
        if (previewButton.dataset.starting === '1') return;
        if (callRingtonePreviewing) return stopContactCallTone();
        previewButton.dataset.starting = '1';
        previewButton.disabled = true;
        previewButton.textContent = '准备试听…';
        try {
            await startIncomingCallRingtone(true);
        } catch (error) {
            stopContactCallTone();
            showAppToast(error.message);
        } finally {
            previewButton.dataset.starting = '';
            previewButton.disabled = false;
            if (!callRingtonePreviewing) previewButton.textContent = '试听';
        }
    });
    refreshCallRingtoneSettingsUi();
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
    const prepareOutput = kind === 'contactVoice'
        ? createContactVoiceOutputPipeline(id, stream).then(enhanced => { audio.muted = enhanced; return enhanced; })
        : Promise.resolve(false);
    prepareOutput.then(() => audio.play())
        .then(() => document.getElementById('remoteAudioUnlockBtn')?.remove())
        .catch(err => {
            audio.muted = false;
            audio.play().catch(() => {});
            historyLog('remote-audio-play-blocked', { kind, sessionKey, peerId, error: err.message });
            showRemoteAudioUnlockButton(err.message);
        });
}

async function createContactVoiceOutputPipeline(id, stream) {
    try {
        const context = await ensureCallAudioContext();
        const previous = remoteAudioPipelines.get(id);
        previous?.source?.disconnect();
        previous?.compressor?.disconnect();
        previous?.gain?.disconnect();
        const source = context.createMediaStreamSource(stream);
        const compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.knee.value = 18;
        compressor.ratio.value = 4;
        compressor.attack.value = .004;
        compressor.release.value = .22;
        const gain = context.createGain();
        // Browser media elements already stop at volume=1. Web Audio provides a modest,
        // compressor-protected speech boost for quiet phone microphones.
        gain.gain.value = 1.35;
        source.connect(compressor).connect(gain).connect(context.destination);
        remoteAudioPipelines.set(id, { source, compressor, gain });
        return true;
    } catch (error) {
        historyLog('contact-voice-output-enhancement-failed', { error: error.message });
        return false;
    }
}

function removeRemoteAudio(kind, sessionKey, peerId) {
    const id = `remote-audio-${kind}-${sessionKey}-${peerId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const pipeline = remoteAudioPipelines.get(id);
    pipeline?.source?.disconnect();
    pipeline?.compressor?.disconnect();
    pipeline?.gain?.disconnect();
    remoteAudioPipelines.delete(id);
    const audio = document.getElementById(id);
    if (audio) {
        audio.srcObject = null;
        audio.remove();
    }
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

async function announceStoredFileAssets(options = {}) {
    if (!fileAssetTransfer) return;
    try {
        const files = typeof IDBKeyRange !== 'undefined'
            ? await getAllFromStore('files', 'sessionId', IDBKeyRange.only(state.sessionId))
            : (await getAllFromStore('files')).filter(file => file.sessionId === state.sessionId);
        for (const storedFile of files) {
            const file = await materializeExternalFileRecord(storedFile);
            const isCachedChatAsset = hasCompleteFileCache(file, file) && (file.isFileAsset || (!file.isEditorAsset && file.ownerDeviceId));
            if (!isCachedChatAsset) continue;
            if (!file.isFileAsset) {
                file.isFileAsset = true;
                await saveToStore('files', file);
                historyLog('file-asset-cache-migrated', { fileId: file.id });
            }
            await fileAssetTransfer.announce(file);
            if (file.isServerAsset) confirmServerAssetCache(file, file);
        }
        if (options.resumePending) fileAssetTransfer.resumePending();
    } catch (err) {
        historyLog('file-asset-announce-failed', { error: err.message });
    }
}

async function handleFileAssetDiscovery(data) {
    const { assetId, from, reason } = data || {};
    if (!fileAssetTransfer || !assetId || from === state.deviceId) return;
    try {
        const file = await materializeExternalFileRecord(await getFromStore('files', assetId));
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
    if (!requireTunnelPermission('sendFile')) return null;
    const externalFileHandle = Number(file?.size || 0) >= EXTERNAL_FILE_HANDLE_MIN_SIZE && options.externalFileHandle?.getFile
        ? options.externalFileHandle
        : null;
    const fileInfo = createFileInfoFromFile(file, {
        ...options,
        isExternalFile: Boolean(externalFileHandle),
        externalSourceLabel: externalFileHandle ? '本机原文件' : options.externalSourceLabel
    });
    if (externalFileHandle) {
        await storeAndAnnounceExternalFileAsset(file, externalFileHandle, fileInfo);
    } else if (!options.deferAssetStorage) {
        await storeAndAnnounceFileAsset(file, fileInfo);
    }

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
        senderName: state.deviceName,
        remark: String(options.remark || '').trim().slice(0, RECORD_REMARK_MAX_LENGTH)
    };

    await publishHistoryMessage(message, {
        autoRequestAsset: options.deferAssetStorage !== true
    });
    if (options.deferAssetStorage && !externalFileHandle) {
        enqueueOutboundFileAsset(file, fileInfo, { messageId: message.id, mode: 'split' });
    }
    historyLog('file-asset-message-emitted', {
        message: summarizeHistoryMessage(message),
        targetDeviceId,
        deferredAssetStorage: options.deferAssetStorage === true
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

function readSynchsafeInteger(bytes, offset) {
    return ((bytes[offset] & 0x7f) << 21) |
        ((bytes[offset + 1] & 0x7f) << 14) |
        ((bytes[offset + 2] & 0x7f) << 7) |
        (bytes[offset + 3] & 0x7f);
}

function readId3FrameSize(bytes, offset, version) {
    if (version >= 4) return readSynchsafeInteger(bytes, offset);
    return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
}

function readUint24BE(bytes, offset) {
    return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function readUint32BE(bytes, offset) {
    return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function readUint64BEAsNumber(bytes, offset) {
    const high = readUint32BE(bytes, offset);
    const low = readUint32BE(bytes, offset + 4);
    return high * 0x100000000 + low;
}

function readAscii(bytes, offset, length) {
    if (offset < 0 || length <= 0 || offset + length > bytes.length) return '';
    return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function decodeLatin1(bytes) {
    return new TextDecoder('iso-8859-1').decode(bytes).replace(/\0+$/g, '').trim();
}

function decodeUtf8(bytes) {
    return new TextDecoder('utf-8').decode(bytes).replace(/\0+$/g, '').trim();
}

function decodeUtf16Bytes(bytes, littleEndian = true) {
    const codes = [];
    for (let index = 0; index + 1 < bytes.length; index += 2) {
        const code = littleEndian ? (bytes[index] | (bytes[index + 1] << 8)) : ((bytes[index] << 8) | bytes[index + 1]);
        if (code === 0) break;
        codes.push(code);
    }
    return String.fromCharCode(...codes).trim();
}

function cleanAudioMetaText(value) {
    return String(value || '').replace(/\0/g, '').replace(/\s+/g, ' ').trim();
}

function getFileExtensionLower(file = {}) {
    const name = String((file && file.name) || '').toLowerCase();
    const index = name.lastIndexOf('.');
    return index >= 0 ? name.slice(index + 1) : '';
}

function isAudioFileLike(storedFile, fileInfo = {}) {
    const type = String(fileInfo?.type || storedFile?.type || '').toLowerCase();
    if (type.startsWith('video/')) return false;
    if (type.startsWith('audio/')) return true;
    return ['mp3', 'm4a', 'aac', 'alac', 'flac', 'fla', 'ogg', 'opus'].includes(getFileExtensionLower(fileInfo)) ||
        ['mp3', 'm4a', 'aac', 'alac', 'flac', 'fla', 'ogg', 'opus'].includes(getFileExtensionLower(storedFile));
}

async function getStoredFileBytes(storedFile) {
    const data = storedFile?.data;
    if (!data) return new Uint8Array();
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    return new Uint8Array();
}

async function imageBytesToDataUrl(bytes, mime = 'image/jpeg') {
    if (!bytes?.length) return '';
    return await blobToBase64(new Blob([bytes], { type: mime || 'image/jpeg' }));
}

function findId3TextTerminator(bytes, start, end, encoding) {
    if (encoding === 1 || encoding === 2) {
        for (let index = start; index + 1 < end; index += 2) {
            if (bytes[index] === 0 && bytes[index + 1] === 0) return index + 2;
        }
        return end;
    }
    const index = bytes.indexOf(0, start);
    return index >= 0 && index < end ? index + 1 : end;
}

function decodeId3TextFrame(bytes, frameStart, frameEnd) {
    if (frameEnd <= frameStart) return '';
    const encoding = bytes[frameStart];
    let data = bytes.slice(frameStart + 1, frameEnd);
    if (!data.length) return '';
    if (encoding === 0) return cleanAudioMetaText(decodeLatin1(data));
    if (encoding === 3) return cleanAudioMetaText(decodeUtf8(data));
    if (encoding === 1) {
        if (data[0] === 0xff && data[1] === 0xfe) return cleanAudioMetaText(decodeUtf16Bytes(data.slice(2), true));
        if (data[0] === 0xfe && data[1] === 0xff) return cleanAudioMetaText(decodeUtf16Bytes(data.slice(2), false));
        return cleanAudioMetaText(decodeUtf16Bytes(data, true));
    }
    if (encoding === 2) return cleanAudioMetaText(decodeUtf16Bytes(data, false));
    return cleanAudioMetaText(decodeUtf8(data));
}

function extractAudioTextFromId3Bytes(bytes) {
    const metadata = {};
    if (bytes.length < 20 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return metadata;
    const version = bytes[3];
    const tagSize = readSynchsafeInteger(bytes, 6);
    let offset = 10;
    const flags = bytes[5] || 0;
    if (flags & 0x40) {
        if (version === 3 && offset + 4 <= bytes.length) {
            offset += 4 + readUint32BE(bytes, offset);
        } else if (version >= 4 && offset + 4 <= bytes.length) {
            offset += readSynchsafeInteger(bytes, offset);
        }
    }
    const end = Math.min(bytes.length, 10 + tagSize);
    const decoder = new TextDecoder('iso-8859-1');
    const headerSize = version === 2 ? 6 : 10;
    const map = version === 2
        ? { TT2: 'title', TP1: 'artist', TAL: 'album' }
        : { TIT2: 'title', TPE1: 'artist', TALB: 'album', TPE2: 'albumArtist' };
    while (offset + headerSize <= end) {
        const frameId = decoder.decode(bytes.slice(offset, offset + (version === 2 ? 3 : 4))).replace(/\0/g, '');
        const frameSize = version === 2 ? readUint24BE(bytes, offset + 3) : readId3FrameSize(bytes, offset + 4, version);
        if (!frameId || frameSize <= 0) break;
        const frameStart = offset + headerSize;
        const frameEnd = Math.min(end, frameStart + frameSize);
        const key = map[frameId];
        if (key && !metadata[key]) metadata[key] = decodeId3TextFrame(bytes, frameStart, frameEnd);
        offset = frameEnd;
    }
    return metadata;
}

function parseId3ApicFrame(bytes, frameStart, frameEnd, frameId) {
    if (frameEnd <= frameStart + 5) return null;
    const decoder = new TextDecoder('iso-8859-1');
    const encoding = bytes[frameStart];
    let cursor = frameStart + 1;
    let mime = 'image/jpeg';
    if (frameId === 'PIC') {
        const format = readAscii(bytes, cursor, 3).toUpperCase();
        cursor += 3;
        mime = format.includes('PNG') ? 'image/png' : format.includes('GIF') ? 'image/gif' : 'image/jpeg';
    } else {
        const mimeEnd = bytes.indexOf(0, cursor);
        if (mimeEnd < 0 || mimeEnd >= frameEnd) return null;
        mime = decoder.decode(bytes.slice(cursor, mimeEnd)) || 'image/jpeg';
        cursor = mimeEnd + 1;
    }
    cursor += 1; // picture type
    cursor = findId3TextTerminator(bytes, cursor, frameEnd, encoding);
    if (cursor >= frameEnd) return null;
    return {
        bytes: bytes.slice(cursor, frameEnd),
        mime
    };
}

async function extractAudioPosterFromId3Bytes(bytes) {
    if (bytes.length < 20 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return '';
    const version = bytes[3];
    const tagSize = readSynchsafeInteger(bytes, 6);
    let offset = 10;
    const flags = bytes[5] || 0;
    if (flags & 0x40) {
        if (version === 3 && offset + 4 <= bytes.length) {
            offset += 4 + readUint32BE(bytes, offset);
        } else if (version >= 4 && offset + 4 <= bytes.length) {
            offset += readSynchsafeInteger(bytes, offset);
        }
    }
    const end = Math.min(bytes.length, 10 + tagSize);
    const decoder = new TextDecoder('iso-8859-1');
    const headerSize = version === 2 ? 6 : 10;
    while (offset + headerSize <= end) {
        const frameId = decoder.decode(bytes.slice(offset, offset + (version === 2 ? 3 : 4))).replace(/\0/g, '');
        const frameSize = version === 2 ? readUint24BE(bytes, offset + 3) : readId3FrameSize(bytes, offset + 4, version);
        if (!frameId || frameSize <= 0) break;
        const frameStart = offset + headerSize;
        const frameEnd = Math.min(end, frameStart + frameSize);
        if ((frameId === 'APIC' || frameId === 'PIC') && frameEnd > frameStart + 8) {
            const image = parseId3ApicFrame(bytes, frameStart, frameEnd, frameId);
            if (image?.bytes?.length) return await imageBytesToDataUrl(image.bytes, image.mime);
        }
        offset = frameEnd;
    }
    return '';
}

function readMp4Atom(bytes, offset, limit) {
    if (offset + 8 > limit) return null;
    let size = readUint32BE(bytes, offset);
    const type = readAscii(bytes, offset + 4, 4);
    let headerSize = 8;
    if (size === 1) {
        if (offset + 16 > limit) return null;
        size = readUint64BEAsNumber(bytes, offset + 8);
        headerSize = 16;
    } else if (size === 0) {
        size = limit - offset;
    }
    if (!type || size < headerSize || offset + size > limit) return null;
    return {
        type,
        start: offset,
        end: offset + size,
        payloadStart: offset + headerSize
    };
}

function getMp4CoverMime(kind) {
    if (kind === 14) return 'image/png';
    if (kind === 12) return 'image/gif';
    return 'image/jpeg';
}

function findMp4CoverData(bytes, start = 0, end = bytes.length, depth = 0) {
    if (depth > 8) return null;
    let offset = start;
    const containers = new Set(['moov', 'udta', 'meta', 'ilst', 'covr']);
    while (offset + 8 <= end) {
        const atom = readMp4Atom(bytes, offset, end);
        if (!atom) break;
        if (atom.type === 'data' && atom.payloadStart + 8 <= atom.end) {
            const kind = readUint32BE(bytes, atom.payloadStart);
            const dataStart = atom.payloadStart + 8;
            if (dataStart < atom.end) {
                return {
                    bytes: bytes.slice(dataStart, atom.end),
                    mime: getMp4CoverMime(kind)
                };
            }
        }
        const childStart = atom.type === 'meta' ? atom.payloadStart + 4 : atom.payloadStart;
        if (containers.has(atom.type) && childStart + 8 <= atom.end) {
            const found = findMp4CoverData(bytes, childStart, atom.end, depth + 1);
            if (found) return found;
        }
        offset = atom.end;
    }
    return null;
}

function findMp4TextMetadata(bytes, start = 0, end = bytes.length, depth = 0, metadata = {}) {
    if (depth > 8) return metadata;
    let offset = start;
    const containers = new Set(['moov', 'udta', 'meta', 'ilst']);
    const atomMap = { '©nam': 'title', '©ART': 'artist', aART: 'artist', '©alb': 'album' };
    while (offset + 8 <= end) {
        const atom = readMp4Atom(bytes, offset, end);
        if (!atom) break;
        if (atomMap[atom.type]) {
            let child = atom.payloadStart;
            while (child + 8 <= atom.end) {
                const dataAtom = readMp4Atom(bytes, child, atom.end);
                if (!dataAtom) break;
                if (dataAtom.type === 'data' && dataAtom.payloadStart + 8 <= dataAtom.end) {
                    const text = cleanAudioMetaText(decodeUtf8(bytes.slice(dataAtom.payloadStart + 8, dataAtom.end)));
                    if (text && !metadata[atomMap[atom.type]]) metadata[atomMap[atom.type]] = text;
                }
                child = dataAtom.end;
            }
        }
        const childStart = atom.type === 'meta' ? atom.payloadStart + 4 : atom.payloadStart;
        if (containers.has(atom.type) && childStart + 8 <= atom.end) {
            findMp4TextMetadata(bytes, childStart, atom.end, depth + 1, metadata);
        }
        offset = atom.end;
    }
    return metadata;
}

async function extractAudioPosterFromMp4Bytes(bytes) {
    if (bytes.length < 16) return '';
    const cover = findMp4CoverData(bytes);
    return cover?.bytes?.length ? await imageBytesToDataUrl(cover.bytes, cover.mime) : '';
}

function findFlacStart(bytes) {
    const max = Math.min(bytes.length - 4, 65536);
    for (let index = 0; index <= max; index++) {
        if (bytes[index] === 0x66 && bytes[index + 1] === 0x4c && bytes[index + 2] === 0x61 && bytes[index + 3] === 0x43) {
            return index;
        }
    }
    return -1;
}

function parseFlacPictureBlock(bytes, start, end) {
    let cursor = start;
    if (cursor + 8 > end) return null;
    cursor += 4; // picture type
    const mimeLength = readUint32BE(bytes, cursor);
    cursor += 4;
    if (mimeLength < 0 || cursor + mimeLength + 4 > end) return null;
    const mime = readAscii(bytes, cursor, mimeLength) || 'image/jpeg';
    cursor += mimeLength;
    const descriptionLength = readUint32BE(bytes, cursor);
    cursor += 4 + descriptionLength;
    if (cursor + 20 > end) return null;
    cursor += 16; // width, height, depth, indexed colors
    const imageLength = readUint32BE(bytes, cursor);
    cursor += 4;
    if (imageLength <= 0 || cursor + imageLength > end) return null;
    return {
        bytes: bytes.slice(cursor, cursor + imageLength),
        mime
    };
}

function readLittleEndianUint32(bytes, offset) {
    return (bytes[offset]) | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | ((bytes[offset + 3] << 24) >>> 0);
}

function parseVorbisComments(bytes, start, end) {
    const metadata = {};
    let cursor = start;
    if (cursor + 8 > end) return metadata;
    const vendorLength = readLittleEndianUint32(bytes, cursor);
    cursor += 4 + vendorLength;
    if (cursor + 4 > end) return metadata;
    const count = readLittleEndianUint32(bytes, cursor);
    cursor += 4;
    for (let i = 0; i < count && cursor + 4 <= end; i++) {
        const length = readLittleEndianUint32(bytes, cursor);
        cursor += 4;
        if (length <= 0 || cursor + length > end) break;
        const entry = decodeUtf8(bytes.slice(cursor, cursor + length));
        cursor += length;
        const equalIndex = entry.indexOf('=');
        if (equalIndex <= 0) continue;
        const key = entry.slice(0, equalIndex).toUpperCase();
        const value = cleanAudioMetaText(entry.slice(equalIndex + 1));
        if (key === 'TITLE' && !metadata.title) metadata.title = value;
        if (key === 'ARTIST' && !metadata.artist) metadata.artist = value;
        if (key === 'ALBUM' && !metadata.album) metadata.album = value;
    }
    return metadata;
}

function extractAudioTextFromFlacBytes(bytes) {
    const metadata = {};
    const flacStart = findFlacStart(bytes);
    if (flacStart < 0) return metadata;
    let offset = flacStart + 4;
    let lastBlock = false;
    while (!lastBlock && offset + 4 <= bytes.length) {
        const header = bytes[offset];
        lastBlock = Boolean(header & 0x80);
        const blockType = header & 0x7f;
        const blockLength = readUint24BE(bytes, offset + 1);
        const blockStart = offset + 4;
        const blockEnd = blockStart + blockLength;
        if (blockEnd > bytes.length) break;
        if (blockType === 4) return parseVorbisComments(bytes, blockStart, blockEnd);
        offset = blockEnd;
    }
    return metadata;
}

async function extractAudioPosterFromFlacBytes(bytes) {
    const flacStart = findFlacStart(bytes);
    if (flacStart < 0) return '';
    let offset = flacStart + 4;
    let lastBlock = false;
    while (!lastBlock && offset + 4 <= bytes.length) {
        const header = bytes[offset];
        lastBlock = Boolean(header & 0x80);
        const blockType = header & 0x7f;
        const blockLength = readUint24BE(bytes, offset + 1);
        const blockStart = offset + 4;
        const blockEnd = blockStart + blockLength;
        if (blockEnd > bytes.length) break;
        if (blockType === 6) {
            const picture = parseFlacPictureBlock(bytes, blockStart, blockEnd);
            if (picture?.bytes?.length) return await imageBytesToDataUrl(picture.bytes, picture.mime);
        }
        offset = blockEnd;
    }
    return '';
}

async function extractAudioPosterFromStoredFile(storedFile) {
    const bytes = await getStoredFileBytes(storedFile);
    if (bytes.length < 16) return '';
    const id3Poster = await extractAudioPosterFromId3Bytes(bytes);
    if (id3Poster) return id3Poster;
    const name = String(storedFile?.name || '').toLowerCase();
    const type = String(storedFile?.type || '').toLowerCase();
    if (type.includes('mp4') || type.includes('m4a') || name.endsWith('.m4a') || name.endsWith('.mp4') || name.endsWith('.aac') || name.endsWith('.alac')) {
        const mp4Poster = await extractAudioPosterFromMp4Bytes(bytes);
        if (mp4Poster) return mp4Poster;
    }
    if (type.includes('flac') || name.endsWith('.flac') || name.endsWith('.fla')) {
        const flacPoster = await extractAudioPosterFromFlacBytes(bytes);
        if (flacPoster) return flacPoster;
    }
    return '';
}

function extractAudioTextFromId3v1Bytes(bytes) {
    if (bytes.length < 128) return {};
    const start = bytes.length - 128;
    if (readAscii(bytes, start, 3) !== 'TAG') return {};
    return {
        title: cleanAudioMetaText(decodeLatin1(bytes.slice(start + 3, start + 33))),
        artist: cleanAudioMetaText(decodeLatin1(bytes.slice(start + 33, start + 63))),
        album: cleanAudioMetaText(decodeLatin1(bytes.slice(start + 63, start + 93)))
    };
}

async function extractAudioMetadataFromStoredFile(storedFile) {
    const bytes = await getStoredFileBytes(storedFile);
    if (bytes.length < 16) return {};
    const name = String(storedFile?.name || '').toLowerCase();
    const type = String(storedFile?.type || '').toLowerCase();
    let metadata = extractAudioTextFromId3Bytes(bytes);
    if ((!metadata.title && !metadata.artist && !metadata.album) &&
        (type.includes('mp4') || type.includes('m4a') || name.endsWith('.m4a') || name.endsWith('.mp4') || name.endsWith('.aac') || name.endsWith('.alac'))) {
        metadata = findMp4TextMetadata(bytes);
    }
    if ((!metadata.title && !metadata.artist && !metadata.album) &&
        (type.includes('flac') || name.endsWith('.flac') || name.endsWith('.fla'))) {
        metadata = extractAudioTextFromFlacBytes(bytes);
    }
    const id3v1 = extractAudioTextFromId3v1Bytes(bytes);
    return {
        title: metadata.title || id3v1.title || '',
        artist: metadata.artist || metadata.albumArtist || id3v1.artist || '',
        album: metadata.album || id3v1.album || ''
    };
}

async function ensureAudioMetadataCache(storedFile, fileInfo = {}) {
    if (!isAudioFileLike(storedFile, fileInfo) || !hasCompleteFileCache(storedFile, fileInfo)) return {};
    if (storedFile.audioTitle || storedFile.audioArtist || storedFile.audioAlbum) {
        return {
            title: storedFile.audioTitle || '',
            artist: storedFile.audioArtist || '',
            album: storedFile.audioAlbum || ''
        };
    }
    const metadata = await extractAudioMetadataFromStoredFile({
        ...storedFile,
        name: storedFile?.name || fileInfo.name || '',
        type: storedFile?.type || fileInfo.type || ''
    }).catch(err => {
        historyLog('audio-metadata-cache-failed', {
            fileId: fileInfo.id || storedFile.id,
            fileName: fileInfo.name || storedFile.name,
            error: err.message
        });
        return {};
    });
    if (!metadata.title && !metadata.artist && !metadata.album) return {};
    await saveToStore('files', {
        ...storedFile,
        audioTitle: metadata.title || '',
        audioArtist: metadata.artist || '',
        audioAlbum: metadata.album || ''
    });
    return metadata;
}

async function ensureAudioPosterCache(storedFile, fileInfo = {}) {
    if (!isAudioFileLike(storedFile, fileInfo) || !hasCompleteFileCache(storedFile, fileInfo)) return '';
    if (storedFile.audioPoster) return storedFile.audioPoster;
    const poster = await extractAudioPosterFromStoredFile({
        ...storedFile,
        name: storedFile?.name || fileInfo.name || '',
        type: storedFile?.type || fileInfo.type || ''
    })
        .catch(err => {
            historyLog('audio-poster-cache-failed', {
                fileId: fileInfo.id || storedFile.id,
                fileName: fileInfo.name || storedFile.name,
                error: err.message
            });
            return '';
        });
    if (!poster) return '';
    await saveToStore('files', {
        ...storedFile,
        audioPoster: poster
    });
    return poster;
}

function ensureAudioPosterCacheShared(storedFile, fileInfo = {}) {
    const fileId = fileInfo?.id || storedFile?.id || '';
    if (!fileId) return Promise.resolve('');
    if (storedFile?.audioPoster) return Promise.resolve(storedFile.audioPoster);
    const pending = audioPosterHydrationPromises.get(fileId);
    if (pending) return pending;
    const promise = ensureAudioPosterCache(storedFile, fileInfo)
        .finally(() => audioPosterHydrationPromises.delete(fileId));
    audioPosterHydrationPromises.set(fileId, promise);
    return promise;
}

const mediaPosterQueue = [];
const mediaPosterQueuedIds = new Set();
let mediaPosterQueueRunning = false;

function shouldGenerateMediaPoster(fileInfo = {}) {
    const type = String(fileInfo.type || '').toLowerCase();
    return type.startsWith('video/') || isAudioFileLike(null, fileInfo);
}

function enqueueMediaPosterCache(fileId, fileInfo = {}) {
    if (!fileId || !shouldGenerateMediaPoster(fileInfo) || mediaPosterQueuedIds.has(fileId)) return;
    mediaPosterQueuedIds.add(fileId);
    mediaPosterQueue.push({ fileId, fileInfo: { ...fileInfo } });
    if (!mediaPosterQueueRunning) {
        mediaPosterQueueRunning = true;
        setTimeout(processMediaPosterQueue, 0);
    }
}

function getCachedMediaPosterOrQueue(storedFile, fileInfo = {}) {
    const type = String(fileInfo.type || storedFile?.type || '').toLowerCase();
    if (type.startsWith('video/')) {
        if (storedFile?.videoPoster) return storedFile.videoPoster;
        enqueueMediaPosterCache(fileInfo.id || storedFile?.id, { ...storedFile, ...fileInfo });
        return '';
    }
    if (isAudioFileLike(storedFile, fileInfo)) {
        if (storedFile?.audioPoster) return storedFile.audioPoster;
        enqueueMediaPosterCache(fileInfo.id || storedFile?.id, { ...storedFile, ...fileInfo });
        return '';
    }
    return '';
}

async function processMediaPosterQueue() {
    while (mediaPosterQueue.length) {
        const task = mediaPosterQueue.shift();
        mediaPosterQueuedIds.delete(task.fileId);
        try {
            let storedFile = await getFromStore('files', task.fileId).catch(() => null);
            if (storedFile?.externalFileHandle) {
                storedFile = await materializeExternalFileRecord(storedFile);
            }
            if (!hasCompleteFileCache(storedFile, task.fileInfo)) continue;
            const type = String(task.fileInfo.type || storedFile.type || '').toLowerCase();
            let updated = false;
            if (type.startsWith('video/') && !storedFile.videoPoster) {
                updated = Boolean(await ensureVideoPosterCache(storedFile, task.fileInfo));
            } else if (isAudioFileLike(storedFile, task.fileInfo) && !storedFile.audioPoster) {
                updated = Boolean(await ensureAudioPosterCacheShared(storedFile, task.fileInfo));
            }
            if (updated) {
                const updatedFile = await getFromStore('files', task.fileId).catch(() => null);
                const poster = updatedFile?.audioPoster || updatedFile?.videoPoster || '';
                updateMusicQueueTrackPoster(task.fileId, poster);
                updateActiveAudioPreviewPoster(task.fileId, poster);
                await refreshFileMessage(task.fileId);
                historyLog('media-poster-cache-generated', {
                    fileId: task.fileId,
                    fileName: task.fileInfo.name || storedFile.name,
                    type: task.fileInfo.type || storedFile.type
                });
            }
        } catch (err) {
            historyLog('media-poster-cache-background-failed', {
                fileId: task.fileId,
                fileName: task.fileInfo?.name,
                error: err.message
            });
        }
        await sleep(20);
    }
    mediaPosterQueueRunning = false;
    if (mediaPosterQueue.length) {
        mediaPosterQueueRunning = true;
        setTimeout(processMediaPosterQueue, 0);
    }
}

function renderMediaKindBadge(kind) {
    if (kind === 'video') return '<span class="media-kind-badge" aria-label="视频文件">▶</span>';
    if (kind === 'audio') return '<span class="media-kind-badge" aria-label="音频文件">♪</span>';
    return '';
}

function createFileInfoFromFile(file, options = {}) {
    const {
        fileId: optionFileId,
        silent,
        collectionMessageId,
        externalFileHandle,
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
    return {
        ...fileInfo,
        ownerDeviceId: state.deviceId,
        isAsset: true
    };
}

async function createFileAsset(file, options = {}) {
    const fileInfo = createFileInfoFromFile(file, options);

    const data = await fileToArrayBuffer(file);
    const asset = {
        ...fileInfo,
        sessionId: state.sessionId,
        ownerDeviceId: state.deviceId,
        isFileAsset: true,
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

async function storeAndAnnounceFileAsset(file, fileInfo) {
    const data = await fileToArrayBuffer(file);
    const asset = {
        ...fileInfo,
        sessionId: state.sessionId,
        ownerDeviceId: state.deviceId,
        isFileAsset: true,
        data
    };
    await saveToStore('files', asset);
    notifyMusicLibraryAssetAvailable(fileInfo, asset);
    await fileAssetTransfer.announce(asset);
    enqueueMediaPosterCache(fileInfo.id, fileInfo);
    refreshFileMessage(fileInfo.id).catch(err => historyLog('file-asset-refresh-after-store-failed', {
        fileId: fileInfo.id,
        fileName: fileInfo.name,
        error: err.message
    }));
    return fileInfo;
}

async function storeAndAnnounceExternalFileAsset(file, handle, fileInfo) {
    if (!handle?.getFile) return storeAndAnnounceFileAsset(file, fileInfo);
    const data = await fileToArrayBuffer(file);
    const asset = {
        ...fileInfo,
        isExternalFile: true,
        externalSourceLabel: '本机原文件',
        sessionId: state.sessionId,
        ownerDeviceId: state.deviceId,
        isFileAsset: true,
        externalFileHandle: handle,
        externalFileAvailable: true,
        externalFilePermissionRequired: false,
        externalFileMissing: false,
        data,
        hasSafetyCopy: true,
        safetyCopyState: state.devices.size > 0 ? 'pending-replica' : 'waiting-online-peer',
        sourceMode: 'external-handle-with-safety-copy',
        cacheCleared: false
    };
    await saveToStore('files', asset);
    notifyMusicLibraryAssetAvailable(fileInfo, asset);
    await fileAssetTransfer.announce(asset);
    enqueueMediaPosterCache(fileInfo.id, fileInfo);
    refreshFileMessage(fileInfo.id).catch(err => historyLog('external-file-asset-refresh-after-store-failed', {
        fileId: fileInfo.id,
        fileName: fileInfo.name,
        error: err.message
    }));
    historyLog('external-file-asset-stored', {
        fileId: fileInfo.id,
        fileName: fileInfo.name,
        size: fileInfo.size
    });
    return fileInfo;
}

const outboundFileAssetQueue = [];
let outboundFileAssetQueueRunning = false;

function enqueueOutboundFileAsset(file, fileInfo, context = {}) {
    if (!file || !fileInfo?.id) return;
    outboundFileAssetQueue.push({ file, fileInfo: { ...fileInfo }, context: { ...context } });
    if (!outboundFileAssetQueueRunning) {
        outboundFileAssetQueueRunning = true;
        setTimeout(processOutboundFileAssetQueue, 0);
    }
}

async function processOutboundFileAssetQueue() {
    while (outboundFileAssetQueue.length) {
        const task = outboundFileAssetQueue.shift();
        try {
            if (task.context.externalFileHandle) {
                await storeAndAnnounceExternalFileAsset(task.file, task.context.externalFileHandle, task.fileInfo);
            } else {
                await storeAndAnnounceFileAsset(task.file, task.fileInfo);
            }
            historyLog('outbound-file-asset-prepared', {
                fileId: task.fileInfo.id,
                fileName: task.fileInfo.name,
                size: task.fileInfo.size,
                mode: task.context.mode || '',
                messageId: task.context.messageId || ''
            });
        } catch (err) {
            historyLog('outbound-file-asset-prepare-failed', {
                fileId: task.fileInfo.id,
                fileName: task.fileInfo.name,
                mode: task.context.mode || '',
                messageId: task.context.messageId || '',
                error: err.message
            });
        }
        await sleep(10);
    }
    outboundFileAssetQueueRunning = false;
    if (outboundFileAssetQueue.length) {
        outboundFileAssetQueueRunning = true;
        setTimeout(processOutboundFileAssetQueue, 0);
    }
}

async function sendFileCollection(files, options = {}) {
    if (!requireTunnelPermission('sendFile')) return;
    const entries = Array.from(files || []).map(item => item?.file ? item : { file: item, handle: null })
        .filter(item => item.file)
        .map(entry => ({
            ...entry,
            handle: Number(entry.file?.size || 0) >= EXTERNAL_FILE_HANDLE_MIN_SIZE && entry.handle?.getFile
                ? entry.handle
                : null
        }));
    if (!entries.length) return;
    if (entries.length === 1) {
        await sendFile(entries[0].file, null, { ...options, externalFileHandle: entries[0].handle });
        return;
    }

    const collectionId = generateId();
    const fileInfos = entries.map(entry => createFileInfoFromFile(entry.file, {
        ...options,
        collectionId,
        collectionMessageId: collectionId,
        isExternalFile: Boolean(entry.handle?.getFile),
        externalSourceLabel: entry.handle?.getFile ? '本机原文件' : options.externalSourceLabel
    }));

    const totalSize = fileInfos.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    const message = {
        id: generateId(),
        type: 'collection',
        collection: {
            id: collectionId,
            files: fileInfos,
            count: fileInfos.length,
            totalSize,
            remark: String(options.remark || '').trim().slice(0, RECORD_REMARK_MAX_LENGTH)
        },
        timestamp: nextHistoryTimestamp(),
        sender: state.deviceId,
        senderName: state.deviceName,
        remark: String(options.remark || '').trim().slice(0, RECORD_REMARK_MAX_LENGTH)
    };

    await publishHistoryMessage(message, { autoRequestAsset: false });
    entries.forEach((entry, index) => {
        enqueueOutboundFileAsset(entry.file, fileInfos[index], {
            messageId: message.id,
            collectionId,
            mode: 'collection',
            externalFileHandle: entry.handle?.getFile ? entry.handle : null
        });
    });
    historyLog('file-collection-message-emitted', {
        messageId: message.id,
        collectionId,
        fileCount: fileInfos.length,
        totalSize,
        deferredAssetStorage: true
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
                <label class="send-mode-remark-label">合辑备注（可选）
                    <textarea class="send-mode-remark" maxlength="${RECORD_REMARK_MAX_LENGTH}" rows="3" placeholder="为这组合辑添加说明"></textarea>
                </label>
                <div class="send-mode-actions">
                    <button class="btn btn-secondary" type="button" data-mode="split">拆分成多条</button>
                    <button class="btn btn-primary" type="button" data-mode="collection">以合辑发送</button>
                </div>
            </div>
        `;
        const finish = mode => {
            const remark = overlay.querySelector('.send-mode-remark')?.value?.trim() || '';
            overlay.remove();
            resolve({ mode, remark });
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
    const entries = Array.from(files || []).map(item => item?.file ? item : { file: item, handle: null }).filter(item => item.file);
    if (!entries.length) return;
    const { processingProgress: suppliedProgress, ...sendOptions } = options;
    const progress = suppliedProgress || showFileSendProcessingPlaceholder(entries.length);
    const ownsProgress = !suppliedProgress;
    try {
        progress.update('检查文件', 0, entries.length, entries[0].file.name || '文件');
        if (entries.length === 1 && await maybeImportTransferHistoryBackupFile(entries[0].file)) {
            progress.update('备份导入完成', entries.length, entries.length);
            return;
        }
        if (entries.length === 1) {
            progress.update('读取文件并准备记录', 0, 1, entries[0].file.name || '文件');
            await sendFile(entries[0].file, null, { ...sendOptions, externalFileHandle: entries[0].handle });
            progress.update('记录已写入，准备发送', 1, 1, entries[0].file.name || '文件');
            return;
        }

        progress.update('等待选择发送方式', 0, entries.length, `共 ${entries.length} 个文件`);
        const { mode, remark } = await askFileCollectionMode(entries.map(entry => entry.file));
        if (mode === 'collection') {
            progress.update('生成合辑记录', 0, entries.length, `正在整理 ${entries.length} 个文件`);
            await sendFileCollection(entries, { ...sendOptions, remark });
            progress.update('合辑已写入，后台准备发送', entries.length, entries.length);
            return;
        }
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            progress.update('写入拆分记录', index, entries.length, entry.file.name || `文件 ${index + 1}`);
            await sendFile(entry.file, null, {
                ...sendOptions,
                deferAssetStorage: !entry.handle,
                externalFileHandle: entry.handle
            });
        }
        progress.update('记录已写入，后台准备发送', entries.length, entries.length);
    } finally {
        if (ownsProgress) progress.close();
    }
}

async function maybeImportTransferHistoryBackupFile(file) {
    const name = String(file?.name || '').toLowerCase();
    if (!name.endsWith('.tunnel-backup.json') && !name.endsWith('.tunnel-backup')) return false;
    try {
        const text = await file.text();
        const backup = JSON.parse(text);
        if (backup?.format !== 'instant-tunnel-history-backup' || !Array.isArray(backup.messages) || !Array.isArray(backup.assets)) {
            return false;
        }
        await importTransferHistoryBackup(file, backup);
        return true;
    } catch (err) {
        historyLog('history-backup-auto-import-failed', { fileName: file?.name || '', error: err.message });
        throw err;
    }
}

async function pickFilesForSending() {
    if (!window.isSecureContext || typeof window.showOpenFilePicker !== 'function') {
        document.getElementById('fileInput')?.click();
        return;
    }
    try {
        const handles = await window.showOpenFilePicker({ multiple: true });
        const entries = [];
        for (const handle of handles) {
            if (handle?.kind !== 'file') continue;
            entries.push({ handle, file: await handle.getFile() });
        }
        await sendSelectedFiles(entries);
    } catch (err) {
        if (err?.name === 'AbortError') return;
        historyLog('file-handle-picker-failed', { error: err.message });
        document.getElementById('fileInput')?.click();
    }
}

async function getDroppedFileEntries(dataTransfer) {
    const items = Array.from(dataTransfer?.items || []).filter(item => item.kind === 'file');
    if (!items.length) return Array.from(dataTransfer?.files || []).map(file => ({ file, handle: null }));
    const entries = [];
    for (const item of items) {
        const fallbackFile = item.getAsFile?.();
        let handle = null;
        if (typeof item.getAsFileSystemHandle === 'function') {
            try {
                const candidate = await item.getAsFileSystemHandle();
                if (candidate?.kind === 'file') handle = candidate;
            } catch (err) {
                historyLog('dropped-file-handle-read-failed', { fileName: fallbackFile?.name || '', error: err.message });
            }
        }
        const file = handle ? await handle.getFile().catch(() => fallbackFile) : fallbackFile;
        if (file) entries.push({ file, handle });
    }
    return entries;
}

function clipboardImageExtension(type = '') {
    return ({
        'image/jpeg':'jpg',
        'image/png':'png',
        'image/gif':'gif',
        'image/webp':'webp',
        'image/bmp':'bmp',
        'image/svg+xml':'svg',
        'image/avif':'avif'
    })[String(type).toLowerCase()] || 'png';
}

function createClipboardImageFile(blob, index = 0, timestamp = Date.now()) {
    const type = String(blob?.type || 'image/png').toLowerCase();
    const stamp = new Date(timestamp).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const name = `粘贴图片-${stamp}${index ? `-${index + 1}` : ''}.${clipboardImageExtension(type)}`;
    try {
        return new File([blob], name, { type, lastModified:timestamp });
    } catch (_) {
        const file = new Blob([blob], { type });
        file.name = name;
        file.lastModified = timestamp;
        return file;
    }
}

async function extractClipboardImageFiles(items, timestamp = Date.now()) {
    const files = [];
    for (const item of Array.from(items || [])) {
        const type = Array.from(item?.types || []).find(candidate => /^image\//i.test(candidate));
        if (!type || typeof item.getType !== 'function') continue;
        try {
            const blob = await item.getType(type);
            if (blob) files.push(createClipboardImageFile(blob, files.length, timestamp));
        } catch (_) {}
    }
    return files;
}

function extractPastedImageFiles(clipboardData, timestamp = Date.now()) {
    return Array.from(clipboardData?.items || [])
        .filter(item => item?.kind === 'file' && /^image\//i.test(item.type || ''))
        .map(item => item.getAsFile?.())
        .filter(Boolean)
        .map((file, index) => file.name
            ? file
            : createClipboardImageFile(file, index, timestamp));
}

function renderClipboardImagePasteArea() {
    const composer = document.getElementById('fileUploadComposer');
    const zone = document.getElementById('pasteImageZone');
    const available = clipboardImageAvailable || pendingClipboardImageFiles.length > 0;
    composer?.classList.toggle('clipboard-image-ready', available);
    if (!zone) return;
    zone.hidden = !available;
    zone.disabled = clipboardImageSendInProgress;
    zone.setAttribute('aria-label', available
        ? `将剪贴板中的${pendingClipboardImageFiles.length > 1 ? `${pendingClipboardImageFiles.length}张` : ''}图片发送到当前隧道`
        : '剪贴板中没有可粘贴的图片');
}

function setPendingClipboardImageFiles(files, options = {}) {
    pendingClipboardImageFiles = Array.from(files || []).filter(file => /^image\//i.test(file?.type || ''));
    clipboardImageAvailable = options.available === true || pendingClipboardImageFiles.length > 0;
    if (Object.prototype.hasOwnProperty.call(options, 'signature')) {
        clipboardImageSignature = String(options.signature || '');
    } else if (!clipboardImageAvailable) {
        clipboardImageSignature = '';
    }
    renderClipboardImagePasteArea();
    return pendingClipboardImageFiles;
}

async function createClipboardImageFingerprint(files) {
    const entries = [];
    for (const file of Array.from(files || [])) {
        const type = String(file?.type || 'application/octet-stream').toLowerCase();
        const size = Number(file?.size) || 0;
        if (globalThis.crypto?.subtle && typeof file?.arrayBuffer === 'function') {
            const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
            const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
            entries.push(`${type}:${size}:${hash}`);
        } else {
            entries.push(`${type}:${size}:${Number(file?.lastModified) || 0}`);
        }
    }
    return entries.length ? `image:${entries.join('|')}` : 'clipboard:none';
}

function handleClipboardImageChange(event) {
    const types = Array.from(event?.types || []).map(type => String(type).toLowerCase());
    const hasImage = types.some(type => type.startsWith('image/'));
    const changeId = String(event?.changeId || ++clipboardImageChangeSequence);
    const signature = `change:${changeId}`;
    setPendingClipboardImageFiles([], { available:hasImage, signature });
    historyLog('clipboard-images-detected', { count:hasImage ? 1 : 0, source:'clipboardchange' });
    if (hasImage && clipboardImagePermissionStatus?.state === 'granted') {
        refreshClipboardImageAvailability({ expectedSignature:signature, source:'clipboardchange' })
            .catch(err => historyLog('clipboard-image-probe-failed', { error:err.message }));
    }
}

async function getClipboardImagePermissionStatus() {
    if (clipboardImagePermissionStatus) return clipboardImagePermissionStatus;
    if (!navigator.permissions?.query) return null;
    try {
        clipboardImagePermissionStatus = await navigator.permissions.query({ name:'clipboard-read' });
        const handlePermissionChange = () => {
            if (clipboardImagePermissionStatus?.state === 'granted') {
                refreshClipboardImageAvailability().catch(err => historyLog('clipboard-image-probe-failed', { error:err.message }));
            } else if (clipboardImagePermissionStatus?.state === 'denied') {
                clipboardImageReadAllowed = false;
                setPendingClipboardImageFiles([], { available:false, signature:'' });
            }
        };
        clipboardImagePermissionStatus.addEventListener?.('change', handlePermissionChange);
        return clipboardImagePermissionStatus;
    } catch (_) {
        return null;
    }
}

async function refreshClipboardImageAvailability(options = {}) {
    if (clipboardImageProbeRunning || !window.isSecureContext || typeof navigator.clipboard?.read !== 'function') {
        return pendingClipboardImageFiles;
    }
    const permission = await getClipboardImagePermissionStatus();
    if (!options.allowPrompt && permission && permission.state !== 'granted' && !clipboardImageReadAllowed) return pendingClipboardImageFiles;
    if (!options.allowPrompt && !permission && !clipboardImageReadAllowed) return pendingClipboardImageFiles;
    clipboardImageProbeRunning = true;
    try {
        const items = await navigator.clipboard.read();
        const files = await extractClipboardImageFiles(items);
        const signature = await createClipboardImageFingerprint(files);
        clipboardImageReadAllowed = true;
        if (options.expectedSignature && clipboardImageSignature !== options.expectedSignature) {
            return pendingClipboardImageFiles;
        }
        const available = files.length > 0 && signature !== clipboardImageConsumedSignature;
        return setPendingClipboardImageFiles(available ? files : [], { available, signature });
    } catch (err) {
        if (['NotAllowedError', 'SecurityError'].includes(err?.name)) {
            clipboardImagePermissionRetryAt = Date.now() + 30_000;
        }
        if (!['NotAllowedError', 'SecurityError'].includes(err?.name)) {
            historyLog('clipboard-image-probe-failed', { name:err?.name || '', error:err?.message || String(err) });
        }
        return pendingClipboardImageFiles;
    } finally {
        clipboardImageProbeRunning = false;
    }
}

async function sendClipboardImagesToTunnel() {
    if (clipboardImageSendInProgress || !requireTunnelPermission('sendFile')) return;
    let files = pendingClipboardImageFiles;
    if (!files.length) files = await refreshClipboardImageAvailability({ allowPrompt:true });
    if (!files.length) {
        showAppToast('剪贴板中没有可发送的图片');
        return;
    }
    clipboardImageSendInProgress = true;
    renderClipboardImagePasteArea();
    try {
        await sendSelectedFiles(files);
        const sentSignature = clipboardImageSignature.startsWith('image:')
            ? clipboardImageSignature
            : await createClipboardImageFingerprint(files);
        clipboardImageConsumedSignature = sentSignature;
        setPendingClipboardImageFiles([], { available:false, signature:sentSignature });
        historyLog('clipboard-images-sent', {
            count:files.length,
            totalSize:files.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
        });
    } catch (err) {
        historyLog('clipboard-images-send-failed', { count:files.length, error:err.message });
        alert(`粘贴图片发送失败：${err.message}`);
    } finally {
        clipboardImageSendInProgress = false;
        renderClipboardImagePasteArea();
    }
}

function initClipboardImagePaste() {
    const zone = document.getElementById('pasteImageZone');
    if (!zone) return;
    zone.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        sendClipboardImagesToTunnel().catch(err => historyLog('clipboard-images-send-failed', { error:err.message }));
    });
    document.addEventListener('paste', event => {
        const files = extractPastedImageFiles(event.clipboardData);
        if (!files.length) return;
        setPendingClipboardImageFiles(files, { signature:`paste:${Date.now()}:${++clipboardImageChangeSequence}` });
        historyLog('clipboard-images-detected', { count:files.length, source:'paste-event' });
    });
    const refresh = () => {
        if (document.visibilityState !== 'hidden' && document.hasFocus?.() !== false) {
            refreshClipboardImageAvailability().catch(err => historyLog('clipboard-image-probe-failed', { error:err.message }));
        }
    };
    const clipboard = navigator.clipboard;
    const supportsClipboardChange = typeof clipboard?.addEventListener === 'function' && 'onclipboardchange' in clipboard;
    if (supportsClipboardChange) {
        clipboard.addEventListener('clipboardchange', handleClipboardImageChange);
    }
    clipboardImageMonitorTimer = window.setInterval(refresh, CLIPBOARD_IMAGE_POLL_INTERVAL);
    const requestClipboardReadAfterActivation = event => {
        if (event?.target?.closest?.('#pasteImageZone') || clipboardImagePermissionRequested || clipboardImageReadAllowed ||
            Date.now() < clipboardImagePermissionRetryAt) return;
        clipboardImagePermissionRequested = true;
        refreshClipboardImageAvailability({ allowPrompt:true, source:'user-activation' })
            .catch(err => historyLog('clipboard-image-probe-failed', { error:err.message }))
            .finally(() => { clipboardImagePermissionRequested = false; });
    };
    document.addEventListener('pointerdown', requestClipboardReadAfterActivation, { passive:true });
    document.addEventListener('keydown', requestClipboardReadAfterActivation, { passive:true });
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    refresh();
}

async function consumePendingSharedFiles() {
    if (sharedFileImportInProgress || !state.sessionId) return;
    const queued = await getAllFromStore('shareQueue').catch(() => []);
    if (!queued.length) return;

    sharedFileImportInProgress = true;
    const progress = showFileSendProcessingPlaceholder(queued.length, '正在读取系统分享文件');
    try {
        const sorted = queued.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const files = [];
        const importedItems = [];
        for (let index = 0; index < sorted.length; index++) {
            const item = sorted[index];
            progress.update('读取文件', index, sorted.length, item.name || 'shared-file');
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
            files.push(file);
            importedItems.push(item);
        }
        if (files.length) {
            progress.update('生成预览并准备记录', files.length, files.length, '请选择合辑或拆分发送');
            await sendSelectedFiles(files, { processingProgress: progress });
            progress.update('写入记录并准备发送', files.length, files.length, '正在完成本机缓存登记');
            for (const item of importedItems) {
                await deleteFromStore('shareQueue', item.id);
                historyLog('shared-file-imported', { name: item.name, size: item.size, sessionId: state.sessionId });
            }
        }
        state.pendingSharedFileCount = 0;
    } finally {
        progress.close();
        sharedFileImportInProgress = false;
    }
}

function showFileSendProcessingPlaceholder(total, initialStage = '正在准备所选文件') {
    const container = document.getElementById('chatMessages');
    const placeholder = document.createElement('div');
    placeholder.className = 'shared-file-processing-placeholder';
    placeholder.innerHTML = `<div class="shared-file-processing-spinner" aria-hidden="true"></div>
        <div class="shared-file-processing-copy">
            <strong>发送处理中</strong>
            <span>${escapeHtml(initialStage)}</span>
            <small>0 / ${total}</small>
        </div>`;
    container?.appendChild(placeholder);
    let active = true;
    const pin = () => {
        if (!active || !container) return;
        container.scrollTop = container.scrollHeight;
        requestAnimationFrame(pin);
    };
    requestAnimationFrame(pin);
    return {
        update(stage, current, count, detail = '') {
            placeholder.querySelector('span').textContent = detail ? `${stage} · ${detail}` : stage;
            placeholder.querySelector('small').textContent = `${Math.min(current + (stage === '读取文件' ? 1 : 0), count)} / ${count}`;
        },
        close() {
            active = false;
            placeholder.remove();
            if (container) requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
        }
    };
}

function downloadJsonFile(name, value) {
    const blob = new Blob([JSON.stringify(value)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function arrayBufferToBase64(buffer) {
    const source = ArrayBuffer.isView(buffer)
        ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
        : buffer;
    const bytes = new Uint8Array(source);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

function base64ToArrayBuffer(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
}

function sanitizeBackupMessage(message) {
    const clone = JSON.parse(JSON.stringify(message));
    if (clone.fileInfo) delete clone.fileInfo.data;
    (clone.collection?.files || []).forEach(file => { if (file) delete file.data; });
    return clone;
}

async function readExternalFileHandle(storedFile) {
    const handle = storedFile?.externalFileHandle;
    if (!handle?.getFile) return null;
    const permission = handle.queryPermission ? await handle.queryPermission({ mode: 'read' }) : 'granted';
    if (permission !== 'granted') return null;
    return handle.getFile();
}

async function exportTransferHistory(includeData) {
    const messages = (typeof IDBKeyRange !== 'undefined'
        ? await getAllFromStore('messages', 'sessionId', IDBKeyRange.only(state.sessionId))
        : (await getAllFromStore('messages')).filter(message => message.sessionId === state.sessionId))
        .sort(compareHistoryMessages);
    const fileIds = new Set();
    messages.forEach(message => {
        if (message.fileInfo?.id) fileIds.add(message.fileInfo.id);
        getCollectionFiles(message).forEach(file => file?.id && fileIds.add(file.id));
    });
    const assets = [];
    let completed = 0;
    for (const fileId of fileIds) {
        const stored = await getFromStore('files', fileId).catch(() => null);
        const metadata = stored ? {
            id: fileId,
            name: stored.name,
            type: stored.type,
            size: stored.size,
            ownerDeviceId: stored.ownerDeviceId,
            isFileAsset: true,
            sourceSessionId: stored.backupSourceSessionId || stored.backupSource?.sessionId || stored.sessionId || state.sessionId,
            externalSource: Boolean(stored.externalFileHandle)
        } : { id: fileId, sourceSessionId: state.sessionId };
        if (includeData) {
            let data = stored?.data;
            if (!getBinaryDataSize(data)) {
                const external = await readExternalFileHandle(stored).catch(() => null);
                if (external) data = await external.arrayBuffer();
            }
            if (getBinaryDataSize(data)) metadata.dataBase64 = arrayBufferToBase64(data instanceof Blob ? await data.arrayBuffer() : data);
        }
        assets.push(metadata);
        completed++;
        showAppToast(`正在导出资源 ${completed}/${fileIds.size}`);
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    const backup = {
        format: 'instant-tunnel-history-backup',
        version: 1,
        mode: includeData ? 'full' : 'metadata',
        exportedAt: Date.now(),
        source: {
            serverOrigin: window.location.origin,
            sessionId: state.sessionId,
            shortCode: state.shortCode,
            remark: state.sessionRemark,
            deviceId: state.deviceId
        },
        network: {
            sourceSessionId: state.sessionId,
            sourceServerOrigin: window.location.origin,
            providerDeviceIds: Array.from(new Set(assets.map(asset => asset.ownerDeviceId).filter(Boolean)))
        },
        messages: messages.map(sanitizeBackupMessage),
        assets
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadJsonFile(`tunnel-${state.shortCode || state.sessionId.slice(0, 8)}-${includeData ? 'full' : 'metadata'}-${stamp}.tunnel-backup.json`, backup);
}

function askBackupImportPlacement() {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'send-mode-overlay';
        overlay.innerHTML = `<div class="send-mode-dialog" role="dialog" aria-modal="true"><h3>导入传输记录</h3><p>请选择记录在当前隧道中的插入位置。</p><div class="send-mode-actions"><button class="btn btn-secondary" data-placement="original">按原时间戳插入</button><button class="btn btn-primary" data-placement="tail">按原顺序插入尾部</button></div></div>`;
        overlay.addEventListener('click', event => {
            const button = event.target.closest('[data-placement]');
            if (!button && event.target !== overlay) return;
            overlay.remove();
            resolve(button?.dataset.placement || '');
        });
        document.body.appendChild(overlay);
    });
}

async function importTransferHistoryBackup(file, parsedBackup = null) {
    const backup = parsedBackup || JSON.parse(await file.text());
    if (backup?.format !== 'instant-tunnel-history-backup' || !Array.isArray(backup.messages) || !Array.isArray(backup.assets)) {
        throw new Error('不是有效的传输记录备份');
    }
    const placement = await askBackupImportPlacement();
    if (!placement) return;
    const progress = showBlockingProgressPanel('正在导入传输记录', '正在准备备份数据...');
    try {
    const sourceSessionId = backup.source?.sessionId || backup.network?.sourceSessionId || '';
    const shouldRemapFileIds = Boolean(sourceSessionId && sourceSessionId !== state.sessionId);
    const assetMap = new Map(backup.assets.map(asset => [asset.id, asset]));
    const fileIdMap = new Map();
    for (const asset of backup.assets) {
        fileIdMap.set(asset.id, shouldRemapFileIds ? generateId() : asset.id);
    }
    const importedAssetsWithData = [];
    for (let assetIndex = 0; assetIndex < backup.assets.length; assetIndex++) {
        const asset = backup.assets[assetIndex];
        const newFileId = fileIdMap.get(asset.id) || asset.id;
        progress.update(Math.floor(assetIndex * 45 / Math.max(1, backup.assets.length)), `导入文件元信息 ${assetIndex + 1}/${backup.assets.length}`);
        const existing = await getFromStore('files', asset.id).catch(() => null);
        const existingNew = newFileId === asset.id ? existing : await getFromStore('files', newFileId).catch(() => null);
        const data = asset.dataBase64 ? base64ToArrayBuffer(asset.dataBase64) : existing?.data;
        const storedAsset = {
            ...(existingNew || {}),
            ...asset,
            id: newFileId,
            data,
            dataBase64: undefined,
            sessionId: state.sessionId,
            isFileAsset: true,
            cacheCleared: !getBinaryDataSize(data),
            backupSource: {
                serverOrigin: backup.source?.serverOrigin || backup.network?.sourceServerOrigin || '',
                sessionId: asset.sourceSessionId || backup.source?.sessionId || '',
                shortCode: backup.source?.shortCode || '',
                providerDeviceIds: backup.network?.providerDeviceIds || [],
                fileId: asset.id
            },
            backupSourceFileId: asset.id,
            backupSourceSessionId: asset.sourceSessionId || backup.source?.sessionId || '',
            backupSourceServer: backup.source?.serverOrigin || backup.network?.sourceServerOrigin || ''
        };
        await saveToStore('files', storedAsset);
        if (getBinaryDataSize(data)) importedAssetsWithData.push(storedAsset);
        if (assetIndex % 8 === 0) await sleep(0);
    }
    const ordered = backup.messages.slice().sort(compareHistoryMessages);
    const tailStart = Math.max(Date.now(), ...state.messages.map(message => Number(message.timestamp) || 0)) + 1;
    for (let index = 0; index < ordered.length; index++) {
        const original = ordered[index];
        progress.update(45 + Math.floor(index * 45 / Math.max(1, ordered.length)), `导入传输记录 ${index + 1}/${ordered.length}`);
        const message = {
            ...original,
            id: generateId(),
            sessionId: state.sessionId,
            timestamp: placement === 'tail' ? tailStart + index : Number(original.timestamp) || tailStart + index,
            localOrder: Number(original.localOrder) || index + 1,
            importedFromBackup: true,
            backupSourceSessionId: backup.source?.sessionId || ''
        };
        if (message.collection) {
            message.collection = { ...message.collection, id: generateId() };
        }
        const decorate = info => info ? ({
            ...info,
            id: fileIdMap.get(info.id) || info.id,
            data: undefined,
            isSmall: false,
            isAsset: true,
            backupSourceSessionId: assetMap.get(info.id)?.sourceSessionId || backup.source?.sessionId || '',
            backupSourceServer: backup.source?.serverOrigin || '',
            backupSourceFileId: info.id
        }) : info;
        if (message.fileInfo) message.fileInfo = decorate(message.fileInfo);
        if (message.collection?.files) message.collection.files = message.collection.files.map(decorate);
        await publishHistoryMessage(message, { autoRequestAsset: true, scroll: false });
        if (index % 8 === 0) await sleep(0);
    }
    progress.update(92, '广播已导入的文件缓存...');
    for (const asset of importedAssetsWithData) {
        await fileAssetTransfer?.announce(asset).catch(err => historyLog('backup-import-asset-announce-failed', {
            fileId: asset.id,
            error: err.message
        }));
    }
    progress.update(96, '刷新传输记录...');
    await loadSessionData();
    progress.update(100, '导入完成');
    progress.close();
    showAppToast(`已导入 ${ordered.length} 条传输记录`);
    } catch (err) {
        progress.close();
        throw err;
    }
}

function showHistoryBackupDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'send-mode-overlay';
    overlay.innerHTML = `<div class="send-mode-dialog" role="dialog" aria-modal="true"><h3>传输记录备份</h3><p>元信息备份体积小，完整备份会包含本机现有的全部文件数据。</p><div class="send-mode-actions"><button class="btn btn-secondary" data-action="metadata">导出元信息</button><button class="btn btn-primary" data-action="full">导出完整备份</button><button class="btn btn-secondary" data-action="import">导入备份</button></div></div>`;
    overlay.addEventListener('click', event => {
        const button = event.target.closest('[data-action]');
        if (!button && event.target !== overlay) return;
        overlay.remove();
        if (button?.dataset.action === 'metadata') exportTransferHistory(false).catch(err => alert(`导出失败：${err.message}`));
        if (button?.dataset.action === 'full') exportTransferHistory(true).catch(err => alert(`导出失败：${err.message}`));
        if (button?.dataset.action === 'import') document.getElementById('historyBackupInput')?.click();
    });
    document.body.appendChild(overlay);
}

async function purgeLocalSession(sessionId, options = {}) {
    const [messages, files, mounts, editorContent] = await Promise.all([
        typeof IDBKeyRange !== 'undefined'
            ? getAllFromStore('messages', 'sessionId', IDBKeyRange.only(sessionId))
            : getAllFromStore('messages').then(items => items.filter(item => item.sessionId === sessionId)),
        typeof IDBKeyRange !== 'undefined'
            ? getAllFromStore('files', 'sessionId', IDBKeyRange.only(sessionId))
            : getAllFromStore('files').then(items => items.filter(item => item.sessionId === sessionId)),
        typeof IDBKeyRange !== 'undefined'
            ? getAllFromStore('mounts', 'sessionId', IDBKeyRange.only(sessionId))
            : getAllFromStore('mounts').then(items => items.filter(item => item.sessionId === sessionId)),
        getFromStore('editorContent', 'current')
    ]);
    const total = Math.max(1, messages.length + files.length + mounts.length + 2);
    let done = 0;
    const tick = label => {
        done++;
        options.onProgress?.(Math.floor(done * 100 / total), label);
    };
    for (const message of messages) {
        await deleteFromStore('messages', message.id);
        tick(`清理传输记录 ${done + 1}/${total}`);
        if (done % 20 === 0) await sleep(0);
    }
    for (const file of files) {
        if (await isFileReferencedOutsideSession(file.id, sessionId)) {
            await saveToStore('files', {
                ...file,
                sessionId: file.sessionId || sessionId,
                retainedForOtherSession: true,
                timestamp: file.timestamp || Date.now()
            });
        } else {
            await deleteFromStore('files', file.id);
        }
        tick(`清理文件缓存 ${done + 1}/${total}`);
        if (done % 8 === 0) await sleep(0);
    }
    for (const mount of mounts) {
        await deleteFromStore('mounts', mount.id);
        tick(`清理本机挂载 ${done + 1}/${total}`);
    }
    await deleteFromStore('sessions', sessionId);
    tick('清理隧道索引');
    if (editorContent?.sessionId === sessionId) await deleteFromStore('editorContent', 'current');
    tick('完成退出清理');
    updateSessionDirectoryCache(null, sessionId);
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

const serverAssetRecoveries = {
    pending: [],
    active: 0,
    promises: new Map(),
    fetches: new Map(),
    metadata: new Map(),
    stages: new Map()
};

function setServerAssetRecoveryStage(fileInfo, label, active = true) {
    if (!fileInfo?.id) return;
    const stage = { label: String(label || ''), active };
    serverAssetRecoveries.stages.set(fileInfo.id, stage);
    showFileMessagePlaceholder(fileInfo.id, stage.label, true, active);
    if (activeFilePreviewMode === 'file' && activeFilePreviewFileId === fileInfo.id) {
        renderFileMetadataPreview(document.getElementById('filePreviewContent'), fileInfo, stage.label);
        renderSingleFilePreviewActions({
            messageId: activeFilePreviewMessageId || activeCollectionPreviewMessageId || '',
            fileInfo,
            ownerDeviceId: activeFilePreviewOwnerDeviceId || fileInfo.ownerDeviceId || '',
            collectionMessageId: activeCollectionPreviewMessageId || '',
            hasLocalData: false,
            cacheCleared: true,
            restoreRequested: active
        }).catch(err => historyLog('server-asset-recovery-actions-failed', { fileId: fileInfo.id, error: err.message }));
    }
    refreshCollectionPreviewCardForFile(fileInfo.id).catch(() => {});
    refreshOpenSnsMediaClientStates();
    historyLog('server-asset-recovery-stage', { fileId: fileInfo.id, label: stage.label, active });
}

function clearServerAssetRecoveryStage(fileId) {
    if (fileId) serverAssetRecoveries.stages.delete(fileId);
}

async function markServerAssetRecoveryFailed(fileInfo, error) {
    const current = await getFromStore('files', fileInfo.id).catch(() => null);
    if (hasCompleteFileCache(current, fileInfo)) {
        clearServerAssetRecoveryStage(fileInfo.id);
        return;
    }
    await saveToStore('files', {
        ...(current || {}),
        ...fileInfo,
        id: fileInfo.id,
        sessionId: state.sessionId,
        isFileAsset: true,
        isServerAsset: true,
        cacheCleared: true,
        restoreRequested: false,
        transferInterrupted: true,
        isPartial: false
    });
    setServerAssetRecoveryStage(fileInfo, `还原失败：${String(error?.message || error || '未知错误')}`, false);
}

function confirmServerAssetCache(fileInfo, cachedFile = fileInfo) {
    if (!fileInfo?.id || !fileInfo.isServerAsset || state.db?._isMemory || !state.socket?.connected) return;
    state.socket.emit('server-asset-cache-confirmed', {
        sessionId: state.sessionId,
        assetId: fileInfo.id,
        size: Number(cachedFile?.size ?? fileInfo.size) || 0
    });
}

async function fetchServerAssetCache(fileInfo, reason = '') {
    if (!fileInfo?.id || !fileInfo.serverAssetUrl) return false;
    if (serverAssetRecoveries.fetches.has(fileInfo.id)) {
        return serverAssetRecoveries.fetches.get(fileInfo.id);
    }
    const task = fetchServerAssetCacheOnce(fileInfo, reason)
        .catch(async err => {
            await markServerAssetRecoveryFailed(fileInfo, err);
            throw err;
        })
        .finally(() => serverAssetRecoveries.fetches.delete(fileInfo.id));
    serverAssetRecoveries.fetches.set(fileInfo.id, task);
    return task;
}

async function fetchServerAssetCacheOnce(fileInfo, reason = '') {
    const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
    if (hasCompleteFileCache(storedFile, fileInfo) && !storedFile?.cacheCleared) {
        await fileAssetTransfer?.announce?.(storedFile);
        confirmServerAssetCache(fileInfo, storedFile);
        serverAssetRecoveries.metadata.delete(fileInfo.id);
        clearServerAssetRecoveryStage(fileInfo.id);
        return true;
    }
    if (storedFile?.cacheCleared && !storedFile.restoreRequested) return false;

    const refetchSource = fileInfo.snsTaskId || fileInfo.snsSourceUrl ? 'SNS 原链接' : '原始渠道';
    setServerAssetRecoveryStage(fileInfo, `2/4 正在请求服务器副本（缺失时从${refetchSource}重新获取）`);
    const response = await fetch(fileInfo.serverAssetUrl, { cache: 'no-store' });
    if (!response.ok) {
        let serverError = '';
        try {
            serverError = String((await response.json())?.error || '');
        } catch (_) {}
        throw new Error(serverError && serverError !== 'server-asset-fetch-failed'
            ? serverError
            : `server-asset-fetch-${response.status}`);
    }
    const serverOrigin = response.headers.get('x-drop2tunnel-asset-origin');
    if (serverOrigin === 'sns-refetch') {
        setServerAssetRecoveryStage(fileInfo, '3/4 SNS 原链接重新获取完成，正在下载');
    } else if (serverOrigin === 'telegram-refetch') {
        setServerAssetRecoveryStage(fileInfo, '3/4 Telegram 文件重新获取完成，正在下载');
    } else {
        setServerAssetRecoveryStage(fileInfo, '2/4 服务器副本可用，正在下载');
    }
    const buffer = await response.arrayBuffer();
    const expectedSize = Number(response.headers.get('content-length')) || Number(fileInfo.size) || 0;
    if (expectedSize > 0 && buffer.byteLength !== expectedSize) {
        throw new Error(`server-asset-size-mismatch-${buffer.byteLength}-${expectedSize}`);
    }
    const nextFile = {
        ...(storedFile || {}),
        id: fileInfo.id,
        name: fileInfo.name,
        type: fileInfo.type || 'application/octet-stream',
        size: buffer.byteLength,
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
    setServerAssetRecoveryStage(fileInfo, '4/4 正在写入、校验并确认本机缓存');
    await saveToStore('files', nextFile);
    const verifiedFile = await getFromStore('files', fileInfo.id);
    if (!hasCompleteFileCache(verifiedFile, { ...fileInfo, size: buffer.byteLength })) {
        throw new Error('server-asset-cache-verification-failed');
    }
    notifyMusicLibraryAssetAvailable(fileInfo, verifiedFile);
    await fileAssetTransfer?.announce?.(verifiedFile).catch(err => historyLog('server-asset-cache-announce-failed', {
        reason,
        fileId: fileInfo.id,
        error: err.message
    }));
    confirmServerAssetCache(fileInfo, verifiedFile);
    serverAssetRecoveries.metadata.delete(fileInfo.id);
    clearServerAssetRecoveryStage(fileInfo.id);
    enqueueMediaPosterCache(fileInfo.id, fileInfo);
    fileObjectUrls.delete(fileInfo.id);
    await refreshFileMessage(fileInfo.id);
    refreshOpenSnsMediaClientStates();
    historyLog('server-asset-cache-fetched', {
        reason,
        fileId: fileInfo.id,
        fileName: fileInfo.name,
        size: verifiedFile.size
    });
    return true;
}

async function requestServerAssetWithPeerPreference(fileInfo, ownerDeviceId, reason, options = {}) {
    if (!fileInfo?.id || !fileInfo.serverAssetUrl) return false;
    serverAssetRecoveries.metadata.set(fileInfo.id, fileInfo);
    let initial = await getFromStore('files', fileInfo.id).catch(() => null);
    if (initial?.cacheCleared && !initial.restoreRequested) {
        if (!options.priority && !options.force) {
            serverAssetRecoveries.metadata.delete(fileInfo.id);
            return false;
        }
        initial = {
            ...initial,
            restoreRequested: true,
            transferInterrupted: false
        };
        await saveToStore('files', initial);
    } else if (!hasCompleteFileCache(initial, fileInfo) && (options.priority || options.force) && !initial?.restoreRequested) {
        initial = {
            ...(initial || {}),
            ...fileInfo,
            sessionId: state.sessionId,
            isFileAsset: true,
            isServerAsset: true,
            cacheCleared: true,
            restoreRequested: true,
            transferInterrupted: false,
            isPartial: false
        };
        await saveToStore('files', initial);
    }
    if (hasCompleteFileCache(initial, fileInfo) && !initial?.cacheCleared) {
        await fileAssetTransfer?.announce?.(initial);
        confirmServerAssetCache(fileInfo, initial);
        serverAssetRecoveries.metadata.delete(fileInfo.id);
        clearServerAssetRecoveryStage(fileInfo.id);
        return true;
    }

    if (fileInfo.sourceChannel === 'youtube-premium') {
        return fetchServerAssetCache(fileInfo, `${reason}-premium-ready-copy`);
    }

    setServerAssetRecoveryStage(fileInfo, '1/4 正在查找在线设备副本');
    if (fileAssetTransfer) {
        await fileAssetTransfer.request(fileInfo.id, ownerDeviceId || '', {
            ...fileInfo,
            isAsset: true
        }, {
            priority: options.priority === true,
            force: options.force === true
        }).catch(err => historyLog('server-asset-peer-request-failed', {
            reason,
            fileId: fileInfo.id,
            error: err.message
        }));
        if (fileAssetTransfer.downloadQueue?.includes(fileInfo.id)) {
            setServerAssetRecoveryStage(fileInfo, '1/4 已排队，等待在线设备传输');
            while (fileAssetTransfer.downloadQueue?.includes(fileInfo.id)) {
                await sleep(250);
            }
            setServerAssetRecoveryStage(fileInfo, '1/4 正在查找在线设备副本');
        }
        await sleep(options.peerWaitMs ?? 3500);
        const peerResult = await getFromStore('files', fileInfo.id).catch(() => null);
        if (hasCompleteFileCache(peerResult, fileInfo)) {
            confirmServerAssetCache(fileInfo, peerResult);
            serverAssetRecoveries.metadata.delete(fileInfo.id);
            clearServerAssetRecoveryStage(fileInfo.id);
            return true;
        }
        const peerTransferActive = fileAssetTransfer.transfers?.has(fileInfo.id) ||
            fileAssetTransfer.multiSourceTransfers?.has(fileInfo.id) ||
            fileAssetTransfer.providerTransfers?.has(fileInfo.id);
        const peerProgress = getFileReceiveProgressState(fileInfo.id);
        if (peerTransferActive) {
            const progress = Number(peerProgress?.progress) || 0;
            setServerAssetRecoveryStage(fileInfo, progress > 0
                ? `1/4 正在从在线设备接收（${Math.round(progress)}%）`
                : '1/4 已找到在线设备，正在建立 P2P 传输');
            return true;
        }
        fileAssetTransfer.cancel?.(fileInfo.id);
    }
    return fetchServerAssetCache(fileInfo, `${reason}-telegram-fallback`);
}

function scheduleServerAssetRecovery(fileInfo, ownerDeviceId, reason, options = {}) {
    if (!fileInfo?.id || !fileInfo.serverAssetUrl) return Promise.resolve(false);
    const existing = serverAssetRecoveries.promises.get(fileInfo.id);
    if (existing) return existing;
    if (!options.serverOnly && serverAssetRecoveries.metadata.has(fileInfo.id) && fileAssetTransfer?.hasDownloadWork?.(fileInfo.id)) {
        return Promise.resolve(true);
    }
    let resolveTask;
    const promise = new Promise(resolve => { resolveTask = resolve; });
    serverAssetRecoveries.promises.set(fileInfo.id, promise);
    serverAssetRecoveries.pending.push({ fileInfo, ownerDeviceId, reason, serverOnly: options.serverOnly === true, resolveTask });
    drainServerAssetRecoveries();
    return promise;
}

function drainServerAssetRecoveries() {
    while (serverAssetRecoveries.active < 2 && serverAssetRecoveries.pending.length) {
        const job = serverAssetRecoveries.pending.shift();
        serverAssetRecoveries.active++;
        const recovery = job.serverOnly
            ? fetchServerAssetCache(job.fileInfo, job.reason)
            : requestServerAssetWithPeerPreference(job.fileInfo, job.ownerDeviceId, job.reason);
        recovery
            .catch(err => {
                historyLog('server-asset-cache-fetch-failed', {
                    reason: job.reason,
                    fileId: job.fileInfo.id,
                    error: err.message
                });
                return false;
            })
            .then(result => {
                if (!result && !fileAssetTransfer?.hasDownloadWork?.(job.fileInfo.id)) {
                    serverAssetRecoveries.metadata.delete(job.fileInfo.id);
                }
                job.resolveTask(result);
            })
            .finally(() => {
                serverAssetRecoveries.active--;
                serverAssetRecoveries.promises.delete(job.fileInfo.id);
                refreshOpenSnsMediaClientStates();
                drainServerAssetRecoveries();
            });
    }
}

async function requestMissingFileAssetCache(message, reason) {
    const fileInfo = message?.fileInfo;
    if (fileInfo?.isServerAsset && fileInfo.serverAssetUrl) {
        scheduleServerAssetRecovery(fileInfo, fileInfo.ownerDeviceId || message.sender, reason);
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
            scheduleServerAssetRecovery(fileInfo, fileInfo.ownerDeviceId || message?.sender, reason);
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

function enqueueSessionHistory(data) {
    sessionHistoryQueue.pending = data;
    if (sessionHistoryQueue.running) return;
    sessionHistoryQueue.running = true;
    (async () => {
        while (sessionHistoryQueue.pending) {
            const snapshot = sessionHistoryQueue.pending;
            sessionHistoryQueue.pending = null;
            await handleSessionHistory(snapshot);
        }
    })().catch(err => historyLog('snapshot-processing-failed', { error: err.message }))
        .finally(() => {
            sessionHistoryQueue.running = false;
            if (sessionHistoryQueue.pending) enqueueSessionHistory(sessionHistoryQueue.pending);
        });
}

function enqueueHistoryAssetRecovery(messages) {
    sessionHistoryQueue.recoveryPending = messages;
    if (sessionHistoryQueue.recoveryRunning) return;
    sessionHistoryQueue.recoveryRunning = true;
    (async () => {
        while (sessionHistoryQueue.recoveryPending) {
            const pending = sessionHistoryQueue.recoveryPending;
            sessionHistoryQueue.recoveryPending = null;
            for (let index = 0; index < pending.length; index++) {
                const message = pending[index];
                if (message?.type === 'file' && (message.fileInfo?.isAsset || message.fileInfo?.isServerAsset)) {
                    await requestMissingFileAssetCache(message, 'snapshot-background');
                } else if (message?.type === 'collection') {
                    await requestMissingCollectionAssetCaches(message, 'snapshot-collection-background');
                }
                if (index > 0 && index % 20 === 0) await sleep(0);
            }
        }
    })().catch(err => historyLog('snapshot-background-recovery-failed', { error: err.message }))
        .finally(() => {
            sessionHistoryQueue.recoveryRunning = false;
            if (sessionHistoryQueue.recoveryPending) {
                enqueueHistoryAssetRecovery(sessionHistoryQueue.recoveryPending);
            }
        });
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

            await addMessageToChat(message, message.sender === state.deviceId, { autoRequestAsset: false });
            historyLog('snapshot-message-rendered', {
                message: summarizeHistoryMessage(message)
            });
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
    enqueueHistoryAssetRecovery(messages);
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
    const pinnedAnchor = chatScrollAnchorHoldUntil > Date.now() && chatScrollAnchorMessageId
        ? getMessageElement(chatScrollAnchorMessageId)
        : null;
    const pinnedTop = pinnedAnchor ? pinnedAnchor.offsetTop : 0;
    const restore = () => {
        if (pinnedAnchor?.isConnected) {
            container.scrollTop += pinnedAnchor.offsetTop - pinnedTop;
        } else if (chatScrollAnchorHoldUntil > Date.now() && chatScrollPinnedToBottom) {
            container.scrollTop = container.scrollHeight;
        } else if (wasNearBottom) {
            container.scrollTop = container.scrollHeight;
        } else {
            container.scrollTop = Math.max(0, container.scrollHeight - distanceFromBottom);
        }
    };
    const result = callback();
    requestAnimationFrame(restore);
    return result;
}

function stopChatScrollAnchorPin() {
    if (chatScrollAnchorPinFrame) {
        cancelAnimationFrame(chatScrollAnchorPinFrame);
        chatScrollAnchorPinFrame = 0;
    }
    chatScrollAnchorPinMode = '';
}

function releaseChatScrollAnchorPinByUser() {
    if (!chatScrollAnchorPinMode && chatScrollAnchorHoldUntil <= Date.now()) return;
    chatScrollAnchorHoldUntil = 0;
    chatScrollPinnedToBottom = false;
    chatScrollSuppressUntil = 0;
    stopChatScrollAnchorPin();
}

function pinChatScrollToDomAnchor(messageId, duration = 9000) {
    const container = document.getElementById('chatMessages');
    const anchor = getMessageElement(messageId);
    if (!container || !anchor) return false;
    stopChatScrollAnchorPin();
    chatScrollAnchorMessageId = messageId;
    chatScrollPinnedToBottom = false;
    chatScrollAnchorHoldUntil = Date.now() + duration;
    chatScrollAnchorPinMode = 'message';
    chatScrollAnchorPinnedTop = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top;

    const keepPinned = () => {
        if (chatScrollAnchorHoldUntil <= Date.now() || chatScrollAnchorPinMode !== 'message') {
            stopChatScrollAnchorPin();
            return;
        }
        const liveContainer = document.getElementById('chatMessages');
        const liveAnchor = getMessageElement(chatScrollAnchorMessageId);
        if (!liveContainer || !liveAnchor) {
            stopChatScrollAnchorPin();
            return;
        }
        const currentTop = liveAnchor.getBoundingClientRect().top - liveContainer.getBoundingClientRect().top;
        const delta = currentTop - chatScrollAnchorPinnedTop;
        if (Math.abs(delta) > 0.5) {
            chatScrollSuppressUntil = Date.now() + 120;
            liveContainer.scrollTop += delta;
        }
        chatScrollAnchorPinFrame = requestAnimationFrame(keepPinned);
    };
    chatScrollAnchorPinFrame = requestAnimationFrame(keepPinned);
    return true;
}

function pinChatScrollToBottom(duration = 9000) {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    stopChatScrollAnchorPin();
    chatScrollAnchorMessageId = '';
    chatScrollPinnedToBottom = true;
    chatScrollAnchorHoldUntil = Date.now() + duration;
    chatScrollAnchorPinMode = 'bottom';
    const keepPinned = () => {
        if (chatScrollAnchorHoldUntil <= Date.now() || chatScrollAnchorPinMode !== 'bottom') {
            stopChatScrollAnchorPin();
            return;
        }
        const liveContainer = document.getElementById('chatMessages');
        if (!liveContainer) {
            stopChatScrollAnchorPin();
            return;
        }
        chatScrollSuppressUntil = Date.now() + 120;
        liveContainer.scrollTop = liveContainer.scrollHeight;
        chatScrollAnchorPinFrame = requestAnimationFrame(keepPinned);
    };
    chatScrollAnchorPinFrame = requestAnimationFrame(keepPinned);
}

function getCurrentChatScrollAnchorId() {
    const container = document.getElementById('chatMessages');
    if (!container) return '';
    const containerRect = container.getBoundingClientRect();
    const targetY = containerRect.top + containerRect.height * 0.46;
    let best = null;
    let bestDistance = Infinity;
    document.querySelectorAll('#chatMessages .message[data-message-id]').forEach(message => {
        const rect = message.getBoundingClientRect();
        if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) return;
        const center = rect.top + rect.height / 2;
        const distance = Math.abs(center - targetY);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = message;
        }
    });
    return best?.dataset.messageId || '';
}

async function saveChatScrollAnchor() {
    const anchorId = getCurrentChatScrollAnchorId();
    if (!anchorId || !state.sessionId) return;
    chatScrollAnchorMessageId = anchorId;
    const existing = await getFromStore('sessions', state.sessionId).catch(() => null);
    await saveToStore('sessions', {
        ...(existing || {}),
        sessionId: state.sessionId,
        deviceId: state.deviceId,
        shortCode: state.shortCode || existing?.shortCode || '',
        remark: state.sessionRemark || existing?.remark || '',
        scrollAnchorMessageId: anchorId,
        scrollAnchorSavedAt: Date.now(),
        lastActive: existing?.lastActive || Date.now()
    });
}

function scheduleChatScrollAnchorSave() {
    if (chatScrollAnchorSaveTimer) clearTimeout(chatScrollAnchorSaveTimer);
    chatScrollAnchorSaveTimer = setTimeout(() => {
        chatScrollAnchorSaveTimer = null;
        saveChatScrollAnchor().catch(err => historyLog('chat-scroll-anchor-save-failed', { error: err.message }));
    }, 300);
}

function initChatScrollAnchorTracking() {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    const releaseByUser = () => {
        if (document.getElementById('chatMessages')?.classList.contains('history-loading')) return;
        releaseChatScrollAnchorPinByUser();
    };
    container.addEventListener('pointerdown', releaseByUser, { passive: true });
    container.addEventListener('touchstart', releaseByUser, { passive: true });
    container.addEventListener('wheel', releaseByUser, { passive: true });
    container.addEventListener('scroll', () => {
        if (document.getElementById('chatMessages')?.classList.contains('history-loading')) return;
        if (Date.now() < chatScrollSuppressUntil) return;
        releaseChatScrollAnchorPinByUser();
        scheduleChatScrollAnchorSave();
    }, { passive: true });
    container.addEventListener('keydown', event => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
            releaseByUser();
        }
    });
    container.addEventListener('pointerup', () => {
        scheduleChatScrollAnchorSave();
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            saveChatScrollAnchor().catch(() => {});
        }
    });
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
    const persistedFile = await getFromStore('files', fileInfo.id).catch(() => null);
    let storedFile = persistedFile;
    if (persistedFile?.externalFileHandle) storedFile = await materializeExternalFileRecord(persistedFile);
    const externalSourceState = getExternalFileSourceState(persistedFile, storedFile, fileInfo);
    const isAudioLike = isAudioFileLike(storedFile, fileInfo);
    if (hasCompleteFileCache(storedFile, fileInfo)) {
        const resolvedType = String(fileInfo.type || storedFile.type || '').toLowerCase();
        if (resolvedType.startsWith('image/')) {
            const url = getStoredFileUrl(fileInfo.id, storedFile);
            body = `<img src="${url}" alt="${escapeHtml(fileInfo.name || '')}" loading="lazy" decoding="async">`;
        } else if (resolvedType.startsWith('video/')) {
            const poster = getCachedMediaPosterOrQueue(storedFile, fileInfo);
            body = poster
                ? `<img src="${poster}" alt="${escapeHtml(fileInfo.name || '')}" loading="lazy" decoding="async">${renderMediaKindBadge('video')}`
                : `<span class="collection-video-placeholder" aria-label="视频文件">🎬</span>${renderMediaKindBadge('video')}`;
        } else if (resolvedType.startsWith('audio/') || isAudioLike) {
            const poster = getCachedMediaPosterOrQueue(storedFile, fileInfo);
            body = poster
                ? `<img src="${poster}" alt="${escapeHtml(fileInfo.name || '')}" loading="lazy" decoding="async">${renderMediaKindBadge('audio')}`
                : `<span class="collection-video-placeholder" aria-label="音频文件">🎵</span>${renderMediaKindBadge('audio')}`;
        }
    } else if (type.startsWith('video/')) {
        body = `<span class="collection-video-placeholder" aria-label="视频文件">🎬</span>${renderMediaKindBadge('video')}`;
    } else if (type.startsWith('audio/') || isAudioLike) {
        body = `<span class="collection-video-placeholder" aria-label="音频文件">🎵</span>${renderMediaKindBadge('audio')}`;
    }
    const isMoreTile = total > 4 && index === 3;
    const remaining = isMoreTile ? `<span class="collection-more">更多文件...<br>+${total - 3}</span>` : '';
    const externalBadge = externalSourceState.handleReadable
        ? '<span class="external-file-badge collection-external-file-badge" title="内容按需读取自供源设备的本机文件系统">🖴</span>'
        : '';
    const favoriteBadge = !isMoreTile && await isFileFavorite(fileInfo)
        ? '<span class="collection-file-favorite-badge" title="单文件收藏">★</span>'
        : '';
    const fileAttribute = isMoreTile ? 'data-collection-more="true"' : `data-collection-file-id="${escapeHtml(fileInfo.id || '')}"`;
    return `<div class="collection-preview-tile" ${fileAttribute} role="button" tabindex="0">${body}${favoriteBadge}${externalBadge}${remaining}</div>`;
}

async function renderCollectionPreviewHtml(message) {
    const files = getCollectionFiles(message);
    const visible = files.slice(0, Math.min(files.length, 4));
    const tiles = [];
    for (let index = 0; index < visible.length; index++) {
        tiles.push(await createCollectionTileHtml(visible[index], index, files.length));
    }
    const totalSize = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    const remark = String(message?.remark || message?.collection?.remark || '').trim();
    return `
        <div class="message-bubble collection-message">
            <div class="collection-preview">${tiles.join('')}</div>
            <div class="collection-meta">${files.length} 个文件 · ${formatFileSize(totalSize)}</div>
            ${remark ? `<div class="collection-remark">${renderRemarkHtml(remark)}</div>` : ''}
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
        messageEl.dataset.fileIsServerAsset = String(Boolean(message.fileInfo.isServerAsset));
        messageEl.dataset.fileServerAssetUrl = message.fileInfo.serverAssetUrl || '';
        messageEl.dataset.fileSourceChannel = message.fileInfo.sourceChannel || '';
        messageEl.dataset.fileSnsTaskId = message.fileInfo.snsTaskId || '';
        messageEl.dataset.fileSnsSourceUrl = message.fileInfo.snsSourceUrl || '';
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
        const isAudio = isAudioFileLike(null, fileInfo);

        // 检查是否是本地已存储的文件（刷新后从IndexedDB加载）
        let fileUrl = fileInfo.data || null;
        let storedFile = null;
        let externalSourceState = getExternalFileSourceState(null, null, fileInfo);

        if (fileInfo.id) {
            try {
                const persistedFile = await getFromStore('files', fileInfo.id);
                storedFile = persistedFile;
                if (persistedFile?.externalFileHandle) storedFile = await materializeExternalFileRecord(persistedFile);
                externalSourceState = getExternalFileSourceState(persistedFile, storedFile, fileInfo);

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
            const poster = storedFile ? getCachedMediaPosterOrQueue(storedFile, fileInfo) : '';
            contentHtml = `
                <div class="message-bubble">
                    <div class="media-preview">
                        ${poster
                            ? `<img src="${poster}" alt="${escapeHtml(fileInfo.name)}" loading="lazy" decoding="async">`
                            : `<span class="collection-video-placeholder" aria-label="视频文件">🎬</span>`}
                        ${renderMediaKindBadge('video')}
                    </div>
                    <div class="file-name media-file-name">${escapeHtml(fileInfo.name)}</div>
                    <div class="file-size media-file-size">${formatFileSize(fileInfo.size)}</div>
                </div>
            `;
        } else if (isAudio && fileUrl) {
            const poster = storedFile ? getCachedMediaPosterOrQueue(storedFile, fileInfo) : '';
            contentHtml = `
                <div class="message-bubble">
                    <div class="media-preview">
                        ${poster
                            ? `<img src="${poster}" alt="${escapeHtml(fileInfo.name)}" loading="lazy" decoding="async">`
                            : `<span class="collection-video-placeholder" aria-label="音频文件">🎵</span>`}
                        ${renderMediaKindBadge('audio')}
                    </div>
                    <div class="file-name media-file-name">${escapeHtml(fileInfo.name)}</div>
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
                    <div class="file-message-main">
                        <div class="file-icon">${getFileIcon(fileInfo.type)}</div>
                        <div class="file-info">
                            <div class="file-name">${escapeHtml(fileInfo.name)}</div>
                            <div class="file-size">${sizeStr}${!hasLocalData ? unavailableLabel : ''}</div>
                        </div>
                    </div>
                </div>
            `;
        }
        fileRenderState = {
            fileInfo,
            hasLocalData: Boolean(fileUrl),
            cacheCleared: Boolean(storedFile?.cacheCleared),
            restoreRequested: Boolean(storedFile?.restoreRequested),
            handleSourceOnly: externalSourceState.handleSourceOnly,
            handleReadable: externalSourceState.handleReadable
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
        const preview = getRichMessagePreviewText(message).slice(0, 100);
        const previewText = preview || '空富文本内容';
        contentHtml = `
            <div class="rich-preview" onclick="viewRichContent('${message.id}')">
                <div class="rich-preview-title">
                    <span>📝</span>
                    <span>富文本</span>
                </div>
                <div class="rich-preview-content ${preview ? '' : 'rich-preview-empty'}">${escapeHtml(previewText)}${preview.length >= 100 ? '...' : ''}</div>
            </div>
        `;
    }

    const fileRecordRemark = message.type === 'file'
        ? String(message.remark || message.fileInfo?.remark || '').trim()
        : '';
    messageEl.innerHTML = `
        <div class="message-header">
            <span>${message.senderName}</span>
            <span>${formatTime(message.timestamp)}</span>
        </div>
        ${contentHtml}
    `;
    syncTransferRecordFavoriteBadge(messageEl, message);
    syncTransferRecordSnsBadge(messageEl, message);
    if (fileRecordRemark) {
        const remark = document.createElement('div');
        remark.className = 'collection-remark';
        remark.innerHTML = renderRemarkHtml(fileRecordRemark);
        messageEl.querySelector('.message-bubble')?.appendChild(remark);
    }

    if (fileRenderState) {
        syncFileMessageExternalSourceBadge(messageEl, fileRenderState.handleReadable);
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
        isAsset: messageEl.dataset.fileIsAsset === 'true',
        isServerAsset: messageEl.dataset.fileIsServerAsset === 'true',
        serverAssetUrl: messageEl.dataset.fileServerAssetUrl || '',
        sourceChannel: messageEl.dataset.fileSourceChannel || '',
        snsTaskId: messageEl.dataset.fileSnsTaskId || '',
        snsSourceUrl: messageEl.dataset.fileSnsSourceUrl || ''
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

function syncFileMessageExternalSourceBadge(messageEl, handleReadable) {
    if (!messageEl) return;
    messageEl.querySelectorAll(':scope > .external-file-badge').forEach(badge => badge.remove());
    if (!handleReadable) return;
    const badge = document.createElement('span');
    badge.className = 'external-file-badge external-file-source-badge';
    badge.title = '本机原文件可直接读取，未占用浏览器文件缓存';
    badge.textContent = '💾 外部文件';
    messageEl.appendChild(badge);
}

function syncRenderedExternalFileSource(fileId, handleReadable) {
    document.querySelectorAll(`.message[data-file-id="${CSS.escape(fileId)}"]`)
        .forEach(messageEl => syncFileMessageExternalSourceBadge(messageEl, handleReadable));
}

function getTransferRecordAnchorUrl(messageId, sessionId = state.sessionId) {
    const url = new URL('/', window.location.origin);
    url.searchParams.set('record', messageId);
    url.hash = sessionId;
    return url.href;
}

function getTransferRecordDetailsUrl(messageId, sessionId = state.sessionId) {
    return `${window.location.origin}/record/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}`;
}

async function copyTransferRecordLink(messageId) {
    const copied = await copyTextToClipboard(getTransferRecordAnchorUrl(messageId)).catch(() => false);
    showAppToast(copied ? '锚点链接已复制，可通过该链接一键跳转到这条记录' : '复制失败，请从详情页手动复制链接');
}

function getTransferRecordTypeLabel(message) {
    if (message?.type === 'collection') return '文件合辑';
    if (message?.type === 'file') return '单文件';
    if (message?.type === 'rich') return '富文本';
    if (message?.type === 'text') return '文本消息';
    return message?.type || '未知类型';
}

async function getRecordFileDetail(fileInfo = {}) {
    const persistedFile = await getFromStore('files', fileInfo.id).catch(() => null);
    const readableFile = persistedFile?.externalFileHandle
        ? await materializeExternalFileRecord(persistedFile)
        : persistedFile;
    const sourceState = getExternalFileSourceState(persistedFile, readableFile, fileInfo);
    const recoveryStage = serverAssetRecoveries.stages.get(fileInfo.id);
    let cacheStatus = '本机无缓存';
    if (recoveryStage?.label) cacheStatus = recoveryStage.label;
    else if (sourceState.handleReadable) cacheStatus = '本机原文件句柄有效';
    else if (hasCompleteFileCache(persistedFile, fileInfo)) cacheStatus = '浏览器缓存完整';
    else if (persistedFile?.restoreRequested) cacheStatus = '正在请求还原';
    else if (persistedFile?.isPartial || persistedFile?.transferInterrupted) cacheStatus = '传输中断或存在分片';
    else if (persistedFile?.cacheCleared) cacheStatus = '缓存已释放';
    return { fileInfo, cacheStatus, sourceState };
}

function closeTransferRecordDetails(options = {}) {
    const overlay = document.getElementById('transferRecordDetailsLayer');
    if (!overlay) return;
    overlay.remove();
    if (options.keepRoute !== true && /^\/record\//.test(window.location.pathname)) {
        history.replaceState(null, '', getTransferRecordAnchorUrl(overlay.dataset.messageId, state.sessionId));
    }
}

async function showTransferRecordDetails(messageId) {
    const message = await getFromStore('messages', messageId).catch(() => null);
    if (!message) throw new Error('目标传输记录尚未同步到本机');
    closeTransferRecordDetails({ keepRoute: true });

    const fileInfos = message.type === 'collection'
        ? getCollectionFiles(message)
        : (message.fileInfo?.id ? [message.fileInfo] : []);
    const fileDetails = [];
    for (const fileInfo of fileInfos) fileDetails.push(await getRecordFileDetail(fileInfo));
    const sender = {
        deviceId: message.sender || fileInfos[0]?.ownerDeviceId || '',
        name: message.senderName || fileInfos[0]?.senderName || '未知设备'
    };
    const senderName = getDeviceDisplayName(sender);
    const overlay = document.createElement('div');
    overlay.id = 'transferRecordDetailsLayer';
    overlay.className = 'transfer-record-details-layer';
    overlay.dataset.messageId = message.id;
    overlay.innerHTML = `
        <section class="transfer-record-details-panel" role="dialog" aria-modal="true" aria-labelledby="transferRecordDetailsTitle">
            <header class="transfer-record-details-header">
                <div>
                    <span class="transfer-record-details-kicker">${escapeHtml(getTransferRecordTypeLabel(message))}</span>
                    <h2 id="transferRecordDetailsTitle">传输记录详情</h2>
                </div>
                <button type="button" class="transfer-record-details-close" aria-label="关闭">×</button>
            </header>
            <div class="transfer-record-details-body">
                <dl class="transfer-record-details-summary">
                    <div><dt>记录 ID</dt><dd>${escapeHtml(message.id)}</dd></div>
                    <div><dt>关联隧道</dt><dd>${escapeHtml(state.shortCode || state.sessionId)}${state.sessionRemark ? ` · ${escapeHtml(state.sessionRemark)}` : ''}</dd></div>
                    <div><dt>发送者</dt><dd>${escapeHtml(senderName)}${sender.deviceId ? ` · ${escapeHtml(sender.deviceId)}` : ''}</dd></div>
                    <div><dt>发送时间</dt><dd>${escapeHtml(formatDateTime(message.timestamp || Date.now()))}</dd></div>
                    <div><dt>备注</dt><dd>${escapeHtml(String(message.remark || message.collection?.remark || '无'))}</dd></div>
                </dl>
                ${message.type === 'text' ? `<section class="transfer-record-details-content"><h3>消息内容</h3><p>${escapeHtml(message.text || '')}</p></section>` : ''}
                ${message.type === 'rich' ? `<section class="transfer-record-details-content"><h3>富文本摘要</h3><p>${escapeHtml(String(message.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000))}</p></section>` : ''}
                ${fileDetails.length ? `<section class="transfer-record-details-files"><h3>文件信息 · ${fileDetails.length}</h3>${fileDetails.map((entry, index) => `
                    <article class="transfer-record-detail-file">
                        <strong>${index + 1}. ${escapeHtml(entry.fileInfo.name || '未知文件')}</strong>
                        <span>${escapeHtml(entry.fileInfo.type || 'application/octet-stream')} · ${formatFileSize(Number(entry.fileInfo.size) || 0)}</span>
                        <span>缓存状态：${escapeHtml(entry.cacheStatus)}</span>
                        <span>文件 ID：${escapeHtml(entry.fileInfo.id || '-')}</span>
                    </article>`).join('')}</section>` : ''}
                ${renderSnsMediaSection(message)}
                ${renderSnsAcquisitionSection(message)}
                <details class="transfer-record-raw-details"><summary>记录元数据</summary><pre>${escapeHtml(JSON.stringify(message, (key, value) => key === 'data' ? '[binary omitted]' : value, 2))}</pre></details>
            </div>
            <footer class="transfer-record-details-actions">
                <button type="button" data-record-locate>定位到记录</button>
                <button type="button" data-record-copy>复制记录链接</button>
            </footer>
        </section>`;
    overlay.querySelector('.transfer-record-details-close').addEventListener('click', () => closeTransferRecordDetails());
    overlay.querySelector('[data-record-copy]').addEventListener('click', () => copyTransferRecordLink(message.id));
    overlay.querySelector('[data-record-locate]').addEventListener('click', async () => {
        closeTransferRecordDetails();
        await focusTransferRecordById(message.id, { timeoutMs: 5000 });
    });
    overlay.querySelectorAll('[data-sns-fetch]').forEach(button => {
        button.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            button.disabled = true;
            button.textContent = '获取中...';
            try {
                await requestSnsMediaContent(message.id, button.dataset.snsFetch);
                await showTransferRecordDetails(message.id);
            } catch (err) {
                button.disabled = false;
                button.textContent = '获取文件内容';
                showAppToast(`获取SNS媒体失败：${err.message}`);
            }
        });
    });
    overlay.querySelectorAll('[data-sns-locate]').forEach(button => {
        button.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            closeTransferRecordDetails();
            await focusTransferRecordById(button.dataset.snsLocate, { timeoutMs: 8000 });
        });
    });
    overlay.querySelectorAll('[data-sns-source-locate]').forEach(button => {
        button.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            closeTransferRecordDetails();
            await focusTransferRecordById(button.dataset.snsSourceLocate, { timeoutMs: 8000 });
        });
    });
    overlay.addEventListener('click', event => {
        if (event.target === overlay) closeTransferRecordDetails();
    });
    document.body.appendChild(overlay);
    await refreshSnsMediaClientStates(overlay, message);
}

function getSnsMediaStatusLabel(item = {}) {
    if (item.serverState === 'fetching') {
        const progress = Math.max(0, Math.min(100, Number(item.serverProgress) || 0));
        const stages = {
            queued: '等待服务器处理',
            parsing: '正在解析',
            fetching_song: '正在获取歌曲',
            fetching_video: '正在获取视频',
            processing_cover: '正在处理封面',
            writing_metadata: '正在写入元数据',
            creating_collection: '正在创建合辑'
        };
        const stage = stages[item.serverStage] || '服务器获取中';
        const showProgress = item.serverStage === 'fetching_song' || item.serverStage === 'fetching_video';
        return showProgress ? `${stage} · ${Math.round(progress)}%` : stage;
    }
    if (item.serverState === 'ready') {
        const label = item.mediaKind === 'song' ? '已获取歌曲' : '已生成文件记录';
        return item.resultFileName ? `${label} · ${item.resultFileName}` : label;
    }
    if (item.serverState === 'failed') return `获取失败：${item.serverError || '未知错误'}`;
    return '等待获取文件内容';
}

function renderSnsMediaItemHtml(item = {}) {
    const staleFetching = item.serverState === 'fetching' && Date.now() - (Number(item.updatedAt) || 0) > 2 * 60 * 1000;
    const canFetch = !item.serverState || item.serverState === 'not_fetched' || item.serverState === 'failed' || staleFetching;
    const isFetching = item.serverState === 'fetching';
    const progress = Math.max(0, Math.min(100, Number(item.serverProgress) || 0));
    return `
        <article class="sns-media-item" data-sns-media-item-id="${escapeHtml(item.id || '')}">
            ${item.coverUrl ? `<img class="sns-media-cover" src="${escapeHtml(item.coverUrl)}" alt="">` : '<div class="sns-media-cover sns-media-cover-empty">SNS</div>'}
            <div class="sns-media-main">
                <strong>${escapeHtml(item.title || 'SNS 媒体文件')}</strong>
                ${item.mediaKind ? `<span>${escapeHtml(item.mediaKind === 'song' ? '歌曲' : item.mediaKind === 'video' ? '视频' : '暂不支持')}</span>` : ''}
                <a href="${escapeHtml(item.mediaUrl || item.sourceUrl || '#')}" target="_blank" rel="noopener">${escapeHtml(item.mediaUrl || item.sourceUrl || '')}</a>
                <span>${escapeHtml(getSnsMediaStatusLabel(item))}</span>
                ${item.generatedMessageId ? `<span class="sns-media-client-state"><span aria-hidden="true">💻</span><span data-sns-client-state="${escapeHtml(item.id || '')}">本机无缓存</span></span>` : ''}
                ${isFetching ? `<div class="sns-media-progress"><i style="width:${progress}%"></i></div>` : ''}
                <div class="sns-media-actions">
                    ${canFetch ? `<button type="button" data-sns-fetch="${escapeHtml(item.id || '')}">获取文件内容</button>` : ''}
                    ${item.generatedMessageId ? `<button type="button" data-sns-locate="${escapeHtml(item.generatedMessageId)}">定位生成的文件记录</button>` : ''}
                </div>
            </div>
        </article>`;
}

async function refreshSnsMediaClientStates(container, message) {
    const items = Array.isArray(message?.snsMediaItems) ? message.snsMediaItems : [];
    for (const item of items) {
        if (!item?.generatedMessageId) continue;
        const target = container?.querySelector?.(`[data-sns-client-state="${cssEscape(item.id)}"]`);
        if (!target) continue;
        const generated = await getFromStore('messages', item.generatedMessageId).catch(() => null);
        if (!generated) {
            target.textContent = '本机无缓存';
            continue;
        }
        const files = generated.type === 'collection' ? getCollectionFiles(generated) : [generated.fileInfo].filter(Boolean);
        const stored = await Promise.all(files.map(file => getFromStore('files', file.id).catch(() => null)));
        const completeCount = stored.filter((file, index) => hasCompleteFileCache(file, files[index])).length;
        const recoveryStage = files.map(file => serverAssetRecoveries.stages.get(file.id)).find(Boolean);
        const downloading = files.some(file => serverAssetRecoveries.promises.has(file.id) || fileAssetTransfer?.hasDownloadWork?.(file.id));
        const partial = stored.some(file => file?.isPartial || file?.transferInterrupted);
        const released = stored.length > 0 && stored.every(file => file?.cacheCleared);
        const status = completeCount === files.length && files.length
            ? '浏览器缓存完整'
            : recoveryStage?.label || (downloading
                ? '正在请求还原'
                : partial
                    ? '传输中断或存在分片'
                    : released
                        ? '缓存已释放'
                        : completeCount
                            ? '传输中断或存在分片'
                            : '本机无缓存');
        target.textContent = status;
    }
}

function refreshOpenSnsMediaClientStates() {
    const overlay = document.getElementById('transferRecordDetailsLayer');
    if (!overlay?.dataset.messageId) return;
    getFromStore('messages', overlay.dataset.messageId)
        .then(message => message && refreshSnsMediaClientStates(overlay, message))
        .catch(() => {});
}

function renderSnsAcquisitionSection(message = {}) {
    const acquisition = message.snsAcquisition;
    if (!acquisition?.sourceMessageId) return '';
    const sourceLabel = acquisition.source === 'ytmusic'
        ? 'YouTube Music'
        : acquisition.source === 'youtube'
            ? 'YouTube'
            : String(acquisition.source || 'SNS').toUpperCase();
    return `
        <section class="transfer-record-details-sns">
            <h3>来源为 ${escapeHtml(sourceLabel)} 获取</h3>
            <div class="sns-media-main">
                <a href="${escapeHtml(acquisition.sourceUrl || '#')}" target="_blank" rel="noopener">${escapeHtml(acquisition.sourceUrl || '')}</a>
                <span>${escapeHtml(acquisition.mediaKind === 'song' ? '歌曲合辑' : '视频文件')}</span>
                <div class="sns-media-actions">
                    <button type="button" data-sns-source-locate="${escapeHtml(acquisition.sourceMessageId)}">定位原始链接记录</button>
                </div>
            </div>
        </section>`;
}

function renderSnsMediaSection(message = {}) {
    if (message.snsAcquisition) return '';
    const items = Array.isArray(message.snsMediaItems) ? message.snsMediaItems.filter(item => item?.id) : [];
    const sources = Array.isArray(message.snsSources) ? message.snsSources.filter(source => source?.id) : [];
    if (!items.length && !sources.length) return '';
    const itemsBySource = new Map();
    items.forEach(item => {
        const list = itemsBySource.get(item.sourceId) || [];
        list.push(item);
        itemsBySource.set(item.sourceId, list);
    });
    const renderedSources = sources.map(source => {
        const sourceItems = itemsBySource.get(source.id) || [];
        const isCollection = source.sourceType === 'collection' || sourceItems.length > 1;
        const body = sourceItems.map(renderSnsMediaItemHtml).join('') ||
            `<p class="sns-media-empty">${source.parseStatus === 'failed' ? `解析失败：${escapeHtml(source.parseError || '')}` : '正在识别媒体文件...'}</p>`;
        if (!isCollection) return body;
        return `
            <details class="sns-media-source" open>
                <summary>${escapeHtml(source.title || source.sourceUrl || 'SNS 列表')}</summary>
                ${body}
            </details>`;
    }).join('');
    const orphanItems = items
        .filter(item => !sources.some(source => source.id === item.sourceId))
        .map(renderSnsMediaItemHtml)
        .join('');
    return `
        <section class="transfer-record-details-sns">
            <h3>SNS媒体文件</h3>
            ${renderedSources}${orphanItems}
        </section>`;
}

function emitSocketWithAck(eventName, payload, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        if (!state.socket?.connected) return reject(new Error('socket-not-connected'));
        state.socket.timeout(timeoutMs).emit(eventName, payload, (err, response) => {
            if (err) return reject(err);
            resolve(response);
        });
    });
}

async function requestSnsMediaContent(messageId, mediaItemId) {
    if (!state.socket?.connected) throw new Error('socket-not-connected');
    showAppToast('已开始获取SNS媒体文件内容');
    const result = await emitSocketWithAck('sns-media-fetch', {
        sessionId: state.sessionId,
        messageId,
        mediaItemId
    }, 10000);
    if (!result?.ok) throw new Error(result?.error || 'sns-media-fetch-failed');
    showAppToast('SNS媒体文件获取任务已启动');
    return result.item;
}

function renderMessageRecordActions(messageEl, message) {
    messageEl.querySelector('.message-record-actions')?.remove();
    const actions = document.createElement('div');
    actions.className = 'message-record-actions';
    const menuItems = [];
    menuItems.push(createFileActionButton('详情', '查看这条传输记录的完整信息', () => {
        showTransferRecordDetails(message.id).catch(err => showAppToast(`详情加载失败：${err.message}`));
    }));
    menuItems.push(createFileActionButton('复制此锚点', '复制可直接定位到此记录的链接', () => {
        copyTransferRecordLink(message.id);
    }));
    menuItems.push(createFileActionButton(message.favorite ? '★ 取消收藏' : '☆ 收藏', message.favorite ? '从已收藏中移除此记录' : '将此传输记录加入已收藏', () => {
        toggleTransferRecordFavorite(message.id).catch(err => {
            alert(`收藏状态保存失败：${err.message}`);
        });
    }));
    if (message.type === 'file' || message.type === 'collection') {
        menuItems.push(createFileActionButton('备注', '添加或修改这条文件记录的备注', () => {
            editTransferRecordRemark(message.id).catch(err => {
                alert(`备注保存失败：${err.message}`);
            });
        }));
    }
    if (message.type === 'file' || message.type === 'collection') {
        menuItems.push(createFileActionButton('✴↗ 使用光媒分享', message.type === 'collection' ? '将整个合辑作为可恢复光媒任务分享' : '将当前文件通过动态二维码分享', () => {
            shareHistoryMessageViaLight(message.id).catch(err => {
                alert(`光媒分享失败：${err.message}`);
                historyLog('light-share-record-failed', { messageId: message.id, error: err.message });
            });
        }));
    }
    menuItems.push(createFileActionButton('⎇ 发到其他隧道', '将这条传输记录转发到另一个隧道', () => {
        forwardHistoryMessage(message.id).catch(err => {
            alert(`转发失败：${err.message}`);
            historyLog('history-message-forward-failed', { messageId: message.id, error: err.message });
        });
    }));
    menuItems.push(createFileActionButton('删除', '从会话中删除此记录', () => {
        deleteHistoryMessage(message.id);
    }));
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'message-record-menu-trigger';
    trigger.textContent = '☰';
    trigger.title = '记录操作';
    trigger.setAttribute('aria-label', '打开传输记录操作菜单');
    trigger.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openMessageRecordActionMenu(trigger, menuItems);
    });
    actions.appendChild(trigger);
    messageEl.appendChild(actions);
}

async function toggleTransferRecordFavorite(messageId) {
    const message = await getFromStore('messages', messageId);
    if (!message) throw new Error('record-not-found');
    const favorite = !message.favorite;
    const updated = { ...message, favorite, favoritedAt: favorite ? Date.now() : 0 };
    await updateHistoryMessage(updated);
    const messageEl = getMessageElement(messageId);
    if (messageEl) {
        syncTransferRecordFavoriteBadge(messageEl, updated);
        renderMessageRecordActions(messageEl, updated);
    }
    showAppToast(favorite ? '已加入已收藏' : '已取消收藏');
}

function syncTransferRecordFavoriteBadge(messageEl, message) {
    if (!messageEl) return;
    messageEl.querySelector('.message-record-favorite-badge')?.remove();
    messageEl.classList.toggle('message-record-favorite', message?.favorite === true);
    if (message?.favorite !== true) return;
    const header = messageEl.querySelector('.message-header');
    if (!header) return;
    const badge = document.createElement('span');
    badge.className = 'message-record-favorite-badge';
    badge.textContent = '★';
    badge.title = '记录收藏';
    header.appendChild(badge);
}

function syncTransferRecordSnsBadge(messageEl, message) {
    if (!messageEl) return;
    messageEl.querySelector('.message-record-sns-badge')?.remove();
    const mediaItems = Array.isArray(message?.snsMediaItems) ? message.snsMediaItems : [];
    const hasSnsMedia = !message?.snsAcquisition && mediaItems.some(item => item?.id && item?.mediaKind !== 'unsupported');
    messageEl.classList.toggle('message-record-sns', hasSnsMedia);
    if (!hasSnsMedia) return;
    const header = messageEl.querySelector('.message-header');
    if (!header) return;
    const badge = document.createElement('span');
    badge.className = 'message-record-sns-badge';
    badge.textContent = '◉ SNS';
    badge.title = '此记录包含可获取的 SNS 媒体';
    header.appendChild(badge);
}

async function isFileFavorite(fileInfo = {}) {
    if (!fileInfo?.id) return false;
    if (getFavoriteMusicIds().has(fileInfo.id)) return true;
    const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
    return storedFile?.mediaFavorite === true;
}

async function setSingleFileFavorite(fileInfo, favorite) {
    if (!fileInfo?.id) return;
    const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
    if (storedFile?.id) {
        await saveToStore('files', { ...storedFile, mediaFavorite: Boolean(favorite) });
    }
    if (isAudioFileLike(storedFile, fileInfo)) {
        const ids = getFavoriteMusicIds();
        if (favorite) ids.add(fileInfo.id);
        else ids.delete(fileInfo.id);
        saveFavoriteMusicIds(ids);
        renderMusicPlayerActions();
    }
    await refreshFileFavoriteBadges(fileInfo.id);
    showAppToast(favorite ? '已加入单文件收藏' : '已取消单文件收藏');
}

async function toggleSingleFileFavorite(fileInfo) {
    const favorite = await isFileFavorite(fileInfo);
    await setSingleFileFavorite(fileInfo, !favorite);
}

async function refreshFileFavoriteBadges(fileId) {
    if (!fileId) return;
    const favorite = await isFileFavorite({ id: fileId });
    document.querySelectorAll(`.collection-file-card[data-file-id="${CSS.escape(fileId)}"], .collection-preview-tile[data-collection-file-id="${CSS.escape(fileId)}"]`).forEach(card => {
        syncCollectionFileFavoriteBadge(card, favorite);
    });
}

function syncCollectionFileFavoriteBadge(card, favorite) {
    const target = card?.querySelector?.('.collection-file-thumb') || card;
    if (!target) return;
    target.querySelector('.collection-file-favorite-badge')?.remove();
    card.classList.toggle('collection-file-card--favorite', favorite === true);
    if (!favorite) return;
    const badge = document.createElement('span');
    badge.className = 'collection-file-favorite-badge';
    badge.textContent = '★';
    badge.title = '单文件收藏';
    target.appendChild(badge);
}

function openMessageRecordActionMenu(trigger, menuItems) {
    document.querySelector('.message-record-action-menu-layer')?.remove();
    const layer = document.createElement('div');
    layer.className = 'message-record-action-menu-layer';
    const menu = document.createElement('div');
    menu.className = 'message-record-action-menu';
    menu.setAttribute('role', 'menu');
    const handle = document.createElement('div');
    handle.className = 'message-record-action-menu-handle';
    handle.setAttribute('aria-hidden', 'true');
    menu.appendChild(handle);
    menuItems.forEach(item => menu.appendChild(item));
    layer.appendChild(menu);
    document.body.appendChild(layer);

    const close = () => layer.remove();
    menu.addEventListener('click', event => {
        if (event.target.closest('.history-action')) close();
    }, true);
    layer.addEventListener('click', event => {
        if (event.target === layer) close();
    });
    layer.addEventListener('contextmenu', event => event.preventDefault());

    if (!window.matchMedia('(max-width: 767px)').matches) {
        const rect = trigger.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const left = Math.min(window.innerWidth - menuRect.width - 8, Math.max(8, rect.right - menuRect.width));
        const preferredTop = rect.bottom + 5;
        const top = preferredTop + menuRect.height <= window.innerHeight - 8
            ? preferredTop
            : Math.max(8, rect.top - menuRect.height - 5);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }

    let dragPointerId = null;
    let dragStartY = 0;
    let dragDistance = 0;
    handle.addEventListener('pointerdown', event => {
        if (!window.matchMedia('(max-width: 767px)').matches) return;
        dragPointerId = event.pointerId;
        dragStartY = event.clientY;
        dragDistance = 0;
        handle.setPointerCapture?.(dragPointerId);
        menu.style.transition = 'none';
        event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
        if (event.pointerId !== dragPointerId) return;
        dragDistance = Math.max(0, event.clientY - dragStartY);
        menu.style.transform = `translateY(${dragDistance}px)`;
        event.preventDefault();
    });
    const finishDrag = event => {
        if (event.pointerId !== dragPointerId) return;
        handle.releasePointerCapture?.(dragPointerId);
        dragPointerId = null;
        menu.style.transition = 'transform 180ms cubic-bezier(.22, .61, .36, 1)';
        if (dragDistance >= 56) {
            menu.style.transform = 'translateY(105%)';
            layer.style.background = 'transparent';
            setTimeout(close, 180);
        } else {
            menu.style.transform = '';
        }
        dragDistance = 0;
        event.preventDefault();
    };
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
}

async function editTransferRecordRemark(messageId) {
    const message = await getFromStore('messages', messageId);
    if (!message || !['file', 'collection'].includes(message.type)) return;
    const current = String(message.remark || message.collection?.remark || '');
    const next = await openTransferRecordRemarkEditor(current);
    if (next === null) return;
    const remark = next.trim().slice(0, RECORD_REMARK_MAX_LENGTH);
    const updated = { ...message, remark };
    if (updated.type === 'collection') updated.collection = { ...updated.collection, remark };
    await updateHistoryMessage(updated);
}

function openTransferRecordRemarkEditor(current = '') {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'send-mode-overlay record-remark-editor-layer';
        overlay.innerHTML = `
            <section class="send-mode-dialog record-remark-editor" role="dialog" aria-modal="true" aria-labelledby="recordRemarkEditorTitle">
                <h3 id="recordRemarkEditorTitle">传输记录备注</h3>
                <p>备注会随这条文件记录同步；留空保存即可删除备注。</p>
                <textarea maxlength="${RECORD_REMARK_MAX_LENGTH}" rows="5" placeholder="填写备注内容"></textarea>
                <div class="record-remark-editor-count">0 / ${RECORD_REMARK_MAX_LENGTH}</div>
                <div class="send-mode-actions">
                    <button class="btn btn-secondary" type="button" data-remark-cancel>取消</button>
                    <button class="btn btn-primary" type="button" data-remark-save>保存</button>
                </div>
            </section>`;
        const input = overlay.querySelector('textarea');
        const count = overlay.querySelector('.record-remark-editor-count');
        input.value = current;
        const syncCount = () => { count.textContent = `${input.value.length} / ${RECORD_REMARK_MAX_LENGTH}`; };
        syncCount();
        input.addEventListener('input', syncCount);
        const finish = value => {
            overlay.remove();
            resolve(value);
        };
        overlay.addEventListener('click', event => {
            if (event.target === overlay || event.target.closest('[data-remark-cancel]')) finish(null);
            if (event.target.closest('[data-remark-save]')) finish(input.value);
        });
        input.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') finish(input.value);
            if (event.key === 'Escape') finish(null);
        });
        document.body.appendChild(overlay);
        requestAnimationFrame(() => input.focus({ preventScroll: true }));
    });
}

async function chooseForwardTargetSession() {
    const sessions = (await getAllFromStore('sessions').catch(() => []))
        .filter(session => session?.sessionId && session.sessionId !== state.sessionId)
        .sort((left, right) => String(left.sessionId).localeCompare(String(right.sessionId), undefined, { numeric: true }));
    const lastTargetSessionId = localStorage.getItem(LAST_FORWARD_SESSION_STORAGE_KEY) || '';
    if (!sessions.length) throw new Error('本机没有可转发的其他隧道');
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'send-mode-overlay';
        const options = sessions.map(session => {
            const label = String(session.remark || session.shortCode || session.sessionId).trim();
            return `<option value="${escapeHtml(session.sessionId)}">${escapeHtml(label)} · ${escapeHtml(session.shortCode || session.sessionId.slice(0, 8))}</option>`;
        }).join('');
        overlay.innerHTML = `<div class="send-mode-dialog" role="dialog" aria-modal="true">
            <h3>发到其他隧道</h3>
            <select class="forward-session-select">${options}</select>
            <div class="send-mode-actions">
                <button class="btn btn-secondary" type="button" data-forward-cancel>取消</button>
                <button class="btn btn-primary" type="button" data-forward-confirm>转发</button>
            </div>
        </div>`;
        const finish = value => { overlay.remove(); resolve(value); };
        overlay.addEventListener('click', event => {
            if (event.target === overlay || event.target.closest('[data-forward-cancel]')) finish('');
            if (event.target.closest('[data-forward-confirm]')) finish(overlay.querySelector('.forward-session-select')?.value || '');
        });
        document.body.appendChild(overlay);
        const select = overlay.querySelector('.forward-session-select');
        if (select && sessions.some(session => session.sessionId === lastTargetSessionId)) {
            select.value = lastTargetSessionId;
        }
    });
}

async function cloneForwardFileInfo(fileInfo, targetSessionId) {
    const nextId = generateId();
    const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
    if (storedFile) {
        const nextStored = {
            ...storedFile,
            id: nextId,
            sessionId: state.sessionId,
            ownerDeviceId: state.deviceId,
            timestamp: Date.now()
        };
        await saveToStore('files', nextStored);
        if (hasCompleteFileCache(nextStored, fileInfo)) await fileAssetTransfer?.announce?.(nextStored);
    }
    return {
        ...fileInfo,
        id: nextId,
        ownerDeviceId: state.deviceId,
        sender: state.deviceId,
        isAsset: true,
        backupSourceSessionId: state.sessionId,
        forwardedToSessionId: targetSessionId,
        timestamp: Date.now()
    };
}

async function forwardHistoryMessage(messageId) {
    const source = await getFromStore('messages', messageId);
    if (!source) throw new Error('找不到原传输记录');
    const targetSessionId = await chooseForwardTargetSession();
    if (!targetSessionId) return;
    localStorage.setItem(LAST_FORWARD_SESSION_STORAGE_KEY, targetSessionId);
    const message = {
        ...source,
        id: generateId(),
        sessionId: targetSessionId,
        timestamp: Date.now(),
        sender: state.deviceId,
        senderName: state.deviceName,
        forwardedFrom: { sessionId: state.sessionId, messageId: source.id }
    };
    if (source.type === 'file' && source.fileInfo?.id) {
        message.fileInfo = await cloneForwardFileInfo(source.fileInfo, targetSessionId);
    } else if (source.type === 'collection') {
        const files = [];
        for (const fileInfo of getCollectionFiles(source)) files.push(await cloneForwardFileInfo(fileInfo, targetSessionId));
        message.collection = {
            ...source.collection,
            id: generateId(),
            files,
            count: files.length,
            totalSize: files.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
        };
    }
    await new Promise((resolve, reject) => {
        state.socket.timeout(10000).emit('forward-message', { targetSessionId, message }, (err, response) => {
            if (err) return reject(new Error('服务器响应超时'));
            if (!response?.ok) return reject(new Error(response?.error || '服务器拒绝转发'));
            resolve(response);
        });
    });
    await saveToStore('messages', message);
    showAppToast('已转发到所选隧道');
    historyLog('history-message-forwarded', { messageId, targetMessageId: message.id, targetSessionId });
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
let activeFilePreviewStoredFile = null;
let activeFilePreviewObjectUrl = '';
let filePreviewOpenTask = null;
let remotePreviewSelection = null;
let remotePreviewControl = null;
let activeRemotePreviewControl = null;
let remotePreviewBubbleDrag = null;
let remotePreviewBubblePosition = null;
let remotePreviewBubbleSuppressClick = false;
const incomingRemotePreviewRequests = new Map();

function runExclusiveFilePreviewOpen(task, details = {}) {
    if (filePreviewOpenTask) return filePreviewOpenTask;
    filePreviewOpenTask = Promise.resolve()
        .then(task)
        .catch(err => {
            historyLog('file-preview-exclusive-open-failed', { ...details, error: err.message });
        })
        .finally(() => {
            requestAnimationFrame(() => { filePreviewOpenTask = null; });
        });
    return filePreviewOpenTask;
}

const musicPlayer = {
    audio: null,
    queue: [],
    currentIndex: -1,
    currentTrackId: '',
    overlay: null,
    queueOpen: false,
    queueHistoryOpen: false,
    queueDrag: null,
    pendingQueueExitAction: '',
    libraryFillPending: false,
    libraryFillPromise: null,
    libraryFillExhaustedAt: 0,
    mediaSessionReady: false,
    historyOpen: false,
    closeAfterHistory: false,
    tempAudio: null,
    tempResumeBackground: false,
    tempPreviewFileId: '',
    previewControls: null,
    miniEnabled: false,
    progressTimer: null,
    lastTrackIntentAt: 0
};
const musicPlayerPosterHydratingIds = new Set();
const musicPlayerDurationHydratingIds = new Set();
const audioPosterHydrationPromises = new Map();

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
    stopTemporaryAudioPreview();
    musicPlayer.previewControls = null;
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
    activeFilePreviewStoredFile = null;
    activeFilePreviewObjectUrl = '';
    musicPlayer.previewControls = null;
    setFilePreviewFullscreenButton(false);
    setFilePreviewLightShareButton(false);
    setFilePreviewMusicButton(false);
    setFilePreviewRemoteButton(false);
    viewer.classList.remove('active');
    filePreviewPointerStart = null;
    const content = document.getElementById('filePreviewContent');
    content?.replaceChildren();
    resetFilePreviewContentStage(content);
    document.getElementById('filePreviewActions')?.replaceChildren();
    if (shouldGoBack) history.back();
}

function replaceCurrentHistoryWithoutPreviewLayers() {
    const current = history.state && typeof history.state === 'object' ? history.state : {};
    if (!current[FILE_PREVIEW_HISTORY_KEY] && !current[MEDIA_FULLSCREEN_HISTORY_KEY] && !current.filePreviewStage) return;
    const next = { ...current };
    delete next[FILE_PREVIEW_HISTORY_KEY];
    delete next[MEDIA_FULLSCREEN_HISTORY_KEY];
    delete next.filePreviewStage;
    history.replaceState(next, '', window.location.href);
    suppressNextFilePreviewPopstate = false;
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
    return isPreviewableFileType(type);
}

function setFilePreviewFullscreenButton(visible) {
    const button = document.getElementById('filePreviewFullscreenBtn');
    if (!button) return;
    button.hidden = !visible;
    button.disabled = !visible;
}

function setFilePreviewMusicButton(visible) {
    const button = document.getElementById('filePreviewMusicBtn');
    if (!button) return;
    button.hidden = !visible;
    button.disabled = !visible;
}

function setFilePreviewRemoteButton(visible) {
    const button = document.getElementById('filePreviewRemoteBtn');
    if (!button) return;
    button.hidden = !visible;
    button.disabled = !visible;
}

function createRemotePreviewRequestId() {
    return globalThis.crypto?.randomUUID?.() || generateId();
}

function remotePreviewStatusText(entry) {
    if (entry.status === 'checking') return '正在检测目标设备的完整缓存…';
    if (entry.status === 'available') return '已确认完整缓存，可以远程打开';
    if (entry.status === 'opening') return '正在目标设备打开并进入全屏…';
    const reason = ({
        offline:'设备已离线',
        'not-previewable':'该文件不能预览',
        'cache-incomplete':'目标设备没有完整缓存',
        'target-unavailable':'设备不在当前隧道或已离线',
        'cache-verification-required':'缓存验证已失效',
        'preview-open-failed':'目标设备打开预览失败',
        'fullscreen-open-failed':'目标设备进入全屏失败',
        'open-timeout':'目标设备打开超时'
    }[entry.reason]);
    return reason || '目标设备不可用';
}

function renderRemotePreviewDeviceList() {
    const list = document.getElementById('remotePreviewDeviceList');
    if (!list) return;
    list.replaceChildren();
    const entries = Array.from(remotePreviewSelection?.devices?.values?.() || []);
    if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'remote-preview-device-empty';
        empty.textContent = '当前隧道没有其他在线客户端设备';
        list.appendChild(empty);
        return;
    }
    entries.forEach(entry => {
        const row = document.createElement('div');
        row.className = 'remote-preview-device-row';
        const detail = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'remote-preview-device-name';
        name.textContent = getDeviceDisplayName(entry.device);
        const status = document.createElement('div');
        status.className = `remote-preview-device-status ${entry.status === 'available' ? 'available' : (entry.status === 'unavailable' ? 'unavailable' : '')}`;
        status.textContent = remotePreviewStatusText(entry);
        detail.append(name, status);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-primary';
        button.textContent = entry.status === 'opening'
            ? '打开中…'
            : (entry.status === 'unavailable' ? '重新检测' : '在此设备打开');
        button.disabled = entry.status === 'checking' || entry.status === 'opening';
        button.addEventListener('click', () => {
            if (entry.status === 'available') requestRemotePreviewOpen(entry);
            else if (entry.status === 'unavailable') beginRemotePreviewCacheCheck(entry);
        });
        row.append(detail, button);
        list.appendChild(row);
    });
}

function updateRemotePreviewEntry(requestId, update) {
    if (!remotePreviewSelection) return null;
    const entry = Array.from(remotePreviewSelection.devices.values()).find(item => item.requestId === requestId);
    if (!entry) return null;
    clearTimeout(entry.timer);
    Object.assign(entry, update);
    renderRemotePreviewDeviceList();
    return entry;
}

function closeRemotePreviewDeviceModal() {
    const modal = document.getElementById('remotePreviewDeviceModal');
    if (modal?.open && typeof modal.close === 'function') modal.close();
    modal?.removeAttribute('open');
    modal?.classList.remove('active');
    for (const entry of remotePreviewSelection?.devices?.values?.() || []) clearTimeout(entry.timer);
    remotePreviewSelection = null;
}

function showRemotePreviewDeviceModal() {
    const modal = document.getElementById('remotePreviewDeviceModal');
    if (!modal) return;
    document.body.appendChild(modal);
    if (typeof modal.showModal === 'function') {
        if (!modal.open) modal.showModal();
        return;
    }
    modal.setAttribute('open', '');
    modal.classList.add('active');
}

function requestRemotePreviewOpen(entry) {
    if (!remotePreviewSelection || entry.status !== 'available' || !state.socket?.connected) return;
    const requestId = entry.requestId;
    entry.status = 'opening';
    renderRemotePreviewDeviceList();
    entry.timer = setTimeout(() => {
        const current = updateRemotePreviewEntry(requestId, { status:'unavailable', reason:'open-timeout' });
        if (current) setTimeout(() => beginRemotePreviewCacheCheck(current), 500);
    }, 15_000);
    state.socket.emit('remote-preview-open', { requestId, to: entry.deviceId }, result => {
        if (result?.ok) return;
        const current = updateRemotePreviewEntry(requestId, { status:'unavailable', reason:result?.reason || 'target-unavailable' });
        if (current && result?.reason === 'cache-verification-required') {
            setTimeout(() => beginRemotePreviewCacheCheck(current), 500);
        }
    });
}

function beginRemotePreviewCacheCheck(entry) {
    if (!remotePreviewSelection || remotePreviewSelection.devices.get(entry.deviceId) !== entry) return;
    clearTimeout(entry.timer);
    const requestId = createRemotePreviewRequestId();
    entry.requestId = requestId;
    entry.status = 'checking';
    entry.reason = '';
    renderRemotePreviewDeviceList();
    const { fileInfo, messageId } = remotePreviewSelection;
    entry.timer = setTimeout(() => updateRemotePreviewEntry(requestId, { status:'unavailable', reason:'offline' }), 5_500);
    state.socket?.emit('remote-preview-cache-check', {
        requestId,
        to:entry.deviceId,
        fileId:fileInfo.id,
        fileInfo,
        messageId
    }, result => {
        if (result?.ok) return;
        updateRemotePreviewEntry(requestId, { status:'unavailable', reason:result?.reason || 'target-unavailable' });
    });
}

function openRemotePreviewDeviceModal() {
    if (!activeFilePreviewFileId || !activeFilePreviewStoredFile || !isPreviewableFileType(activeFilePreviewMediaType)) return;
    const devices = new Map(Array.from(state.devices.entries()).filter(([, device]) => device.clientType !== 'vclient'));
    const fileInfo = {
        id: activeFilePreviewFileId,
        name: activeFilePreviewStoredFile.name || document.querySelector('#filePreviewTitle .file-preview-title-name')?.textContent || '文件预览',
        type: activeFilePreviewMediaType || activeFilePreviewStoredFile.type || '',
        size: Number(activeFilePreviewStoredFile.size) || 0,
        ownerDeviceId: activeFilePreviewOwnerDeviceId || activeFilePreviewStoredFile.ownerDeviceId || ''
    };
    remotePreviewSelection = { fileInfo, messageId: activeFilePreviewMessageId, devices:new Map() };
    devices.forEach((device, deviceId) => {
        const entry = { deviceId, device, requestId:'', status:'checking', reason:'', timer:null };
        remotePreviewSelection.devices.set(deviceId, entry);
        beginRemotePreviewCacheCheck(entry);
    });
    document.getElementById('remotePreviewFileName').textContent = `文件：${fileInfo.name}`;
    renderRemotePreviewDeviceList();
    showRemotePreviewDeviceModal();
    historyLog('remote-preview-device-picker-opened', { fileId:fileInfo.id, candidateCount:devices.size });
}

async function handleRemotePreviewCacheCheck(data) {
    if (!data?.requestId || !data?.from || !data?.fileId || data.fileInfo?.id !== data.fileId) return;
    const storedFile = await getFromStore('files', data.fileId).catch(() => null);
    const type = String(data.fileInfo?.type || storedFile?.type || '').toLowerCase();
    const available = isPreviewableFileType(type) && hasCompleteFileCache(storedFile, data.fileInfo);
    if (available) {
        incomingRemotePreviewRequests.set(data.requestId, { ...data, checkedAt:Date.now() });
        setTimeout(() => incomingRemotePreviewRequests.delete(data.requestId), 20_000);
    }
    state.socket?.emit('remote-preview-cache-result', {
        requestId:data.requestId,
        to:data.from,
        fileId:data.fileId,
        available,
        reason:available ? '' : (isPreviewableFileType(type) ? 'cache-incomplete' : 'not-previewable')
    });
}

function handleRemotePreviewCacheResult(data) {
    const entry = updateRemotePreviewEntry(data?.requestId, {
        status:data?.available === true ? 'available' : 'unavailable',
        reason:data?.reason || ''
    });
    if (entry) historyLog('remote-preview-cache-result', { fileId:data.fileId, targetDeviceId:data.from, available:data.available === true });
}

async function handleRemotePreviewOpen(data) {
    const request = incomingRemotePreviewRequests.get(data?.requestId);
    let ok = false;
    let reason = 'cache-verification-required';
    let presentation = 'media';
    try {
        if (!request || request.from !== data?.from || request.fileId !== data?.fileId) throw new Error(reason);
        const persisted = await getFromStore('files', data.fileId).catch(() => null);
        const storedFile = await materializeCachedFileRecord(persisted);
        if (!hasCompleteFileCache(storedFile, request.fileInfo)) throw new Error('cache-incomplete');
        const type = String(request.fileInfo?.type || storedFile?.type || '').toLowerCase();
        if (!isPreviewableFileType(type)) throw new Error('not-previewable');
        const useMusicPlayer = isAudioFileLike(storedFile, request.fileInfo);
        presentation = useMusicPlayer ? 'music' : 'media';
        const currentMusicTrack = getCurrentMusicTrack();
        if (useMusicPlayer && currentMusicTrack?.id === data.fileId && musicPlayer.overlay?.classList.contains('active')) {
            ok = true;
            reason = '';
            return;
        }
        const currentFullscreenFileId = mediaFullscreenItems[mediaFullscreenIndex]?.fileInfo?.id || '';
        if (!useMusicPlayer && currentFullscreenFileId === data.fileId &&
            document.getElementById('mediaFullscreenViewer')?.classList.contains('active')) {
            ok = true;
            reason = '';
            return;
        }
        if (!useMusicPlayer && musicPlayer.overlay?.classList.contains('active')) {
            closeMusicPlayer({ fromHistory:true, remoteControlCommand:true });
        }
        closeFilePreview({ fromHistory:true, forceClose:true });
        replaceCurrentHistoryWithoutPreviewLayers();
        ok = await openFilePreviewForInfo({ ...request.fileInfo, ...storedFile, data:undefined, id:data.fileId }, {
            messageId:request.messageId || '',
            ownerDeviceId:request.fileInfo?.ownerDeviceId || storedFile?.ownerDeviceId || '',
            requestMissing:false,
            returnToCollection:false
        });
        if (!ok) throw new Error('preview-open-failed');
        ok = useMusicPlayer
            ? await openMusicPlayerFromActivePreview({ pushHistory:false })
            : await openActivePreviewFullscreen({ focusedOnly:true, focusedFileInfo:request.fileInfo });
        if (!ok) throw new Error('fullscreen-open-failed');
        reason = '';
    } catch (error) {
        ok = false;
        reason = error.message || reason;
    } finally {
        incomingRemotePreviewRequests.delete(data?.requestId);
        const fullscreenState = getRemotePreviewFullscreenState({ presentation });
        if (ok) {
            activeRemotePreviewControl = {
                controlId:data.requestId,
                controllerDeviceId:data.from,
                fileId:fullscreenState.fileId || data.fileId,
                presentation
            };
        }
        state.socket?.emit('remote-preview-open-result', {
            requestId:data?.requestId,
            to:data?.from,
            ok,
            reason,
            ...fullscreenState
        });
        historyLog('remote-preview-open-handled', { fileId:data?.fileId, controllerDeviceId:data?.from, ok, reason });
    }
}

function handleRemotePreviewOpenResult(data) {
    const entry = updateRemotePreviewEntry(data?.requestId, data?.ok === true
        ? { status:'opened', reason:'' }
        : { status:'unavailable', reason:data?.reason || 'preview-open-failed' });
    if (!entry) return;
    if (data.ok === true) {
        showAppToast(`已在 ${getDeviceDisplayName(entry.device)} 打开并进入全屏`);
        startRemotePreviewControl(data, entry);
        closeRemotePreviewDeviceModal();
    } else {
        setTimeout(() => beginRemotePreviewCacheCheck(entry), 500);
    }
}

function remotePreviewControlReasonText(reason) {
    return ({
        'control-session-invalid':'控制会话已失效',
        'target-unavailable':'目标设备已离线',
        'no-adjacent-file':'没有其他已完整缓存的可预览文件',
        'fullscreen-not-active':'目标设备已经退出全屏',
        'playback-unavailable':'当前文件不支持播放控制',
        'playback-failed':'目标设备无法开始播放',
        'command-timeout':'目标设备响应超时',
        replaced:'控制已由新的远程预览替换',
        offline:'控制设备或目标设备已离线',
        exited:'目标设备已退出全屏'
    }[reason]) || '远程控制失败';
}

function renderRemotePreviewControlPanel() {
    const panel = document.getElementById('remotePreviewControlPanel');
    const bubble = document.getElementById('remotePreviewControlBubble');
    if (!panel || !bubble) return;
    const visible = Boolean(remotePreviewControl && !remotePreviewControl.minimized && !remotePreviewControl.closing);
    const bubbleVisible = Boolean(remotePreviewControl?.minimized && !remotePreviewControl.closing);
    panel.hidden = !visible;
    bubble.hidden = !bubbleVisible;
    if (bubbleVisible && remotePreviewBubblePosition) {
        positionRemotePreviewControlBubble(remotePreviewBubblePosition.x, remotePreviewBubblePosition.y);
    }
    if (!remotePreviewControl) return;
    const control = remotePreviewControl;
    const title = document.getElementById('remotePreviewControlTitle');
    const logo = document.getElementById('remotePreviewControlDeviceLogo');
    const status = document.getElementById('remotePreviewControlStatus');
    const previous = document.getElementById('remotePreviewControlPrevBtn');
    const next = document.getElementById('remotePreviewControlNextBtn');
    const playbackRow = document.getElementById('remotePreviewControlPlaybackRow');
    const playback = document.getElementById('remotePreviewControlPlaybackBtn');
    const pending = Boolean(control.pendingAction);
    if (title) title.textContent = `${control.targetName} · ${control.fileName || '文件预览'}`;
    if (logo) logo.textContent = control.targetLogo || '📱';
    if (status) status.textContent = control.statusText || '已进入全屏';
    [previous, next].forEach(button => { if (button) button.disabled = pending; });
    const playbackAvailable = /^audio\/|^video\//.test(control.mediaType || '');
    if (playbackRow) playbackRow.hidden = !playbackAvailable;
    if (playback) {
        playback.hidden = !playbackAvailable;
        playback.disabled = pending;
        playback.textContent = control.playing ? '暂停' : '播放';
    }
}

function minimizeRemotePreviewControlPanel() {
    if (!remotePreviewControl || remotePreviewControl.closing) return;
    remotePreviewControl.minimized = true;
    renderRemotePreviewControlPanel();
    document.getElementById('remotePreviewControlBubble')?.focus({ preventScroll:true });
}

function restoreRemotePreviewControlPanel() {
    if (!remotePreviewControl || remotePreviewControl.closing) return;
    remotePreviewControl.minimized = false;
    renderRemotePreviewControlPanel();
    document.getElementById('remotePreviewControlMinimizeBtn')?.focus({ preventScroll:true });
}

function positionRemotePreviewControlBubble(x, y) {
    const bubble = document.getElementById('remotePreviewControlBubble');
    if (!bubble) return;
    const rect = bubble.getBoundingClientRect();
    const width = rect.width || 56;
    const height = rect.height || 56;
    const maxX = Math.max(8, window.innerWidth - width - 8);
    const maxY = Math.max(8, window.innerHeight - height - 8);
    const next = {
        x:Math.min(Math.max(8, Number(x) || 8), maxX),
        y:Math.min(Math.max(8, Number(y) || 8), maxY)
    };
    remotePreviewBubblePosition = next;
    bubble.style.left = `${next.x}px`;
    bubble.style.top = `${next.y}px`;
    bubble.style.right = 'auto';
    bubble.style.bottom = 'auto';
}

function beginRemotePreviewBubbleDrag(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const bubble = event.currentTarget;
    const rect = bubble.getBoundingClientRect();
    remotePreviewBubbleDrag = {
        pointerId:event.pointerId,
        startX:event.clientX,
        startY:event.clientY,
        originX:rect.left,
        originY:rect.top,
        moved:false
    };
    remotePreviewBubbleSuppressClick = false;
    bubble.classList.add('dragging');
    bubble.setPointerCapture?.(event.pointerId);
}

function moveRemotePreviewBubble(event) {
    const drag = remotePreviewBubbleDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
    positionRemotePreviewControlBubble(drag.originX + dx, drag.originY + dy);
    event.preventDefault();
}

function finishRemotePreviewBubbleDrag(event) {
    const drag = remotePreviewBubbleDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bubble = event.currentTarget;
    remotePreviewBubbleSuppressClick = drag.moved;
    remotePreviewBubbleDrag = null;
    bubble.classList.remove('dragging');
    try { bubble.releasePointerCapture?.(event.pointerId); } catch (_) {}
}

function getRemotePreviewDevicePresentation(device = {}) {
    const displayName = getDeviceDisplayName(device);
    const match = displayName.match(/^(📱|💻|🖥️?|⌚)\s*(.+)$/u);
    return {
        logo:match?.[1] || '📱',
        name:match?.[2] || displayName
    };
}

function startRemotePreviewControl(data, entry) {
    clearTimeout(remotePreviewControl?.timer);
    const target = getRemotePreviewDevicePresentation(entry.device);
    remotePreviewControl = {
        controlId:data.controlId || data.requestId,
        targetDeviceId:entry.deviceId,
        targetName:target.name,
        fileId:data.fileId || remotePreviewSelection?.fileInfo?.id || '',
        fileName:data.fileName || remotePreviewSelection?.fileInfo?.name || '文件预览',
        mediaType:String(data.mediaType || remotePreviewSelection?.fileInfo?.type || '').toLowerCase(),
        targetLogo:target.logo,
        playing:data.playing === true,
        pendingAction:'',
        minimized:false,
        closing:false,
        statusText:'已进入全屏',
        timer:null
    };
    renderRemotePreviewControlPanel();
    historyLog('remote-preview-control-started', { controlId:remotePreviewControl.controlId, targetDeviceId:entry.deviceId, fileId:remotePreviewControl.fileId });
}

function finishRemotePreviewControl(reason = '', options = {}) {
    const control = remotePreviewControl;
    if (!control) return;
    clearTimeout(control.timer);
    remotePreviewControl = null;
    renderRemotePreviewControlPanel();
    if (options.toast !== false && reason) showAppToast(remotePreviewControlReasonText(reason));
    historyLog('remote-preview-control-finished', { controlId:control.controlId, targetDeviceId:control.targetDeviceId, reason });
}

function sendRemotePreviewControl(action, options = {}) {
    const control = remotePreviewControl;
    if (!control) return false;
    if (!state.socket?.connected) {
        finishRemotePreviewControl('target-unavailable');
        return false;
    }
    if (control.pendingAction && action !== 'exit') return false;
    clearTimeout(control.timer);
    control.pendingAction = action;
    control.closing = action === 'exit' && options.closePanel === true;
    control.statusText = ({previous:'正在切换到上一个文件…',next:'正在切换到下一个文件…','toggle-playback':'正在切换播放状态…',exit:'正在退出目标设备全屏…'}[action]) || '正在执行远程操作…';
    renderRemotePreviewControlPanel();
    const { controlId, targetDeviceId } = control;
    control.timer = setTimeout(() => {
        if (remotePreviewControl?.controlId !== controlId) return;
        if (remotePreviewControl.closing) {
            finishRemotePreviewControl('', { toast:false });
            showAppToast('退出命令响应超时，本机控制面板已关闭');
            return;
        }
        remotePreviewControl.pendingAction = '';
        remotePreviewControl.statusText = remotePreviewControlReasonText('command-timeout');
        renderRemotePreviewControlPanel();
    }, 15_000);
    state.socket.emit('remote-preview-control', { controlId, to:targetDeviceId, action }, result => {
        if (result?.ok || remotePreviewControl?.controlId !== controlId || remotePreviewControl.pendingAction !== action) return;
        if (['control-session-invalid', 'target-unavailable'].includes(result?.reason)) {
            finishRemotePreviewControl(result.reason);
            return;
        }
        clearTimeout(remotePreviewControl.timer);
        remotePreviewControl.pendingAction = '';
        remotePreviewControl.closing = false;
        remotePreviewControl.statusText = remotePreviewControlReasonText(result?.reason || 'control-session-invalid');
        renderRemotePreviewControlPanel();
    });
    return true;
}

function handleRemotePreviewControlResult(data) {
    const control = remotePreviewControl;
    if (!control || control.controlId !== data?.controlId || control.targetDeviceId !== data?.from) return;
    if (control.pendingAction && control.pendingAction !== data.action) return;
    clearTimeout(control.timer);
    control.timer = null;
    control.pendingAction = '';
    control.closing = false;
    if (data.ok !== true) {
        if (['control-session-invalid', 'fullscreen-not-active'].includes(data.reason)) {
            finishRemotePreviewControl(data.reason);
            return;
        }
        control.statusText = remotePreviewControlReasonText(data.reason || 'control-session-invalid');
        renderRemotePreviewControlPanel();
        return;
    }
    if (data.action === 'exit') {
        finishRemotePreviewControl('', { toast:false });
        showAppToast('目标设备已退出全屏');
        return;
    }
    control.fileId = data.fileId || control.fileId;
    control.fileName = data.fileName || control.fileName;
    control.mediaType = String(data.mediaType || '').toLowerCase();
    control.playing = data.playing === true;
    control.statusText = data.action === 'toggle-playback'
        ? (control.playing ? '目标设备正在播放' : '目标设备已暂停')
        : '已切换文件';
    renderRemotePreviewControlPanel();
}

function handleRemotePreviewControlEnded(data) {
    if (remotePreviewControl?.controlId === data?.controlId) {
        finishRemotePreviewControl(data.reason || 'exited');
    }
    if (activeRemotePreviewControl?.controlId === data?.controlId) {
        const presentation = activeRemotePreviewControl.presentation;
        activeRemotePreviewControl = null;
        if (presentation === 'music') {
            closeMusicPlayer({ fromHistory:true, remoteControlCommand:true });
        } else {
            closeMediaFullscreen({ fromHistory:true, forceClose:true, remoteControlCommand:true });
        }
    }
}

function setFilePreviewTitle(fileName, options = {}) {
    const title = document.getElementById('filePreviewTitle');
    if (!title) return;
    const name = document.createElement('span');
    name.className = 'file-preview-title-name';
    name.textContent = fileName || '文件预览';
    title.replaceChildren();
    if (options.handleReadable || options.handleSourceOnly) {
        const sourceIcon = document.createElement('span');
        sourceIcon.className = 'file-preview-source-icon';
        sourceIcon.textContent = '💾';
        sourceIcon.title = options.handleSourceOnly
            ? '本机原文件可直接读取，未占用浏览器文件缓存'
            : '本机原文件句柄有效，当前仍保留浏览器安全副本';
        sourceIcon.setAttribute('aria-label', '本机文件系统句柄来源');
        title.appendChild(sourceIcon);
    }
    title.appendChild(name);
}

function shouldIgnorePreviewGestureTarget(target) {
    return Boolean(target?.closest?.('button, input, textarea, select, a, .file-preview-actions'));
}

function isPreviewMediaTarget(target) {
    return Boolean(target?.closest?.('#filePreviewContent img, #filePreviewContent video'));
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
    const recoveryStage = serverAssetRecoveries.stages.get(storedFile?.id);
    if (recoveryStage?.label) return recoveryStage.label;
    if (storedFile?.externalFilePermissionRequired) return '需要重新授权本机原文件';
    if (storedFile?.externalFileMissing) return '本机原文件无法读取';
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
    const previousBubble = messageEl.querySelector('.message-bubble');
    const previousPreview = previousBubble?.querySelector('.collection-preview');
    const nextBubble = document.createElement('div');
    nextBubble.className = 'message-bubble collection-message';
    const nextPreview = document.createElement('div');
    nextPreview.className = 'collection-preview';
    files.slice(0, Math.min(files.length, 4)).forEach((fileInfo, index) => {
        const isMoreTile = files.length > 4 && index === 3;
        const existingTile = previousPreview
            ?.querySelector(`.collection-preview-tile[data-collection-file-id="${CSS.escape(fileInfo.id)}"]`);
        const tile = existingTile?.cloneNode(true) || document.createElement('div');
        tile.className = 'collection-preview-tile';
        tile.setAttribute('role', 'button');
        tile.setAttribute('tabindex', '0');
        tile.removeAttribute('data-collection-file-id');
        tile.removeAttribute('data-collection-more');
        tile.querySelector('.collection-more')?.remove();
        if (!tile.childNodes.length) {
            tile.innerHTML = `<span>${getFileIcon(fileInfo.type || '')}</span>`;
        }
        if (isMoreTile) {
            tile.dataset.collectionMore = 'true';
            const more = document.createElement('span');
            more.className = 'collection-more';
            more.innerHTML = `更多文件...<br>+${files.length - 3}`;
            tile.appendChild(more);
        } else {
            tile.dataset.collectionFileId = fileInfo.id;
        }
        nextPreview.appendChild(tile);
    });
    const meta = document.createElement('div');
    meta.className = 'collection-meta';
    meta.textContent = `${files.length} 个文件 · ${formatFileSize(files.reduce((sum, file) => sum + (Number(file.size) || 0), 0))}`;
    nextBubble.append(nextPreview, meta);
    const remarkText = String(message?.remark || message?.collection?.remark || '').trim();
    if (remarkText) {
        const remark = document.createElement('div');
        remark.className = 'collection-remark';
        remark.innerHTML = renderRemarkHtml(remarkText);
        nextBubble.appendChild(remark);
    }
    preserveChatScroll(() => {
        if (previousBubble) previousBubble.replaceWith(nextBubble);
    });
    syncTransferRecordFavoriteBadge(messageEl, message);
    syncTransferRecordSnsBadge(messageEl, message);
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
    let storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
    if (storedFile?.externalFileHandle) {
        storedFile = await materializeExternalFileRecord(storedFile, { requestPermission: true });
    }
    if (hasCompleteFileCache(storedFile, fileInfo)) {
        await downloadFile(fileInfo.id);
        return;
    }
    if (fileInfo.isServerAsset && fileInfo.serverAssetUrl) {
        const fetched = await requestServerAssetWithPeerPreference(fileInfo, ownerDeviceId, 'manual-download', {
            priority: true,
            force: true,
            peerWaitMs: 5000
        });
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
        await requestServerAssetWithPeerPreference(
            fileInfo,
            ownerDeviceId,
            options.force ? 'manual-force-restore' : 'manual-restore',
            { priority: true, force: Boolean(options.force), peerWaitMs: 5000 }
        );
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
    if (!options.preserveCollectionDownloads) {
        await cancelClearedCollectionDownloadsExcept(options.collectionMessageId || '', fileInfo.id);
    }
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
    const storedFile = await getFromStore('files', fileInfo.id);
    if (storedFile?.externalFileHandle) {
        const readableFile = await materializeExternalFileRecord(storedFile, { requestPermission: true });
        const sourceState = await syncExternalFileSourceUi(fileInfo.id, storedFile, readableFile, fileInfo);
        if (sourceState.handleReadable) {
            showAppToast('本机原文件仍可直接读取，没有需要释放的浏览器缓存');
            await refreshFileMessage(fileInfo.id);
            await openFilePreviewForInfo(fileInfo, {
                messageId,
                collectionMessageId: options.collectionMessageId || '',
                ownerDeviceId,
                requestMissing: false
            });
            return;
        }
    }
    if (state.devices.size === 0) {
        const ok = confirm('请确认这个文件在其它设备已缓存，否则将无法恢复。继续清除本机缓存吗？');
        if (!ok) return;
    }
    fileAssetTransfer?.cancel(fileInfo.id);
    if (storedFile?.externalFileHandle && storedFile.hasSafetyCopy && storedFile.safetyCopyState !== 'replicated') {
        alert('此文件绑定了本机原文件句柄，但安全副本尚未确认被其它设备完整缓存。为避免原文件移动或权限失效后无法恢复，暂不释放空间。');
        return;
    }
    if (storedFile?.externalFileHandle && !getBinaryDataSize(storedFile.data) && !storedFile.cacheStoreRef) {
        showAppToast('此文件已是按需读取模式，没有占用浏览器文件缓存');
        return;
    }
    await deleteCacheStoreReference(storedFile, 'clear-file-cache-by-info');
    const { data, cacheStoreRef, cacheStorage, ...metadata } = storedFile || {};
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
    let storedFile = await getFromStore('files', fileInfo.id);
    if (storedFile?.externalFileHandle) {
        storedFile = await materializeExternalFileRecord(storedFile, { requestPermission: true });
    }
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
    if (navigator.share) {
        await navigator.share({
            title: fileInfo.name || storedFile.name || '文件磁链',
            text: '分享一个即时传输隧道文件',
            url: result.url
        }).catch(err => {
            if (err?.name !== 'AbortError') historyLog('file-magnet-system-share-failed', { fileId: fileInfo.id, error: err.message });
        });
    }
    alert(copied ? `磁链已复制，可继续使用系统分享面板发送给朋友\n${result.url}` : `磁链已生成，请手动复制\n${result.url}`);
    historyLog('file-magnet-shared', { messageId, fileId: fileInfo.id, magnetId: result.id, copied });
    return result;
}

async function renderSingleFilePreviewActions({ messageId, fileInfo, ownerDeviceId, collectionMessageId = '', hasLocalData = true, cacheCleared = false, restoreRequested = false, handleSourceOnly = false, handleReadable = false }) {
    const isCollectionFile = Boolean(collectionMessageId);
    const fileFavorite = await isFileFavorite(fileInfo);
    const deleteTitle = isCollectionFile ? '仅从合辑中删除此文件，并清理其缓存' : '从会话中删除此记录及所有设备的文件缓存';
    const cacheAction = handleReadable || handleSourceOnly
        ? null
        : hasLocalData
        ? createFileActionButton('🧹释放空间', '仅清理本设备保存的文件内容', () => {
            clearFileCacheByInfo(fileInfo, ownerDeviceId, messageId, { collectionMessageId });
        })
        : createFileActionButton(restoreRequested ? '☁↓ 正在还原' : '☁↓ 还原文件', restoreRequested ? '文件正在拉取，点击可重新请求' : '从其它在线设备还原此文件', () => {
            restoreFileCacheByInfo(fileInfo, ownerDeviceId, messageId, { collectionMessageId, force: true })
                .catch(err => {
                    alert(`还原文件失败: ${err.message}`);
                    historyLog('file-cache-restore-by-info-failed', { messageId, collectionMessageId, fileId: fileInfo.id, error: err.message });
                });
        });
    setFilePreviewActions([
        createFileActionButton(fileFavorite ? '★' : '☆', fileFavorite ? '取消收藏' : '收藏', () => {
            toggleSingleFileFavorite(fileInfo)
                .then(() => renderSingleFilePreviewActions({ messageId, fileInfo, ownerDeviceId, collectionMessageId, hasLocalData, cacheCleared, restoreRequested, handleSourceOnly, handleReadable }))
                .catch(err => {
                    alert(`收藏状态保存失败: ${err.message}`);
                    historyLog('file-favorite-toggle-failed', { messageId, collectionMessageId, fileId: fileInfo.id, error: err.message });
                });
        }),
        createFileActionButton('📋', '查看文件名、大小、来源设备等详细信息', () => {
            showFileDetailsForInfo(fileInfo, { messageId, sender: ownerDeviceId, senderName: '' })
                .catch(err => historyLog('file-details-open-failed', { messageId, fileId: fileInfo.id, error: err.message }));
        }),
        createFileActionButton('⇩', '下载此文件', () => downloadFileByInfo(fileInfo, ownerDeviceId, { collectionMessageId })),
        createFileActionButton('🧲🔗', '生成可分享的磁力下载链接', () => {
            shareFileMagnetForInfo(fileInfo, ownerDeviceId, messageId).catch(err => {
                alert(`磁链生成失败: ${err.message}`);
                historyLog('file-magnet-share-failed', { messageId, fileId: fileInfo.id, error: err.message });
            });
        }),
        cacheAction,
        createFileActionButton('✖删除', deleteTitle, () => {
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
    ].filter(Boolean));
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

function formatAudioTime(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return '0:00';
    const total = Math.floor(value);
    const minutes = Math.floor(total / 60);
    const rest = String(total % 60).padStart(2, '0');
    return `${minutes}:${rest}`;
}

function showAppToast(message) {
    if (typeof showToast === 'function') {
        showToast(message);
        return;
    }
    const toast = document.createElement('div');
    toast.className = 'device-details-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    toast.style.position = 'fixed';
    toast.style.right = '16px';
    toast.style.bottom = 'calc(18px + env(safe-area-inset-bottom))';
    setTimeout(() => toast.remove(), 2200);
}

function showBlockingProgressPanel(title, detail = '') {
    const overlay = document.createElement('div');
    overlay.className = 'send-mode-overlay blocking-progress-overlay';
    overlay.style.zIndex = '99999';
    overlay.innerHTML = `
        <div class="send-mode-dialog" role="alertdialog" aria-modal="true" style="min-width:min(360px,88vw);text-align:center;">
            <div style="font-size:18px;font-weight:800;margin-bottom:10px;">${escapeHtml(title)}</div>
            <div class="blocking-progress-spinner" aria-hidden="true" style="width:38px;height:38px;border:4px solid rgba(102,126,234,.18);border-top-color:#667eea;border-radius:50%;margin:8px auto 12px;animation:blocking-progress-spin .85s linear infinite;"></div>
            <div class="blocking-progress-detail" style="font-size:14px;color:#526079;line-height:1.55;">${escapeHtml(detail || '正在处理，请稍候...')}</div>
            <div style="height:7px;background:#edf1fa;border-radius:999px;overflow:hidden;margin-top:14px;">
                <div class="blocking-progress-fill" style="height:100%;width:0%;background:#667eea;transition:width .16s ease;"></div>
            </div>
        </div>
    `;
    if (!document.getElementById('blockingProgressStyle')) {
        const style = document.createElement('style');
        style.id = 'blockingProgressStyle';
        style.textContent = '@keyframes blocking-progress-spin{to{transform:rotate(360deg)}}';
        document.head.appendChild(style);
    }
    document.body.appendChild(overlay);
    return {
        update(progress, nextDetail = '') {
            const fill = overlay.querySelector('.blocking-progress-fill');
            const detailEl = overlay.querySelector('.blocking-progress-detail');
            if (fill && Number.isFinite(progress)) fill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
            if (detailEl && nextDetail) detailEl.textContent = nextDetail;
        },
        close() {
            overlay.remove();
        }
    };
}

function getMusicPlayerSaveKey() {
    return `${MUSIC_PLAYER_STORAGE_KEY}:${state.deviceId || 'local'}:${state.sessionId || 'no-session'}`;
}

function sanitizeMusicTrackFileInfo(track = {}) {
    const fileInfo = track.fileInfo || track || {};
    return {
        id: track.id || fileInfo.id || '',
        name: fileInfo.name || track.name || 'Audio',
        type: fileInfo.type || track.type || '',
        size: Number(fileInfo.size || track.size || 0),
        sessionId: track.sessionId || fileInfo.sessionId || state.sessionId || '',
        ownerDeviceId: fileInfo.ownerDeviceId || track.ownerDeviceId || '',
        messageId: fileInfo.messageId || track.messageId || '',
        timestamp: fileInfo.timestamp || track.timestamp || 0,
        localOrder: fileInfo.localOrder || track.localOrder || 0
    };
}

function serializeMusicTrack(track, queueOrder = -1) {
    if (!track?.id) return null;
    const sessionId = track.sessionId || track.fileInfo?.sessionId || state.sessionId || '';
    const fileInfo = sanitizeMusicTrackFileInfo({ ...track, sessionId });
    return {
        id: track.id,
        sessionId,
        fileInfo,
        name: track.name || track.fileInfo?.name || 'Audio',
        artist: track.artist || '',
        album: track.album || '',
        size: Number(track.size || track.fileInfo?.size || 0),
        type: track.type || track.fileInfo?.type || '',
        codec: track.codec || '',
        duration: Number(track.duration || 0),
        bitrate: track.bitrate || '',
        sampleRate: track.sampleRate || '',
        queueOrder: Number.isFinite(queueOrder) && queueOrder >= 0 ? queueOrder : undefined
    };
}

function getMusicLibrarySaveKey() {
    return `${MUSIC_LIBRARY_STORAGE_KEY}:${state.deviceId || 'local'}`;
}

function getFavoriteMusicIds() {
    try {
        return new Set(JSON.parse(localStorage.getItem(getMusicLibrarySaveKey()) || '[]'));
    } catch (_) {
        return new Set();
    }
}

function saveFavoriteMusicIds(ids) {
    localStorage.setItem(getMusicLibrarySaveKey(), JSON.stringify(Array.from(ids).filter(Boolean)));
}

function isMusicTrackFavorite(track = getCurrentMusicTrack()) {
    if (!track?.id) return false;
    return getFavoriteMusicIds().has(track.id);
}

async function setMusicTrackFavorite(track, favorite) {
    if (!track?.id) return;
    const ids = getFavoriteMusicIds();
    if (favorite) ids.add(track.id);
    else ids.delete(track.id);
    saveFavoriteMusicIds(ids);
    const storedFile = await getFromStore('files', track.id).catch(() => null);
    if (storedFile?.id) {
        await saveToStore('files', { ...storedFile, mediaFavorite: Boolean(favorite) });
    }
    await refreshFileFavoriteBadges(track.id);
    renderMusicPlayerActions();
}

function scheduleMusicPlayerPersist() {
    if (musicPlayerPersistTimer) clearTimeout(musicPlayerPersistTimer);
    musicPlayerPersistTimer = setTimeout(persistMusicPlayerState, 350);
}

function buildMusicPlayerPayload() {
    const audio = musicPlayer.audio;
    return {
        queue: musicPlayer.queue.map((track, index) => serializeMusicTrack(track, index)).filter(Boolean),
        currentIndex: musicPlayer.currentIndex,
        currentTrackId: getCurrentMusicTrack()?.id || musicPlayer.currentTrackId || '',
        currentTime: Number(audio?.currentTime || 0),
        paused: !isBackgroundMusicPlaying(),
        miniEnabled: Boolean(musicPlayer.miniEnabled || musicPlayer.queue.length),
        updatedAt: Date.now()
    };
}

function persistMusicPlayerState() {
    if (musicPlayerPersistTimer) {
        clearTimeout(musicPlayerPersistTimer);
        musicPlayerPersistTimer = null;
    }
    musicPlayerPersistTimer = null;
    musicPlayerLastPersistAt = Date.now();
    try {
        const payload = buildMusicPlayerPayload();
        localStorage.setItem(getMusicPlayerSaveKey(), JSON.stringify(payload));
        scheduleMusicPlayerDurablePersist(payload);
    } catch (err) {
        historyLog('music-player-persist-failed', {
            error: err.message,
            queueCount: musicPlayer.queue.length
        });
    }
}

function persistMusicPlayerStateNow() {
    persistMusicPlayerState();
    persistMusicPlayerStateToSession().catch(err => historyLog('music-player-immediate-persist-failed', {
        error: err.message,
        queueCount: musicPlayer.queue.length
    }));
}

function scheduleMusicPlayerDurablePersist(payload = null) {
    if (!state.sessionId || !state.db) return;
    if (musicPlayerDurablePersistTimer) clearTimeout(musicPlayerDurablePersistTimer);
    const snapshot = payload || buildMusicPlayerPayload();
    musicPlayerDurablePersistTimer = setTimeout(() => {
        musicPlayerDurablePersistTimer = null;
        persistMusicPlayerStateToSession(snapshot).catch(err => historyLog('music-player-durable-persist-failed', {
            error: err.message,
            queueCount: snapshot.queue?.length || 0
        }));
    }, 250);
}

async function persistMusicPlayerStateToSession(payload = buildMusicPlayerPayload()) {
    if (!state.sessionId || !state.db) return false;
    const existing = await getFromStore('sessions', state.sessionId).catch(() => null);
    await saveToStore('sessions', {
        ...(existing || {}),
        sessionId: state.sessionId,
        deviceId: state.deviceId,
        musicPlayerState: payload,
        musicPlayerStateUpdatedAt: payload.updatedAt || Date.now()
    });
    return true;
}

function parseSavedMusicPlayerState(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function isMusicQueueSubset(shorter = [], longer = []) {
    if (!shorter.length || shorter.length > longer.length) return false;
    const longerIds = new Set(longer.map(track => track?.id).filter(Boolean));
    return shorter.every(track => track?.id && longerIds.has(track.id));
}

function haveSameMusicQueueMembers(left = [], right = []) {
    if (left.length !== right.length) return false;
    const leftIds = new Set(left.map(track => track?.id).filter(Boolean));
    return right.every(track => track?.id && leftIds.has(track.id));
}

function findSavedMusicQueueIndex(saved, fileId) {
    if (!saved?.queue?.length || !fileId) return -1;
    return saved.queue.findIndex(track => track?.id === fileId);
}

function normalizeSavedMusicQueue(queue = []) {
    const items = Array.isArray(queue) ? queue.filter(track => track?.id) : [];
    const orders = items.map(track => Number(track.queueOrder));
    const hasStableOrder = items.length > 1 &&
        orders.every(order => Number.isInteger(order) && order >= 0) &&
        new Set(orders).size === items.length;
    if (!hasStableOrder) return items;
    return [...items].sort((a, b) => Number(a.queueOrder) - Number(b.queueOrder));
}

function getSavedMusicCurrentTrackId(saved) {
    if (!saved?.queue?.length) return '';
    if (saved.currentTrackId && saved.queue.some(track => track?.id === saved.currentTrackId)) {
        return saved.currentTrackId;
    }
    const index = Math.min(Math.max(Number(saved.currentIndex) || 0, 0), saved.queue.length - 1);
    return saved.queue[index]?.id || '';
}

function chooseSavedMusicPlayerState(localSaved, durableSaved) {
    const local = parseSavedMusicPlayerState(localSaved);
    const durable = parseSavedMusicPlayerState(durableSaved);
    if (!local?.queue?.length) return durable;
    if (!durable?.queue?.length) return local;
    local.queue = normalizeSavedMusicQueue(local.queue);
    durable.queue = normalizeSavedMusicQueue(durable.queue);

    const localNewer = Number(local.updatedAt || 0) >= Number(durable.updatedAt || 0);
    const newerState = localNewer ? local : durable;
    let queueState = localNewer ? local : durable;
    const explicitCurrentTrackId = newerState.currentTrackId ||
        local.currentTrackId ||
        durable.currentTrackId ||
        '';

    if (durable.queue.length > local.queue.length && isMusicQueueSubset(local.queue, durable.queue)) {
        queueState = durable;
    } else if (local.queue.length > durable.queue.length && isMusicQueueSubset(durable.queue, local.queue)) {
        queueState = local;
    } else if (durable.queue.length !== local.queue.length) {
        queueState = durable.queue.length > local.queue.length ? durable : local;
    } else if (explicitCurrentTrackId && haveSameMusicQueueMembers(local.queue, durable.queue)) {
        const localIndex = findSavedMusicQueueIndex(local, explicitCurrentTrackId);
        const durableIndex = findSavedMusicQueueIndex(durable, explicitCurrentTrackId);
        if (localIndex === 0 && durableIndex > 0) queueState = durable;
        else if (durableIndex === 0 && localIndex > 0) queueState = local;
    }

    const currentTrackId = explicitCurrentTrackId && queueState.queue.some(track => track?.id === explicitCurrentTrackId)
        ? explicitCurrentTrackId
        : (getSavedMusicCurrentTrackId(newerState) || getSavedMusicCurrentTrackId(queueState));
    const currentIndex = queueState.queue.findIndex(track => track?.id === currentTrackId);
    return {
        ...queueState,
        currentTime: newerState.currentTrackId === currentTrackId ? newerState.currentTime : queueState.currentTime,
        paused: newerState.paused,
        miniEnabled: newerState.miniEnabled || queueState.miniEnabled,
        updatedAt: Math.max(Number(local.updatedAt || 0), Number(durable.updatedAt || 0)),
        currentTrackId,
        currentIndex: currentIndex >= 0 ? currentIndex : Math.min(Math.max(Number(queueState.currentIndex) || 0, 0), queueState.queue.length - 1)
    };
}

function persistMusicPlayerProgressSoon() {
    if (Date.now() - musicPlayerLastPersistAt > 5000) {
        persistMusicPlayerState();
        return;
    }
    scheduleMusicPlayerPersist();
}

async function hydrateSavedMusicTrack(savedTrack) {
    if (!savedTrack?.id) return null;
    if (savedTrack.sessionId && state.sessionId && savedTrack.sessionId !== state.sessionId) return null;
    const storedFile = await getFromStore('files', savedTrack.id).catch(() => null);
    if (storedFile?.sessionId && state.sessionId && storedFile.sessionId !== state.sessionId) return null;
    if (!hasCompleteFileCache(storedFile, savedTrack.fileInfo || savedTrack)) return null;
    const fileInfo = { ...(savedTrack.fileInfo || {}), id: savedTrack.id };
    fileInfo.sessionId = savedTrack.sessionId || fileInfo.sessionId || storedFile.sessionId || state.sessionId || '';
    const url = getStoredFileUrl(savedTrack.id, storedFile);
    const type = String(fileInfo.type || storedFile.type || savedTrack.type || '').toLowerCase();
    const extension = getFileExtension(fileInfo.name || storedFile.name || savedTrack.name || '').toUpperCase();
    const metadata = await ensureAudioMetadataCache(storedFile, fileInfo).catch(() => ({}));
    return {
        id: savedTrack.id,
        sessionId: fileInfo.sessionId,
        fileInfo,
        name: metadata.title || storedFile.audioTitle || savedTrack.name || fileInfo.name || storedFile.name || 'Audio',
        artist: metadata.artist || storedFile.audioArtist || savedTrack.artist || '未知艺术家',
        album: metadata.album || storedFile.audioAlbum || savedTrack.album || '未知专辑',
        url,
        poster: storedFile.audioPoster || '',
        size: Number(savedTrack.size || fileInfo.size || storedFile.size || 0),
        type: type || 'audio/*',
        codec: savedTrack.codec || extension || type || '未知',
        duration: Number(savedTrack.duration || 0),
        bitrate: savedTrack.bitrate || '',
        sampleRate: savedTrack.sampleRate || ''
    };
}

async function restoreMusicPlayerState() {
    const storedSession = await getFromStore('sessions', state.sessionId).catch(() => null);
    const saved = chooseSavedMusicPlayerState(
        localStorage.getItem(getMusicPlayerSaveKey()),
        storedSession?.musicPlayerState || null
    );
    if (!saved?.queue?.length) {
        if (musicPlayer.audio) {
            try { musicPlayer.audio.pause(); } catch (_) {}
            musicPlayer.audio.removeAttribute('src');
        }
        musicPlayer.queue = [];
        musicPlayer.currentIndex = -1;
        musicPlayer.currentTrackId = '';
        musicPlayer.miniEnabled = false;
        updateTopbarMusicState();
        renderMusicPlayer();
        return;
    }
    const restored = [];
    const savedQueue = normalizeSavedMusicQueue(saved.queue);
    const savedCurrentTrackId = getSavedMusicCurrentTrackId({ ...saved, queue: savedQueue });
    for (const item of savedQueue) {
        const track = await hydrateSavedMusicTrack(item);
        if (track) restored.push(track);
    }
    musicPlayer.queue = restored;
    const restoredCurrentIndex = restored.findIndex(track => track?.id === savedCurrentTrackId);
    if (restoredCurrentIndex >= 0) {
        setMusicCurrentIndex(restoredCurrentIndex);
    } else {
        setMusicCurrentIndex(Math.min(Math.max(Number(saved.currentIndex) || 0, 0), Math.max(restored.length - 1, 0)));
    }
    musicPlayer.miniEnabled = Boolean(restored.length && saved.miniEnabled);
    if (restored.length) {
        const audio = ensureBackgroundAudio();
        const track = getCurrentMusicTrack();
        if (track?.url) {
            audio.src = track.url;
            const resumeAt = Number(saved.currentTime || 0);
            if (resumeAt > 0) {
                const applyTime = () => {
                    try { audio.currentTime = resumeAt; } catch (_) {}
                    audio.removeEventListener('loadedmetadata', applyTime);
                };
                audio.addEventListener('loadedmetadata', applyTime);
            }
        }
    }
    updateTopbarMusicState();
    renderMusicPlayer();
}

function isBackgroundMusicPlaying() {
    return Boolean(musicPlayer.audio && !musicPlayer.audio.paused && !musicPlayer.audio.ended);
}

function ensureBackgroundAudio() {
    if (musicPlayer.audio) return musicPlayer.audio;
    const audio = new Audio();
    audio.preload = 'metadata';
    initMusicMediaSession();
    audio.addEventListener('timeupdate', updateMusicPlayerProgress);
    audio.addEventListener('loadedmetadata', updateMusicPlayerProgress);
    audio.addEventListener('play', () => {
        updateMusicPlayerPlayState();
        updateTopbarMusicState();
        updateMediaSessionPlaybackState();
        startMusicPlayerProgressTimer();
        scheduleMusicPlayerPersist();
    });
    audio.addEventListener('pause', () => {
        updateMusicPlayerPlayState();
        updateTopbarMusicState();
        updateMediaSessionPlaybackState();
        stopMusicPlayerProgressTimer();
        scheduleMusicPlayerPersist();
    });
    audio.addEventListener('ended', () => {
        scheduleMusicPlayerPersist();
        playNextMusicTrack({ fromEnded: true });
    });
    musicPlayer.audio = audio;
    return audio;
}

function stopMusicPlayerProgressTimer() {
    if (musicPlayer.progressTimer) clearInterval(musicPlayer.progressTimer);
    musicPlayer.progressTimer = null;
}

function startMusicPlayerProgressTimer() {
    stopMusicPlayerProgressTimer();
    musicPlayer.progressTimer = setInterval(updateMusicPlayerProgress, 500);
}

async function buildAudioTrack(fileInfo, storedFile, url) {
    const type = String(fileInfo.type || storedFile?.type || '').toLowerCase();
    const extension = getFileExtension(fileInfo.name || storedFile?.name || '').toUpperCase();
    const poster = storedFile?.audioPoster || await ensureAudioPosterCacheShared(storedFile, fileInfo).catch(() => '');
    const metadata = await ensureAudioMetadataCache(storedFile, fileInfo).catch(() => ({}));
    const sessionId = fileInfo.sessionId || storedFile?.sessionId || state.sessionId || '';
    const safeFileInfo = sanitizeMusicTrackFileInfo({ ...fileInfo, id: fileInfo.id, sessionId });
    return {
        id: fileInfo.id,
        sessionId,
        fileInfo: safeFileInfo,
        name: metadata.title || storedFile?.audioTitle || fileInfo.name || storedFile?.name || 'Audio',
        artist: metadata.artist || storedFile?.audioArtist || '未知艺术家',
        album: metadata.album || storedFile?.audioAlbum || '未知专辑',
        url,
        poster,
        size: Number(fileInfo.size || storedFile?.size || 0),
        type: type || 'audio/*',
        codec: extension || type || '未知',
        duration: 0,
        bitrate: '',
        sampleRate: ''
    };
}

function getCurrentMusicTrack() {
    if (!musicPlayer.queue.length) {
        musicPlayer.currentIndex = -1;
        musicPlayer.currentTrackId = '';
        return null;
    }
    if (musicPlayer.currentTrackId) {
        const index = musicPlayer.queue.findIndex(track => track?.id === musicPlayer.currentTrackId);
        if (index >= 0) {
            musicPlayer.currentIndex = index;
            return musicPlayer.queue[index];
        }
    }
    const normalizedIndex = Math.min(Math.max(Number(musicPlayer.currentIndex) || 0, 0), musicPlayer.queue.length - 1);
    musicPlayer.currentIndex = normalizedIndex;
    musicPlayer.currentTrackId = musicPlayer.queue[normalizedIndex]?.id || '';
    return musicPlayer.queue[normalizedIndex] || null;
}

function setMusicCurrentIndex(index) {
    if (!musicPlayer.queue.length) {
        musicPlayer.currentIndex = -1;
        musicPlayer.currentTrackId = '';
        return null;
    }
    const normalizedIndex = Math.min(Math.max(Number(index) || 0, 0), musicPlayer.queue.length - 1);
    musicPlayer.currentIndex = normalizedIndex;
    musicPlayer.currentTrackId = musicPlayer.queue[normalizedIndex]?.id || '';
    return musicPlayer.queue[normalizedIndex] || null;
}

function setMusicCurrentTrackById(fileId, fallbackIndex = musicPlayer.currentIndex) {
    if (!fileId) return setMusicCurrentIndex(fallbackIndex);
    const index = musicPlayer.queue.findIndex(track => track?.id === fileId);
    return setMusicCurrentIndex(index >= 0 ? index : fallbackIndex);
}

function updateMusicQueueTrackPoster(fileId, poster) {
    if (!fileId || !poster) return false;
    let changed = false;
    musicPlayer.queue.forEach(track => {
        if (track?.id !== fileId || track.poster === poster) return;
        track.poster = poster;
        if (track.fileInfo) track.fileInfo.audioPoster = poster;
        changed = true;
    });
    if (!changed) {
        if (getCurrentMusicTrack()?.id === fileId) syncMusicPlayerCoverElement(getCurrentMusicTrack(), { force: true });
        return false;
    }
    renderMusicPlayer();
    renderMusicQueueList();
    updateMediaSessionMetadata();
    if (getCurrentMusicTrack()?.id === fileId) {
        forceMusicPlayerCoverForTrack(fileId, poster);
    }
    scheduleMusicPlayerPersist();
    return true;
}

function updateActiveAudioPreviewPoster(fileId, poster) {
    if (!fileId || !poster || activeFilePreviewFileId !== fileId) return false;
    const cover = document.querySelector('#filePreviewContent .audio-preview-cover');
    if (!cover) return false;
    const existing = cover.querySelector('img');
    if (existing?.src === poster || existing?.currentSrc === poster) return false;
    const toggle = cover.querySelector('.audio-preview-toggle');
    const image = document.createElement('img');
    image.src = poster;
    image.alt = '';
    cover.querySelector('.audio-preview-cover-placeholder')?.remove();
    existing?.remove();
    cover.insertBefore(image, toggle || null);
    return true;
}

function preloadImageSource(src, timeout = 5000) {
    if (!src) return Promise.resolve(false);
    return new Promise(resolve => {
        const image = new Image();
        let settled = false;
        const done = ok => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(ok);
        };
        const timer = setTimeout(() => done(false), timeout);
        image.onload = () => {
            if (typeof image.decode === 'function') {
                image.decode().then(() => done(true)).catch(() => done(true));
            } else {
                done(true);
            }
        };
        image.onerror = () => done(false);
        image.src = src;
        if (image.complete && image.naturalWidth > 0) done(true);
    });
}

function updateMusicQueueTrackDuration(fileId, duration) {
    const normalized = Number(duration || 0);
    if (!fileId || !(normalized > 0)) return false;
    let changed = false;
    musicPlayer.queue.forEach(track => {
        if (track?.id !== fileId || Number(track.duration || 0) > 0) return;
        track.duration = normalized;
        if (track.size && !track.bitrate) track.bitrate = `${Math.round((track.size * 8) / normalized / 1000)} kbps`;
        changed = true;
    });
    if (!changed) return false;
    updateMusicPlayerProgress();
    renderMusicQueueList();
    updateMediaSessionMetadata();
    scheduleMusicPlayerPersist();
    return true;
}

function removeMusicTrackFromQueue(fileId) {
    if (!fileId || !musicPlayer.queue.some(track => track?.id === fileId)) return false;
    const previousTrack = getCurrentMusicTrack();
    const previousTrackId = previousTrack?.id || '';
    const previousIndex = musicPlayer.currentIndex;
    const wasCurrent = previousTrackId === fileId;
    const wasPlaying = isBackgroundMusicPlaying();
    musicPlayer.queue = musicPlayer.queue.filter(track => track?.id !== fileId);
    if (!musicPlayer.queue.length) {
        const audio = musicPlayer.audio;
        if (audio) {
            try { audio.pause(); } catch (_) {}
            audio.removeAttribute('src');
        }
        musicPlayer.currentIndex = -1;
        musicPlayer.currentTrackId = '';
        musicPlayer.miniEnabled = false;
        musicPlayer.queueOpen = false;
        musicPlayer.overlay?.classList.remove('active');
    } else {
        if (wasCurrent) setMusicCurrentIndex(Math.min(previousIndex, musicPlayer.queue.length - 1));
        else setMusicCurrentTrackById(previousTrackId, previousIndex);
        if (wasCurrent) {
            const nextTrack = getCurrentMusicTrack();
            const audio = ensureBackgroundAudio();
            if (nextTrack?.url && audio.src !== nextTrack.url) audio.src = nextTrack.url;
            if (wasPlaying) audio.play().catch(err => historyLog('music-player-play-after-delete-failed', { fileId: nextTrack?.id, error: err.message }));
        }
        renderMusicPlayer();
    }
    renderMusicQueueList();
    updateTopbarMusicState();
    updateMediaSessionMetadata();
    scheduleMusicPlayerPersist();
    historyLog('music-track-removed-after-file-delete', { fileId, remainingCount: musicPlayer.queue.length });
    return true;
}

function hydrateMusicTrackPoster(track = getCurrentMusicTrack()) {
    if (!track?.id || track.poster || musicPlayerPosterHydratingIds.has(track.id)) return;
    musicPlayerPosterHydratingIds.add(track.id);
    (async () => {
        const storedFile = await getFromStore('files', track.id).catch(() => null);
        if (!hasCompleteFileCache(storedFile, track.fileInfo || track)) return;
        let poster = storedFile.audioPoster || storedFile.videoPoster || '';
        if (!poster && isAudioFileLike(storedFile, track.fileInfo || track)) {
            poster = await ensureAudioPosterCacheShared(storedFile, track.fileInfo || track).catch(() => '');
        }
        if (poster) updateMusicQueueTrackPoster(track.id, poster);
    })()
        .catch(err => historyLog('music-player-poster-hydrate-failed', { fileId: track.id, error: err.message }))
        .finally(() => musicPlayerPosterHydratingIds.delete(track.id));
}

async function ensureMusicTrackPosterForPreview(track, fileInfo = {}, storedFile = null) {
    if (!track?.id) return '';
    if (track.poster) {
        updateActiveAudioPreviewPoster(track.id, track.poster);
        await preloadImageSource(track.poster);
        return track.poster;
    }
    const previewPoster = document.querySelector('#filePreviewContent .audio-preview-cover img')?.currentSrc ||
        document.querySelector('#filePreviewContent .audio-preview-cover img')?.src ||
        '';
    if (previewPoster) {
        track.poster = previewPoster;
        if (track.fileInfo) track.fileInfo.audioPoster = previewPoster;
        updateMusicQueueTrackPoster(track.id, previewPoster);
        await preloadImageSource(previewPoster);
        return previewPoster;
    }
    const latestFile = await getFromStore('files', track.id).catch(() => null);
    const sourceFile = latestFile || storedFile;
    if (!hasCompleteFileCache(sourceFile, fileInfo || track)) return '';
    const poster = sourceFile.audioPoster || await ensureAudioPosterCacheShared(sourceFile, fileInfo || track).catch(() => '');
    if (!poster) return '';
    track.poster = poster;
    if (track.fileInfo) track.fileInfo.audioPoster = poster;
    updateActiveAudioPreviewPoster(track.id, poster);
    updateMusicQueueTrackPoster(track.id, poster);
    await preloadImageSource(poster);
    return poster;
}

function hydrateMusicTrackDuration(track) {
    if (!track?.id || !track.url || Number(track.duration || 0) > 0 || musicPlayerDurationHydratingIds.has(track.id)) return;
    musicPlayerDurationHydratingIds.add(track.id);
    const probe = new Audio();
    probe.preload = 'metadata';
    const cleanup = () => {
        probe.removeAttribute('src');
        try { probe.load(); } catch (_) {}
        musicPlayerDurationHydratingIds.delete(track.id);
    };
    probe.addEventListener('loadedmetadata', () => {
        updateMusicQueueTrackDuration(track.id, probe.duration);
        cleanup();
    }, { once: true });
    probe.addEventListener('error', cleanup, { once: true });
    setTimeout(cleanup, 10000);
    probe.src = track.url;
}

function setTopbarMusicVisible(visible) {
    const button = document.getElementById('topbarMusicBtn');
    if (!button) return;
    button.hidden = !visible;
}

function replaceCurrentHistoryWithoutMusicPlayer() {
    const baseState = history.state && typeof history.state === 'object' ? { ...history.state } : {};
    delete baseState[MUSIC_QUEUE_HISTORY_KEY];
    delete baseState[MUSIC_PLAYER_HISTORY_KEY];
    history.replaceState(baseState, '', window.location.href);
}

function ensureHomeHistoryGuard() {
    if (!state.sessionId || homeHistoryGuardReady) return;
    const currentState = history.state && typeof history.state === 'object' ? history.state : {};
    if (!currentState[HOME_GUARD_HISTORY_KEY]) {
        history.replaceState({ ...currentState, [HOME_GUARD_HISTORY_KEY]: true }, '', window.location.href);
    }
    history.pushState({ ...currentState, [HOME_GUARD_HISTORY_KEY]: true, homeGuardTop: true }, '', window.location.href);
    homeHistoryGuardReady = true;
}

function trapHomeBackNavigation(eventState = history.state) {
    if (!state.sessionId || isAnyBlockingOverlayOpen()) return false;
    if (!eventState?.[HOME_GUARD_HISTORY_KEY]) return false;
    const nextState = {
        ...(eventState && typeof eventState === 'object' ? eventState : {}),
        [HOME_GUARD_HISTORY_KEY]: true,
        homeGuardTop: true
    };
    history.pushState(nextState, '', window.location.href);
    homeHistoryGuardReady = true;
    historyLog('home-back-navigation-trapped', { sessionId: state.sessionId });
    return true;
}

function updateTopbarMusicState() {
    const button = document.getElementById('topbarMusicBtn');
    const marquee = document.getElementById('topbarNowPlaying');
    const marqueeText = marquee?.querySelector('span');
    const track = getCurrentMusicTrack();
    const hasQueue = musicPlayer.queue.length > 0;
    const playing = isBackgroundMusicPlaying();
    if (button) {
        button.hidden = !hasQueue;
        button.classList.toggle('is-playing', hasQueue && playing);
    }
    if (marquee) {
        marquee.hidden = !(hasQueue && playing && track?.name);
        if (marqueeText) marqueeText.textContent = track?.name || '';
    }
}

function initMusicMediaSession() {
    if (musicPlayer.mediaSessionReady || !('mediaSession' in navigator)) return;
    musicPlayer.mediaSessionReady = true;
    const safeSetAction = (action, handler) => {
        try {
            navigator.mediaSession.setActionHandler(action, handler);
        } catch (_) {}
    };
    safeSetAction('play', () => ensureBackgroundAudio().play().catch(err => historyLog('music-media-session-play-failed', { error: err.message })));
    safeSetAction('pause', () => ensureBackgroundAudio().pause());
    safeSetAction('previoustrack', playPreviousMusicTrack);
    safeSetAction('nexttrack', playNextMusicTrack);
    safeSetAction('seekto', details => {
        const audio = ensureBackgroundAudio();
        if (typeof details.seekTime === 'number') {
            audio.currentTime = details.seekTime;
            updateMediaSessionPlaybackState();
            scheduleMusicPlayerPersist();
        }
    });
}

function updateMediaSessionMetadata() {
    if (!('mediaSession' in navigator) || typeof MediaMetadata !== 'function') return;
    initMusicMediaSession();
    const track = getCurrentMusicTrack();
    if (!track) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
        return;
    }
    const artwork = track.poster ? [
        { src: track.poster, sizes: '512x512', type: 'image/png' }
    ] : [];
    navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name || 'Audio',
        artist: track.artist || '未知艺术家',
        album: track.album || '即时传输隧道',
        artwork
    });
    updateMediaSessionPlaybackState();
}

function updateMediaSessionPlaybackState() {
    if (!('mediaSession' in navigator)) return;
    const audio = musicPlayer.audio;
    const track = getCurrentMusicTrack();
    navigator.mediaSession.playbackState = isBackgroundMusicPlaying() ? 'playing' : (track ? 'paused' : 'none');
    if (navigator.mediaSession.setPositionState && audio && track) {
        const duration = Number(audio.duration || track.duration || 0);
        if (duration > 0) {
            try {
                navigator.mediaSession.setPositionState({
                    duration,
                    playbackRate: audio.playbackRate || 1,
                    position: Math.min(Number(audio.currentTime || 0), duration)
                });
            } catch (_) {}
        }
    }
}

async function getLocalAudioLibraryTracks() {
    const tracks = [];
    for (const fileInfo of await getCurrentSessionAudioFileInfos()) {
        const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
        if (!hasCompleteFileCache(storedFile, fileInfo)) continue;
        const url = getStoredFileUrl(storedFile.id, storedFile);
        tracks.push(await buildAudioTrack(fileInfo, storedFile, url).catch(() => null));
        if (tracks.length % 8 === 0) await sleep(0);
    }
    return tracks.filter(Boolean);
}

async function getCurrentSessionAudioFileInfos() {
    const messages = await getCurrentSessionMessages();
    const byId = new Map();
    const consider = fileInfo => {
        if (!fileInfo?.id || byId.has(fileInfo.id)) return;
        const type = String(fileInfo.type || '').toLowerCase();
        if (type.startsWith('video/') || !isAudioFileLike(null, fileInfo)) return;
        byId.set(fileInfo.id, fileInfo);
    };
    for (const message of messages) {
        if (message?.type === 'file') consider(message.fileInfo);
        if (message?.type === 'collection') getCollectionFiles(message).forEach(consider);
    }
    return Array.from(byId.values());
}

function notifyMusicLibraryAssetAvailable(fileInfo, storedFile = null) {
    const type = String(fileInfo?.type || storedFile?.type || '').toLowerCase();
    if (type.startsWith('video/') || !isAudioFileLike(storedFile, fileInfo)) return;
    musicPlayer.libraryFillExhaustedAt = 0;
    scheduleMusicQueueTailFill();
}

async function pickRandomLibraryTrackNotInQueue() {
    const usedIds = new Set(musicPlayer.queue.map(track => track.id));
    const candidates = (await getCurrentSessionAudioFileInfos()).filter(fileInfo => !usedIds.has(fileInfo.id));
    while (candidates.length) {
        const [fileInfo] = candidates.splice(Math.floor(Math.random() * candidates.length), 1);
        const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
        if (!hasCompleteFileCache(storedFile, fileInfo)) continue;
        const url = getStoredFileUrl(storedFile.id, storedFile);
        const track = await buildAudioTrack(fileInfo, storedFile, url).catch(() => null);
        if (track) return track;
        await sleep(0);
    }
    return pickRandomLibraryTrackFromFileStore(usedIds);
}

async function pickRandomLibraryTrackFromFileStore(usedIds) {
    const files = typeof IDBKeyRange !== 'undefined'
        ? await getAllFromStore('files', 'sessionId', IDBKeyRange.only(state.sessionId))
        : (await getAllFromStore('files')).filter(file => file.sessionId === state.sessionId);
    const candidates = files.filter(storedFile => {
        const type = String(storedFile?.type || '').toLowerCase();
        return storedFile?.id &&
            !usedIds.has(storedFile.id) &&
            !type.startsWith('video/') &&
            hasCompleteFileCache(storedFile, storedFile) &&
            isAudioFileLike(storedFile, storedFile);
    });
    while (candidates.length) {
        const [storedFile] = candidates.splice(Math.floor(Math.random() * candidates.length), 1);
        const url = getStoredFileUrl(storedFile.id, storedFile);
        const track = await buildAudioTrack(storedFile, storedFile, url).catch(() => null);
        if (track) return track;
        await sleep(0);
    }
    return null;
}

async function appendRandomLibraryTrackIfPossible(options = {}) {
    if (musicPlayer.libraryFillExhaustedAt && Date.now() - musicPlayer.libraryFillExhaustedAt < 30000) return false;
    const track = await pickRandomLibraryTrackNotInQueue();
    if (!track) {
        musicPlayer.libraryFillExhaustedAt = Date.now();
        return false;
    }
    musicPlayer.libraryFillExhaustedAt = 0;
    musicPlayer.queue.push(track);
    hydrateMusicTrackDuration(track);
    if (options.playNow) {
        setMusicCurrentIndex(musicPlayer.queue.length - 1);
        const audio = ensureBackgroundAudio();
        audio.src = track.url;
        renderMusicPlayer();
        await audio.play().catch(err => historyLog('music-player-random-library-play-failed', { fileId: track.id, error: err.message }));
    } else {
        renderMusicQueueList({ skipFocus: true });
    }
    persistMusicPlayerState();
    await persistMusicPlayerStateToSession().catch(err => historyLog('music-player-auto-append-persist-failed', {
        fileId: track.id,
        error: err.message,
        queueCount: musicPlayer.queue.length
    }));
    return true;
}

function scheduleMusicQueueTailFill() {
    if (musicPlayer.libraryFillPending || !musicPlayer.queue.length) return;
    if (musicPlayer.currentIndex < musicPlayer.queue.length - 1) return;
    const currentTrackId = getCurrentMusicTrack()?.id || '';
    const scheduledAt = Date.now();
    musicPlayer.libraryFillPending = true;
    musicPlayer.libraryFillPromise = new Promise(resolve => setTimeout(resolve, 120))
        .then(() => appendRandomLibraryTrackIfPossible({ playNow: false }))
        .then(appended => {
                if (musicPlayer.lastTrackIntentAt <= scheduledAt) restoreMusicCurrentTrackById(currentTrackId);
                return appended;
        })
        .catch(err => {
            historyLog('music-player-tail-fill-failed', { error: err.message });
            return false;
        })
        .finally(() => {
            musicPlayer.libraryFillPending = false;
            musicPlayer.libraryFillPromise = null;
        });
}

function restoreMusicCurrentTrackById(fileId) {
    if (!fileId) return false;
    const index = musicPlayer.queue.findIndex(track => track?.id === fileId);
    if (index < 0) return false;
    const alreadyCurrent = musicPlayer.currentIndex === index && musicPlayer.currentTrackId === fileId;
    setMusicCurrentIndex(index);
    if (alreadyCurrent) return false;
    renderMusicPlayer();
    return true;
}

function renderMusicPlayerActions() {
    const container = musicPlayer.overlay?.querySelector('#musicPlayerActionsStrip');
    if (!container) return;
    const track = getCurrentMusicTrack();
    container.replaceChildren();
    if (!track?.id) return;
    const favorite = isMusicTrackFavorite(track);
    const actions = [
        {
            label: favorite ? '★ 已收藏' : '☆ 收藏',
            title: favorite ? '取消收藏到媒体库' : '收藏到媒体库',
            className: favorite ? 'active' : '',
            handler: () => setMusicTrackFavorite(track, !favorite).catch(err => historyLog('music-favorite-toggle-failed', { fileId: track.id, error: err.message }))
        },
        {
            label: '🎯 定位文件',
            title: '定位到传输记录中的文件',
            handler: () => locateCurrentMusicFile()
        },
        {
            label: '分享',
            title: '生成并分享磁力链接',
            handler: () => shareCurrentMusicFile().catch(err => {
                alert(`磁链生成失败: ${err.message}`);
                historyLog('music-share-failed', { fileId: track.id, error: err.message });
            })
        },
        {
            label: '下载',
            title: '下载当前歌曲',
            handler: () => downloadFileByInfo(track.fileInfo || track, track.fileInfo?.ownerDeviceId || track.ownerDeviceId || state.deviceId).catch(err => {
                alert(`下载失败: ${err.message}`);
                historyLog('music-download-failed', { fileId: track.id, error: err.message });
            })
        }
    ];
    actions.forEach(action => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `music-player-action ${action.className || ''}`.trim();
        button.title = action.title;
        button.textContent = action.label;
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            action.handler();
        });
        container.appendChild(button);
    });
}

function locateCurrentMusicFile() {
    const track = getCurrentMusicTrack();
    if (!track?.id) return;
    minimizeMusicPlayer({ keepHistory: true });
    locateProgressFile(track.id);
}

async function shareCurrentMusicFile() {
    const track = getCurrentMusicTrack();
    if (!track?.id) return;
    await shareFileMagnetForInfo(track.fileInfo || track, track.fileInfo?.ownerDeviceId || track.ownerDeviceId || state.deviceId, track.messageId || '');
}

function openMusicPlayerOverlay(options = {}) {
    const overlay = ensureMusicPlayerOverlay();
    if (options.resetQueue) {
        musicPlayer.queueOpen = false;
        musicPlayer.queueHistoryOpen = false;
        overlay.classList.remove('queue-open');
    }
    getCurrentMusicTrack();
    overlay.classList.add('active');
    renderMusicPlayer();
    const track = getCurrentMusicTrack();
    if (track?.id) forceMusicPlayerCoverForTrack(track.id, track.poster || '');
    else requestAnimationFrame(() => syncMusicPlayerCoverElement(getCurrentMusicTrack(), { force: true }));
    if (!musicPlayer.historyOpen && options.pushHistory !== false) {
        const baseState = history.state && typeof history.state === 'object' ? history.state : {};
        history.pushState({ ...baseState, [MUSIC_PLAYER_HISTORY_KEY]: true }, '', window.location.href);
        musicPlayer.historyOpen = true;
    }
}

function ensureMusicPlayerOverlay() {
    if (musicPlayer.overlay) return musicPlayer.overlay;
    const overlay = document.createElement('div');
    overlay.id = 'musicPlayerOverlay';
    overlay.className = 'music-player-overlay';
    overlay.innerHTML = `
        <div class="music-player-topbar">
            <button class="music-player-icon-button" id="musicPlayerMinimizeBtn" type="button" title="最小化">_</button>
            <button class="music-player-icon-button" id="musicPlayerCloseBtn" type="button" title="关闭">×</button>
        </div>
        <div class="music-player-shell">
            <div class="music-player-body">
                <div class="music-player-cover" id="musicPlayerCover"></div>
                <div class="music-player-title" id="musicPlayerTitle"></div>
                <div class="music-player-subtitle" id="musicPlayerSubtitle"></div>
                <div class="music-player-actions-strip" id="musicPlayerActionsStrip"></div>
                <input class="music-player-range" id="musicPlayerRange" type="range" min="0" max="1000" value="0">
                <div class="music-player-times"><span id="musicPlayerCurrentTime">0:00</span><span id="musicPlayerDuration">0:00</span></div>
                <div class="music-player-controls">
                    <button class="music-player-icon-button music-player-skip-button" id="musicPlayerPrevBtn" type="button">❮</button>
                    <button class="music-player-main-button" id="musicPlayerPlayBtn" type="button">▶</button>
                    <button class="music-player-icon-button music-player-skip-button" id="musicPlayerNextBtn" type="button">❯</button>
                </div>
            </div>
            <div class="music-player-queue-drawer" id="musicPlayerQueueDrawer">
                <div class="music-player-queue-puller" id="musicPlayerQueuePuller" role="button" tabindex="0" aria-label="播放队列"><span>播放队列</span></div>
                <div class="music-player-queue-title">播放队列</div>
                <div class="music-player-queue-list" id="musicPlayerQueueList"></div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#musicPlayerMinimizeBtn')?.addEventListener('click', minimizeMusicPlayer);
    overlay.querySelector('#musicPlayerCloseBtn')?.addEventListener('click', closeMusicPlayer);
    overlay.querySelector('#musicPlayerPrevBtn')?.addEventListener('click', playPreviousMusicTrack);
    overlay.querySelector('#musicPlayerNextBtn')?.addEventListener('click', playNextMusicTrack);
    overlay.querySelector('#musicPlayerPlayBtn')?.addEventListener('click', toggleBackgroundMusic);
    overlay.querySelector('#musicPlayerRange')?.addEventListener('input', event => {
        const audio = ensureBackgroundAudio();
        const duration = Number(audio.duration || getCurrentMusicTrack()?.duration || 0);
        if (duration > 0) audio.currentTime = duration * (Number(event.target.value) / 1000);
        scheduleMusicPlayerPersist();
    });
    initMusicQueueDrawer(overlay);
    initMusicPlayerCoverGestures(overlay);
    musicPlayer.overlay = overlay;
    return overlay;
}

function initMusicPlayerCoverGestures(overlay) {
    const cover = overlay.querySelector('#musicPlayerCover');
    if (!cover) return;
    let gesture = null;
    cover.addEventListener('pointerdown', event => {
        gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, horizontal: false };
        cover.setPointerCapture?.(event.pointerId);
    });
    cover.addEventListener('pointermove', event => {
        if (!gesture || gesture.id !== event.pointerId) return;
        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        if (!gesture.horizontal && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.35) gesture.horizontal = true;
        if (!gesture.horizontal) return;
        event.preventDefault();
        gesture.dx = dx;
        cover.style.transform = `translateX(${Math.max(-70, Math.min(70, dx * .42))}px)`;
    });
    const finish = event => {
        if (!gesture || gesture.id !== event.pointerId) return;
        const dx = gesture.dx;
        const horizontal = gesture.horizontal;
        gesture = null;
        cover.style.transform = '';
        if (!horizontal || Math.abs(dx) < 56) return;
        if (dx < 0) playNextMusicTrack();
        else playPreviousMusicTrack();
    };
    cover.addEventListener('pointerup', finish);
    cover.addEventListener('pointercancel', finish);
}

function renderMusicPlayer() {
    const overlay = ensureMusicPlayerOverlay();
    const track = getCurrentMusicTrack();
    const cover = overlay.querySelector('#musicPlayerCover');
    const title = overlay.querySelector('#musicPlayerTitle');
    const subtitle = overlay.querySelector('#musicPlayerSubtitle');
    if (!track) return;
    syncMusicPlayerCoverElement(track);
    if (!track.poster) hydrateMusicTrackPoster(track);
    title.innerHTML = `<span>${escapeHtml(track.name || 'Audio')}</span>`;
    requestAnimationFrame(() => {
        const span = title.querySelector('span');
        title.classList.toggle('is-marquee', Boolean(span && span.scrollWidth > title.clientWidth + 8));
    });
    subtitle.textContent = `${track.artist || '未知艺术家'} · ${track.album || '未知专辑'}`;
    overlay.classList.toggle('queue-open', musicPlayer.queueOpen);
    updateMusicPlayerProgress();
    updateMusicPlayerPlayState();
    renderMusicQueueList();
    renderMusicPlayerActions();
    updateMediaSessionMetadata();
}

function syncMusicPlayerCoverElement(track = getCurrentMusicTrack(), options = {}) {
    const cover = musicPlayer.overlay?.querySelector('#musicPlayerCover');
    if (!cover || !track) return;
    const poster = track.poster || '';
    const currentImage = cover.querySelector('img');
    if (poster) {
        cover.style.backgroundImage = `url(${JSON.stringify(poster)})`;
        cover.style.backgroundSize = 'cover';
        cover.style.backgroundPosition = 'center';
        if (!options.force && (currentImage?.src === poster || currentImage?.currentSrc === poster)) return;
        const image = document.createElement('img');
        image.src = poster;
        image.alt = track.name || 'Audio';
        image.decoding = 'async';
        cover.replaceChildren(image);
        return;
    }
    cover.style.backgroundImage = '';
    cover.style.backgroundSize = '';
    cover.style.backgroundPosition = '';
    if (cover.querySelector('.music-player-cover-placeholder')) return;
    cover.innerHTML = '<div class="music-player-cover-placeholder">♪</div>';
}

function forceMusicPlayerCoverForTrack(fileId, poster = '') {
    if (!fileId) return;
    const queueTrack = musicPlayer.queue.find(track => track?.id === fileId);
    const currentTrack = getCurrentMusicTrack();
    const targetPoster = poster || queueTrack?.poster || currentTrack?.poster || '';
    if (queueTrack && targetPoster && !queueTrack.poster) {
        queueTrack.poster = targetPoster;
        if (queueTrack.fileInfo) queueTrack.fileInfo.audioPoster = targetPoster;
    }
    const apply = () => {
        const track = getCurrentMusicTrack();
        if (!track || track.id !== fileId) return;
        if (targetPoster && !track.poster) {
            track.poster = targetPoster;
            if (track.fileInfo) track.fileInfo.audioPoster = targetPoster;
        }
        syncMusicPlayerCoverElement(track, { force: true });
    };
    apply();
    requestAnimationFrame(apply);
    setTimeout(apply, 80);
    setTimeout(apply, 300);
}

function updateMusicPlayerProgress() {
    const overlay = musicPlayer.overlay;
    if (!overlay) return;
    const audio = musicPlayer.audio;
    const track = getCurrentMusicTrack();
    const duration = Number(audio?.duration || track?.duration || 0);
    const current = Number(audio?.currentTime || 0);
    if (track && duration > 0) {
        track.duration = duration;
        if (track.size && !track.bitrate) track.bitrate = `${Math.round((track.size * 8) / duration / 1000)} kbps`;
    }
    const range = overlay.querySelector('#musicPlayerRange');
    if (range) range.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : '0';
    overlay.querySelector('#musicPlayerCurrentTime').textContent = formatAudioTime(current);
    overlay.querySelector('#musicPlayerDuration').textContent = formatAudioTime(duration);
    syncActiveAudioPreviewControls();
    updateTopbarMusicState();
    updateMediaSessionPlaybackState();
    persistMusicPlayerProgressSoon();
}

function updateMusicPlayerPlayState() {
    const button = musicPlayer.overlay?.querySelector('#musicPlayerPlayBtn');
    if (button) button.textContent = isBackgroundMusicPlaying() ? '❚❚' : '▶';
    updateTopbarMusicState();
    syncActiveAudioPreviewControls();
    renderMusicQueueList();
}

function setMusicQueueOpen(open, options = {}) {
    const nextOpen = Boolean(open);
    if (nextOpen && options.pushHistory !== false && musicPlayer.historyOpen && !history.state?.[MUSIC_QUEUE_HISTORY_KEY]) {
        const baseState = history.state && typeof history.state === 'object' ? history.state : {};
        history.pushState({ ...baseState, [MUSIC_PLAYER_HISTORY_KEY]: true, [MUSIC_QUEUE_HISTORY_KEY]: true }, '', window.location.href);
        musicPlayer.queueHistoryOpen = true;
    }
    if (nextOpen && (options.fromHistory || history.state?.[MUSIC_QUEUE_HISTORY_KEY])) {
        musicPlayer.queueHistoryOpen = true;
    }
    if (!nextOpen && !options.fromHistory && musicPlayer.queueHistoryOpen && history.state?.[MUSIC_QUEUE_HISTORY_KEY]) {
        if (options.replaceHistory) {
            const baseState = history.state && typeof history.state === 'object' ? { ...history.state } : {};
            delete baseState[MUSIC_QUEUE_HISTORY_KEY];
            baseState[MUSIC_PLAYER_HISTORY_KEY] = true;
            history.replaceState(baseState, '', window.location.href);
        } else {
            history.back();
            return;
        }
    }
    musicPlayer.queueOpen = nextOpen;
    if (!nextOpen) musicPlayer.queueHistoryOpen = false;
    musicPlayer.overlay?.classList.toggle('queue-open', musicPlayer.queueOpen);
    if (musicPlayer.queueOpen) requestAnimationFrame(focusActiveMusicQueueItem);
}

function initMusicQueueDrawer(overlay) {
    const puller = overlay.querySelector('#musicPlayerQueuePuller');
    if (!puller) return;
    let suppressClickUntil = 0;
    const toggle = event => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (Date.now() < suppressClickUntil) return;
        setMusicQueueOpen(!musicPlayer.queueOpen, musicPlayer.queueOpen ? { replaceHistory: true } : {});
    };
    puller.addEventListener('click', toggle);
    puller.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
        }
    });
    puller.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
        puller.setPointerCapture?.(event.pointerId);
        musicPlayer.queueDrag = {
            startY: event.clientY,
            lastY: event.clientY,
            moved: false,
            wasOpen: musicPlayer.queueOpen
        };
    });
    puller.addEventListener('pointermove', event => {
        const drag = musicPlayer.queueDrag;
        if (!drag) return;
        event.preventDefault();
        event.stopPropagation();
        const deltaY = event.clientY - drag.startY;
        drag.lastY = event.clientY;
        if (Math.abs(deltaY) > 8) drag.moved = true;
    });
    const finish = event => {
        const drag = musicPlayer.queueDrag;
        if (!drag) return;
        event.preventDefault();
        event.stopPropagation();
        const deltaY = event.clientY - drag.startY;
        if (drag.moved) {
            if (deltaY < -58) setMusicQueueOpen(true);
            else if (deltaY > 58) setMusicQueueOpen(false, { replaceHistory: true });
            else setMusicQueueOpen(drag.wasOpen);
            suppressClickUntil = Date.now() + 240;
        }
        musicPlayer.queueDrag = null;
    };
    puller.addEventListener('pointerup', finish);
    puller.addEventListener('pointercancel', finish);
}

function renderMusicQueueList(options = {}) {
    const list = musicPlayer.overlay?.querySelector('#musicPlayerQueueList');
    if (!list) return;
    getCurrentMusicTrack();
    list.replaceChildren();
    if (!musicPlayer.queue.length) {
        const empty = document.createElement('div');
        empty.className = 'music-player-queue-meta';
        empty.textContent = '暂无播放队列';
        list.appendChild(empty);
        return;
    }
    musicPlayer.queue.forEach((track, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'music-player-queue-item';
        item.classList.toggle('active', index === musicPlayer.currentIndex);
        item.dataset.queueIndex = String(index);
        item.innerHTML = `
            <div class="music-player-queue-cover">${track.poster ? `<img src="${track.poster}" alt="${escapeHtml(track.name)}">` : '♪'}</div>
            <div>
                <div class="music-player-queue-name">${escapeHtml(track.name || 'Audio')}</div>
                <div class="music-player-queue-meta">${escapeHtml(track.artist || '未知艺术家')} · ${formatAudioTime(track.duration || 0)}</div>
            </div>
            <div class="music-player-queue-state">${index === musicPlayer.currentIndex ? (isBackgroundMusicPlaying() ? '播放中' : '当前') : ''}</div>
            <span class="music-player-queue-handle" role="button" aria-label="拖动调整队列位置" title="拖动调整队列位置">⚌</span>
        `;
        bindMusicQueueItemGestures(item, index);
        list.appendChild(item);
    });
    if (musicPlayer.queueOpen && !options.skipFocus) requestAnimationFrame(focusActiveMusicQueueItem);
}

function moveMusicQueueTrack(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= musicPlayer.queue.length || toIndex >= musicPlayer.queue.length) return;
    const activeId = getCurrentMusicTrack()?.id || '';
    const [track] = musicPlayer.queue.splice(fromIndex, 1);
    musicPlayer.queue.splice(toIndex, 0, track);
    setMusicCurrentTrackById(activeId, toIndex);
    musicPlayer.queue.forEach((item, index) => { item.queueOrder = index; });
    renderMusicQueueList({ skipFocus: true });
    persistMusicPlayerState();
}

function bindMusicQueueItemGestures(item, index) {
    const handle = item.querySelector('.music-player-queue-handle');
    let swipe = null;
    let suppressClick = false;
    item.addEventListener('click', event => {
        if (suppressClick || event.target.closest('.music-player-queue-handle')) return;
        playMusicQueueIndex(Number(item.dataset.queueIndex));
    });
    item.addEventListener('pointerdown', event => {
        if (event.target.closest('.music-player-queue-handle')) return;
        swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, horizontal: false };
        item.setPointerCapture?.(event.pointerId);
    });
    item.addEventListener('pointermove', event => {
        if (!swipe || swipe.id !== event.pointerId) return;
        const dx = event.clientX - swipe.x;
        const dy = event.clientY - swipe.y;
        if (!swipe.horizontal && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) swipe.horizontal = true;
        if (!swipe.horizontal) return;
        event.preventDefault();
        swipe.dx = dx;
        item.style.transform = `translateX(${Math.max(-110, Math.min(110, dx))}px)`;
        item.style.opacity = String(Math.max(.35, 1 - Math.abs(dx) / 180));
    });
    const finishSwipe = event => {
        if (!swipe || swipe.id !== event.pointerId) return;
        const shouldRemove = swipe.horizontal && Math.abs(swipe.dx) >= 72;
        suppressClick = swipe.horizontal;
        swipe = null;
        item.style.transform = '';
        item.style.opacity = '';
        if (shouldRemove) removeMusicTrackFromQueue(musicPlayer.queue[Number(item.dataset.queueIndex)]?.id);
        setTimeout(() => { suppressClick = false; }, 180);
    };
    item.addEventListener('pointerup', finishSwipe);
    item.addEventListener('pointercancel', finishSwipe);

    handle?.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
        handle.setPointerCapture?.(event.pointerId);
        const startIndex = Number(item.dataset.queueIndex);
        let targetIndex = startIndex;
        item.classList.add('is-dragging');
        const onMove = moveEvent => {
            if (moveEvent.pointerId !== event.pointerId) return;
            moveEvent.preventDefault();
            const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest('.music-player-queue-item');
            if (!target || target === item) return;
            const nextIndex = Number(target.dataset.queueIndex);
            if (!Number.isInteger(nextIndex)) return;
            targetIndex = nextIndex;
            item.style.transform = `translateY(${target.offsetTop - item.offsetTop}px)`;
        };
        const onEnd = endEvent => {
            if (endEvent.pointerId !== event.pointerId) return;
            item.classList.remove('is-dragging');
            item.style.transform = '';
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onEnd);
            handle.removeEventListener('pointercancel', onEnd);
            moveMusicQueueTrack(startIndex, targetIndex);
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onEnd);
        handle.addEventListener('pointercancel', onEnd);
    });
}

function focusActiveMusicQueueItem() {
    getCurrentMusicTrack();
    const list = musicPlayer.overlay?.querySelector('#musicPlayerQueueList');
    const active = list?.querySelector(`.music-player-queue-item[data-queue-index="${musicPlayer.currentIndex}"]`) ||
        list?.querySelector('.music-player-queue-item.active');
    if (!list || !active) return;
    active.scrollIntoView({ block: 'center', inline: 'nearest' });
}

function syncActiveAudioPreviewControls() {
    const controls = musicPlayer.previewControls;
    if (!controls?.fileId || !controls.toggle || !controls.range) return;
    const audio = getAudioForPreviewControls(controls.fileId);
    if (!audio) {
        resetAudioPreviewControls(controls);
        return;
    }
    const total = Number(audio.duration || 0);
    const current = Number(audio.currentTime || 0);
    controls.current.textContent = formatAudioTime(current);
    controls.duration.textContent = formatAudioTime(total);
    controls.range.value = total > 0 ? String(Math.round((current / total) * 1000)) : '0';
    controls.toggle.textContent = audio.paused ? '▶' : 'Ⅱ';
}

function getAudioForPreviewControls(fileId) {
    if (musicPlayer.tempPreviewFileId === fileId && musicPlayer.tempAudio) return musicPlayer.tempAudio;
    return null;
}

function resetAudioPreviewControls(controls = musicPlayer.previewControls) {
    if (!controls) return;
    if (controls.range) controls.range.value = '0';
    if (controls.current) controls.current.textContent = '0:00';
    if (controls.toggle) controls.toggle.textContent = '▶';
}

async function activateMusicTrack(track, options = {}) {
    if (!track?.id) return;
    musicPlayer.lastTrackIntentAt = Date.now();
    musicPlayer.libraryFillExhaustedAt = 0;
    const existingIndex = musicPlayer.queue.findIndex(item => item.id === track.id);
    const audio = ensureBackgroundAudio();
    if (existingIndex >= 0) {
        setMusicCurrentIndex(existingIndex);
        const existing = musicPlayer.queue[existingIndex];
        Object.assign(existing, track);
        track = existing;
    } else {
        const insertAt = musicPlayer.currentIndex >= 0 ? musicPlayer.currentIndex + 1 : musicPlayer.queue.length;
        musicPlayer.queue.splice(insertAt, 0, track);
        setMusicCurrentIndex(insertAt);
    }
    if (audio.src !== track.url) audio.src = track.url;
    const startTime = Number(options.startTime || 0);
    if (startTime > 0) {
        const applyStartTime = () => {
            try { audio.currentTime = startTime; } catch (_) {}
            audio.removeEventListener('loadedmetadata', applyStartTime);
        };
        if (Number.isFinite(audio.duration) && audio.duration > 0) applyStartTime();
        else audio.addEventListener('loadedmetadata', applyStartTime);
    }
    renderMusicPlayer();
    if (options.play !== false) await audio.play().catch(err => historyLog('music-player-play-failed', { fileId: track.id, error: err.message }));
    musicPlayer.miniEnabled = true;
    updateTopbarMusicState();
    scheduleMusicPlayerPersist();
    scheduleMusicQueueTailFill();
    return track;
}

async function openMusicPlayerFromActivePreview(options = {}) {
    if (!activeFilePreviewFileId || !activeFilePreviewStoredFile || !activeFilePreviewObjectUrl) return false;
    const fileInfo = await getActivePreviewFileInfo(activeFilePreviewFileId);
    const track = await buildAudioTrack(fileInfo || activeFilePreviewStoredFile, activeFilePreviewStoredFile, activeFilePreviewObjectUrl);
    await ensureMusicTrackPosterForPreview(track, fileInfo || activeFilePreviewStoredFile, activeFilePreviewStoredFile);
    if (!track.poster) {
        const latestFile = await getFromStore('files', activeFilePreviewFileId).catch(() => null);
        if (latestFile?.audioPoster) {
            track.poster = latestFile.audioPoster;
            if (track.fileInfo) track.fileInfo.audioPoster = latestFile.audioPoster;
            await preloadImageSource(latestFile.audioPoster);
        }
    }
    const tempAudio = musicPlayer.tempAudio;
    const startTime = tempAudio?.dataset?.previewFileId === activeFilePreviewFileId ? Number(tempAudio.currentTime || 0) : 0;
    handoffTemporaryPreviewToBackground(activeFilePreviewFileId);
    const activatedTrack = await activateMusicTrack(track, { play: true, startTime });
    if (!activatedTrack) return false;
    openMusicPlayerOverlay({ resetQueue:true, pushHistory:options.pushHistory });
    forceMusicPlayerCoverForTrack(activatedTrack?.id || track.id, activatedTrack?.poster || track.poster || '');
    return musicPlayer.overlay?.classList.contains('active') === true;
}

function handoffTemporaryPreviewToBackground(fileId) {
    if (musicPlayer.tempAudio) {
        musicPlayer.tempAudio.pause();
        musicPlayer.tempAudio.src = '';
    }
    musicPlayer.tempAudio = null;
    musicPlayer.tempPreviewFileId = fileId || '';
    musicPlayer.tempResumeBackground = false;
    resetAudioPreviewControls();
}

async function playMusicQueueIndex(index) {
    if (index < 0 || index >= musicPlayer.queue.length) return;
    musicPlayer.lastTrackIntentAt = Date.now();
    const track = setMusicCurrentIndex(index);
    if (!track) return;
    const audio = ensureBackgroundAudio();
    if (audio.src !== track.url) audio.src = track.url;
    renderMusicPlayer();
    await audio.play().catch(err => historyLog('music-player-queue-play-failed', { fileId: track.id, error: err.message }));
    updateTopbarMusicState();
    scheduleMusicPlayerPersist();
    scheduleMusicQueueTailFill();
}

function finishActiveRemoteMusicControl(options = {}) {
    const remoteControl = activeRemotePreviewControl;
    if (remoteControl?.presentation !== 'music') return;
    activeRemotePreviewControl = null;
    if (!options.remoteControlCommand) {
        state.socket?.emit('remote-preview-control-ended', {
            controlId:remoteControl.controlId,
            to:remoteControl.controllerDeviceId,
            reason:options.reason || 'exited'
        });
    }
}

function minimizeMusicPlayer(options = {}) {
    if (!options.fromHistory && musicPlayer.queueOpen && history.state?.[MUSIC_QUEUE_HISTORY_KEY]) {
        musicPlayer.pendingQueueExitAction = '';
        setMusicQueueOpen(false, { replaceHistory: true });
    }
    if (!options.fromHistory && musicPlayer.queueOpen) {
        setMusicQueueOpen(false, { replaceHistory: true });
    }
    const shouldGoBack = musicPlayer.historyOpen && !options.fromHistory && !options.keepHistory &&
        history.state?.[MUSIC_PLAYER_HISTORY_KEY] === true;
    if (shouldGoBack) {
        replaceCurrentHistoryWithoutMusicPlayer();
    }
    finishActiveRemoteMusicControl(options);
    musicPlayer.overlay?.classList.remove('active');
    musicPlayer.miniEnabled = true;
    if (!options.keepHistory) musicPlayer.historyOpen = false;
    updateTopbarMusicState();
}

function closeMusicPlayer(options = {}) {
    if (!options.fromHistory && musicPlayer.queueOpen && history.state?.[MUSIC_QUEUE_HISTORY_KEY]) {
        musicPlayer.pendingQueueExitAction = '';
        setMusicQueueOpen(false, { replaceHistory: true });
    }
    if (!options.fromHistory && musicPlayer.queueOpen) {
        setMusicQueueOpen(false, { replaceHistory: true });
    }
    const shouldGoBack = musicPlayer.historyOpen && !options.fromHistory &&
        history.state?.[MUSIC_PLAYER_HISTORY_KEY] === true;
    if (shouldGoBack) {
        musicPlayer.closeAfterHistory = false;
        replaceCurrentHistoryWithoutMusicPlayer();
    }
    finishActiveRemoteMusicControl(options);
    musicPlayer.overlay?.classList.remove('active');
    if (options.stop !== false) ensureBackgroundAudio().pause();
    musicPlayer.miniEnabled = false;
    musicPlayer.historyOpen = false;
    updateTopbarMusicState();
    scheduleMusicPlayerPersist();
}

function toggleBackgroundMusic() {
    const audio = ensureBackgroundAudio();
    if (audio.paused) audio.play().catch(err => historyLog('music-player-play-failed', { error: err.message }));
    else audio.pause();
    scheduleMusicPlayerPersist();
}

async function playNextMusicTrack(options = {}) {
    if (!musicPlayer.queue.length) return;
    const nextIndex = musicPlayer.currentIndex + 1;
    if (nextIndex < musicPlayer.queue.length) {
        await playMusicQueueIndex(nextIndex).catch(err => historyLog('music-player-next-failed', { error: err.message }));
        return;
    }
    await handleMusicQueueTail(options);
}

async function handleMusicQueueTail(options = {}) {
    if (!musicPlayer.queue.length) return;
    if (musicPlayer.libraryFillPromise) {
        await musicPlayer.libraryFillPromise;
        if (musicPlayer.currentIndex + 1 < musicPlayer.queue.length) {
            await playMusicQueueIndex(musicPlayer.currentIndex + 1)
                .catch(err => historyLog('music-player-next-preloaded-failed', { error: err.message }));
            return;
        }
    }
    const exhaustedRecently = musicPlayer.libraryFillExhaustedAt && Date.now() - musicPlayer.libraryFillExhaustedAt < 30000;
    const canTryAppend = !musicPlayer.libraryFillPending && !exhaustedRecently;
    const appended = canTryAppend
        ? await appendRandomLibraryTrackIfPossible({ playNow: false }).catch(err => {
            historyLog('music-player-random-library-failed', { error: err.message });
            return false;
        })
        : false;
    if (appended) {
        await playMusicQueueIndex(musicPlayer.currentIndex + 1).catch(err => historyLog('music-player-next-random-failed', { error: err.message }));
        return;
    }
    await playMusicQueueIndex(0).catch(err => historyLog(options.fromEnded ? 'music-player-ended-loop-failed' : 'music-player-next-first-failed', { error: err.message }));
}

async function playPreviousMusicTrack() {
    if (!musicPlayer.queue.length) return;
    await playMusicQueueIndex((musicPlayer.currentIndex - 1 + musicPlayer.queue.length) % musicPlayer.queue.length)
        .catch(err => historyLog('music-player-prev-failed', { error: err.message }));
}

function pauseBackgroundForTemporaryPreview(fileId) {
    const shouldResumeLater = musicPlayer.tempResumeBackground || isBackgroundMusicPlaying();
    if (musicPlayer.tempAudio) {
        musicPlayer.tempAudio.pause();
        musicPlayer.tempAudio.src = '';
    }
    musicPlayer.tempResumeBackground = shouldResumeLater;
    musicPlayer.tempPreviewFileId = fileId || '';
    if (musicPlayer.tempResumeBackground) ensureBackgroundAudio().pause();
}

function stopTemporaryAudioPreview(options = {}) {
    const audio = musicPlayer.tempAudio;
    const shouldResume = options.resumeBackground !== false && musicPlayer.tempResumeBackground;
    if (audio) {
        audio.pause();
        audio.src = '';
    }
    resetAudioPreviewControls();
    musicPlayer.tempAudio = null;
    musicPlayer.tempPreviewFileId = '';
    musicPlayer.tempResumeBackground = false;
    if (shouldResume && getCurrentMusicTrack()) {
        ensureBackgroundAudio().play()
            .then(() => showAppToast('后台音乐已恢复播放'))
            .catch(err => historyLog('music-background-resume-failed', { error: err.message }));
    }
}

function renderAudioPreview(content, fileInfo, storedFile, url) {
    setFilePreviewContentStage('preview-media-stage');
    content.replaceChildren();
    pauseBackgroundForTemporaryPreview(fileInfo.id);
    const poster = storedFile.audioPoster || '';
    const wrapper = document.createElement('div');
    wrapper.className = 'audio-preview-player';
    wrapper.innerHTML = `
        <div class="audio-preview-cover">
            ${poster ? `<img src="${poster}" alt="${escapeHtml(fileInfo.name || '')}">` : '<div class="audio-preview-cover-placeholder">♪</div>'}
            <button class="audio-preview-toggle" type="button" aria-label="播放或暂停">▶</button>
        </div>
        <div class="audio-preview-name">${escapeHtml(fileInfo.name || storedFile.name || 'Audio')}</div>
        <div class="audio-preview-progress">
            <input class="audio-preview-range" type="range" min="0" max="1000" value="0">
            <div class="audio-preview-time"><span>0:00</span><span>0:00</span></div>
        </div>
    `;
    const audio = new Audio(url);
    audio.autoplay = true;
    audio.preload = 'metadata';
    audio.dataset.previewFileId = fileInfo.id;
    if (!poster) {
        ensureAudioPosterCacheShared(storedFile, fileInfo)
            .then(generatedPoster => {
                if (!generatedPoster) return;
                updateActiveAudioPreviewPoster(fileInfo.id, generatedPoster);
                updateMusicQueueTrackPoster(fileInfo.id, generatedPoster);
            })
            .catch(err => historyLog('audio-preview-poster-hydrate-failed', { fileId: fileInfo.id, error: err.message }));
    }
    musicPlayer.tempAudio = audio;
    musicPlayer.tempPreviewFileId = fileInfo.id;
    const toggle = wrapper.querySelector('.audio-preview-toggle');
    const range = wrapper.querySelector('.audio-preview-range');
    const current = wrapper.querySelector('.audio-preview-time span:first-child');
    const duration = wrapper.querySelector('.audio-preview-time span:last-child');
    musicPlayer.previewControls = {
        fileId: fileInfo.id,
        toggle,
        range,
        current,
        duration
    };
    const sync = () => {
        const targetAudio = getAudioForPreviewControls(fileInfo.id);
        if (!targetAudio) {
            resetAudioPreviewControls(musicPlayer.previewControls);
            return;
        }
        const total = Number(targetAudio.duration || 0);
        current.textContent = formatAudioTime(targetAudio.currentTime || 0);
        duration.textContent = formatAudioTime(total);
        range.value = total > 0 ? String(Math.round((targetAudio.currentTime / total) * 1000)) : '0';
        toggle.textContent = targetAudio.paused ? '▶' : 'Ⅱ';
    };
    audio.addEventListener('timeupdate', sync);
    audio.addEventListener('loadedmetadata', sync);
    audio.addEventListener('play', sync);
    audio.addEventListener('pause', sync);
    range.addEventListener('input', () => {
        const targetAudio = getAudioForPreviewControls(fileInfo.id);
        if (!targetAudio) return;
        const total = Number(targetAudio.duration || 0);
        if (total > 0) {
            targetAudio.currentTime = total * (Number(range.value) / 1000);
            scheduleMusicPlayerPersist();
        }
    });
    toggle.addEventListener('click', () => {
        let targetAudio = getAudioForPreviewControls(fileInfo.id);
        if (!targetAudio) {
            pauseBackgroundForTemporaryPreview(fileInfo.id);
            audio.src = url;
            audio.currentTime = 0;
            audio.dataset.previewFileId = fileInfo.id;
            musicPlayer.tempAudio = audio;
            musicPlayer.tempPreviewFileId = fileInfo.id;
            targetAudio = audio;
        }
        if (targetAudio.paused) targetAudio.play().catch(err => historyLog('audio-preview-play-failed', { fileId: fileInfo.id, error: err.message }));
        else targetAudio.pause();
        sync();
    });
    content.appendChild(wrapper);
    audio.play().catch(err => historyLog('audio-preview-autoplay-failed', { fileId: fileInfo.id, error: err.message }));
    sync();
}

async function openFilePreviewForInfo(fileInfo, options = {}) {
    if (!fileInfo?.id) return false;
    const title = document.getElementById('filePreviewTitle');
    const content = setFilePreviewContentStage('preview-loading-stage');
    if (!content || !title) return false;

    const collectionContextId = options.collectionContextId || options.collectionMessageId || '';
    const returnCollectionMessageId = options.returnToCollection === false ? '' : (options.collectionMessageId || '');
    activeFilePreviewMode = 'file';
    activeCollectionPreviewMessageId = collectionContextId;
    activeFilePreviewFileId = fileInfo.id;
    activeFilePreviewMessageId = options.messageId || '';
    const ownerDeviceId = options.ownerDeviceId || fileInfo.ownerDeviceId || options.sender || '';
    activeFilePreviewOwnerDeviceId = ownerDeviceId;
    activeFilePreviewCanFullscreen = false;
    activeFilePreviewMediaType = '';
    activeFilePreviewStoredFile = null;
    activeFilePreviewObjectUrl = '';
    setFilePreviewFullscreenButton(false);
    setFilePreviewLightShareButton(true);
    setFilePreviewMusicButton(false);
    setFilePreviewRemoteButton(false);

    setFilePreviewTitle(fileInfo.name);
    renderFilePreviewLoading(content, fileInfo);
    const viewer = document.getElementById('filePreviewViewer');
    openFilePreviewHistory(viewer, {
        nested: Boolean(returnCollectionMessageId),
        stage: returnCollectionMessageId ? 'file' : 'file-root'
    });
    filePreviewReturnCollectionMessageId = returnCollectionMessageId;

    const persistedFile = await materializeCachedFileRecord(await getFromStore('files', fileInfo.id));
    let storedFile = persistedFile;
    if (persistedFile?.externalFileHandle) {
        storedFile = await materializeExternalFileRecord(persistedFile, { requestPermission: true });
    }
    const beforeExternalSourceState = getExternalFileSourceState(persistedFile, persistedFile, fileInfo);
    const externalSourceState = await syncExternalFileSourceUi(fileInfo.id, persistedFile, storedFile, fileInfo);
    setFilePreviewTitle(fileInfo.name, {
        handleSourceOnly: externalSourceState.handleSourceOnly,
        handleReadable: externalSourceState.handleReadable
    });
    if (beforeExternalSourceState.handleSourceOnly !== externalSourceState.handleSourceOnly ||
        persistedFile?.externalFileAvailable !== storedFile?.externalFileAvailable ||
        persistedFile?.externalFileMissing !== storedFile?.externalFileMissing ||
        persistedFile?.externalFilePermissionRequired !== storedFile?.externalFilePermissionRequired) {
        await refreshCollectionMessagesForFile(fileInfo.id);
        await refreshCollectionPreviewCardForFile(fileInfo.id, collectionContextId);
    }
    if (!hasCompleteFileCache(storedFile, fileInfo)) {
        if (options.requestMissing === true && fileInfo.isServerAsset && fileInfo.serverAssetUrl) {
            await requestServerAssetWithPeerPreference(fileInfo, ownerDeviceId, 'file-preview-request-missing', { priority: true })
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
        renderFileMetadataPreview(content, fileInfo, getMissingFileStateLabel(storedFile || fileInfo));
        await renderSingleFilePreviewActions({
            messageId: options.messageId || '',
            fileInfo,
            ownerDeviceId,
            collectionMessageId: collectionContextId,
            hasLocalData: false,
            cacheCleared: Boolean(storedFile?.cacheCleared),
            restoreRequested: Boolean(storedFile?.restoreRequested),
            handleReadable: externalSourceState.handleReadable
        });
        historyLog('file-preview-opened-without-cache', {
            messageId: options.messageId,
            collectionMessageId: collectionContextId,
            fileId: fileInfo.id
        });
        await updateFilePreviewNavigationControls();
        return true;
    }

    const type = String(fileInfo.type || storedFile.type || '').toLowerCase();
    activeFilePreviewStoredFile = storedFile;
    if (!isPreviewableFileType(type)) {
        renderFileMetadataPreview(content, fileInfo, '不可直接预览');
        await renderSingleFilePreviewActions({
            messageId: options.messageId || '',
            fileInfo,
            ownerDeviceId,
            collectionMessageId: collectionContextId,
            hasLocalData: true,
            handleSourceOnly: externalSourceState.handleSourceOnly,
            handleReadable: externalSourceState.handleReadable
        });
        historyLog('file-preview-opened-as-metadata', {
            messageId: options.messageId,
            collectionMessageId: collectionContextId,
            fileId: fileInfo.id,
            type
        });
        await updateFilePreviewNavigationControls();
        return true;
    }

    setFilePreviewContentStage(isVisualPreviewableType(type) ? 'preview-media-stage' : 'preview-metadata-stage');
    content.replaceChildren();

    const url = getStoredFileUrl(fileInfo.id, storedFile);
    activeFilePreviewObjectUrl = url;
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
        const poster = getCachedMediaPosterOrQueue(storedFile, fileInfo);
        if (poster) video.poster = poster;
        video.dataset.previewFileId = fileInfo.id;
        video.className = 'file-preview-media file-preview-media-video';
        content.appendChild(video);
        fitPreviewMediaElement(video, content);
        video.play().catch(() => {});
    } else if (type.startsWith('audio/')) {
        renderAudioPreview(content, fileInfo, storedFile, url);
    }

    activeFilePreviewCanFullscreen = isFullscreenPreviewableType(type);
    activeFilePreviewMediaType = type;
    setFilePreviewFullscreenButton(activeFilePreviewCanFullscreen);
    setFilePreviewMusicButton(type.startsWith('audio/'));
    setFilePreviewRemoteButton(true);
    await renderSingleFilePreviewActions({
        messageId: options.messageId || '',
        fileInfo,
        ownerDeviceId,
        collectionMessageId: collectionContextId,
        hasLocalData: true,
        handleSourceOnly: externalSourceState.handleSourceOnly,
        handleReadable: externalSourceState.handleReadable
    });
    historyLog('file-preview-opened', {
        messageId: options.messageId,
        collectionMessageId: collectionContextId,
        fileId: fileInfo.id,
        type,
        handleSourceOnly: externalSourceState.handleSourceOnly
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
    const addFileInfo = async (fileInfo, messageId = '') => {
        if (!fileInfo?.id) return;
        const persistedFile = await getFromStore('files', fileInfo.id).catch(() => null);
        const storedFile = persistedFile?.externalFileHandle
            ? await materializeExternalFileRecord(persistedFile, { requestPermission: false })
            : persistedFile;
        if (!hasCompleteFileCache(storedFile, fileInfo)) return;
        const type = String(fileInfo.type || storedFile.type || '').toLowerCase();
        if (!isFullscreenPreviewableType(type)) return;
        items.push({ fileInfo, storedFile, type, url: getStoredFileUrl(fileInfo.id, storedFile), messageId });
    };

    const messages = (await getCurrentSessionMessages().catch(() => []))
        .filter(message => message?.id)
        .sort(compareHistoryMessages);
    for (const message of messages) {
        if (message.type === 'collection') {
            for (const fileInfo of getCollectionFiles(message)) {
                await addFileInfo(fileInfo, message.id);
            }
        } else if (message.type === 'file' && message.fileInfo?.id) {
            await addFileInfo(message.fileInfo, message.id);
        }
    }

    if (!items.length && activeCollectionPreviewMessageId) {
        const message = await getFromStore('messages', activeCollectionPreviewMessageId).catch(() => null);
        for (const fileInfo of getCollectionFiles(message)) {
            const persistedFile = await getFromStore('files', fileInfo.id).catch(() => null);
            const storedFile = persistedFile?.externalFileHandle
                ? await materializeExternalFileRecord(persistedFile, { requestPermission: true })
                : persistedFile;
            if (!hasCompleteFileCache(storedFile, fileInfo)) continue;
            const type = String(fileInfo.type || storedFile.type || '').toLowerCase();
            if (!isFullscreenPreviewableType(type)) continue;
            items.push({ fileInfo, storedFile, type, url: getStoredFileUrl(fileInfo.id, storedFile), messageId: activeCollectionPreviewMessageId });
        }
    } else if (!items.length && activeFilePreviewFileId) {
        const fileInfo = await getActivePreviewFileInfo(activeFilePreviewFileId);
        const persistedFile = await getFromStore('files', activeFilePreviewFileId).catch(() => null);
        const storedFile = persistedFile?.externalFileHandle
            ? await materializeExternalFileRecord(persistedFile, { requestPermission: true })
            : persistedFile;
        const type = String(fileInfo?.type || storedFile?.type || '').toLowerCase();
        if (fileInfo?.id && hasCompleteFileCache(storedFile, fileInfo) && isFullscreenPreviewableType(type)) {
            items.push({ fileInfo, storedFile, type, url: getStoredFileUrl(fileInfo.id, storedFile), messageId: activeFilePreviewMessageId });
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
    if (item.type.startsWith('audio/')) {
        const card = document.createElement('div');
        card.className = 'media-fullscreen-audio-card';
        const cover = document.createElement('div');
        cover.className = 'media-fullscreen-audio-cover';
        const poster = getCachedMediaPosterOrQueue(item.storedFile, item.fileInfo);
        if (poster) {
            const image = document.createElement('img');
            image.src = poster;
            image.alt = '';
            cover.appendChild(image);
        } else {
            cover.textContent = '♪';
        }
        const audio = document.createElement('audio');
        audio.src = item.url;
        audio.controls = true;
        audio.autoplay = true;
        audio.preload = 'metadata';
        card.append(cover, audio);
        audio.addEventListener('canplay', () => audio.play().catch(() => {}), { once:true });
        return card;
    }
    return null;
}

function getMediaFullscreenGroupCounter() {
    const item = mediaFullscreenItems[mediaFullscreenIndex];
    if (!item?.messageId) return '';
    const group = mediaFullscreenItems.filter(entry => entry.messageId === item.messageId);
    if (group.length <= 1) return '';
    const groupIndex = group.findIndex(entry => entry.fileInfo?.id === item.fileInfo?.id);
    return `${groupIndex >= 0 ? groupIndex + 1 : 1} / ${group.length}`;
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
    counter.textContent = getMediaFullscreenGroupCounter();
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
            if (['IMG', 'VIDEO'].includes(media.tagName)) fitPreviewMediaElement(media, content);
            if (media.tagName === 'VIDEO') media.play().catch(() => {});
            if (media.classList.contains('media-fullscreen-audio-card')) media.querySelector('audio')?.play().catch(() => {});
        }
    }

    historyLog('media-fullscreen-rendered', {
        fileId: item.fileInfo.id,
        index: mediaFullscreenIndex,
        count: mediaFullscreenItems.length,
        reusedActivePreviewMedia: Boolean(reusableMedia)
    });
}

function getRemotePreviewFullscreenState(options = {}) {
    const presentation = options.presentation || activeRemotePreviewControl?.presentation || 'media';
    if (presentation === 'music') {
        const track = getCurrentMusicTrack();
        const audio = musicPlayer.audio;
        return {
            fileId:track?.id || '',
            fileName:track?.fileInfo?.name || track?.name || '音乐播放',
            mediaType:String(track?.type || track?.fileInfo?.type || 'audio/*').toLowerCase(),
            playing:Boolean(audio && !audio.paused && !audio.ended)
        };
    }
    const item = mediaFullscreenItems[mediaFullscreenIndex];
    const media = document.getElementById('mediaFullscreenContent')?.querySelector('video, audio');
    return {
        fileId:item?.fileInfo?.id || '',
        fileName:item?.fileInfo?.name || '文件预览',
        mediaType:String(item?.type || item?.fileInfo?.type || '').toLowerCase(),
        playing:Boolean(media && !media.paused && !media.ended)
    };
}

async function findRemotePreviewAdjacentItem(delta) {
    const currentFileId = mediaFullscreenItems[mediaFullscreenIndex]?.fileInfo?.id || activeRemotePreviewControl?.fileId || '';
    if (!currentFileId) return null;
    const candidates = [];
    const seen = new Set();
    const add = (fileInfo, messageId) => {
        if (!fileInfo?.id || seen.has(fileInfo.id)) return;
        seen.add(fileInfo.id);
        candidates.push({ fileInfo, messageId });
    };
    const messages = (await getCurrentSessionMessages().catch(() => []))
        .filter(message => message?.id)
        .sort(compareHistoryMessages);
    for (const message of messages) {
        if (message.type === 'collection') getCollectionFiles(message).forEach(fileInfo => add(fileInfo, message.id));
        else if (message.type === 'file') add(message.fileInfo, message.id);
    }
    const currentIndex = candidates.findIndex(entry => entry.fileInfo.id === currentFileId);
    if (currentIndex < 0 || candidates.length <= 1) return null;
    const direction = delta < 0 ? -1 : 1;
    for (let step = 1; step < candidates.length; step += 1) {
        const candidate = candidates[(currentIndex + direction * step + candidates.length) % candidates.length];
        const persisted = await getFromStore('files', candidate.fileInfo.id).catch(() => null);
        const storedFile = persisted?.externalFileHandle
            ? await materializeExternalFileRecord(persisted, { requestPermission:false })
            : await materializeCachedFileRecord(persisted);
        if (!hasCompleteFileCache(storedFile, candidate.fileInfo)) continue;
        const type = String(candidate.fileInfo.type || storedFile?.type || '').toLowerCase();
        if (!isFullscreenPreviewableType(type)) continue;
        return {
            fileInfo:candidate.fileInfo,
            storedFile,
            type,
            url:getStoredFileUrl(candidate.fileInfo.id, storedFile),
            messageId:candidate.messageId
        };
    }
    return null;
}

async function handleRemotePreviewControl(data) {
    const control = activeRemotePreviewControl;
    const action = String(data?.action || '');
    const presentation = control?.presentation || 'media';
    let ok = false;
    let reason = 'control-session-invalid';
    try {
        if (!control || control.controlId !== data?.controlId || control.controllerDeviceId !== data?.from) throw new Error(reason);
        if (presentation === 'music') {
            if (!musicPlayer.overlay?.classList.contains('active') || !getCurrentMusicTrack()) throw new Error('fullscreen-not-active');
            if (action === 'previous' || action === 'next') {
                if (action === 'previous') await playPreviousMusicTrack();
                else await playNextMusicTrack();
                control.fileId = getCurrentMusicTrack()?.id || control.fileId;
            } else if (action === 'toggle-playback') {
                const audio = ensureBackgroundAudio();
                if (audio.paused || audio.ended) {
                    await audio.play().catch(() => { throw new Error('playback-failed'); });
                } else {
                    audio.pause();
                }
            } else if (action === 'exit') {
                closeMusicPlayer({ fromHistory:true, remoteControlCommand:true });
                activeRemotePreviewControl = null;
            } else {
                throw new Error(reason);
            }
        } else {
            if (!document.getElementById('mediaFullscreenViewer')?.classList.contains('active')) throw new Error('fullscreen-not-active');
            if (action === 'previous' || action === 'next') {
                const item = await findRemotePreviewAdjacentItem(action === 'previous' ? -1 : 1);
                if (!item) throw new Error('no-adjacent-file');
                mediaFullscreenItems = [item];
                mediaFullscreenIndex = 0;
                renderMediaFullscreenItem();
                control.fileId = item.fileInfo.id;
            } else if (action === 'toggle-playback') {
                const media = document.getElementById('mediaFullscreenContent')?.querySelector('video, audio');
                if (!media) throw new Error('playback-unavailable');
                if (media.paused || media.ended) {
                    await media.play().catch(() => { throw new Error('playback-failed'); });
                } else {
                    media.pause();
                }
            } else if (action === 'exit') {
                closeMediaFullscreen({ fromHistory:true, forceClose:true, remoteControlCommand:true });
                activeRemotePreviewControl = null;
            } else {
                throw new Error(reason);
            }
        }
        ok = true;
        reason = '';
    } catch (error) {
        reason = error.message || reason;
    } finally {
        state.socket?.emit('remote-preview-control-result', {
            controlId:data?.controlId,
            to:data?.from,
            action,
            ok,
            reason,
            ...getRemotePreviewFullscreenState({ presentation })
        });
        historyLog('remote-preview-control-handled', { controlId:data?.controlId, controllerDeviceId:data?.from, action, ok, reason });
    }
}

function navigateMediaFullscreen(delta) {
    if (!document.getElementById('mediaFullscreenViewer')?.classList.contains('active')) return;
    if (mediaFullscreenItems.length <= 1) return;
    mediaFullscreenIndex = (mediaFullscreenIndex + delta + mediaFullscreenItems.length) % mediaFullscreenItems.length;
    renderMediaFullscreenItem();
}

async function locateMediaFullscreenRecord() {
    const item = mediaFullscreenItems[mediaFullscreenIndex];
    const messageId = item?.messageId || activeCollectionPreviewMessageId || activeFilePreviewMessageId;
    if (!messageId) return;
    closeMediaFullscreen({ forceClose: true });
    closeFilePreview({ forceClose: true });
    await focusTransferRecordById(messageId, { timeoutMs: 7000 });
}

async function openActivePreviewFullscreen(options = {}) {
    if (!activeFilePreviewCanFullscreen || !activeFilePreviewFileId) return false;
    if (options.focusedOnly) {
        const storedFile = activeFilePreviewStoredFile;
        const fileInfo = {
            ...(options.focusedFileInfo || {}),
            id:activeFilePreviewFileId,
            name:options.focusedFileInfo?.name || storedFile?.name || '文件预览',
            type:options.focusedFileInfo?.type || activeFilePreviewMediaType || storedFile?.type || ''
        };
        const type = String(fileInfo.type || '').toLowerCase();
        mediaFullscreenItems = storedFile && hasCompleteFileCache(storedFile, fileInfo) && isFullscreenPreviewableType(type)
            ? [{ fileInfo, storedFile, type, url:getStoredFileUrl(fileInfo.id, storedFile), messageId:activeFilePreviewMessageId }]
            : [];
    } else {
        mediaFullscreenItems = await getFullscreenPreviewItems();
    }
    const activeIndex = mediaFullscreenItems.findIndex(item => item.fileInfo.id === activeFilePreviewFileId);
    if (!mediaFullscreenItems.length || activeIndex < 0) {
        if (!options.focusedOnly) alert('当前文件尚未缓存到本机，不能全屏预览。');
        return false;
    }
    mediaFullscreenIndex = activeIndex;
    const overlay = document.getElementById('mediaFullscreenViewer');
    if (!overlay) return false;
    overlay.classList.add('active');
    renderMediaFullscreenItem();
    if (!mediaFullscreenHistoryOpen) {
        const baseState = history.state && typeof history.state === 'object' ? history.state : {};
        history.pushState({ ...baseState, [MEDIA_FULLSCREEN_HISTORY_KEY]: true }, '', window.location.href);
        mediaFullscreenHistoryOpen = true;
    }
    return true;
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
    const remoteControl = activeRemotePreviewControl;
    activeRemotePreviewControl = null;
    if (remoteControl && !options.remoteControlCommand) {
        state.socket?.emit('remote-preview-control-ended', {
            controlId:remoteControl.controlId,
            to:remoteControl.controllerDeviceId,
            reason:'exited'
        });
    }
    if (shouldGoBack) {
        suppressNextFilePreviewPopstate = document.getElementById('filePreviewViewer')?.classList.contains('active') === true;
        history.back();
    }
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
    const shouldReturnToCollection = Boolean(filePreviewReturnCollectionMessageId);
    await openFilePreviewForInfo(nextFile, {
        messageId: activeCollectionPreviewMessageId,
        collectionMessageId: shouldReturnToCollection ? activeCollectionPreviewMessageId : '',
        collectionContextId: activeCollectionPreviewMessageId,
        returnToCollection: shouldReturnToCollection,
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
    const persistedFile = await getFromStore('files', fileInfo.id).catch(() => null);
    let storedFile = persistedFile;
    if (persistedFile?.externalFileHandle) storedFile = await materializeExternalFileRecord(persistedFile);
    const externalSourceState = getExternalFileSourceState(persistedFile, storedFile, fileInfo);
    const hasLocalData = hasCompleteFileCache(storedFile, fileInfo);
    const type = String(fileInfo.type || storedFile?.type || '').toLowerCase();
    const isAudioLike = isAudioFileLike(storedFile, fileInfo);
    if (hasLocalData && type.startsWith('image/')) {
        const url = getStoredFileUrl(fileInfo.id, storedFile);
        const image = document.createElement('img');
        image.src = url;
        image.alt = fileInfo.name || '';
        image.loading = 'lazy';
        image.decoding = 'async';
        thumb.appendChild(image);
    } else if (hasLocalData && type.startsWith('video/')) {
        const poster = getCachedMediaPosterOrQueue(storedFile, fileInfo);
        if (poster) {
            const image = document.createElement('img');
            image.src = poster;
            image.alt = fileInfo.name || '';
            image.loading = 'lazy';
            image.decoding = 'async';
            thumb.appendChild(image);
            thumb.insertAdjacentHTML('beforeend', renderMediaKindBadge('video'));
        }
    } else if (hasLocalData && (type.startsWith('audio/') || isAudioLike)) {
        const poster = getCachedMediaPosterOrQueue(storedFile, fileInfo);
        if (poster) {
            const image = document.createElement('img');
            image.src = poster;
            image.alt = fileInfo.name || '';
            image.loading = 'lazy';
            image.decoding = 'async';
            thumb.appendChild(image);
            thumb.insertAdjacentHTML('beforeend', renderMediaKindBadge('audio'));
        }
    }
    if (!thumb.childNodes.length) {
        thumb.classList.add('collection-file-thumb--metadata');
        const recoveryStage = serverAssetRecoveries.stages.get(fileInfo.id);
        const stateLabel = hasLocalData
            ? (type.startsWith('video/') ? '视频' : type.startsWith('audio/') ? '音频' : '不可预览')
            : (recoveryStage?.label || (storedFile?.cacheCleared ? '缓存已清理' : '本机未缓存'));
        thumb.innerHTML = `
            <div class="file-icon">${getFileIcon(fileInfo.type || '')}</div>
            <div class="collection-file-state">${escapeHtml(stateLabel)}</div>
        `;
        if (type.startsWith('video/')) thumb.insertAdjacentHTML('beforeend', renderMediaKindBadge('video'));
        if (type.startsWith('audio/') || isAudioLike) thumb.insertAdjacentHTML('beforeend', renderMediaKindBadge('audio'));
    }

    const name = document.createElement('div');
    name.className = 'collection-file-name';
    name.textContent = fileInfo.name || '未知文件';
    const size = document.createElement('div');
    size.className = 'collection-file-size';
    size.textContent = formatFileSize(Number(fileInfo.size) || 0);
    card.append(thumb, name, size);
    syncCollectionFileFavoriteBadge(card, await isFileFavorite(fileInfo));
    if (externalSourceState.handleReadable) {
        const badge = document.createElement('span');
        badge.className = 'external-file-badge';
        badge.title = '内容按需读取自供源设备的本机文件系统';
        badge.textContent = '💾 外部文件';
        card.appendChild(badge);
    }
    card.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        runExclusiveFilePreviewOpen(() => {
            captureCollectionPreviewReturnState(collectionMessageId, fileInfo.id);
            return openFilePreviewForInfo(fileInfo, {
                messageId: collectionMessageId,
                collectionMessageId,
                ownerDeviceId: fileInfo.ownerDeviceId,
                requestMissing: false
            });
        }, {
            messageId: collectionMessageId,
            fileId: fileInfo.id
        });
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
        const storedFile = await materializeCachedFileRecord(await getFromStore('files', fileInfo.id).catch(() => null));
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

async function collectionFileHasUsableLocalSource(fileInfo) {
    if (!fileInfo?.id) return true;
    const storedFile = await getFromStore('files', fileInfo.id).catch(() => null);
    if (hasCompleteFileCache(storedFile, fileInfo)) return true;
    if (storedFile?.externalFileHandle) {
        const readableFile = await materializeExternalFileRecord(storedFile);
        const sourceState = getExternalFileSourceState(storedFile, readableFile, fileInfo);
        return sourceState.handleReadable;
    }
    return false;
}

function canRestoreCollectionFile(fileInfo) {
    if (!fileInfo?.id) return false;
    if (fileInfo.isServerAsset && fileInfo.serverAssetUrl) return true;
    return Boolean(fileInfo.isAsset && fileAssetTransfer);
}

async function restoreMissingCollectionFiles(files, collectionMessageId = '') {
    const missingFiles = [];
    let unavailableCount = 0;
    for (const fileInfo of files) {
        if (!fileInfo?.id) continue;
        if (await collectionFileHasUsableLocalSource(fileInfo)) continue;
        if (!canRestoreCollectionFile(fileInfo)) {
            unavailableCount++;
            continue;
        }
        missingFiles.push(fileInfo);
    }
    if (!missingFiles.length) {
        showAppToast(unavailableCount > 0 ? '合辑内缺失文件暂无可用来源' : '合辑内文件均已缓存');
        return;
    }

    showAppToast(`正在还原 ${missingFiles.length} 个缺失文件`);
    let requested = 0;
    let failed = 0;
    for (const fileInfo of missingFiles) {
        try {
            await restoreFileCacheByInfo(fileInfo, fileInfo.ownerDeviceId || null, collectionMessageId, {
                collectionMessageId,
                force: false,
                preserveCollectionDownloads: true
            });
            requested++;
        } catch (err) {
            failed++;
            historyLog('collection-restore-missing-file-failed', {
                messageId: collectionMessageId,
                fileId: fileInfo.id,
                error: err.message
            });
        }
    }
    historyLog('collection-restore-missing-requested', {
        messageId: collectionMessageId,
        totalCount: files.length,
        missingCount: missingFiles.length,
        requested,
        failed,
        unavailableCount
    });
    showAppToast(failed > 0 ? `已请求还原 ${requested} 个文件，${failed} 个失败` : `已请求还原 ${requested} 个缺失文件`);
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
    setFilePreviewLightShareButton(false);
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
    setCollectionPreviewActions(files, messageId);
    openFilePreviewHistory(document.getElementById('filePreviewViewer'), { stage: 'collection' });
    historyLog('collection-preview-opened', { messageId, fileCount: files.length });
}

function setCollectionPreviewActions(files, messageId) {
    setFilePreviewActions([
        createFileActionButton('还原所有文件', '仅拉取合辑内尚未缓存的文件', event => {
            const button = event.currentTarget;
            button.disabled = true;
            restoreMissingCollectionFiles(files, messageId)
                .catch(err => {
                    alert(`合辑还原失败: ${err.message}`);
                    historyLog('collection-restore-missing-failed', { messageId, error: err.message });
                })
                .finally(() => {
                    button.disabled = false;
                });
        }),
        createFileActionButton('下载全部', '拉取缺失缓存后打包下载整个合辑 ZIP', () => {
            downloadCollectionFiles(files, messageId).catch(err => {
                alert(`合辑下载失败: ${err.message}`);
                historyLog('collection-download-failed', { messageId, error: err.message });
            });
        })
    ]);
}

function attachCollectionRecordInteractions(messageEl) {
    const messageId = messageEl.dataset.messageId;
    messageEl.addEventListener('click', event => {
        if (event.target.closest('.file-cache-retry, .message-record-actions')) return;
        const tile = event.target.closest('.collection-preview-tile[data-collection-file-id]');
        if (tile) {
            const fileId = tile.dataset.collectionFileId || '';
            if (fileId) {
                event.preventDefault();
                event.stopPropagation();
                runExclusiveFilePreviewOpen(async () => {
                    const message = await getFromStore('messages', messageId);
                        const fileInfo = getCollectionFiles(message).find(file => file.id === fileId);
                        if (!fileInfo) return openCollectionRecord(messageId);
                        return openFilePreviewForInfo(fileInfo, {
                            messageId,
                            ownerDeviceId: fileInfo.ownerDeviceId || message?.sender,
                            sender: message?.sender,
                            collectionContextId: messageId,
                            returnToCollection: false,
                            requestMissing: false
                        });
                }, { messageId, fileId });
                return;
            }
        }
        runExclusiveFilePreviewOpen(() => openCollectionRecord(messageId), { messageId });
    });
}

function attachFileRecordInteractions(messageEl) {
    let longPressTimer = null;
    let suppressClickUntil = 0;
    let startPoint = null;
    const messageId = messageEl.dataset.messageId;
    const isAction = target => Boolean(target.closest('.file-actions, .file-cache-retry, .message-record-actions'));
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
        runExclusiveFilePreviewOpen(() => openFileRecord(messageId), { messageId });
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
                <div class="file-size">${formatFileSize(fileInfo.size)} (${escapeHtml(label)})</div>
            </div>
        `;
        renderFileMessageActions(messageEl, fileInfo, { hasLocalData: false, cacheCleared, restoreRequested });
    }));
}

async function refreshFileMessage(fileId) {
    const persistedFile = await getFromStore('files', fileId);
    const storedFile = persistedFile?.externalFileHandle
        ? await materializeExternalFileRecord(persistedFile)
        : persistedFile;
    if (!hasCompleteFileCache(storedFile)) return;
    hideCompletedFileReceiveProgress(fileId);
    const externalSourceState = getExternalFileSourceState(persistedFile, storedFile, storedFile);

    let url = fileObjectUrls.get(fileId);
    if (!url) {
        url = URL.createObjectURL(new Blob([storedFile.data], { type: storedFile.type }));
        fileObjectUrls.set(fileId, url);
    }

    const poster = getCachedMediaPosterOrQueue(storedFile, storedFile);

    const renderedMessages = Array.from(document.querySelectorAll(`.message[data-file-id="${fileId}"]`));
    preserveChatScroll(() => renderedMessages.forEach(messageEl => {
        const fileInfo = getFileInfoFromMessageElement(messageEl);
        const type = fileInfo.type || storedFile.type;
        const isAudioLike = isAudioFileLike(storedFile, fileInfo);
        const name = escapeHtml(fileInfo.name || storedFile.name);
        const bubble = messageEl.querySelector('.message-bubble');
        if (!bubble) return;

        if (type.startsWith('image/')) {
            bubble.innerHTML = `<div class="media-preview"><img src="${url}" alt="${name}" loading="lazy" decoding="async"></div><div class="file-size media-file-size">${formatFileSize(storedFile.size)}</div>`;
            bubble.classList.remove('file-message');
            bubble.style.opacity = '';
        } else if (type.startsWith('video/')) {
            bubble.innerHTML = `<div class="media-preview">${poster ? `<img src="${poster}" alt="${name}" loading="lazy" decoding="async">` : `<span class="collection-video-placeholder" aria-label="视频文件">🎬</span>`}${renderMediaKindBadge('video')}</div><div class="file-name media-file-name">${name}</div><div class="file-size media-file-size">${formatFileSize(storedFile.size)}</div>`;
            bubble.classList.remove('file-message');
            bubble.style.opacity = '';
        } else if (type.startsWith('audio/') || isAudioLike) {
            bubble.innerHTML = `<div class="media-preview">${poster ? `<img src="${poster}" alt="${name}" loading="lazy" decoding="async">` : `<span class="collection-video-placeholder" aria-label="音频文件">🎵</span>`}${renderMediaKindBadge('audio')}</div><div class="file-name media-file-name">${name}</div><div class="file-size media-file-size">${formatFileSize(storedFile.size)}</div>`;
            bubble.classList.remove('file-message');
            bubble.style.opacity = '';
        } else {
            bubble.style.opacity = '';
            bubble.removeAttribute('onclick');
            const size = bubble.querySelector('.file-size');
            if (size) size.textContent = formatFileSize(storedFile.size);
        }
        syncFileMessageExternalSourceBadge(messageEl, externalSourceState.handleReadable);
        renderFileMessageActions(messageEl, fileInfo, { hasLocalData: true, cacheCleared: false });
    }));
    for (const messageEl of renderedMessages) {
        const message = await getFromStore('messages', messageEl.dataset.messageId).catch(() => null);
        const remarkText = String(message?.remark || message?.fileInfo?.remark || '').trim();
        messageEl.querySelector('.collection-remark')?.remove();
        if (remarkText) {
            const remark = document.createElement('div');
            remark.className = 'collection-remark';
            remark.innerHTML = renderRemarkHtml(remarkText);
            messageEl.querySelector('.message-bubble')?.appendChild(remark);
        }
    }
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

function clearFileMessageAvailability(fileId) {
    document.querySelectorAll(`.message[data-file-id="${fileId}"]`).forEach(messageEl => {
        const size = messageEl.querySelector('.file-size');
        if (size) size.textContent = formatFileSize(Number(messageEl.dataset.fileSize || 0));
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

    const storedFile = await getFromStore('files', fileInfo.id);
    if (storedFile?.externalFileHandle) {
        const readableFile = await materializeExternalFileRecord(storedFile, { requestPermission: true });
        const sourceState = await syncExternalFileSourceUi(fileInfo.id, storedFile, readableFile, fileInfo);
        if (sourceState.handleReadable) {
            showAppToast('本机原文件仍可直接读取，没有需要释放的浏览器缓存');
            await refreshFileMessage(fileInfo.id);
            return;
        }
    }
    fileAssetTransfer?.cancel(fileInfo.id);
    if (storedFile?.externalFileHandle && storedFile.hasSafetyCopy && storedFile.safetyCopyState !== 'replicated') {
        alert('此文件绑定了本机原文件句柄，但安全副本尚未确认被其它设备完整缓存。为避免原文件移动或权限失效后无法恢复，暂不释放空间。');
        return;
    }
    await deleteCacheStoreReference(storedFile, 'clear-file-cache');
    const { data, cacheStoreRef, cacheStorage, ...metadata } = storedFile || {};
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
        await requestServerAssetWithPeerPreference(
            fileInfo,
            fileInfo.ownerDeviceId || message.sender,
            options.force ? 'message-force-restore' : 'message-restore',
            { priority: true, force: Boolean(options.force), peerWaitMs: 5000 }
        );
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
    if (!requireTunnelPermission('delete')) return;
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
    let removedCollectionFiles = [];
    if (previous?.type === 'collection' && message.type === 'collection') {
        const nextIds = new Set(getCollectionFiles(message).map(file => file.id));
        removedCollectionFiles = getCollectionFiles(previous).filter(file => !nextIds.has(file.id));
    }
    await saveToStore('messages', {
        ...message,
        sessionId: state.sessionId
    });

    const wasOwn = message.sender === state.deviceId;
    if (previous?.type === 'collection' && message.type === 'collection') {
        await updateCollectionMessageElement(message);
        await applyCollectionPreviewIncrementalUpdate(previous, message);
        const existingElement = getMessageElement(message.id);
        if (existingElement) {
            syncTransferRecordFavoriteBadge(existingElement, message);
            syncTransferRecordSnsBadge(existingElement, message);
            renderMessageRecordActions(existingElement, message);
        }
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
    if (removedCollectionFiles.length) {
        enqueueFileCacheCleanup(removedCollectionFiles.map(fileInfo => fileInfo.id), 'collection-file-removed');
    }
    if (message.type === 'rich' && activeRichMessageId === message.id && document.getElementById('richViewer')?.classList.contains('active')) {
        const container = document.getElementById('richViewerContent');
        container.innerHTML = getRichMessageContent(message);
        await hydrateEditorAssets(container);
    }
}

async function updateHistoryMessage(message) {
    await applyHistoryMessageUpdate(message);
    state.socket?.emit('update-message', {
        sessionId: state.sessionId,
        message
    });
}

function enqueueFileCacheCleanup(fileIds, reason = 'history-deleted') {
    for (const fileId of fileIds || []) {
        if (fileId) pendingFileCacheCleanupIds.add(fileId);
    }
    if (!pendingFileCacheCleanupIds.size) return;
    historyLog('file-cache-cleanup-queued', {
        reason,
        pendingCount: pendingFileCacheCleanupIds.size
    });
    scheduleFileCacheCleanup();
}

function scheduleFileCacheCleanup(delay = 900) {
    if (fileCacheCleanupRunning) return;
    if (fileCacheCleanupTimer) clearTimeout(fileCacheCleanupTimer);
    if (fileCacheCleanupIdleHandle && 'cancelIdleCallback' in window) {
        cancelIdleCallback(fileCacheCleanupIdleHandle);
        fileCacheCleanupIdleHandle = null;
    }
    fileCacheCleanupTimer = setTimeout(() => {
        fileCacheCleanupTimer = null;
        const run = () => {
            fileCacheCleanupIdleHandle = null;
            processPendingFileCacheCleanup().catch(err => {
                historyLog('file-cache-cleanup-batch-failed', { error: err.message });
                scheduleFileCacheCleanup(1800);
            });
        };
        if ('requestIdleCallback' in window) {
            fileCacheCleanupIdleHandle = requestIdleCallback(run, { timeout: 3500 });
        } else {
            setTimeout(run, 0);
        }
    }, delay);
}

async function processPendingFileCacheCleanup() {
    if (fileCacheCleanupRunning || !pendingFileCacheCleanupIds.size) return;
    fileCacheCleanupRunning = true;
    const batch = Array.from(pendingFileCacheCleanupIds).slice(0, 64);
    batch.forEach(fileId => pendingFileCacheCleanupIds.delete(fileId));
    try {
        const referencedFileIds = await findReferencedFileIds(new Set(batch));
        let deletedCount = 0;
        for (let index = 0; index < batch.length; index++) {
            const fileId = batch[index];
            if (referencedFileIds.has(fileId)) continue;
            fileAssetTransfer?.cancel(fileId);
            cleanupProgressForDeletedFile(fileId);
            const storedFile = await getFromStore('files', fileId).catch(() => null);
            await deleteCacheStoreReference(storedFile, 'pending-file-cleanup');
            await deleteFromStore('files', fileId);
            removeMusicTrackFromQueue(fileId);
            const objectUrl = fileObjectUrls.get(fileId);
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            fileObjectUrls.delete(fileId);
            deletedCount += 1;
            if (index % 4 === 3 || navigator.scheduling?.isInputPending?.()) await sleep(0);
        }
        historyLog('file-cache-cleanup-batch-completed', {
            checkedCount: batch.length,
            deletedCount,
            preservedCount: referencedFileIds.size,
            remainingCount: pendingFileCacheCleanupIds.size
        });
    } catch (err) {
        batch.forEach(fileId => pendingFileCacheCleanupIds.add(fileId));
        throw err;
    } finally {
        fileCacheCleanupRunning = false;
    }
    if (pendingFileCacheCleanupIds.size) scheduleFileCacheCleanup(500);
}

async function deleteFileFromCollection(collectionMessageId, fileId) {
    if (!requireTunnelPermission('delete')) return;
    const message = await getFromStore('messages', collectionMessageId);
    const files = getCollectionFiles(message);
    const removedFile = files.find(file => file.id === fileId);
    if (!message || !removedFile) return;
    if (!confirm('删除会同步移除所有设备中合辑里的这个文件，并清理其文件缓存。继续吗？')) return;

    const nextFiles = files.filter(file => file.id !== fileId);
    if (!nextFiles.length) {
        closeFilePreview({ forceClose: true });
        await deleteHistoryMessageLocal(collectionMessageId);
        state.socket?.emit('delete-message', { sessionId: state.sessionId, messageId: collectionMessageId });
        return;
    }

    const shouldReturnToCollection = filePreviewReturnCollectionMessageId === collectionMessageId ||
        collectionPreviewReturnState?.messageId === collectionMessageId ||
        (activeCollectionPreviewMessageId === collectionMessageId && filePreviewNestedHistoryOpen);
    const frozenCollectionReturnState = shouldReturnToCollection && collectionPreviewReturnState
        ? { ...collectionPreviewReturnState }
        : {};
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
    let restoredCollectionBeforeUpdate = false;
    if (shouldReturnToCollection) {
        stopTemporaryAudioPreview();
        musicPlayer.previewControls = null;
        const shouldConsumeNestedHistory = filePreviewNestedHistoryOpen &&
            history.state?.[FILE_PREVIEW_HISTORY_KEY] === true && history.state?.filePreviewStage === 'file';
        filePreviewReturnCollectionMessageId = '';
        filePreviewNestedHistoryOpen = false;
        if (shouldConsumeNestedHistory) {
            suppressNextFilePreviewPopstate = true;
            history.back();
        } else {
            const historyState = history.state && typeof history.state === 'object' ? history.state : {};
            history.replaceState({ ...historyState, [FILE_PREVIEW_HISTORY_KEY]: true, filePreviewStage: 'collection' }, '', window.location.href);
        }
        restoredCollectionBeforeUpdate = restoreCollectionPreviewReturnState(collectionMessageId);
        if (restoredCollectionBeforeUpdate) {
            const content = document.getElementById('filePreviewContent');
            content?.querySelector(`.collection-file-card[data-file-id="${CSS.escape(fileId)}"]`)?.remove();
            const grid = content?.querySelector('.collection-file-grid');
            if (grid) grid.dataset.collectionCount = String(nextFiles.length);
            const title = document.getElementById('filePreviewTitle');
            if (title) title.textContent = `合辑 · ${nextFiles.length} 个文件`;
            setCollectionPreviewActions(nextFiles, collectionMessageId);
        } else {
            activeFilePreviewMode = 'collection';
            activeCollectionPreviewMessageId = collectionMessageId;
            activeFilePreviewFileId = '';
            activeFilePreviewMessageId = '';
            activeFilePreviewOwnerDeviceId = '';
            activeFilePreviewCanFullscreen = false;
            activeFilePreviewMediaType = '';
            setFilePreviewFullscreenButton(false);
            setFilePreviewMusicButton(false);
            const title = document.getElementById('filePreviewTitle');
            if (title) title.textContent = `合辑 · ${nextFiles.length} 个文件`;
            const content = setFilePreviewContentStage('collection-stage');
            if (content) {
                const status = document.createElement('div');
                status.className = 'collection-preview-updating';
                status.textContent = '正在更新合辑…';
                content.replaceChildren(status);
            }
            setFilePreviewActions([]);
        }
    }
    await updateHistoryMessage(nextMessage);
    if (shouldReturnToCollection) {
        if (!restoredCollectionBeforeUpdate) {
            await openCollectionRecord(collectionMessageId, frozenCollectionReturnState);
        }
    } else {
        closeFilePreview({ forceClose: true });
    }
    historyLog('collection-file-deleted', {
        messageId: collectionMessageId,
        fileId,
        remainingCount: nextFiles.length
    });
}

async function deleteHistoryMessageLocal(messageId) {
    const message = await getFromStore('messages', messageId);
    if (!message) return;
    const fileIds = new Set();
    if (message.type === 'collection') getCollectionFiles(message).forEach(file => file?.id && fileIds.add(file.id));
    if (message.type === 'rich') {
        extractAssetIds(message.content).forEach(fileId => fileIds.add(fileId));
        extractFileRefIds(message.content).forEach(fileId => fileIds.add(fileId));
    }
    if (message.fileInfo?.id) fileIds.add(message.fileInfo.id);

    // Make the visible deletion immediate; cache cleanup continues asynchronously below.
    await deleteFromStore('messages', messageId);
    pendingHistoryMessageIds.delete(messageId);
    document.querySelector(`.message[data-message-id="${messageId}"]`)?.remove();
    if (activeCollectionPreviewMessageId === messageId || activeFileDetailsMessageId === messageId) {
        closeFileDetails();
        closeFilePreview({ forceClose: true, fromHistory: true });
    }
    for (const fileId of fileIds) {
        cleanupProgressForDeletedFile(fileId);
    }
    enqueueFileCacheCleanup(fileIds, 'history-message-deleted');
    historyLog('history-message-deleted-locally', {
        messageId,
        fileId: message?.fileInfo?.id,
        queuedFileCount: fileIds.size
    });
}

async function findReferencedFileIds(fileIds, excludingMessageId = null) {
    const targets = fileIds instanceof Set ? fileIds : new Set(fileIds || []);
    const referenced = new Set();
    if (!targets.size) return referenced;
    const [messages, editorContent] = await Promise.all([
        getAllFromStore('messages').catch(() => []),
        getFromStore('editorContent', 'current').catch(() => null)
    ]);
    const markContentReferences = content => {
        const contentIds = new Set([...extractAssetIds(content), ...extractFileRefIds(content)]);
        for (const fileId of contentIds) {
            if (targets.has(fileId)) referenced.add(fileId);
        }
    };
    for (const entry of messages) {
        if (!entry || entry.id === excludingMessageId || referenced.size === targets.size) continue;
        if (entry.fileInfo?.id && targets.has(entry.fileInfo.id)) referenced.add(entry.fileInfo.id);
        for (const file of getCollectionFiles(entry)) {
            if (targets.has(file.id)) referenced.add(file.id);
        }
        if (entry.type === 'rich') markContentReferences(entry.content);
    }
    if (editorContent?.content) markContentReferences(editorContent.content);
    const editor = document.getElementById('editor');
    if (editor) markContentReferences(editor.innerHTML);
    return referenced;
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

async function isFileReferencedOutsideSession(fileId, currentSessionId) {
    if (!fileId) return false;
    const messages = await getAllFromStore('messages').catch(() => []);
    return messages.some(message => {
        if (!message || message.sessionId === currentSessionId) return false;
        if (message.fileInfo?.id === fileId) return true;
        if (getCollectionFiles(message).some(file => file?.id === fileId)) return true;
        if (message.type === 'rich' && extractFileRefIds(message.content).includes(fileId)) return true;
        return false;
    });
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
        await deleteCacheStoreReference(file, 'garbage-cleanup');
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

function createFileInventoryRecord(file) {
    if (!file) return file;
    const { data, audioPoster, videoPoster, ...metadata } = file;
    return { ...metadata, _inventoryDataSize: getBinaryDataSize(data) };
}

function hasCompleteFileInventoryCache(file, fileInfo = null) {
    const dataSize = Number(file?._inventoryDataSize) || 0;
    const expectedSize = Number(fileInfo?.size ?? file?.size);
    return (dataSize > 0 && (!Number.isFinite(expectedSize) || expectedSize <= 0 || dataSize === expectedSize)) ||
        hasCompleteFileCache(file, fileInfo);
}

async function getCurrentSessionFileInventory() {
    if (state.db._isMemory || typeof IDBKeyRange === 'undefined') {
        return (await getCurrentSessionFiles()).map(createFileInventoryRecord);
    }

    return new Promise((resolve, reject) => {
        try {
            const transaction = state.db.transaction(['files'], 'readonly');
            const source = transaction.objectStore('files').index('sessionId');
            const request = source.openCursor(IDBKeyRange.only(state.sessionId));
            const files = [];
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(files);
                    return;
                }
                files.push(createFileInventoryRecord(cursor.value));
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
            transaction.onabort = () => reject(transaction.error || new Error('IndexedDB files inventory read aborted'));
        } catch (err) {
            reject(err);
        }
    });
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
    if (reference.kind === 'rich-message') return `富文本${time}`;
    return '协同编辑器';
}

async function getSessionResourceInventory() {
    const [messages, files, editorContent] = await Promise.all([
        getCurrentSessionMessages(),
        getCurrentSessionFileInventory(),
        getFromStore('editorContent', 'current')
    ]);
    const favoriteMusicIds = getFavoriteMusicIds();
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
                isTelegramSource: false,
                isSnsSource: false,
                isFavorite: false,
                isFileFavorite: false,
                isRecordFavorite: false,
                serverAssetUrl: '',
                telegramFileId: '',
                telegramFileIdUpdatedAt: 0,
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
        resource.isFileFavorite = resource.isFileFavorite || candidate.mediaFavorite === true || favoriteMusicIds.has(id);
        resource.isRecordFavorite = resource.isRecordFavorite || candidate.recordFavorite === true || candidate.favorite === true;
        resource.isFavorite = resource.isFavorite || resource.isFileFavorite || resource.isRecordFavorite;
        resource.isSnsSource = resource.isSnsSource || Boolean(candidate.snsTaskId || candidate.snsMediaItemId || candidate.snsSourceUrl) ||
            /^sns(?:-|$)/.test(String(candidate.source || ''));
        resource.isTelegramSource = resource.isTelegramSource || candidate.telegramBotOrigin === true ||
            Boolean(candidate.telegramFileId || candidate.telegramFileUniqueId);
        if (candidate.serverAssetUrl) resource.serverAssetUrl = candidate.serverAssetUrl;
        if (candidate.telegramFileId && Number(candidate.telegramFileIdUpdatedAt || 0) >= resource.telegramFileIdUpdatedAt) {
            resource.telegramFileId = candidate.telegramFileId;
            resource.telegramFileIdUpdatedAt = Number(candidate.telegramFileIdUpdatedAt) || 0;
        }
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
            upsertResource({
                ...message.fileInfo,
                recordFavorite: message.favorite === true,
                telegramBotOrigin: message.senderName === 'Telegram Bot' && !message.snsAcquisition
            });
            addReference(message.fileInfo.id, {
                kind: 'chat-file',
                messageId: message.id,
                timestamp: message.timestamp
            });
        }
        if (message.type === 'collection') {
            getCollectionFiles(message).forEach(fileInfo => {
                if (!fileInfo?.id) return;
                upsertResource({
                    ...fileInfo,
                    recordFavorite: message.favorite === true,
                    telegramBotOrigin: message.senderName === 'Telegram Bot' && !message.snsAcquisition
                });
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
        resource.isTelegramSource = resource.isTelegramSource && !resource.isSnsSource;
        resource.name = resource.name || `未命名资源 ${resource.id.slice(0, 8)}`;
        resource.hasLocalData = hasCompleteFileInventoryCache(resource.file, resource);
        resource.isExternalFile = Boolean(resource.file?.externalFileHandle || resource.isExternalFile);
        resource.externalFileAvailable = resource.file?.externalFileAvailable === true;
        resource.hasReadableLocalSource = resource.hasLocalData || (resource.isExternalFile && resource.file?.externalFileMissing !== true);
        resource.cacheCleared = Boolean(resource.file?.cacheCleared);
        resource.isPartial = Boolean(resource.file?.isPartial || resource.file?.transferInterrupted);
        resource.timestamp = Number(resource.file?.timestamp || 0);
        resource.references.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        delete resource.isSnsSource;
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
        scrollMessageInsideChat(message);
        flashResourceTarget(message);
    });
}

function getResourceTargetInEditor(editor, assetId) {
    return Array.from(editor.querySelectorAll('[data-tunnel-asset-id], [data-tunnel-file-ref-id]'))
        .find(element => element.dataset.tunnelAssetId === assetId || element.dataset.tunnelFileRefId === assetId);
}

function focusResourceReference(reference) {
    if (reference.kind === 'editor') {
        settleMobileWorkspaceView('editor');
        const editor = document.getElementById('editor');
        if (!editor) return;
        requestAnimationFrame(() => {
            editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const target = getResourceTargetInEditor(editor, reference.targetAssetId || reference.resourceId);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                flashResourceTarget(target);
            } else {
                editor.focus();
                flashResourceTarget(editor);
            }
            settleMobileWorkspaceView('editor');
        });
        return;
    }

    settleMobileWorkspaceView('chat');
    const message = document.querySelector(`.message[data-message-id="${reference.messageId}"]`);
    if (!message) return;
    requestAnimationFrame(() => {
        scrollMessageInsideChat(message);
        flashResourceTarget(message);
        settleMobileWorkspaceView('chat');
    });
}

function closeResourceBrowser() {
    const layer = document.getElementById('resourceBrowserLayer');
    if (!layer) return;
    layer.replaceChildren();
    layer.classList.remove('active', 'is-minimized');
    layer.hidden = true;
}

function minimizeResourceBrowser() {
    const layer = document.getElementById('resourceBrowserLayer');
    if (!layer || layer.hidden) return;
    layer.classList.remove('active');
    layer.classList.add('is-minimized');
    const button = layer.querySelector('.resource-browser-minimize');
    if (button) {
        button.textContent = '□';
        button.title = '恢复资源管理器';
        button.setAttribute('aria-label', '恢复资源管理器');
    }
}

function restoreResourceBrowser() {
    const layer = document.getElementById('resourceBrowserLayer');
    if (!layer || layer.hidden) return false;
    layer.classList.remove('is-minimized');
    layer.classList.add('active');
    const modal = layer.querySelector('.resource-browser-modal');
    if (modal) {
        modal.style.removeProperty('left');
        modal.style.removeProperty('top');
        modal.style.removeProperty('right');
        modal.style.removeProperty('bottom');
    }
    const button = layer.querySelector('.resource-browser-minimize');
    if (button) {
        button.textContent = '−';
        button.title = '最小化资源管理器';
        button.setAttribute('aria-label', '最小化资源管理器');
    }
    return true;
}

function initResourceBrowserCapsuleDrag(layer, header) {
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragged = false;

    header.addEventListener('pointerdown', event => {
        if (!layer.classList.contains('is-minimized')) return;
        const modal = layer.querySelector('.resource-browser-modal');
        if (!modal) return;
        const rect = modal.getBoundingClientRect();
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        originLeft = rect.left;
        originTop = rect.top;
        dragged = false;
        header.setPointerCapture?.(pointerId);
        event.preventDefault();
    });

    header.addEventListener('pointermove', event => {
        if (pointerId !== event.pointerId || !layer.classList.contains('is-minimized')) return;
        const modal = layer.querySelector('.resource-browser-modal');
        if (!modal) return;
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        if (Math.hypot(deltaX, deltaY) > 5) dragged = true;
        if (!dragged) return;
        modal.style.left = `${Math.min(window.innerWidth - modal.offsetWidth - 6, Math.max(6, originLeft + deltaX))}px`;
        modal.style.top = `${Math.min(window.innerHeight - modal.offsetHeight - 6, Math.max(6, originTop + deltaY))}px`;
        modal.style.right = 'auto';
        modal.style.bottom = 'auto';
        event.preventDefault();
    });

    header.addEventListener('pointerup', event => {
        if (pointerId !== event.pointerId) return;
        header.releasePointerCapture?.(pointerId);
        pointerId = null;
        if (!dragged && layer.classList.contains('is-minimized')) restoreResourceBrowser();
        dragged = false;
        event.preventDefault();
    });
    header.addEventListener('pointercancel', event => {
        if (pointerId === event.pointerId) pointerId = null;
        dragged = false;
    });
}

async function clearResourceCache(resource) {
    const file = await getFromStore('files', resource.id);
    if (!file || !hasCompleteFileCache(file, resource)) return;
    if (!confirm(`仅清除此设备保存的“${resource.name}”内容吗？引用与传输记录会保留。`)) return;

    fileAssetTransfer?.cancel(resource.id);
    await deleteCacheStoreReference(file, 'resource-cache-clear');
    const { data, cacheStoreRef, cacheStorage, ...metadata } = file;
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

    if (resource.isServerAsset && resource.serverAssetUrl) {
        await requestServerAssetWithPeerPreference(metadata, resource.ownerDeviceId, 'resource-restore', {
            priority: true,
            force: true,
            peerWaitMs: 5000
        });
        historyLog('resource-server-asset-restore-requested', { resourceId: resource.id });
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

async function saveMountedFiles(fileEntries, options = {}) {
    const records = [];
    for (const entry of fileEntries) {
        const file = entry.file || await entry.handle.getFile();
        const fileInfo = createFileInfoFromFile(file, {
            isExternalFile: true,
            externalSourceLabel: '本机挂载',
            externalVirtualPath: entry.virtualPath || file.name
        });
        const record = {
            ...fileInfo,
            sessionId: state.sessionId,
            isFileAsset: true,
            externalFileHandle: entry.handle,
            externalFileAvailable: true,
            externalMountId: options.mountId || '',
            cacheCleared: false
        };
        await saveToStore('files', record);
        await fileAssetTransfer?.announce(record);
        records.push({ record, fileInfo });
    }
    if (!records.length) return;
    let message;
    if (records.length === 1) {
        message = {
            id: generateId(),
            type: 'file',
            fileInfo: records[0].fileInfo,
            timestamp: nextHistoryTimestamp(),
            sender: state.deviceId,
            senderName: state.deviceName
        };
    } else {
        const files = records.map(item => item.fileInfo);
        message = {
            id: generateId(),
            type: 'collection',
            collection: {
                id: generateId(),
                files,
                count: files.length,
                totalSize: files.reduce((sum, file) => sum + Number(file.size || 0), 0),
                externalMountId: options.mountId || ''
            },
            timestamp: nextHistoryTimestamp(),
            sender: state.deviceId,
            senderName: state.deviceName
        };
    }
    await publishHistoryMessage(message, { autoRequestAsset: false });
    showAppToast(`已发布 ${records.length} 个本机挂载文件`);
}

async function mountLocalFiles() {
    if (!window.showOpenFilePicker) throw new Error('当前浏览器不支持本机文件挂载，请使用桌面版 Chromium 并通过 HTTPS 访问');
    const handles = await window.showOpenFilePicker({ multiple: true });
    const entries = [];
    for (const handle of handles) entries.push({ handle, file: await handle.getFile(), virtualPath: handle.name });
    await saveMountedFiles(entries);
    await showResourceBrowser();
}

async function mountLocalDirectory() {
    if (!window.showDirectoryPicker) throw new Error('当前浏览器不支持本机目录挂载，请使用桌面版 Chromium 并通过 HTTPS 访问');
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    const mount = {
        id: generateId(),
        kind: 'directory',
        sessionId: state.sessionId,
        displayName: handle.name || '本机目录',
        virtualPath: `/${handle.name || '本机目录'}`,
        handle,
        readOnly: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    await saveToStore('mounts', mount);
    await showResourceBrowser();
}

async function collectMountedDirectoryFiles(mount, limit = 500) {
    const entries = [];
    const walk = async (directory, prefix = '') => {
        for await (const [name, handle] of directory.entries()) {
            if (entries.length >= limit) return;
            const virtualPath = `${prefix}/${name}`;
            if (handle.kind === 'directory') await walk(handle, virtualPath);
            else if (handle.kind === 'file') entries.push({ handle, virtualPath, file: await handle.getFile() });
        }
    };
    let permission = mount.handle.queryPermission ? await mount.handle.queryPermission({ mode: 'read' }) : 'granted';
    if (permission !== 'granted' && mount.handle.requestPermission) permission = await mount.handle.requestPermission({ mode: 'read' });
    if (permission !== 'granted') throw new Error('没有本机目录读取权限');
    await walk(mount.handle, mount.virtualPath || '');
    return entries;
}

async function publishMountedDirectory(mount) {
    const entries = await collectMountedDirectoryFiles(mount);
    if (!entries.length) throw new Error('目录中没有可发布的文件');
    if (entries.length >= 500) showAppToast('目录文件较多，本次仅发布前 500 个文件');
    await saveMountedFiles(entries, { mountId: mount.id });
}

async function renderMountsInResourceBrowser(container) {
    const mounts = typeof IDBKeyRange !== 'undefined'
        ? await getAllFromStore('mounts', 'sessionId', IDBKeyRange.only(state.sessionId))
        : (await getAllFromStore('mounts')).filter(mount => mount.sessionId === state.sessionId);
    const section = document.createElement('section');
    section.className = 'resource-browser-mounts';
    const title = document.createElement('strong');
    title.textContent = `本机资源挂载 · ${mounts.length}`;
    section.appendChild(title);
    if (!mounts.length) {
        const empty = document.createElement('span');
        empty.textContent = ' 尚未挂载本机目录';
        section.appendChild(empty);
    }
    mounts.forEach(mount => {
        const row = document.createElement('div');
        row.className = 'resource-browser-mount-row';
        row.innerHTML = `<span>🖴 本机目录 · ${escapeHtml(mount.displayName)}</span>`;
        row.append(
            createResourceBrowserButton('发布到隧道', '按需读取目录文件并以合辑发布', () => publishMountedDirectory(mount).catch(err => alert(err.message))),
            createResourceBrowserButton('解除挂载', '只解除映射，不删除真实文件', async () => {
                await deleteFromStore('mounts', mount.id);
                await showResourceBrowser();
            }, 'danger')
        );
        section.appendChild(row);
    });
    container.querySelector(':scope > .resource-browser-mounts')?.remove();
    container.insertBefore(section, container.querySelector(':scope > .resource-browser-list'));
}

async function waitForTelegramRepairCache(resource, timeoutMs = 12000) {
    let storedFile = await getFromStore('files', resource.id).catch(() => null);
    if (storedFile?.externalFileHandle) storedFile = await materializeExternalFileRecord(storedFile, { requestPermission: true });
    if (hasCompleteFileCache(storedFile, resource)) return storedFile;
    if (!fileAssetTransfer) return null;
    await fileAssetTransfer.requestProviderDiscovery?.(resource.id, 'telegram-file-id-repair');
    await fileAssetTransfer.request(resource.id, resource.ownerDeviceId || null, {
        id: resource.id,
        name: resource.name,
        type: resource.type,
        size: resource.size,
        ownerDeviceId: resource.ownerDeviceId,
        isAsset: true
    }, { priority: true }).catch(() => null);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await sleep(500);
        storedFile = await getFromStore('files', resource.id).catch(() => null);
        if (storedFile?.externalFileHandle) storedFile = await materializeExternalFileRecord(storedFile);
        if (hasCompleteFileCache(storedFile, resource)) return storedFile;
    }
    return null;
}

async function applyTelegramFileIdUpdateLocally(fileId, update) {
    const storedFile = await getFromStore('files', fileId).catch(() => null);
    if (storedFile && Number(update.telegramFileIdUpdatedAt || 0) >= Number(storedFile.telegramFileIdUpdatedAt || 0)) {
        await saveToStore('files', {
            ...storedFile,
            telegramFileId: update.telegramFileId,
            telegramFileUniqueId: update.telegramFileUniqueId || '',
            telegramFileIdUpdatedAt: update.telegramFileIdUpdatedAt,
            isServerAsset: true,
            serverAssetUrl: `/api/server-assets/${fileId}`
        });
    }
    for (const message of await getCurrentSessionMessages()) {
        let changed = false;
        const patch = fileInfo => {
            if (!fileInfo || fileInfo.id !== fileId || Number(fileInfo.telegramFileIdUpdatedAt || 0) > Number(update.telegramFileIdUpdatedAt || 0)) return;
            fileInfo.telegramFileId = update.telegramFileId;
            fileInfo.telegramFileUniqueId = update.telegramFileUniqueId || '';
            fileInfo.telegramFileIdUpdatedAt = update.telegramFileIdUpdatedAt;
            fileInfo.isServerAsset = true;
            fileInfo.serverAssetUrl = `/api/server-assets/${fileId}`;
            changed = true;
        };
        const next = { ...message };
        if (next.fileInfo) next.fileInfo = { ...next.fileInfo };
        if (next.collection?.files) next.collection = { ...next.collection, files: next.collection.files.map(file => ({ ...file })) };
        patch(next.fileInfo);
        next.collection?.files?.forEach(patch);
        if (changed) await applyHistoryMessageUpdate(next, { remote: true });
    }
}

async function runTelegramFileContinuityRepair() {
    const resources = (await getSessionResourceInventory()).filter(resource => resource.isTelegramSource);
    if (!resources.length) {
        showAppToast('当前隧道没有 Telegram 来源文件');
        return;
    }
    const progress = showBlockingProgressPanel('Telegram 文件防失联检测及修复', `准备扫描 ${resources.length} 个文件...`);
    const stats = { valid: 0, repaired: 0, unavailable: 0, failed: 0 };
    try {
        for (let index = 0; index < resources.length; index++) {
            const resource = resources[index];
            progress.update(Math.floor(index * 100 / resources.length), `检测 ${index + 1}/${resources.length} · ${resource.name} · 有效 ${stats.valid} / 修复 ${stats.repaired} / 待来源 ${stats.unavailable} / 失败 ${stats.failed}`);
            const response = await fetch('/api/telegram/assets/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: state.sessionId, assetIds: [resource.id] })
            });
            if (!response.ok) throw new Error(`检测接口返回 ${response.status}`);
            const payload = await response.json();
            const result = payload.results?.[0];
            if (result?.valid) {
                stats.valid += 1;
                continue;
            }
            const storedFile = await waitForTelegramRepairCache(resource);
            if (!storedFile) {
                stats.unavailable += 1;
                continue;
            }
            try {
                const body = storedFile.data instanceof Blob
                    ? storedFile.data
                    : new Blob([storedFile.data], { type: resource.type || storedFile.type || 'application/octet-stream' });
                const repairResponse = await fetch(`/api/telegram/assets/${encodeURIComponent(resource.id)}/repair?sessionId=${encodeURIComponent(state.sessionId)}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'X-File-Name': encodeURIComponent(resource.name || 'file')
                    },
                    body
                });
                const repair = await repairResponse.json().catch(() => ({}));
                if (!repairResponse.ok) throw new Error(repair.error || `修复接口返回 ${repairResponse.status}`);
                await applyTelegramFileIdUpdateLocally(resource.id, repair);
                stats.repaired += 1;
            } catch (err) {
                stats.failed += 1;
                historyLog('telegram-file-id-repair-failed', { fileId: resource.id, error: err.message });
            }
            await sleep(0);
        }
        progress.update(100, `有效 ${stats.valid} · 已修复 ${stats.repaired} · 暂不可修复 ${stats.unavailable} · 失败 ${stats.failed}`);
        await sleep(500);
    } finally {
        progress.close();
    }
    await showResourceBrowser();
    showAppToast(`Telegram 检测完成：有效 ${stats.valid}，修复 ${stats.repaired}，待来源 ${stats.unavailable}，失败 ${stats.failed}`);
}

async function showResourceBrowser(options = {}) {
    const layer = document.getElementById('resourceBrowserLayer');
    if (!layer) throw new Error('资源浏览器容器不存在');
    if (options.restoreIfMinimized && layer.classList.contains('is-minimized')) {
        restoreResourceBrowser();
        return;
    }
    if (layer.parentElement !== document.body) document.body.appendChild(layer);
    layer.replaceChildren();
    layer.hidden = false;
    layer.classList.remove('is-minimized');
    layer.classList.add('active');
    const modal = document.createElement('section');
    modal.className = 'modal resource-browser-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', '会话资源浏览器');

    const header = document.createElement('div');
    header.className = 'resource-browser-header';
    const headerMain = document.createElement('div');
    headerMain.className = 'resource-browser-header-main';
    const title = document.createElement('h3');
    title.textContent = '会话资源浏览器';
    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'resource-browser-refresh';
    refreshButton.textContent = '↻ 刷新';
    refreshButton.title = '重新扫描当前会话资源';
    const headerActions = document.createElement('div');
    headerActions.className = 'resource-browser-header-actions';
    const minimizeButton = document.createElement('button');
    minimizeButton.type = 'button';
    minimizeButton.className = 'resource-browser-minimize';
    minimizeButton.textContent = '−';
    minimizeButton.title = '最小化资源管理器';
    minimizeButton.setAttribute('aria-label', '最小化资源管理器');
    minimizeButton.addEventListener('click', () => {
        if (layer.classList.contains('is-minimized')) restoreResourceBrowser();
        else minimizeResourceBrowser();
    });
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'resource-browser-close';
    closeButton.textContent = '×';
    closeButton.title = '关闭资源浏览器';
    closeButton.addEventListener('click', closeResourceBrowser);
    headerMain.append(title, refreshButton);
    headerActions.append(minimizeButton, closeButton);
    header.append(headerMain, headerActions);
    initResourceBrowserCapsuleDrag(layer, header);

    const controls = document.createElement('div');
    controls.className = 'resource-browser-controls';
    const mountDirectoryButton = createResourceBrowserButton('挂载本机目录', '只读映射用户授权的真实目录', () => mountLocalDirectory().catch(err => alert(err.message)));
    const mountFileButton = createResourceBrowserButton('关联本机文件', '不复制文件内容，远端请求时再读取', () => mountLocalFiles().catch(err => alert(err.message)));
    const telegramRepairButton = createResourceBrowserButton('Telegram 文件防失联检测及修复', '检测当前 bot 是否仍可使用文件的 Telegram file_id，并在有缓存来源时换绑', () => {
        runTelegramFileContinuityRepair().catch(err => alert(`Telegram 文件检测失败：${err.message}`));
    });
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
        ['missing', '缓存缺失'],
        ['favorite', '已收藏'],
        ['telegram', 'Telegram 渠道']
    ].forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        filter.appendChild(option);
    });
    controls.append(mountDirectoryButton, mountFileButton, telegramRepairButton, searchInput, filter);

    const summary = document.createElement('div');
    summary.className = 'resource-browser-summary';
    const list = document.createElement('div');
    list.className = 'resource-browser-list';
    modal.append(header, controls, summary);
    await renderMountsInResourceBrowser(modal);
    modal.append(list);
    layer.appendChild(modal);
    layer.onclick = event => {
        if (event.target === layer) closeResourceBrowser();
    };

    let resourceInventory = null;
    const render = async (options = {}) => {
        const previousScrollTop = options.preserveScroll ? list.scrollTop : 0;
        if (options.reload || resourceInventory === null) {
            resourceInventory = await getSessionResourceInventory();
        }
        const resources = resourceInventory;
        const query = searchInput.value.trim().toLocaleLowerCase('zh-CN');
        const mode = filter.value;
        const visible = resources.filter(resource => {
            const matchesQuery = !query || `${resource.name} ${resource.type}`.toLocaleLowerCase('zh-CN').includes(query);
            if (!matchesQuery) return false;
            if (mode === 'referenced') return resource.references.length > 0;
            if (mode === 'orphaned') return resource.references.length === 0;
            if (mode === 'missing') return !resource.hasReadableLocalSource;
            if (mode === 'favorite') return resource.isFavorite;
            if (mode === 'telegram') return resource.isTelegramSource;
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
            if (resource.isTelegramSource) addTag('Telegram 兜底', 'protected');
            if (resource.references.length) addTag(`引用 ${resource.references.length}`, 'protected');
            else addTag('未引用', 'warning');
            if (resource.isFileFavorite) addTag('单文件收藏', 'protected');
            if (resource.isRecordFavorite) addTag('记录收藏', 'protected');
            if (resource.derivedCopies.length) addTag(`引用副本 ${resource.derivedCopies.length}`, 'protected');
            if (resource.isExternalFile && !resource.hasLocalData) addTag('🖴 本机映射', 'protected');
            else if (resource.hasLocalData) addTag('已缓存');
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
                    button.addEventListener('click', () => {
                        minimizeResourceBrowser();
                        requestAnimationFrame(() => focusResourceReference(reference));
                    });
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
            if (resource.hasReadableLocalSource) {
                actions.appendChild(createResourceBrowserButton('下载', resource.isExternalFile ? '从本机映射读取并下载' : '下载本机已缓存的资源', () => downloadFile(resource.id)));
                if (resource.hasLocalData && !(resource.isExternalFile && resource.externalFileAvailable)) {
                    actions.appendChild(createResourceBrowserButton('清除缓存', '仅清理本设备保存的文件内容', async () => {
                        await clearResourceCache(resource);
                        await render({ reload: true, preserveScroll: true });
                    }));
                }
            } else if (resource.cacheCleared || resource.isPartial) {
                actions.appendChild(createResourceBrowserButton(
                    resource.isEditorAsset ? '还原图片' : '还原文件',
                    '从当前在线设备重新获取资源内容',
                    async () => {
                        await restoreResourceCache(resource);
                        await render({ reload: true, preserveScroll: true });
                    }
                ));
            }
            if (resource.references.length === 0) {
                actions.appendChild(createResourceBrowserButton('移除资源', '仅从本设备移除未引用资源', async () => {
                    await deleteUnreferencedResource(resource);
                    await render({ reload: true, preserveScroll: true });
                }, 'danger'));
            }
            if (actions.childElementCount) item.appendChild(actions);
            list.appendChild(item);
        });
        if (options.preserveScroll) {
            requestAnimationFrame(() => {
                list.scrollTop = Math.min(previousScrollTop, Math.max(0, list.scrollHeight - list.clientHeight));
            });
        }
    };

    searchInput.addEventListener('input', () => render().catch(err => alert(`加载资源失败: ${err.message}`)));
    filter.addEventListener('change', () => render().catch(err => alert(`加载资源失败: ${err.message}`)));
    refreshButton.addEventListener('click', async () => {
        if (refreshButton.disabled) return;
        refreshButton.disabled = true;
        refreshButton.textContent = '↻ 刷新中';
        try {
            await renderMountsInResourceBrowser(modal);
            await render({ reload: true, preserveScroll: true });
            showAppToast('资源列表已刷新');
        } catch (err) {
            alert(`刷新资源失败: ${err.message}`);
        } finally {
            refreshButton.disabled = false;
            refreshButton.textContent = '↻ 刷新';
        }
    });
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

    await addMessageToChat(message, true, {
        forceScroll: options.forceScroll !== false,
        autoRequestAsset: options.autoRequestAsset !== false
    });
}

async function sendText() {
    if (!requireTunnelPermission('sendText')) return;
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
    if (!requireTunnelPermission('collaborativeEdit')) return { emitted: false, reason: 'permission-denied' };
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

function getEditableSelectionRange(editor) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !editor) return null;
    const range = selection.getRangeAt(0);
    return editor.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
}

function insertHtmlIntoEditable(editor, html, savedRange = null) {
    if (!editor) return;
    const range = savedRange || getEditableSelectionRange(editor);
    if (!range) {
        editor.insertAdjacentHTML('beforeend', html);
        editor.focus();
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
}

function getEditableDropRange(editor, event) {
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
    return range && editor?.contains(range.commonAncestorContainer) ? range : null;
}

async function insertRichEditorImageFile(editor, file, savedRange = null) {
    const asset = await createEditorAssetFromFile(file);
    const html = createEditorAssetHtml(asset);
    if (getEditorContentSize(editor.innerHTML + html) > MAX_EDITOR_CONTENT_SIZE) {
        throw new Error('内容过大，无法同步到其它设备');
    }
    insertHtmlIntoEditable(editor, html, savedRange);
    await hydrateEditorAssets(editor);
}

function attachRichEditorEnhancedTools(layer, editor) {
    if (!layer || !editor) return;
    layer.querySelectorAll('.rich-message-editor-toolbar .toolbar-btn[data-cmd]').forEach(btn => {
        btn.addEventListener('click', event => {
            event.preventDefault();
            document.execCommand(btn.dataset.cmd, false, null);
            editor.focus();
        });
    });
    layer.querySelector('[data-rich-insert-image]')?.addEventListener('click', event => {
        event.preventDefault();
        editor.focus();
        const savedRange = getEditableSelectionRange(editor);
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async e => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                await insertRichEditorImageFile(editor, file, savedRange);
            } catch (err) {
                alert(`图片无法插入: ${err.message}`);
            }
        };
        input.click();
    });
    layer.querySelector('[data-rich-insert-file]')?.addEventListener('click', async event => {
        event.preventDefault();
        editor.focus();
        const savedRange = getEditableSelectionRange(editor);
        const referenceFiles = await getReferenceableSessionFiles();
        if (!referenceFiles.length) return alert('暂无文件可引用');
        openEditorFileReferenceDialog(referenceFiles, savedRange, (html, range) => insertHtmlIntoEditable(editor, html, range), editor, async () => {
            await hydrateEditorAssets(editor);
            return { emitted: false };
        });
    });
    layer.querySelector('[data-rich-insert-link]')?.addEventListener('click', event => {
        event.preventDefault();
        editor.focus();
        const url = prompt('请输入链接地址（https://...）');
        if (!url) return;
        const safeUrl = escapeHtml(url.trim());
        const selectedText = String(window.getSelection?.()?.toString() || '').trim();
        insertHtmlIntoEditable(editor, `<a href="${safeUrl}" target="_blank" rel="noopener">${escapeHtml(selectedText || url)}</a>&nbsp;`, getEditableSelectionRange(editor));
    });
    layer.querySelector('[data-rich-insert-quote]')?.addEventListener('click', event => {
        event.preventDefault();
        insertHtmlIntoEditable(editor, '<blockquote style="border-left:4px solid #667eea;margin:8px 0;padding:6px 10px;background:#f6f8ff;">引用内容</blockquote>');
    });
    layer.querySelector('[data-rich-insert-hr]')?.addEventListener('click', event => {
        event.preventDefault();
        insertHtmlIntoEditable(editor, '<hr><p><br></p>');
    });
    layer.querySelector('[data-rich-insert-table]')?.addEventListener('click', event => {
        event.preventDefault();
        insertHtmlIntoEditable(editor, '<table border="1" style="border-collapse:collapse;width:100%;"><tbody><tr><td>单元格</td><td>单元格</td></tr><tr><td>单元格</td><td>单元格</td></tr></tbody></table><p><br></p>');
    });
    editor.addEventListener('dragover', event => {
        if (Array.from(event.dataTransfer?.files || []).some(file => file.type.startsWith('image/'))) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        }
    });
    editor.addEventListener('drop', async event => {
        const imageFile = Array.from(event.dataTransfer?.files || []).find(file => file.type.startsWith('image/'));
        if (!imageFile) return;
        event.preventDefault();
        event.stopPropagation();
        try {
            await insertRichEditorImageFile(editor, imageFile, getEditableDropRange(editor, event));
        } catch (err) {
            alert(`图片无法插入: ${err.message}`);
        }
    });
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
        if (!requireTunnelPermission('sendRich')) return;
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
            senderName: state.deviceName,
            richVersion: 1,
            richHistory: [{
                version: 1,
                content,
                editorDeviceId: state.deviceId,
                editorDeviceName: state.deviceName,
                editedAt: Date.now()
            }]
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
        joinedAt: Date.now(),
        clientType: data.clientType === 'vclient' ? 'vclient' : 'browser'
    });

    updateDeviceList();
    refreshTunnelAdminDevicePicker();

    // 尝试建立P2P连接
    if (data.clientType !== 'vclient') connectToPeer(deviceId);
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

    for (const [assetId, transfer] of editorAssetTransfers) {
        if (transfer.from !== deviceId) continue;
        clearEditorAssetTransfer(assetId);
        editorAssetRequests.delete(assetId);
        setEditorAssetUnavailable(assetId, 'provider-disconnected');
    }

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
    refreshTunnelAdminDevicePicker();
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
                joinedAt: device.joinedAt,
                clientType: device.clientType === 'vclient' ? 'vclient' : 'browser'
            });

            // 建立P2P连接
            if (device.clientType !== 'vclient') connectToPeer(device.deviceId);
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
    refreshTunnelAdminDevicePicker();
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
        externalIp: data.externalIp || existing?.externalIp || null,
        clientType: data.clientType === 'vclient' ? 'vclient' : (existing?.clientType || 'browser')
    });
    if (!existing && data.clientType !== 'vclient') connectToPeer(data.deviceId);
    updateDeviceList();
    refreshTunnelAdminDevicePicker();
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
        clientType: device.clientType === 'vclient' ? 'vclient' : 'browser',
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

const DEVICE_REMARKS_KEY = 'deviceRemarks:v1';
const DEVICE_REMARK_BACKUPS_KEY = 'deviceRemarkBackups:v1';
const deviceRemarkSyncSignatures = new Map();

function readDeviceRemarkMap(key) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || '{}');
        return value && typeof value === 'object' ? value : {};
    } catch (_) {
        return {};
    }
}

function getLocalDeviceRemark(deviceId) {
    return readDeviceRemarkMap(DEVICE_REMARKS_KEY)[deviceId] || null;
}

function getDeviceDisplayName(device = {}, options = {}) {
    const deviceId = device.deviceId || device.id || '';
    const originalName = String(device.name || device.deviceName || (deviceId ? `设备-${deviceId.slice(-4)}` : '未知设备')).trim();
    if (options.isSelf || deviceId === state.deviceId) return originalName;
    const remark = String(getLocalDeviceRemark(deviceId)?.remark || '').trim();
    return remark ? `${remark}(${originalName})` : originalName;
}

async function setLocalDeviceRemark(deviceId, value) {
    const remarks = readDeviceRemarkMap(DEVICE_REMARKS_KEY);
    const remark = String(value || '').trim().slice(0, 120);
    const updatedAt = Date.now();
    if (remark) remarks[deviceId] = { remark, updatedAt };
    else delete remarks[deviceId];
    localStorage.setItem(DEVICE_REMARKS_KEY, JSON.stringify(remarks));
    state.socket?.emit('device-remark-backup', { targetDeviceId: deviceId, remark, updatedAt });
    renderNearbyDevices();
}

function handleDeviceRemarkBackup(data) {
    if (data?.targetDeviceId !== state.deviceId || !data.ownerDeviceId) return;
    const backups = readDeviceRemarkMap(DEVICE_REMARK_BACKUPS_KEY);
    const key = `${data.ownerDeviceId}:${state.deviceId}`;
    if (!backups[key] || Number(data.updatedAt) >= Number(backups[key].updatedAt || 0)) {
        backups[key] = { remark: String(data.remark || '').slice(0, 120), updatedAt: Number(data.updatedAt) || Date.now() };
        localStorage.setItem(DEVICE_REMARK_BACKUPS_KEY, JSON.stringify(backups));
    }
}

function handleDeviceRemarkRestoreRequest(data) {
    if (data?.helperDeviceId !== state.deviceId || !data.ownerDeviceId) return;
    const backup = readDeviceRemarkMap(DEVICE_REMARK_BACKUPS_KEY)[`${data.ownerDeviceId}:${state.deviceId}`];
    if (!backup) return;
    state.socket?.emit('device-remark-restore-response', {
        ownerDeviceId: data.ownerDeviceId,
        remark: backup.remark,
        updatedAt: backup.updatedAt
    });
}

function handleDeviceRemarkRestoreResponse(data) {
    if (data?.ownerDeviceId !== state.deviceId || !data.helperDeviceId) return;
    const remarks = readDeviceRemarkMap(DEVICE_REMARKS_KEY);
    const current = remarks[data.helperDeviceId];
    if (!current || Number(data.updatedAt) > Number(current.updatedAt || 0)) {
        if (data.remark) remarks[data.helperDeviceId] = { remark: String(data.remark).slice(0, 120), updatedAt: Number(data.updatedAt) || Date.now() };
        else delete remarks[data.helperDeviceId];
        localStorage.setItem(DEVICE_REMARKS_KEY, JSON.stringify(remarks));
        updateDeviceList();
        renderNearbyDevices();
    }
}

function syncDeviceRemarkWithHelper(deviceId) {
    if (!deviceId || !state.socket?.connected) return;
    const local = getLocalDeviceRemark(deviceId);
    const signature = `${local?.updatedAt || 0}:${local?.remark || ''}`;
    if (deviceRemarkSyncSignatures.get(deviceId) !== signature) {
        deviceRemarkSyncSignatures.set(deviceId, signature);
        if (local) state.socket.emit('device-remark-backup', {
            targetDeviceId: deviceId,
            remark: local.remark,
            updatedAt: local.updatedAt
        });
    }
    state.socket.emit('device-remark-restore-request', { helperDeviceId: deviceId });
}

async function startIntercomWithDevice(device) {
    try {
        if (!device?.deviceId) return;
        if (device.clientType === 'vclient') return;
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
    const isCacheNode = normalized.clientType === 'vclient';
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
    const localRemark = isSelf ? '' : getLocalDeviceRemark(normalized.deviceId)?.remark;
    name.textContent = `${getDeviceDisplayName(normalized, { isSelf })}${isSelf ? ' (我)' : ''}`;
    if (localRemark) name.title = `设备原名：${normalized.name || normalized.deviceId}`;
    makeDeviceNameInteractive(name, normalized);
    const status = el.querySelector('.status');
    status.textContent = isSelf
        ? '在线'
        : isCacheNode
            ? '缓存节点 · 在线（Socket.IO 中继）'
        : (options.contact
            ? `${normalized.model || '未知设备'} · ${normalized.deviceId.slice(0, 8)}...`
            : `在线 · P2P${state.dataChannels.has(dataChannelId) ? '已连接' : '连接中'}`);

    if (!isSelf && !isCacheNode) {
        const actions = document.createElement('div');
        actions.className = 'device-actions';
        const voiceButton = document.createElement('button');
        voiceButton.className = 'icon-action';
        voiceButton.type = 'button';
        voiceButton.title = '发起语音通话（不受隧道限制）';
        voiceButton.setAttribute('aria-label', `向 ${getDeviceDisplayName(normalized)} 发起语音通话`);
        voiceButton.textContent = '☎';
        voiceButton.addEventListener('click', () => startContactVoiceCall(normalized));
        const intercomButton = document.createElement('button');
        intercomButton.className = 'icon-action';
        intercomButton.type = 'button';
        intercomButton.title = `${normalized.deviceId === directIntercomTargetId ? '关闭' : '发起'}对讲`;
        intercomButton.textContent = normalized.deviceId === directIntercomTargetId ? '×' : '📢';
        intercomButton.addEventListener('click', () => startIntercomWithDevice(normalized));
        actions.append(voiceButton, intercomButton);
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
    const voiceButton = document.getElementById('deviceVoiceCallBtn');
    if (!modal || !title || !fields || !qr || !followButton || !voiceButton) return;

    title.textContent = profile.name || '设备资料';
    fields.innerHTML = '';
    [
        ['我的备注', getLocalDeviceRemark(profile.deviceId)?.remark || '未设置'],
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
    voiceButton.hidden = profile.deviceId === state.deviceId || profile.clientType === 'vclient';
    voiceButton.onclick = () => {
        closeDeviceProfile();
        startContactVoiceCall(profile);
    };
    followButton.onclick = async () => {
        if (state.contacts.has(profile.deviceId)) {
            await unfollowDevice(profile.deviceId);
            followButton.textContent = '关注';
        } else {
            await followDevice(profile);
            followButton.textContent = '取消关注';
        }
    };
    document.getElementById('deviceRemarkBtn')?.remove();
    if (profile.deviceId !== state.deviceId) {
        const remarkButton = document.createElement('button');
        remarkButton.id = 'deviceRemarkBtn';
        remarkButton.type = 'button';
        remarkButton.className = 'btn btn-secondary';
        remarkButton.textContent = '设置备注';
        remarkButton.onclick = async () => {
            const current = getLocalDeviceRemark(profile.deviceId)?.remark || '';
            const next = prompt('设置仅自己可见的设备备注（留空即删除）', current);
            if (next === null) return;
            await setLocalDeviceRemark(profile.deviceId, next);
            closeDeviceProfile();
            showDeviceProfile(profile, options);
            updateDeviceList();
        };
        followButton.parentElement?.insertBefore(remarkButton, followButton);
    }
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
    const stateLabel = document.getElementById('contactCallState');
    const avatar = document.getElementById('contactCallAvatar');
    if (!overlay || !title || !subtitle) return;
    syncContactCallTone(call);
    clearInterval(contactCallTimer);
    contactCallTimer = null;

    if (!call || call.state === 'idle') {
        overlay.hidden = true;
        overlay.dataset.state = 'idle';
        if (call?.callId && call?.peerId) removeRemoteAudio('contactVoice', call.callId, call.peerId);
        const reasonText = ({busy:'对方正在通话中',offline:'对方当前离线','no-answer':'对方暂未接听',rejected:'对方已拒接','microphone-denied':'麦克风不可用','connection-failed':'语音链路中断；跨网络通话请检查 TURN 配置'}[call?.reason]);
        if (reasonText) showAppToast(reasonText);
        state.activeContactCall = null;
        setContactCallActions([]);
        return;
    }

    state.activeContactCall = call;
    overlay.hidden = false;
    const contact = call.contact || call.caller || {};
    const name = contact.name || contact.deviceName || contact.deviceId || call.from || '联系人';
    overlay.dataset.state = call.state;
    if (avatar) avatar.textContent = String(name).trim().slice(0, 1).toUpperCase() || '☎';

    if (call.state === 'preparing' || call.state === 'preparing-accept') {
        if (stateLabel) stateLabel.textContent = '正在准备麦克风';
        title.textContent = call.state === 'preparing' ? `准备呼叫 ${name}` : `准备接听 ${name}`;
        subtitle.textContent = '请在浏览器提示中允许使用麦克风';
        setContactCallActions(call.state === 'preparing' ? [
            makeCallButton('取消', 'btn btn-secondary', () => mediaController.endContactCall('cancelled'))
        ] : []);
        return;
    }

    if (call.state === 'incoming') {
        if (stateLabel) stateLabel.textContent = '来电 · 全局联系人通话';
        title.textContent = `${name} 正在呼叫`;
        subtitle.textContent = '不经过当前隧道的联系人语音通话';
        setContactCallActions([
            makeCallButton('拒接', 'btn btn-secondary', () => mediaController.rejectContactCall(call, 'rejected')),
            makeCallButton('接听', 'btn btn-primary', () => mediaController.acceptContactCall(call).catch(err => {
                alert(`无法接听: ${err.message}`);
            }))
        ]);
        return;
    }

    if (call.state === 'dialing') {
        if (stateLabel) stateLabel.textContent = '正在拨号';
        title.textContent = `正在呼叫 ${name}`;
        subtitle.textContent = '等待对方接听...';
        setContactCallActions([
            makeCallButton('取消', 'btn btn-secondary', () => mediaController.endContactCall('cancelled'))
        ]);
        return;
    }

    if (call.state === 'active') {
        if (stateLabel) stateLabel.textContent = '通话中 · 已加密传输';
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
    if (state.activeContactCall && state.activeContactCall.state !== 'idle') {
        state.socket?.emit('contact-call-rejected', { callId: data.callId, to: data.from, reason: 'busy' });
        return;
    }
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

function announceNearbyPresence() {
    if (!state.socket?.connected || !state.deviceId) return;
    state.socket.emit('nearby-presence', {
        deviceId: state.deviceId,
        deviceName: state.deviceName,
        deviceModel: state.deviceModel,
        localIp: state.reportedLanIp || '',
        latitude: nearbyLocation?.latitude,
        longitude: nearbyLocation?.longitude
    });
}

function formatNearbyHint(device) {
    if (Number.isFinite(device?.distanceMeters)) {
        return device.distanceMeters < 1000 ? `约 ${device.distanceMeters} 米` : `约 ${(device.distanceMeters / 1000).toFixed(1)} 公里`;
    }
    return device?.discoveryReason === 'same-network' ? '同一网络' : '局域网候选';
}

async function inviteNearbyDeviceToCurrentTunnel(device) {
    if (!device?.deviceId || !state.sessionId) return;
    const invitationId = generateId();
    const invite = {
        invitationId,
        from: state.deviceId,
        to: device.deviceId,
        sessionId: state.sessionId,
        link: `${window.location.origin}/?open=1&invite=${encodeURIComponent(invitationId)}&from=${encodeURIComponent(state.deviceId)}#${state.sessionId}`,
        sender: {
            deviceId: state.deviceId,
            name: state.deviceName,
            profileUrl: `${window.location.origin}/device/${encodeURIComponent(state.deviceId)}`
        },
        createdAt: Date.now()
    };
    const response = await sendTunnelInvite(invite);
    if (!response?.delivered) {
        const queued = getQueuedTunnelInvites().filter(item => item.invitationId !== invitationId);
        queued.push(invite);
        setQueuedTunnelInvites(queued);
        showAppToast('对方暂时不可达，邀请已加入待发送队列');
        return;
    }
    showAppToast('已向附近设备发送加入邀请');
}

function renderNearbyDevices() {
    const container = document.getElementById('nearbyDeviceList');
    if (!container) return;
    container.replaceChildren();
    if (!state.nearbyDevices.size) {
        const empty = document.createElement('div');
        empty.className = 'contact-empty';
        empty.textContent = nearbyLocation ? '附近暂未发现其他在线设备' : '暂未发现同网络设备，可点击“增强发现”授权位置';
        container.appendChild(empty);
        return;
    }
    state.nearbyDevices.forEach(device => {
        const row = document.createElement('div');
        row.className = 'device-item contact-item';
        const info = document.createElement('div');
        info.className = 'info';
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = getDeviceDisplayName(device);
        const hint = document.createElement('div');
        hint.className = 'status';
        hint.textContent = formatNearbyHint(device);
        makeDeviceNameInteractive(name, {
            ...device,
            name: device.name || `设备-${device.deviceId.slice(-4)}`,
            profileUrl: device.profileUrl || `${window.location.origin}/device/${device.deviceId}`
        });
        info.append(name, hint);
        row.append(info);
        const alreadyJoined = state.devices.has(device.deviceId);
        if (!alreadyJoined) {
            const inviteButton = document.createElement('button');
            inviteButton.type = 'button';
            inviteButton.className = 'session-tool';
            inviteButton.textContent = '邀请';
            inviteButton.title = '邀请此设备加入当前隧道';
            inviteButton.addEventListener('click', async () => {
                inviteButton.disabled = true;
                await inviteNearbyDeviceToCurrentTunnel(device).catch(err => {
                    showAppToast(`邀请失败：${err.message}`);
                });
                setTimeout(() => { inviteButton.disabled = false; }, 1200);
            });
            row.appendChild(inviteButton);
        }
        container.appendChild(row);
    });
}

function enablePreciseNearbyDiscovery() {
    if (!window.isSecureContext || !navigator.geolocation) {
        showAppToast('当前浏览器需要 HTTPS 才能启用跨网络附近发现');
        return;
    }
    const button = document.getElementById('nearbyPreciseBtn');
    if (button) button.disabled = true;
    navigator.geolocation.getCurrentPosition(position => {
        nearbyLocation = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude
        };
        if (button) {
            button.disabled = false;
            button.textContent = '已增强';
        }
        announceNearbyPresence();
        showAppToast('已启用跨网络附近发现');
    }, error => {
        if (button) button.disabled = false;
        showAppToast(error.code === 1 ? '未获得位置权限' : '暂时无法获取位置');
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 });
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
        syncDeviceRemarkWithHelper(device.deviceId || device.id);
    });
    renderContacts();
    if (state.devices.size) scheduleLanP2pGuide();
}

// ==================== UI 初始化 ====================
function setMobileWorkspaceView(view, options = {}) {
    if (!['chat', 'devices', 'editor'].includes(view)) return;
    const appShell = document.getElementById('appShell');
    if (!appShell) return;

    currentMobileWorkspaceView = view;
    appShell.dataset.mobileView = view;
    const track = appShell.querySelector('.main-layout');
    track?.classList.remove('is-workspace-dragging');
    track?.style.removeProperty('transform');
    track?.style.setProperty('--workspace-index', String(getWorkspaceViewIndex(view)));
    document.querySelectorAll('.mobile-workspace-button[data-mobile-view]').forEach(button => {
        const active = button.dataset.mobileView === view;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });

    if (options.log !== false) {
        historyLog('mobile-workspace-view-changed', { view });
    }
}

async function focusTransferRecordById(messageId, options = {}) {
    if (!messageId) return false;
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 30000));
    const deadline = Date.now() + timeoutMs;
    let historyRequested = false;
    settleMobileWorkspaceView('chat');
    while (Date.now() < deadline) {
        let messageEl = getMessageElement(messageId);
        if (!messageEl) {
            const storedMessage = await getFromStore('messages', messageId).catch(() => null);
            if (storedMessage?.sessionId === state.sessionId) {
                await addMessageToChat(storedMessage, storedMessage.sender === state.deviceId, {
                    scroll: false,
                    autoRequestAsset: false
                });
                messageEl = getMessageElement(messageId);
            }
        }
        if (messageEl) {
            settleMobileWorkspaceView('chat');
            scrollMessageInsideChat(messageEl, options.behavior || 'auto');
            pinChatScrollToDomAnchor(messageId, 4500);
            flashResourceTarget(messageEl);
            return true;
        }
        if (!historyRequested && state.socket?.connected) {
            historyRequested = true;
            requestSessionHistory('record-deep-link');
        }
        await sleep(250);
    }
    return false;
}

async function handlePendingRecordNavigation() {
    const messageId = state.pendingRecordId;
    if (!messageId) return;
    const found = await focusTransferRecordById(messageId, { timeoutMs: 30000, behavior: 'auto' });
    if (!found) {
        showAppToast('目标传输记录暂未同步到本机，请稍后重试');
        return;
    }
    state.pendingRecordId = '';
    if (state.pendingRecordDetails) {
        await showTransferRecordDetails(messageId);
    }
}

async function handlePendingDeviceCallOrIntercom() {
    const params = new URLSearchParams(window.location.search);
    const callDeviceId = params.get('call');
    const intercomDeviceId = params.get('intercom');
    if (!callDeviceId && !intercomDeviceId) return;

    // Wait for socket to connect and device list to settle
    const deadline = Date.now() + 15000;
    while ((!state.socket?.connected || state.devices.size === 0) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!state.socket?.connected) {
        showAppToast('网络连接未就绪，无法发起通话');
        return;
    }

    if (callDeviceId) {
        const name = params.get('callName') || `设备-${callDeviceId.slice(-4)}`;
        const contact = state.contacts.get(callDeviceId) || { deviceId: callDeviceId, deviceName: name };
        try {
            await mediaController.startContactCall(contact);
        } catch (err) {
            showAppToast(`无法发起语音通话: ${err.message}`);
            historyLog('device-call-start-failed', { contactDeviceId: callDeviceId, error: err.message });
        }
        return;
    }

    if (intercomDeviceId) {
        try {
            await mediaController.startIntercom([intercomDeviceId]);
        } catch (err) {
            showAppToast(`无法发起对讲机: ${err.message}`);
            historyLog('device-intercom-start-failed', { contactDeviceId: intercomDeviceId, error: err.message });
        }
    }
}

function scrollMessageInsideChat(message, behavior = 'smooth') {
    const container = document.getElementById('chatMessages');
    if (!container || !message || !container.contains(message)) return;
    const targetTop = message.offsetTop - Math.max(0, (container.clientHeight - message.offsetHeight) / 2);
    container.scrollTo({ top: Math.max(0, targetTop), behavior });
}

function normalizeMobileWorkspaceView() {
    const appShell = document.getElementById('appShell');
    if (!appShell) return;
    const view = ['chat', 'devices', 'editor'].includes(currentMobileWorkspaceView)
        ? currentMobileWorkspaceView
        : (['chat', 'devices', 'editor'].includes(appShell.dataset.mobileView) ? appShell.dataset.mobileView : 'chat');
    setMobileWorkspaceView(view, { log: false });
}

function settleMobileWorkspaceView(view = currentMobileWorkspaceView) {
    setMobileWorkspaceView(view, { log: false });
    normalizeMobileWorkspaceView();
    requestAnimationFrame(normalizeMobileWorkspaceView);
    setTimeout(normalizeMobileWorkspaceView, 80);
}

function settleCurrentMobileWorkspaceView() {
    settleMobileWorkspaceView(currentMobileWorkspaceView);
}

function isAnyBlockingOverlayOpen() {
    return Boolean(
        document.querySelector('.modal-overlay.active') ||
        document.getElementById('filePreviewViewer')?.classList.contains('active') ||
        document.getElementById('mediaFullscreenViewer')?.classList.contains('active') ||
        document.getElementById('richViewer')?.classList.contains('active') ||
        document.getElementById('transferRecordDetailsLayer') ||
        (document.getElementById('downloadCacheOverlay') && !document.getElementById('downloadCacheOverlay').hidden) ||
        document.getElementById('resourceBrowserLayer')?.classList.contains('active')
    );
}

function shouldIgnoreWorkspaceSwipeTarget(target) {
    return Boolean(target?.closest?.(
        'input, textarea, select, button, a, .toolbar, .editor-toolbar, .file-preview-actions, .mobile-workspace-nav, .tunnel-topbar'
    ));
}

function getAdjacentWorkspaceView(delta) {
    const views = ['devices', 'chat', 'editor'];
    const currentIndex = Math.max(0, views.indexOf(currentMobileWorkspaceView));
    const nextIndex = Math.min(views.length - 1, Math.max(0, currentIndex + delta));
    return views[nextIndex];
}

function getWorkspaceViewIndex(view = currentMobileWorkspaceView) {
    return Math.max(0, ['devices', 'chat', 'editor'].indexOf(view));
}

function getWorkspaceViewByIndex(index) {
    return ['devices', 'chat', 'editor'][Math.min(2, Math.max(0, index))] || 'chat';
}

function initWorkspaceSwipeNavigation() {
    const appShell = document.getElementById('appShell');
    if (!appShell) return;
    const track = appShell.querySelector('.main-layout');
    let swipeStart = null;
    const resetTrack = () => {
        track?.classList.remove('is-workspace-dragging');
        track?.style.removeProperty('transform');
        swipeStart = null;
    };
    const normalizeSoon = () => requestAnimationFrame(normalizeMobileWorkspaceView);
    appShell.addEventListener('pointerdown', event => {
        if (!window.matchMedia('(max-width: 767px)').matches) return;
        if (event.pointerType !== 'touch') return;
        if (isAnyBlockingOverlayOpen() || shouldIgnoreWorkspaceSwipeTarget(event.target)) return;
        const index = getWorkspaceViewIndex();
        swipeStart = {
            x: event.clientX,
            y: event.clientY,
            lastX: event.clientX,
            lastAt: performance.now(),
            velocity: 0,
            target: event.target,
            index,
            width: Math.max(1, appShell.clientWidth || window.innerWidth || 1),
            dragging: false
        };
        try {
            appShell.setPointerCapture?.(event.pointerId);
        } catch (_) {}
    }, { passive: true });
    appShell.addEventListener('pointermove', event => {
        if (!swipeStart) return;
        if (isAnyBlockingOverlayOpen() || shouldIgnoreWorkspaceSwipeTarget(swipeStart.target)) {
            resetTrack();
            return;
        }
        const dx = event.clientX - swipeStart.x;
        const dy = event.clientY - swipeStart.y;
        const now = performance.now();
        const dt = Math.max(1, now - swipeStart.lastAt);
        swipeStart.velocity = (event.clientX - swipeStart.lastX) / dt;
        swipeStart.lastX = event.clientX;
        swipeStart.lastAt = now;
        if (!swipeStart.dragging) {
            if (Math.abs(dx) < 6) return;
            if (Math.abs(dx) < Math.abs(dy) * 0.95) return;
            swipeStart.dragging = true;
            track?.classList.add('is-workspace-dragging');
        }
        event.preventDefault();
        const minOffset = -2 * swipeStart.width;
        const maxOffset = 0;
        const resistance = (swipeStart.index === 0 && dx > 0) || (swipeStart.index === 2 && dx < 0) ? 0.32 : 1;
        const nextOffset = Math.max(minOffset, Math.min(maxOffset, (-swipeStart.index * swipeStart.width) + dx * resistance));
        if (track) track.style.transform = `translateX(${nextOffset}px)`;
    });
    appShell.addEventListener('pointerup', event => {
        if (!swipeStart) return;
        const start = swipeStart;
        swipeStart = null;
        track?.classList.remove('is-workspace-dragging');
        if (isAnyBlockingOverlayOpen() || shouldIgnoreWorkspaceSwipeTarget(start.target)) {
            track?.style.removeProperty('transform');
            return;
        }
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        const shouldChange = start.dragging && Math.abs(dx) > Math.min(96, start.width * 0.22) && Math.abs(dx) > Math.abs(dy) * 0.72;
        const velocityChange = start.dragging && Math.abs(start.velocity) > 0.55 && Math.abs(dx) > 32;
        const nextIndex = shouldChange || velocityChange
            ? start.index + (dx < 0 ? 1 : -1)
            : start.index;
        setMobileWorkspaceView(getWorkspaceViewByIndex(nextIndex), { user: true });
    });
    appShell.addEventListener('pointercancel', resetTrack);
    appShell.addEventListener('pointerleave', () => {
        if (swipeStart?.dragging) return;
        resetTrack();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            resetTrack();
            normalizeSoon();
        }
    });
    window.addEventListener('pageshow', normalizeSoon);
    window.addEventListener('resize', normalizeSoon);
    window.addEventListener('orientationchange', normalizeSoon);
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
            const code = escapeHtml(normalizeLocalShortCode(session.shortCode) || '-----');
            return `<button class="session-tool session-switch-item${currentClass}" data-session-id="${id}" style="width:100%;justify-content:flex-start;margin:6px 0;"><strong>${code}${remark ? ` · ${remark}` : ''}</strong><br><small>${time}</small></button>`;
        }).join('')
        : '<p>本设备还没有加入过其它隧道。</p>';
    dialog.innerHTML = `
        <div class="modal session-switcher-modal">
            <button class="session-switcher-close" id="closeSessionSwitcher" type="button" aria-label="关闭">×</button>
            <h3>切换隧道</h3>
            <button class="session-switch-scroll" type="button" data-scroll="-1" aria-label="向上滚动">⌃</button>
            <div class="session-switcher-list" id="sessionSwitcherList">${list}</div>
            <button class="session-switch-scroll" type="button" data-scroll="1" aria-label="向下滚动">⌄</button>
        </div>
    `;
    document.body.appendChild(dialog);
    dialog.addEventListener('click', event => {
        if (event.target === dialog) dialog.remove();
    });
    dialog.querySelector('#closeSessionSwitcher').addEventListener('click', () => dialog.remove());
    const scroller = dialog.querySelector('#sessionSwitcherList');
    const updateScrollButtons = () => {
        if (!scroller) return;
        const hasOverflow = scroller.scrollHeight > scroller.clientHeight + 2;
        dialog.querySelectorAll('.session-switch-scroll').forEach(button => {
            button.hidden = !hasOverflow;
        });
    };
    dialog.querySelectorAll('[data-scroll]').forEach(button => {
        button.addEventListener('click', () => {
            const direction = Number(button.dataset.scroll) || 1;
            scroller?.scrollBy({ top: direction * Math.max(120, scroller.clientHeight * 0.75), behavior: 'smooth' });
        });
    });
    requestAnimationFrame(() => {
        updateScrollButtons();
        const current = scroller?.querySelector('.session-switch-item.is-current');
        if (!current || !scroller) return;
        current.scrollIntoView({ block: 'center', inline: 'nearest' });
        requestAnimationFrame(updateScrollButtons);
    });
    window.addEventListener('resize', updateScrollButtons, { once: true });
    dialog.querySelectorAll('[data-session-id]').forEach(button => {
        button.addEventListener('click', () => {
            const sessionId = button.dataset.sessionId;
            if (sessionId && sessionId !== state.sessionId) {
                if (hasActiveTransferTasks()) {
                    const ok = confirm('切换到别的隧道，将停止当前正在进行的数据传输任务，是否切换？');
                    if (!ok) return;
                }
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
    const shouldSelectInput = window.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches;
    input.focus({ preventScroll: true });
    if (shouldSelectInput) {
        input.select();
    } else {
        const end = input.value.length;
        input.setSelectionRange?.(end, end);
        requestAnimationFrame(() => {
            clearSelection();
            input.setSelectionRange?.(end, end);
        });
    }
    const close = () => overlay.remove();
    overlay.addEventListener('selectstart', event => {
        if (event.target === input) return;
        event.preventDefault();
    });
    overlay.addEventListener('contextmenu', event => {
        if (event.target === input) return;
        event.preventDefault();
    });
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
        const remark = String(session.remark || '').trim();
        button.innerHTML = `<strong>${escapeHtml(code)}${remark ? ` · ${escapeHtml(remark)}` : ''}</strong>`;
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
            setMobileWorkspaceView(button.dataset.mobileView, { user: true });
        });
    });
    const tunnelButton = document.querySelector('.mobile-workspace-button[data-mobile-view="chat"]');
    if (tunnelButton) {
        let longPressTimer = null;
        let suppressNextClick = false;
        let holdStartPoint = null;
        let lastRemarkHoldAt = 0;
        const cancel = () => {
            if (longPressTimer) clearTimeout(longPressTimer);
            longPressTimer = null;
            holdStartPoint = null;
        };
        const pointFromEvent = event => {
            const touch = event?.touches?.[0] || event?.changedTouches?.[0];
            return touch
                ? { x: touch.clientX, y: touch.clientY }
                : { x: event?.clientX || 0, y: event?.clientY || 0 };
        };
        const cancelIfMoved = event => {
            if (!holdStartPoint) return;
            const point = pointFromEvent(event);
            if (Math.hypot(point.x - holdStartPoint.x, point.y - holdStartPoint.y) > 14) cancel();
        };
        const openTunnelRemarkFromHold = event => {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            clearSelection();
            const now = Date.now();
            if (now - lastRemarkHoldAt < 650) {
                suppressNextClick = true;
                return;
            }
            lastRemarkHoldAt = now;
            suppressNextClick = true;
            showTunnelRemarkDialog();
        };
        const scheduleHold = event => {
            cancel();
            holdStartPoint = pointFromEvent(event);
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                openTunnelRemarkFromHold(event);
                navigator.vibrate?.(12);
            }, 560);
        };
        tunnelButton.addEventListener('selectstart', event => event.preventDefault());
        tunnelButton.addEventListener('dragstart', event => event.preventDefault());
        tunnelButton.addEventListener('contextmenu', event => {
            event.preventDefault();
            openTunnelRemarkFromHold(event);
        });
        tunnelButton.addEventListener('pointerdown', event => {
            if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
            scheduleHold(event);
        });
        tunnelButton.addEventListener('pointermove', cancelIfMoved);
        if (!window.PointerEvent) {
            tunnelButton.addEventListener('touchstart', scheduleHold, { passive: true });
            tunnelButton.addEventListener('touchmove', cancelIfMoved, { passive: true });
            ['touchend', 'touchcancel'].forEach(eventName => {
                tunnelButton.addEventListener(eventName, cancel, { passive: true });
            });
        }
        tunnelButton.addEventListener('click', event => {
            if (!suppressNextClick) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            suppressNextClick = false;
        }, true);
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(eventName => {
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
    const progress = showBlockingProgressPanel('正在退出隧道', '正在清理本机缓存与传输记录...');
    try {
        state.isExitingTunnel = true;
        if (chatScrollAnchorSaveTimer) clearTimeout(chatScrollAnchorSaveTimer);
        if (musicPlayerPersistTimer) clearTimeout(musicPlayerPersistTimer);
        if (musicPlayerDurablePersistTimer) clearTimeout(musicPlayerDurablePersistTimer);
        state.socket?.disconnect();
        await purgeLocalSession(state.sessionId, {
            onProgress: (value, detail) => progress.update(value, detail)
        });
        progress.update(100, '清理完成，正在返回入口...');
        state.db?.close?.();
        window.location.href = `${window.location.origin}${window.location.pathname}?leave=1`;
    } catch (err) {
        progress.close();
        state.isExitingTunnel = false;
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
    const selected = ['classic', 'graphite', 'atelier', 'social'].includes(theme) ? theme : 'classic';
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
        const themes = ['classic', 'graphite', 'atelier', 'social'];
        const current = document.body.dataset.theme || 'classic';
        const next = themes[(themes.indexOf(current) + 1) % themes.length];
        applyTheme(next);
        historyLog('theme-changed', { theme: next, source: 'topbar-cycle' });
    });
    document.getElementById('topbarMusicBtn')?.addEventListener('click', () => {
        openMusicPlayerOverlay({ resetQueue: true });
    });
}

function isTunnelOwner() {
    return !state.sessionOwnerDeviceId || state.sessionOwnerDeviceId === state.deviceId;
}

function canManageTunnelSettings() {
    return isTunnelOwner();
}

function hasTunnelPermission(capability) {
    if (isTunnelOwner()) return true;
    if (state.sessionSelfAdminPermissions) return state.sessionSelfAdminPermissions?.[capability] !== false;
    return state.sessionPermissions?.[capability] !== false;
}

function requireTunnelPermission(capability) {
    if (hasTunnelPermission(capability)) return true;
    showAppToast(`当前隧道权限不允许：${TUNNEL_PERMISSION_LABELS[capability] || capability}`);
    return false;
}

function getTunnelKnownDevicesForAdminPicker() {
    const devices = new Map();
    if (state.deviceId) devices.set(state.deviceId, { deviceId: state.deviceId, deviceName: state.deviceName || '本设备' });
    state.devices.forEach((device, id) => {
        const deviceId = device.deviceId || id;
        if (deviceId) devices.set(deviceId, { ...device, deviceId });
    });
    return Array.from(devices.values())
        .filter(device => device.deviceId && device.deviceId !== state.sessionOwnerDeviceId && device.deviceId !== state.deviceId)
        .sort((a, b) => String(a.deviceName || a.deviceId).localeCompare(String(b.deviceName || b.deviceId), undefined, { numeric: true }));
}

function getDeviceNameForAdminRecord(deviceId, fallback = '') {
    if (state.devices.has(deviceId)) return state.devices.get(deviceId).deviceName || state.devices.get(deviceId).name || fallback;
    if (deviceId === state.deviceId) return state.deviceName || fallback;
    return fallback || deviceId;
}

function refreshTunnelAdminDevicePicker(knownDevices = getTunnelKnownDevicesForAdminPicker()) {
    const select = document.getElementById('tunnelAdminDeviceSelect');
    if (!select) return;
    const placeholder = knownDevices.length ? '选择在线设备' : '暂无可选在线设备';
    const desiredOptions = [
        { value: '', label: placeholder },
        ...knownDevices.map(device => ({
            value: device.deviceId,
            label: `${device.deviceName || device.name || '未命名设备'} · ${String(device.deviceId).slice(0, 8)}...`
        }))
    ];
    const optionSignature = JSON.stringify(desiredOptions);
    if (select.dataset.adminPickerSignature === optionSignature) return;

    const selectedDeviceId = select.value;
    select.replaceChildren(...desiredOptions.map(option => new Option(option.label, option.value)));
    select.dataset.adminPickerSignature = optionSignature;
    if (selectedDeviceId && desiredOptions.some(option => option.value === selectedDeviceId)) {
        select.value = selectedDeviceId;
    }
}

function renderTunnelAdminSettings() {
    const container = document.getElementById('tunnelAdminDeviceList');
    const hint = document.getElementById('tunnelAdminHint');
    const save = document.getElementById('saveTunnelAdminsBtn');
    const add = document.getElementById('addTunnelAdminBtn');
    const select = document.getElementById('tunnelAdminDeviceSelect');
    const manual = document.getElementById('tunnelAdminManualId');
    if (!container || !hint || !save || !add || !select || !manual) return;

    const editable = canManageTunnelSettings();
    const admins = Array.from(state.sessionAdminDevices.values());
    const knownDevices = getTunnelKnownDevicesForAdminPicker();
    refreshTunnelAdminDevicePicker(knownDevices);
    select.disabled = !editable;
    manual.disabled = !editable;
    add.disabled = !editable;
    save.hidden = !editable;
    hint.textContent = editable
        ? '只有隧道创建者可添加或移除管理员；管理员使用这里分配的独立权限。'
        : (state.sessionIsAdmin ? '你是此隧道管理员，正在使用独立权限。' : '仅隧道创建者可配置管理员。');

    container.replaceChildren();
    if (!admins.length) {
        const empty = document.createElement('div');
        empty.className = 'tunnel-admin-empty';
        empty.textContent = '尚未添加指定设备管理员。';
        container.appendChild(empty);
        return;
    }
    admins.forEach(record => {
        const card = document.createElement('div');
        card.className = 'tunnel-admin-card';
        card.dataset.adminDeviceId = record.deviceId;
        const title = document.createElement('div');
        title.className = 'tunnel-admin-card-title';
        const name = document.createElement('strong');
        name.textContent = record.deviceName || getDeviceNameForAdminRecord(record.deviceId, '未命名设备');
        const id = document.createElement('span');
        id.textContent = record.deviceId;
        title.append(name, id);
        const grid = document.createElement('div');
        grid.className = 'tunnel-permission-grid tunnel-admin-permission-grid';
        Object.entries(TUNNEL_PERMISSION_LABELS).forEach(([key, label]) => {
            const option = document.createElement('label');
            option.className = 'tunnel-permission-option';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.dataset.adminPermission = key;
            input.checked = record.permissions?.[key] !== false;
            input.disabled = !editable;
            option.append(input, document.createTextNode(label));
            grid.appendChild(option);
        });
        const actions = document.createElement('div');
        actions.className = 'tunnel-admin-actions';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-secondary';
        remove.textContent = '移除管理员';
        remove.disabled = !editable;
        remove.addEventListener('click', () => {
            state.sessionAdminDevices.delete(record.deviceId);
            renderTunnelAdminSettings();
        });
        actions.appendChild(remove);
        card.append(title, grid, actions);
        container.appendChild(card);
    });
}

function renderTunnelPermissionSettings() {
    const grid = document.getElementById('tunnelPermissionGrid');
    const hint = document.getElementById('tunnelPermissionOwnerHint');
    const save = document.getElementById('saveTunnelPermissionsBtn');
    if (!grid || !hint || !save) return;
    const permissions = { ...DEFAULT_TUNNEL_PERMISSIONS, ...(state.sessionPermissions || {}) };
    grid.replaceChildren();
    Object.entries(TUNNEL_PERMISSION_LABELS).forEach(([key, label]) => {
        const option = document.createElement('label');
        option.className = 'tunnel-permission-option';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.permission = key;
        input.checked = permissions[key] !== false;
        input.disabled = !canManageTunnelSettings();
        option.append(input, document.createTextNode(label));
        grid.appendChild(option);
    });
    hint.textContent = isTunnelOwner() ? '你是隧道创建者' : (state.sessionIsAdmin ? '你是指定设备管理员' : '仅创建者可修改');
    save.hidden = !canManageTunnelSettings();
    renderTunnelAdminSettings();
}

function applyTunnelPermissionUi() {
    const bindings = {
        sendTextBtn: 'sendText',
        textInput: 'sendText',
        dropZone: 'sendFile',
        fileInput: 'sendFile',
        folderUploadBtn: 'sendFile',
        directorySyncBtn: 'sendFile',
        sendRichBtn: 'sendRich',
        editor: 'collaborativeEdit',
        clearEditorBtn: 'collaborativeEdit',
        insertImageBtn: 'collaborativeEdit',
        insertFileBtn: 'collaborativeEdit',
        globalIntercomBtn: 'globalIntercom',
        voiceChatBtn: 'groupVoice'
    };
    Object.entries(bindings).forEach(([id, capability]) => {
        const element = document.getElementById(id);
        if (!element) return;
        const allowed = hasTunnelPermission(capability);
        if ('disabled' in element) element.disabled = !allowed;
        element.setAttribute('aria-disabled', String(!allowed));
        element.classList.toggle('permission-disabled', !allowed);
        if (id === 'editor') element.contentEditable = allowed ? 'true' : 'false';
    });
    const chatMessages = document.getElementById('chatMessages');
    const canRead = hasTunnelPermission('read');
    chatMessages?.classList.toggle('permission-read-blocked', !canRead);
    if (chatMessages) chatMessages.inert = !canRead;
    ['resourceBrowserBtn', 'historyBackupBtn'].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.disabled = !canRead;
    });
    renderTunnelPermissionSettings();
}

async function updateLanP2pPermissionUi() {
    const button = document.getElementById('grantLanP2pPermissionBtn');
    const status = document.getElementById('lanP2pPermissionStatus');
    if (!button || !status) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        button.disabled = true;
        status.textContent = '需要 HTTPS';
        return;
    }
    button.disabled = false;
    try {
        const states = await Promise.all(['camera', 'microphone'].map(name => navigator.permissions.query({ name })));
        status.textContent = states.every(permission => permission.state === 'granted') ? '已授权' : '未授权';
    } catch {
        status.textContent = '状态未知';
    }
}

function hasSameLanTunnelPeer() {
    const ownExternalIp = state.selfNetworkInfo?.externalIp || '';
    const ownIp = String(state.selfNetworkInfo?.internalIp || state.reportedLanIp || '').split('.');
    return Array.from(state.devices.values()).some(device => {
        const nearbyReason = state.nearbyDevices.get(device.id)?.discoveryReason;
        if (nearbyReason === 'same-network' || nearbyReason === 'local-subnet') return true;
        if (ownExternalIp && device.externalIp === ownExternalIp) return true;
        const peerIp = String(device.internalIp || '').split('.');
        return ownIp.length === 4 && peerIp.length === 4 && isPrivateNetworkIp(ownIp.join('.')) &&
            ownIp.slice(0, 3).join('.') === peerIp.slice(0, 3).join('.');
    });
}

function scheduleLanP2pGuide() {
    if (location.protocol !== 'https:' || !state.devices.size) return;
    if (lanP2pGuideTimer) clearTimeout(lanP2pGuideTimer);
    lanP2pGuideTimer = setTimeout(() => {
        lanP2pGuideTimer = null;
        maybeShowLanP2pGuide('same-lan');
    }, 5000);
}

async function maybeShowLanP2pGuide(reason) {
    const guide = document.getElementById('lanP2pGuide');
    if (!guide || location.protocol !== 'https:' || !state.devices.size || !navigator.mediaDevices?.getUserMedia ||
        guide.dataset.state || (reason !== 'relay' && !hasSameLanTunnelPeer())) return;
    try {
        if (sessionStorage.getItem('drop2tunnel.lanP2pGuideSeen')) {
            guide.dataset.state = 'seen';
            return;
        }
    } catch (_) {}

    guide.dataset.state = 'checking';
    try {
        const permissions = await Promise.all(['camera', 'microphone'].map(name => navigator.permissions.query({ name })));
        if (permissions.every(permission => permission.state === 'granted')) {
            guide.dataset.state = 'granted';
            return;
        }
    } catch (_) {}

    try { sessionStorage.setItem('drop2tunnel.lanP2pGuideSeen', '1'); } catch (_) {}
    guide.dataset.state = 'shown';
    guide.hidden = false;
    historyLog('lan-p2p-guide-shown', { reason });
}

function initLanP2pGuide() {
    const guide = document.getElementById('lanP2pGuide');
    if (!guide) return;
    const dismiss = () => {
        guide.hidden = true;
        guide.dataset.state = 'dismissed';
    };
    guide.querySelectorAll('[data-dismiss-lan-p2p-guide]').forEach(button => button.addEventListener('click', dismiss));
    document.getElementById('openLanP2pEnhancementBtn')?.addEventListener('click', () => {
        dismiss();
        document.getElementById('tunnelSettingsBtn')?.click();
        requestAnimationFrame(() => {
            document.getElementById('lanP2pEnhancementSection')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            document.getElementById('grantLanP2pPermissionBtn')?.focus({ preventScroll: true });
        });
    });
}

async function grantLanP2pPermission() {
    const button = document.getElementById('grantLanP2pPermissionBtn');
    let stream;
    if (button) button.disabled = true;
    try {
        stream = await mediaController.getMedia({ video: true, audio: true });
        showAppToast('授权完成，请刷新页面后建立新的 P2P 连接');
    } catch (err) {
        historyLog('lan-p2p-permission-failed', { name: err.name, error: err.message });
        showAppToast('授权失败，请在站点设置中允许摄像头和麦克风');
    } finally {
        stream?.getTracks().forEach(track => track.stop());
        await updateLanP2pPermissionUi();
    }
}

function initTunnelSettings() {
    initCallRingtoneSettings();
    const settingsToolGrid = document.getElementById('settingsToolGrid');
    const connectionTools = document.querySelector('.left-panel .session-tools');
    if (settingsToolGrid && connectionTools && connectionTools !== settingsToolGrid) {
        while (connectionTools.firstChild) settingsToolGrid.appendChild(connectionTools.firstChild);
        connectionTools.remove();
    }
    const layer = document.getElementById('tunnelSettingsLayer');
    const open = () => {
        renderTunnelPermissionSettings();
        updateLanP2pPermissionUi();
        refreshCallRingtoneSettingsUi();
        layer.hidden = false;
    };
    const close = () => { layer.hidden = true; };
    settingsToolGrid?.addEventListener('click', event => {
        if (event.target.closest('button')) close();
    }, true);
    document.getElementById('tunnelSettingsBtn')?.addEventListener('click', open);
    document.getElementById('grantLanP2pPermissionBtn')?.addEventListener('click', grantLanP2pPermission);
    document.getElementById('closeTunnelSettingsBtn')?.addEventListener('click', close);
    layer?.addEventListener('click', event => {
        if (event.target === layer) close();
    });
    document.getElementById('saveTunnelPermissionsBtn')?.addEventListener('click', () => {
        if (!canManageTunnelSettings()) return;
        const permissions = {};
        layer.querySelectorAll('[data-permission]').forEach(input => { permissions[input.dataset.permission] = input.checked; });
        state.socket.timeout(8000).emit('session-permissions-update', {
            sessionId: state.sessionId,
            permissions
        }, (err, response) => {
            if (err || !response?.ok) return showAppToast('隧道权限保存失败');
            state.sessionPermissions = { ...DEFAULT_TUNNEL_PERMISSIONS, ...(response.permissions || permissions) };
            if (Array.isArray(response.adminDevices)) {
                state.sessionAdminDevices = new Map(response.adminDevices.map(record => [record.deviceId, {
                    ...record,
                    permissions: { ...DEFAULT_TUNNEL_PERMISSIONS, ...(record.permissions || {}) }
                }]));
            }
            applyTunnelPermissionUi();
            showAppToast('隧道默认权限已保存');
        });
    });
    document.getElementById('addTunnelAdminBtn')?.addEventListener('click', () => {
        if (!canManageTunnelSettings()) return;
        const select = document.getElementById('tunnelAdminDeviceSelect');
        const manual = document.getElementById('tunnelAdminManualId');
        const deviceId = String(manual?.value || select?.value || '').trim();
        if (!deviceId) return showAppToast('请选择在线设备，或输入设备 ID');
        if (deviceId === state.deviceId || deviceId === state.sessionOwnerDeviceId) return showAppToast('创建者无需添加为管理员');
        const deviceName = getDeviceNameForAdminRecord(deviceId, '指定设备');
        state.sessionAdminDevices.set(deviceId, {
            deviceId,
            deviceName,
            permissions: { ...DEFAULT_TUNNEL_PERMISSIONS },
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
        if (manual) manual.value = '';
        renderTunnelAdminSettings();
    });
    document.getElementById('saveTunnelAdminsBtn')?.addEventListener('click', () => {
        if (!canManageTunnelSettings()) return;
        const admins = {};
        layer.querySelectorAll('.tunnel-admin-card[data-admin-device-id]').forEach(card => {
            const deviceId = card.dataset.adminDeviceId;
            const record = state.sessionAdminDevices.get(deviceId) || { deviceId, permissions: {} };
            const permissions = {};
            card.querySelectorAll('[data-admin-permission]').forEach(input => {
                permissions[input.dataset.adminPermission] = input.checked;
            });
            admins[deviceId] = {
                ...record,
                permissions,
                deviceName: record.deviceName || getDeviceNameForAdminRecord(deviceId, ''),
                updatedAt: Date.now()
            };
        });
        state.socket.timeout(8000).emit('session-admins-update', {
            sessionId: state.sessionId,
            admins
        }, (err, response) => {
            if (err || !response?.ok) return showAppToast('管理员权限保存失败');
            state.sessionAdminDevices = new Map((response.adminDevices || []).map(record => [record.deviceId, {
                ...record,
                permissions: { ...DEFAULT_TUNNEL_PERMISSIONS, ...(record.permissions || {}) }
            }]));
            applyTunnelPermissionUi();
            showAppToast('指定设备管理员已保存');
        });
    });
}

function initUI() {
    initTunnelSettings();
    initLanP2pGuide();
    initThemeSwitcher();
    window.addEventListener('beforeunload', persistMusicPlayerStateNow);
    window.addEventListener('pagehide', persistMusicPlayerStateNow);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') persistMusicPlayerStateNow();
        if (document.visibilityState === 'visible') {
            validateVisibleExternalFileSources().catch(err => historyLog('external-file-visible-validation-failed', { error: err.message }));
        }
    });
    window.addEventListener('focus', () => {
        validateVisibleExternalFileSources().catch(err => historyLog('external-file-focus-validation-failed', { error: err.message }));
    });
    initMobileWorkspace();
    initProgressDrawer();
    initChatScrollAnchorTracking();
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
    document.getElementById('nearbyPreciseBtn')?.addEventListener('click', enablePreciseNearbyDiscovery);
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
    document.getElementById('connectionHeaderMenuBtn')?.addEventListener('click', event => {
        event.stopPropagation();
        const menu = document.getElementById('connectionHeaderMenu');
        if (menu) menu.hidden = !menu.hidden;
    });
    document.getElementById('scanTunnelCodeBtn')?.addEventListener('click', () => {
        const menu = document.getElementById('connectionHeaderMenu');
        if (menu) menu.hidden = true;
        openTunnelCodeScanner().catch(err => alert(`无法扫描隧道码：${err.message}`));
    });
    document.getElementById('receiveLightBtn')?.addEventListener('click', () => {
        const menu = document.getElementById('connectionHeaderMenu');
        if (menu) menu.hidden = true;
        getLightTransferApi()?.openReceiver().catch(err => alert(`无法开始光媒接收：${err.message}`));
    });
    document.addEventListener('click', event => {
        if (!event.target.closest?.('.connection-header-menu-wrap')) {
            const menu = document.getElementById('connectionHeaderMenu');
            if (menu) menu.hidden = true;
        }
    });
    configureLightTransfer();
    document.getElementById('joinShortCodeBtn').addEventListener('click', joinByShortCode);
    document.getElementById('shortCodeInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') joinByShortCode();
    });
    document.getElementById('clipboardShareBtn').addEventListener('click', toggleClipboardShare);
    document.getElementById('copySharedClipboardBtn').addEventListener('click', copySharedClipboard);
    document.getElementById('garbageCleanupBtn').addEventListener('click', showGarbageCleanupDialog);
    document.getElementById('resourceBrowserBtn').addEventListener('click', () => {
        showResourceBrowser({ restoreIfMinimized: true }).catch(err => {
            historyLog('resource-browser-open-failed', { error: err.message });
            alert(`无法打开资源浏览器: ${err.message}`);
        });
    });
    document.getElementById('historyBackupBtn')?.addEventListener('click', showHistoryBackupDialog);
    document.getElementById('historyBackupInput')?.addEventListener('change', event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) importTransferHistoryBackup(file).catch(err => alert(`导入失败：${err.message}`));
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
        if (!requireTunnelPermission('groupVoice')) return;
        try {
            if (mediaController.voice) mediaController.leaveVoice();
            else await mediaController.joinVoice();
        } catch (err) {
            alert(`无法加入语音聊天: ${err.message}`);
            historyLog('voice-join-failed', { error: err.message });
        }
    });

    document.getElementById('globalIntercomBtn').addEventListener('click', async () => {
        if (!requireTunnelPermission('globalIntercom')) return;
        try {
            if (mediaController.intercom) {
                mediaController.stopIntercom();
            } else {
                const recipients = Array.from(state.devices.values())
                    .filter(device => device.clientType !== 'vclient')
                    .map(device => device.id || device.deviceId)
                    .filter(Boolean);
                if (!recipients.length) return;
                await mediaController.startIntercom(recipients);
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
        if (!requireTunnelPermission('sendFile')) return;
        pickFilesForSending().catch(err => {
            historyLog('file-picker-send-failed', { error: err.message });
            alert(`选择文件失败：${err.message}`);
        });
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
    document.getElementById('filePreviewLightShareBtn')?.addEventListener('click', () => {
        shareCurrentPreviewViaLight().catch(err => {
            alert(`光媒分享失败：${err.message}`);
            historyLog('light-share-preview-failed', { fileId: activeFilePreviewFileId, error: err.message });
        });
    });
    document.getElementById('filePreviewFullscreenBtn')?.addEventListener('click', () => {
        openActivePreviewFullscreen().catch(err => historyLog('media-fullscreen-open-failed', { error: err.message }));
    });
    document.getElementById('filePreviewRemoteBtn')?.addEventListener('click', openRemotePreviewDeviceModal);
    document.getElementById('filePreviewMusicBtn')?.addEventListener('click', () => {
        openMusicPlayerFromActivePreview().catch(err => historyLog('music-player-open-failed', { error: err.message }));
    });
    document.getElementById('closeRemotePreviewDeviceBtn')?.addEventListener('click', closeRemotePreviewDeviceModal);
    document.getElementById('remotePreviewDeviceModal')?.addEventListener('click', event => {
        if (event.target === event.currentTarget) closeRemotePreviewDeviceModal();
    });
    document.getElementById('remotePreviewDeviceModal')?.addEventListener('cancel', event => {
        event.preventDefault();
        closeRemotePreviewDeviceModal();
    });
    document.getElementById('remotePreviewControlPrevBtn')?.addEventListener('click', () => sendRemotePreviewControl('previous'));
    document.getElementById('remotePreviewControlNextBtn')?.addEventListener('click', () => sendRemotePreviewControl('next'));
    document.getElementById('remotePreviewControlPlaybackBtn')?.addEventListener('click', () => sendRemotePreviewControl('toggle-playback'));
    document.getElementById('remotePreviewControlMinimizeBtn')?.addEventListener('click', minimizeRemotePreviewControlPanel);
    document.getElementById('remotePreviewControlCloseBtn')?.addEventListener('click', () => sendRemotePreviewControl('exit', { closePanel:true }));
    const remotePreviewBubble = document.getElementById('remotePreviewControlBubble');
    remotePreviewBubble?.addEventListener('click', event => {
        if (remotePreviewBubbleSuppressClick) {
            remotePreviewBubbleSuppressClick = false;
            event.preventDefault();
            return;
        }
        restoreRemotePreviewControlPanel();
    });
    remotePreviewBubble?.addEventListener('pointerdown', beginRemotePreviewBubbleDrag);
    remotePreviewBubble?.addEventListener('pointermove', moveRemotePreviewBubble);
    remotePreviewBubble?.addEventListener('pointerup', finishRemotePreviewBubbleDrag);
    remotePreviewBubble?.addEventListener('pointercancel', finishRemotePreviewBubbleDrag);
    window.addEventListener('resize', () => {
        if (remotePreviewBubblePosition) positionRemotePreviewControlBubble(remotePreviewBubblePosition.x, remotePreviewBubblePosition.y);
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
    document.getElementById('filePreviewContent')?.addEventListener('dblclick', event => {
        if (!activeFilePreviewCanFullscreen || !isPreviewMediaTarget(event.target)) return;
        event.preventDefault();
        openActivePreviewFullscreen().catch(err => historyLog('media-fullscreen-open-failed', { error: err.message }));
    });
    document.getElementById('filePreviewViewer')?.addEventListener('pointerdown', event => {
        if (!document.getElementById('filePreviewViewer')?.classList.contains('active')) return;
        if (event.pointerType !== 'touch') return;
        if (shouldIgnorePreviewGestureTarget(event.target)) return;
        try {
            event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch (_) {}
        filePreviewPointerStart = { x: event.clientX, y: event.clientY, target: event.target, pointerType: event.pointerType };
    }, true);
    document.getElementById('filePreviewViewer')?.addEventListener('pointerup', event => {
        if (!filePreviewPointerStart) return;
        const dx = event.clientX - filePreviewPointerStart.x;
        const dy = event.clientY - filePreviewPointerStart.y;
        const startTarget = filePreviewPointerStart.target;
        const pointerType = filePreviewPointerStart.pointerType;
        filePreviewPointerStart = null;
        if (shouldIgnorePreviewGestureTarget(startTarget)) return;
        if (Math.abs(dx) > 26 && Math.abs(dx) > Math.abs(dy) * 1.02) {
            event.preventDefault();
            navigateFilePreview(dx < 0 ? 1 : -1).catch(err => historyLog('file-preview-swipe-navigate-failed', { error: err.message }));
            return;
        }
        if (pointerType === 'touch' && Math.abs(dy) > 46 && Math.abs(dy) > Math.abs(dx) * 1.22) {
            event.preventDefault();
            if (dy < 0 && activeFilePreviewCanFullscreen && isPreviewMediaTarget(startTarget)) {
                openActivePreviewFullscreen().catch(err => historyLog('media-fullscreen-open-failed', { error: err.message }));
            } else if (dy > 0) {
                closeFilePreview();
            }
        }
    }, true);
    document.getElementById('mediaFullscreenCloseBtn')?.addEventListener('click', () => closeMediaFullscreen());
    document.getElementById('mediaFullscreenLocateBtn')?.addEventListener('click', () => {
        locateMediaFullscreenRecord().catch(err => historyLog('media-fullscreen-locate-failed', { error: err.message }));
    });
    document.getElementById('mediaFullscreenPrevBtn')?.addEventListener('click', () => navigateMediaFullscreen(-1));
    document.getElementById('mediaFullscreenNextBtn')?.addEventListener('click', () => navigateMediaFullscreen(1));
    document.getElementById('mediaFullscreenViewer')?.addEventListener('click', event => {
        if (event.target?.closest?.('img, video, button, .media-fullscreen-arrow, .media-fullscreen-topbar')) return;
        if (event.target?.id === 'mediaFullscreenViewer' || event.target?.id === 'mediaFullscreenContent') {
            closeMediaFullscreen();
        }
    });
    document.getElementById('mediaFullscreenViewer')?.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'touch') return;
        if (event.target.closest?.('button')) return;
        try {
            event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch (_) {}
        mediaFullscreenPointerStart = { x: event.clientX, y: event.clientY, pointerType: event.pointerType };
    }, true);
    document.getElementById('mediaFullscreenViewer')?.addEventListener('pointerup', event => {
        if (!mediaFullscreenPointerStart) return;
        const dx = event.clientX - mediaFullscreenPointerStart.x;
        const dy = event.clientY - mediaFullscreenPointerStart.y;
        const pointerType = mediaFullscreenPointerStart.pointerType;
        mediaFullscreenPointerStart = null;
        if (Math.abs(dx) > 38 && Math.abs(dx) > Math.abs(dy) * 1.12) {
            event.preventDefault();
            navigateMediaFullscreen(dx < 0 ? 1 : -1);
            return;
        }
        if (pointerType === 'touch' && dy > 42 && Math.abs(dy) > Math.abs(dx) * 1.18) {
            event.preventDefault();
            closeMediaFullscreen();
        }
    }, true);
    document.addEventListener('keydown', event => {
        if (!document.getElementById('musicPlayerOverlay')?.classList.contains('active')) return;
        if (event.key !== 'Escape' || !musicPlayer.queueOpen) return;
        event.preventDefault();
        setMusicQueueOpen(false, { replaceHistory: true });
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
    document.getElementById('editRichMessageBtn')?.addEventListener('click', () => {
        if (activeRichMessageId) openRichMessageEditor(activeRichMessageId);
    });
    document.getElementById('richHistoryBtn')?.addEventListener('click', () => {
        if (activeRichMessageId) openRichHistory(activeRichMessageId);
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
        const entries = await getDroppedFileEntries(e.dataTransfer);
        await sendSelectedFiles(entries);
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
    const activeDownloadSnapshot = snapshotFresh ? progressQueueSnapshot.activeDownloads : 0;

    const items = Array.from(list.children);
    const taskItems = items;
    const visibleReceiveItems = taskItems.filter(item => item.dataset.progressDirection === 'receive').length;
    const hiddenStartingDownloads = Math.max(0, activeDownloadSnapshot - visibleReceiveItems);
    const count = taskItems.length + queuedSnapshot + hiddenStartingDownloads;
    if (!count) {
        summary.textContent = '';
        return;
    }

    const moving = taskItems.filter(isProgressItemActivelyMoving).length;
    const stalled = taskItems.filter(item => item.dataset.progressActivity === 'moving' && !isProgressItemActivelyMoving(item)).length;
    const starting = taskItems.filter(item => item.dataset.progressActivity === 'starting').length + hiddenStartingDownloads;
    const queued = queuedSnapshot;
    const parts = [`${count} 个任务`];
    if (moving) parts.push(`进行中 ${moving}`);
    if (stalled) parts.push(`${stalled} 个停滞`);
    if (starting) parts.push(`${starting} 个建链中`);
    if (queued) parts.push(`${queued} 个等待`);
    summary.textContent = parts.join(' · ');
}

function hasActiveTransferTasks() {
    const list = document.getElementById('progressList');
    const visibleItems = list ? Array.from(list.children).filter(item => item.isConnected) : [];
    const snapshotFresh = Date.now() - progressQueueSnapshot.updatedAt <= PROGRESS_QUEUE_SNAPSHOT_TTL;
    return visibleItems.length > 0 ||
        (snapshotFresh && (progressQueueSnapshot.queueLength > 0 || progressQueueSnapshot.activeDownloads > 0));
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
    const row = document.getElementById('sessionRemarkRow');
    const value = document.getElementById('sessionRemark');
    if (row && value) {
        value.textContent = state.sessionRemark || '-';
        row.hidden = !state.sessionRemark;
    }
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
    settleMobileWorkspaceView('chat');
    scrollMessageInsideChat(message);
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

function cleanupProgressForDeletedFile(fileId) {
    if (!fileId) return;
    const baseFileId = String(fileId);
    fileTransferProgressStates.delete(baseFileId);
    activeFileProgress.delete(baseFileId);
    completedFileProgress.add(baseFileId);
    Array.from(progressHideTimers.keys()).forEach(key => {
        if (getProgressBaseFileId(key) !== baseFileId) return;
        const timer = progressHideTimers.get(key);
        if (timer) clearTimeout(timer);
        progressHideTimers.delete(key);
        activeFileProgress.delete(key);
        progressUiLastPaint.delete(key);
        document.getElementById(progressElementId(key))?.remove();
    });
    document.querySelectorAll('#progressList .progress-item').forEach(item => {
        if (item.dataset.fileId === baseFileId || getProgressBaseFileId(item.dataset.progressKey) === baseFileId) {
            item.remove();
        }
    });
    const list = document.getElementById('progressList');
    if (!list || list.children.length === 0) {
        clearProgressQueueSnapshot();
        document.getElementById('transferProgress').style.display = 'none';
    }
    updateProgressDrawerSummary();
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
    activeRichMessageId = '';

    const shouldGoBack = richViewerHistoryOpen && !options.fromHistory &&
        history.state?.[RICH_VIEWER_HISTORY_KEY] === true;
    richViewerHistoryOpen = false;
    if (shouldGoBack) history.back();
}

window.addEventListener('popstate', event => {
    if (musicPlayer.historyOpen || document.getElementById('musicPlayerOverlay')?.classList.contains('active')) {
        if (event.state?.[MUSIC_QUEUE_HISTORY_KEY]) {
            setMusicQueueOpen(true, { fromHistory: true, pushHistory: false });
            return;
        }
        if (musicPlayer.queueOpen) {
            const pendingQueueExitAction = musicPlayer.pendingQueueExitAction;
            musicPlayer.pendingQueueExitAction = '';
            setMusicQueueOpen(false, { fromHistory: true });
            if (pendingQueueExitAction === 'close') {
                closeMusicPlayer({ fromHistory: true });
                replaceCurrentHistoryWithoutMusicPlayer();
            } else if (pendingQueueExitAction === 'minimize') {
                minimizeMusicPlayer({ fromHistory: true });
                replaceCurrentHistoryWithoutMusicPlayer();
            }
            return;
        }
        const stop = musicPlayer.closeAfterHistory === true;
        musicPlayer.closeAfterHistory = false;
        if (stop) closeMusicPlayer({ fromHistory: true });
        else minimizeMusicPlayer({ fromHistory: true });
        return;
    }
    if (mediaFullscreenHistoryOpen || document.getElementById('mediaFullscreenViewer')?.classList.contains('active')) {
        closeMediaFullscreen({ fromHistory: true });
        return;
    }
    if (suppressNextFilePreviewPopstate) {
        suppressNextFilePreviewPopstate = false;
        return;
    }
    if (filePreviewHistoryOpen || document.getElementById('filePreviewViewer')?.classList.contains('active')) {
        closeFilePreview({ fromHistory: true });
        return;
    }
    if (trapHomeBackNavigation(event.state)) return;
    if (!richViewerHistoryOpen) return;
    richViewerHistoryOpen = false;
    closeRichViewer({ fromHistory: true });
});

function normalizeRichHistory(message) {
    const history = Array.isArray(message?.richHistory)
        ? message.richHistory.filter(entry => entry && typeof entry.content === 'string')
        : [];
    if (history.length) return history.sort((a, b) => Number(a.version) - Number(b.version));
    return [{
        version: Number(message?.richVersion) || 1,
        content: getRichMessageContent(message),
        editorDeviceId: message?.sender || '',
        editorDeviceName: message?.senderName || '未知设备',
        editedAt: Number(message?.timestamp) || Date.now()
    }];
}

function readPendingRichEdits() {
    try {
        const value = JSON.parse(localStorage.getItem(PENDING_RICH_EDITS_STORAGE_KEY) || '{}');
        return value && typeof value === 'object' ? value : {};
    } catch {
        return {};
    }
}

function writePendingRichEdit(messageId, draft) {
    const all = readPendingRichEdits();
    const key = `${state.sessionId}:${messageId}`;
    if (draft) all[key] = draft;
    else delete all[key];
    localStorage.setItem(PENDING_RICH_EDITS_STORAGE_KEY, JSON.stringify(all));
}

function htmlToDiffLines(html) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = String(html || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
    return (wrapper.textContent || '').replace(/\r/g, '').split('\n');
}

function buildLineDiff(leftHtml, rightHtml) {
    const left = htmlToDiffLines(leftHtml);
    const right = htmlToDiffLines(rightHtml);
    const rows = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i--) {
        for (let j = right.length - 1; j >= 0; j--) {
            rows[i][j] = left[i] === right[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
        }
    }
    const operations = [];
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
        if (i < left.length && j < right.length && left[i] === right[j]) {
            operations.push({ type: 'same', left: left[i], right: right[j] }); i++; j++;
        } else if (j < right.length && (i >= left.length || rows[i][j + 1] >= rows[i + 1][j])) {
            operations.push({ type: 'added', left: '', right: right[j++] });
        } else {
            operations.push({ type: 'removed', left: left[i++], right: '' });
        }
    }
    return operations;
}

function renderRichDiff(panel, leftVersion, rightVersion) {
    const leftPane = panel.querySelector('[data-rich-diff-left]');
    const rightPane = panel.querySelector('[data-rich-diff-right]');
    leftPane.replaceChildren();
    rightPane.replaceChildren();
    buildLineDiff(leftVersion.content, rightVersion.content).forEach(operation => {
        const addLine = (target, marker, text, className) => {
            const line = document.createElement('div');
            line.className = `rich-diff-line ${className || ''}`.trim();
            line.innerHTML = `<span>${marker}</span><span>${escapeHtml(text || ' ')}</span>`;
            target.appendChild(line);
        };
        addLine(leftPane, operation.type === 'removed' ? '-' : ' ', operation.left, operation.type === 'removed' ? 'removed' : '');
        addLine(rightPane, operation.type === 'added' ? '+' : ' ', operation.right, operation.type === 'added' ? 'added' : '');
    });
}

async function openRichHistory(messageId) {
    const message = await getFromStore('messages', messageId);
    if (!message || message.type !== 'rich') return;
    const versions = normalizeRichHistory(message);
    const layer = document.createElement('div');
    layer.className = 'rich-history-layer';
    layer.innerHTML = `<section class="rich-history-panel" role="dialog" aria-modal="true">
        <header class="rich-history-header"><h3>富文本修改历史</h3><button class="btn btn-secondary" data-rich-history-close>关闭</button></header>
        <div class="rich-history-body">
            <div class="rich-version-list"></div>
            <div class="rich-diff-selectors"><select data-rich-left></select><select data-rich-right></select></div>
            <div class="rich-diff-grid"><div class="rich-diff-pane" data-rich-diff-left></div><div class="rich-diff-pane" data-rich-diff-right></div></div>
        </div>
    </section>`;
    const list = layer.querySelector('.rich-version-list');
    const leftSelect = layer.querySelector('[data-rich-left]');
    const rightSelect = layer.querySelector('[data-rich-right]');
    const displayVersions = [...versions].sort((a, b) => Number(b.version) - Number(a.version));
    displayVersions.forEach(version => {
        const label = `版本 ${version.version} · ${version.editorDeviceName || version.editorDeviceId || '未知设备'} · ${formatDateTime(version.editedAt)}`;
        const optionLeft = new Option(label, String(version.version));
        const optionRight = new Option(label, String(version.version));
        leftSelect.add(optionLeft);
        rightSelect.add(optionRight);
        const button = document.createElement('button');
        button.className = 'rich-version-button';
        button.textContent = label;
        button.addEventListener('click', () => {
            leftSelect.value = String(Math.max(1, Number(version.version) - 1));
            rightSelect.value = String(version.version);
            update();
        });
        list.appendChild(button);
    });
    leftSelect.value = String(versions[Math.max(0, versions.length - 2)].version);
    rightSelect.value = String(versions[versions.length - 1].version);
    const update = () => {
        const left = versions.find(version => String(version.version) === leftSelect.value) || versions[0];
        const right = versions.find(version => String(version.version) === rightSelect.value) || versions[versions.length - 1];
        renderRichDiff(layer, left, right);
    };
    leftSelect.addEventListener('change', update);
    rightSelect.addEventListener('change', update);
    layer.addEventListener('click', event => {
        if (event.target === layer || event.target.closest('[data-rich-history-close]')) layer.remove();
    });
    document.body.appendChild(layer);
    update();
}

async function submitRichMessageEdit(message, content, baseVersion) {
    if (!state.socket?.connected) {
        writePendingRichEdit(message.id, { content, baseVersion, savedAt: Date.now() });
        showAppToast('当前离线，修改已保存在本机；联网后将检查版本冲突');
        return { offline: true };
    }
    return await new Promise((resolve, reject) => {
        state.socket.timeout(10000).emit('rich-message-edit', {
            sessionId: state.sessionId,
            messageId: message.id,
            baseVersion,
            content
        }, (err, response) => {
            if (err) reject(new Error('服务端响应超时'));
            else resolve(response || {});
        });
    });
}

async function publishRichConflictAsNewRecord(original, content) {
    const message = {
        id: generateId(),
        type: 'rich',
        content,
        timestamp: nextHistoryTimestamp(),
        sender: state.deviceId,
        senderName: state.deviceName,
        relatedRichMessageId: original.id,
        richVersion: 1,
        richHistory: [{ version: 1, content, editorDeviceId: state.deviceId, editorDeviceName: state.deviceName, editedAt: Date.now() }]
    };
    await publishHistoryMessage(message);
    showAppToast('本地修改已作为关联的新记录发送');
}

async function openRichMessageEditor(messageId, draft = null) {
    if (!requireTunnelPermission('sendRich')) return;
    const message = await getFromStore('messages', messageId);
    if (!message || message.type !== 'rich') return;
    let baseVersion = Number(draft?.baseVersion || message.richVersion) || 1;
    const layer = document.createElement('div');
    layer.className = 'rich-history-layer';
    layer.innerHTML = `<section class="rich-history-panel" role="dialog" aria-modal="true">
        <header class="rich-history-header"><h3>编辑富文本 · 基于版本 ${baseVersion}</h3><button class="btn btn-secondary" data-rich-edit-close>关闭</button></header>
        <div class="rich-history-body"><div class="rich-conflict-notice" hidden></div>
            <div class="editor-toolbar rich-message-editor-toolbar">
                <button class="toolbar-btn" type="button" data-cmd="bold" title="加粗">B</button>
                <button class="toolbar-btn" type="button" data-cmd="italic" title="斜体">I</button>
                <button class="toolbar-btn" type="button" data-cmd="underline" title="下划线">U</button>
                <button class="toolbar-btn" type="button" data-cmd="insertUnorderedList" title="无序列表">•</button>
                <button class="toolbar-btn" type="button" data-cmd="insertOrderedList" title="有序列表">1.</button>
                <button class="toolbar-btn" type="button" data-rich-insert-link title="插入链接">🔗</button>
                <button class="toolbar-btn" type="button" data-rich-insert-image title="插入图片">🖼️</button>
                <button class="toolbar-btn" type="button" data-rich-insert-file title="引用文件">📎</button>
                <button class="toolbar-btn" type="button" data-rich-insert-quote title="引用块">❝</button>
                <button class="toolbar-btn" type="button" data-rich-insert-table title="插入表格">▦</button>
                <button class="toolbar-btn" type="button" data-rich-insert-hr title="分割线">—</button>
            </div>
            <div class="rich-message-editor" contenteditable="true"></div></div>
        <footer class="rich-history-actions"><button class="btn btn-secondary" data-rich-edit-history>修改历史</button><button class="btn btn-primary" data-rich-edit-save>保存修改</button></footer>
    </section>`;
    const editor = layer.querySelector('.rich-message-editor');
    const notice = layer.querySelector('.rich-conflict-notice');
    editor.innerHTML = draft && typeof draft.content === 'string' ? draft.content : getRichMessageContent(message);
    attachRichEditorEnhancedTools(layer, editor);
    hydrateEditorAssets(editor).catch(err => historyLog('rich-editor-asset-hydrate-failed', { messageId, error: err.message }));
    const close = () => layer.remove();
    layer.addEventListener('click', async event => {
        if (event.target === layer || event.target.closest('[data-rich-edit-close]')) return close();
        if (event.target.closest('[data-rich-edit-history]')) return openRichHistory(messageId);
        if (!event.target.closest('[data-rich-edit-save]')) return;
        const localContent = serializeEditorContent(editor.innerHTML);
        const response = await submitRichMessageEdit(message, localContent, baseVersion).catch(err => ({ error: err.message }));
        if (response.offline) {
            close();
            return;
        }
        if (response.ok) {
            writePendingRichEdit(messageId, null);
            await applyHistoryMessageUpdate(response.message, { remote: true });
            close();
            await viewRichContent(messageId);
            showAppToast(`已保存为版本 ${response.message.richVersion}`);
            return;
        }
        if (response.conflict && response.message) {
            notice.hidden = false;
            notice.innerHTML = `线上已更新到版本 ${response.message.richVersion}，当前修改基于版本 ${baseVersion}。<div class="send-mode-actions"><button class="btn btn-secondary" data-rich-send-related>作为关联新记录发送</button><button class="btn btn-primary" data-rich-merge>手动合并</button></div>`;
            notice.querySelector('[data-rich-send-related]').onclick = async () => { await publishRichConflictAsNewRecord(response.message, localContent); writePendingRichEdit(messageId, null); close(); };
            notice.querySelector('[data-rich-merge]').onclick = () => {
                notice.innerHTML = `<strong>手动合并</strong><p>下方编辑区已保留本地修改；线上版本只读展示在其后，请整理后再次保存。</p><details open><summary>线上版本 ${response.message.richVersion}</summary><div class="rich-message-editor">${response.message.content}</div></details>`;
                baseVersion = Number(response.message.richVersion) || baseVersion;
            };
            return;
        }
        showAppToast(`保存失败：${response.error || '未知错误'}`);
    });
    document.body.appendChild(layer);
    requestAnimationFrame(() => editor.focus());
}

async function reconcilePendingRichEdits() {
    if (!state.socket?.connected) return;
    const pending = readPendingRichEdits();
    const prefix = `${state.sessionId}:`;
    const entry = Object.entries(pending).find(([key]) => key.startsWith(prefix));
    if (!entry) return;
    const messageId = entry[0].slice(prefix.length);
    const message = await getFromStore('messages', messageId).catch(() => null);
    if (!message) return writePendingRichEdit(messageId, null);
    const response = await submitRichMessageEdit(message, entry[1].content, entry[1].baseVersion).catch(() => null);
    if (response?.ok) {
        writePendingRichEdit(messageId, null);
        await applyHistoryMessageUpdate(response.message, { remote: true });
        showAppToast('离线富文本修改已同步');
    } else if (response?.conflict) {
        showAppToast('检测到离线富文本修改冲突，请在编辑浮层中处理');
        openRichMessageEditor(messageId, entry[1]);
    }
}

async function viewRichContent(messageId) {
    const message = await getFromStore('messages', messageId);
    if (message && message.type === 'rich') {
        const container = document.getElementById('richViewerContent');
        container.innerHTML = getRichMessageContent(message);
        await hydrateEditorAssets(container);
        const viewer = document.getElementById('richViewer');
        activeRichMessageId = messageId;
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
    let file = await materializeCachedFileRecord(await getFromStore('files', fileId));
    if (file?.externalFileHandle) {
        file = await materializeExternalFileRecord(file, { requestPermission: true });
    }
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
        const storedSessionForAnchor = await getFromStore('sessions', state.sessionId).catch(() => null);
        const deepLinkedMessage = state.pendingRecordId
            ? messages.find(message => message.id === state.pendingRecordId)
            : null;
        const orderedMessages = deepLinkedMessage
            ? [deepLinkedMessage, ...messages.filter(message => message.id !== deepLinkedMessage.id)]
            : messages;
        chatScrollAnchorMessageId = deepLinkedMessage?.id || storedSessionForAnchor?.scrollAnchorMessageId || '';
        chatMessages?.classList.add('history-loading');
        try {
            // 使用 for...of 确保按顺序异步处理，但不要每条都滚动，避免刷新时列表抖动。
            let renderedCount = 0;
            for (const msg of orderedMessages) {
                try {
                    const isOwn = msg.sender === state.deviceId;
                    await addMessageToChat(msg, isOwn, { scroll: false });
                    renderedCount += 1;
                    if (msg.id === deepLinkedMessage?.id) {
                        settleMobileWorkspaceView('chat');
                        const target = getMessageElement(msg.id);
                        if (target) {
                            scrollMessageInsideChat(target, 'auto');
                            pinChatScrollToDomAnchor(msg.id, 30000);
                            flashResourceTarget(target);
                        }
                    }
                    if (deepLinkedMessage && renderedCount % 8 === 0) await sleep(0);
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
                requestAnimationFrame(() => {
                    const anchor = chatScrollAnchorMessageId ? getMessageElement(chatScrollAnchorMessageId) : null;
                    if (anchor) {
                        anchor.scrollIntoView({ block: 'center', inline: 'nearest' });
                        pinChatScrollToDomAnchor(chatScrollAnchorMessageId, 12000);
                    } else {
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                        pinChatScrollToBottom(3500);
                    }
                    requestAnimationFrame(() => {
                        chatMessages.classList.remove('history-loading');
                        scheduleChatScrollAnchorSave();
                        settleCurrentMobileWorkspaceView();
                    });
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

function renderRemarkHtml(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    return escapeHtml(raw).replace(/https?:\/\/[^\s<>"']+/g, url => {
        const safeUrl = url.replace(/[\r\n]/g, '');
        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });
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
