function ensureMediaState(session) {
    if (!session.media) {
        session.media = { camera: null, voiceParticipants: new Set() };
    }
    return session.media;
}

const CONTACT_CALL_TIMEOUT_MS = 45_000;
const REMOTE_PREVIEW_TIMEOUT_MS = 20_000;
const contactCalls = new Map();
const contactDeviceCalls = new Map();
const remotePreviewRequests = new Map();
const remotePreviewControls = new Map();
const REMOTE_PREVIEW_CONTROL_ACTIONS = new Set(['previous', 'next', 'toggle-playback', 'exit']);

function simpleContactProfile(profile, fallbackDeviceId = '') {
    const value = profile && typeof profile === 'object' ? profile : {};
    const text = (input, limit) => String(input || '').trim().slice(0, limit);
    return {
        deviceId: text(value.deviceId || fallbackDeviceId, 64),
        name: text(value.name || value.deviceName, 80),
        deviceName: text(value.deviceName || value.name, 80),
        avatar: text(value.avatar, 12),
        avatarDataUrl: /^data:image\/(?:png|jpeg|webp);base64,/i.test(String(value.avatarDataUrl || ''))
            ? String(value.avatarDataUrl).slice(0, 180_000)
            : ''
    };
}

function clearContactCall(call) {
    if (!call) return;
    clearTimeout(call.timer);
    contactCalls.delete(call.callId);
    if (contactDeviceCalls.get(call.callerId) === call.callId) contactDeviceCalls.delete(call.callerId);
    if (contactDeviceCalls.get(call.calleeId) === call.callId) contactDeviceCalls.delete(call.calleeId);
}

function clearRemotePreviewRequest(requestId) {
    const request = remotePreviewRequests.get(requestId);
    if (!request) return;
    clearTimeout(request.timer);
    remotePreviewRequests.delete(requestId);
}

function clearRemotePreviewControl(controlId) {
    remotePreviewControls.delete(controlId);
}

function simplePreviewFileInfo(fileInfo, fileId) {
    const value = fileInfo && typeof fileInfo === 'object' ? fileInfo : {};
    return {
        id: String(fileId || value.id || '').slice(0, 128),
        name: String(value.name || '未命名文件').slice(0, 240),
        type: String(value.type || '').slice(0, 160),
        size: Math.max(0, Number(value.size) || 0),
        ownerDeviceId: String(value.ownerDeviceId || '').slice(0, 64)
    };
}

