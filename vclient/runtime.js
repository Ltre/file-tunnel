'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { CacheStore, normalizeAsset } = require('./cache-store');

const RELAY_CHUNK_SIZE = 240 * 1024;
const MAX_RELAY_CHUNK_SIZE = 256 * 1024;
const MAX_ASSET_SIZE = 1024 * 1024 * 1024;
const EDITOR_RELAY_CHUNK_SIZE = 64 * 1024;
const MAX_EDITOR_ASSET_SIZE = 20 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 20000;
const DEFAULT_REQUEST_TIMEOUT_MS = 45000;
const DEFAULT_ACK_TIMEOUT_MS = 30000;
const DEFAULT_RECEIVE_IDLE_TIMEOUT_MS = 60000;
const DEFAULT_RECORD_PAGE_SIZE = 200;
const MAX_RECORD_PAGES = 10000;
const VALID_SESSION_ID = /^[a-zA-Z0-9_-]{8,64}$/;
const VALID_ASSET_ID = /^[a-zA-Z0-9_-]{12,64}$/;

function defaultIoFactory(url, options) {
    // Loaded lazily so the storage and protocol modules remain independently testable.
    return require('socket.io-client').io(url, options);
}

function normalizeServerUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function controlUrl(serverUrl, namespace) {
    return `${normalizeServerUrl(serverUrl)}${namespace.startsWith('/') ? namespace : `/${namespace}`}`;
}

function binaryBuffer(value) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return null;
}

function extractRichAssetReferences(content) {
    const html = String(content || '');
    const references = new Map();
    const add = (id, kind) => {
        const value = String(id || '');
        if (!VALID_ASSET_ID.test(value)) return;
        if (!references.has(value) || kind === 'editor') references.set(value, { id: value, kind });
    };
    for (const match of html.matchAll(/data-tunnel-file-ref-id=["']([^"']+)["']/gi)) add(match[1], 'file');
    for (const match of html.matchAll(/data-tunnel-asset-id=["']([^"']+)["']/gi)) add(match[1], 'editor');
    for (const match of html.matchAll(/downloadFile\(\s*["']([^"']+)["']\s*\)/gi)) add(match[1], 'file');
    return Array.from(references.values());
}

function assetReferencesFromMessage(message) {
    if (!message || typeof message !== 'object') return [];
    const references = new Map();
    const add = (asset, fallbackId = '', kind = 'file') => {
        const normalized = normalizeAsset(asset ? { ...asset, assetKind: asset.assetKind || asset.asset_kind || kind } : null);
        const id = normalized?.id || String(fallbackId || asset?.id || '');
        if (!VALID_ASSET_ID.test(id)) return;
        const previous = references.get(id);
        references.set(id, {
            id,
            kind: normalized?.assetKind || kind || previous?.kind || 'file',
            asset: normalized || previous?.asset || null
        });
    };
    if (message.type === 'file') add(message.fileInfo, '', 'file');
    if (message.type === 'collection' && Array.isArray(message.collection?.files)) {
        message.collection.files.forEach(file => add(file, '', 'file'));
    }
    if (message.type === 'rich') {
        extractRichAssetReferences(message.content).forEach(reference => add(null, reference.id, reference.kind));
    }
    return Array.from(references.values());
}

function parseJsonObject(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
        return null;
    }
}

function assetReferencesFromRecord(record) {
    if (!record || typeof record !== 'object') return [];
    const message = record.message || record.payload?.message || record.payload ||
        parseJsonObject(record.message_json) || parseJsonObject(record.payload_json);
    const references = assetReferencesFromMessage(message);
    const known = new Set(references.map(item => item.id));
    const append = (asset, fallbackId = '', kind = 'file') => {
        const metadata = asset?.metadata && typeof asset.metadata === 'object' ? asset.metadata : {};
        const resolvedKind = String(asset?.asset_kind || metadata.assetKind || metadata.asset_kind || kind).toLowerCase() === 'editor'
            ? 'editor'
            : 'file';
        const normalized = normalizeAsset(asset ? { ...metadata, ...asset, assetKind: resolvedKind } : null);
        const id = normalized?.id || String(fallbackId || asset?.id || '');
        if (!VALID_ASSET_ID.test(id)) return;
        if (known.has(id)) {
            const existing = references.find(reference => reference.id === id);
            if (existing) {
                if (resolvedKind === 'editor') existing.kind = 'editor';
                if (normalized) existing.asset = normalized;
            }
            return;
        }
        known.add(id);
        references.push({ id, kind: resolvedKind, asset: normalized });
    };
    const files = Array.isArray(record.files) ? record.files : [];
    files.forEach(file => append(file, file?.file_id, file?.asset_kind));
    const ids = [
        ...(Array.isArray(record.assetIds) ? record.assetIds : []),
        ...(Array.isArray(record.asset_ids) ? record.asset_ids : []),
        ...(Array.isArray(record.file_ids) ? record.file_ids : []),
        ...(Array.isArray(record.rich_asset_ids) ? record.rich_asset_ids : []),
        ...(Array.isArray(record.rich_refs) ? record.rich_refs : [])
    ];
    ids.forEach(id => append(null, id, 'file'));
    return references;
}

async function emitWithAck(socket, eventName, payload, timeoutMs = DEFAULT_ACK_TIMEOUT_MS) {
    if (!socket?.connected) throw new Error('Socket is not connected');
    let response;
    if (typeof socket.timeout === 'function' && typeof socket.emitWithAck === 'function') {
        response = await socket.timeout(timeoutMs).emitWithAck(eventName, payload);
    } else if (typeof socket.emitWithAck === 'function') {
        response = await Promise.race([
            socket.emitWithAck(eventName, payload),
            new Promise((_, reject) => {
                const timer = setTimeout(() => reject(new Error(`${eventName} acknowledgement timed out`)), timeoutMs);
                timer.unref?.();
            })
        ]);
    } else {
        response = await new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error(`${eventName} acknowledgement timed out`));
            }, timeoutMs);
            timer.unref?.();
            socket.emit(eventName, payload, result => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(result || { ok: true });
            });
        });
    }
    if (response?.ok === false) throw new Error(response.reason || response.error || `${eventName} rejected`);
    return response || { ok: true };
}

