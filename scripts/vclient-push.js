'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const { readControlToken } = require('../vclient');

const MAX_ASSET_SIZE = 1024 * 1024 * 1024;
const MAX_COLLECTION_FILES = 500;
const RELAY_CHUNK_SIZE = 240 * 1024;
const VALID_SESSION_ID = /^[a-zA-Z0-9_-]{8,64}$/;
const VALID_SHORT_CODE = /^[a-zA-Z0-9]{5}$/;

function usage() {
    return [
        '将服务器本地文件直接推送并缓存到已启用的 VClient 节点。',
        '',
        '单文件：',
        '  npm run vclient:push -- --tunnel <短码或长ID> --file <文件> [--remark <备注>]',
        '',
        '合辑（重复 --file，或指定一个目录中的直属文件）：',
        '  npm run vclient:push -- --tunnel <短码或长ID> --file <文件1> --file <文件2> [--name <合辑名>]',
        '  npm run vclient:push -- --tunnel <短码或长ID> --collection <目录> [--name <合辑名>]',
        '',
        '可选：--server <URL> --token-file <路径> --timeout <秒> --remark <备注>'
    ].join('\n');
}

function takeValue(argv, index, option) {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} 缺少参数`);
    return value;
}

function parseArguments(argv = []) {
    const result = { files: [], collection: '', tunnel: '', remark: '', name: '', server: '', tokenFile: '', timeoutSeconds: 1800, help: false };
    for (let index = 0; index < argv.length; index++) {
        const option = argv[index];
        if (option === '--help' || option === '-h') {
            result.help = true;
        } else if (option === '--file') {
            result.files.push(takeValue(argv, index, option));
            index++;
        } else if (['--collection', '--tunnel', '--remark', '--name', '--server', '--token-file', '--timeout'].includes(option)) {
            const value = takeValue(argv, index, option);
            index++;
            if (option === '--collection') result.collection = value;
            if (option === '--tunnel') result.tunnel = value;
            if (option === '--remark') result.remark = value;
            if (option === '--name') result.name = value;
            if (option === '--server') result.server = value;
            if (option === '--token-file') result.tokenFile = value;
            if (option === '--timeout') result.timeoutSeconds = Number(value);
        } else {
            throw new Error(`未知参数：${option}`);
        }
    }
    if (!result.help) {
        if (!result.tunnel) throw new Error('请通过 --tunnel 指定隧道短码或长 ID');
        if (!VALID_SHORT_CODE.test(result.tunnel) && !VALID_SESSION_ID.test(result.tunnel)) {
            throw new Error('隧道参数必须是 5 位短码或 8～64 位长 ID');
        }
        if (!result.files.length && !result.collection) throw new Error('请至少指定一个 --file，或通过 --collection 指定目录');
        if (!Number.isFinite(result.timeoutSeconds) || result.timeoutSeconds < 10) throw new Error('--timeout 至少为 10 秒');
    }
    result.remark = String(result.remark || '').trim().slice(0, 2000);
    result.name = String(result.name || '').trim().slice(0, 120);
    return result;
}

async function defaultServerUrl(environment = process.env) {
    if (environment.VCLIENT_SERVER_URL) return String(environment.VCLIENT_SERVER_URL).trim();
    let port = 80;
    try {
        const config = JSON.parse(await fs.promises.readFile(path.resolve('tunnel.config.json'), 'utf8'));
        port = Number(config?.serverPort) || port;
    } catch (_) {}
    return `http://127.0.0.1:${port}`;
}

