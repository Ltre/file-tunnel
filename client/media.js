(function attachMediaController(global) {
    const rtcConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ]
    };

    class MediaController {
        constructor(deps) {
            this.deps = deps;
            this.connections = new Map();
            this.pendingCandidates = new Map();
            this.camera = null;
            this.voice = null;
            this.intercom = null;
            this.cameraBroadcast = null;
        }

        socket() { return this.deps.getSocket(); }
        key(kind, sessionKey, peerId) { return `${kind}:${sessionKey}:${peerId}`; }
        log(event, details = {}) { this.deps.log(`media-${event}`, details); }

        emit(event, data) {
            const socket = this.socket();
            if (socket?.connected) socket.emit(event, { sessionId: this.deps.getSessionId(), ...data });
        }

        async getMedia(constraints) {
            if (!global.isSecureContext) {
                throw new Error('摄像头和麦克风只能通过 HTTPS 使用；请改用 HTTPS 域名，或仅在本机使用 http://localhost:3000');
            }
            if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持媒体采集');
            return navigator.mediaDevices.getUserMedia(constraints);
        }

        async startCamera() {
            if (this.camera) return;
            const stream = await this.getMedia({ video: true, audio: true });
            const broadcastId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
            this.camera = { broadcastId, stream };
            this.cameraBroadcast = { broadcastId, ownerDeviceId: this.deps.getDeviceId(), local: true };
            this.deps.onLocalCamera(stream, true);
            this.emit('camera-broadcast-start', { broadcastId });
            this.log('camera-started', { broadcastId });
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

        shouldInitiate(peerId) {
            return peerId && this.deps.getDeviceId().localeCompare(peerId) < 0;
        }

        async createOffer(kind, sessionKey, peerId, stream) {
            const key = this.key(kind, sessionKey, peerId);
            if (this.connections.has(key)) return;
            const pc = this.createConnection(kind, sessionKey, peerId, stream);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.emit('media-signal', { to: peerId, kind, sessionKey, type: 'offer', sdp: offer });
        }

        createConnection(kind, sessionKey, peerId, stream) {
            const key = this.key(kind, sessionKey, peerId);
            const pc = new RTCPeerConnection(rtcConfig);
            this.connections.set(key, pc);
            if (stream) stream.getTracks().forEach(track => pc.addTrack(track, stream));
            pc.onicecandidate = event => {
                if (event.candidate) this.emit('media-signal', {
                    to: peerId, kind, sessionKey, type: 'ice-candidate', candidate: event.candidate
                });
            };
            pc.ontrack = event => this.handleRemoteTrack(kind, sessionKey, peerId, event.streams[0]);
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
                const stream = kind === 'voice' ? this.voice?.stream : null;
                pc = this.createConnection(kind, sessionKey, from, stream);
            }
            if (type === 'offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(sdp));
                await this.flushCandidates(key, pc);
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                this.emit('media-signal', { to: from, kind, sessionKey, type: 'answer', sdp: answer });
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
