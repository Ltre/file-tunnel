const MAX_FILE_ASSET_SIZE = 1024 * 1024 * 1024;
const MAX_FILE_ASSETS_PER_SESSION = 500;
const MAX_RELAY_CHUNK_SIZE = 64 * 1024;
const MAX_FILE_ASSET_RANGE_SIZE = 4 * 1024 * 1024;
const relays = new Map();

function isValidFileAsset(asset, isValidId) {
    return asset &&
        isValidId(asset.id) &&
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

function findProvider(session, assetId, requesterId, preferredProviderId, deviceSockets) {
    const record = session.fileAssets && session.fileAssets.get(assetId);
    if (!record) return null;
    const providers = Array.from(record.providers);
    const candidates = providers.filter(id => id !== requesterId && session.devices.has(id) && (!deviceSockets || deviceSockets.has(id)));
    const preferred = candidates.find(id => id === preferredProviderId);
    if (preferred && (record.providerLoads?.get(preferred) || 0) === 0) return preferred;
    return candidates.sort((a, b) =>
        (record.providerLoads?.get(a) || 0) - (record.providerLoads?.get(b) || 0)
    )[0] || null;
}

function assignmentKey(assetId, requesterId, transferId = 'full') {
    return `${assetId}:${requesterId}:${transferId}`;
}

function releaseAssignment(record, assetId, requesterId, transferId = 'full') {
    if (!record?.assignments || !record.providerLoads) return;
    const key = assignmentKey(assetId, requesterId, transferId);
    const providerId = record.assignments.get(key);
    if (!providerId) return;
    record.assignments.delete(key);
    const nextLoad = Math.max(0, (record.providerLoads.get(providerId) || 1) - 1);
    if (nextLoad === 0) record.providerLoads.delete(providerId);
    else record.providerLoads.set(providerId, nextLoad);
}

function registerFileAssetHandlers(socket, context) {
    const { sessions, deviceSockets, getSessionId, getDeviceId, isValidId, sanitize, historyLog, clientIp } = context;
    const current = () => ({ sessionId: getSessionId(), deviceId: getDeviceId() });

    socket.on('file-asset-available', data => {
        try {
            const { sessionId, asset } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidFileAsset(asset, isValidId)) return;
            const session = sessions.get(sessionId);
            if (!session || !session.devices.has(deviceId)) return;
            if (!session.fileAssets) session.fileAssets = new Map();

            let record = session.fileAssets.get(asset.id);
            if (!record) {
                if (session.fileAssets.size >= MAX_FILE_ASSETS_PER_SESSION) {
                    socket.emit('error', { message: '会话文件数量已达上限', code: 'FILE_ASSET_LIMIT_REACHED' });
                    return;
                }
                record = {
                    metadata: {
                        id: asset.id,
                        name: sanitize(asset.name, 255),
                        type: sanitize(asset.type, 100),
                        size: asset.size,
                        ownerDeviceId: isValidId(asset.ownerDeviceId) ? asset.ownerDeviceId : deviceId,
                        isFolderArchive: asset.isFolderArchive === true,
                        isDirectoryMirror: asset.isDirectoryMirror === true,
                        folderName: typeof asset.folderName === 'string' ? sanitize(asset.folderName, 120) : undefined,
                        entryCount: Number.isInteger(asset.entryCount) ? asset.entryCount : undefined
                    },
                    providers: new Set(),
                    providerLoads: new Map(),
                    assignments: new Map()
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
        } catch (err) {
            console.error('file-asset-available error:', err);
        }
    });

    socket.on('file-asset-request', data => {
        try {
            const { sessionId, assetId, preferredProviderId, mode } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidId(assetId)) return;
            const session = sessions.get(sessionId);
            if (!session || !session.devices.has(deviceId)) return;
            const record = session.fileAssets?.get(assetId);
            if (!record) {
                socket.emit('file-asset-unavailable', { assetId, reason: 'no-known-provider' });
                return;
            }

            if (mode === 'manifest') {
                const providers = Array.from(record.providers)
                    .filter(id => id !== deviceId && session.devices.has(id) && deviceSockets.has(id))
                    .sort((a, b) => (record.providerLoads?.get(a) || 0) - (record.providerLoads?.get(b) || 0));
                socket.emit('file-asset-manifest', { asset: record.metadata, providers });
                historyLog('file-asset-manifest-sent', {
                    sessionId, deviceId, socketId: socket.id, clientIp, asset: record.metadata, providers
                });
                return;
            }

            const hasTransferFields = data?.transferId || data?.rangeStart !== undefined || data?.rangeEnd !== undefined;
            const transfer = normalizeTransfer(data, record.metadata);
            if (hasTransferFields && !transfer) return;
            if (!record.providerLoads) record.providerLoads = new Map();
            if (!record.assignments) record.assignments = new Map();
            const forced = data?.force === true;
            const requestId = typeof data?.requestId === 'string' && data.requestId.length <= 120
                ? sanitize(data.requestId, 120)
                : undefined;
            const existingProviderId = record.assignments.get(assignmentKey(assetId, deviceId, transfer?.transferId));
            if (existingProviderId && !forced && session.devices.has(existingProviderId) && deviceSockets.has(existingProviderId)) {
                historyLog('file-asset-request-ignored-duplicate', {
                    sessionId, deviceId, targetDeviceId: existingProviderId, socketId: socket.id, clientIp,
                    assetId, transfer
                });
                return;
            }
            if (existingProviderId) releaseAssignment(record, assetId, deviceId, transfer?.transferId);
            const providerId = findProvider(session, assetId, deviceId, preferredProviderId, deviceSockets);
            if (!providerId) {
                releaseAssignment(record, assetId, deviceId, transfer?.transferId);
                socket.emit('file-asset-unavailable', { assetId, transferId: transfer?.transferId, reason: 'no-online-provider' });
                historyLog('file-asset-request-unavailable', {
                    sessionId, deviceId, socketId: socket.id, clientIp, assetId, preferredProviderId,
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
                    sessionId, deviceId, targetDeviceId: providerId, socketId: socket.id, clientIp, assetId, transfer
                });
                return;
            }
            releaseAssignment(record, assetId, deviceId, transfer?.transferId);
            record.assignments.set(assignmentKey(assetId, deviceId, transfer?.transferId), providerId);
            record.providerLoads.set(providerId, (record.providerLoads.get(providerId) || 0) + 1);
            providerSocket.emit('file-asset-request', { asset: record.metadata, from: deviceId, transfer, requestId });
            historyLog('file-asset-request-forwarded', {
                sessionId, deviceId, targetDeviceId: providerId, socketId: socket.id, clientIp, asset: record.metadata,
                transfer, knownProviderDeviceIds: Array.from(record.providers),
                providerLoads: Object.fromEntries(record.providerLoads),
                forced,
                requestId
            });
        } catch (err) {
            console.error('file-asset-request error:', err);
        }
    });

    socket.on('file-asset-unavailable', data => {
        try {
            const { sessionId, assetId, to, reason, transferId, rangeStart, rangeEnd } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidId(assetId) || !isValidId(to)) return;
            const session = sessions.get(sessionId);
            const record = session?.fileAssets?.get(assetId);
            const transfer = normalizeTransfer({ transferId, rangeStart, rangeEnd }, record?.metadata || {});
            if ((transferId || rangeStart !== undefined || rangeEnd !== undefined) && !transfer) return;
            if (record && reason === 'provider-missing-local-data') {
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
                    record.assignments.set(assignmentKey(assetId, to, transfer?.transferId), alternative);
                    record.providerLoads.set(alternative, (record.providerLoads.get(alternative) || 0) + 1);
                    alternativeSocket.emit('file-asset-request', { asset: record.metadata, from: to, transfer });
                    return;
                }
            }
            const target = deviceSockets.get(to);
            if (target) target.emit('file-asset-unavailable', {
                assetId, from: deviceId, transferId: transfer?.transferId,
                rangeStart: transfer?.rangeStart, rangeEnd: transfer?.rangeEnd,
                reason: sanitize(reason || 'provider-unavailable', 80)
            });
        } catch (err) {
            console.error('file-asset-unavailable error:', err);
        }
    });

    socket.on('file-asset-transfer-status', data => {
        try {
            const { sessionId, assetId, to, status, transferId } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidId(assetId) || !isValidId(to) ||
                (transferId !== undefined && !isValidTransferId(transferId)) ||
                !['started', 'completed', 'failed'].includes(status)) return;
            const record = sessions.get(sessionId)?.fileAssets?.get(assetId);
            if (!record?.assignments) return;
            const assignedProvider = record.assignments.get(assignmentKey(assetId, to, transferId));
            if (assignedProvider !== deviceId) return;
            if (status === 'completed' || status === 'failed') releaseAssignment(record, assetId, to, transferId);
            historyLog('file-asset-transfer-status', {
                sessionId, deviceId, targetDeviceId: to, socketId: socket.id, clientIp, assetId, transferId, status,
                providerLoads: Object.fromEntries(record.providerLoads || [])
            });
        } catch (err) {
            console.error('file-asset-transfer-status error:', err);
        }
    });

    socket.on('directory-mirror-asset', data => {
        try {
            const { sessionId, assetId } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidId(assetId)) return;
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

    socket.on('file-asset-relay-start', data => {
        try {
            const { sessionId, to, asset, transferId, rangeStart, rangeEnd } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidId(to) || !isValidFileAsset(asset, isValidId) || to === deviceId) return;
            const transfer = normalizeTransfer({ transferId, rangeStart, rangeEnd }, asset);
            if ((transferId || rangeStart !== undefined || rangeEnd !== undefined) && !transfer) return;
            const target = deviceSockets.get(to);
            if (!target) return;
            const key = relayKey(sessionId, deviceId, to, asset.id, transfer?.transferId);
            relays.set(key, {
                sessionId, from: deviceId, to, asset, transfer, receivedSize: 0,
                expectedSize: transfer ? transfer.rangeEnd - transfer.rangeStart : asset.size
            });
            target.emit('file-asset-relay-start', { asset, from: deviceId, transfer });
            historyLog('file-asset-relay-started', { sessionId, deviceId, targetDeviceId: to, socketId: socket.id, clientIp, asset, transfer });
        } catch (err) {
            console.error('file-asset-relay-start error:', err);
        }
    });

    socket.on('file-asset-relay-chunk', data => {
        try {
            const { sessionId, to, assetId, chunk, transferId } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidId(to) || !isValidId(assetId) ||
                (transferId !== undefined && !isValidTransferId(transferId))) return;
            const key = relayKey(sessionId, deviceId, to, assetId, transferId);
            const relay = relays.get(key);
            const size = binarySize(chunk);
            if (!relay || size <= 0 || size > MAX_RELAY_CHUNK_SIZE || relay.receivedSize + size > relay.expectedSize) {
                relays.delete(key);
                return;
            }
            const target = deviceSockets.get(to);
            if (!target) return;
            relay.receivedSize += size;
            target.emit('file-asset-relay-chunk', { assetId, from: deviceId, transferId, chunk });
        } catch (err) {
            console.error('file-asset-relay-chunk error:', err);
        }
    });

    socket.on('file-asset-relay-complete', data => {
        try {
            const { sessionId, to, assetId, transferId } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidId(to) || !isValidId(assetId) ||
                (transferId !== undefined && !isValidTransferId(transferId))) return;
            const key = relayKey(sessionId, deviceId, to, assetId, transferId);
            const relay = relays.get(key);
            relays.delete(key);
            if (!relay || relay.receivedSize !== relay.expectedSize) return;
            const target = deviceSockets.get(to);
            if (target) target.emit('file-asset-relay-complete', { assetId, from: deviceId, transferId });
            historyLog('file-asset-relay-completed', { sessionId, deviceId, targetDeviceId: to, socketId: socket.id, clientIp, asset: relay.asset, transfer: relay.transfer });
        } catch (err) {
            console.error('file-asset-relay-complete error:', err);
        }
    });
}

function cleanupFileAssetRelays(sessionId, deviceId) {
    for (const [key, relay] of relays) {
        if (relay.sessionId === sessionId && (!deviceId || relay.from === deviceId || relay.to === deviceId)) relays.delete(key);
    }
}

module.exports = { registerFileAssetHandlers, cleanupFileAssetRelays };