function requestAttemptId(requestId, transferId = '') {
    const prefix = String(requestId || 'vclient').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 70);
    const part = String(transferId || 'full').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24);
    return `${prefix}-${part}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`.slice(0, 120);
}

class TunnelClient {
    constructor(runtime, sessionId) {
        this.runtime = runtime;
        this.sessionId = sessionId;
        this.store = runtime.store;
        this.deviceId = this.store.stableDeviceId(sessionId);
        this.socket = null;
        this.state = 'disabled';
        this.lastError = '';
        this.connectedOnce = false;
        this.stopping = false;
        this.heartbeatTimer = null;
        this.wanted = new Map();
        this.activeDownloads = new Set();
        this.receives = new Map();
        this.ignoredEditorRelays = new Map();
        this.uploads = new Map();
        this.initialScanComplete = false;
        this.lastSyncAt = 0;
        this.auditSyncPromise = null;
        this.auditRetryTimer = null;
        this.cleanupPromise = Promise.resolve();
    }

    log(event, details = {}) {
        this.runtime.log(event, { sessionId: this.sessionId, deviceId: this.deviceId, ...details });
    }

    reportState(state, details = {}) {
        const changed = this.state !== state || details.error !== undefined;
        this.state = state;
        if (details.error !== undefined) this.lastError = String(details.error || '');
        if (changed || details.force) this.runtime.reportStatus(this, details);
    }

    reportAsset(assetId, state, details = {}) {
        this.runtime.reportAssetStatus(this, assetId, state, details);
    }

    async start() {
        if (this.socket) return;
        this.stopping = false;
        this.reportState('starting', { force: true });
        this.socket = this.runtime.ioFactory(this.runtime.serverUrl, {
            autoConnect: false,
            reconnection: true,
            auth: {
                clientType: 'vclient',
                instanceId: this.store.instanceId,
                vclientToken: this.runtime.token,
                language: 'zh-Hans'
            }
        });
        this.bindSocket();
        this.socket.connect();
    }

    bindSocket() {
        const socket = this.socket;
        socket.on('connect', () => this.onConnect().catch(err => this.fail(err)));
        socket.on('connect_error', err => {
            this.lastError = err?.message || 'connect-error';
            this.reportState(this.connectedOnce ? 'reconnecting' : 'error', { error: this.lastError });
        });
        socket.on('disconnect', reason => {
            this.cleanupPromise = this.onDisconnect(reason)
                .catch(err => this.log('disconnect-cleanup-failed', { error: err.message }));
        });
        socket.on('session-history', data => this.onHistory(data).catch(err => this.fail(err)));
        socket.on('message', data => this.scanMessages([data?.message]).catch(err => this.fail(err)));
        socket.on('message-updated', data => this.scanMessages([data?.message]).catch(err => this.fail(err)));
        socket.on('file-asset-available', data => this.onAssetAvailable(data).catch(err => this.fail(err)));
        socket.on('file-asset-manifest', data => this.onManifest(data).catch(err => this.fail(err)));
        socket.on('file-asset-unavailable', data => this.onUnavailable(data).catch(err => this.fail(err)));
        socket.on('file-asset-discovery', data => this.onDiscovery(data).catch(err => this.fail(err)));
        socket.on('file-asset-request', data => this.onProviderRequest(data));
        socket.on('file-asset-relay-start', (data, ack) => {
            this.onRelayStart(data).then(result => ack?.(result)).catch(err => ack?.({ ok: false, reason: `receiver-${err.message}` }));
        });
        socket.on('file-asset-relay-chunk', (data, ack) => {
            this.onRelayChunk(data).then(result => ack?.(result)).catch(async err => {
                await this.abortReceive(this.receives.get(String(data?.assetId || '')), err.message).catch(() => {});
                ack?.({ ok: false, reason: `receiver-${err.message}` });
            });
        });
        socket.on('file-asset-relay-complete', (data, ack) => {
            this.onRelayComplete(data).then(result => ack?.(result)).catch(async err => {
                await this.abortReceive(this.receives.get(String(data?.assetId || '')), err.message).catch(() => {});
                ack?.({ ok: false, reason: `receiver-${err.message}` });
            });
        });
        socket.on('editor-asset-available', data => this.onEditorAssetAvailable(data).catch(err => this.fail(err)));
        socket.on('editor-asset-provider', data => this.onEditorAssetProvider(data));
        socket.on('editor-asset-unavailable', data => this.onEditorAssetUnavailable(data).catch(err => this.fail(err)));
        socket.on('editor-asset-request', data => this.onEditorProviderRequest(data));
        socket.on('editor-asset-relay-start', data => {
            this.onEditorRelayStart(data).catch(err => this.rejectEditorRelay(data, err));
        });
        socket.on('editor-asset-relay-chunk', data => {
            this.onEditorRelayChunk(data).catch(err => this.rejectEditorRelay(data, err));
        });
        socket.on('editor-asset-relay-complete', data => {
            this.onEditorRelayComplete(data).catch(err => this.rejectEditorRelay(data, err));
        });
        socket.on('device-camera-request', data => this.rejectCameraRequest(data));
        socket.on('contact-call-request', data => this.rejectContactCall(data));
        socket.on('device-tunnel-invite', data => this.rejectTunnelInvite(data));
        socket.on('file-offer', data => this.rejectLegacyFileOffer(data));
        socket.on('light-network-chunks-request', data => this.rejectLightRequest(data));
        socket.on('device-left', data => this.onDeviceLeft(data).catch(err => this.fail(err)));
        socket.on('error', data => this.log('server-error', { error: data?.message || data?.code || String(data || '') }));
    }

    async onConnect() {
        await this.cleanupPromise;
        if (this.stopping) return;
        this.connectedOnce = true;
        this.lastError = '';
        this.reportState('syncing', { force: true });
        this.socket.emit('join-session', {
            sessionId: this.sessionId,
            deviceId: this.deviceId,
            deviceName: '服务器缓存节点',
            deviceModel: `VClient ${this.store.instanceId.slice(0, 8)}`,
            clientType: 'vclient'
        });
        this.startHeartbeat();
        for (const cached of await this.store.listSessionAssets(this.sessionId)) {
            this.announce(cached);
            this.reportAsset(cached.asset.id, 'cached', {
                name: cached.asset.name,
                size: cached.size,
                received: cached.size,
                sha256: cached.sha256,
                progress: 100
            });
        }
        this.socket.emit('session-history-request', { sessionId: this.sessionId, reason: 'vclient-startup' });
        await this.syncAuditRecords();
    }

