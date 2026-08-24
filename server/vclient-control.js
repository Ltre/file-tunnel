'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function readOrCreateControlToken(dataDir) {
    const tokenPath = path.join(dataDir, 'vclient-control.token');
    const configured = String(process.env.VCLIENT_CONTROL_TOKEN || '').trim();
    if (configured) return { token: configured, tokenPath };
    try {
        const existing = fs.readFileSync(tokenPath, 'utf8').trim();
        if (existing.length >= 32) return { token: existing, tokenPath };
    } catch (_) {}
    fs.mkdirSync(dataDir, { recursive: true });
    const token = crypto.randomBytes(32).toString('hex');
    try {
        fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600, flag: 'wx' });
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const concurrent = fs.readFileSync(tokenPath, 'utf8').trim();
        if (concurrent.length >= 32) return { token: concurrent, tokenPath };
        fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600, flag: 'w' });
    }
    try { fs.chmodSync(tokenPath, 0o600); } catch (_) {}
    return { token, tokenPath };
}

function tokenMatches(expected, supplied) {
    const left = Buffer.from(String(expected || ''));
    const right = Buffer.from(String(supplied || ''));
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createVClientControl({ io, app, adminAuth, infraStore, dataDir, isValidSessionId }) {
    const { token, tokenPath } = readOrCreateControlToken(dataDir);
    const namespace = io.of('/vclient-control');
    let controller = null;

    const enabledAssignments = () => (infraStore.listVClientTunnels?.() || [])
        .filter(row => Number(row.desired_enabled) === 1)
        .map(row => ({
            sessionId: row.session_id,
            enabled: true,
            updatedAt: Number(row.updated_at) || Date.now()
        }));

    const emitAssignments = socket => {
        const target = socket || controller;
        if (target?.connected) target.emit('assignments', { tunnels: enabledAssignments(), sentAt: Date.now() });
    };

    namespace.use((socket, next) => {
        if (!tokenMatches(token, socket.handshake.auth?.token)) return next(new Error('vclient-control-unauthorized'));
        next();
    });

    namespace.on('connection', socket => {
        if (controller && controller.id !== socket.id) {
            controller.emit('superseded', { reason: 'new-controller-connected', at: Date.now() });
            controller.disconnect(true);
        }
        controller = socket;
        emitAssignments(socket);

        socket.on('assignments-request', () => emitAssignments(socket));

        socket.on('status', payload => {
            const sessionId = String(payload?.sessionId || '');
            if (!isValidSessionId(sessionId)) return;
            if (payload?.scope !== 'process' && !infraStore.getVClientTunnel?.(sessionId)?.desired_enabled) {
                forceDisconnectTunnel(sessionId, 'vclient-tunnel-disabled');
                return;
            }
            const details = {
                statusDetail: String(payload?.detail || ''),
                lastError: String(payload?.error || payload?.reason || ''),
                instanceId: String(payload?.instanceId || socket.handshake.auth?.instanceId || ''),
                deviceId: String(payload?.deviceId || ''),
                heartbeatAt: Number(payload?.at) || Date.now()
            };
            if (Number.isFinite(Number(payload?.cachedFiles))) details.cachedFiles = Math.max(0, Number(payload.cachedFiles));
            if (Number.isFinite(Number(payload?.cachedBytes))) details.cachedBytes = Math.max(0, Number(payload.cachedBytes));
            if (Number(payload?.lastSyncAt) > 0) details.lastSyncAt = Number(payload.lastSyncAt);
            infraStore.updateVClientStatus?.(
                sessionId,
                String(payload?.state || payload?.status || 'unknown'),
                details
            );
        });

        socket.on('asset-status', payload => {
            const sessionId = String(payload?.sessionId || '');
            const fileId = String(payload?.assetId || payload?.fileId || '');
            if (!isValidSessionId(sessionId) || !fileId) return;
            if (!infraStore.getVClientTunnel?.(sessionId)?.desired_enabled) {
                forceDisconnectTunnel(sessionId, 'vclient-tunnel-disabled');
                return;
            }
            const state = String(payload?.state || 'waiting');
            const bytesTotal = Math.max(0, Number(payload?.bytesTotal ?? payload?.size) || 0);
            const bytesCached = Math.max(0, Number(
                payload?.bytesCached ?? payload?.received ?? (state === 'cached' ? bytesTotal : 0)
            ) || 0);
            const updatedAt = Number(payload?.updatedAt) || Date.now();
            infraStore.upsertVClientAssetState?.(sessionId, fileId, {
                state,
                bytesCached,
                bytesTotal,
                cachePath: '',
                error: String(payload?.error || payload?.reason || ''),
                updatedAt,
                completedAt: Number(payload?.completedAt) || (state === 'cached' ? updatedAt : 0)
            });
        });

        socket.on('records-request', (payload, ack) => {
            const respond = typeof ack === 'function' ? ack : () => {};
            const sessionId = String(payload?.sessionId || '');
            const assignment = infraStore.getVClientTunnel?.(sessionId);
            if (!isValidSessionId(sessionId) || Number(assignment?.desired_enabled) !== 1) {
                return respond({ ok: false, error: 'vclient-tunnel-not-enabled' });
            }
            const limit = Math.max(1, Math.min(250, Number(payload?.limit) || 100));
            const offset = Math.max(0, Number(payload?.cursor ?? payload?.offset) || 0);
            const result = infraStore.listTransferRecords?.(sessionId, {
                limit,
                offset,
                includeDeleted: true
            }) || { items: [], total: 0, limit, offset };
            respond({
                ok: true,
                ...result,
                nextCursor: offset + result.items.length < result.total ? offset + result.items.length : null
            });
        });

        socket.on('disconnect', () => {
            if (controller?.id === socket.id) controller = null;
        });
    });

    function forceDisconnectTunnel(sessionId, reason) {
        for (const dataSocket of io.of('/').sockets.values()) {
            if (dataSocket.data?.isVClient !== true || dataSocket.data?.vclientSessionId !== sessionId) continue;
            dataSocket.emit('error', { code: 'VCLIENT_TUNNEL_DISABLED', message: reason });
            dataSocket.disconnect(true);
        }
    }

    app.get('/api/vclient/status', adminAuth.requireAuth, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            processOnline: Boolean(controller?.connected),
            instanceId: String(controller?.handshake.auth?.instanceId || ''),
            tunnels: infraStore.listVClientTunnels?.() || []
        });
    });

    app.post('/api/vclient/tunnels/:sessionId/enable', adminAuth.requireAuth, (req, res) => {
        const sessionId = String(req.params.sessionId || '');
        if (!isValidSessionId(sessionId) || !infraStore.getTunnel(sessionId)) {
            return res.status(404).json({ error: 'vclient-tunnel-not-found' });
        }
        infraStore.setVClientDesired(sessionId, true);
        infraStore.updateVClientStatus?.(sessionId, controller?.connected ? 'starting' : 'waiting-process', {
            statusDetail: controller?.connected ? '已下发启用指令' : '等待独立缓存节点进程连接'
        });
        emitAssignments();
        res.json({ ok: true, processOnline: Boolean(controller?.connected), tunnel: infraStore.getVClientTunnel(sessionId) });
    });

    app.post('/api/vclient/tunnels/:sessionId/disable', adminAuth.requireAuth, (req, res) => {
        const sessionId = String(req.params.sessionId || '');
        if (!isValidSessionId(sessionId)) return res.status(400).json({ error: 'vclient-tunnel-invalid' });
        infraStore.setVClientDesired(sessionId, false);
        infraStore.updateVClientStatus?.(sessionId, controller?.connected ? 'stopping' : 'stopped', {
            statusDetail: '停止不会删除已有缓存'
        });
        forceDisconnectTunnel(sessionId, 'vclient-tunnel-disabled');
        emitAssignments();
        res.json({ ok: true, processOnline: Boolean(controller?.connected), tunnel: infraStore.getVClientTunnel(sessionId) });
    });

    app.get('/api/vclient/tunnels/:sessionId/status', adminAuth.requireAuth, (req, res) => {
        const sessionId = String(req.params.sessionId || '');
        if (!isValidSessionId(sessionId)) return res.status(400).json({ error: 'vclient-tunnel-invalid' });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ processOnline: Boolean(controller?.connected), tunnel: infraStore.getVClientTunnel(sessionId) });
    });

    app.get('/api/vclient/tunnels/:sessionId/records', adminAuth.requireAuth, (req, res) => {
        const sessionId = String(req.params.sessionId || '');
        if (!isValidSessionId(sessionId)) return res.status(400).json({ error: 'vclient-tunnel-invalid' });
        const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const records = infraStore.listTransferRecords?.(sessionId, {
            limit,
            offset,
            includeDeleted: req.query.includeDeleted === '1'
        }) || { items: [], total: 0, limit, offset };
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            ...records,
            processOnline: Boolean(controller?.connected),
            tunnel: infraStore.getVClientTunnel(sessionId),
            assetStates: infraStore.listVClientAssetStates?.(sessionId) || []
        });
    });

    return {
        tokenPath,
        isControllerOnline: () => Boolean(controller?.connected),
        isDataSocketAuthenticated(socket) {
            return tokenMatches(token, socket?.handshake?.auth?.vclientToken);
        },
        isTunnelEnabled(sessionId) {
            return Number(infraStore.getVClientTunnel?.(sessionId)?.desired_enabled) === 1;
        },
        emitAssignments
    };
}

module.exports = { createVClientControl };
