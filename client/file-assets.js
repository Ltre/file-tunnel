(function attachFileAssetTransfer(global) {
    const RELAY_CHUNK_SIZE = 64 * 1024;
    const P2P_CHUNK_SIZE = 64 * 1024;
    const BUFFER_LIMIT = 4 * 1024 * 1024;
    const BUFFER_LOW_WATER = 1 * 1024 * 1024;
    const BUFFER_POLL_MS = 20;
    const BUFFER_WAIT_TIMEOUT = 5000;
    const BUFFER_STALL_TIMEOUT = 8000;
    const P2P_TIMEOUT = 1500;
    const MAX_CONCURRENT_FULL_DOWNLOADS = 3;
    const MAX_CONCURRENT_MULTI_SOURCE_DOWNLOADS = 4;
    const MAX_CONCURRENT_UPLOADS = 2;
    const RECEIVE_TIMEOUT = 30000;
    const MAX_RETRIES = 3;
    const UPLOAD_COMPLETED_DEDUPE_MS = 5000;
    const MULTI_SOURCE_THRESHOLD = 10 * 1024 * 1024;
    const MULTI_SOURCE_RANGE_SIZE = 2 * 1024 * 1024;
    const MAX_CONCURRENT_RANGES = 4;
    const SMALL_TRANSFER_PRIORITY_SIZE = 1024 * 1024;
    const LARGE_FULL_UPLOAD_THRESHOLD = 4 * 1024 * 1024;
    const MULTI_SOURCE_WATCHDOG_INTERVAL = 5000;
    const MULTI_SOURCE_STALL_MS = 12000;
    const REQUEST_WATCHDOG_INTERVAL = 5000;
    const REQUEST_STALL_MS = 15000;
    const PROVIDER_TRANSFER_STALL_MS = 120000;
    const DISCOVERY_RETRY_MS = 2500;
    const DISCOVERY_RETRY_MAX_MS = 15000;
    const DISCOVERY_REQUEST_THROTTLE_MS = 3000;
    const RELAY_ACK_TIMEOUT = 30000;
    const RELAY_COMPLETE_ACK_TIMEOUT = 90000;
    const P2P_COMPLETE_ACK_TIMEOUT = 90000;

    class FileAssetTransfer {
        constructor(deps) {
            this.deps = deps;
            this.requests = new Map();
            this.desiredAssets = new Map();
            this.transfers = new Map();
            this.p2pUnavailablePeers = new Map();
            this.downloadQueue = [];
            this.priorityDownloads = new Set();
            this.activeDownloads = new Set();
            this.uploadQueue = [];
            this.activeUploads = 0;
            this.retryCounts = new Map();
            this.receiveTimers = new Map();
            this.multiSourceTransfers = new Map();
            this.rangeTimers = new Map();
            this.requestedMetadata = new Map();
            this.requestIds = new Map();
            this.forceRequests = new Map();
            this.providerTransfers = new Map();
            this.discoveryRequests = new Map();
            this.relayStartPromises = new Map();
            this.activeUploadKeys = new Set();
            this.activeUploadTasks = new Map();
            this.completedUploadKeys = new Map();
            this.rejectedUploadKeys = new Set();
            this.cancelledAssets = new Set();
            this.uploadQueueSeq = 0;
            this.requestWatchdogTimer = setInterval(() => this.checkRequestStalls(), REQUEST_WATCHDOG_INTERVAL);
        }

        log(event, details) {
            this.deps.log(`file-asset-${event}`, details);
        }

        socket() {
            return this.deps.getSocket();
        }

        async announce(asset) {
            const socket = this.socket();
            if (!socket || !socket.connected) return;
            socket.emit('file-asset-available', {
                sessionId: this.deps.getSessionId(),
                asset: this.metadata(asset)
            });
            this.log('announced', { asset: this.metadata(asset) });
        }

        metadata(asset) {
            return {
                id: asset.id,
                name: asset.name,
                type: asset.type || 'application/octet-stream',
                size: asset.size,
                ownerDeviceId: asset.ownerDeviceId,
                isFolderArchive: asset.isFolderArchive === true,
                isDirectoryMirror: asset.isDirectoryMirror === true,
                folderName: typeof asset.folderName === 'string' ? asset.folderName : undefined,
                entryCount: Number.isInteger(asset.entryCount) ? asset.entryCount : undefined
            };
        }

        dataSize(data) {
            if (!data) return 0;
            if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
            if (data instanceof ArrayBuffer) return data.byteLength;
            if (ArrayBuffer.isView(data)) return data.byteLength;
            return 0;
        }

        hasCompleteCache(file, metadata = null) {
            const size = this.dataSize(file?.data);
            if (size <= 0) return false;
            const expectedSize = Number(metadata?.size ?? file?.size);
            return !Number.isFinite(expectedSize) || expectedSize <= 0 || size === expectedSize;
        }

        sliceData(data, start, end) {
            if (data instanceof ArrayBuffer || (typeof Blob !== 'undefined' && data instanceof Blob)) {
                return data.slice(start, end);
            }
            if (ArrayBuffer.isView(data)) {
                return data.buffer.slice(data.byteOffset + start, data.byteOffset + end);
            }
            throw new Error('Invalid file asset data');
        }

        createRequestId(assetId) {
            const random = Math.random().toString(36).slice(2, 10);
            return `req-${String(assetId || '').slice(0, 8)}-${Date.now().toString(36)}-${random}`;
        }

        transferAttemptId(requestId, transport, transfer = null) {
            const base = String(requestId || this.createRequestId('asset')).replace(/[^a-zA-Z0-9_.:-]/g, '-');
            const part = transfer?.transferId ? `-${transfer.transferId}` : '-full';
            return `${base}-${transport}${part}`.slice(0, 120);
        }

        attemptTimestamp(attemptId) {
            const parts = String(attemptId || '').split('-');
            if (parts.length < 5 || parts[0] !== 'req') return 0;
            const value = Number.parseInt(parts[2], 36);
            return Number.isFinite(value) ? value : 0;
        }

        attemptPhase(transport) {
            if (transport === 'socket-relay') return 2;
            if (transport === 'p2p') return 1;
            return 0;
        }

        isStaleAttempt(existing, attemptId, transport) {
            if (!existing?.attemptId || !attemptId || existing.attemptId === attemptId) return false;
            const existingTime = existing.attemptTimestamp || this.attemptTimestamp(existing.attemptId);
            const nextTime = this.attemptTimestamp(attemptId);
            if (existingTime && nextTime && nextTime < existingTime) return true;
            if (existingTime && nextTime && nextTime === existingTime) {
                return this.attemptPhase(transport) < this.attemptPhase(existing.transport);
            }
            return false;
        }

        async markInterruptedAsset(assetId, asset, reason) {
            const metadata = asset || this.transfers.get(assetId)?.asset || this.requestedMetadata.get(assetId);
            if (!assetId || !metadata?.id) return;

            try {
                const existing = await this.deps.load(assetId);
                if (this.hasCompleteCache(existing, metadata)) return;
                const { data, ...previous } = existing || {};
                await this.deps.store({
                    ...previous,
                    ...this.metadata(metadata),
                    id: assetId,
                    sessionId: this.deps.getSessionId(),
                    isFileAsset: true,
                    isPartial: true,
                    transferInterrupted: true,
                    transferInterruptedAt: Date.now(),
                    transferInterruptedReason: String(reason || 'transfer-interrupted').slice(0, 80)
                });
                this.log('interrupted-cache-marked', { assetId, reason });
            } catch (err) {
                this.log('interrupted-cache-mark-failed', { assetId, reason, error: err.message });
            }
        }

        async request(assetId, preferredProviderId, metadata = null, options = {}) {
            if (!assetId) return;
            if (options.force) {
                this.cancel(assetId);
                this.forceRequests.set(assetId, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
            }
            if (options.force || options.priority) this.priorityDownloads.add(assetId);
            this.cancelledAssets.delete(assetId);
            if (metadata?.id === assetId) this.requestedMetadata.set(assetId, metadata);
            if (this.desiredAssets.has(assetId)) {
                if (preferredProviderId) this.desiredAssets.set(assetId, preferredProviderId);
                if (options.force || options.priority) {
                    const queueIndex = this.downloadQueue.indexOf(assetId);
                    if (queueIndex > 0) {
                        this.downloadQueue.splice(queueIndex, 1);
                        this.downloadQueue.unshift(assetId);
                        this.deps.onQueue?.(assetId, this.downloadQueue.length, this.activeDownloads.size);
                        this.log('download-queue-promoted', { assetId, queueLength: this.downloadQueue.length });
                        this.dispatchDownloads();
                    }
                }
                const activeButIdle = this.activeDownloads.has(assetId) &&
                    !this.transfers.has(assetId) &&
                    !this.multiSourceTransfers.has(assetId) &&
                    !this.providerTransfers.has(assetId);
                const requestedAt = this.requests.get(assetId) || 0;
                if ((options.force || options.priority) && activeButIdle && (!requestedAt || Date.now() - requestedAt > 3000)) {
                    this.retryDownload(assetId, preferredProviderId || this.desiredAssets.get(assetId), 'manual-existing-request-kick');
                    return;
                }
                this.ensureDesiredDownloadQueued(assetId, options.force ? 'force-existing-request' : 'existing-request');
                return;
            }
            this.desiredAssets.set(assetId, preferredProviderId);
            const local = await this.deps.load(assetId);
            if (!this.desiredAssets.has(assetId)) return;
            if (this.hasCompleteCache(local, metadata)) {
                if (local.cacheCleared || local.restoreRequested) {
                    try {
                        await this.deps.store({
                            ...local,
                            cacheCleared: false,
                            restoreRequested: false,
                            timestamp: local.timestamp || Date.now()
                        });
                    } catch (err) {
                        this.log('cache-flag-reset-failed', { assetId, error: err.message });
                    }
                }
                this.desiredAssets.delete(assetId);
                this.requestedMetadata.delete(assetId);
                this.requestIds.delete(assetId);
                this.forceRequests.delete(assetId);
                this.priorityDownloads.delete(assetId);
                this.discoveryRequests.delete(assetId);
                this.log('request-skipped-local-cache', { assetId, size: this.dataSize(local.data) });
                return;
            }
            this.enqueueDownload(assetId);
        }

        hasDownloadWork(assetId) {
            return this.activeDownloads.has(assetId) ||
                this.downloadQueue.includes(assetId) ||
                this.transfers.has(assetId) ||
                this.multiSourceTransfers.has(assetId);
        }

        ensureDesiredDownloadQueued(assetId, reason = 'desired-download-check') {
            if (!assetId || !this.desiredAssets.has(assetId)) return false;
            if (this.hasDownloadWork(assetId)) return false;
            this.log('desired-download-requeued', {
                assetId,
                reason,
                queueLength: this.downloadQueue.length,
                activeDownloads: this.activeDownloads.size
            });
            this.enqueueDownload(assetId);
            return true;
        }

        enqueueDownload(assetId) {
            if (!this.desiredAssets.has(assetId) || this.activeDownloads.has(assetId) || this.downloadQueue.includes(assetId)) return;
            if (this.priorityDownloads.has(assetId)) this.downloadQueue.unshift(assetId);
            else this.downloadQueue.push(assetId);
            this.deps.onQueue?.(assetId, this.downloadQueue.length, this.activeDownloads.size);
            this.log('download-queued', {
                assetId,
                queueLength: this.downloadQueue.length,
                activeDownloads: this.activeDownloads.size,
                priority: this.priorityDownloads.has(assetId)
            });
            this.dispatchDownloads();
        }

        downloadMode(assetId) {
            const metadata = this.requestedMetadata.get(assetId);
            return Number(metadata?.size) > MULTI_SOURCE_THRESHOLD ? 'multi-source' : 'full';
        }

        assetSize(assetId) {
            return Number(this.requestedMetadata.get(assetId)?.size) || 0;
        }

        downloadPriority(assetId) {
            if (this.priorityDownloads.has(assetId)) return -1;
            const size = this.assetSize(assetId);
            if (size > 0 && size <= SMALL_TRANSFER_PRIORITY_SIZE) return 0;
            return this.downloadMode(assetId) === 'multi-source' ? 2 : 1;
        }

        activeDownloadCount(mode) {
            return Array.from(this.activeDownloads)
                .filter(assetId => this.downloadMode(assetId) === mode)
                .length;
        }

        canStartDownload(assetId) {
            const mode = this.downloadMode(assetId);
            const limit = mode === 'multi-source' ? MAX_CONCURRENT_MULTI_SOURCE_DOWNLOADS : MAX_CONCURRENT_FULL_DOWNLOADS;
            const activeCount = this.activeDownloadCount(mode);
            if (activeCount < limit) return true;
            return this.priorityDownloads.has(assetId) && activeCount < limit + 1;
        }

        nextDownloadIndex() {
            let bestIndex = -1;
            let bestPriority = Infinity;
            let bestSize = Infinity;
            for (let index = 0; index < this.downloadQueue.length; index++) {
                const assetId = this.downloadQueue[index];
                if (!this.canStartDownload(assetId)) continue;
                const priority = this.downloadPriority(assetId);
                const size = this.assetSize(assetId) || Infinity;
                if (priority < bestPriority || (priority === bestPriority && size < bestSize)) {
                    bestIndex = index;
                    bestPriority = priority;
                    bestSize = size;
                }
            }
            return bestIndex;
        }

        dispatchDownloads() {
            const socket = this.socket();
            if (!socket?.connected) return;
            while (this.downloadQueue.length) {
                const nextIndex = this.nextDownloadIndex();
                if (nextIndex < 0) break;
                const [assetId] = this.downloadQueue.splice(nextIndex, 1);
                if (!this.desiredAssets.has(assetId) || this.activeDownloads.has(assetId)) continue;
                this.activeDownloads.add(assetId);
                this.requests.set(assetId, Date.now());
                const metadata = this.requestedMetadata.get(assetId);
                const forceToken = this.forceRequests.get(assetId);
                const requestId = forceToken
                    ? `${this.createRequestId(assetId)}:force:${String(forceToken).replace(/[^a-zA-Z0-9_.:-]/g, '-')}`
                    : this.createRequestId(assetId);
                this.requestIds.set(assetId, requestId);
                const forced = Boolean(forceToken);
                const needsManifest = Number(metadata?.size) > MULTI_SOURCE_THRESHOLD;
                socket.emit('file-asset-request', {
                    sessionId: this.deps.getSessionId(),
                    assetId,
                    mode: needsManifest ? 'manifest' : undefined,
                    preferredProviderId: this.desiredAssets.get(assetId),
                    force: forced,
                    requestId
                });
                this.log(needsManifest ? 'manifest-requested' : 'requested', {
                    assetId, preferredProviderId: this.desiredAssets.get(assetId), activeDownloads: this.activeDownloads.size,
                    forced
                });
            }
        }

        checkRequestStalls() {
            const now = Date.now();
            for (const assetId of Array.from(this.desiredAssets.keys())) {
                this.ensureDesiredDownloadQueued(assetId, 'watchdog-orphaned-desired');
            }
            for (const assetId of Array.from(this.activeDownloads)) {
                if (!this.desiredAssets.has(assetId)) continue;
                if (this.transfers.has(assetId) || this.multiSourceTransfers.has(assetId)) continue;
                const providerTransfer = this.providerTransfers.get(assetId);
                if (providerTransfer && now - providerTransfer.updatedAt < PROVIDER_TRANSFER_STALL_MS) {
                    continue;
                }
                if (providerTransfer) this.providerTransfers.delete(assetId);
                const requestedAt = this.requests.get(assetId) || 0;
                if (!requestedAt || now - requestedAt < REQUEST_STALL_MS) continue;
                this.log('request-watchdog-stalled', {
                    assetId,
                    waitedMs: now - requestedAt,
                    preferredProviderId: this.desiredAssets.get(assetId),
                    queueLength: this.downloadQueue.length,
                    activeDownloads: this.activeDownloads.size
                });
                this.retryDownload(assetId, this.desiredAssets.get(assetId), 'request-watchdog-stalled');
            }
        }

        requestProviderDiscovery(assetId, reason = 'provider-discovery') {
            const socket = this.socket();
            if (!socket?.connected || !assetId) return false;
            const now = Date.now();
            const lastRequestedAt = this.discoveryRequests.get(assetId) || 0;
            if (now - lastRequestedAt < DISCOVERY_REQUEST_THROTTLE_MS) return false;
            this.discoveryRequests.set(assetId, now);
            socket.emit('file-asset-discovery', {
                sessionId: this.deps.getSessionId(),
                assetId,
                reason
            });
            this.log('provider-discovery-requested', { assetId, reason });
            return true;
        }

        scheduleProviderDiscoveryRetry(assetId, providerId, reason = 'provider-discovery') {
            if (!this.desiredAssets.has(assetId)) return;
            const attempts = (this.retryCounts.get(assetId) || 0) + 1;
            this.retryCounts.set(assetId, attempts);
            this.requestProviderDiscovery(assetId, reason);
            this.providerTransfers.delete(assetId);
            this.releaseDownload(assetId);
            this.forceRequests.set(assetId, `discovery:${assetId}:${attempts}:${Date.now()}`);
            this.priorityDownloads.add(assetId);
            const delay = Math.min(DISCOVERY_RETRY_MAX_MS, attempts * DISCOVERY_RETRY_MS);
            this.log('provider-discovery-retry-scheduled', {
                assetId,
                providerId,
                reason,
                attempts,
                delay
            });
            setTimeout(() => {
                if (!this.desiredAssets.has(assetId)) return;
                this.desiredAssets.set(assetId, null);
                this.enqueueDownload(assetId);
            }, delay);
        }

        async handleTransferStatus(data) {
            const { assetId, from, status, transferId, requestId } = data || {};
            if (!assetId || !this.desiredAssets.has(assetId)) return;
            const currentRequestId = this.requestIds.get(assetId);
            if (!transferId && requestId && currentRequestId && requestId !== currentRequestId) {
                this.log('provider-transfer-status-ignored-stale', {
                    assetId,
                    peerDeviceId: from,
                    transferId,
                    status,
                    requestId,
                    currentRequestId
                });
                return;
            }
            const now = Date.now();
            if (status === 'started') {
                this.providerTransfers.set(assetId, { from, transferId: transferId || 'full', requestId: requestId || currentRequestId || '', updatedAt: now });
                const metadata = this.requestedMetadata.get(assetId);
                if (metadata?.name) this.deps.onProgress(assetId, metadata.name, 0, 'receiving');
                this.log('provider-transfer-started', { assetId, peerDeviceId: from, transferId, requestId });
                return;
            }
            this.providerTransfers.delete(assetId);
            if (status === 'failed') {
                this.log('provider-transfer-failed', { assetId, peerDeviceId: from, transferId, requestId });
                this.retryDownload(assetId, from, 'provider-transfer-failed');
                return;
            }
            if (status === 'completed') {
                this.log('provider-transfer-completed', { assetId, peerDeviceId: from, transferId, requestId });
                setTimeout(async () => {
                    if (!this.desiredAssets.has(assetId)) return;
                    if (this.transfers.has(assetId) || this.multiSourceTransfers.has(assetId)) return;
                    const metadata = this.requestedMetadata.get(assetId);
                    const local = await this.deps.load(assetId).catch(() => null);
                    if (this.hasCompleteCache(local, metadata)) return;
                    this.retryDownload(assetId, from, 'provider-completed-without-local-cache');
                }, 2000);
            }
        }

        handleManifest(data) {
            const asset = data?.asset;
            const providers = Array.isArray(data?.providers) ? data.providers.filter(Boolean) : [];
            if (!asset?.id || !this.desiredAssets.has(asset.id)) return;
            if (!providers.length) {
                this.handleUnavailable({ assetId: asset.id, reason: 'no-online-provider' });
                return;
            }
            const requestId = this.forceRequests.get(asset.id);
            if (asset.size > MULTI_SOURCE_THRESHOLD && providers.length >= 2) {
                this.beginMultiSourceDownload(asset, providers, requestId);
                return;
            }
            const socket = this.socket();
            if (!socket?.connected) return;
            const forceToken = this.forceRequests.get(asset.id);
            const fallbackRequestId = forceToken
                ? `${this.createRequestId(asset.id)}:force:${String(forceToken).replace(/[^a-zA-Z0-9_.:-]/g, '-')}`
                : this.createRequestId(asset.id);
            const forced = Boolean(forceToken);
            this.requests.set(asset.id, Date.now());
            this.requestIds.set(asset.id, fallbackRequestId);
            socket.emit('file-asset-request', {
                sessionId: this.deps.getSessionId(),
                assetId: asset.id,
                preferredProviderId: this.desiredAssets.get(asset.id) || providers[0],
                force: forced,
                requestId: fallbackRequestId
            });
            this.log('requested', { assetId: asset.id, preferredProviderId: this.desiredAssets.get(asset.id) || providers[0], forced });
        }

        beginMultiSourceDownload(asset, providers, forceRequestId = null) {
            if (this.multiSourceTransfers.has(asset.id)) return;
            let buffer;
            try {
                buffer = new Uint8Array(asset.size);
            } catch (err) {
                this.log('multi-source-buffer-failed', { assetId: asset.id, error: err.message });
                this.handleManifest({ asset, providers: [providers[0]] });
                return;
            }

            const ranges = new Map();
            for (let start = 0, index = 0; start < asset.size; start += MULTI_SOURCE_RANGE_SIZE, index++) {
                const end = Math.min(start + MULTI_SOURCE_RANGE_SIZE, asset.size);
                const transferId = `part-${index}`;
                ranges.set(transferId, {
                    transferId,
                    rangeStart: start,
                    rangeEnd: end,
                    providerCursor: index % providers.length,
                    providerId: null,
                    from: null,
                    transport: null,
                    receivedSize: 0,
                    pendingChunks: Promise.resolve(),
                    retryCount: 0,
                    active: false,
                    completed: false,
                    retryScheduled: false,
                    lastActivityAt: 0,
                    attemptId: '',
                    attemptTimestamp: 0
                });
            }
            this.multiSourceTransfers.set(asset.id, {
                asset,
                providers,
                buffer,
                ranges,
                queuedRangeIds: Array.from(ranges.keys()),
                activeRangeIds: new Set(),
                completedBytes: 0,
                forceRequestId,
                startedAt: Date.now(),
                lastProgressAt: Date.now(),
                watchdogTimer: null
            });
            this.deps.onProgress(asset.id, asset.name, 0, 'receiving-multi-source');
            this.log('multi-source-started', { asset: this.metadata(asset), providers, rangeCount: ranges.size, forced: Boolean(forceRequestId) });
            this.startMultiSourceWatchdog(asset.id);
            this.dispatchMultiSourceRanges(asset.id);
        }

        dispatchMultiSourceRanges(assetId) {
            const transfer = this.multiSourceTransfers.get(assetId);
            const socket = this.socket();
            if (!transfer || !socket?.connected) return;
            while (transfer.activeRangeIds.size < MAX_CONCURRENT_RANGES && transfer.queuedRangeIds.length) {
                const transferId = transfer.queuedRangeIds.shift();
                const range = transfer.ranges.get(transferId);
                if (!range || range.completed || range.active) continue;
                const preferredProviderId = transfer.providers[range.providerCursor % transfer.providers.length];
                range.active = true;
                range.providerId = preferredProviderId;
                range.from = null;
                range.transport = null;
                range.receivedSize = 0;
                range.pendingChunks = Promise.resolve();
                range.lastActivityAt = Date.now();
                range.attemptId = '';
                range.attemptTimestamp = 0;
                transfer.activeRangeIds.add(transferId);
                this.resetRangeTimer(assetId, transferId);
                const forceToken = transfer.forceRequestId
                    ? String(transfer.forceRequestId).replace(/[^a-zA-Z0-9_.:-]/g, '-')
                    : '';
                const requestId = `${this.createRequestId(assetId)}:${forceToken ? `force:${forceToken}:` : ''}${transferId}:${range.retryCount}`;
                const forced = Boolean(transfer.forceRequestId || range.retryCount > 0);
                socket.emit('file-asset-request', {
                    sessionId: this.deps.getSessionId(),
                    assetId,
                    preferredProviderId,
                    transferId,
                    rangeStart: range.rangeStart,
                    rangeEnd: range.rangeEnd,
                    force: forced,
                    requestId
                });
                this.log('range-requested', {
                    assetId, transferId, preferredProviderId,
                    rangeStart: range.rangeStart, rangeEnd: range.rangeEnd,
                    forced
                });
            }
        }

        beginMultiSourceRange(assetId, asset, deviceId, transport, part, attemptId = '') {
            const transfer = this.multiSourceTransfers.get(assetId);
            const range = transfer?.ranges.get(part?.transferId);
            if (!transfer || !range || !range.active || range.retryScheduled || range.completed || asset.id !== assetId ||
                part.rangeStart !== range.rangeStart || part.rangeEnd !== range.rangeEnd) {
                throw new Error('Invalid multi-source range metadata');
            }
            if (this.isStaleAttempt(range, attemptId, transport)) {
                this.log('stale-range-start-ignored', {
                    assetId,
                    transferId: range.transferId,
                    peerDeviceId: deviceId,
                    attemptId,
                    activeAttemptId: range.attemptId
                });
                return false;
            }
            range.from = deviceId;
            range.providerId = deviceId;
            range.transport = transport;
            range.attemptId = attemptId;
            range.attemptTimestamp = this.attemptTimestamp(attemptId);
            range.receivedSize = 0;
            range.pendingChunks = Promise.resolve();
            range.lastActivityAt = Date.now();
            this.resetRangeTimer(assetId, range.transferId);
            this.log('range-receiving', { assetId, transferId: range.transferId, peerDeviceId: deviceId, transport, attemptId });
            return true;
        }

        async appendMultiSourceRange(assetId, transferId, deviceId, data, attemptId = '') {
            const transfer = this.multiSourceTransfers.get(assetId);
            const range = transfer?.ranges.get(transferId);
            if (!transfer || !range || range.completed || !range.active || range.retryScheduled || range.from !== deviceId) return;
            if (attemptId && range.attemptId && range.attemptId !== attemptId) {
                this.log('stale-range-chunk-ignored', {
                    assetId,
                    transferId,
                    attemptId,
                    activeAttemptId: range.attemptId
                });
                return;
            }
            let chunk = data instanceof Blob ? await data.arrayBuffer() : data;
            if (ArrayBuffer.isView(chunk)) chunk = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
            if (!(chunk instanceof ArrayBuffer)) throw new Error('Invalid multi-source chunk');
            if (range.receivedSize + chunk.byteLength > range.rangeEnd - range.rangeStart) {
                throw new Error('Multi-source range exceeded expected size');
            }
            transfer.buffer.set(new Uint8Array(chunk), range.rangeStart + range.receivedSize);
            range.receivedSize += chunk.byteLength;
            range.lastActivityAt = Date.now();
            transfer.lastProgressAt = Date.now();
            this.resetRangeTimer(assetId, transferId);
            this.reportMultiSourceProgress(transfer);
        }

        queueMultiSourceChunk(assetId, transferId, deviceId, data, attemptId = '') {
            const transfer = this.multiSourceTransfers.get(assetId);
            const range = transfer?.ranges.get(transferId);
            if (!range) return Promise.resolve();
            if (attemptId && range.attemptId && range.attemptId !== attemptId) {
                this.log('stale-range-chunk-queued-ignored', {
                    assetId,
                    transferId,
                    attemptId,
                    activeAttemptId: range.attemptId
                });
                return Promise.resolve();
            }
            range.pendingChunks = range.pendingChunks.then(() => this.appendMultiSourceRange(assetId, transferId, deviceId, data, attemptId));
            return range.pendingChunks;
        }

        async completeMultiSourceRange(assetId, transferId, deviceId, transport, attemptId = '') {
            const transfer = this.multiSourceTransfers.get(assetId);
            const range = transfer?.ranges.get(transferId);
            if (!transfer || !range || range.completed || range.from !== deviceId) throw new Error('Multi-source range mismatch');
            if (attemptId && range.attemptId && range.attemptId !== attemptId) {
                this.log('stale-range-complete-ignored', {
                    assetId,
                    transferId,
                    attemptId,
                    activeAttemptId: range.attemptId,
                    transport
                });
                return false;
            }
            await range.pendingChunks;
            if (range.receivedSize !== range.rangeEnd - range.rangeStart) throw new Error('Multi-source range size mismatch');
            range.completed = true;
            range.active = false;
            this.clearRangeTimer(assetId, transferId);
            transfer.activeRangeIds.delete(transferId);
            transfer.completedBytes += range.receivedSize;
            transfer.lastProgressAt = Date.now();
            this.reportMultiSourceProgress(transfer);
            this.log('range-completed', { assetId, transferId, peerDeviceId: deviceId, transport, attemptId });

            if (Array.from(transfer.ranges.values()).every(item => item.completed)) {
                await this.completeMultiSourceDownload(assetId, transfer);
            } else {
                this.dispatchMultiSourceRanges(assetId);
            }
            return true;
        }

        reportMultiSourceProgress(transfer) {
            const activeBytes = Array.from(transfer.ranges.values())
                .filter(range => !range.completed)
                .reduce((total, range) => total + range.receivedSize, 0);
            const progress = Math.min(99, Math.floor((transfer.completedBytes + activeBytes) * 100 / transfer.asset.size));
            this.deps.onProgress(transfer.asset.id, transfer.asset.name, progress, 'receiving-multi-source');
        }

        async completeMultiSourceDownload(assetId, transfer) {
            const stored = {
                ...transfer.asset,
                sessionId: this.deps.getSessionId(),
                isFileAsset: true,
                data: transfer.buffer.buffer,
                timestamp: Date.now()
            };
            this.stopMultiSourceWatchdog(transfer);
            this.clearRangeTimers(assetId);
            this.multiSourceTransfers.delete(assetId);
            await this.deps.store(stored);
            this.releaseCompletedDownload(assetId, stored, 'multi-source-completed');
            this.deps.onProgress(assetId, stored.name, 100, 'received-multi-source');
            await this.announce(stored);
            await this.deps.onReceived(stored);
            this.log('multi-source-completed', { asset: this.metadata(stored) });
        }

        retryMultiSourceRange(assetId, transferId, providerId, reason, error) {
            const transfer = this.multiSourceTransfers.get(assetId);
            const range = transfer?.ranges.get(transferId);
            if (!transfer || !range || range.completed || range.retryScheduled) return;
            range.retryScheduled = true;
            range.active = false;
            range.from = null;
            range.transport = null;
            range.receivedSize = 0;
            range.pendingChunks = Promise.resolve();
            range.attemptId = '';
            range.attemptTimestamp = 0;
            range.lastActivityAt = Date.now();
            transfer.activeRangeIds.delete(transferId);
            this.clearRangeTimer(assetId, transferId);
            range.retryCount++;
            const providerIndex = transfer.providers.indexOf(providerId || range.providerId);
            range.providerCursor = (providerIndex >= 0 ? providerIndex + 1 : range.providerCursor + 1) % transfer.providers.length;
            if (range.retryCount > MAX_RETRIES) {
                const interruptedAsset = transfer.asset;
                this.stopMultiSourceWatchdog(transfer);
                this.clearRangeTimers(assetId);
                this.multiSourceTransfers.delete(assetId);
                this.releaseDownload(assetId);
                this.desiredAssets.delete(assetId);
                this.requestedMetadata.delete(assetId);
                this.requestIds.delete(assetId);
                this.forceRequests.delete(assetId);
                this.priorityDownloads.delete(assetId);
                this.markInterruptedAsset(assetId, interruptedAsset, reason);
                this.deps.onUnavailable(assetId, 'transfer-interrupted');
                this.log('range-retry-exhausted', { assetId, transferId, providerId, reason, error });
                return;
            }
            this.log('range-retry-scheduled', { assetId, transferId, providerId, reason, error, attempts: range.retryCount });
            setTimeout(() => {
                const current = this.multiSourceTransfers.get(assetId)?.ranges.get(transferId);
                if (!current || current.completed) return;
                current.retryScheduled = false;
                this.multiSourceTransfers.get(assetId).queuedRangeIds.push(transferId);
                this.dispatchMultiSourceRanges(assetId);
            }, range.retryCount * 500);
        }

        startMultiSourceWatchdog(assetId) {
            const transfer = this.multiSourceTransfers.get(assetId);
            if (!transfer || transfer.watchdogTimer) return;
            transfer.watchdogTimer = setInterval(() => this.checkMultiSourceStall(assetId), MULTI_SOURCE_WATCHDOG_INTERVAL);
        }

        stopMultiSourceWatchdog(transfer) {
            if (transfer?.watchdogTimer) clearInterval(transfer.watchdogTimer);
            if (transfer) transfer.watchdogTimer = null;
        }

        checkMultiSourceStall(assetId) {
            const transfer = this.multiSourceTransfers.get(assetId);
            if (!transfer) return;
            const now = Date.now();
            const activeRanges = Array.from(transfer.activeRangeIds)
                .map(transferId => transfer.ranges.get(transferId))
                .filter(range => range && !range.completed && range.active && !range.retryScheduled);
            const stalledRanges = activeRanges
                .filter(range => now - (range.lastActivityAt || transfer.lastProgressAt || transfer.startedAt) >= MULTI_SOURCE_STALL_MS)
                .sort((a, b) => (a.lastActivityAt || 0) - (b.lastActivityAt || 0));

            if (stalledRanges.length) {
                const range = stalledRanges[0];
                this.log('range-watchdog-stalled', {
                    assetId,
                    transferId: range.transferId,
                    providerId: range.providerId,
                    receivedSize: range.receivedSize,
                    staleForMs: now - (range.lastActivityAt || transfer.lastProgressAt || transfer.startedAt)
                });
                this.retryMultiSourceRange(assetId, range.transferId, range.providerId, 'watchdog-stalled');
                return;
            }

            const incompleteQueued = transfer.queuedRangeIds.some(transferId => {
                const range = transfer.ranges.get(transferId);
                return range && !range.completed && !range.active;
            });
            if (!transfer.activeRangeIds.size && !incompleteQueued) {
                for (const range of transfer.ranges.values()) {
                    if (!range.completed && !range.active && !range.retryScheduled) {
                        transfer.queuedRangeIds.push(range.transferId);
                    }
                }
                if (transfer.queuedRangeIds.length) {
                    this.log('range-watchdog-requeued', { assetId, queuedRangeCount: transfer.queuedRangeIds.length });
                    this.dispatchMultiSourceRanges(assetId);
                }
            }
        }

        rangeTimerKey(assetId, transferId) {
            return `${assetId}:${transferId}`;
        }

        resetRangeTimer(assetId, transferId) {
            this.clearRangeTimer(assetId, transferId);
            const timer = setTimeout(() => this.retryMultiSourceRange(assetId, transferId, null, 'receive-timeout'), RECEIVE_TIMEOUT);
            this.rangeTimers.set(this.rangeTimerKey(assetId, transferId), timer);
        }

        clearRangeTimer(assetId, transferId) {
            const key = this.rangeTimerKey(assetId, transferId);
            const timer = this.rangeTimers.get(key);
            if (timer) clearTimeout(timer);
            this.rangeTimers.delete(key);
        }

        clearRangeTimers(assetId) {
            Array.from(this.rangeTimers.keys())
                .filter(key => key.startsWith(`${assetId}:`))
                .forEach(key => {
                    clearTimeout(this.rangeTimers.get(key));
                    this.rangeTimers.delete(key);
                });
        }

        releaseDownload(assetId) {
            this.requests.delete(assetId);
            this.activeDownloads.delete(assetId);
            this.clearReceiveTimer(assetId);
            this.dispatchDownloads();
        }

        handleAvailable(data) {
            const asset = data && data.asset;
            if (!asset || !asset.id || !this.desiredAssets.has(asset.id)) return;
            this.requestedMetadata.set(asset.id, asset);
            this.retryCounts.delete(asset.id);
            const multiSource = this.multiSourceTransfers.get(asset.id);
            if (multiSource) {
                const providerId = data.from || asset.ownerDeviceId;
                if (providerId && !multiSource.providers.includes(providerId)) multiSource.providers.push(providerId);
                return;
            }
            if (this.activeDownloads.has(asset.id) || this.transfers.has(asset.id)) {
                this.log('available-ignored-in-progress', { assetId: asset.id, from: data.from });
                return;
            }
            this.releaseDownload(asset.id);
            this.desiredAssets.set(asset.id, asset.ownerDeviceId || data.from);
            this.enqueueDownload(asset.id);
        }

        handleRequest(data) {
            if (!data?.asset?.id || !data?.from) return;
            const key = this.uploadKey(data);
            this.cleanupCompletedUploads();
            if (this.activeUploadKeys.has(key) ||
                this.uploadQueue.some(item => item._uploadKey === key) ||
                this.completedUploadKeys.has(key)) {
                this.log('upload-request-ignored-duplicate', {
                    assetId: data.asset.id,
                    peerDeviceId: data.from,
                    transferId: data.transfer?.transferId || null,
                    requestId: data.requestId || null
                });
                return;
            }
            data._uploadKey = key;
            data._queueSeq = this.uploadQueueSeq++;
            this.uploadQueue.push(data);
            this.log('upload-queued', { assetId: data.asset.id, peerDeviceId: data.from, queueLength: this.uploadQueue.length });
            this.dispatchUploads();
        }

        dispatchUploads() {
            while (this.activeUploads < MAX_CONCURRENT_UPLOADS && this.uploadQueue.length) {
                const nextIndex = this.nextUploadIndex();
                if (nextIndex < 0) break;
                const [data] = this.uploadQueue.splice(nextIndex, 1);
                const key = data._uploadKey || this.uploadKey(data);
                if (this.activeUploadKeys.has(key)) continue;
                this.activeUploads++;
                this.activeUploadKeys.add(key);
                this.activeUploadTasks.set(key, data);
                this.sendRequestedAsset(data)
                    .then(success => {
                        if (success) this.completedUploadKeys.set(key, Date.now());
                    })
                    .catch(err => this.log('send-failed', { assetId: data?.asset?.id, peerDeviceId: data?.from, error: err.message }))
                    .finally(() => {
                        this.activeUploadKeys.delete(key);
                        this.activeUploadTasks.delete(key);
                        this.cleanupCompletedUploads();
                        this.activeUploads--;
                        this.dispatchUploads();
                    });
            }
        }

        isRangeUpload(data) {
            return Boolean(data?.transfer?.transferId);
        }

        uploadPriority(data) {
            const size = Number(data?.asset?.size) || 0;
            if (!this.isRangeUpload(data) && size > 0 && size <= SMALL_TRANSFER_PRIORITY_SIZE) return 0;
            if (!this.isRangeUpload(data)) return 1;
            return 2;
        }

        canStartUpload(data) {
            if (!this.isRangeUpload(data)) {
                const size = Number(data?.asset?.size) || 0;
                if (size > 0 && size <= SMALL_TRANSFER_PRIORITY_SIZE) return true;
                const peerId = data?.from || '';
                const activeLargeFullUploadsForPeer = Array.from(this.activeUploadTasks.values())
                    .filter(item =>
                        !this.isRangeUpload(item) &&
                        item?.from === peerId &&
                        (Number(item?.asset?.size) || 0) > LARGE_FULL_UPLOAD_THRESHOLD
                    )
                    .length;
                return activeLargeFullUploadsForPeer < 1;
            }
            const hasFullUploadQueued = this.uploadQueue.some(item => !this.isRangeUpload(item));
            if (!hasFullUploadQueued) return true;
            const activeRangeUploads = Array.from(this.activeUploadTasks.values())
                .filter(item => this.isRangeUpload(item))
                .length;
            return activeRangeUploads < 1;
        }

        nextUploadIndex() {
            let bestIndex = -1;
            let bestPriority = Infinity;
            let bestSize = Infinity;
            let bestSeq = Infinity;
            for (let index = 0; index < this.uploadQueue.length; index++) {
                const item = this.uploadQueue[index];
                if (!this.canStartUpload(item)) continue;
                const priority = this.uploadPriority(item);
                const size = Number(item?.asset?.size) || Infinity;
                const seq = Number.isFinite(item?._queueSeq) ? item._queueSeq : Infinity;
                if (
                    priority < bestPriority ||
                    (priority === bestPriority && size < bestSize) ||
                    (priority === bestPriority && size === bestSize && seq < bestSeq)
                ) {
                    bestIndex = index;
                    bestPriority = priority;
                    bestSize = size;
                    bestSeq = seq;
                }
            }
            return bestIndex;
        }

        uploadKey(data) {
            const assetId = data?.asset?.id || '';
            const from = data?.from || '';
            const transfer = data?.transfer || {};
            return [
                assetId,
                from,
                data?.requestId || '',
                transfer.transferId || 'full',
                Number.isInteger(transfer.rangeStart) ? transfer.rangeStart : 0,
                Number.isInteger(transfer.rangeEnd) ? transfer.rangeEnd : 'end'
            ].join(':');
        }

        uploadCancelKey(assetId, peerDeviceId, transferId = 'full') {
            return [assetId || '', peerDeviceId || '', transferId || 'full'].join(':');
        }

        cleanupCompletedUploads() {
            const expiresBefore = Date.now() - UPLOAD_COMPLETED_DEDUPE_MS;
            for (const [key, completedAt] of this.completedUploadKeys) {
                if (completedAt < expiresBefore) this.completedUploadKeys.delete(key);
            }
        }

        async sendRequestedAsset(data) {
            const { asset, from, transfer } = data || {};
            if (!asset || !asset.id || !from) return false;
            const requestId = typeof data?.requestId === 'string' && data.requestId
                ? data.requestId
                : this.createRequestId(asset.id);
            const stored = await this.deps.load(asset.id);
            const storedSize = this.dataSize(stored?.data);
            let channel = null;
            if (!this.hasCompleteCache(stored, asset)) {
                this.emitUnavailable(asset.id, from, 'provider-missing-local-data', transfer, requestId);
                return false;
            }
            if (transfer && (!Number.isInteger(transfer.rangeStart) || !Number.isInteger(transfer.rangeEnd) ||
                transfer.rangeStart < 0 || transfer.rangeEnd <= transfer.rangeStart || transfer.rangeEnd > storedSize)) {
                this.emitUnavailable(asset.id, from, 'invalid-range', transfer, requestId);
                return false;
            }

            this.emitTransferStatus(asset.id, from, 'started', transfer?.transferId, requestId);
            try {
                if (this.cancelledAssets.has(asset.id)) throw new Error('File asset transfer cancelled');
                const unavailableUntil = this.p2pUnavailablePeers.get(from);
                if (unavailableUntil && unavailableUntil > Date.now()) {
                    throw new Error('Peer is in P2P cooldown');
                }
                await this.deps.connectPeer(from);
                if (!await this.deps.waitForDataChannel(from, P2P_TIMEOUT)) {
                    throw new Error('Peer connection timed out');
                }
                const peer = this.deps.getPeer(from);
                if (!peer || peer.connectionState !== 'connected') {
                    throw new Error('Peer connection is not ready');
                }
                const suffix = transfer ? `:${transfer.transferId}` : '';
                channel = peer.createDataChannel(`file-asset:${asset.id}${suffix}`, { ordered: true });
                this.setupChannel(from, asset.id, channel, transfer?.transferId);
                if (!await this.waitForChannel(channel)) {
                    throw new Error('File asset channel timed out');
                }
                await this.sendViaDataChannel(channel, stored, transfer, from, this.transferAttemptId(requestId, 'p2p', transfer));
                this.emitTransferStatus(asset.id, from, 'completed', transfer?.transferId, requestId);
                return true;
            } catch (err) {
                if (channel?._fileAssetRejected) {
                    const routeId = transfer?.transferId ? `${from}:${transfer.transferId}` : from;
                    const rejectedTransport = transfer ? `sending-multi-source:${routeId}` : `sending:${routeId}`;
                    this.deps.onProgress(asset.id, asset.name, 100, rejectedTransport);
                    this.emitTransferStatus(asset.id, from, 'failed', transfer?.transferId, requestId);
                    this.log('send-p2p-rejected', {
                        assetId: asset.id,
                        peerDeviceId: from,
                        transferId: transfer?.transferId,
                        reason: channel._fileAssetRejected,
                        requestId
                    });
                    return false;
                }
                const routeId = transfer?.transferId ? `${from}:${transfer.transferId}` : from;
                const abandonedTransport = transfer ? `sending-multi-source:${routeId}` : `sending:${routeId}`;
                this.deps.onProgress(asset.id, asset.name, 100, abandonedTransport);
                this.p2pUnavailablePeers.set(from, Date.now() + 30000);
                this.log('send-p2p-failed', { assetId: asset.id, peerDeviceId: from, transferId: transfer?.transferId, error: err.message });
                try {
                    await this.sendViaSocketRelay(from, stored, transfer, this.transferAttemptId(requestId, 'relay', transfer));
                    this.emitTransferStatus(asset.id, from, 'completed', transfer?.transferId, requestId);
                    return true;
                } catch (relayErr) {
                    const failedRelayTransport = transfer ? `sending-multi-source-relay:${routeId}` : `sending-relay:${routeId}`;
                    this.deps.onProgress(asset.id, asset.name, 100, failedRelayTransport);
                    this.log('send-relay-failed', { assetId: asset.id, peerDeviceId: from, transferId: transfer?.transferId, error: relayErr.message });
                    this.emitTransferStatus(asset.id, from, 'failed', transfer?.transferId, requestId);
                    this.emitUnavailable(asset.id, from, 'asset-transfer-failed', transfer, requestId);
                    return false;
                }
            }
        }

        emitTransferStatus(assetId, to, status, transferId, requestId = '') {
            const socket = this.socket();
            if (!socket?.connected) return;
            socket.emit('file-asset-transfer-status', {
                sessionId: this.deps.getSessionId(), assetId, to, status, transferId, requestId
            });
        }

        emitUnavailable(assetId, to, reason, transfer, requestId = '') {
            const socket = this.socket();
            if (!socket || !socket.connected) return;
            socket.emit('file-asset-unavailable', {
                sessionId: this.deps.getSessionId(), assetId, to, reason,
                transferId: transfer?.transferId, rangeStart: transfer?.rangeStart, rangeEnd: transfer?.rangeEnd,
                requestId
            });
        }

        setupChannel(deviceId, assetId, channel, transferId = null) {
            channel.binaryType = 'arraybuffer';
            channel._fileAssetMessageQueue = Promise.resolve();
            channel.onmessage = event => {
                channel._fileAssetMessageQueue = channel._fileAssetMessageQueue
                    .then(() => this.handleChannelMessage(deviceId, assetId, event.data, channel, transferId))
                    .catch(err => {
                    if (transferId) this.retryMultiSourceRange(assetId, transferId, deviceId, 'channel-message-failed', err.message);
                    else this.retryDownload(assetId, deviceId, 'channel-message-failed', err.message);
                    this.log('receive-failed', { assetId, transferId, peerDeviceId: deviceId, error: err.message });
                    channel.close();
                });
            };
            channel.onclose = () => {
                const range = transferId ? this.multiSourceTransfers.get(assetId)?.ranges.get(transferId) : null;
                if (range?.active) {
                    const attemptId = channel._fileAssetAttemptId || '';
                    if (attemptId && range.attemptId && range.attemptId !== attemptId) return;
                    this.retryMultiSourceRange(assetId, transferId, deviceId, 'channel-closed');
                } else {
                    const transfer = this.transfers.get(assetId);
                    if (!transfer || transfer.from !== deviceId) return;
                    const attemptId = channel._fileAssetAttemptId || '';
                    if (attemptId && transfer.attemptId && transfer.attemptId !== attemptId) return;
                    this.retryDownload(assetId, deviceId, 'channel-closed');
                }
            };
            channel.onopen = () => this.p2pUnavailablePeers.delete(deviceId);
        }

        handleIncomingChannel(deviceId, channel) {
            const match = /^file-asset:([a-zA-Z0-9-]+)(?::([a-zA-Z0-9_-]+))?$/.exec(channel.label || '');
            if (!match) return false;
            this.setupChannel(deviceId, match[1], channel, match[2] || null);
            return true;
        }

        waitForChannel(channel, timeout = 20000) {
            if (channel.readyState === 'open') return Promise.resolve(true);
            return new Promise(resolve => {
                const timer = setTimeout(() => resolve(false), timeout);
                channel.addEventListener('open', () => { clearTimeout(timer); resolve(true); }, { once: true });
                channel.addEventListener('close', () => { clearTimeout(timer); resolve(false); }, { once: true });
            });
        }

        async waitForBuffer(channel) {
            if (channel.readyState !== 'open') throw new Error('File asset channel closed');
            if (channel.bufferedAmount <= BUFFER_LIMIT) return;
            channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
            const startedAt = Date.now();
            let lastBufferedAmount = channel.bufferedAmount;
            let lastDrainAt = startedAt;
            while (channel.readyState === 'open' && channel.bufferedAmount > BUFFER_LOW_WATER) {
                await new Promise(resolve => {
                    let settled = false;
                    const finish = () => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        channel.removeEventListener('bufferedamountlow', finish);
                        resolve();
                    };
                    const timer = setTimeout(finish, BUFFER_POLL_MS);
                    channel.addEventListener('bufferedamountlow', finish, { once: true });
                });
                const currentBufferedAmount = channel.bufferedAmount;
                const now = Date.now();
                if (currentBufferedAmount < lastBufferedAmount) {
                    lastBufferedAmount = currentBufferedAmount;
                    lastDrainAt = now;
                }
                if (now - startedAt > BUFFER_WAIT_TIMEOUT && currentBufferedAmount > BUFFER_LIMIT * 2) {
                    throw new Error('File asset channel backpressure timeout');
                }
                if (now - lastDrainAt > BUFFER_STALL_TIMEOUT) {
                    throw new Error('File asset channel backpressure stalled');
                }
            }
            if (channel.readyState !== 'open') throw new Error('File asset channel closed');
        }

        async waitForChannelDrain(channel, timeout = 30000) {
            const startedAt = Date.now();
            while (channel.readyState === 'open' && channel.bufferedAmount > 0) {
                if (channel._fileAssetRejected) throw new Error(`File asset receiver rejected: ${channel._fileAssetRejected}`);
                await new Promise(resolve => setTimeout(resolve, BUFFER_POLL_MS));
                if (Date.now() - startedAt > timeout) throw new Error('File asset channel drain timeout');
            }
            if (channel._fileAssetRejected) throw new Error(`File asset receiver rejected: ${channel._fileAssetRejected}`);
            if (channel.readyState !== 'open' && channel.bufferedAmount > 0) {
                throw new Error('File asset channel closed before drain');
            }
        }

        waitForTransferAck(channel, assetId, transferId = '', attemptId = '', timeout = P2P_COMPLETE_ACK_TIMEOUT) {
            return new Promise((resolve, reject) => {
                let settled = false;
                const finish = (err, value) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    channel.removeEventListener('message', onMessage);
                    channel.removeEventListener('close', onClose);
                    if (err) reject(err);
                    else resolve(value);
                };
                const onMessage = event => {
                    if (typeof event.data !== 'string') return;
                    let message;
                    try {
                        message = JSON.parse(event.data);
                    } catch {
                        return;
                    }
                    if (message.type !== 'file-asset-complete-ack' || message.assetId !== assetId) return;
                    if ((message.transferId || '') !== (transferId || '')) return;
                    if (attemptId && message.attemptId && message.attemptId !== attemptId) return;
                    if (message.ok === false) {
                        finish(new Error(message.reason || 'File asset receiver failed to store data'));
                        return;
                    }
                    finish(null, message);
                };
                const onClose = () => finish(new Error('File asset channel closed before receiver acknowledgement'));
                const timer = setTimeout(() => finish(new Error('File asset receiver acknowledgement timed out')), timeout);
                channel.addEventListener('message', onMessage);
                channel.addEventListener('close', onClose, { once: true });
            });
        }

        async sendViaDataChannel(channel, asset, transfer = null, peerDeviceId = '', attemptId = '') {
            const metadata = this.metadata(asset);
            const rangeStart = transfer ? transfer.rangeStart : 0;
            const rangeEnd = transfer ? transfer.rangeEnd : this.dataSize(asset.data);
            const routeId = transfer?.transferId ? `${peerDeviceId}:${transfer.transferId}` : peerDeviceId;
            const transport = transfer ? `sending-multi-source:${routeId}` : `sending:${routeId}`;
            channel.send(JSON.stringify({ type: 'file-asset-start', asset: metadata, transfer, attemptId }));
            for (let offset = rangeStart; offset < rangeEnd; offset += P2P_CHUNK_SIZE) {
                if (this.cancelledAssets.has(asset.id)) throw new Error('File asset transfer cancelled');
                if (channel._fileAssetRejected) throw new Error(`File asset receiver rejected: ${channel._fileAssetRejected}`);
                if (channel.readyState !== 'open') throw new Error('File asset channel closed');
                await this.waitForBuffer(channel);
                if (channel._fileAssetRejected) throw new Error(`File asset receiver rejected: ${channel._fileAssetRejected}`);
                channel.send(this.sliceData(asset.data, offset, Math.min(offset + P2P_CHUNK_SIZE, rangeEnd)));
                const sent = Math.min(rangeEnd, offset + P2P_CHUNK_SIZE) - rangeStart;
                this.deps.onProgress(asset.id, asset.name, Math.min(99, Math.floor(sent * 100 / (rangeEnd - rangeStart))), transport);
            }
            if (channel._fileAssetRejected) throw new Error(`File asset receiver rejected: ${channel._fileAssetRejected}`);
            const receiverAck = this.waitForTransferAck(channel, asset.id, transfer?.transferId || '', attemptId);
            channel.send(JSON.stringify({ type: 'file-asset-complete', assetId: asset.id, transferId: transfer?.transferId, attemptId }));
            await this.waitForChannelDrain(channel);
            await receiverAck;
            this.deps.onProgress(asset.id, asset.name, 100, transport);
            this.log('sent-p2p', { asset: metadata, transfer });
        }

        emitWithAck(eventName, payload, timeout = 15000) {
            const socket = this.socket();
            if (!socket?.connected) return Promise.reject(new Error('Socket is not connected'));
            return new Promise((resolve, reject) => {
                let settled = false;
                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    reject(new Error(`${eventName} acknowledgement timed out`));
                }, timeout);
                socket.emit(eventName, payload, response => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (response?.ok === false) {
                        reject(new Error(response.reason || response.error || `${eventName} rejected`));
                        return;
                    }
                    resolve(response || { ok: true });
                });
            });
        }

        async sendViaSocketRelay(deviceId, asset, transfer = null, attemptId = '') {
            const socket = this.socket();
            if (!socket || !socket.connected) throw new Error('Socket is not connected');
            const metadata = this.metadata(asset);
            const rangeStart = transfer ? transfer.rangeStart : 0;
            const rangeEnd = transfer ? transfer.rangeEnd : this.dataSize(asset.data);
            const routeId = transfer?.transferId ? `${deviceId}:${transfer.transferId}` : deviceId;
            const transport = transfer ? `sending-multi-source-relay:${routeId}` : `sending-relay:${routeId}`;
            const cancelKey = this.uploadCancelKey(asset.id, deviceId, transfer?.transferId || 'full');
            this.rejectedUploadKeys.delete(cancelKey);
            await this.emitWithAck('file-asset-relay-start', {
                sessionId: this.deps.getSessionId(), to: deviceId, asset: metadata,
                transferId: transfer?.transferId, rangeStart: transfer?.rangeStart, rangeEnd: transfer?.rangeEnd,
                attemptId
            }, RELAY_ACK_TIMEOUT);
            for (let offset = rangeStart; offset < rangeEnd; offset += RELAY_CHUNK_SIZE) {
                if (this.cancelledAssets.has(asset.id)) throw new Error('File asset transfer cancelled');
                if (this.rejectedUploadKeys.has(cancelKey)) throw new Error('File asset receiver rejected relay');
                await this.emitWithAck('file-asset-relay-chunk', {
                    sessionId: this.deps.getSessionId(), to: deviceId, assetId: asset.id, transferId: transfer?.transferId,
                    attemptId,
                    chunk: this.sliceData(asset.data, offset, Math.min(offset + RELAY_CHUNK_SIZE, rangeEnd))
                }, RELAY_ACK_TIMEOUT);
                const sent = Math.min(rangeEnd, offset + RELAY_CHUNK_SIZE) - rangeStart;
                this.deps.onProgress(asset.id, asset.name, Math.min(99, Math.floor(sent * 100 / (rangeEnd - rangeStart))), transport);
            }
            if (this.rejectedUploadKeys.has(cancelKey)) throw new Error('File asset receiver rejected relay');
            await this.emitWithAck('file-asset-relay-complete', {
                sessionId: this.deps.getSessionId(), to: deviceId, assetId: asset.id, transferId: transfer?.transferId,
                attemptId
            }, RELAY_COMPLETE_ACK_TIMEOUT);
            this.deps.onProgress(asset.id, asset.name, 100, transport);
            this.log('sent-relay', { asset: metadata, peerDeviceId: deviceId, transfer });
        }

        begin(assetId, asset, deviceId, transport, attemptId = '') {
            if (!asset || asset.id !== assetId || !Number.isFinite(asset.size) || asset.size <= 0) {
                throw new Error('Invalid file asset metadata');
            }
            const existing = this.transfers.get(assetId);
            if (this.isStaleAttempt(existing, attemptId, transport)) {
                this.log('stale-transfer-start-ignored', {
                    assetId,
                    from: deviceId,
                    transport,
                    attemptId,
                    activeAttemptId: existing.attemptId
                });
                return false;
            }
            this.transfers.set(assetId, {
                asset,
                from: deviceId,
                transport,
                attemptId,
                attemptTimestamp: this.attemptTimestamp(attemptId),
                chunks: [],
                receivedSize: 0,
                pendingChunks: Promise.resolve()
            });
            this.resetReceiveTimer(assetId, deviceId);
            this.deps.onProgress(assetId, asset.name, 0, transport === 'p2p' ? 'receiving' : 'receiving-relay');
            this.log('receiving', { asset, peerDeviceId: deviceId, transport, attemptId });
            return true;
        }

        async append(assetId, data, attemptId = '') {
            const transfer = this.transfers.get(assetId);
            if (!transfer) return;
            if (attemptId && transfer.attemptId && transfer.attemptId !== attemptId) {
                this.log('stale-transfer-chunk-ignored', {
                    assetId,
                    attemptId,
                    activeAttemptId: transfer.attemptId,
                    transport: transfer.transport
                });
                return;
            }
            let chunk = data instanceof Blob ? await data.arrayBuffer() : data;
            if (ArrayBuffer.isView(chunk)) chunk = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
            if (!(chunk instanceof ArrayBuffer)) throw new Error('Invalid file asset chunk');
            transfer.chunks.push(chunk);
            transfer.receivedSize += chunk.byteLength;
            this.resetReceiveTimer(assetId, transfer.from);
            if (transfer.receivedSize > transfer.asset.size) {
                this.transfers.delete(assetId);
                throw new Error('File asset exceeded advertised size');
            }
            this.deps.onProgress(assetId, transfer.asset.name, Math.min(99, Math.floor(transfer.receivedSize * 100 / transfer.asset.size)), transfer.transport);
        }

        queueChunk(assetId, data, attemptId = '') {
            const transfer = this.transfers.get(assetId);
            if (!transfer) return Promise.resolve();
            if (attemptId && transfer.attemptId && transfer.attemptId !== attemptId) {
                this.log('stale-transfer-chunk-queued-ignored', {
                    assetId,
                    attemptId,
                    activeAttemptId: transfer.attemptId
                });
                return Promise.resolve();
            }
            transfer.pendingChunks = transfer.pendingChunks.then(() => this.append(assetId, data, attemptId));
            return transfer.pendingChunks;
        }

        async complete(assetId, deviceId, transport, attemptId = '') {
            const transfer = this.transfers.get(assetId);
            if (!transfer || transfer.from !== deviceId) throw new Error('File asset transfer mismatch');
            if (attemptId && transfer.attemptId && transfer.attemptId !== attemptId) {
                this.log('stale-transfer-complete-ignored', {
                    assetId,
                    attemptId,
                    activeAttemptId: transfer.attemptId,
                    transport
                });
                return false;
            }
            await transfer.pendingChunks;
            if (transfer.receivedSize !== transfer.asset.size) throw new Error('File asset size mismatch');
            const merged = new Uint8Array(transfer.receivedSize);
            let offset = 0;
            transfer.chunks.forEach(chunk => { merged.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; });
            const stored = {
                ...transfer.asset,
                sessionId: this.deps.getSessionId(),
                isFileAsset: true,
                data: merged.buffer,
                timestamp: Date.now()
            };
            await this.deps.store(stored);
            this.transfers.delete(assetId);
            this.releaseCompletedDownload(assetId, stored, 'received');
            this.deps.onProgress(assetId, stored.name, 100, 'received');
            await this.announce(stored);
            await this.deps.onReceived(stored);
            this.log('received', { asset: this.metadata(stored), peerDeviceId: deviceId, transport, attemptId });
            return true;
        }

        shouldAcceptIncomingTransfer(assetId, asset, attemptId = '', transferId = '') {
            if (!assetId || !asset?.id || asset.id !== assetId) {
                return { ok: false, reason: 'invalid-asset' };
            }
            if (!this.desiredAssets.has(assetId)) {
                return { ok: false, reason: 'not-requested' };
            }
            const currentRequestId = this.requestIds.get(assetId);
            if (!transferId && currentRequestId && attemptId && !String(attemptId).startsWith(`${currentRequestId}-`)) {
                return { ok: false, reason: 'stale-request' };
            }
            const requestedAt = this.requests.get(assetId) || 0;
            const attemptAt = this.attemptTimestamp(attemptId);
            if (requestedAt && attemptAt && attemptAt < requestedAt - 1000) {
                return { ok: false, reason: 'stale-request' };
            }
            return { ok: true, reason: '' };
        }

        async shouldAcceptIncomingTransferAsync(assetId, asset, attemptId = '', transferId = '') {
            const acceptance = this.shouldAcceptIncomingTransfer(assetId, asset, attemptId, transferId);
            if (!acceptance.ok) return acceptance;
            if (transferId) return acceptance;
            const existing = await this.deps.load(assetId).catch(() => null);
            if (this.hasCompleteCache(existing, asset)) {
                this.releaseCompletedDownload(assetId, asset, 'incoming-already-cached');
                return { ok: false, reason: 'already-cached' };
            }
            return acceptance;
        }

        releaseCompletedDownload(assetId, asset = null, reason = 'completed') {
            this.transfers.delete(assetId);
            this.providerTransfers.delete(assetId);
            this.desiredAssets.delete(assetId);
            this.requestedMetadata.delete(assetId);
            this.requestIds.delete(assetId);
            this.forceRequests.delete(assetId);
            this.priorityDownloads.delete(assetId);
            this.discoveryRequests.delete(assetId);
            this.retryCounts.delete(assetId);
            this.downloadQueue = this.downloadQueue.filter(id => id !== assetId);
            this.releaseDownload(assetId);
            this.log('download-intent-cleared', {
                assetId,
                reason,
                asset: asset ? this.metadata(asset) : undefined
            });
        }

        rejectIncomingChannel(channel, assetId, reason, attemptId = '') {
            this.log('incoming-transfer-rejected', { assetId, reason, attemptId });
            if (channel?.readyState === 'open') {
                try {
                    channel.send(JSON.stringify({ type: 'file-asset-rejected', assetId, reason, attemptId }));
                } catch (err) {
                    this.log('incoming-transfer-reject-send-failed', { assetId, reason, error: err.message });
                }
            }
        }

        async handleChannelMessage(deviceId, assetId, data, channel, transferId = null) {
            if (typeof data !== 'string') {
                if (transferId && this.multiSourceTransfers.has(assetId)) {
                    return this.queueMultiSourceChunk(assetId, transferId, deviceId, data, channel._fileAssetAttemptId || '');
                }
                return this.queueChunk(assetId, data, channel._fileAssetAttemptId || '');
            }
            const message = JSON.parse(data);
            if (message.type === 'file-asset-rejected' && message.assetId === assetId) {
                channel._fileAssetRejected = message.reason || 'receiver-rejected';
                channel.close();
                this.log('outgoing-transfer-rejected', {
                    assetId,
                    transferId,
                    peerDeviceId: deviceId,
                    reason: channel._fileAssetRejected,
                    attemptId: message.attemptId || channel._fileAssetAttemptId || ''
                });
                return;
            }
            if (message.type === 'file-asset-complete-ack' && message.assetId === assetId) {
                return;
            }
            if (message.type === 'file-asset-start') {
                channel._fileAssetAttemptId = message.attemptId || '';
                const acceptance = await this.shouldAcceptIncomingTransferAsync(assetId, message.asset, message.attemptId || '', message.transfer?.transferId || '');
                if (!acceptance.ok) {
                    this.rejectIncomingChannel(channel, assetId, acceptance.reason, message.attemptId || '');
                    setTimeout(() => channel.close(), 50);
                    return;
                }
                if (message.transfer?.transferId) {
                    const started = this.beginMultiSourceRange(assetId, message.asset, deviceId, 'p2p', message.transfer, message.attemptId || '');
                    if (!started) channel.close();
                    return;
                }
                const started = this.begin(assetId, message.asset, deviceId, 'p2p', message.attemptId || '');
                if (!started) channel.close();
                return;
            }
            if (message.type === 'file-asset-complete' && message.assetId === assetId) {
                try {
                    if (message.transferId && this.multiSourceTransfers.has(assetId)) {
                        await this.completeMultiSourceRange(assetId, message.transferId, deviceId, 'p2p', message.attemptId || channel._fileAssetAttemptId || '');
                    } else {
                        await this.complete(assetId, deviceId, 'p2p', message.attemptId || channel._fileAssetAttemptId || '');
                    }
                    if (channel.readyState === 'open') {
                        channel.send(JSON.stringify({
                            type: 'file-asset-complete-ack',
                            assetId,
                            transferId: message.transferId || '',
                            attemptId: message.attemptId || channel._fileAssetAttemptId || '',
                            ok: true
                        }));
                    }
                    setTimeout(() => channel.close(), 50);
                } catch (err) {
                    if (channel.readyState === 'open') {
                        channel.send(JSON.stringify({
                            type: 'file-asset-complete-ack',
                            assetId,
                            transferId: message.transferId || '',
                            attemptId: message.attemptId || channel._fileAssetAttemptId || '',
                            ok: false,
                            reason: err.message
                        }));
                    }
                    throw err;
                }
            }
        }

        relayStartKey(assetId, from, transferId = '') {
            return `${assetId || ''}:${from || ''}:${transferId || 'full'}`;
        }

        async handleRelayStart(data) {
            const { asset, from, transfer } = data || {};
            const key = this.relayStartKey(asset?.id, from, transfer?.transferId);
            const promise = this.processRelayStart(data)
                .finally(() => {
                    if (this.relayStartPromises.get(key) === promise) this.relayStartPromises.delete(key);
                });
            this.relayStartPromises.set(key, promise);
            await promise;
        }

        async waitForRelayStart(assetId, from, transferId = '') {
            const promise = this.relayStartPromises.get(this.relayStartKey(assetId, from, transferId));
            if (promise) await promise.catch(() => {});
        }

        async processRelayStart(data) {
            const { asset, from, transfer, attemptId } = data || {};
            if (!asset || !asset.id || !from) return { ok: false, reason: 'invalid-relay-start' };
            const acceptance = await this.shouldAcceptIncomingTransferAsync(asset.id, asset, attemptId || '', transfer?.transferId || '');
            if (!acceptance.ok) {
                this.log('relay-start-rejected', { assetId: asset.id, peerDeviceId: from, reason: acceptance.reason, attemptId });
                this.emitUnavailable(asset.id, from, `receiver-${acceptance.reason}`, transfer);
                return { ok: false, reason: `receiver-${acceptance.reason}` };
            }
            if (transfer?.transferId) {
                try {
                    const started = this.beginMultiSourceRange(asset.id, asset, from, 'socket-relay', transfer, attemptId || '');
                    return started ? { ok: true } : { ok: false, reason: 'receiver-start-rejected' };
                } catch (err) {
                    this.log('relay-rejected', { assetId: asset.id, transferId: transfer.transferId, error: err.message });
                    return { ok: false, reason: err.message };
                }
            }
            try {
                const started = this.begin(asset.id, asset, from, 'socket-relay', attemptId || '');
                return started ? { ok: true } : { ok: false, reason: 'receiver-start-rejected' };
            } catch (err) {
                this.log('relay-rejected', { assetId: asset.id, error: err.message });
                return { ok: false, reason: err.message };
            }
        }

        async handleRelayChunk(data) {
            const { assetId, chunk, from, transferId, attemptId } = data || {};
            if (!assetId || !chunk) return { ok: false, reason: 'invalid-relay-chunk' };
            await this.waitForRelayStart(assetId, from, transferId || '');
            if (transferId) {
                if (!this.multiSourceTransfers.has(assetId)) return { ok: false, reason: 'receiver-transfer-missing' };
                await this.queueMultiSourceChunk(assetId, transferId, from, chunk, attemptId || '');
                return { ok: true };
            }
            if (!this.transfers.has(assetId)) return { ok: false, reason: 'receiver-transfer-missing' };
            await this.queueChunk(assetId, chunk, attemptId || '');
            return { ok: true };
        }

        async handleRelayComplete(data) {
            const { assetId, from, transferId, attemptId } = data || {};
            if (!assetId || !from) return { ok: false, reason: 'invalid-relay-complete' };
            await this.waitForRelayStart(assetId, from, transferId || '');
            if (transferId) {
                if (!this.multiSourceTransfers.has(assetId)) return { ok: false, reason: 'receiver-transfer-missing' };
                await this.completeMultiSourceRange(assetId, transferId, from, 'socket-relay', attemptId || '');
                return { ok: true };
            }
            if (!this.transfers.has(assetId)) return { ok: false, reason: 'receiver-transfer-missing' };
            await this.complete(assetId, from, 'socket-relay', attemptId || '');
            return { ok: true };
        }

        handleUnavailable(data) {
            const { assetId, reason, from, transferId } = data || {};
            if (!assetId) return;
            if (['receiver-not-requested', 'receiver-stale-request', 'receiver-invalid-asset', 'receiver-already-cached'].includes(reason)) {
                this.rejectedUploadKeys.add(this.uploadCancelKey(assetId, from, transferId || 'full'));
                this.log('upload-rejected-by-receiver', { assetId, peerDeviceId: from, transferId, reason });
                return;
            }
            if (transferId && this.multiSourceTransfers.has(assetId)) {
                this.retryMultiSourceRange(assetId, transferId, from, reason || 'provider-unavailable');
                return;
            }
            const requested = this.desiredAssets.has(assetId);
            const discoveryReasons = ['no-known-provider', 'no-online-provider'];
            if (requested && discoveryReasons.includes(reason)) {
                this.scheduleProviderDiscoveryRetry(assetId, from, reason || 'provider-discovery');
                return;
            }
            const retryable = ['provider-socket-unavailable', 'provider-missing-local-data', 'asset-transfer-failed', 'provider-unavailable'];
            if (requested && retryable.includes(reason)) {
                this.retryDownload(assetId, from, reason || 'provider-unavailable');
                return;
            }
            this.releaseDownload(assetId);
            if (!requested) return;
            this.deps.onUnavailable(assetId, reason);
            this.log('unavailable', { assetId, reason });
        }

        cancel(assetId) {
            if (!assetId) return;
            this.cancelledAssets.add(assetId);
            this.releaseDownload(assetId);
            this.desiredAssets.delete(assetId);
            this.requestedMetadata.delete(assetId);
            this.requestIds.delete(assetId);
            this.forceRequests.delete(assetId);
            this.priorityDownloads.delete(assetId);
            this.providerTransfers.delete(assetId);
            this.discoveryRequests.delete(assetId);
            this.stopMultiSourceWatchdog(this.multiSourceTransfers.get(assetId));
            this.transfers.delete(assetId);
            this.multiSourceTransfers.delete(assetId);
            this.clearRangeTimers(assetId);
            this.downloadQueue = this.downloadQueue.filter(id => id !== assetId);
            this.log('cancelled', { assetId });
        }

        resetReceiveTimer(assetId, providerId) {
            this.clearReceiveTimer(assetId);
            const timer = setTimeout(() => this.retryDownload(assetId, providerId, 'receive-timeout'), RECEIVE_TIMEOUT);
            this.receiveTimers.set(assetId, timer);
        }

        clearReceiveTimer(assetId) {
            const timer = this.receiveTimers.get(assetId);
            if (timer) clearTimeout(timer);
            this.receiveTimers.delete(assetId);
        }

        retryDownload(assetId, providerId, reason, error) {
            if (!this.desiredAssets.has(assetId)) return;
            const attempts = (this.retryCounts.get(assetId) || 0) + 1;
            const interruptedAsset = this.transfers.get(assetId)?.asset || this.requestedMetadata.get(assetId);
            this.retryCounts.set(assetId, attempts);
            this.transfers.delete(assetId);
            this.providerTransfers.delete(assetId);
            this.releaseDownload(assetId);
            if (attempts > MAX_RETRIES) {
                this.markInterruptedAsset(assetId, interruptedAsset, reason);
                this.desiredAssets.delete(assetId);
                this.requestedMetadata.delete(assetId);
                this.requestIds.delete(assetId);
                this.priorityDownloads.delete(assetId);
                this.discoveryRequests.delete(assetId);
                this.deps.onUnavailable(assetId, 'transfer-interrupted');
                this.log('retry-exhausted', { assetId, providerId, reason, error });
                return;
            }
            this.forceRequests.set(assetId, `retry:${assetId}:${attempts}:${Date.now()}`);
            this.priorityDownloads.add(assetId);
            this.log('retry-scheduled', { assetId, providerId, reason, error, attempts });
            setTimeout(() => {
                if (!this.desiredAssets.has(assetId)) return;
                this.desiredAssets.set(assetId, null);
                this.enqueueDownload(assetId);
            }, attempts * 1000);
        }

        resumePending() {
            this.requests.clear();
            this.activeDownloads.clear();
            this.desiredAssets.forEach((_, assetId) => this.enqueueDownload(assetId));
            this.dispatchDownloads();
        }
    }

    global.FileAssetTransfer = FileAssetTransfer;
})(window);