    async onDisconnect(reason) {
        this.stopHeartbeat();
        for (const receive of this.receives.values()) {
            this.reportAsset(receive.asset.id, 'interrupted', {
                name: receive.asset.name,
                size: receive.asset.size,
                received: receive.received,
                reason: reason || 'disconnected'
            });
        }
        await this.abortAllReceives('disconnected', { retry: false });
        this.ignoredEditorRelays.clear();
        this.activeDownloads.clear();
        for (const entry of this.wanted.values()) {
            this.clearEntryTimers(entry);
            entry.active = false;
        }
        if (!this.stopping) this.reportState('reconnecting', { error: reason || 'disconnected' });
    }

    startHeartbeat() {
        this.stopHeartbeat();
        const send = () => {
            if (!this.socket?.connected) return;
            this.socket.emit('tunnel-heartbeat', {
                sessionId: this.sessionId,
                deviceId: this.deviceId,
                deviceName: '服务器缓存节点',
                deviceModel: `VClient ${this.store.instanceId.slice(0, 8)}`,
                clientType: 'vclient'
            });
        };
        send();
        this.heartbeatTimer = setInterval(send, this.runtime.heartbeatMs);
        this.heartbeatTimer.unref?.();
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    async onHistory(data) {
        const messages = Array.isArray(data?.messages) ? data.messages : [];
        await this.scanMessages(messages);
        this.lastSyncAt = Date.now();
        this.socket?.emit('session-history-ack', {
            sessionId: this.sessionId,
            deviceId: this.deviceId,
            receivedCount: messages.length,
            restoredCount: 0,
            duplicateCount: 0,
            failedCount: 0
        });
        this.updateLifecycle();
    }

    async scanMessages(messages) {
        for (const message of Array.isArray(messages) ? messages : []) {
            if (this.stopping) break;
            for (const reference of assetReferencesFromMessage(message)) await this.ensureAsset(reference);
        }
    }

    async scanRecords(records) {
        for (const record of Array.isArray(records) ? records : []) {
            if (this.stopping) break;
            for (const reference of assetReferencesFromRecord(record)) await this.ensureAsset(reference);
        }
    }

    async syncAuditRecords() {
        if (this.auditSyncPromise || this.stopping) return this.auditSyncPromise;
        if (!this.runtime.control?.connected) {
            this.scheduleAuditRetry('control-offline');
            return null;
        }
        this.auditSyncPromise = (async () => {
            await this.runtime.fetchRecords(this);
            if (this.stopping) return;
            this.initialScanComplete = true;
            this.lastSyncAt = Date.now();
            this.lastError = '';
            this.updateLifecycle();
            this.runtime.reportStatus(this, { force: true });
        })().catch(err => {
            this.lastError = err?.message || String(err);
            this.log('audit-sync-failed', { error: this.lastError });
            if (!this.initialScanComplete) this.reportState('error', { error: this.lastError });
            this.scheduleAuditRetry(this.lastError);
        }).finally(() => {
            this.auditSyncPromise = null;
        });
        return this.auditSyncPromise;
    }

    scheduleAuditRetry(reason) {
        if (this.auditRetryTimer || this.stopping) return;
        this.log('audit-sync-retry-scheduled', { reason });
        this.auditRetryTimer = setTimeout(() => {
            this.auditRetryTimer = null;
            this.syncAuditRecords();
        }, 5000);
        this.auditRetryTimer.unref?.();
    }

    async ensureAsset(reference, preferredProviderId = '') {
        if (this.stopping) return;
        const id = String(reference?.id || reference?.asset?.id || '');
        if (!VALID_ASSET_ID.test(id)) return;
        const kind = reference?.kind === 'editor' || reference?.asset?.assetKind === 'editor' ? 'editor' : 'file';
        const asset = normalizeAsset(reference?.asset ? { ...reference.asset, assetKind: kind } : null);
        const cached = await this.store.getCached(this.sessionId, id, asset).catch(() => null);
        if (cached) {
            this.announce(cached);
            this.reportAsset(id, 'cached', { size: cached.size, sha256: cached.sha256, progress: 100 });
            return;
        }
        let entry = this.wanted.get(id);
        if (!entry) {
            entry = {
                id,
                kind,
                asset: null,
                preferredProviderId: '',
                retryCount: 0,
                active: false,
                retryTimer: null,
                watchdog: null,
                requestId: ''
            };
            this.wanted.set(id, entry);
        }
        if (kind === 'editor') entry.kind = 'editor';
        if (asset) entry.asset = asset;
        if (preferredProviderId) entry.preferredProviderId = preferredProviderId;
        this.reportAsset(id, 'waiting', { name: entry.asset?.name || '', size: entry.asset?.size || 0, progress: 0 });
        this.dispatchDownloads();
        this.updateLifecycle();
    }

    dispatchDownloads() {
        if (!this.socket?.connected) return;
        const capacity = Math.max(0, this.runtime.maxConcurrentDownloads - this.activeDownloads.size);
        if (!capacity) return;
        const candidates = Array.from(this.wanted.values()).filter(entry => !entry.active && !entry.retryTimer).slice(0, capacity);
        candidates.forEach(entry => this.requestAsset(entry));
    }

    requestAsset(entry) {
        if (!this.socket?.connected || entry.active) return;
        entry.active = true;
        entry.requestId = `vc-${crypto.randomBytes(10).toString('hex')}`;
        this.activeDownloads.add(entry.id);
        const manifestOnly = entry.kind !== 'editor' && !entry.asset;
        if (entry.kind === 'editor') {
            this.socket.emit('editor-asset-request', {
                sessionId: this.sessionId,
                assetId: entry.id,
                preferredProviderId: entry.preferredProviderId || undefined
            });
        } else {
            this.socket.emit('file-asset-request', {
                sessionId: this.sessionId,
                assetId: entry.id,
                mode: manifestOnly ? 'manifest' : undefined,
                preferredProviderId: entry.preferredProviderId || undefined,
                relayOnly: true,
                force: entry.retryCount > 0,
                requestId: entry.requestId
            });
        }
        this.reportAsset(entry.id, 'waiting', {
            phase: manifestOnly ? 'discovering' : 'requesting',
            name: entry.asset?.name || '', size: entry.asset?.size || 0, retryCount: entry.retryCount, progress: 0
        });
        entry.watchdog = setTimeout(() => this.retryEntry(entry, 'request-timeout'), this.runtime.requestTimeoutMs);
        entry.watchdog.unref?.();
    }

    async onManifest(data) {
        const asset = normalizeAsset(data?.asset);
        if (!asset || !this.wanted.has(asset.id)) return;
        const entry = this.wanted.get(asset.id);
        entry.asset = asset;
        entry.preferredProviderId = Array.isArray(data?.providers) ? String(data.providers[0] || '') : entry.preferredProviderId;
        this.releaseActive(entry);
        if (!data?.providers?.length) return this.retryEntry(entry, 'no-online-provider');
        this.dispatchDownloads();
    }

    async onAssetAvailable(data) {
        const asset = normalizeAsset(data?.asset);
        if (!asset || !this.wanted.has(asset.id)) return;
        const entry = this.wanted.get(asset.id);
        entry.asset = asset;
        entry.preferredProviderId = String(data?.from || entry.preferredProviderId || '');
        if (entry.retryTimer) {
            clearTimeout(entry.retryTimer);
            entry.retryTimer = null;
        }
        if (!entry.active) this.dispatchDownloads();
    }

    async onEditorAssetAvailable(data) {
        const raw = data?.asset;
        const asset = normalizeAsset(raw ? { ...raw, assetKind: 'editor' } : null);
        if (!asset || !this.wanted.has(asset.id)) return;
        const entry = this.wanted.get(asset.id);
        entry.kind = 'editor';
        entry.asset = asset;
        entry.preferredProviderId = String(data?.from || entry.preferredProviderId || '');
        if (entry.retryTimer) {
            clearTimeout(entry.retryTimer);
            entry.retryTimer = null;
        }
        if (!entry.active) this.dispatchDownloads();
    }

    onEditorAssetProvider(data) {
        const entry = this.wanted.get(String(data?.assetId || ''));
        if (!entry) return;
        entry.preferredProviderId = String(data?.providerDeviceId || entry.preferredProviderId || '');
        this.reportAsset(entry.id, 'waiting', {
            phase: 'waiting-provider-relay',
            name: entry.asset?.name || '',
            size: entry.asset?.size || 0,
            progress: 0
        });
    }

    async onEditorAssetUnavailable(data) {
        const entry = this.wanted.get(String(data?.assetId || ''));
        if (!entry) return;
        const receive = this.receives.get(entry.id);
        if (receive) await this.abortReceive(receive, data?.reason || 'no-online-provider', { retry: false });
        this.retryEntry(entry, data?.reason || 'no-online-provider');
    }

    async onUnavailable(data) {
        const entry = this.wanted.get(String(data?.assetId || ''));
        if (!entry) return;
        const receive = this.receives.get(entry.id);
        if (receive) await this.abortReceive(receive, data?.reason || 'unavailable', { retry: false });
        this.retryEntry(entry, data?.reason || 'unavailable');
    }

    async onDeviceLeft(data) {
        const deviceId = String(data?.deviceId || '');
        if (!deviceId) return;
        const interrupted = Array.from(this.receives.values()).filter(receive => receive.from === deviceId);
        for (const receive of interrupted) {
            this.reportAsset(receive.asset.id, 'interrupted', {
                name: receive.asset.name,
                size: receive.asset.size,
                received: receive.received,
                reason: 'provider-disconnected'
            });
            await this.abortReceive(receive, 'provider-disconnected');
        }
    }

    async onDiscovery(data) {
        const assetId = String(data?.assetId || '');
        if (!VALID_ASSET_ID.test(assetId)) return;
        const cached = await this.store.getCached(this.sessionId, assetId);
        if (cached) this.announce(cached);
    }

    retryEntry(entry, reason) {
        if (!entry || !this.wanted.has(entry.id) || this.stopping) return;
        this.releaseActive(entry);
        if (entry.retryTimer) clearTimeout(entry.retryTimer);
        entry.retryCount++;
        const delay = Math.min(60000, 3000 * (2 ** Math.min(entry.retryCount - 1, 4)));
        const unavailable = ['no-online-provider', 'no-known-provider', 'provider-socket-unavailable'].includes(String(reason));
        this.reportAsset(entry.id, unavailable ? 'unavailable' : 'interrupted', {
            name: entry.asset?.name || '', size: entry.asset?.size || 0, reason, retryCount: entry.retryCount, retryAfterMs: delay
        });
        entry.retryTimer = setTimeout(() => {
            entry.retryTimer = null;
            this.reportAsset(entry.id, 'retrying', {
                name: entry.asset?.name || '', size: entry.asset?.size || 0,
                reason, retryCount: entry.retryCount
            });
            this.dispatchDownloads();
        }, delay);
        entry.retryTimer.unref?.();
        this.updateLifecycle();
    }

    releaseActive(entry) {
        if (!entry) return;
        entry.active = false;
        if (entry.watchdog) clearTimeout(entry.watchdog);
        entry.watchdog = null;
        this.activeDownloads.delete(entry.id);
    }

    clearEntryTimers(entry) {
        if (entry?.retryTimer) clearTimeout(entry.retryTimer);
        if (entry?.watchdog) clearTimeout(entry.watchdog);
        if (entry) {
            entry.retryTimer = null;
            entry.watchdog = null;
        }
    }

    updateLifecycle() {
        if (!this.socket?.connected || this.stopping || !this.initialScanComplete) return;
        this.reportState(this.wanted.size || this.receives.size ? 'syncing' : 'active');
    }

    announce(cached) {
        if (!this.socket?.connected || !cached?.asset) return;
        if (cached.asset.assetKind === 'editor') {
            this.socket.emit('editor-asset-available', { sessionId: this.sessionId, asset: cached.asset });
            return;
        }
        this.socket.emit('file-asset-available', { sessionId: this.sessionId, asset: cached.asset });
        this.socket.emit('server-asset-cache-confirmed', {
            sessionId: this.sessionId,
            assetId: cached.asset.id,
            size: cached.size,
            sha256: cached.sha256
        });
    }

    armReceiveIdleWatchdog(receive) {
        if (!receive) return;
        if (receive.idleTimer) clearTimeout(receive.idleTimer);
        receive.idleTimer = setTimeout(() => {
            if (this.receives.get(receive.asset.id) !== receive) return;
            this.reportAsset(receive.asset.id, 'interrupted', {
                name: receive.asset.name,
                size: receive.asset.size,
                received: receive.received,
                reason: 'transfer-idle-timeout'
            });
            this.abortReceive(receive, 'transfer-idle-timeout')
                .catch(err => this.log('idle-receive-cleanup-failed', { assetId: receive.asset.id, error: err.message }));
        }, this.runtime.receiveIdleTimeoutMs);
        receive.idleTimer.unref?.();
    }

    async onRelayStart(data) {
        const asset = normalizeAsset(data?.asset);
        if (!asset || !this.wanted.has(asset.id)) return { ok: false, reason: 'receiver-not-requested' };
        if (data?.transfer?.transferId) return { ok: false, reason: 'receiver-range-not-supported' };
        const cached = await this.store.getCached(this.sessionId, asset.id, asset);
        if (cached) {
            const entry = this.wanted.get(asset.id);
            if (entry) {
                this.clearEntryTimers(entry);
                this.releaseActive(entry);
            }
            this.wanted.delete(asset.id);
            this.announce(cached);
            this.updateLifecycle();
            return { ok: false, reason: 'receiver-already-cached' };
        }
        if (asset.size > MAX_ASSET_SIZE) return { ok: false, reason: 'receiver-asset-too-large' };
        const existing = this.receives.get(asset.id);
        if (existing) return { ok: false, reason: 'receiver-transfer-active' };
        const temporaryPath = await this.store.createPartialPath(this.sessionId, asset.id);
        const handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
        const receive = {
            asset,
            from: String(data?.from || ''),
            attemptId: String(data?.attemptId || ''),
            requestId: String(data?.requestId || ''),
            temporaryPath,
            handle,
            hash: crypto.createHash('sha256'),
            received: 0,
            reportedPercent: -1,
            writeChain: Promise.resolve(),
            closed: false,
            idleTimer: null
        };
        this.receives.set(asset.id, receive);
        this.armReceiveIdleWatchdog(receive);
        const entry = this.wanted.get(asset.id);
        if (entry) {
            entry.asset = asset;
            if (entry.watchdog) clearTimeout(entry.watchdog);
            entry.watchdog = null;
        }
        this.reportAsset(asset.id, 'transferring', { name: asset.name, size: asset.size, received: 0, progress: 0 });
        return { ok: true };
    }

    async onEditorRelayStart(data) {
        const raw = data?.asset;
        const asset = normalizeAsset(raw ? { ...raw, assetKind: 'editor' } : null);
        if (!asset || asset.size > MAX_EDITOR_ASSET_SIZE) throw new Error('invalid-editor-asset');
        const result = await this.onRelayStart({ ...data, asset });
        if (result?.reason === 'receiver-already-cached') {
            this.ignoredEditorRelays.set(asset.id, String(data?.from || ''));
        }
        return result;
    }

    async onEditorRelayChunk(data) {
        const assetId = String(data?.assetId || '');
        if (this.ignoredEditorRelays.get(assetId) === String(data?.from || '')) return { ok: true, skipped: true };
        const chunk = binaryBuffer(data?.chunk);
        if (!chunk || chunk.length > EDITOR_RELAY_CHUNK_SIZE) throw new Error('invalid-editor-relay-chunk');
        return this.onRelayChunk(data);
    }

    async onEditorRelayComplete(data) {
        const assetId = String(data?.assetId || '');
        if (this.ignoredEditorRelays.get(assetId) === String(data?.from || '')) {
            this.ignoredEditorRelays.delete(assetId);
            return { ok: true, skipped: true };
        }
        return this.onRelayComplete(data);
    }

    async rejectEditorRelay(data, error) {
        const assetId = String(data?.assetId || data?.asset?.id || '');
        await this.abortReceive(this.receives.get(assetId), error?.message || 'editor-relay-failed').catch(() => {});
        const to = String(data?.from || '');
        if (assetId && to && this.socket?.connected) {
            this.socket.emit('editor-asset-unavailable', {
                sessionId: this.sessionId,
                assetId,
                to,
                reason: 'asset-transfer-failed'
            });
        }
        this.log('editor-relay-rejected', { assetId, error: error?.message || String(error) });
    }

    async onRelayChunk(data) {
        const assetId = String(data?.assetId || '');
        const receive = this.receives.get(assetId);
        const chunk = binaryBuffer(data?.chunk);
        if (!receive || !chunk || chunk.length <= 0 || chunk.length > MAX_RELAY_CHUNK_SIZE) {
            throw new Error('invalid-relay-chunk');
        }
        if (String(data?.from || '') !== receive.from ||
            (receive.attemptId && String(data?.attemptId || '') !== receive.attemptId)) {
            throw new Error('relay-source-mismatch');
        }
        const writeTask = receive.writeChain.then(async () => {
            if (this.receives.get(assetId) !== receive || receive.closed) throw new Error('relay-not-active');
            if (receive.received + chunk.length > receive.asset.size) throw new Error('size-overflow');
            let offset = 0;
            while (offset < chunk.length) {
                const result = await receive.handle.write(chunk, offset, chunk.length - offset, receive.received + offset);
                if (!result.bytesWritten) throw new Error('disk-write-failed');
                offset += result.bytesWritten;
            }
            receive.hash.update(chunk);
            receive.received += chunk.length;
            this.armReceiveIdleWatchdog(receive);
            const percent = Math.min(99, Math.floor(receive.received * 100 / receive.asset.size));
            if (percent !== receive.reportedPercent) {
                receive.reportedPercent = percent;
                this.reportAsset(assetId, 'transferring', {
                    name: receive.asset.name, size: receive.asset.size, received: receive.received, progress: percent
                });
            }
            return { ok: true, receivedSize: receive.received, expectedSize: receive.asset.size };
        });
        receive.writeChain = writeTask;
        return writeTask;
    }

    async onRelayComplete(data) {
        const assetId = String(data?.assetId || '');
        const receive = this.receives.get(assetId);
        if (!receive || String(data?.from || '') !== receive.from ||
            (receive.attemptId && String(data?.attemptId || '') !== receive.attemptId)) {
            throw new Error('relay-complete-mismatch');
        }
        await receive.writeChain;
        if (receive.idleTimer) clearTimeout(receive.idleTimer);
        receive.idleTimer = null;
        if (receive.received !== receive.asset.size) {
            await this.abortReceive(receive, 'size-mismatch');
            throw new Error('size-mismatch');
        }
        await receive.handle.sync();
        await receive.handle.close();
        receive.closed = true;
        const sha256 = receive.hash.digest('hex');
        const cached = await this.store.commitTemp(this.sessionId, receive.asset, receive.temporaryPath, {
            sha256,
            size: receive.received
        });
        this.receives.delete(assetId);
        const entry = this.wanted.get(assetId);
        if (entry) {
            this.clearEntryTimers(entry);
            this.releaseActive(entry);
        }
        this.wanted.delete(assetId);
        this.announce(cached);
        this.reportAsset(assetId, 'cached', {
            name: cached.asset.name, size: cached.size, received: cached.size, sha256, progress: 100
        });
        this.runtime.reportStatus(this, { force: true });
        this.dispatchDownloads();
        this.updateLifecycle();
        return { ok: true, sha256 };
    }

    async abortReceive(receive, reason, { retry = true } = {}) {
        if (!receive) return;
        this.receives.delete(receive.asset.id);
        if (receive.idleTimer) clearTimeout(receive.idleTimer);
        receive.idleTimer = null;
        receive.closed = true;
        await receive.writeChain.catch(() => {});
        await receive.handle.close().catch(() => {});
        await fs.promises.unlink(receive.temporaryPath).catch(() => {});
        const entry = this.wanted.get(receive.asset.id);
        if (entry && !this.stopping && retry) this.retryEntry(entry, reason);
    }

    async abortAllReceives(reason, options = {}) {
        await Promise.all(Array.from(this.receives.values()).map(receive => this.abortReceive(receive, reason, options)));
    }

    onProviderRequest(data) {
        if (this.stopping) return;
        const assetId = String(data?.asset?.id || '');
        const from = String(data?.from || '');
        if (!VALID_ASSET_ID.test(assetId) || !from) return;
        const key = `${assetId}:${from}:${data?.transfer?.transferId || 'full'}:${data?.requestId || ''}`;
        if (this.uploads.has(key)) return;
        const task = this.sendCachedAsset(data)
            .catch(err => this.log('provider-relay-failed', { assetId, to: from, error: err.message }))
            .finally(() => this.uploads.delete(key));
        this.uploads.set(key, task);
    }

    onEditorProviderRequest(data) {
        if (this.stopping) return;
        const assetId = String(data?.asset?.id || '');
        const from = String(data?.from || '');
        if (!VALID_ASSET_ID.test(assetId) || !from) return;
        const key = `editor:${assetId}:${from}`;
        if (this.uploads.has(key)) return;
        const task = this.sendCachedEditorAsset(data)
            .catch(err => this.log('editor-provider-relay-failed', { assetId, to: from, error: err.message }))
            .finally(() => this.uploads.delete(key));
        this.uploads.set(key, task);
    }

    async sendCachedEditorAsset(data) {
        if (this.stopping) throw new Error('vclient-stopping');
        const raw = data?.asset;
        const asset = normalizeAsset(raw ? { ...raw, assetKind: 'editor' } : null);
        const to = String(data?.from || '');
        const cached = asset && await this.store.getCached(this.sessionId, asset.id, asset);
        if (!cached || cached.asset.assetKind !== 'editor') {
            if (asset?.id && to && this.socket?.connected) {
                this.socket.emit('editor-asset-unavailable', {
                    sessionId: this.sessionId,
                    assetId: asset.id,
                    to,
                    reason: 'provider-missing-local-data'
                });
            }
            return false;
        }
        this.socket.emit('editor-asset-relay-start', {
            sessionId: this.sessionId,
            to,
            asset: cached.asset
        });
        const handle = await fs.promises.open(cached.path, 'r');
        try {
            let position = 0;
            while (position < cached.size) {
                if (this.stopping || !this.socket?.connected) throw new Error('editor-upload-interrupted');
                const length = Math.min(EDITOR_RELAY_CHUNK_SIZE, cached.size - position);
                const chunk = Buffer.allocUnsafe(length);
                const result = await handle.read(chunk, 0, length, position);
                if (!result.bytesRead) throw new Error('cached-editor-asset-read-failed');
                this.socket.emit('editor-asset-relay-chunk', {
                    sessionId: this.sessionId,
                    to,
                    assetId: asset.id,
                    chunk: result.bytesRead === chunk.length ? chunk : chunk.subarray(0, result.bytesRead)
                });
                position += result.bytesRead;
                await new Promise(resolve => setImmediate(resolve));
            }
        } finally {
            await handle.close();
        }
        this.socket.emit('editor-asset-relay-complete', {
            sessionId: this.sessionId,
            to,
            assetId: asset.id
        });
        return true;
    }

    async sendCachedAsset(data) {
        if (this.stopping) throw new Error('vclient-stopping');
        const asset = normalizeAsset(data?.asset);
        const to = String(data?.from || '');
        const transfer = data?.transfer || null;
        const requestId = String(data?.requestId || '');
        const cached = asset && await this.store.getCached(this.sessionId, asset.id, asset);
        if (!cached) {
            this.emitUnavailable(asset?.id || data?.asset?.id, to, 'provider-missing-local-data', transfer, requestId);
            return false;
        }
        const rangeStart = transfer ? Number(transfer.rangeStart) : 0;
        const rangeEnd = transfer ? Number(transfer.rangeEnd) : cached.size;
        if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart < 0 || rangeEnd <= rangeStart || rangeEnd > cached.size) {
            this.emitUnavailable(asset.id, to, 'invalid-range', transfer, requestId);
            return false;
        }
        const attemptId = requestAttemptId(requestId, transfer?.transferId);
        this.emitTransferStatus(asset.id, to, 'started', transfer?.transferId, requestId);
        try {
            const startAck = await emitWithAck(this.socket, 'file-asset-relay-start', {
                sessionId: this.sessionId,
                to,
                asset: cached.asset,
                transferId: transfer?.transferId,
                rangeStart: transfer?.rangeStart,
                rangeEnd: transfer?.rangeEnd,
                attemptId,
                requestId
            }, this.runtime.ackTimeoutMs);
            if (startAck?.skipped) {
                this.emitTransferStatus(asset.id, to, 'completed', transfer?.transferId, requestId);
                return true;
            }
            const handle = await fs.promises.open(cached.path, 'r');
            try {
                let position = rangeStart;
                while (position < rangeEnd) {
                    if (this.stopping || !this.socket?.connected) throw new Error('file-upload-interrupted');
                    const length = Math.min(RELAY_CHUNK_SIZE, rangeEnd - position);
                    const chunk = Buffer.allocUnsafe(length);
                    const result = await handle.read(chunk, 0, length, position);
                    if (!result.bytesRead) throw new Error('cached-file-read-failed');
                    await emitWithAck(this.socket, 'file-asset-relay-chunk', {
                        sessionId: this.sessionId,
                        to,
                        assetId: asset.id,
                        transferId: transfer?.transferId,
                        attemptId,
                        chunk: result.bytesRead === chunk.length ? chunk : chunk.subarray(0, result.bytesRead)
                    }, this.runtime.ackTimeoutMs);
                    position += result.bytesRead;
                }
            } finally {
                await handle.close();
            }
            await emitWithAck(this.socket, 'file-asset-relay-complete', {
                sessionId: this.sessionId,
                to,
                assetId: asset.id,
                transferId: transfer?.transferId,
                attemptId
            }, Math.max(this.runtime.ackTimeoutMs, 60000));
            this.emitTransferStatus(asset.id, to, 'completed', transfer?.transferId, requestId);
            return true;
        } catch (err) {
            this.emitTransferStatus(asset.id, to, 'failed', transfer?.transferId, requestId);
            this.emitUnavailable(asset.id, to, 'asset-transfer-failed', transfer, requestId);
            throw err;
        }
    }