function registerMediaHandlers(socket, context) {
    const { sessions, deviceSockets, getSessionId, getDeviceId, isValidId, canUseCapability, historyLog, clientIp } = context;
    const current = () => ({ sessionId: getSessionId(), deviceId: getDeviceId() });

    socket.on('camera-broadcast-start', data => {
        const { sessionId, broadcastId } = data || {};
        const { deviceId } = current();
        if (sessionId !== current().sessionId || !isValidId(broadcastId)) return;
        const session = sessions.get(sessionId);
        if (!session) return;
        const media = ensureMediaState(session);
        const previous = media.camera;
        media.camera = { broadcastId, ownerDeviceId: deviceId };
        if (previous && previous.ownerDeviceId !== deviceId) {
            const previousSocket = deviceSockets.get(previous.ownerDeviceId);
            if (previousSocket) previousSocket.emit('camera-broadcast-stop', { broadcastId: previous.broadcastId, replaced: true });
        }
        socket.to(sessionId).emit('camera-broadcast-start', { broadcastId, from: deviceId });
        historyLog('camera-broadcast-started', { sessionId, deviceId, socketId: socket.id, clientIp, broadcastId, replaced: Boolean(previous) });
    });

    socket.on('camera-broadcast-stop', data => {
        const { sessionId, broadcastId } = data || {};
        const { deviceId } = current();
        if (sessionId !== current().sessionId || !isValidId(broadcastId)) return;
        const session = sessions.get(sessionId);
        const media = session && ensureMediaState(session);
        if (!media?.camera || media.camera.broadcastId !== broadcastId || media.camera.ownerDeviceId !== deviceId) return;
        media.camera = null;
        socket.to(sessionId).emit('camera-broadcast-stop', { broadcastId, from: deviceId });
        historyLog('camera-broadcast-stopped', { sessionId, deviceId, socketId: socket.id, clientIp, broadcastId });
    });

    socket.on('camera-viewer-ready', data => {
        const { sessionId, broadcastId, to } = data || {};
        const { deviceId } = current();
        if (sessionId !== current().sessionId || !isValidId(broadcastId) || !isValidId(to)) return;
        const session = sessions.get(sessionId);
        const media = session && ensureMediaState(session);
        if (!media?.camera || media.camera.broadcastId !== broadcastId || media.camera.ownerDeviceId !== to) return;
        const owner = deviceSockets.get(to);
        if (owner) owner.emit('camera-viewer-ready', { broadcastId, from: deviceId });
    });

    socket.on('voice-join', data => {
        const { sessionId } = data || {};
        const { deviceId } = current();
        if (sessionId !== current().sessionId) return;
        const session = sessions.get(sessionId);
        if (!session) return;
        if (canUseCapability && !canUseCapability(session, deviceId, 'groupVoice')) {
            return socket.emit('permission-denied', { capability: 'groupVoice' });
        }
        const media = ensureMediaState(session);
        const participants = Array.from(media.voiceParticipants);
        media.voiceParticipants.add(deviceId);
        socket.emit('voice-state', { participants });
        socket.to(sessionId).emit('voice-peer-joined', { deviceId });
        historyLog('voice-joined', { sessionId, deviceId, socketId: socket.id, clientIp, participantCount: media.voiceParticipants.size });
    });

    socket.on('voice-leave', data => {
        const { sessionId } = data || {};
        const { deviceId } = current();
        if (sessionId !== current().sessionId) return;
        const session = sessions.get(sessionId);
        const media = session && ensureMediaState(session);
        if (!media) return;
        media.voiceParticipants.delete(deviceId);
        socket.to(sessionId).emit('voice-peer-left', { deviceId });
        historyLog('voice-left', { sessionId, deviceId, socketId: socket.id, clientIp, participantCount: media.voiceParticipants.size });
    });

    socket.on('media-signal', data => {
        const { sessionId, to, kind, sessionKey, type } = data || {};
        const { deviceId } = current();
        if (sessionId !== current().sessionId || !isValidId(to) ||
            !['camera', 'voice', 'intercom'].includes(kind) ||
            typeof sessionKey !== 'string' || !['offer', 'answer', 'ice-candidate'].includes(type)) return;
        const session = sessions.get(sessionId);
        if (!session?.devices.has(deviceId) || !session.devices.has(to)) return;
        if (kind === 'voice' && canUseCapability && !canUseCapability(session, deviceId, 'groupVoice')) return;
        if (kind === 'intercom' && canUseCapability && !canUseCapability(session, deviceId, 'globalIntercom')) return;
        const target = deviceSockets.get(to);
        if (target) target.emit('media-signal', { ...data, from: deviceId });
    });

    socket.on('intercom-stop', data => {
        const { sessionId, intercomId, recipients } = data || {};
        const { deviceId } = current();
        if (sessionId !== current().sessionId || !isValidId(intercomId) || !Array.isArray(recipients)) return;
        recipients.filter(isValidId).forEach(id => {
            const target = deviceSockets.get(id);
            if (target) target.emit('intercom-stop', { intercomId, from: deviceId });
        });
    });

    socket.on('contact-call-request', data => {
        const { deviceId } = current();
        const { to, callId, caller } = data || {};
        if (!isValidId(deviceId) || !isValidId(to) || !isValidId(callId) || deviceId === to) return;
        const target = deviceSockets.get(to);
        if (!target || target.data?.isVClient === true) {
            socket.emit('contact-call-rejected', { callId, from: to, reason: 'offline' });
            return;
        }
        if (contactCalls.has(callId) || contactDeviceCalls.has(deviceId) || contactDeviceCalls.has(to)) {
            socket.emit('contact-call-rejected', { callId, from: to, reason: 'busy' });
            return;
        }
        const call = { callId, callerId: deviceId, calleeId: to, state: 'ringing', createdAt: Date.now(), timer: null };
        call.timer = setTimeout(() => {
            if (contactCalls.get(callId) !== call || call.state !== 'ringing') return;
            clearContactCall(call);
            deviceSockets.get(deviceId)?.emit('contact-call-rejected', { callId, from: to, reason: 'no-answer' });
            deviceSockets.get(to)?.emit('contact-call-ended', { callId, from: deviceId, reason: 'no-answer' });
        }, CONTACT_CALL_TIMEOUT_MS);
        call.timer.unref?.();
        contactCalls.set(callId, call);
        contactDeviceCalls.set(deviceId, callId);
        contactDeviceCalls.set(to, callId);
        target.emit('contact-call-request', { callId, from: deviceId, caller: simpleContactProfile(caller, deviceId), requestedAt: call.createdAt });
        historyLog('contact-call-requested', { deviceId, targetDeviceId: to, callId, socketId: socket.id, clientIp });
    });

    socket.on('contact-call-accepted', data => {
        const { deviceId } = current();
        const { to, callId, callee } = data || {};
        if (!isValidId(deviceId) || !isValidId(to) || !isValidId(callId)) return;
        const call = contactCalls.get(callId);
        if (!call || call.state !== 'ringing' || call.calleeId !== deviceId || call.callerId !== to) return;
        const target = deviceSockets.get(to);
        if (!target) {
            clearContactCall(call);
            socket.emit('contact-call-ended', { callId, from: to, reason: 'offline' });
            return;
        }
        clearTimeout(call.timer);
        call.state = 'active';
        call.answeredAt = Date.now();
        target.emit('contact-call-accepted', { callId, from: deviceId, callee: simpleContactProfile(callee, deviceId), answeredAt: call.answeredAt });
        historyLog('contact-call-accepted', { deviceId, targetDeviceId: to, callId, socketId: socket.id, clientIp });
    });

    socket.on('contact-call-rejected', data => {
        const { deviceId } = current();
        const { to, callId, reason } = data || {};
        if (!isValidId(deviceId) || !isValidId(to) || !isValidId(callId)) return;
        const call = contactCalls.get(callId);
        if (!call || call.state !== 'ringing' || call.calleeId !== deviceId || call.callerId !== to) return;
        clearContactCall(call);
        const target = deviceSockets.get(to);
        if (target) target.emit('contact-call-rejected', { callId, from: deviceId, reason: String(reason || 'rejected').slice(0, 40) });
    });

    socket.on('contact-call-ended', data => {
        const { deviceId } = current();
        const { to, callId, reason } = data || {};
        if (!isValidId(deviceId) || !isValidId(to) || !isValidId(callId)) return;
        const call = contactCalls.get(callId);
        if (!call || ![call.callerId, call.calleeId].includes(deviceId)) return;
        const peerId = call.callerId === deviceId ? call.calleeId : call.callerId;
        if (peerId !== to) return;
        clearContactCall(call);
        deviceSockets.get(peerId)?.emit('contact-call-ended', { callId, from: deviceId, reason: String(reason || 'ended').slice(0, 40) });
    });

    socket.on('contact-media-signal', data => {
        const { deviceId } = current();
        const { to, kind, sessionKey, type } = data || {};
        if (!isValidId(deviceId) || !isValidId(to) || kind !== 'contactVoice' ||
            typeof sessionKey !== 'string' || !['offer', 'answer', 'ice-candidate'].includes(type)) return;
        const call = contactCalls.get(sessionKey);
        if (!call || call.state !== 'active' || ![call.callerId, call.calleeId].includes(deviceId)) return;
        const peerId = call.callerId === deviceId ? call.calleeId : call.callerId;
        if (peerId !== to) return;
        const target = deviceSockets.get(to);
        if (target) target.emit('contact-media-signal', { ...data, from: deviceId });
    });

    socket.on('remote-preview-cache-check', (data, ack) => {
        const respond = typeof ack === 'function' ? ack : () => {};
        const { sessionId, deviceId } = current();
        const requestId = String(data?.requestId || '');
        const to = String(data?.to || '');
        const fileId = String(data?.fileId || data?.fileInfo?.id || '');
        const session = sessions.get(sessionId);
        const target = deviceSockets.get(to);
        if (!isValidId(requestId) || !isValidId(to) || !fileId || to === deviceId ||
            !session?.devices.has(deviceId) || !session.devices.has(to) || !target || target.data?.isVClient === true) {
            return respond({ ok: false, reason: 'target-unavailable' });
        }
        clearRemotePreviewRequest(requestId);
        const request = {
            requestId, sessionId, controllerId: deviceId, targetId: to, fileId,
            available: false, timer: null
        };
        request.timer = setTimeout(() => clearRemotePreviewRequest(requestId), REMOTE_PREVIEW_TIMEOUT_MS);
        request.timer.unref?.();
        remotePreviewRequests.set(requestId, request);
        target.emit('remote-preview-cache-check', {
            requestId,
            from: deviceId,
            fileId,
            fileInfo: simplePreviewFileInfo(data?.fileInfo, fileId),
            messageId: String(data?.messageId || '').slice(0, 128)
        });
        respond({ ok: true });
    });

    socket.on('remote-preview-cache-result', data => {
        const { sessionId, deviceId } = current();
        const requestId = String(data?.requestId || '');
        const request = remotePreviewRequests.get(requestId);
        if (!request || request.sessionId !== sessionId || request.targetId !== deviceId ||
            request.controllerId !== data?.to || request.fileId !== data?.fileId) return;
        request.available = data?.available === true;
        deviceSockets.get(request.controllerId)?.emit('remote-preview-cache-result', {
            requestId,
            from: deviceId,
            fileId: request.fileId,
            available: request.available,
            reason: String(data?.reason || '').slice(0, 80)
        });
    });

    socket.on('remote-preview-open', (data, ack) => {
        const respond = typeof ack === 'function' ? ack : () => {};
        const { sessionId, deviceId } = current();
        const request = remotePreviewRequests.get(String(data?.requestId || ''));
        const session = sessions.get(sessionId);
        if (!request || !request.available || request.sessionId !== sessionId || request.controllerId !== deviceId ||
            request.targetId !== data?.to || !session?.devices.has(request.targetId) || !deviceSockets.has(request.targetId)) {
            return respond({ ok: false, reason: 'cache-verification-required' });
        }
        deviceSockets.get(request.targetId).emit('remote-preview-open', {
            requestId: request.requestId,
            from: deviceId,
            fileId: request.fileId
        });
        respond({ ok: true });
    });

    socket.on('remote-preview-open-result', data => {
        const { sessionId, deviceId } = current();
        const requestId = String(data?.requestId || '');
        const request = remotePreviewRequests.get(requestId);
        if (!request || request.sessionId !== sessionId || request.targetId !== deviceId || request.controllerId !== data?.to) return;
        const ok = data?.ok === true;
        let controlId = '';
        if (ok) {
            controlId = requestId;
            for (const [existingId, existing] of remotePreviewControls) {
                if (existing.controllerId !== request.controllerId && existing.targetId !== request.targetId) continue;
                deviceSockets.get(existing.targetId)?.emit('remote-preview-control', {
                    controlId:existingId,
                    from:existing.controllerId,
                    action:'exit',
                    reason:'replaced'
                });
                deviceSockets.get(existing.controllerId)?.emit('remote-preview-control-ended', {
                    controlId:existingId,
                    from:existing.targetId,
                    reason:'replaced'
                });
                clearRemotePreviewControl(existingId);
            }
            remotePreviewControls.set(controlId, {
                controlId,
                sessionId:request.sessionId,
                controllerId:request.controllerId,
                targetId:request.targetId,
                fileId:String(data?.fileId || request.fileId).slice(0, 128),
                createdAt:Date.now()
            });
        }
        deviceSockets.get(request.controllerId)?.emit('remote-preview-open-result', {
            requestId,
            controlId,
            from: deviceId,
            fileId: request.fileId,
            fileName:String(data?.fileName || '').slice(0, 240),
            mediaType:String(data?.mediaType || '').slice(0, 160),
            playing:data?.playing === true,
            ok,
            reason:String(data?.reason || '').slice(0, 120)
        });
        clearRemotePreviewRequest(requestId);
    });

    socket.on('remote-preview-control', (data, ack) => {
        const respond = typeof ack === 'function' ? ack : () => {};
        const { sessionId, deviceId } = current();
        const controlId = String(data?.controlId || '');
        const action = String(data?.action || '');
        const control = remotePreviewControls.get(controlId);
        const session = sessions.get(sessionId);
        const target = control && deviceSockets.get(control.targetId);
        if (!isValidId(controlId) || !REMOTE_PREVIEW_CONTROL_ACTIONS.has(action) || !control ||
            control.sessionId !== sessionId || control.controllerId !== deviceId || control.targetId !== data?.to ||
            !session?.devices.has(deviceId) || !session.devices.has(control.targetId) || !target) {
            return respond({ ok:false, reason:'control-session-invalid' });
        }
        target.emit('remote-preview-control', { controlId, from:deviceId, action });
        respond({ ok:true });
    });

    socket.on('remote-preview-control-result', data => {
        const { sessionId, deviceId } = current();
        const controlId = String(data?.controlId || '');
        const action = String(data?.action || '');
        const control = remotePreviewControls.get(controlId);
        if (!control || control.sessionId !== sessionId || control.targetId !== deviceId ||
            control.controllerId !== data?.to || !REMOTE_PREVIEW_CONTROL_ACTIONS.has(action)) return;
        control.fileId = String(data?.fileId || control.fileId).slice(0, 128);
        deviceSockets.get(control.controllerId)?.emit('remote-preview-control-result', {
            controlId,
            from:deviceId,
            action,
            ok:data?.ok === true,
            reason:String(data?.reason || '').slice(0, 120),
            fileId:control.fileId,
            fileName:String(data?.fileName || '').slice(0, 240),
            mediaType:String(data?.mediaType || '').slice(0, 160),
            playing:data?.playing === true
        });
        if (action === 'exit' && data?.ok === true) clearRemotePreviewControl(controlId);
    });

    socket.on('remote-preview-control-ended', data => {
        const { sessionId, deviceId } = current();
        const controlId = String(data?.controlId || '');
        const control = remotePreviewControls.get(controlId);
        if (!control || control.sessionId !== sessionId || control.targetId !== deviceId || control.controllerId !== data?.to) return;
        deviceSockets.get(control.controllerId)?.emit('remote-preview-control-ended', {
            controlId,
            from:deviceId,
            reason:String(data?.reason || 'exited').slice(0, 80)
        });
        clearRemotePreviewControl(controlId);
    });
}

