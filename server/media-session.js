function ensureMediaState(session) {
    if (!session.media) {
        session.media = { camera: null, voiceParticipants: new Set() };
    }
    return session.media;
}

function registerMediaHandlers(socket, context) {
    const { sessions, deviceSockets, getSessionId, getDeviceId, isValidId, historyLog, clientIp } = context;
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
        if (!isValidId(deviceId) || !isValidId(to) || !isValidId(callId)) return;
        const target = deviceSockets.get(to);
        if (target) target.emit('contact-call-request', { callId, from: deviceId, caller });
        else socket.emit('contact-call-rejected', { callId, from: to, reason: 'offline' });
        historyLog('contact-call-requested', { deviceId, targetDeviceId: to, callId, socketId: socket.id, clientIp });
    });

    socket.on('contact-call-accepted', data => {
        const { deviceId } = current();
        const { to, callId, callee } = data || {};
        if (!isValidId(deviceId) || !isValidId(to) || !isValidId(callId)) return;
        const target = deviceSockets.get(to);
        if (target) target.emit('contact-call-accepted', { callId, from: deviceId, callee });
        historyLog('contact-call-accepted', { deviceId, targetDeviceId: to, callId, socketId: socket.id, clientIp });
    });

    socket.on('contact-call-rejected', data => {
        const { deviceId } = current();
        const { to, callId, reason } = data || {};
        if (!isValidId(deviceId) || !isValidId(to) || !isValidId(callId)) return;
        const target = deviceSockets.get(to);
        if (target) target.emit('contact-call-rejected', { callId, from: deviceId, reason: String(reason || 'rejected').slice(0, 40) });
    });

    socket.on('contact-call-ended', data => {
        const { deviceId } = current();
        const { to, callId, reason } = data || {};
        if (!isValidId(deviceId) || !isValidId(to) || !isValidId(callId)) return;
        const target = deviceSockets.get(to);
        if (target) target.emit('contact-call-ended', { callId, from: deviceId, reason: String(reason || 'ended').slice(0, 40) });
    });

    socket.on('contact-media-signal', data => {
        const { deviceId } = current();
        const { to, kind, sessionKey, type } = data || {};
        if (!isValidId(deviceId) || !isValidId(to) || kind !== 'contactVoice' ||
            typeof sessionKey !== 'string' || !['offer', 'answer', 'ice-candidate'].includes(type)) return;
        const target = deviceSockets.get(to);
        if (target) target.emit('contact-media-signal', { ...data, from: deviceId });
    });
}

function cleanupMediaDevice(session, deviceId, emit) {
    if (!session?.media) return;
    const media = session.media;
    media.voiceParticipants.delete(deviceId);
    if (media.camera?.ownerDeviceId === deviceId) {
        emit('camera-broadcast-stop', { broadcastId: media.camera.broadcastId, from: deviceId });
        media.camera = null;
    }
    emit('voice-peer-left', { deviceId });
}

module.exports = { registerMediaHandlers, cleanupMediaDevice };