async function collectInputFiles(options) {
    const inputs = options.files.map(value => path.resolve(value));
    if (options.collection) {
        const directory = path.resolve(options.collection);
        const stat = await fs.promises.stat(directory).catch(() => null);
        if (!stat?.isDirectory()) throw new Error(`合辑目录不存在：${directory}`);
        const entries = await fs.promises.readdir(directory, { withFileTypes: true });
        entries.filter(entry => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
            .forEach(entry => inputs.push(path.join(directory, entry.name)));
    }
    const unique = Array.from(new Set(inputs));
    if (!unique.length) throw new Error('没有找到可推送的文件（合辑目录只读取直属普通文件）');
    if (unique.length > MAX_COLLECTION_FILES) throw new Error(`合辑最多包含 ${MAX_COLLECTION_FILES} 个文件`);
    const files = [];
    for (const filePath of unique) {
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (!stat?.isFile()) throw new Error(`文件不存在或不是普通文件：${filePath}`);
        if (stat.size <= 0) throw new Error(`暂不支持空文件：${filePath}`);
        if (stat.size > MAX_ASSET_SIZE) throw new Error(`单文件不能超过 1GB：${filePath}`);
        files.push({ path: filePath, name: path.basename(filePath), size: stat.size });
    }
    return files;
}

function mimeType(fileName) {
    const extension = path.extname(fileName).toLowerCase();
    return ({
        '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
        '.pdf': 'application/pdf', '.zip': 'application/zip', '.json': 'application/json', '.txt': 'text/plain'
    })[extension] || 'application/octet-stream';
}

function createPushPayload(files, options, deviceId, now = Date.now()) {
    const assets = files.map(file => ({
        id: crypto.randomBytes(16).toString('base64url'),
        name: file.name,
        type: mimeType(file.name),
        size: file.size,
        ownerDeviceId: deviceId,
        timestamp: now,
        sender: deviceId,
        senderName: '服务器 Shell',
        isAsset: true,
        remark: options.remark
    }));
    const common = {
        id: crypto.randomUUID(),
        timestamp: now,
        sender: deviceId,
        senderName: '服务器 Shell',
        remark: options.remark
    };
    const message = assets.length === 1 && !options.collection
        ? { ...common, type: 'file', fileInfo: assets[0] }
        : {
            ...common,
            type: 'collection',
            collection: {
                id: crypto.randomUUID(),
                name: options.name || (options.collection ? path.basename(path.resolve(options.collection)) : '服务器推送合辑'),
                files: assets,
                count: assets.length,
                totalSize: assets.reduce((sum, asset) => sum + asset.size, 0),
                remark: options.remark
            }
        };
    return { assets, message, filesByAssetId: new Map(assets.map((asset, index) => [asset.id, files[index]])) };
}

function waitForEvent(socket, event, options = {}) {
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || 30000);
    const predicate = options.predicate || (() => true);
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            socket.off(event, onEvent);
            socket.off('error', onError);
            socket.off('connect_error', onConnectError);
            if (options.errorEvent) socket.off(options.errorEvent, onError);
        };
        const onEvent = payload => {
            if (!predicate(payload)) return;
            cleanup();
            resolve(payload);
        };
        const onError = payload => {
            cleanup();
            reject(new Error(payload?.message || payload?.code || payload?.error || String(payload || '服务器拒绝请求')));
        };
        const onConnectError = error => onError(error);
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(options.timeoutMessage || `等待 ${event} 超时`));
        }, timeoutMs);
        socket.on(event, onEvent);
        socket.on('error', onError);
        socket.on('connect_error', onConnectError);
        if (options.errorEvent) socket.on(options.errorEvent, onError);
    });
}

function emitWithAck(socket, event, payload, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
            if (error) return reject(error);
            if (response?.ok === false) return reject(new Error(response.reason || response.error || `${event} 被拒绝`));
            resolve(response || { ok: true });
        });
    });
}

