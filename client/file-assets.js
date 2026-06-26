(function attachFileAssetTransfer(global) {
    const CHUNK_SIZE = 64 * 1024;
    const BUFFER_LIMIT = 512 * 1024;
    const P2P_TIMEOUT = 1500;
    const MAX_CONCURRENT_FULL_DOWNLOADS = 2;
    const MAX_CONCURRENT_MULTI_SOURCE_DOWNLOADS = 4;
    const MAX_CONCURRENT_UPLOADS = 2;
    const RECEIVE_TIMEOUT = 30000;
    const MAX_RETRIES = 3;
    const UPLOAD_COMPLETED_DEDUPE_MS = 5000;
    const MULTI_SOURCE_THRESHOLD = 10 * 1024 * 1024;
    const MULTI_SOURCE_RANGE_SIZE = 2 * 1024 * 1024;
    const MAX_CONCURRENT_RANGES = 4;
    const SMALL_TRANSFER_PRIORITY_SIZE = 1024 * 1024;
    const MULTI_SOURCE_WATCHDOG_INTERVAL = 5000;
    const MULTI_SOURCE_STALL_MS = 12000;

    class FileAssetTransfer {
        constructor(deps) {
            this.deps = deps;
            this.requests = new Map();
            this.desiredAssets = new Map();
            this.transfers = new Map();
            this.p2pUnavailablePeers = new Map();
            this.downloadQueue = [];
            this.activeDownloads = new Set();
            this.uploadQueue = [];
            this.activeUploads = 0;
            this.retryCounts = new Map();
            this.receiveTimers = new Map();
            this.multiSourceTransfers = new Map();
            this.rangeTimers = new Map();
            this.requestedMetadata = new Map();
            this.forceRequests = new Map();
            this.activeUploadKeys = new Set();
            this.activeUploadTasks = new Map();
            this.completedUploadKeys = new Map();
            this.cancelledAssets = new Set();
            this.uploadQueueSeq = 0;
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
            this.cancelledAssets.delete(assetId);
            if (metadata?.id === assetId) this.requestedMetadata.set(assetId, metadata);
            if (this.desiredAssets.has(assetId)) {
                if (preferredProviderId) this.desiredAssets.set(assetId, preferredProviderId);
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
                this.forceRequests.delete(assetId);
                this.log('request-skipped-local-cache', { assetId, size: this.dataSize(local.data) });
                return;
            }
            this.enqueueDownload(assetId);
        }

        enqueueDownload(assetId) {
            if (!this.desiredAssets.has(assetId) || this.activeDownloads.has(assetId) || this.downloadQueue.includes(assetId)) return;
            this.downloadQueue.push(assetId);
            this.deps.onQueue?.(assetId, this.downloadQueue.length, this.activeDownloads.size);
            this.log('download-queued', { assetId, queueLength: this.downloadQueue.length, activeDownloads: this.activeDownloads.size });
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
            return this.activeDownloadCount(mode) < limit;
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
                const requestId = this.forceRequests.get(assetId);
                const needsManifest = Number(metadata?.size) > MULTI_SOURCE_THRESHOLD;
                socket.emit('file-asset-request', {
                    sessionId: this.deps.getSessionId(),
                    assetId,
                    mode: needsManifest ? 'manifest' : undefined,
                    preferredProviderId: this.desiredAssets.get(assetId),
                    force: Boolean(requestId),
                    requestId
                });
                this.log(needsManifest ? 'manifest-requested' : 'requested', {
                    assetId, preferredProviderId: this.desiredAssets.get(assetId), activeDownloads: this.activeDownloads.size,
                    forced: Boolean(requestId)
                });
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
            socket.emit('file-asset-request', {
                sessionId: this.deps.getSessionId(),
                assetId: asset.id,
                preferredProviderId: this.desiredAssets.get(asset.id) || providers[0],
                force: Boolean(requestId),
                requestId
            });
            this.log('requested', { assetId: asset.id, preferredProviderId: this.desiredAssets.get(asset.id) || providers[0], forced: Boolean(requestId) });
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
                    lastActivityAt: 0
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
                transfer.activeRangeIds.add(transferId);
                this.resetRangeTimer(assetId, transferId);
                const retryRequestId = range.retryCount > 0
                    ? `retry:${assetId}:${transferId}:${range.retryCount}:${Date.now()}`
                    : null;
                const requestId = transfer.forceRequestId
                    ? `${transfer.forceRequestId}:${transferId}:${range.retryCount}`
                    : retryRequestId;
                socket.emit('file-asset-request', {
                    sessionId: this.deps.getSessionId(),
                    assetId,
                    preferredProviderId,
                    transferId,
                    rangeStart: range.rangeStart,
                    rangeEnd: range.rangeEnd,
                    force: Boolean(requestId),
                    requestId
                });
                this.log('range-requested', {
                    assetId, transferId, preferredProviderId,
                    rangeStart: range.rangeStart, rangeEnd: range.rangeEnd,
                    forced: Boolean(requestId)
                });
            }
        }

        beginMultiSourceRange(assetId, asset, deviceId, transport, part) {
            const transfer = this.multiSourceTransfers.get(assetId);
            const range = transfer?.ranges.get(part?.transferId);
            if (!transfer || !range || !range.active || range.retryScheduled || range.completed || asset.id !== assetId ||
                part.rangeStart !== range.rangeStart || part.rangeEnd !== range.rangeEnd) {
                throw new Error('Invalid multi-source range metadata');
            }
            range.from = deviceId;
            range.providerId = deviceId;
            range.transport = transport;
            range.receivedSize = 0;
            range.pendingChunks = Promise.resolve();
            range.lastActivityAt = Date.now();
            this.resetRangeTimer(assetId, range.transferId);
            this.log('range-receiving', { assetId, transferId: range.transferId, peerDeviceId: deviceId, transport });
        }

        async appendMultiSourceRange(assetId, transferId, deviceId, data) {
            const transfer = this.multiSourceTransfers.get(assetId);
            const range = transfer?.ranges.get(transferId);
            if (!transfer || !range || range.completed || !range.active || range.retryScheduled || range.from !== deviceId) return;
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

        queueMultiSourceChunk(assetId, transferId, deviceId, data) {
            const transfer = this.multiSourceTransfers.get(assetId);
            const range = transfer?.ranges.get(transferId);
            if (!range) return Promise.resolve();
            range.pendingChunks = range.pendingChunks.then(() => this.appendMultiSourceRange(assetId, transferId, deviceId, data));
            return range.pendingChunks;
        }

        async completeMultiSourceRange(assetId, transferId, deviceId, transport) {
            const transfer = this.multiSourceTransfers.get(assetId);
            const range = transfer?.ranges.get(transferId);
            if (!transfer || !range || range.completed || range.from !== deviceId) throw new Error('Multi-source range mismatch');
            await range.pendingChunks;
            if (range.receivedSize !== range.rangeEnd - range.rangeStart) throw new Error('Multi-source range size mismatch');
            range.completed = true;
            range.active = false;
            this.clearRangeTimer(assetId, transferId);
            transfer.activeRangeIds.delete(transferId);
            transfer.completedBytes += range.receivedSize;
            transfer.lastProgressAt = Date.now();
            this.reportMultiSourceProgress(transfer);
            this.log('range-completed', { assetId, transferId, peerDeviceId: deviceId, transport });

            if (Array.from(transfer.ranges.values()).every(item => item.completed)) {
                await this.completeMultiSourceDownload(assetId, transfer);
            } else {
                this.dispatchMultiSourceRanges(assetId);
            }
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
            this.releaseDownload(assetId);
            this.desiredAssets.delete(assetId);
            this.requestedMetadata.delete(assetId);
            this.forceRequests.delete(assetId);
            this.retryCounts.delete(assetId);
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
                this.forceRequests.delete(assetId);
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
            if (!this.isRangeUpload(data)) return true;
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

        cleanupCompletedUploads() {
            const expiresBefore = Date.now() - UPLOAD_COMPLETED_DEDUPE_MS;
            for (const [key, completedAt] of this.completedUploadKeys) {
                if (completedAt < expiresBefore) this.completedUploadKeys.delete(key);
            }
        }

        async sendRequestedAsset(data) {
            const { asset, from, transfer } = data || {};
            if (!asset || !asset.id || !from) return false;
            const stored = await this.deps.load(asset.id);
            const storedSize = this.dataSize(stored?.data);
            if (!this.hasCompleteCache(stored, asset)) {
                this.emitUnavailable(asset.id, from, 'provider-missing-local-data', transfer);
                return false;
            }
            if (transfer && (!Number.isInteger(transfer.rangeStart) || !Number.isInteger(transfer.rangeEnd) ||
                transfer.rangeStart < 0 || transfer.rangeEnd <= transfer.rangeStart || transfer.rangeEnd > storedSize)) {
                this.emitUnavailable(asset.id, from, 'invalid-range', transfer);
                return false;
            }

            this.emitTransferStatus(asset.id, from, 'started', transfer?.transferId);
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
                const channel = peer.createDataChannel(`file-asset:${asset.id}${suffix}`, { ordered: true });
                this.setupChannel(from, asset.id, channel, transfer?.transferId);
                if (!await this.waitForChannel(channel)) {
                    throw new Error('File asset channel timed out');
                }
                await this.sendViaDataChannel(channel, stored, transfer, from);
                this.emitTransferStatus(asset.id, from, 'completed', transfer?.transferId);
                return true;
            } catch (err) {
                this.p2pUnavailablePeers.set(from, Date.now() + 30000);
                this.log('send-p2p-failed', { assetId: asset.id, peerDeviceId: from, transferId: transfer?.transferId, error: err.message });
                try {
                    await this.sendViaSocketRelay(from, stored, transfer);
                    this.emitTransferStatus(asset.id, from, 'completed', transfer?.transferId);
                    return true;
                } catch (relayErr) {
                    this.log('send-relay-failed', { assetId: asset.id, peerDeviceId: from, transferId: transfer?.transferId, error: relayErr.message });
                    this.emitTransferStatus(asset.id, from, 'failed', transfer?.transferId);
                    this.emitUnavailable(asset.id, from, 'asset-transfer-failed', transfer);
                    return false;
                }
            }
        }

        emitTransferStatus(assetId, to, status, transferId) {
            const socket = this.socket();
            if (!socket?.connected) return;
            socket.emit('file-asset-transfer-status', {
                sessionId: this.deps.getSessionId(), assetId, to, status, transferId
            });
        }

        emitUnavailable(assetId, to, reason, transfer) {
            const socket = this.socket();
            if (!socket || !socket.connected) return;
            socket.emit('file-asset-unavailable', {
                sessionId: this.deps.getSessionId(), assetId, to, reason,
                transferId: transfer?.transferId, rangeStart: transfer?.rangeStart, rangeEnd: transfer?.rangeEnd
            });
        }

        setupChannel(deviceId, assetId, channel, transferId = null) {
            channel.binaryType = 'arraybuffer';
            channel.onmessage = event => this.handleChannelMessage(deviceId, assetId, event.data, channel, transferId)
                .catch(err => {
                    if (transferId) this.retryMultiSourceRange(assetId, transferId, deviceId, 'channel-message-failed', err.message);
                    else this.retryDownload(assetId, deviceId, 'channel-message-failed', err.message);
                    this.log('receive-failed', { assetId, transferId, peerDeviceId: deviceId, error: err.message });
                    channel.close();
                });
            channel.onclose = () => {
                if (transferId && this.multiSourceTransfers.get(assetId)?.ranges.get(transferId)?.active) {
                    this.retryMultiSourceRange(assetId, transferId, deviceId, 'channel-closed');
                } else if (this.transfers.has(assetId)) {
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
            if (channel.bufferedAmount <= BUFFER_LIMIT) return;
            await new Promise(resolve => {
                const timer = setTimeout(resolve, 1000);
                channel.bufferedAmountLowThreshold = BUFFER_LIMIT / 2;
                channel.addEventListener('bufferedamountlow', () => { clearTimeout(timer); resolve(); }, { once: true });
            });
        }

        async sendViaDataChannel(channel, asset, transfer = null, peerDeviceId = '') {
            const metadata = this.metadata(asset);
            const rangeStart = transfer ? transfer.rangeStart : 0;
            const rangeEnd = transfer ? transfer.rangeEnd : this.dataSize(asset.data);
            const routeId = transfer?.transferId ? `${peerDeviceId}:${transfer.transferId}` : peerDeviceId;
            const transport = transfer ? `sending-multi-source:${routeId}` : `sending:${routeId}`;
            channel.send(JSON.stringify({ type: 'file-asset-start', asset: metadata, transfer }));
            for (let offset = rangeStart; offset < rangeEnd; offset += CHUNK_SIZE) {
                if (this.cancelledAssets.has(asset.id)) throw new Error('File asset transfer cancelled');
                if (channel.readyState !== 'open') throw new Error('File asset channel closed');
                await this.waitForBuffer(channel);
                channel.send(this.sliceData(asset.data, offset, Math.min(offset + CHUNK_SIZE, rangeEnd)));
                const sent = Math.min(rangeEnd, offset + CHUNK_SIZE) - rangeStart;
                this.deps.onProgress(asset.id, asset.name, Math.min(99, Math.floor(sent * 100 / (rangeEnd - rangeStart))), transport);
            }
            channel.send(JSON.stringify({ type: 'file-asset-complete', assetId: asset.id, transferId: transfer?.transferId }));
            this.deps.onProgress(asset.id, asset.name, 100, transport);
            this.log('sent-p2p', { asset: metadata, transfer });
        }

        async sendViaSocketRelay(deviceId, asset, transfer = null) {
            const socket = this.socket();
            if (!socket || !socket.connected) throw new Error('Socket is not connected');
            const metadata = this.metadata(asset);
            const rangeStart = transfer ? transfer.rangeStart : 0;
            const rangeEnd = transfer ? transfer.rangeEnd : this.dataSize(asset.data);
            const routeId = transfer?.transferId ? `${deviceId}:${transfer.transferId}` : deviceId;
            const transport = transfer ? `sending-multi-source-relay:${routeId}` : `sending-relay:${routeId}`;
            socket.emit('file-asset-relay-start', {
                sessionId: this.deps.getSessionId(), to: deviceId, asset: metadata,
                transferId: transfer?.transferId, rangeStart: transfer?.rangeStart, rangeEnd: transfer?.rangeEnd
            });
            for (let offset = rangeStart; offset < rangeEnd; offset += CHUNK_SIZE) {
                if (this.cancelledAssets.has(asset.id)) throw new Error('File asset transfer cancelled');
                socket.emit('file-asset-relay-chunk', {
                    sessionId: this.deps.getSessionId(), to: deviceId, assetId: asset.id, transferId: transfer?.transferId,
                    chunk: this.sliceData(asset.data, offset, Math.min(offset + CHUNK_SIZE, rangeEnd))
                });
                const sent = Math.min(rangeEnd, offset + CHUNK_SIZE) - rangeStart;
                this.deps.onProgress(asset.id, asset.name, Math.min(99, Math.floor(sent * 100 / (rangeEnd - rangeStart))), transport);
                await new Promise(resolve => setTimeout(resolve, 1));
            }
            socket.emit('file-asset-relay-complete', {
                sessionId: this.deps.getSessionId(), to: deviceId, assetId: asset.id, transferId: transfer?.transferId
            });
            this.deps.onProgress(asset.id, asset.name, 100, transport);
            this.log('sent-relay', { asset: metadata, peerDeviceId: deviceId, transfer });
        }

        begin(assetId, asset, deviceId, transport) {
            if (!asset || asset.id !== assetId || !Number.isFinite(asset.size) || asset.size <= 0) {
                throw new Error('Invalid file asset metadata');
            }
            this.transfers.set(assetId, {
                asset, from: deviceId, transport, chunks: [], receivedSize: 0, pendingChunks: Promise.resolve()
            });
            this.resetReceiveTimer(assetId, deviceId);
            this.deps.onProgress(assetId, asset.name, 0, transport === 'p2p' ? 'receiving' : 'receiving-relay');
            this.log('receiving', { asset, peerDeviceId: deviceId, transport });
        }

        async append(assetId, data) {
            const transfer = this.transfers.get(assetId);
            if (!transfer) return;
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

        queueChunk(assetId, data) {
            const transfer = this.transfers.get(assetId);
            if (!transfer) return Promise.resolve();
            transfer.pendingChunks = transfer.pendingChunks.then(() => this.append(assetId, data));
            return transfer.pendingChunks;
        }

        async complete(assetId, deviceId, transport) {
            const transfer = this.transfers.get(assetId);
            if (!transfer || transfer.from !== deviceId) throw new Error('File asset transfer mismatch');
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
            this.releaseDownload(assetId);
            this.desiredAssets.delete(assetId);
            this.requestedMetadata.delete(assetId);
            this.forceRequests.delete(assetId);
            this.retryCounts.delete(assetId);
            this.deps.onProgress(assetId, stored.name, 100, 'received');
            await this.announce(stored);
            await this.deps.onReceived(stored);
            this.log('received', { asset: this.metadata(stored), peerDeviceId: deviceId, transport });
        }

        async handleChannelMessage(deviceId, assetId, data, channel, transferId = null) {
            if (typeof data !== 'string') {
                if (transferId && this.multiSourceTransfers.has(assetId)) {
                    return this.queueMultiSourceChunk(assetId, transferId, deviceId, data);
                }
                return this.queueChunk(assetId, data);
            }
            const message = JSON.parse(data);
            if (message.type === 'file-asset-start') {
                if (message.transfer?.transferId) return this.beginMultiSourceRange(assetId, message.asset, deviceId, 'p2p', message.transfer);
                return this.begin(assetId, message.asset, deviceId, 'p2p');
            }
            if (message.type === 'file-asset-complete' && message.assetId === assetId) {
                if (message.transferId && this.multiSourceTransfers.has(assetId)) {
                    await this.completeMultiSourceRange(assetId, message.transferId, deviceId, 'p2p');
                    channel.close();
                    return;
                }
                await this.complete(assetId, deviceId, 'p2p');
                channel.close();
            }
        }

        handleRelayStart(data) {
            const { asset, from, transfer } = data || {};
            if (!asset || !asset.id || !from) return;
            if (transfer?.transferId) {
                try { this.beginMultiSourceRange(asset.id, asset, from, 'socket-relay', transfer); } catch (err) { this.log('relay-rejected', { assetId: asset.id, transferId: transfer.transferId, error: err.message }); }
                return;
            }
            try { this.begin(asset.id, asset, from, 'socket-relay'); } catch (err) { this.log('relay-rejected', { assetId: asset.id, error: err.message }); }
        }

        handleRelayChunk(data) {
            const { assetId, chunk, from, transferId } = data || {};
            if (!assetId || !chunk) return;
            const operation = transferId && this.multiSourceTransfers.has(assetId)
                ? this.queueMultiSourceChunk(assetId, transferId, from, chunk)
                : this.queueChunk(assetId, chunk);
            operation.catch(err => this.log('relay-failed', { assetId, transferId, error: err.message }));
        }

        handleRelayComplete(data) {
            const { assetId, from, transferId } = data || {};
            if (!assetId || !from) return;
            const operation = transferId && this.multiSourceTransfers.has(assetId)
                ? this.completeMultiSourceRange(assetId, transferId, from, 'socket-relay')
                : this.complete(assetId, from, 'socket-relay');
            operation.catch(err => {
                if (transferId) this.retryMultiSourceRange(assetId, transferId, from, 'relay-complete-failed', err.message);
                this.log('relay-failed', { assetId, transferId, error: err.message });
            });
        }

        handleUnavailable(data) {
            const { assetId, reason, from, transferId } = data || {};
            if (!assetId) return;
            if (transferId && this.multiSourceTransfers.has(assetId)) {
                this.retryMultiSourceRange(assetId, transferId, from, reason || 'provider-unavailable');
                return;
            }
            const requested = this.desiredAssets.has(assetId);
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
            this.forceRequests.delete(assetId);
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
            this.releaseDownload(assetId);
            if (attempts > MAX_RETRIES) {
                this.markInterruptedAsset(assetId, interruptedAsset, reason);
                this.desiredAssets.delete(assetId);
                this.requestedMetadata.delete(assetId);
                this.deps.onUnavailable(assetId, 'transfer-interrupted');
                this.log('retry-exhausted', { assetId, providerId, reason, error });
                return;
            }
            this.forceRequests.set(assetId, `retry:${assetId}:${attempts}:${Date.now()}`);
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
