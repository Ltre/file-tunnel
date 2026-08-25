const MAX_FILE_ASSET_SIZE = 1024 * 1024 * 1024;
const MAX_FILE_ASSETS_PER_SESSION = 500;
const MAX_RELAY_CHUNK_SIZE = 256 * 1024;
const MAX_FILE_ASSET_RANGE_SIZE = 4 * 1024 * 1024;
const relays = new Map();
const RELAY_TARGET_ACK_TIMEOUT = 30000;
const RELAY_COMPLETE_ACK_TIMEOUT = 60000;
const LARGE_FILE_ASSET_SIZE = 15 * 1024 * 1024;
const RECEIVER_MAX_ACTIVE_ASSETS = 5;
const RECEIVER_MAX_ACTIVE_LARGE_ASSETS = 3;
const ASSIGNMENT_PENDING_STALE_MS = 45000;
const ASSIGNMENT_ACTIVE_STALE_MS = 10 * 60 * 1000;

function isValidFileAsset(asset, isValidAssetId) {
    return asset &&
        isValidAssetId(asset.id) &&
        typeof asset.name === 'string' && asset.name.length > 0 && asset.name.length <= 255 &&
        typeof asset.type === 'string' && asset.type.length <= 100 &&
        typeof asset.size === 'number' && asset.size > 0 && asset.size <= MAX_FILE_ASSET_SIZE;
}

function binarySize(value) {
    if (Buffer.isBuffer(value)) return value.length;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    return -1;
}

function relayKey(sessionId, from, to, assetId, transferId = 'full') {
    return `${sessionId}:${from}:${to}:${assetId}:${transferId}`;
}

function relayTransferToken(transferId, attemptId = '') {
    if (transferId) return attemptId ? `${transferId}:${attemptId}` : transferId;
    return attemptId || 'full';
}

function isValidTransferId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

function normalizeTransfer(data, asset) {
    if (!data?.transferId && data?.rangeStart === undefined && data?.rangeEnd === undefined) return null;
    const { transferId, rangeStart, rangeEnd } = data || {};
    if (!isValidTransferId(transferId) || !Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) ||
        rangeStart < 0 || rangeEnd <= rangeStart || rangeEnd > asset.size || rangeEnd - rangeStart > MAX_FILE_ASSET_RANGE_SIZE) {
        return null;
    }
    return { transferId, rangeStart, rangeEnd };
}

function deviceFreshness(session, deviceId) {
    const device = session?.devices?.get(deviceId);
    const seenAt = Number(device?.lastSeenAt || device?.joinedAt || 0);
    return Number.isFinite(seenAt) ? seenAt : 0;
}

function sortProviders(session, record, candidates) {
    return candidates.slice().sort((a, b) => {
        const loadDiff = (record.providerLoads?.get(a) || 0) - (record.providerLoads?.get(b) || 0);
        if (loadDiff !== 0) return loadDiff;
        return deviceFreshness(session, b) - deviceFreshness(session, a);
    });
}

function freshProviderCandidates(session, candidates) {
    const now = Date.now();
    const fresh = candidates.filter(id => {
        const seenAt = deviceFreshness(session, id);
        return !seenAt || now - seenAt <= 60000;
    });
    return fresh.length ? fresh : candidates;
}

function findProvider(session, assetId, requesterId, preferredProviderId, deviceSockets) {
    const record = session.fileAssets && session.fileAssets.get(assetId);
    if (!record) return null;
    const providers = Array.from(record.providers);
    const candidates = providers.filter(id => id !== requesterId && session.devices.has(id) && (!deviceSockets || deviceSockets.has(id)));
    const pool = sortProviders(session, record, freshProviderCandidates(session, candidates));
    const preferred = pool.find(id => id === preferredProviderId);
    if (preferred && (record.providerLoads?.get(preferred) || 0) === 0) return preferred;
    return pool[0] || null;
}

function assignmentKey(assetId, requesterId, transferId = 'full') {
    return `${assetId}:${requesterId}:${transferId}`;
}

function getAssignmentMeta(record, assetId, requesterId, transferId = 'full') {
    return record?.assignmentMeta?.get(assignmentKey(assetId, requesterId, transferId));
}

function setAssignment(record, assetId, requesterId, transferId, providerId, requestId = '') {
    if (!record.assignments) record.assignments = new Map();
    if (!record.providerLoads) record.providerLoads = new Map();
    if (!record.assignmentMeta) record.assignmentMeta = new Map();
    const key = assignmentKey(assetId, requesterId, transferId);
    record.assignments.set(key, providerId);
    record.assignmentMeta.set(key, {
        providerId,
        assignedAt: Date.now(),
        updatedAt: Date.now(),
        status: 'assigned',
        requestId: requestId || ''
    });
    record.providerLoads.set(providerId, (record.providerLoads.get(providerId) || 0) + 1);
}