    emitTransferStatus(assetId, to, status, transferId, requestId) {
        if (!this.socket?.connected) return;
        this.socket.emit('file-asset-transfer-status', {
            sessionId: this.sessionId, assetId, to, status, transferId, requestId
        });
    }

    emitUnavailable(assetId, to, reason, transfer, requestId) {
        if (!this.socket?.connected || !assetId || !to) return;
        this.socket.emit('file-asset-unavailable', {
            sessionId: this.sessionId,
            assetId,
            to,
            reason,
            requestId,
            transferId: transfer?.transferId,
            rangeStart: transfer?.rangeStart,
            rangeEnd: transfer?.rangeEnd
        });
    }

    rejectCameraRequest(data) {
        if (!data?.requestId || !data?.from) return;
        this.socket.emit('device-camera-response', {
            requestId: data.requestId,
            from: this.deviceId,
            to: data.from,
            mode: data.mode === 'share-mine' ? 'share-mine' : 'open-remote',
            accepted: false,
            reason: 'vclient-unsupported'
        });
    }

    rejectContactCall(data) {
        if (!data?.callId || !data?.from) return;
        this.socket.emit('contact-call-rejected', {
            to: data.from,
            callId: data.callId,
            reason: 'vclient-unsupported'
        });
    }

    rejectTunnelInvite(data) {
        if (!data?.invitationId || !data?.from) return;
        this.socket.emit('device-tunnel-invite-ack', {
            invitationId: data.invitationId,
            from: this.deviceId,
            to: data.from,
            sessionId: data.sessionId || this.sessionId,
            accepted: false
        });
    }

