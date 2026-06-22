(function attachFileAssetTransfer(global) {
    const CHUNK_SIZE = 64 * 1024;
    const BUFFER_LIMIT = 512 * 1024;
    const P2P_TIMEOUT = 1500;

    class FileAssetTransfer {
        constructor(deps) {
            this.deps = deps;
            this.requests = new Map();
            this.desiredAssets = new Map();
            this.transfers = new Map();
            this.p2pUnavailablePeers = new Map();
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
                ownerDeviceId: asset.ownerDeviceId
            };
        }

        async request(assetId, preferredProviderId) {
            const socket = this.socket();
            this.desiredAssets.set(assetId, preferredProviderId);
            if (!socket || !socket.connected || this.requests.has(assetId)) return;
            this.requests.set(assetId, Date.now());
            socket.emit('file-asset-request', {
                sessionId: this.deps.getSessionId(),
                assetId,
                preferredProviderId
            });
            this.log('requested', { assetId, preferredProviderId });
            setTimeout(() => this.requests.delete(assetId), 30000);
        }

        handleAvailable(data) {
            const asset = data && data.asset;
            if (!asset || !asset.id || !this.desiredAssets.has(asset.id)) return;
            this.requests.delete(asset.id);
            this.request(asset.id, asset.ownerDeviceId || data.from);
        }

        async handleRequest(data) {
            const { asset, from } = data || {};
            if (!asset || !asset.id || !from) return;
            const stored = await this.deps.load(asset.id);
            if (!stored || !stored.data) {
                this.emitUnavailable(asset.id, from, 'provider-missing-local-data');
                return;
            }

            try {
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
                const channel = peer.createDataChannel(`file-asset:${asset.id}`, { ordered: true });
                this.setupChannel(from, asset.id, channel);
                if (!await this.waitForChannel(channel)) {
                    throw new Error('File asset channel timed out');
                }
                await this.sendViaDataChannel(channel, stored);
            } catch (err) {
                this.p2pUnavailablePeers.set(from, Date.now() + 30000);
                this.log('send-p2p-failed', { assetId: asset.id, peerDeviceId: from, error: err.message });
                try {
                    await this.sendViaSocketRelay(from, stored);
                } catch (relayErr) {
                    this.log('send-relay-failed', { assetId: asset.id, peerDeviceId: from, error: relayErr.message });
                    this.emitUnavailable(asset.id, from, 'asset-transfer-failed');
                }
            }
        }

        emitUnavailable(assetId, to, reason) {
            const socket = this.socket();
            if (!socket || !socket.connected) return;
            socket.emit('file-asset-unavailable', {
                sessionId: this.deps.getSessionId(), assetId, to, reason
            });
        }

        setupChannel(deviceId, assetId, channel) {
            channel.binaryType = 'arraybuffer';
            channel.onmessage = event => this.handleChannelMessage(deviceId, assetId, event.data, channel)
                .catch(err => {
                    this.transfers.delete(assetId);
                    this.log('receive-failed', { assetId, peerDeviceId: deviceId, error: err.message });
                    channel.close();
                });
            channel.onopen = () => this.p2pUnavailablePeers.delete(deviceId);
        }

        handleIncomingChannel(deviceId, channel) {
            const match = /^file-asset:([a-zA-Z0-9-]+)$/.exec(channel.label || '');
            if (!match) return false;
            this.setupChannel(deviceId, match[1], channel);
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

        async sendViaDataChannel(channel, asset) {
            const metadata = this.metadata(asset);
            channel.send(JSON.stringify({ type: 'file-asset-start', asset: metadata }));
            for (let offset = 0; offset < asset.data.byteLength; offset += CHUNK_SIZE) {
                if (channel.readyState !== 'open') throw new Error('File asset channel closed');
                await this.waitForBuffer(channel);
                channel.send(asset.data.slice(offset, Math.min(offset + CHUNK_SIZE, asset.data.byteLength)));
                this.deps.onProgress(asset.id, asset.name, Math.min(99, Math.floor((offset + CHUNK_SIZE) * 100 / asset.data.byteLength)), 'sending');
            }
            channel.send(JSON.stringify({ type: 'file-asset-complete', assetId: asset.id }));
            this.deps.onProgress(asset.id, asset.name, 100, 'sending');
            this.log('sent-p2p', { asset: metadata });
        }

        async sendViaSocketRelay(deviceId, asset) {
            const socket = this.socket();
            if (!socket || !socket.connected) throw new Error('Socket is not connected');
            const metadata = this.metadata(asset);
            socket.emit('file-asset-relay-start', {
                sessionId: this.deps.getSessionId(), to: deviceId, asset: metadata
            });
            for (let offset = 0; offset < asset.data.byteLength; offset += CHUNK_SIZE) {
                socket.emit('file-asset-relay-chunk', {
                    sessionId: this.deps.getSessionId(), to: deviceId, assetId: asset.id,
                    chunk: asset.data.slice(offset, Math.min(offset + CHUNK_SIZE, asset.data.byteLength))
                });
                this.deps.onProgress(asset.id, asset.name, Math.min(99, Math.floor((offset + CHUNK_SIZE) * 100 / asset.data.byteLength)), 'sending-relay');
                await new Promise(resolve => setTimeout(resolve, 1));
            }
            socket.emit('file-asset-relay-complete', {
                sessionId: this.deps.getSessionId(), to: deviceId, assetId: asset.id
            });
            this.deps.onProgress(asset.id, asset.name, 100, 'sending-relay');
            this.log('sent-relay', { asset: metadata, peerDeviceId: deviceId });
        }

        begin(assetId, asset, deviceId, transport) {
            if (!asset || asset.id !== assetId || !Number.isFinite(asset.size) || asset.size <= 0) {
                throw new Error('Invalid file asset metadata');
            }
            this.transfers.set(assetId, {
                asset, from: deviceId, transport, chunks: [], receivedSize: 0, pendingChunks: Promise.resolve()
            });
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
            this.requests.delete(assetId);
            this.desiredAssets.delete(assetId);
            this.deps.onProgress(assetId, stored.name, 100, 'received');
            await this.announce(stored);
            await this.deps.onReceived(stored);
            this.log('received', { asset: this.metadata(stored), peerDeviceId: deviceId, transport });
        }

        async handleChannelMessage(deviceId, assetId, data, channel) {
            if (typeof data !== 'string') return this.queueChunk(assetId, data);
            const message = JSON.parse(data);
            if (message.type === 'file-asset-start') return this.begin(assetId, message.asset, deviceId, 'p2p');
            if (message.type === 'file-asset-complete' && message.assetId === assetId) {
                await this.complete(assetId, deviceId, 'p2p');
                channel.close();
            }
        }

        handleRelayStart(data) {
            const { asset, from } = data || {};
            if (!asset || !asset.id || !from) return;
            try { this.begin(asset.id, asset, from, 'socket-relay'); } catch (err) { this.log('relay-rejected', { assetId: asset.id, error: err.message }); }
        }

        handleRelayChunk(data) {
            const { assetId, chunk } = data || {};
            if (assetId && chunk) this.queueChunk(assetId, chunk).catch(err => this.log('relay-failed', { assetId, error: err.message }));
        }

        handleRelayComplete(data) {
            const { assetId, from } = data || {};
            if (assetId && from) this.complete(assetId, from, 'socket-relay').catch(err => this.log('relay-failed', { assetId, error: err.message }));
        }

        handleUnavailable(data) {
            const { assetId, reason } = data || {};
            if (!assetId) return;
            const requested = this.desiredAssets.has(assetId);
            this.requests.delete(assetId);
            if (!requested) return;
            this.deps.onUnavailable(assetId, reason);
            this.log('unavailable', { assetId, reason });
        }

        cancel(assetId) {
            if (!assetId) return;
            this.requests.delete(assetId);
            this.desiredAssets.delete(assetId);
            this.transfers.delete(assetId);
            this.log('cancelled', { assetId });
        }
    }

    global.FileAssetTransfer = FileAssetTransfer;
})(window);