function releaseAssignment(record, assetId, requesterId, transferId = 'full') {
    if (!record?.assignments || !record.providerLoads) return;
    const key = assignmentKey(assetId, requesterId, transferId);
    const providerId = record.assignments.get(key);
    if (!providerId) return;
    record.assignments.delete(key);
    record.assignmentMeta?.delete(key);
    const nextLoad = Math.max(0, (record.providerLoads.get(providerId) || 1) - 1);
    if (nextLoad === 0) record.providerLoads.delete(providerId);
    else record.providerLoads.set(providerId, nextLoad);
}

function cleanupStaleAssignments(session) {
    if (!session?.fileAssets) return;
    const now = Date.now();
    for (const [assetId, record] of session.fileAssets) {
        if (!record?.assignments) continue;
        for (const key of Array.from(record.assignments.keys())) {
            const meta = record.assignmentMeta?.get(key);
            const staleAfter = ['started', 'active'].includes(meta?.status)
                ? ASSIGNMENT_ACTIVE_STALE_MS
                : ASSIGNMENT_PENDING_STALE_MS;
            const touchedAt = Number(meta?.updatedAt || meta?.assignedAt || 0);
            if (touchedAt && now - touchedAt <= staleAfter) continue;
            const parts = key.split(':');
            const requesterId = parts[1];
            const transferId = parts.slice(2).join(':') || 'full';
            releaseAssignment(record, assetId, requesterId, transferId);
        }
    }
}

function getReceiverLoad(session, requesterId, currentAssetId = '') {
    cleanupStaleAssignments(session);
    const activeAssets = new Set();
    const activeLargeAssets = new Set();
    if (!session?.fileAssets) return { activeAssets, activeLargeAssets };
    for (const [assetId, record] of session.fileAssets) {
        if (!record?.assignments) continue;
        for (const key of record.assignments.keys()) {
            const parts = key.split(':');
            if (parts[1] !== requesterId) continue;
            activeAssets.add(assetId);
            if (Number(record.metadata?.size) >= LARGE_FILE_ASSET_SIZE) activeLargeAssets.add(assetId);
        }
    }
    activeAssets.delete(currentAssetId);
    activeLargeAssets.delete(currentAssetId);
    return { activeAssets, activeLargeAssets };
}

function shouldDeferReceiverTask(session, requesterId, record, currentAssetId) {
    const load = getReceiverLoad(session, requesterId, currentAssetId);
    const isLarge = Number(record?.metadata?.size) >= LARGE_FILE_ASSET_SIZE;
    if (isLarge && load.activeLargeAssets.size >= RECEIVER_MAX_ACTIVE_LARGE_ASSETS) {
        return { defer: true, reason: 'large-active-limit', activeAssets: load.activeAssets.size, activeLargeAssets: load.activeLargeAssets.size };
    }
    if (load.activeAssets.size >= RECEIVER_MAX_ACTIVE_ASSETS) {
        return { defer: true, reason: 'receiver-active-limit', activeAssets: load.activeAssets.size, activeLargeAssets: load.activeLargeAssets.size };
    }
    return { defer: false, activeAssets: load.activeAssets.size, activeLargeAssets: load.activeLargeAssets.size };
}

function ackOk(ack, payload = {}) {
    if (typeof ack === 'function') ack({ ok: true, ...payload });
}

function ackFail(ack, reason, payload = {}) {
    if (typeof ack === 'function') ack({ ok: false, reason: String(reason || 'relay-failed').slice(0, 120), ...payload });
}

function emitWithAck(socket, eventName, payload, timeout = RELAY_TARGET_ACK_TIMEOUT) {
    return new Promise((resolve, reject) => {
        socket.timeout(timeout).emit(eventName, payload, (err, response) => {
            if (err) {
                reject(new Error(err.message || `${eventName} acknowledgement timed out`));
                return;
            }
            if (response?.ok === false) {
                reject(new Error(response.reason || response.error || `${eventName} rejected`));
                return;
            }
            resolve(response || { ok: true });
        });
    });
}

function emitWithAckResult(socket, eventName, payload, timeout = RELAY_TARGET_ACK_TIMEOUT) {
    return new Promise((resolve, reject) => {
        socket.timeout(timeout).emit(eventName, payload, (err, response) => {
            if (err) {
                reject(new Error(err.message || `${eventName} acknowledgement timed out`));
                return;
            }
            resolve(response || { ok: true });
        });
    });
}

function isRelayAckTimeout(reason) {
    const value = String(reason || '').toLowerCase();
    return value.includes('timed out') || value.includes('timeout') || value.includes('acknowledgement');
}