function cleanupMediaDevice(session, deviceId, emit, emitToDevice) {
    if (session?.media) {
        const media = session.media;
        media.voiceParticipants.delete(deviceId);
        if (media.camera?.ownerDeviceId === deviceId) {
            emit('camera-broadcast-stop', { broadcastId: media.camera.broadcastId, from: deviceId });
            media.camera = null;
        }
        emit('voice-peer-left', { deviceId });
    }
    const callId = contactDeviceCalls.get(deviceId);
    const call = callId && contactCalls.get(callId);
    if (call) {
        const peerId = call.callerId === deviceId ? call.calleeId : call.callerId;
        clearContactCall(call);
        emitToDevice?.(peerId, 'contact-call-ended', { callId, from: deviceId, reason: 'offline' });
    }
    for (const [requestId, request] of remotePreviewRequests) {
        if (request.controllerId === deviceId || request.targetId === deviceId) clearRemotePreviewRequest(requestId);
    }
    for (const [controlId, control] of remotePreviewControls) {
        if (control.controllerId !== deviceId && control.targetId !== deviceId) continue;
        const peerId = control.controllerId === deviceId ? control.targetId : control.controllerId;
        clearRemotePreviewControl(controlId);
        emitToDevice?.(peerId, 'remote-preview-control-ended', { controlId, from:deviceId, reason:'offline' });
    }
}

module.exports = { registerMediaHandlers, cleanupMediaDevice };