    rejectLegacyFileOffer(data) {
        if (!data?.from || !data?.fileInfo?.id) return;
        this.socket.emit('file-answer', {
            sessionId: this.sessionId,
            to: data.from,
            from: this.deviceId,
            fileId: data.fileInfo.id,
            accepted: false,
            reason: 'vclient-use-file-assets'
        });
    }

    rejectLightRequest(data) {
        if (!data?.requestId) return;
        this.socket.emit('light-network-chunks-response', {
            requestId: data.requestId,
            taskId: data.taskId,
            chunks: [],
            unavailable: true,
            reason: 'vclient-unsupported'
        });
    }

    fail(err) {
        this.log('tunnel-error', { error: err?.stack || err?.message || String(err) });
        this.reportState('error', { error: err?.message || String(err) });
    }

    async stop() {
        if (this.stopping) return;
        this.stopping = true;
        this.reportState('stopping', { force: true });
        this.stopHeartbeat();
        if (this.auditRetryTimer) clearTimeout(this.auditRetryTimer);
        this.auditRetryTimer = null;
        for (const entry of this.wanted.values()) this.clearEntryTimers(entry);
        await this.abortAllReceives('stopped');
        const pendingUploads = Array.from(this.uploads.values());
        if (pendingUploads.length) {
            await Promise.race([
                Promise.allSettled(pendingUploads),
                new Promise(resolve => setTimeout(resolve, 1000))
            ]);
        }
        this.socket?.disconnect();
        this.socket = null;
        this.uploads.clear();
        this.ignoredEditorRelays.clear();
        this.reportState('disabled', { force: true });
    }
}