function registerFileAssetHandlers(socket, context) {
    const { sessions, deviceSockets, getSessionId, getDeviceId, sanitize, historyLog, clientIp } = context;
    const recordFileAsset = typeof context.recordFileAsset === 'function' ? context.recordFileAsset : null;
    const recordTransferEvent = typeof context.recordTransferEvent === 'function' ? context.recordTransferEvent : null;
    const enqueueAudit = typeof context.enqueueAudit === 'function' ? context.enqueueAudit : null;
    const enqueueAuditTask = task => {
        if (!enqueueAudit || typeof task !== 'function') return;
        try {
            // The server queue owns execution, retries and error reporting. Do not
            // swallow a task failure here or the audit entry could be lost silently.
            const queued = enqueueAudit(task);
            if (queued && typeof queued.catch === 'function') {
                queued.catch(err => console.error('file asset audit enqueue error:', err));
            }
        } catch (err) {
            console.error('file asset audit enqueue error:', err);
        }
    };
    const isValidAssetId = context.isValidAssetId || context.isValidId;
    const isValidDeviceId = context.isValidDeviceId || context.isValidId;
    const isValidSessionId = context.isValidSessionId || context.isValidId;
    const translateText = typeof context.translateText === 'function' ? context.translateText : text => text;
    const current = () => ({ sessionId: getSessionId(), deviceId: getDeviceId() });

    socket.on('file-asset-available', data => {
        try {
            const { sessionId, asset } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidFileAsset(asset, isValidAssetId)) return;
            const session = sessions.get(sessionId);
            if (!session || !session.devices.has(deviceId)) return;
            if (!session.fileAssets) session.fileAssets = new Map();

            let record = session.fileAssets.get(asset.id);
            const isNewRecord = !record;
            if (!record) {
                if (session.fileAssets.size >= MAX_FILE_ASSETS_PER_SESSION) {
                    socket.emit('error', { message: translateText('会话文件数量已达上限'), code: 'FILE_ASSET_LIMIT_REACHED' });
                    return;
                }
                record = {
                    metadata: {
                        id: asset.id,
                        name: sanitize(asset.name, 255),
                        type: sanitize(asset.type, 100),
                        size: asset.size,
                        ownerDeviceId: isValidDeviceId(asset.ownerDeviceId) ? asset.ownerDeviceId : deviceId,
                        isFolderArchive: asset.isFolderArchive === true,
                        isDirectoryMirror: asset.isDirectoryMirror === true,
                        folderName: typeof asset.folderName === 'string' ? sanitize(asset.folderName, 120) : undefined,
                        entryCount: Number.isInteger(asset.entryCount) ? asset.entryCount : undefined
                    },
                    providers: new Set(),
                    providerLoads: new Map(),
                    assignments: new Map(),
                    assignmentMeta: new Map()
                };
                session.fileAssets.set(asset.id, record);
            }
            record.providers.add(deviceId);
            session.lastActivity = Date.now();
            socket.to(sessionId).emit('file-asset-available', { asset: record.metadata, from: deviceId });
            historyLog('file-asset-available', {
                sessionId, deviceId, socketId: socket.id, clientIp, asset: record.metadata,
                providerCount: record.providers.size, providerDeviceIds: Array.from(record.providers)
            });
            // Presence is renewed in bulk by clients. Persist metadata only for a
            // newly discovered asset; a heartbeat is not an append-only transfer.
            if (isNewRecord && recordFileAsset) {
                const auditMetadata = { ...record.metadata };
                const auditNow = session.lastActivity;
                enqueueAuditTask(() => recordFileAsset(sessionId, auditMetadata, {
                    sourceDeviceId: deviceId,
                    now: auditNow
                }));
            }
        } catch (err) {
            console.error('file-asset-available error:', err);
        }
    });

    socket.on('file-asset-request', data => {
        try {
            const { sessionId, sourceSessionId, assetId, preferredProviderId, mode } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidAssetId(assetId)) return;
            const requesterSession = sessions.get(sessionId);
            if (!requesterSession || !requesterSession.devices.has(deviceId)) return;
            const assetSessionId = sourceSessionId && isValidSessionId(sourceSessionId) ? sourceSessionId : sessionId;
            const session = sessions.get(assetSessionId);
            const record = session?.fileAssets?.get(assetId);
            if (!record) {
                socket.to(assetSessionId).emit('file-asset-discovery', {
                    assetId,
                    from: deviceId,
                    reason: 'no-known-provider'
                });
                socket.emit('file-asset-unavailable', { assetId, reason: 'no-known-provider' });
                return;
            }

            if (mode === 'manifest') {
                const candidates = Array.from(record.providers)
                    .filter(id => id !== deviceId && session.devices.has(id) && deviceSockets.has(id))
                const providers = sortProviders(session, record, freshProviderCandidates(session, candidates));
                socket.emit('file-asset-manifest', { asset: record.metadata, providers });
                historyLog('file-asset-manifest-sent', {
                    sessionId, sourceSessionId: assetSessionId, deviceId, socketId: socket.id, clientIp,
                    asset: record.metadata, providers
                });
                return;
            }

            const hasTransferFields = data?.transferId || data?.rangeStart !== undefined || data?.rangeEnd !== undefined;
            const transfer = normalizeTransfer(data, record.metadata);
            if (hasTransferFields && !transfer) return;
            if (!record.providerLoads) record.providerLoads = new Map();
            if (!record.assignments) record.assignments = new Map();
            if (!record.assignmentMeta) record.assignmentMeta = new Map();
            const forced = data?.force === true;
            const transportHint = socket.data?.isVClient === true && data?.relayOnly === true
                ? 'relay-only'
                : undefined;
            const requestId = typeof data?.requestId === 'string' && data.requestId.length <= 120
                ? sanitize(data.requestId, 120)
                : undefined;
            const existingProviderId = record.assignments.get(assignmentKey(assetId, deviceId, transfer?.transferId));
            const existingMeta = getAssignmentMeta(record, assetId, deviceId, transfer?.transferId);
            const existingTouchedAt = Number(existingMeta?.updatedAt || existingMeta?.assignedAt || 0);
            const existingAge = existingTouchedAt ? Date.now() - existingTouchedAt : 0;
            const existingStaleAfter = ['started', 'active'].includes(existingMeta?.status)
                ? ASSIGNMENT_ACTIVE_STALE_MS
                : ASSIGNMENT_PENDING_STALE_MS;
            if (existingProviderId && session.devices.has(existingProviderId) && deviceSockets.has(existingProviderId) &&
                (!existingAge || existingAge <= existingStaleAfter) &&
                ((!requestId && !existingMeta?.requestId) || requestId === existingMeta?.requestId)) {
                historyLog('file-asset-request-ignored-duplicate', {
                    sessionId, deviceId, targetDeviceId: existingProviderId, socketId: socket.id, clientIp,
                    assetId, transfer, forced, requestId, existingRequestId: existingMeta?.requestId || '',
                    existingAge
                });
                return;
            }
            if (existingProviderId) releaseAssignment(record, assetId, deviceId, transfer?.transferId);
            const receiverLimit = shouldDeferReceiverTask(session, deviceId, record, assetId);
            if (receiverLimit.defer) {
                socket.emit('file-asset-unavailable', {
                    assetId,
                    transferId: transfer?.transferId,
                    reason: 'receiver-backpressure',
                    retryAfterMs: 3000
                });
                historyLog('file-asset-request-deferred-receiver-backpressure', {
                    sessionId, sourceSessionId: assetSessionId, deviceId, socketId: socket.id, clientIp,
                    assetId, transfer, forced, requestId,
                    limitReason: receiverLimit.reason,
                    activeAssets: receiverLimit.activeAssets,
                    activeLargeAssets: receiverLimit.activeLargeAssets
                });
                return;
            }
            const providerId = findProvider(session, assetId, deviceId, preferredProviderId, deviceSockets);
            if (!providerId) {
                releaseAssignment(record, assetId, deviceId, transfer?.transferId);
                socket.to(assetSessionId).emit('file-asset-discovery', {
                    assetId,
                    from: deviceId,
                    reason: 'no-online-provider'
                });
                socket.emit('file-asset-unavailable', { assetId, transferId: transfer?.transferId, reason: 'no-online-provider' });
                historyLog('file-asset-request-unavailable', {
                    sessionId, sourceSessionId: assetSessionId, deviceId, socketId: socket.id, clientIp,
                    assetId, preferredProviderId,
                    transfer, knownProviderDeviceIds: Array.from(record.providers || [])
                });
                return;
            }
            const providerSocket = deviceSockets.get(providerId);
            if (!providerSocket || !record) {
                if (record) {
                    releaseAssignment(record, assetId, deviceId, transfer?.transferId);
                    record.providers.delete(providerId);
                }
                socket.emit('file-asset-unavailable', { assetId, transferId: transfer?.transferId, reason: 'provider-socket-unavailable' });
                historyLog('file-asset-provider-socket-missing', {
                    sessionId, sourceSessionId: assetSessionId, deviceId, targetDeviceId: providerId,
                    socketId: socket.id, clientIp, assetId, transfer
                });
                return;
            }
            releaseAssignment(record, assetId, deviceId, transfer?.transferId);
            setAssignment(record, assetId, deviceId, transfer?.transferId, providerId, requestId);
            const assignmentMeta = getAssignmentMeta(record, assetId, deviceId, transfer?.transferId);
            if (assignmentMeta) {
                assignmentMeta.transportHint = transportHint;
                assignmentMeta.rangeStart = transfer?.rangeStart;
                assignmentMeta.rangeEnd = transfer?.rangeEnd;
            }
            providerSocket.emit('file-asset-request', {
                asset: record.metadata,
                from: deviceId,
                transfer,
                requestId,
                transportHint
            });
            historyLog('file-asset-request-forwarded', {
                sessionId, sourceSessionId: assetSessionId, deviceId, targetDeviceId: providerId,
                socketId: socket.id, clientIp, asset: record.metadata,
                transfer, knownProviderDeviceIds: Array.from(record.providers),
                providerLoads: Object.fromEntries(record.providerLoads),
                forced,
                requestId
            });
            if (recordTransferEvent) {
                const auditMetadata = { ...record.metadata };
                const requestAudit = {
                    sourceDeviceId: providerId,
                    targetDeviceId: deviceId,
                    transferId: transfer?.transferId,
                    requestId,
                    now: Date.now(),
                    transport: transportHint || 'negotiated-client-path',
                    details: {
                        sourceSessionId: assetSessionId,
                        requesterSessionId: sessionId,
                        rangeStart: transfer?.rangeStart,
                        rangeEnd: transfer?.rangeEnd
                    }
                };
                enqueueAuditTask(() => {
                    recordTransferEvent(sessionId, 'requested', auditMetadata, requestAudit);
                    if (assetSessionId !== sessionId) {
                        recordTransferEvent(assetSessionId, 'requested', auditMetadata, requestAudit);
                    }
                });
            }
        } catch (err) {
            console.error('file-asset-request error:', err);
        }
    });

    socket.on('file-asset-unavailable', data => {
        try {
            const { sessionId, assetId, to, reason, transferId, rangeStart, rangeEnd } = data || {};
            const requestId = typeof data?.requestId === 'string' && data.requestId.length <= 120
                ? sanitize(data.requestId, 120)
                : undefined;
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidAssetId(assetId) || !isValidDeviceId(to)) return;
            const session = sessions.get(sessionId);
            const record = session?.fileAssets?.get(assetId);
            const transfer = normalizeTransfer({ transferId, rangeStart, rangeEnd }, record?.metadata || {});
            if ((transferId || rangeStart !== undefined || rangeEnd !== undefined) && !transfer) return;
            const receiverRejected = typeof reason === 'string' && reason.startsWith('receiver-');
            if (record && receiverRejected) {
                const activeRequestId = getAssignmentMeta(record, assetId, to, transfer?.transferId)?.requestId;
                if (!requestId || !activeRequestId || requestId === activeRequestId) {
                    releaseAssignment(record, assetId, to, transfer?.transferId);
                    cleanupFileAssetRelay(sessionId, deviceId, to, assetId, transfer?.transferId);
                    historyLog('file-asset-receiver-rejected', {
                        sessionId, deviceId, targetDeviceId: to, socketId: socket.id, clientIp, assetId,
                        transfer, reason: sanitize(reason, 80), requestId
                    });
                }
            }
            if (record && reason === 'provider-missing-local-data') {
                const previousMeta = getAssignmentMeta(record, assetId, to, transfer?.transferId);
                const transportHint = previousMeta?.transportHint;
                releaseAssignment(record, assetId, to, transfer?.transferId);
                record.providers.delete(deviceId);
                const alternative = findProvider(session, assetId, to, null, deviceSockets);
                const alternativeSocket = alternative && deviceSockets.get(alternative);
                historyLog('file-asset-provider-removed', {
                    sessionId, deviceId, targetDeviceId: to, socketId: socket.id, clientIp, assetId,
                    alternativeProviderId: alternative, remainingProviderDeviceIds: Array.from(record.providers)
                });
                if (alternativeSocket) {
                    if (!record.assignments) record.assignments = new Map();
                    if (!record.providerLoads) record.providerLoads = new Map();
                    if (!record.assignmentMeta) record.assignmentMeta = new Map();
                    setAssignment(record, assetId, to, transfer?.transferId, alternative, requestId);
                    const nextMeta = getAssignmentMeta(record, assetId, to, transfer?.transferId);
                    if (nextMeta) {
                        nextMeta.transportHint = transportHint;
                        nextMeta.rangeStart = transfer?.rangeStart;
                        nextMeta.rangeEnd = transfer?.rangeEnd;
                    }
                    alternativeSocket.emit('file-asset-request', {
                        asset: record.metadata,
                        from: to,
                        transfer,
                        requestId,
                        transportHint
                    });
                    return;
                }
            }
            const target = deviceSockets.get(to);
            if (target) target.emit('file-asset-unavailable', {
                assetId, from: deviceId, transferId: transfer?.transferId,
                rangeStart: transfer?.rangeStart, rangeEnd: transfer?.rangeEnd,
                reason: sanitize(reason || 'provider-unavailable', 80),
                requestId
            });
        } catch (err) {
            console.error('file-asset-unavailable error:', err);
        }
    });

    socket.on('file-asset-discovery', data => {
        try {
            const { sessionId, sourceSessionId, assetId, reason } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidAssetId(assetId)) return;
            const requesterSession = sessions.get(sessionId);
            if (!requesterSession || !requesterSession.devices.has(deviceId)) return;
            const assetSessionId = sourceSessionId && isValidSessionId(sourceSessionId) ? sourceSessionId : sessionId;
            if (!sessions.has(assetSessionId)) return;
            socket.to(assetSessionId).emit('file-asset-discovery', {
                assetId,
                from: deviceId,
                reason: sanitize(reason || 'provider-discovery', 80)
            });
            historyLog('file-asset-discovery', {
                sessionId, sourceSessionId: assetSessionId, deviceId, socketId: socket.id, clientIp, assetId,
                reason: sanitize(reason || 'provider-discovery', 80)
            });
        } catch (err) {
            console.error('file-asset-discovery error:', err);
        }
    });

    socket.on('file-asset-transfer-status', data => {
        try {
            const { sessionId, assetId, to, status, transferId } = data || {};
            const requestId = typeof data?.requestId === 'string' && data.requestId.length <= 120
                ? sanitize(data.requestId, 120)
                : undefined;
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidAssetId(assetId) || !isValidDeviceId(to) ||
                (transferId !== undefined && !isValidTransferId(transferId)) ||
                !['started', 'completed', 'failed'].includes(status)) return;
            const record = sessions.get(sessionId)?.fileAssets?.get(assetId);
            if (!record?.assignments) return;
            const assignedProvider = record.assignments.get(assignmentKey(assetId, to, transferId));
            if (assignedProvider !== deviceId) return;
            const meta = getAssignmentMeta(record, assetId, to, transferId);
            if (requestId && meta?.requestId && requestId !== meta.requestId) {
                historyLog('file-asset-transfer-status-ignored-stale', {
                    sessionId,
                    deviceId,
                    targetDeviceId: to,
                    socketId: socket.id,
                    clientIp,
                    assetId,
                    transferId,
                    status,
                    requestId,
                    activeRequestId: meta.requestId
                });
                return;
            }
            if (meta) {
                meta.updatedAt = Date.now();
                meta.status = status;
                if (requestId) meta.requestId = requestId;
            }
            if (status === 'completed' || status === 'failed') releaseAssignment(record, assetId, to, transferId);
            const targetSocket = deviceSockets.get(to);
            if (targetSocket) {
                targetSocket.emit('file-asset-transfer-status', {
                    assetId,
                    from: deviceId,
                    transferId,
                    status,
                    requestId
                });
            }
            historyLog('file-asset-transfer-status', {
                sessionId, deviceId, targetDeviceId: to, socketId: socket.id, clientIp, assetId, transferId, status, requestId,
                providerLoads: Object.fromEntries(record.providerLoads || [])
            });
            if ((status === 'completed' || status === 'failed') && recordTransferEvent) {
                const auditMetadata = { ...record.metadata };
                const auditMeta = meta ? { ...meta } : null;
                const auditNow = Date.now();
                enqueueAuditTask(() => recordTransferEvent(
                    sessionId,
                    status === 'completed' ? 'client-completed' : 'failed',
                    auditMetadata,
                    {
                        sourceDeviceId: deviceId,
                        targetDeviceId: to,
                        transferId,
                        requestId: requestId || auditMeta?.requestId || '',
                        now: auditNow,
                        transport: auditMeta?.transportHint || 'client-reported-path',
                        bytesTransferred: status === 'completed'
                            ? (transferId && auditMeta?.rangeEnd > auditMeta?.rangeStart
                                ? auditMeta.rangeEnd - auditMeta.rangeStart
                                : auditMetadata.size)
                            : 0,
                        details: { status }
                    }
                ));
            }
        } catch (err) {
            console.error('file-asset-transfer-status error:', err);
        }
    });

    socket.on('directory-mirror-asset', data => {
        try {
            const { sessionId, assetId } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidAssetId(assetId)) return;
            const session = sessions.get(sessionId);
            const record = session?.fileAssets?.get(assetId);
            if (!record?.metadata?.isDirectoryMirror || !record.providers.has(deviceId)) return;
            socket.to(sessionId).emit('directory-mirror-asset', { asset: record.metadata, from: deviceId });
            historyLog('directory-mirror-announced', {
                sessionId, deviceId, socketId: socket.id, clientIp, asset: record.metadata
            });
        } catch (err) {
            console.error('directory-mirror-asset error:', err);
        }
    });

    socket.on('file-asset-relay-start', async (data, ack) => {
        try {
            const { sessionId, to, asset, transferId, rangeStart, rangeEnd, attemptId, requestId } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidDeviceId(to) || !isValidFileAsset(asset, isValidAssetId) || to === deviceId) {
                ackFail(ack, 'invalid-relay-start');
                return;
            }
            const relayAttemptId = typeof attemptId === 'string' && attemptId
                ? sanitize(attemptId, 120)
                : '';
            const relayRequestId = typeof requestId === 'string' && requestId.length <= 120
                ? sanitize(requestId, 120)
                : '';
            const transfer = normalizeTransfer({ transferId, rangeStart, rangeEnd }, asset);
            if ((transferId || rangeStart !== undefined || rangeEnd !== undefined) && !transfer) {
                ackFail(ack, 'invalid-relay-range');
                return;
            }
            const target = deviceSockets.get(to);
            if (!target) {
                ackFail(ack, 'target-offline');
                return;
            }
            const key = relayKey(sessionId, deviceId, to, asset.id, relayTransferToken(transfer?.transferId, relayAttemptId));
            relays.set(key, {
                sessionId, from: deviceId, to, asset, transfer, attemptId: relayAttemptId, receivedSize: 0,
                requestId: relayRequestId,
                expectedSize: transfer ? transfer.rangeEnd - transfer.rangeStart : asset.size
            });
            const targetResponse = await emitWithAckResult(target, 'file-asset-relay-start', {
                asset, from: deviceId, transfer, attemptId: relayAttemptId, requestId: relayRequestId
            });
            if (targetResponse?.ok === false) {
                const rejectionReason = String(targetResponse.reason || targetResponse.error || 'relay-start-rejected');
                if (rejectionReason === 'receiver-already-cached') {
                    // This is an idempotent success: the receiver already owns the complete file.
                    // Do not print an exception and do not send any relay chunks. Tell the provider
                    // to finish the request as satisfied so its assignment/load is released normally.
                    relays.delete(key);
                    ackOk(ack, { skipped: true, reason: rejectionReason });
                    historyLog('file-asset-relay-skipped', {
                        sessionId, deviceId, targetDeviceId: to, socketId: socket.id, clientIp,
                        assetId: asset.id, transfer, attemptId: relayAttemptId, requestId: relayRequestId,
                        reason: rejectionReason
                    });
                    return;
                }
                throw new Error(rejectionReason);
            }
            ackOk(ack);
            historyLog('file-asset-relay-started', {
                sessionId, deviceId, targetDeviceId: to, socketId: socket.id, clientIp,
                asset, transfer, attemptId: relayAttemptId, requestId: relayRequestId
            });
        } catch (err) {
            console.error('file-asset-relay-start error:', err);
            const { sessionId, to, asset, transferId, attemptId } = data || {};
            const { deviceId } = current();
            if (sessionId && to && asset?.id) {
                cleanupFileAssetRelay(sessionId, deviceId, to, asset.id, transferId);
            }
            historyLog('file-asset-relay-start-failed', {
                sessionId, deviceId, targetDeviceId: to, socketId: socket.id, clientIp,
                assetId: asset?.id, transferId, attemptId,
                reason: err.message || 'relay-start-failed'
            });
            ackFail(ack, err.message || 'relay-start-failed');
        }
    });

    socket.on('file-asset-relay-chunk', async (data, ack) => {
        try {
            const { sessionId, to, assetId, chunk, transferId, attemptId } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidDeviceId(to) || !isValidAssetId(assetId) ||
                (transferId !== undefined && !isValidTransferId(transferId))) {
                ackFail(ack, 'invalid-relay-chunk');
                return;
            }
            const relayAttemptId = typeof attemptId === 'string' && attemptId
                ? sanitize(attemptId, 120)
                : '';
            const key = relayKey(sessionId, deviceId, to, assetId, relayTransferToken(transferId, relayAttemptId));
            const relay = relays.get(key);
            const size = binarySize(chunk);
            if (!relay || size <= 0 || size > MAX_RELAY_CHUNK_SIZE || relay.receivedSize + size > relay.expectedSize) {
                relays.delete(key);
                ackFail(ack, 'invalid-relay-state');
                return;
            }
            const target = deviceSockets.get(to);
            if (!target) {
                ackFail(ack, 'target-offline');
                return;
            }
            await emitWithAck(target, 'file-asset-relay-chunk', { assetId, from: deviceId, transferId, attemptId: relay.attemptId || relayAttemptId, chunk });
            relay.receivedSize += size;
            ackOk(ack, { receivedSize: relay.receivedSize, expectedSize: relay.expectedSize });
        } catch (err) {
            const { sessionId, to, assetId, transferId } = data || {};
            const { deviceId } = current();
            if (sessionId && to && assetId) cleanupFileAssetRelay(sessionId, deviceId, to, assetId, transferId);
            const reason = err.message || 'relay-chunk-failed';
            if (reason.startsWith('receiver-') || isRelayAckTimeout(reason)) {
                historyLog(reason.startsWith('receiver-') ? 'file-asset-relay-receiver-rejected' : 'file-asset-relay-target-timeout', {
                    sessionId,
                    deviceId,
                    targetDeviceId: to,
                    assetId,
                    transferId,
                    reason
                });
                ackFail(ack, reason);
                return;
            }
            console.error('file-asset-relay-chunk error:', err);
            ackFail(ack, err.message || 'relay-chunk-failed');
        }
    });

    socket.on('file-asset-relay-complete', async (data, ack) => {
        try {
            const { sessionId, to, assetId, transferId, attemptId } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidDeviceId(to) || !isValidAssetId(assetId) ||
                (transferId !== undefined && !isValidTransferId(transferId))) {
                ackFail(ack, 'invalid-relay-complete');
                return;
            }
            const relayAttemptId = typeof attemptId === 'string' && attemptId
                ? sanitize(attemptId, 120)
                : '';
            const key = relayKey(sessionId, deviceId, to, assetId, relayTransferToken(transferId, relayAttemptId));
            const relay = relays.get(key);
            relays.delete(key);
            if (!relay || relay.receivedSize !== relay.expectedSize) {
                ackFail(ack, 'relay-size-mismatch');
                return;
            }
            const target = deviceSockets.get(to);
            if (!target) {
                ackFail(ack, 'target-offline');
                return;
            }
            await emitWithAck(target, 'file-asset-relay-complete', { assetId, from: deviceId, transferId, attemptId: relay.attemptId || relayAttemptId }, RELAY_COMPLETE_ACK_TIMEOUT);
            ackOk(ack);
            historyLog('file-asset-relay-completed', { sessionId, deviceId, targetDeviceId: to, socketId: socket.id, clientIp, asset: relay.asset, transfer: relay.transfer, attemptId: relay.attemptId || relayAttemptId });
            if (recordTransferEvent) {
                const auditAsset = { ...relay.asset };
                const auditTransfer = relay.transfer ? { ...relay.transfer } : null;
                const auditNow = Date.now();
                enqueueAuditTask(() => recordTransferEvent(sessionId, 'relay-completed', auditAsset, {
                    sourceDeviceId: deviceId,
                    targetDeviceId: to,
                    transferId,
                    requestId: relay.requestId || '',
                    now: auditNow,
                    transport: 'socket.io-relay',
                    bytesTransferred: relay.expectedSize,
                    details: {
                        rangeStart: auditTransfer?.rangeStart,
                        rangeEnd: auditTransfer?.rangeEnd,
                        attemptId: relay.attemptId || relayAttemptId
                    }
                }));
            }
        } catch (err) {
            console.error('file-asset-relay-complete error:', err);
            ackFail(ack, err.message || 'relay-complete-failed');
        }
    });
}