function formatBytes(value) {
    const size = Number(value) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
    return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function pushToVClient(options, environment = process.env) {
    const files = await collectInputFiles(options);
    const serverUrl = options.server || await defaultServerUrl(environment);
    const tokenFile = options.tokenFile || environment.VCLIENT_TOKEN_FILE || environment.VCLIENT_CONTROL_TOKEN_FILE ||
        path.resolve('.tunnel-data', 'vclient-control.token');
    const token = await readControlToken({ token: environment.VCLIENT_TOKEN || environment.VCLIENT_CONTROL_TOKEN, tokenFile });
    const deadline = Date.now() + options.timeoutSeconds * 1000;
    const remaining = () => Math.max(1, deadline - Date.now());
    const deviceId = crypto.randomUUID();
    const socket = io(serverUrl, {
        autoConnect: false,
        reconnection: false,
        auth: { clientType: 'server-shell', vclientToken: token, language: 'zh-Hans' }
    });
    try {
        console.log(`[VClient Push] 正在连接 ${serverUrl}`);
        const connected = waitForEvent(socket, 'connect', { timeoutMs: Math.min(remaining(), 30000), timeoutMessage: '连接主服务超时' });
        socket.connect();
        await connected;

        let sessionId = options.tunnel;
        if (VALID_SHORT_CODE.test(options.tunnel)) {
            const resolved = waitForEvent(socket, 'short-code-session', {
                timeoutMs: Math.min(remaining(), 30000), errorEvent: 'short-code-error', timeoutMessage: '解析隧道短码超时'
            });
            socket.emit('join-by-short-code', { shortCode: options.tunnel });
            sessionId = String((await resolved)?.sessionId || '');
        }
        if (!VALID_SESSION_ID.test(sessionId)) throw new Error('服务端没有返回有效的隧道长 ID');

        const joined = waitForEvent(socket, 'session-devices', {
            timeoutMs: Math.min(remaining(), 30000), timeoutMessage: '加入隧道超时'
        });
        socket.emit('join-session', {
            sessionId,
            deviceId,
            deviceName: '服务器 Shell 推送',
            deviceModel: `Node.js ${process.version}`,
            clientType: 'server-shell'
        });
        const joinPayload = await joined;
        const initialDevices = Array.isArray(joinPayload?.devices) ? joinPayload.devices : [];
        let vclient = initialDevices.find(device => device?.clientType === 'vclient');
        if (!vclient) {
            console.log('[VClient Push] 缓存节点尚未进入隧道，正在等待…');
            vclient = await waitForEvent(socket, 'device-joined', {
                timeoutMs: Math.min(remaining(), 60000),
                predicate: device => device?.clientType === 'vclient',
                timeoutMessage: '缓存节点未在线；请确认独立 VClient 进程已启动且该隧道已启用缓存节点'
            });
        }
        const vclientDeviceId = String(vclient.deviceId || '');
        if (!vclientDeviceId) throw new Error('缓存节点设备信息无效');
        console.log(`[VClient Push] 已进入隧道 ${sessionId}，缓存节点 ${vclientDeviceId}`);

        const payload = createPushPayload(files, options, deviceId);
        const completions = new Map();
        for (const asset of payload.assets) {
            let resolve;
            let reject;
            const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
            completions.set(asset.id, { promise, resolve, reject, done: false });
        }
        const active = new Set();
        socket.on('file-asset-request', request => {
            const asset = request?.asset;
            const file = payload.filesByAssetId.get(String(asset?.id || ''));
            const completion = completions.get(String(asset?.id || ''));
            if (!file || !completion || completion.done || request?.from !== vclientDeviceId || active.has(asset.id)) return;
            active.add(asset.id);
            (async () => {
                const requestId = String(request.requestId || '');
                const attemptId = crypto.randomBytes(12).toString('base64url');
                socket.emit('file-asset-transfer-status', {
                    sessionId, assetId: asset.id, to: vclientDeviceId, status: 'started', requestId
                });
                const started = await emitWithAck(socket, 'file-asset-relay-start', {
                    sessionId, to: vclientDeviceId, asset, attemptId, requestId
                }, Math.min(remaining(), 60000));
                if (!started?.skipped) {
                    const handle = await fs.promises.open(file.path, 'r');
                    let position = 0;
                    let lastReportedPercent = -1;
                    try {
                        while (position < file.size) {
                            const buffer = Buffer.allocUnsafe(Math.min(RELAY_CHUNK_SIZE, file.size - position));
                            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
                            if (!bytesRead) throw new Error('读取文件时意外到达结尾');
                            await emitWithAck(socket, 'file-asset-relay-chunk', {
                                sessionId, to: vclientDeviceId, assetId: asset.id, attemptId,
                                chunk: bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead)
                            }, Math.min(remaining(), 60000));
                            position += bytesRead;
                            const percent = Math.floor(position * 100 / file.size);
                            if (percent === 100 || percent >= lastReportedPercent + 5) {
                                lastReportedPercent = percent;
                                console.log(`[VClient Push] ${file.name}：${percent}%（${formatBytes(position)} / ${formatBytes(file.size)}）`);
                            }
                        }
                    } finally {
                        await handle.close();
                    }
                    await emitWithAck(socket, 'file-asset-relay-complete', {
                        sessionId, to: vclientDeviceId, assetId: asset.id, attemptId
                    }, Math.min(remaining(), 90000));
                }
                socket.emit('file-asset-transfer-status', {
                    sessionId, assetId: asset.id, to: vclientDeviceId, status: 'completed', requestId
                });
                completion.done = true;
                completion.resolve();
                console.log(`[VClient Push] 已由缓存节点确认落盘：${file.name}`);
            })().catch(error => {
                socket.emit('file-asset-transfer-status', {
                    sessionId, assetId: asset.id, to: vclientDeviceId, status: 'failed', requestId: request?.requestId
                });
                completion.reject(error);
            }).finally(() => active.delete(asset.id));
        });

        payload.assets.forEach(asset => socket.emit('file-asset-available', { sessionId, asset }));
        const messageAck = waitForEvent(socket, 'message-ack', {
            timeoutMs: Math.min(remaining(), 30000),
            predicate: ack => ack?.messageId === payload.message.id,
            timeoutMessage: '等待传输记录写入确认超时'
        });
        socket.emit('message', { sessionId, message: payload.message });
        const ack = await messageAck;
        if (!ack?.stored) throw new Error(`传输记录未写入：${ack?.reason || 'unknown'}`);
        console.log(`[VClient Push] 传输记录已写入，开始缓存 ${payload.assets.length} 个文件`);

        let completionTimer;
        try {
            await Promise.race([
                Promise.all(Array.from(completions.values(), item => item.promise)),
                new Promise((_, reject) => {
                    completionTimer = setTimeout(() => reject(new Error('等待 VClient 缓存文件超时')), remaining());
                })
            ]);
        } finally {
            clearTimeout(completionTimer);
        }
        console.log(`[VClient Push] 推送完成：${payload.assets.length} 个文件，共 ${formatBytes(files.reduce((sum, file) => sum + file.size, 0))}`);
        return { sessionId, messageId: payload.message.id, fileCount: files.length };
    } finally {
        socket.disconnect();
    }
}

async function main(argv = process.argv.slice(2), environment = process.env) {
    const options = parseArguments(argv);
    if (options.help) {
        console.log(usage());
        return null;
    }
    return pushToVClient(options, environment);
}

if (require.main === module) {
    main().catch(error => {
        console.error(`[VClient Push] 失败：${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { collectInputFiles, createPushPayload, main, mimeType, parseArguments, pushToVClient, usage };