class VClientRuntime {
    constructor(options = {}) {
        this.serverUrl = normalizeServerUrl(options.serverUrl);
        if (!this.serverUrl) throw new Error('VClient server URL is required');
        this.token = String(options.token || '');
        if (!this.token) throw new Error('VClient control token is required');
        this.ioFactory = options.ioFactory || defaultIoFactory;
        this.logger = options.logger || console;
        this.controlNamespace = options.controlNamespace || '/vclient-control';
        this.heartbeatMs = Number(options.heartbeatMs) || DEFAULT_HEARTBEAT_MS;
        this.requestTimeoutMs = Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS;
        this.ackTimeoutMs = Number(options.ackTimeoutMs) || DEFAULT_ACK_TIMEOUT_MS;
        this.receiveIdleTimeoutMs = Number(options.receiveIdleTimeoutMs) || DEFAULT_RECEIVE_IDLE_TIMEOUT_MS;
        this.recordPageSize = Math.max(1, Math.min(500, Number(options.recordPageSize) || DEFAULT_RECORD_PAGE_SIZE));
        this.maxConcurrentDownloads = Math.max(1, Math.min(5, Number(options.maxConcurrentDownloads) || 3));
        this.store = options.store || new CacheStore(options.dataDir);
        this.control = null;
        this.tunnels = new Map();
        this.assignmentChain = Promise.resolve();
        this.stopping = false;
    }

