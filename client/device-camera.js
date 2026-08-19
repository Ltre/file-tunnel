(function attachDeviceCameraBridge(global) {
    const DEFAULT_RTC_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ],
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
    };

    function uid() {
        if (global.crypto?.randomUUID) return global.crypto.randomUUID();
        return `camera-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    class DeviceCameraBridge {
        constructor(options = {}) {
            this.getSocket = options.getSocket || (() => options.socket || null);
            this.getSelfDeviceId = options.getSelfDeviceId || (() => '');
            this.getSelfDeviceName = options.getSelfDeviceName || (() => '当前设备');
            this.getRtcConfig = options.getRtcConfig || (() => DEFAULT_RTC_CONFIG);
            this.toast = options.toast || (() => {});
            this.externalLog = options.externalLog || ((event, details) => console.warn(`[external-dependency][webrtc-ice-services][${event}]`, details));
            this.sessions = new Map();
            this.pendingRequests = new Map();
            this.boundSocket = null;
            this.bindSocket();
        }

        bindSocket() {
            const socket = this.getSocket();
            if (!socket || socket === this.boundSocket) return;
            this.boundSocket = socket;
            socket.on('device-camera-request', data => this.handleRequest(data));
            socket.on('device-camera-response', data => this.handleResponse(data));
            socket.on('device-camera-signal', data => this.handleSignal(data));
            socket.on('device-camera-stop', data => this.stopSession(data?.requestId, false));
        }

        emit(event, payload) {
            this.bindSocket();
            const socket = this.getSocket();
            if (!socket?.connected) throw new Error('对方连接通道当前不可用');
            socket.emit(event, payload);
        }

        async openRemoteCamera(targetDeviceId, targetDeviceName = '对方设备') {
            return this.beginRequest(targetDeviceId, targetDeviceName, 'open-remote');
        }

        async shareMyCamera(targetDeviceId, targetDeviceName = '对方设备') {
            return this.beginRequest(targetDeviceId, targetDeviceName, 'share-mine');
        }

        beginRequest(targetDeviceId, targetDeviceName, mode) {
            const from = this.getSelfDeviceId();
            if (!from || !targetDeviceId || from === targetDeviceId) throw new Error('摄像头共享目标无效');
            const requestId = uid();
            this.pendingRequests.set(requestId, {
                requestId, targetDeviceId, targetDeviceName, mode, initiated: true, createdAt: Date.now()
            });
            this.toast(mode === 'open-remote' ? '已请求打开对方摄像头' : '已请求向对方共享摄像头');
            // Emit asynchronously so that socket connection has a chance to be ready.
            // The synchronous emit() can throw if the socket isn't connected yet on
            // the very first click — which is why the first click appeared to do nothing.
            this._safeEmit('device-camera-request', {
                requestId,
                from,
                to: targetDeviceId,
                mode,
                senderName: this.getSelfDeviceName(),
                createdAt: Date.now()
            });
            return requestId;
        }

        _safeEmit(event, payload) {
            this.bindSocket();
            const socket = this.getSocket();
            if (!socket) {
                this.toast('连接通道未就绪，请稍后重试');
                return;
            }
            if (!socket.connected) {
                // Queue the emit for when the socket reconnects
                const once = () => {
                    socket.off('connect', once);
                    try { socket.emit(event, payload); }
                    catch (err) { this.toast(`发送失败：${err.message}`); }
                };
                socket.on('connect', once);
                this.toast('正在等待连接通道就绪…');
                return;
            }
            try { socket.emit(event, payload); }
            catch (err) { this.toast(`发送失败：${err.message}`); }
        }

        async handleRequest(data = {}) {
            const self = this.getSelfDeviceId();
            if (!data.requestId || data.to !== self || !data.from) return;
            const senderName = String(data.senderName || '对方设备');
            const mode = data.mode === 'share-mine' ? 'share-mine' : 'open-remote';
            const message = mode === 'open-remote'
                ? `${senderName} 请求打开你的摄像头并查看实时画面，是否允许？`
                : `${senderName} 想把摄像头实时画面共享给你，是否接收？`;
            const accepted = global.confirm ? global.confirm(message) : false;
            this.pendingRequests.set(data.requestId, {
                requestId: data.requestId,
                targetDeviceId: data.from,
                targetDeviceName: senderName,
                mode,
                initiated: false,
                createdAt: Date.now()
            });
            this.emit('device-camera-response', {
                requestId: data.requestId,
                from: self,
                to: data.from,
                mode,
                accepted
            });
            if (!accepted) {
                this.pendingRequests.delete(data.requestId);
                return;
            }
            if (mode === 'open-remote') {
                try {
                    await this.startSending(data.requestId, data.from, senderName);
                } catch (error) {
                    this.toast(`摄像头启动失败：${error.message}`);
                    this.stopSession(data.requestId, true);
                }
            } else {
                this.createViewer(data.requestId, senderName, true);
            }
        }

        async handleResponse(data = {}) {
            const pending = this.pendingRequests.get(data.requestId);
            if (!pending || data.to !== this.getSelfDeviceId()) return;
            // Guard against duplicate / late responses — a response was already
            // processed for this requestId, so ignore the stale one instead of
            // showing a spurious "对方拒绝了摄像头请求" toast.
            if (pending.responseProcessed) return;
            pending.responseProcessed = true;
            if (data.accepted === false) {
                this.pendingRequests.delete(data.requestId);
                this.toast('对方拒绝了摄像头请求');
                return;
            }
            if (pending.mode === 'share-mine') {
                try {
                    await this.startSending(data.requestId, pending.targetDeviceId, pending.targetDeviceName);
                } catch (error) {
                    this.toast(`摄像头启动失败：${error.message}`);
                    this.stopSession(data.requestId, true);
                }
            } else {
                this.createViewer(data.requestId, pending.targetDeviceName, true);
            }
        }

        createPeer(requestId, targetDeviceId) {
            const existing = this.sessions.get(requestId);
            if (existing?.pc) return existing.pc;
            const pc = new RTCPeerConnection(this.getRtcConfig() || DEFAULT_RTC_CONFIG);
            const session = existing || { requestId, targetDeviceId, stream: null, remoteStream: null, overlay: null, pendingIce: [] };
            session.pc = pc;
            session.pendingIce ||= [];
            session.targetDeviceId = targetDeviceId;
            this.sessions.set(requestId, session);
            pc.onicecandidate = event => {
                if (!event.candidate) return;
                try {
                    this.emit('device-camera-signal', {
                        requestId,
                        from: this.getSelfDeviceId(),
                        to: targetDeviceId,
                        kind: 'ice',
                        candidate: event.candidate
                    });
                } catch (_) {}
            };
            pc.onicecandidateerror = event => {
                this.externalLog('device-camera-ice-server-error', {
                    dependency: 'webrtc-ice-services',
                    requestId,
                    targetDeviceId,
                    url: event.url || '',
                    errorCode: Number(event.errorCode) || 0,
                    errorText: event.errorText || '',
                    warning: '摄像头 WebRTC 使用的公共 STUN/TURN、DNS、浏览器策略或网络环境可能已变化。'
                });
            };
            pc.ontrack = event => {
                session.remoteStream ||= new MediaStream();
                event.streams?.[0]?.getTracks().forEach(track => {
                    if (!session.remoteStream.getTracks().some(item => item.id === track.id)) session.remoteStream.addTrack(track);
                });
                if (!event.streams?.[0]) session.remoteStream.addTrack(event.track);
                this.attachRemoteStream(requestId, session.remoteStream);
            };
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === 'failed') {
                    this.externalLog('device-camera-peer-failed', {
                        dependency: 'webrtc-ice-services', requestId, targetDeviceId,
                        warning: '摄像头 WebRTC 连接失败；请检查 STUN/TURN 可达性与 NAT/防火墙策略。'
                    });
                }
                if (['failed', 'closed'].includes(pc.connectionState)) this.stopSession(requestId, false);
            };
            return pc;
        }

        async startSending(requestId, targetDeviceId, targetDeviceName) {
            if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持摄像头访问');
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' } },
                audio: false
            });
            const pc = this.createPeer(requestId, targetDeviceId);
            const session = this.sessions.get(requestId);
            session.stream = stream;
            stream.getTracks().forEach(track => pc.addTrack(track, stream));
            this.createLocalSendingPanel(requestId, targetDeviceName, stream);
            const offer = await pc.createOffer({ offerToReceiveVideo: false, offerToReceiveAudio: false });
            await pc.setLocalDescription(offer);
            this.emit('device-camera-signal', {
                requestId,
                from: this.getSelfDeviceId(),
                to: targetDeviceId,
                kind: 'offer',
                description: pc.localDescription
            });
        }

        async handleSignal(data = {}) {
            if (!data.requestId || data.to !== this.getSelfDeviceId() || !data.from) return;
            const pending = this.pendingRequests.get(data.requestId) || {};
            const pc = this.createPeer(data.requestId, data.from);
            try {
                if (data.kind === 'offer' && data.description) {
                    await pc.setRemoteDescription(data.description);
                    const session = this.sessions.get(data.requestId);
                    for (const candidate of session?.pendingIce?.splice(0) || []) await pc.addIceCandidate(candidate);
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    this.emit('device-camera-signal', {
                        requestId: data.requestId,
                        from: this.getSelfDeviceId(),
                        to: data.from,
                        kind: 'answer',
                        description: pc.localDescription
                    });
                    this.createViewer(data.requestId, pending.targetDeviceName || data.senderName || '对方设备', true);
                } else if (data.kind === 'answer' && data.description) {
                    await pc.setRemoteDescription(data.description);
                    const session = this.sessions.get(data.requestId);
                    for (const candidate of session?.pendingIce?.splice(0) || []) await pc.addIceCandidate(candidate);
                } else if (data.kind === 'ice' && data.candidate) {
                    const session = this.sessions.get(data.requestId);
                    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
                    else session?.pendingIce?.push(data.candidate);
                }
            } catch (error) {
                console.warn('device camera signal failed', error);
                this.toast(`摄像头连接失败：${error.message}`);
            }
        }

        ensureStyle() {
            if (document.getElementById('deviceCameraBridgeStyle')) return;
            const style = document.createElement('style');
            style.id = 'deviceCameraBridgeStyle';
            style.textContent = `
                .device-camera-overlay{position:fixed;inset:0;z-index:12050;background:#05070b;display:flex;flex-direction:column;color:#fff}
                .device-camera-topbar{display:flex;align-items:center;gap:10px;padding:12px 14px;background:rgba(12,16,24,.88);z-index:2}
                .device-camera-title{font-weight:800;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
                .device-camera-status{margin-left:auto;color:#aeb8ca;font-size:13px}
                .device-camera-close{border:0;border-radius:8px;padding:8px 12px;background:#242b38;color:#fff;cursor:pointer}
                .device-camera-video-wrap{position:relative;flex:1;min-height:0;display:grid;place-items:center;overflow:hidden}
                .device-camera-video{width:100%;height:100%;object-fit:contain;background:#000}
                .device-camera-hint{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);padding:7px 11px;border-radius:999px;background:rgba(0,0,0,.55);font-size:13px;white-space:nowrap}
            `;
            document.head.appendChild(style);
        }

        createViewer(requestId, name, waiting = false) {
            this.ensureStyle();
            const session = this.sessions.get(requestId) || { requestId };
            if (session.overlay?.isConnected) return session.overlay;
            const overlay = document.createElement('div');
            overlay.className = 'device-camera-overlay';
            overlay.innerHTML = `
                <div class="device-camera-topbar">
                    <div class="device-camera-title">${this.escape(name)} · 摄像头共享</div>
                    <div class="device-camera-status">${waiting ? '等待实时画面…' : '实时画面'}</div>
                    <button class="device-camera-close" type="button">结束</button>
                </div>
                <div class="device-camera-video-wrap">
                    <video class="device-camera-video" autoplay playsinline></video>
                    <div class="device-camera-hint">WebRTC 端到端实时视频</div>
                </div>`;
            overlay.querySelector('.device-camera-close').addEventListener('click', () => this.stopSession(requestId, true));
            document.body.appendChild(overlay);
            session.overlay = overlay;
            this.sessions.set(requestId, session);
            if (session.remoteStream) this.attachRemoteStream(requestId, session.remoteStream);
            return overlay;
        }

        createLocalSendingPanel(requestId, name, stream) {
            const overlay = this.createViewer(requestId, `正在共享给 ${name}`, false);
            const video = overlay.querySelector('video');
            video.muted = true;
            video.srcObject = stream;
            overlay.querySelector('.device-camera-status').textContent = '正在发送';
            return overlay;
        }

        attachRemoteStream(requestId, stream) {
            const session = this.sessions.get(requestId);
            const overlay = session?.overlay || this.createViewer(requestId, session?.targetDeviceName || '对方设备', false);
            const video = overlay.querySelector('video');
            video.muted = false;
            video.srcObject = stream;
            overlay.querySelector('.device-camera-status').textContent = '已连接';
            video.play().catch(() => {});
        }

        stopSession(requestId, notify = true) {
            if (!requestId) return;
            const session = this.sessions.get(requestId);
            const pending = this.pendingRequests.get(requestId);
            session?.stream?.getTracks().forEach(track => track.stop());
            session?.remoteStream?.getTracks().forEach(track => track.stop());
            try { session?.pc?.close(); } catch (_) {}
            session?.overlay?.remove();
            this.sessions.delete(requestId);
            this.pendingRequests.delete(requestId);
            if (notify && (session?.targetDeviceId || pending?.targetDeviceId)) {
                try {
                    this.emit('device-camera-stop', {
                        requestId,
                        from: this.getSelfDeviceId(),
                        to: session?.targetDeviceId || pending?.targetDeviceId
                    });
                } catch (_) {}
            }
        }

        escape(value) {
            const div = document.createElement('div');
            div.textContent = String(value || '');
            return div.innerHTML;
        }
    }

    global.DeviceCameraBridge = DeviceCameraBridge;
})(window);
