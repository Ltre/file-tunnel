(function attachLightTransfer(global) {
    'use strict';

    const PROTOCOL = 'D2L1';
    const DB_NAME = 'drop2tunnel-light-transfer-v1';
    const DB_VERSION = 1;
    const ATOMIC_BLOCK_SIZE = 256;
    const MANIFEST_PART_CHARS = 420;
    const MAX_NETWORK_INDICES = 32;
    const MODES = {
        far: { label: '远距离', blocksPerFrame: 1, fps: 2, qrSize: 560, level: 'H', quiet: 6 },
        normal: { label: '常规距离', blocksPerFrame: 2, fps: 4, qrSize: 500, level: 'Q', quiet: 4 },
        near: { label: '近距离', blocksPerFrame: 4, fps: 6, qrSize: 460, level: 'M', quiet: 3 }
    };

    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();
    let dbPromise = null;
    let options = {};
    let receiverState = null;
    const activeShares = new Map();

    function configure(next = {}) {
        options = { ...options, ...next };
        ensureStyle();
        return api;
    }

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('tasks')) {
                    const store = db.createObjectStore('tasks', { keyPath: 'taskId' });
                    store.createIndex('updatedAt', 'updatedAt');
                }
                if (!db.objectStoreNames.contains('chunks')) {
                    const store = db.createObjectStore('chunks', { keyPath: 'key' });
                    store.createIndex('taskId', 'taskId');
                }
                if (!db.objectStoreNames.contains('receipts')) {
                    const store = db.createObjectStore('receipts', { keyPath: 'id' });
                    store.createIndex('completedAt', 'completedAt');
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('light-transfer-idb-open-failed'));
        });
        return dbPromise;
    }

    async function tx(storeName, mode, callback) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, mode);
            const store = transaction.objectStore(storeName);
            let result;
            try { result = callback(store, transaction); } catch (error) { reject(error); return; }
            transaction.oncomplete = () => resolve(result);
            transaction.onerror = () => reject(transaction.error || new Error('light-transfer-idb-failed'));
            transaction.onabort = () => reject(transaction.error || new Error('light-transfer-idb-aborted'));
        });
    }

    async function getTask(taskId) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const request = db.transaction('tasks', 'readonly').objectStore('tasks').get(taskId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    async function saveTask(task) {
        task.updatedAt = Date.now();
        await tx('tasks', 'readwrite', store => store.put(task));
        return task;
    }

    async function listTasks() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const request = db.transaction('tasks', 'readonly').objectStore('tasks').getAll();
            request.onsuccess = () => resolve((request.result || []).sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt)));
            request.onerror = () => reject(request.error);
        });
    }

    async function listReceipts() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const request = db.transaction('receipts', 'readonly').objectStore('receipts').getAll();
            request.onsuccess = () => resolve((request.result || []).sort((a, b) => Number(b.completedAt) - Number(a.completedAt)));
            request.onerror = () => reject(request.error);
        });
    }

    async function getChunk(taskId, index) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const request = db.transaction('chunks', 'readonly').objectStore('chunks').get(`${taskId}:${index}`);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    async function getChunks(taskId) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const store = db.transaction('chunks', 'readonly').objectStore('chunks');
            const index = store.index('taskId');
            const request = index.getAll(IDBKeyRange.only(taskId));
            request.onsuccess = () => resolve((request.result || []).sort((a, b) => a.index - b.index));
            request.onerror = () => reject(request.error);
        });
    }

    async function saveChunk(taskId, index, data) {
        const existing = await getChunk(taskId, index);
        if (existing) return false;
        const buffer = data instanceof ArrayBuffer
            ? data
            : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        await tx('chunks', 'readwrite', store => store.put({
            key: `${taskId}:${index}`,
            taskId,
            index,
            size: buffer.byteLength,
            data: buffer,
            receivedAt: Date.now()
        }));
        return true;
    }

    async function deleteTaskData(taskId) {
        const chunks = await getChunks(taskId);
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const transaction = db.transaction(['tasks', 'chunks'], 'readwrite');
            transaction.objectStore('tasks').delete(taskId);
            const store = transaction.objectStore('chunks');
            chunks.forEach(chunk => store.delete(chunk.key));
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async function saveReceipt(receipt) {
        await tx('receipts', 'readwrite', store => store.put(receipt));
    }

    function b64url(bytes) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let binary = '';
        const step = 0x8000;
        for (let i = 0; i < data.length; i += step) binary += String.fromCharCode(...data.subarray(i, i + step));
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function unb64url(value) {
        const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
        const binary = atob(padded);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
    }

    async function sha256(bytes) {
        const buffer = bytes instanceof ArrayBuffer
            ? bytes
            : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    }

    function stable(value) {
        if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
        if (value && typeof value === 'object') {
            return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
        }
        return JSON.stringify(value);
    }

    function crc32(bytes) {
        let crc = -1;
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        for (let i = 0; i < data.length; i++) {
            crc ^= data[i];
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
        }
        return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0');
    }

    function makeFrame(body) {
        return `${PROTOCOL}:${JSON.stringify(body)}`;
    }

    function parseFrame(raw) {
        const text = String(raw || '');
        if (!text.startsWith(`${PROTOCOL}:`)) return null;
        try {
            const frame = JSON.parse(text.slice(PROTOCOL.length + 1));
            return frame?.v === 1 && frame?.t ? frame : null;
        } catch (_) {
            return null;
        }
    }

    function safeRecord(record = {}) {
        const copy = JSON.parse(JSON.stringify(record || {}));
        delete copy.sessionId;
        delete copy.favorite;
        delete copy.favoritedAt;
        delete copy.lightTransfer;
        if (copy.fileInfo) copy.fileInfo = safeFileInfo(copy.fileInfo);
        if (Array.isArray(copy.collection?.files)) copy.collection.files = copy.collection.files.map(safeFileInfo);
        return copy;
    }

    function safeFileInfo(fileInfo = {}) {
        const copy = JSON.parse(JSON.stringify(fileInfo || {}));
        for (const key of [
            'data', 'externalFileHandle', 'cacheStoreRef', 'cacheStorage', 'cacheCleared', 'restoreRequested',
            'transferInterrupted', 'isPartial', 'receivedSize', 'mediaFavorite', 'lightTransferTaskId',
            'externalFileAvailable', 'externalFileMissing', 'externalFilePermissionRequired'
        ]) delete copy[key];
        return copy;
    }

    async function prepareShare(bundle = {}) {
        const files = [];
        let offset = 0;
        for (let index = 0; index < (bundle.files || []).length; index++) {
            const source = bundle.files[index];
            const bytes = source.bytes instanceof Uint8Array ? source.bytes : new Uint8Array(source.bytes || 0);
            const hash = await sha256(bytes);
            files.push({
                order: index,
                offset,
                length: bytes.byteLength,
                sha256: hash,
                fileInfo: safeFileInfo(source.fileInfo || {})
            });
            offset += bytes.byteLength;
        }
        if (!files.length) throw new Error('没有可通过光媒分享的文件数据');
        const identity = {
            protocol: PROTOCOL,
            kind: bundle.kind === 'collection' ? 'collection' : 'file',
            tunnelId: String(bundle.tunnelId || ''),
            shortCode: String(bundle.shortCode || ''),
            sourceMessageId: String(bundle.sourceMessageId || ''),
            title: String(bundle.title || files[0]?.fileInfo?.name || '光媒数据'),
            totalSize: offset,
            blockSize: ATOMIC_BLOCK_SIZE,
            blockCount: Math.max(1, Math.ceil(offset / ATOMIC_BLOCK_SIZE)),
            record: safeRecord(bundle.record || {}),
            files
        };
        const taskId = await sha256(textEncoder.encode(stable(identity)));
        const manifest = { ...identity, taskId, createdAt: Number(bundle.createdAt) || Number(bundle.record?.timestamp) || 0 };
        const manifestText = stable(manifest);
        const manifestHash = await sha256(textEncoder.encode(manifestText));
        const parts = [];
        const encodedManifest = b64url(textEncoder.encode(manifestText));
        for (let i = 0; i < encodedManifest.length; i += MANIFEST_PART_CHARS) parts.push(encodedManifest.slice(i, i + MANIFEST_PART_CHARS));
        const providerDeviceId = String(options.getDeviceId?.() || '');
        const networkUrl = options.getNetworkUrl?.(taskId, providerDeviceId) || '';
        const share = {
            taskId,
            manifest,
            manifestHash,
            manifestParts: parts,
            sources: (bundle.files || []).map(source => source.bytes instanceof Uint8Array ? source.bytes : new Uint8Array(source.bytes || 0)),
            totalSize: offset,
            blockCount: identity.blockCount,
            providerDeviceId,
            networkUrl,
            networkEnabled: Boolean(networkUrl),
            senderSalt: hashNumber(providerDeviceId || `${Math.random()}`),
            createdAt: Date.now()
        };
        activeShares.set(taskId, share);
        return share;
    }

    function hashNumber(value) {
        let hash = 2166136261;
        const text = String(value || '');
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    function readGlobalRange(share, start, length) {
        const out = new Uint8Array(length);
        let write = 0;
        let cursor = 0;
        for (const source of share.sources) {
            const sourceStart = cursor;
            const sourceEnd = cursor + source.byteLength;
            const wantedStart = Math.max(start, sourceStart);
            const wantedEnd = Math.min(start + length, sourceEnd);
            if (wantedEnd > wantedStart) {
                const localStart = wantedStart - sourceStart;
                const localEnd = wantedEnd - sourceStart;
                out.set(source.subarray(localStart, localEnd), write);
                write += localEnd - localStart;
            }
            cursor = sourceEnd;
            if (write >= length) break;
        }
        return write === length ? out : out.subarray(0, write);
    }

    function getShareBlocks(share, startIndex, count) {
        const start = Math.max(0, Number(startIndex) || 0);
        const safeCount = Math.max(1, Math.min(Number(count) || 1, share.blockCount - start));
        const byteStart = start * ATOMIC_BLOCK_SIZE;
        const length = Math.min(safeCount * ATOMIC_BLOCK_SIZE, share.totalSize - byteStart);
        return readGlobalRange(share, byteStart, length);
    }

    function createSummaryFrame(share, networkEnabled = true) {
        return makeFrame({
            v: 1, t: share.taskId, k: 's', mh: share.manifestHash,
            z: share.totalSize, bc: share.blockCount, bs: ATOMIC_BLOCK_SIZE,
            n: share.manifest.files.length, q: share.manifest.title,
            ty: share.manifest.kind, si: share.manifest.tunnelId,
            mi: share.manifest.sourceMessageId,
            nu: networkEnabled ? share.networkUrl : ''
        });
    }

    function createManifestFrame(share, partIndex) {
        return makeFrame({
            v: 1, t: share.taskId, k: 'm', mh: share.manifestHash,
            i: partIndex, c: share.manifestParts.length,
            p: share.manifestParts[partIndex]
        });
    }

    function createDataFrame(share, startIndex, count) {
        const bytes = getShareBlocks(share, startIndex, count);
        const actualCount = Math.ceil(bytes.byteLength / ATOMIC_BLOCK_SIZE);
        return makeFrame({
            v: 1, t: share.taskId, k: 'd', s: startIndex,
            c: actualCount, bc: share.blockCount, bs: ATOMIC_BLOCK_SIZE,
            x: crc32(bytes), p: b64url(bytes)
        });
    }

    function ensureStyle() {
        if (document.getElementById('lightTransferStyle')) return;
        const style = document.createElement('style');
        style.id = 'lightTransferStyle';
        style.textContent = `
            .light-transfer-layer{position:fixed;inset:0;z-index:13000;background:#0b0e14;color:#f5f7fb;display:flex;flex-direction:column;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
            .light-transfer-topbar{display:flex;align-items:center;gap:10px;padding:11px 14px;background:#121722;border-bottom:1px solid #252d3b;min-height:48px}
            .light-transfer-title{font-weight:800;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.light-transfer-topbar .spacer{flex:1}
            .light-transfer-btn,.light-transfer-select{border:1px solid #344055;background:#1a2230;color:#f5f7fb;border-radius:8px;padding:8px 10px;font:inherit}.light-transfer-btn{cursor:pointer}.light-transfer-btn.primary{background:#2c65d8;border-color:#2c65d8}.light-transfer-btn.danger{background:#3a1d22;border-color:#6f3039}
            .light-sender-main{flex:1;min-height:0;display:grid;grid-template-rows:minmax(280px,1fr) auto;overflow:hidden}.light-qr-stage{display:grid;place-items:center;padding:18px;overflow:hidden;background:#fff}.light-qr-box{max-width:min(88vw,72vh);max-height:min(88vw,72vh);display:grid;place-items:center}.light-qr-box img,.light-qr-box canvas{max-width:100%;max-height:100%;image-rendering:pixelated}
            .light-info-panel{padding:14px 16px 18px;background:#121722;border-top:1px solid #252d3b;display:grid;gap:10px}.light-info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.light-info-item{background:#181f2b;border:1px solid #283245;border-radius:8px;padding:9px 10px}.light-info-item b{display:block;font-size:12px;color:#8f9bb0;margin-bottom:4px}.light-info-item span{word-break:break-all;font-size:13px}
            .light-receiver-main{flex:1;min-height:0;overflow:auto;padding:14px;display:grid;gap:14px;background:#0b0e14}.light-camera-stage{position:relative;width:min(92vw,760px);aspect-ratio:4/3;margin:auto;background:#000;border-radius:12px;overflow:hidden;border:1px solid #2d3749}.light-camera-stage video{width:100%;height:100%;object-fit:cover}.light-scan-frame{position:absolute;inset:12%;border:2px solid rgba(100,180,255,.88);box-shadow:0 0 0 9999px rgba(0,0,0,.18);pointer-events:none}.light-camera-message{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);background:rgba(0,0,0,.65);padding:6px 10px;border-radius:999px;font-size:12px;white-space:nowrap}
            .light-progress-card{width:min(92vw,760px);margin:auto;display:grid;gap:10px}.light-progress-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.light-progress-bar{height:10px;background:#212a38;border-radius:999px;overflow:hidden;flex:1;min-width:150px}.light-progress-bar>i{display:block;height:100%;background:#4a88ff;width:0}.light-bitmap{width:100%;height:110px;image-rendering:pixelated;background:#111720;border:1px solid #2a3447;border-radius:8px}.light-status{font-size:13px;color:#aeb8c8;line-height:1.5}.light-error{color:#ff9e9e;font-weight:700}.light-preview{border:1px solid #2b3547;background:#151c27;border-radius:10px;padding:10px;display:grid;gap:8px}.light-preview img,.light-preview video{max-width:100%;max-height:320px;margin:auto}.light-preview audio{width:100%}.light-file-status-list{display:grid;gap:5px;font-size:12px;color:#bac3d2}.light-file-status-row{display:flex;gap:8px;justify-content:space-between;border-bottom:1px dashed #2b3547;padding:5px 0}.light-parts-entry{width:min(92vw,760px);margin:auto;display:flex;justify-content:flex-end;padding-bottom:max(18px,env(safe-area-inset-bottom))}
            .light-iframe-layer{position:fixed;inset:0;z-index:13100;background:#fff}.light-iframe-layer iframe{width:100%;height:100%;border:0;display:block}
            @media(max-width:640px){.light-transfer-topbar{padding-top:max(11px,env(safe-area-inset-top))}.light-info-panel{padding-bottom:max(18px,env(safe-area-inset-bottom))}.light-qr-stage{padding:8px}.light-receiver-main{padding:10px}}
        `;
        document.head.appendChild(style);
    }

    function closeLayer(layer) {
        layer?.remove();
    }

    async function openSender(bundle, senderOptions = {}) {
        ensureStyle();
        const share = await prepareShare(bundle);
        document.querySelector('.light-transfer-layer[data-role="sender"]')?.remove();
        const layer = document.createElement('div');
        layer.className = 'light-transfer-layer';
        layer.dataset.role = 'sender';
        layer.innerHTML = `
            <div class="light-transfer-topbar">
                <div class="light-transfer-title">使用光媒分享 · ${escapeHtml(share.manifest.title)}</div>
                <div class="spacer"></div>
                <select class="light-transfer-select" data-light-distance>${Object.entries(MODES).map(([key, mode]) => `<option value="${key}"${key === 'normal' ? ' selected' : ''}>${mode.label}</option>`).join('')}</select>
                <button class="light-transfer-btn" data-light-close>关闭</button>
            </div>
            <div class="light-sender-main">
                <div class="light-qr-stage"><div class="light-qr-box" data-light-qr></div></div>
                <div class="light-info-panel">
                    <div class="light-progress-row">
                        <label><input type="checkbox" data-light-network-provider ${share.networkUrl ? 'checked' : 'disabled'}> 提供网络加速入口</label>
                        <span class="light-status" data-light-frame-status></span>
                    </div>
                    <div class="light-info-grid">
                        <div class="light-info-item"><b>类型</b><span>${share.manifest.kind === 'collection' ? '文件合辑' : '单文件'}</span></div>
                        <div class="light-info-item"><b>文件</b><span>${share.manifest.files.length} 个 / ${formatSize(share.totalSize)}</span></div>
                        <div class="light-info-item"><b>数据块</b><span>${share.blockCount} × ${ATOMIC_BLOCK_SIZE}B</span></div>
                        <div class="light-info-item"><b>任务摘要</b><span>${share.taskId}</span></div>
                        <div class="light-info-item"><b>所属隧道</b><span>${escapeHtml(share.manifest.shortCode || share.manifest.tunnelId || '-')}</span></div>
                        <div class="light-info-item"><b>网络加速</b><span>${share.networkUrl ? '可选；接收端需主动勾选' : '当前不可用'}</span></div>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(layer);
        const qr = layer.querySelector('[data-light-qr]');
        const modeSelect = layer.querySelector('[data-light-distance]');
        const networkToggle = layer.querySelector('[data-light-network-provider]');
        networkToggle.checked = Boolean(share.networkUrl && share.networkEnabled);
        const status = layer.querySelector('[data-light-frame-status]');
        let timer = null;
        let frameNo = 0;
        let manifestFrameNo = 0;
        let dataFrameNo = 0;
        let closed = false;

        const render = () => {
            if (closed || !layer.isConnected) return;
            const mode = MODES[modeSelect.value] || MODES.normal;
            let frame;
            let label;
            // Summary is never more than ~2 seconds away, even in the slow far-distance mode.
            if (frameNo % 4 === 0) {
                frame = createSummaryFrame(share, networkToggle.checked);
                label = '摘要 / Manifest 索引';
            } else if (frameNo % 7 === 0 || frameNo < 3) {
                const part = manifestFrameNo % share.manifestParts.length;
                manifestFrameNo++;
                frame = createManifestFrame(share, part);
                label = `Manifest ${part + 1}/${share.manifestParts.length}`;
            } else {
                const group = mode.blocksPerFrame;
                const groupCount = Math.max(1, Math.ceil(share.blockCount / group));
                const groupOffset = share.senderSalt % groupCount;
                const groupIndex = (groupOffset + dataFrameNo) % groupCount;
                dataFrameNo++;
                const start = groupIndex * group;
                const count = Math.min(group, share.blockCount - start);
                frame = createDataFrame(share, start, count);
                label = `数据块 ${start + 1}–${Math.min(share.blockCount, start + count)}/${share.blockCount}`;
            }
            qr.replaceChildren();
            try {
                new global.QRCode(qr, {
                    text: frame,
                    width: mode.qrSize,
                    height: mode.qrSize,
                    colorDark: '#000000',
                    colorLight: '#ffffff',
                    correctLevel: global.QRCode.CorrectLevel?.[mode.level] ?? global.QRCode.CorrectLevel?.M
                });
                qr.style.padding = `${mode.quiet}px`;
                status.textContent = `${mode.label} · ${mode.fps} fps · ${label}`;
            } catch (error) {
                status.textContent = `二维码帧生成失败：${error.message}`;
            }
            frameNo++;
            clearTimeout(timer);
            timer = setTimeout(render, 1000 / mode.fps);
        };
        const cleanup = () => {
            closed = true;
            clearTimeout(timer);
            closeLayer(layer);
            if (senderOptions.keepNetworkSource !== true) activeShares.delete(share.taskId);
        };
        layer.querySelector('[data-light-close]').addEventListener('click', cleanup);
        networkToggle.addEventListener('change', () => { share.networkEnabled = Boolean(networkToggle.checked && share.networkUrl); });
        modeSelect.addEventListener('change', () => { frameNo = 0; manifestFrameNo = 0; dataFrameNo = 0; render(); });
        render();
        return { taskId: share.taskId, close: cleanup, share };
    }

    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = String(value ?? '');
        return div.innerHTML;
    }

    function formatSize(bytes) {
        let value = Number(bytes) || 0;
        const units = ['B', 'KB', 'MB', 'GB'];
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
        return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
    }

    async function openReceiver(taskId = '') {
        ensureStyle();
        if (receiverState?.layer?.isConnected) await closeReceiver(false);
        const lockedTaskId = String(taskId || '');
        const persisted = lockedTaskId ? await getTask(lockedTaskId) : null;
        const layer = document.createElement('div');
        layer.className = 'light-transfer-layer';
        layer.dataset.role = 'receiver';
        layer.innerHTML = `
            <div class="light-transfer-topbar">
                <div class="light-transfer-title">接收光媒</div><div class="spacer"></div>
                <button class="light-transfer-btn" data-light-pause>暂停扫描</button>
                <button class="light-transfer-btn" data-light-receiver-close>关闭</button>
            </div>
            <div class="light-receiver-main">
                <div class="light-camera-stage">
                    <video autoplay muted playsinline data-light-camera></video>
                    <div class="light-scan-frame"></div>
                    <div class="light-camera-message" data-light-camera-message>正在打开摄像头…</div>
                </div>
                <div class="light-progress-card">
                    <div class="light-progress-row"><strong data-light-summary>${persisted?.summary?.title ? escapeHtml(persisted.summary.title) : '等待识别光媒摘要…'}</strong><span class="spacer"></span><span data-light-percent>0%</span></div>
                    <div class="light-progress-bar"><i data-light-progress></i></div>
                    <canvas class="light-bitmap" data-light-bitmap></canvas>
                    <div class="light-status" data-light-status>从任意动态二维码帧开始扫描即可；Manifest 会高频穿插。</div>
                    <div class="light-progress-row"><label><input type="checkbox" data-light-network> 使用网络加速</label><span class="light-status" data-light-network-status>默认关闭；不会自动联网补块</span></div>
                    <div class="light-file-status-list" data-light-file-list></div>
                    <div class="light-preview" data-light-preview hidden></div>
                </div>
                <div class="light-parts-entry"><button class="light-transfer-btn" data-light-open-parts>继续光媒接收</button></div>
            </div>`;
        document.body.appendChild(layer);
        receiverState = {
            layer,
            taskId: persisted?.taskId || lockedTaskId || '',
            lockedTaskId,
            task: persisted,
            stream: null,
            detector: null,
            detectorTimer: null,
            networkTimer: null,
            paused: false,
            processing: false,
            receivedSet: new Set(),
            previewed: new Set(),
            finalizing: false,
            lastMismatchAt: 0
        };
        const chunks = persisted?.taskId ? await getChunks(persisted.taskId) : [];
        chunks.forEach(chunk => receiverState.receivedSet.add(chunk.index));
        await updateReceiverUi();
        layer.querySelector('[data-light-receiver-close]').addEventListener('click', () => closeReceiver(false));
        layer.querySelector('[data-light-pause]').addEventListener('click', async event => {
            if (receiverState.paused) {
                receiverState.paused = false;
                event.currentTarget.textContent = '暂停扫描';
                await startCameraScanner();
            } else {
                receiverState.paused = true;
                event.currentTarget.textContent = '继续扫描';
                stopCameraScanner();
                setReceiverStatus('扫描已暂停，已接收的数据块和点阵状态已保存到本机。');
            }
        });
        layer.querySelector('[data-light-network]').addEventListener('change', event => {
            if (event.currentTarget.checked) startNetworkAcceleration();
            else stopNetworkAcceleration('网络加速已关闭；继续仅使用光媒。');
        });
        layer.querySelector('[data-light-open-parts]').addEventListener('click', openPartsPage);
        await startCameraScanner();
        return receiverState;
    }

    async function closeReceiver(deleteState = false) {
        if (!receiverState) return;
        stopCameraScanner();
        stopNetworkAcceleration('');
        const layer = receiverState.layer;
        if (deleteState && receiverState.taskId) await deleteTaskData(receiverState.taskId);
        receiverState = null;
        layer?.remove();
    }

    async function startCameraScanner() {
        if (!receiverState || receiverState.paused) return;
        const message = receiverState.layer.querySelector('[data-light-camera-message]');
        if (!navigator.mediaDevices?.getUserMedia) {
            message.textContent = '当前浏览器不支持摄像头访问';
            setReceiverStatus('无法启动连续光媒扫描：浏览器缺少 getUserMedia。', true);
            return;
        }
        if (!global.BarcodeDetector) {
            message.textContent = '当前浏览器缺少连续二维码识别接口';
            setReceiverStatus('当前浏览器没有 BarcodeDetector，无法连续解析动态二维码；建议使用支持 BarcodeDetector 的 Chromium 系浏览器。', true);
            return;
        }
        try {
            receiverState.detector ||= new BarcodeDetector({ formats: ['qr_code'] });
            receiverState.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            });
            const video = receiverState.layer.querySelector('[data-light-camera]');
            video.srcObject = receiverState.stream;
            await video.play().catch(() => {});
            message.textContent = '请将动态二维码置于扫描框内';
            scheduleDetect(120);
        } catch (error) {
            message.textContent = `摄像头启动失败：${error.message}`;
            setReceiverStatus(`摄像头启动失败：${error.message}`, true);
        }
    }

    function stopCameraScanner() {
        if (!receiverState) return;
        clearTimeout(receiverState.detectorTimer);
        receiverState.detectorTimer = null;
        receiverState.stream?.getTracks().forEach(track => track.stop());
        receiverState.stream = null;
        const video = receiverState.layer?.querySelector('[data-light-camera]');
        if (video) video.srcObject = null;
    }

    function scheduleDetect(delay = 120) {
        if (!receiverState || receiverState.paused || !receiverState.stream) return;
        clearTimeout(receiverState.detectorTimer);
        receiverState.detectorTimer = setTimeout(detectLoop, delay);
    }

    async function detectLoop() {
        if (!receiverState || receiverState.paused || receiverState.processing) return scheduleDetect(120);
        const video = receiverState.layer.querySelector('[data-light-camera]');
        if (!video || video.readyState < 2) return scheduleDetect(120);
        receiverState.processing = true;
        try {
            const results = await receiverState.detector.detect(video);
            for (const result of results || []) {
                const frame = parseFrame(result.rawValue);
                if (frame) await acceptFrame(frame, 'optical');
            }
        } catch (_) {
            // Detection failures are expected while focus/exposure changes.
        } finally {
            if (receiverState) receiverState.processing = false;
            scheduleDetect(110);
        }
    }

    async function acceptFrame(frame, source = 'optical') {
        if (!receiverState) return false;
        if (receiverState.lockedTaskId && frame.t !== receiverState.lockedTaskId) {
            const now = Date.now();
            if (now - receiverState.lastMismatchAt > 1500) {
                receiverState.lastMismatchAt = now;
                setReceiverStatus('扫描到的摘要与上次残片任务不一致：不是同一个光媒数据，已禁止合并。', true);
            }
            return false;
        }
        if (receiverState.taskId && frame.t !== receiverState.taskId) {
            const now = Date.now();
            if (now - receiverState.lastMismatchAt > 1500) {
                receiverState.lastMismatchAt = now;
                setReceiverStatus('扫描范围内出现了另一项光媒数据，当前任务已锁定，未混入新数据。', true);
            }
            return false;
        }
        if (!receiverState.taskId) receiverState.taskId = frame.t;
        let task = receiverState.task || await getTask(frame.t) || {
            taskId: frame.t,
            status: 'receiving',
            createdAt: Date.now(),
            receivedCount: 0,
            receivedBytes: 0,
            networkSources: [],
            manifestParts: []
        };
        if (frame.mh && task.manifestHash && String(frame.mh) !== String(task.manifestHash)) {
            setReceiverStatus('扫描到相同任务标识但 Manifest 摘要不同的数据源，已拒绝混合。', true);
            return false;
        }
        if (frame.mh && !task.manifestHash) task.manifestHash = String(frame.mh);
        if (frame.k === 's') {
            task.summary = {
                title: String(frame.q || '光媒数据'),
                kind: frame.ty === 'collection' ? 'collection' : 'file',
                totalSize: Number(frame.z) || 0,
                blockCount: Number(frame.bc) || 0,
                blockSize: Number(frame.bs) || ATOMIC_BLOCK_SIZE,
                fileCount: Number(frame.n) || 1,
                tunnelId: String(frame.si || ''),
                sourceMessageId: String(frame.mi || ''),
                manifestHash: String(frame.mh || '')
            };
            task.blockCount ||= task.summary.blockCount;
            task.totalSize ||= task.summary.totalSize;
            if (frame.nu && !task.networkSources.includes(frame.nu)) task.networkSources.push(String(frame.nu));
            task.lastSource = source;
            await saveTask(task);
        } else if (frame.k === 'm') {
            if (!Array.isArray(task.manifestParts)) task.manifestParts = [];
            if (Number.isInteger(frame.i) && frame.i >= 0 && frame.i < Number(frame.c) && frame.p) {
                task.manifestPartCount = Number(frame.c);
                task.manifestHash ||= String(frame.mh || '');
                task.manifestParts[frame.i] = String(frame.p);
                if (task.manifestParts.filter(Boolean).length === task.manifestPartCount) {
                    try {
                        const bytes = unb64url(task.manifestParts.join(''));
                        const text = textDecoder.decode(bytes);
                        const actualHash = await sha256(textEncoder.encode(text));
                        if (task.manifestHash && actualHash !== task.manifestHash) throw new Error('Manifest SHA-256 不一致');
                        const manifest = JSON.parse(text);
                        if (manifest.taskId !== task.taskId) throw new Error('Manifest 任务身份不一致');
                        task.manifest = manifest;
                        task.blockCount = Number(manifest.blockCount) || task.blockCount;
                        task.totalSize = Number(manifest.totalSize) || task.totalSize;
                        task.manifestVerified = true;
                    } catch (error) {
                        task.manifestError = error.message;
                    }
                }
                await saveTask(task);
            }
        } else if (frame.k === 'd') {
            const blockSize = Number(frame.bs) || ATOMIC_BLOCK_SIZE;
            if (blockSize !== ATOMIC_BLOCK_SIZE) return false;
            const bytes = unb64url(frame.p || '');
            if (crc32(bytes) !== String(frame.x || '').toLowerCase()) return false;
            const start = Number(frame.s);
            const count = Number(frame.c);
            if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 1 || count > 16) return false;
            task.blockCount ||= Number(frame.bc) || 0;
            let cursor = 0;
            let added = 0;
            let bytesAdded = 0;
            for (let n = 0; n < count; n++) {
                const index = start + n;
                if (task.blockCount && index >= task.blockCount) break;
                const remaining = bytes.byteLength - cursor;
                if (remaining <= 0) break;
                const expected = task.totalSize && index === task.blockCount - 1
                    ? Math.max(1, task.totalSize - index * ATOMIC_BLOCK_SIZE)
                    : Math.min(ATOMIC_BLOCK_SIZE, remaining);
                const block = bytes.slice(cursor, cursor + expected);
                cursor += expected;
                if (!block.byteLength) break;
                if (await saveChunk(task.taskId, index, block)) {
                    receiverState.receivedSet.add(index);
                    added++;
                    bytesAdded += block.byteLength;
                }
            }
            if (added) {
                task.receivedCount = Number(task.receivedCount || 0) + added;
                task.receivedBytes = Number(task.receivedBytes || 0) + bytesAdded;
                task.lastSource = source;
                task.status = 'receiving';
                await saveTask(task);
            }
        }
        receiverState.task = task;
        await updateReceiverUi();
        await maybePreviewCompletedFiles();
        await maybeFinalizeTask();
        return true;
    }

    function setReceiverStatus(message, error = false) {
        const element = receiverState?.layer?.querySelector('[data-light-status]');
        if (!element) return;
        element.textContent = message;
        element.classList.toggle('light-error', error);
    }

    async function updateReceiverUi() {
        if (!receiverState?.layer) return;
        const task = receiverState.task || (receiverState.taskId ? await getTask(receiverState.taskId) : null);
        if (task) receiverState.task = task;
        const summary = task?.summary;
        const blockCount = Number(task?.blockCount || summary?.blockCount) || 0;
        const received = receiverState.receivedSet.size;
        const percent = blockCount ? Math.min(100, received / blockCount * 100) : 0;
        receiverState.layer.querySelector('[data-light-summary]').textContent = summary?.title || task?.manifest?.title || '等待识别光媒摘要…';
        receiverState.layer.querySelector('[data-light-percent]').textContent = `${percent.toFixed(percent >= 10 ? 1 : 2)}%`;
        receiverState.layer.querySelector('[data-light-progress]').style.width = `${percent}%`;
        const networkStatus = receiverState.layer.querySelector('[data-light-network-status]');
        const sources = task?.networkSources || [];
        if (receiverState.layer.querySelector('[data-light-network]').checked) {
            networkStatus.textContent = sources.length ? `网络补块已启用 · ${sources.length} 个提供方` : '已勾选，但当前二维码尚未提供网络加速链接';
        } else {
            networkStatus.textContent = sources.length ? `检测到 ${sources.length} 个网络加速入口；默认未使用` : '默认关闭；不会自动联网补块';
        }
        drawBitmap(blockCount, receiverState.receivedSet);
        renderFileStatus(task);
        if (summary && !task?.manifestError) {
            setReceiverStatus(`任务 ${task.taskId.slice(0, 12)}… · 已收 ${received}/${blockCount || '?'} 块 · ${formatSize(task.receivedBytes || 0)} / ${formatSize(task.totalSize || summary.totalSize || 0)}${task.manifestVerified ? ' · Manifest 已校验' : ' · 正在补齐 Manifest'}`);
        }
        if (task?.manifestError) setReceiverStatus(`Manifest 校验失败：${task.manifestError}`, true);
    }

    function drawBitmap(count, set) {
        const canvas = receiverState?.layer?.querySelector('[data-light-bitmap]');
        if (!canvas) return;
        const total = Math.max(1, Number(count) || 1);
        const cols = Math.max(16, Math.min(256, Math.ceil(Math.sqrt(total * 2))));
        const rows = Math.ceil(total / cols);
        canvas.width = cols;
        canvas.height = rows;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#222a36';
        ctx.fillRect(0, 0, cols, rows);
        ctx.fillStyle = '#72f0a3';
        set.forEach(index => {
            if (index >= 0 && index < total) ctx.fillRect(index % cols, Math.floor(index / cols), 1, 1);
        });
    }

    function requiredBlockRange(file, manifest) {
        const start = Math.floor(Number(file.offset || 0) / manifest.blockSize);
        const end = Math.ceil((Number(file.offset || 0) + Number(file.length || 0)) / manifest.blockSize) - 1;
        return [start, Math.max(start, end)];
    }

    function isFileRangeComplete(file, manifest, set) {
        const [start, end] = requiredBlockRange(file, manifest);
        for (let index = start; index <= end; index++) if (!set.has(index)) return false;
        return true;
    }

    function renderFileStatus(task) {
        const list = receiverState?.layer?.querySelector('[data-light-file-list]');
        if (!list) return;
        list.replaceChildren();
        const manifest = task?.manifest;
        if (!manifest?.files?.length) return;
        manifest.files.forEach(file => {
            const complete = isFileRangeComplete(file, manifest, receiverState.receivedSet);
            const row = document.createElement('div');
            row.className = 'light-file-status-row';
            const name = document.createElement('span');
            name.textContent = file.fileInfo?.name || `文件 ${file.order + 1}`;
            const state = document.createElement('span');
            state.textContent = complete ? '数据块已齐，待/已校验' : '接收中';
            row.append(name, state);
            list.appendChild(row);
        });
    }

    async function buildRangeBytes(taskId, offset, length) {
        const startBlock = Math.floor(offset / ATOMIC_BLOCK_SIZE);
        const endBlock = Math.ceil((offset + length) / ATOMIC_BLOCK_SIZE) - 1;
        const merged = new Uint8Array((endBlock - startBlock + 1) * ATOMIC_BLOCK_SIZE);
        let written = 0;
        for (let index = startBlock; index <= endBlock; index++) {
            const chunk = await getChunk(taskId, index);
            if (!chunk?.data) throw new Error(`缺少数据块 ${index}`);
            const bytes = new Uint8Array(chunk.data);
            merged.set(bytes, written);
            written += bytes.byteLength;
        }
        const localOffset = offset - startBlock * ATOMIC_BLOCK_SIZE;
        return merged.slice(localOffset, localOffset + length);
    }

    async function maybePreviewCompletedFiles() {
        const task = receiverState?.task;
        const manifest = task?.manifest;
        if (!manifest?.files?.length) return;
        for (const file of manifest.files) {
            const key = `${task.taskId}:${file.order}`;
            if (receiverState.previewed.has(key) || !isFileRangeComplete(file, manifest, receiverState.receivedSet)) continue;
            receiverState.previewed.add(key);
            try {
                const bytes = await buildRangeBytes(task.taskId, file.offset, file.length);
                const hash = await sha256(bytes);
                if (hash !== file.sha256) throw new Error('文件 SHA-256 校验失败');
                renderEarlyPreview(file, bytes);
                break;
            } catch (error) {
                receiverState.previewed.delete(key);
                setReceiverStatus(`已齐文件校验失败：${file.fileInfo?.name || ''} · ${error.message}`, true);
            }
        }
    }

    function renderEarlyPreview(file, bytes) {
        const panel = receiverState?.layer?.querySelector('[data-light-preview]');
        if (!panel) return;
        const type = String(file.fileInfo?.type || 'application/octet-stream');
        panel.hidden = false;
        panel.replaceChildren();
        const title = document.createElement('strong');
        title.textContent = `已可提前预览：${file.fileInfo?.name || '文件'}`;
        panel.appendChild(title);
        const blob = new Blob([bytes], { type });
        const url = URL.createObjectURL(blob);
        let media = null;
        if (type.startsWith('image/')) media = document.createElement('img');
        else if (type.startsWith('video/')) { media = document.createElement('video'); media.controls = true; }
        else if (type.startsWith('audio/')) { media = document.createElement('audio'); media.controls = true; }
        if (media) {
            media.src = url;
            panel.appendChild(media);
            media.addEventListener('loadeddata', () => setTimeout(() => URL.revokeObjectURL(url), 60000), { once: true });
        } else {
            URL.revokeObjectURL(url);
            const text = document.createElement('div');
            text.className = 'light-status';
            text.textContent = `${formatSize(bytes.byteLength)} · 此文件类型不可直接预览，但该文件已完整接收并通过校验。`;
            panel.appendChild(text);
        }
    }

    async function verifyManifestIdentity(manifest) {
        const identity = { ...manifest };
        delete identity.taskId;
        delete identity.createdAt;
        const expected = await sha256(textEncoder.encode(stable(identity)));
        return expected === manifest.taskId;
    }

    async function maybeFinalizeTask() {
        const state = receiverState;
        const task = state?.task;
        const manifest = task?.manifest;
        if (!state || state.finalizing || !manifest || !task.manifestVerified) return;
        if (state.receivedSet.size < Number(manifest.blockCount)) return;
        state.finalizing = true;
        try {
            setReceiverStatus('数据块已齐，正在进行完整性校验…');
            if (!await verifyManifestIdentity(manifest)) throw new Error('任务摘要/Manifest 身份校验失败');
            const files = [];
            for (const file of manifest.files) {
                const bytes = await buildRangeBytes(task.taskId, file.offset, file.length);
                const hash = await sha256(bytes);
                if (hash !== file.sha256) throw new Error(`${file.fileInfo?.name || '文件'} 的 SHA-256 不一致`);
                files.push({ fileInfo: file.fileInfo, bytes, sha256: hash, order: file.order });
            }
            let result = {};
            if (typeof options.finalizeTask === 'function') result = await options.finalizeTask({ task, manifest, files }) || {};
            const receipt = {
                id: `${task.taskId}:${Date.now()}`,
                taskId: task.taskId,
                completedAt: Date.now(),
                title: manifest.title,
                kind: manifest.kind,
                fileCount: manifest.files.length,
                totalSize: manifest.totalSize,
                tunnelId: manifest.tunnelId,
                messageId: result.messageId || '',
                recordUrl: result.recordUrl || ''
            };
            await saveReceipt(receipt);
            await deleteTaskData(task.taskId);
            stopCameraScanner();
            stopNetworkAcceleration('');
            setReceiverStatus('光媒数据已完整接收并通过整体/文件完整性校验，已生成正式隧道传输记录。');
            const panel = state.layer.querySelector('[data-light-preview]');
            panel.hidden = false;
            const done = document.createElement('div');
            done.className = 'light-progress-row';
            done.innerHTML = `<strong>接收完成</strong><span class="spacer"></span>${receipt.recordUrl ? `<a class="light-transfer-btn primary" href="${escapeHtml(receipt.recordUrl)}">所在传输记录</a>` : ''}`;
            panel.appendChild(done);
            state.task = null;
            state.taskId = '';
            state.receivedSet.clear();
        } catch (error) {
            setReceiverStatus(`完整性校验/写入失败：${error.message}。残片仍保留，可继续扫描补块。`, true);
        } finally {
            if (receiverState === state) state.finalizing = false;
        }
    }

    function missingIndices(limit = MAX_NETWORK_INDICES) {
        const task = receiverState?.task;
        const count = Number(task?.blockCount || task?.summary?.blockCount) || 0;
        const out = [];
        for (let i = 0; i < count && out.length < limit; i++) if (!receiverState.receivedSet.has(i)) out.push(i);
        return out;
    }

    function startNetworkAcceleration() {
        if (!receiverState) return;
        clearTimeout(receiverState.networkTimer);
        const tick = async () => {
            if (!receiverState || !receiverState.layer.querySelector('[data-light-network]').checked) return;
            const task = receiverState.task;
            const sources = task?.networkSources || [];
            const indices = missingIndices();
            if (!sources.length || !indices.length) {
                receiverState.networkTimer = setTimeout(tick, 900);
                await updateReceiverUi();
                return;
            }
            const url = sources[Math.floor(Date.now() / 1000) % sources.length];
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    cache: 'no-store',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ indices })
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
                for (const chunk of data.chunks || []) {
                    await acceptFrame({
                        v: 1,
                        t: task.taskId,
                        k: 'd',
                        s: chunk.s,
                        c: chunk.c,
                        bc: task.blockCount,
                        bs: ATOMIC_BLOCK_SIZE,
                        x: chunk.x,
                        p: chunk.p
                    }, 'network');
                }
            } catch (error) {
                const status = receiverState?.layer?.querySelector('[data-light-network-status]');
                if (status) status.textContent = `网络补块暂不可用：${error.message}`;
            }
            if (receiverState) receiverState.networkTimer = setTimeout(tick, 650);
        };
        tick();
    }

    function stopNetworkAcceleration(message = '') {
        if (!receiverState) return;
        clearTimeout(receiverState.networkTimer);
        receiverState.networkTimer = null;
        if (message) {
            const status = receiverState.layer.querySelector('[data-light-network-status]');
            if (status) status.textContent = message;
        }
    }

    function getNetworkChunks(taskId, indices = []) {
        const share = activeShares.get(String(taskId || ''));
        if (!share || !share.networkEnabled) return null;
        const unique = [...new Set((Array.isArray(indices) ? indices : []).map(Number).filter(index => Number.isInteger(index) && index >= 0 && index < share.blockCount))].slice(0, MAX_NETWORK_INDICES);
        return {
            taskId: share.taskId,
            chunks: unique.map(index => {
                const bytes = getShareBlocks(share, index, 1);
                return { s: index, c: 1, x: crc32(bytes), p: b64url(bytes) };
            })
        };
    }

    function handleNetworkChunkRequest(data, respond) {
        const result = getNetworkChunks(data?.taskId, data?.indices);
        respond?.(result || { taskId: String(data?.taskId || ''), chunks: [], unavailable: true });
        return Boolean(result);
    }

    function openPartsPage() {
        document.querySelector('.light-iframe-layer')?.remove();
        const layer = document.createElement('div');
        layer.className = 'light-iframe-layer';
        layer.innerHTML = '<iframe src="/light-file-parts" title="继续光媒接收"></iframe>';
        document.body.appendChild(layer);
    }

    function closePartsPage() {
        document.querySelector('.light-iframe-layer')?.remove();
    }

    global.addEventListener('message', event => {
        if (event.origin !== location.origin || !event.data) return;
        if (event.data.type === 'light-parts-close') {
            closePartsPage();
        } else if (event.data.type === 'light-transfer-resume' && event.data.taskId) {
            closePartsPage();
            openReceiver(event.data.taskId).catch(error => options.toast?.(`继续光媒接收失败：${error.message}`));
        }
    });

    const api = {
        PROTOCOL,
        ATOMIC_BLOCK_SIZE,
        MODES,
        configure,
        openSender,
        openReceiver,
        closeReceiver,
        listTasks,
        listReceipts,
        getTask,
        getChunks,
        getNetworkChunks,
        handleNetworkChunkRequest,
        openPartsPage,
        closePartsPage,
        parseFrame,
        _acceptFrame: acceptFrame
    };

    global.Drop2TunnelLightTransfer = api;
})(window);