    log(event, details = {}) {
        const line = { at: new Date().toISOString(), event, ...details };
        if (typeof this.logger.info === 'function') this.logger.info('[VClient]', line);
        else if (typeof this.logger.log === 'function') this.logger.log('[VClient]', line);
    }

    async start() {
        await this.store.init();
        this.control = this.ioFactory(controlUrl(this.serverUrl, this.controlNamespace), {
            autoConnect: false,
            reconnection: true,
            auth: {
                token: this.token,
                instanceId: this.store.instanceId,
                clientType: 'vclient'
            }
        });
        this.control.on('connect', () => {
            this.log('control-connected', { instanceId: this.store.instanceId });
            this.control.emit('status', {
                instanceId: this.store.instanceId,
                pid: process.pid,
                state: 'active',
                scope: 'process',
                updatedAt: Date.now()
            });
            for (const tunnel of this.tunnels.values()) this.reportStatus(tunnel, { force: true });
            for (const tunnel of this.tunnels.values()) tunnel.syncAuditRecords();
            this.control.emit('assignments-request', { instanceId: this.store.instanceId });
        });
        this.control.on('connect_error', err => this.log('control-connect-error', { error: err?.message || String(err) }));
        this.control.on('superseded', payload => {
            this.log('control-superseded', { reason: payload?.reason || 'superseded' });
            this.suspendTunnels('control-superseded');
        });
        this.control.on('disconnect', reason => {
            this.log('control-disconnected', { reason });
            if (!this.stopping) this.suspendTunnels(reason || 'control-disconnected');
        });
        this.control.on('assignments', (payload, ack) => {
            this.assignmentChain = this.assignmentChain
                .then(() => this.applyAssignments(payload))
                .then(result => ack?.({ ok: true, ...result }))
                .catch(err => {
                    this.log('assignments-failed', { error: err.message });
                    ack?.({ ok: false, error: err.message });
                });
        });
        this.control.connect();
        return this;
    }

