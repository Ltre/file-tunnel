(function attachMediaController(global) {
    function normalizeIceServers(value) {
        return Array.isArray(value)
            ? value.filter(item => item && typeof item === 'object' && item.urls)
            : [];
    }

    function getRtcConfig() {
        const runtime = global.TUNNEL_CONFIG?.RTC || {};
        const defaults = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ];
        const configured = [
            ...normalizeIceServers(runtime.iceServers),
            ...normalizeIceServers(runtime.turnServers)
        ];
        return {
            iceServers: runtime.replaceDefaultIceServers === true ? configured : [...defaults, ...configured],
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        };
    }

    class MediaController {
        constructor(deps) {
            this.deps = deps;
            this.connections = new Map();
            this.pendingCandidates = new Map();
            this.camera = null;
            this.voice = null;
            this.intercom = null;
            this.cameraBroadcast = null;
            this.contactCall = null;
        }

        socket() { return this.deps.getSocket(); }
        key(kind, sessionKey, peerId) { return `${kind}:${sessionKey}:${peerId}`; }
        log(event, details = {}) { this.deps.log(`media-${event}`, details); }

        emit(event, data) {
            const socket = this.socket();
            if (socket?.connected) socket.emit(event, { sessionId: this.deps.getSessionId(), ...data });
        }

        emitGlobal(event, data) {
            const socket = this.socket();
            if (socket?.connected) socket.emit(event, data);
        }

        async getMediaDeviceSummary() {
            if (!navigator.mediaDevices?.enumerateDevices) return {};
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                return devices.reduce((summary, device) => {
                    summary[device.kind] = (summary[device.kind] || 0) + 1;
                    return summary;
                }, {});
            } catch {
                return {};
            }
        }

        getMediaErrorMessage(error, constraints) {
            const needsAudio = Boolean(constraints?.audio);
            const needsVideo = Boolean(constraints?.video);
            if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
                const deviceName = needsAudio && needsVideo ? '摄像头或麦克风' : (needsVideo ? '摄像头' : '麦克风');
                return `未找到可用的${deviceName}。请检查设备连接、系统隐私设置和浏览器站点权限。`;
            }
            if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
                return '浏览器或系统拒绝了媒体权限。请在地址栏的站点设置中允许摄像头和麦克风。';
            }
            if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
                return '摄像头或麦克风正被其它程序占用，或设备驱动无法访问。';
            }
            if (error?.name === 'OverconstrainedError') {
                return '当前媒体设备不满足浏览器请求的条件。';
            }
            return `无法启动媒体采集：${error?.message || '未知错误'}`;
        }

        async getMedia(constraints) {
            if (!global.isSecureContext) {
                throw new Error('摄像头和麦克风只能通过 HTTPS 使用；请改用 HTTPS 域名，或仅在本机使用 http://localhost');
            }
            if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持媒体采集');
            try {
                return await navigator.mediaDevices.getUserMedia(constraints);
            } catch (error) {
                this.log('capture-failed', {
                    errorName: error?.name,
                    errorMessage: error?.message,
                    constraints,
                    deviceSummary: await this.getMediaDeviceSummary(),
                    secureContext: global.isSecureContext
                });
                const wrapped = new Error(this.getMediaErrorMessage(error, constraints));
                wrapped.name = error?.name || 'MediaCaptureError';
                throw wrapped;
            }
        }

        async startCamera() {
            if (this.camera) return;
            let stream;
            let includesAudio = true;
            try {
                stream = await this.getMedia({ video: true, audio: true });
            } catch (error) {
                if (error?.name !== 'NotFoundError' && error?.name !== 'DevicesNotFoundError') throw error;
                stream = await this.getMedia({ video: true, audio: false });
                includesAudio = false;
                this.log('camera-audio-fallback', { reason: 'audio-device-not-found' });
            }
            const broadcastId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
            this.camera = { broadcastId, stream };
            this.cameraBroadcast = { broadcastId, ownerDeviceId: this.deps.getDeviceId(), local: true };
            this.deps.onLocalCamera(stream, true);
            this.emit('camera-broadcast-start', { broadcastId });
            this.log('camera-started', { broadcastId, includesAudio });
        }

        stopCamera() {
            if (!this.camera) return;
            const { broadcastId, stream } = this.camera;
            stream.getTracks().forEach(track => track.stop());
            this.closeByPrefix(`camera:${broadcastId}:`);
            this.emit('camera-broadcast-stop', { broadcastId });
            this.camera = null;
            this.cameraBroadcast = null;
            this.deps.onLocalCamera(null, false);
            this.log('camera-stopped', { broadcastId });
        }

        handleCameraBroadcastStart(data) {
            if (!data?.broadcastId || !data?.from || data.from === this.deps.getDeviceId()) return;
            this.closeByPrefix('camera:');
            if (this.cameraBroadcast && !this.cameraBroadcast.local) this.deps.onRemoteCamera(null);
            this.cameraBroadcast = { broadcastId: data.broadcastId, ownerDeviceId: data.from, local: false };
            this.emit('camera-viewer-ready', { broadcastId: data.broadcastId, to: data.from });
            this.log('camera-viewer-ready', { broadcastId: data.broadcastId, ownerDeviceId: data.from });
        }

        async handleCameraViewerReady(data) {
            if (!this.camera || data?.broadcastId !== this.camera.broadcastId || !data?.from) return;
            await this.createOffer('camera', data.broadcastId, data.from, this.camera.stream);
        }

        handleCameraBroadcastStop(data) {
            if (!data?.broadcastId) return;
            if (this.camera?.broadcastId === data.broadcastId) {
                this.camera.stream.getTracks().forEach(track => track.stop());
                this.closeByPrefix(`camera:${data.broadcastId}:`);
                this.camera = null;
                this.cameraBroadcast = null;
                this.deps.onLocalCamera(null, false);
            }
            this.closeByPrefix(`camera:${data.broadcastId}:`);
            if (this.cameraBroadcast?.broadcastId === data.broadcastId && !this.cameraBroadcast.local) {
                this.cameraBroadcast = null;
                this.deps.onRemoteCamera(null);
            }
        }

        async joinVoice() {
            if (this.voice) return;
            const stream = await this.getMedia({ audio: true, video: false });
            this.voice = { stream };
            this.emit('voice-join');
            this.deps.onVoiceState(true);
            this.log('voice-joined');
        }

        leaveVoice() {
            if (!this.voice) return;
            this.voice.stream.getTracks().forEach(track => track.stop());
            this.closeByPrefix('voice:room:');
            this.emit('voice-leave');
            this.voice = null;
            this.deps.onVoiceState(false);
            this.log('voice-left');
        }

        async handleVoiceState(data) {
            if (!this.voice || !Array.isArray(data?.participants)) return;
            for (const peerId of data.participants) {
                if (this.shouldInitiate(peerId)) await this.createOffer('voice', 'room', peerId, this.voice.stream);
            }
        }

        async handleVoicePeerJoined(data) {
            if (this.voice && data?.deviceId && this.shouldInitiate(data.deviceId)) {
                await this.createOffer('voice', 'room', data.deviceId, this.voice.stream);
            }
        }

        handleVoicePeerLeft(data) {
            if (data?.deviceId) this.closeConnection(this.key('voice', 'room', data.deviceId));
        }

        async startIntercom(targetIds) {
            if (this.intercom) this.stopIntercom();
            const recipients = [...new Set(targetIds)].filter(id => id && id !== this.deps.getDeviceId());
            if (!recipients.length) throw new Error('没有可用的对讲机接收设备');
            const stream = await this.getMedia({ audio: true, video: false });
            const intercomId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
            this.intercom = { intercomId, stream, recipients };
            await Promise.all(recipients.map(id => this.createOffer('intercom', intercomId, id, stream)));
            this.deps.onIntercomState(true, recipients);
            this.log('intercom-started', { intercomId, recipients });
        }

        stopIntercom() {
            if (!this.intercom) return;
            const { intercomId, stream, recipients } = this.intercom;
            stream.getTracks().forEach(track => track.stop());
            this.closeByPrefix(`intercom:${intercomId}:`);
            this.emit('intercom-stop', { intercomId, recipients });
            this.intercom = null;
            this.deps.onIntercomState(false, []);
            this.log('intercom-stopped', { intercomId });
        }

        handleIntercomStop(data) {
            if (!data?.intercomId || !data?.from) return;
            this.closeConnection(this.key('intercom', data.intercomId, data.from));
        }

        async startContactCall(contact) {
            if (!contact?.deviceId) throw new Error('联系人设备无效');
            if (this.contactCall) this.endContactCall('replaced');
            const callId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
            const stream = await this.getMedia({ audio: true, video: false });
            this.contactCall = { callId, peerId: contact.deviceId, stream, state: 'dialing', startedAt: Date.now(), contact };
            this.emitGlobal('contact-call-request', {
                callId,
                to: contact.deviceId,
                caller: this.deps.getContactSelfProfile()
            });
            this.deps.onContactCallState({ state: 'dialing', callId, contact });
            this.log('contact-call-dialing', { callId, peerId: contact.deviceId });
        }

        async acceptContactCall(call) {
            if (!call?.callId || !call?.from) return;
            if (this.contactCall) this.endContactCall('replaced');
            const stream = await this.getMedia({ audio: true, video: false });
            this.contactCall = {
                callId: call.callId,
                peerId: call.from,
                stream,
                state: 'active',
                startedAt: Date.now(),
                contact: call.caller || { deviceId: call.from }
            };
            this.emitGlobal('contact-call-accepted', { callId: call.callId, to: call.from, callee: this.deps.getContactSelfProfile() });
            this.deps.onContactCallState({ state: 'active', callId: call.callId, contact: this.contactCall.contact, startedAt: this.contactCall.startedAt });
            this.log('contact-call-accepted', { callId: call.callId, peerId: call.from });
        }

        rejectContactCall(call, reason = 'rejected') {
            if (!call?.callId || !call?.from) return;
            this.emitGlobal('contact-call-rejected', { callId: call.callId, to: call.from, reason });
            this.deps.onContactCallState({ state: 'idle' });
        }

        async handleContactCallAccepted(data) {
            if (!this.contactCall || data?.callId !== this.contactCall.callId || data?.from !== this.contactCall.peerId) return;
            this.contactCall.state = 'active';
            this.contactCall.startedAt = Date.now();
            if (data.callee) this.contactCall.contact = { ...this.contactCall.contact, ...data.callee, deviceId: data.from };
            await this.createOffer('contactVoice', data.callId, data.from, this.contactCall.stream);
            this.deps.onContactCallState({ state: 'active', callId: data.callId, contact: this.contactCall.contact, startedAt: this.contactCall.startedAt });
        }

        handleContactCallRejected(data) {
            if (!this.contactCall || data?.callId !== this.contactCall.callId) return;
            this.endContactCall(data?.reason || 'rejected', false);
        }

        endContactCall(reason = 'ended', notify = true) {
            if (!this.contactCall) return;
            const { callId, peerId, stream } = this.contactCall;
            stream?.getTracks().forEach(track => track.stop());
            this.closeConnection(this.key('contactVoice', callId, peerId));
            if (notify) this.emitGlobal('contact-call-ended', { callId, to: peerId, reason });
            this.contactCall = null;
            this.deps.onContactCallState({ state: 'idle', reason });
            this.log('contact-call-ended', { callId, peerId, reason });
        }

        handleContactCallEnded(data) {
            if (!this.contactCall || data?.callId !== this.contactCall.callId) return;
            this.endContactCall(data?.reason || 'remote-ended', false);
        }

        shouldInitiate(peerId) {
            return peerId && this.deps.getDeviceId().localeCompare(peerId) < 0;
        }

        async createOffer(kind, sessionKey, peerId, stream) {
            const key = this.key(kind, sessionKey, peerId);
            if (this.connections.has(key)) return;
            const pc = this.createConnection(kind, sessionKey, peerId, stream);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
                this.sendMediaSignal({ to: peerId, kind, sessionKey, type: 'offer', sdp: offer });
        }

        createConnection(kind, sessionKey, peerId, stream) {
            const key = this.key(kind, sessionKey, peerId);
            const pc = new RTCPeerConnection(getRtcConfig());
            this.connections.set(key, pc);
            if (stream) stream.getTracks().forEach(track => pc.addTrack(track, stream));
            pc.onicecandidate = event => {
                if (event.candidate) this.sendMediaSignal({
                    to: peerId, kind, sessionKey, type: 'ice-candidate', candidate: event.candidate
                });
            };
            pc.ontrack = event => {
                const stream = event.streams?.[0] || new MediaStream([event.track]);
                this.handleRemoteTrack(kind, sessionKey, peerId, stream);
            };
            pc.onconnectionstatechange = () => {
                if (['failed', 'closed'].includes(pc.connectionState)) this.closeConnection(key, false);
            };
            return pc;
        }

        handleRemoteTrack(kind, sessionKey, peerId, stream) {
            if (kind === 'camera') this.deps.onRemoteCamera(stream, { sessionKey, peerId });
            else this.deps.onRemoteAudio(kind, sessionKey, peerId, stream);
            this.log('remote-track', { kind, sessionKey, peerId });
        }

        async handleSignal(data) {
            const { from, kind, sessionKey, type, sdp, candidate } = data || {};
            if (!from || !kind || !sessionKey || !type) return;
            const key = this.key(kind, sessionKey, from);
            let pc = this.connections.get(key);
            if (!pc) {
                const stream = kind === 'voice'
                    ? this.voice?.stream
                    : (kind === 'contactVoice' ? this.contactCall?.stream : null);
                pc = this.createConnection(kind, sessionKey, from, stream);
            }
            if (type === 'offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(sdp));
                await this.flushCandidates(key, pc);
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                this.sendMediaSignal({ to: from, kind, sessionKey, type: 'answer', sdp: answer });
            } else if (type === 'answer') {
                await pc.setRemoteDescription(new RTCSessionDescription(sdp));
                await this.flushCandidates(key, pc);
            } else if (type === 'ice-candidate') {
                if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(candidate));
                else {
                    const pending = this.pendingCandidates.get(key) || [];
                    pending.push(candidate);
                    this.pendingCandidates.set(key, pending);
                }
            }
        }

        sendMediaSignal(data) {
            if (data.kind === 'contactVoice') {
                this.emitGlobal('contact-media-signal', data);
            } else {
                this.emit('media-signal', data);
            }
        }

        async flushCandidates(key, pc) {
            const pending = this.pendingCandidates.get(key) || [];
            this.pendingCandidates.delete(key);
            for (const candidate of pending) await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }

        closeByPrefix(prefix) {
            Array.from(this.connections.keys()).filter(key => key.startsWith(prefix)).forEach(key => this.closeConnection(key));
        }

        closeConnection(key, close = true) {
            const pc = this.connections.get(key);
            this.connections.delete(key);
            this.pendingCandidates.delete(key);
            if (close && pc && pc.signalingState !== 'closed') pc.close();
        }
    }

    global.MediaController = MediaController;
})(window);