function cleanupFileAssetRelays(sessionId, deviceId) {
    const removed = [];
    for (const [key, relay] of relays) {
        if (relay.sessionId !== sessionId || (deviceId && relay.from !== deviceId && relay.to !== deviceId)) continue;
        removed.push(relay);
        relays.delete(key);
    }
    return removed;
}

function cleanupFileAssetAssignments(session, deviceId) {
    for (const asset of session?.fileAssets?.values?.() || []) {
        for (const [key, providerId] of asset.assignments || []) {
            const requesterId = String(key).split(':')[1] || '';
            if (providerId !== deviceId && requesterId !== deviceId) continue;
            asset.assignments.delete(key);
            asset.assignmentMeta?.delete(key);
            const nextLoad = Math.max(0, (asset.providerLoads?.get(providerId) || 1) - 1);
            if (nextLoad === 0) asset.providerLoads?.delete(providerId);
            else asset.providerLoads?.set(providerId, nextLoad);
        }
    }
}

function cleanupFileAssetRelay(sessionId, from, to, assetId, transferId) {
    for (const [key, relay] of relays) {
        if (relay.sessionId !== sessionId || relay.from !== from || relay.to !== to || relay.asset?.id !== assetId) continue;
        const relayTransferId = relay.transfer?.transferId;
        if ((relayTransferId || undefined) !== (transferId || undefined)) continue;
        relays.delete(key);
    }
}

module.exports = { registerFileAssetHandlers, cleanupFileAssetRelays, cleanupFileAssetAssignments };