    suspendTunnels(reason = 'control-offline') {
        this.assignmentChain = this.assignmentChain
            .then(() => this.applyAssignments({ tunnels: [] }))
            .then(() => this.log('data-tunnels-suspended', { reason }))
            .catch(err => this.log('data-tunnels-suspend-failed', { reason, error: err.message }));
        return this.assignmentChain;
    }

    async applyAssignments(payload) {
        const assignments = Array.isArray(payload?.tunnels) ? payload.tunnels : [];
        const enabled = new Set(assignments
            .filter(item => item?.enabled === true && VALID_SESSION_ID.test(String(item.sessionId || '')))
            .map(item => String(item.sessionId)));
        for (const [sessionId, tunnel] of Array.from(this.tunnels.entries())) {
            if (enabled.has(sessionId)) continue;
            await tunnel.stop();
            this.tunnels.delete(sessionId);
        }
        for (const sessionId of enabled) {
            if (this.tunnels.has(sessionId)) continue;
            const tunnel = new TunnelClient(this, sessionId);
            this.tunnels.set(sessionId, tunnel);
            await tunnel.start();
        }
        this.log('assignments-applied', { enabledTunnels: Array.from(enabled) });
        return { enabledCount: enabled.size };
    }

    async fetchRecords(tunnel) {
        if (!this.control?.connected) return;
        let cursor = null;
        for (let page = 0; page < MAX_RECORD_PAGES; page++) {
            const response = await emitWithAck(this.control, 'records-request', {
                sessionId: tunnel.sessionId,
                cursor,
                limit: this.recordPageSize
            }, this.ackTimeoutMs);
            const records = Array.isArray(response?.records) ? response.records :
                Array.isArray(response?.items) ? response.items : [];
            await tunnel.scanRecords(records);
            const nextCursor = response?.nextCursor ?? response?.next_cursor ?? null;
            const hasMore = response?.hasMore === true || response?.has_more === true || Boolean(nextCursor);
            if (!hasMore || !nextCursor || nextCursor === cursor || records.length === 0) break;
            cursor = nextCursor;
        }
    }

    reportStatus(tunnel, details = {}) {
        if (!this.control?.connected) return;
        const totals = this.store.sessionTotals(tunnel.sessionId);
        this.control.emit('status', {
            instanceId: this.store.instanceId,
            pid: process.pid,
            sessionId: tunnel.sessionId,
            deviceId: tunnel.deviceId,
            state: tunnel.state,
            pendingAssets: tunnel.wanted.size,
            activeTransfers: tunnel.receives.size + tunnel.uploads.size,
            cachedFiles: totals.files,
            cachedBytes: totals.bytes,
            lastSyncAt: tunnel.lastSyncAt,
            error: details.error !== undefined ? String(details.error || '') : tunnel.lastError,
            updatedAt: Date.now()
        });
    }

    reportAssetStatus(tunnel, assetId, state, details = {}) {
        if (!this.control?.connected) return;
        const bytesTotal = Number(details.bytesTotal ?? details.size) || 0;
        const bytesCached = state === 'cached'
            ? bytesTotal
            : Number(details.bytesCached ?? details.received) || 0;
        this.control.emit('asset-status', {
            instanceId: this.store.instanceId,
            sessionId: tunnel.sessionId,
            deviceId: tunnel.deviceId,
            assetId,
            state,
            bytesCached,
            bytesTotal,
            completedAt: state === 'cached' ? Date.now() : 0,
            ...details,
            updatedAt: Date.now()
        });
    }

    async stop() {
        if (this.stopping) return;
        this.stopping = true;
        await Promise.all(Array.from(this.tunnels.values()).map(tunnel => tunnel.stop()));
        this.tunnels.clear();
        this.control?.disconnect();
        this.control = null;
    }
}

module.exports = {
    VClientRuntime,
    TunnelClient,
    assetReferencesFromMessage,
    assetReferencesFromRecord,
    extractRichAssetReferences,
    binaryBuffer,
    emitWithAck,
    requestAttemptId,
    normalizeServerUrl,
    constants: {
        RELAY_CHUNK_SIZE,
        MAX_RELAY_CHUNK_SIZE,
        EDITOR_RELAY_CHUNK_SIZE,
        MAX_EDITOR_ASSET_SIZE,
        VALID_SESSION_ID,
        VALID_ASSET_ID
    }
};
