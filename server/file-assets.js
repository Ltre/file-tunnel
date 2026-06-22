const MAX_FILE_ASSET_SIZE = 1024 * 1024 * 1024;
const MAX_FILE_ASSETS_PER_SESSION = 500;
const MAX_RELAY_CHUNK_SIZE = 64 * 1024;
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

function relayKey(sessionId, from, to, assetId) {
    return `${sessionId}:${from}:${to}:${assetId}`;
}

function findProvider(session, assetId, requesterId, preferredProviderId) {
    const record = session.fileAssets && session.fileAssets.get(assetId);
    if (!record) return null;
    const providers = Array.from(record.providers);
    return providers.find(id => id === preferredProviderId && id !== requesterId && session.devices.has(id)) ||
        providers.find(id => id !== requesterId && session.devices.has(id)) || null;
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
                        ownerDeviceId: isValidId(asset.ownerDeviceId) ? asset.ownerDeviceId : deviceId
                    },
                    providers: new Set()
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
            const { sessionId, assetId, preferredProviderId } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidId(assetId)) return;
            const session = sessions.get(sessionId);
            if (!session || !session.devices.has(deviceId)) return;
            const providerId = findProvider(session, assetId, deviceId, preferredProviderId);
            if (!providerId) {
                socket.emit('file-asset-unavailable', { assetId, reason: 'no-online-provider' });
                historyLog('file-asset-request-unavailable', {
                    sessionId, deviceId, socketId: socket.id, clientIp, assetId, preferredProviderId,
                    knownProviderDeviceIds: Array.from(session.fileAssets?.get(assetId)?.providers || [])
                });
                return;
            }
            const providerSocket = deviceSockets.get(providerId);
            const record = session.fileAssets.get(assetId);
            if (!providerSocket || !record) return;
            providerSocket.emit('file-asset-request', { asset: record.metadata, from: deviceId });
            historyLog('file-asset-request-forwarded', {
                sessionId, deviceId, targetDeviceId: providerId, socketId: socket.id, clientIp, asset: record.metadata,
                knownProviderDeviceIds: Array.from(record.providers)
            });
        } catch (err) {
            console.error('file-asset-request error:', err);
        }
    });

    socket.on('file-asset-unavailable', data => {
        try {
            const { sessionId, assetId, to, reason } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidId(assetId) || !isValidId(to)) return;
            const session = sessions.get(sessionId);
            const record = session?.fileAssets?.get(assetId);
            if (record && reason === 'provider-missing-local-data') {
                record.providers.delete(deviceId);
                const alternative = findProvider(session, assetId, to, null);
                const alternativeSocket = alternative && deviceSockets.get(alternative);
                historyLog('file-asset-provider-removed', {
                    sessionId, deviceId, targetDeviceId: to, socketId: socket.id, clientIp, assetId,
                    alternativeProviderId: alternative, remainingProviderDeviceIds: Array.from(record.providers)
                });
                if (alternativeSocket) {
                    alternativeSocket.emit('file-asset-request', { asset: record.metadata, from: to });
                    return;
                }
            }
            const target = deviceSockets.get(to);
            if (target) target.emit('file-asset-unavailable', { assetId, from: deviceId, reason: sanitize(reason || 'provider-unavailable', 80) });
        } catch (err) {
            console.error('file-asset-unavailable error:', err);
        }
    });

    socket.on('file-asset-relay-start', data => {
        try {
            const { sessionId, to, asset } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidId(to) || !isValidFileAsset(asset, isValidId) || to === deviceId) return;
            const target = deviceSockets.get(to);
            if (!target) return;
            const key = relayKey(sessionId, deviceId, to, asset.id);
            relays.set(key, { sessionId, from: deviceId, to, asset, receivedSize: 0 });
            target.emit('file-asset-relay-start', { asset, from: deviceId });
            historyLog('file-asset-relay-started', { sessionId, deviceId, targetDeviceId: to, socketId: socket.id, clientIp, asset });
        } catch (err) {
            console.error('file-asset-relay-start error:', err);
        }
    });

    socket.on('file-asset-relay-chunk', data => {
        try {
            const { sessionId, to, assetId, chunk } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidId(to) || !isValidId(assetId)) return;
            const key = relayKey(sessionId, deviceId, to, assetId);
            const relay = relays.get(key);
            const size = binarySize(chunk);
            if (!relay || size <= 0 || size > MAX_RELAY_CHUNK_SIZE || relay.receivedSize + size > relay.asset.size) {
                relays.delete(key);
                return;
            }
            const target = deviceSockets.get(to);
            if (!target) return;
            relay.receivedSize += size;
            target.emit('file-asset-relay-chunk', { assetId, from: deviceId, chunk });
        } catch (err) {
            console.error('file-asset-relay-chunk error:', err);
        }
    });

    socket.on('file-asset-relay-complete', data => {
        try {
            const { sessionId, to, assetId } = data || {};
            const { deviceId } = current();
            if (sessionId !== current().sessionId || !isValidId(to) || !isValidId(assetId)) return;
            const key = relayKey(sessionId, deviceId, to, assetId);
            const relay = relays.get(key);
            relays.delete(key);
            if (!relay || relay.receivedSize !== relay.asset.size) return;
            const target = deviceSockets.get(to);
            if (target) target.emit('file-asset-relay-complete', { assetId, from: deviceId });
            historyLog('file-asset-relay-completed', { sessionId, deviceId, targetDeviceId: to, socketId: socket.id, clientIp, asset: relay.asset });
        } catch (err) {
            console.error('file-asset-relay-complete error:', err);
        }
    });
}

function cleanupFileAssetRelays(sessionId, deviceId) {
    for (const [key, relay] of relays) {
        if (relay.sessionId === sessionId && (relay.from === deviceId || relay.to === deviceId)) relays.delete(key);
    }
}

module.exports = { registerFileAssetHandlers, cleanupFileAssetRelays };
