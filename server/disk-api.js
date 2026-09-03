'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { createTelegramDriveStore, normalizeTelegramDrivePath } = require('./telegram-drive');
const { readJson, writeJson } = require('./disk-data');
const { createDiskShares } = require('./disk-shares');

const publicFile = item => item ? {
    id: item.id, kind: 'file', name: item.name, type: item.type, size: item.size,
    folderPath: item.folderPath || '', createdAt: item.createdAt, updatedAt: item.updatedAt,
    lastCheckedAt: item.lastCheckedAt || 0, repairedAt: item.repairedAt || 0,
    metadata: item.metadata || {}
} : null;
function createDiskSpaces(dataDir, defaultStore) {
    const stores = new Map([['', defaultStore]]);
    const manifest = path.join(dataDir, 'disk-spaces.json');
    const spaces = readJson(manifest, []);
    return {
        cleanup() { return [...stores.values()].flatMap(store => store.cleanup()); },
        get(value = '') {
            if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f]/.test(value)) throw new Error('DISK_SPACE_INVALID');
            if (!stores.has(value)) {
                const id = crypto.createHash('sha256').update(value).digest('hex');
                stores.set(value, createTelegramDriveStore({ dataDir: path.join(dataDir, 'disk-spaces', id) }));
                if (!spaces.includes(value)) { spaces.push(value); writeJson(manifest, spaces); }
            }
            return stores.get(value);
        }
    };
}
function errorStatus(code) {
    if (code === 'PASSKEY_SERVER_UNAVAILABLE') return 503;
    if (/ACCESS_TOKEN_|APP_AUTH_|LOGIN_REQUIRED|PASSKEY_FLOW_INVALID/.test(code)) return 401;
    if (/NOT_FOUND|not-found/.test(code)) return 404;
    if (/CONFLICT|EXISTS|exists|not-empty|BUSY|IN_PROGRESS/.test(code)) return 409;
    if (/TELEGRAM_|STORAGE_/.test(code)) return 502;
    return 422;
}
function createDiskAPI({ dataDir, defaultStore, auth, operations, telegram, getDefaultBackend, getIdentity, setIdentity, getOrigin, isMockRequest, maxDepth, onDefaultUpload = () => {} }) {
    const browser = express.Router();
    const external = express.Router();
    const admin = express.Router();
    const spaces = createDiskSpaces(dataDir, defaultStore);
    const shares = createDiskShares({ dataDir });
    const shared = express.Router();
    const cleanupTimer = setInterval(() => {
        try { for (const operationId of spaces.cleanup()) if (operationId) operations.fail(operationId, new Error('UPLOAD_EXPIRED')); }
        catch (_) { console.warn('[网盘] 暂存清理失败，请检查数据目录权限'); }
    }, 60000);
    cleanupTimer.unref();
    const mutations = new Map();
    // Serialize index mutations for one logical disk while remote work is pending.
    // Reads and unrelated users/spaces remain independent.
    async function mutate(req, work) {
        const key = JSON.stringify([req.diskScope.userId, req.diskScope.diskSpace]);
        const previous = mutations.get(key) || Promise.resolve();
        const pending = previous.catch(() => {}).then(work);
        mutations.set(key, pending);
        try { return await pending; }
        finally { if (mutations.get(key) === pending) mutations.delete(key); }
    }
    const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
    const limiter = () => rateLimit({ windowMs: 60000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'AUTH_RATE_LIMIT' } });
    const failure = (error, req, res, next) => {
        if (res.headersSent) return res.destroy();
        const code = /^[a-zA-Z0-9_-]+$/.test(error.message) ? error.message : 'DISK_REQUEST_FAILED';
        res.status(errorStatus(code)).json({ error: code, code });
    };
    const noStore = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };
    browser.use(noStore); external.use(noStore); admin.use(noStore);
    shared.use(noStore);
    shared.use(rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false }));
    shared.use((req, res, next) => { res.set({ 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' }); next(); });
    shared.get('/:token', wrap((req, res) => {
        const share = shares.resolve(req.params.token);
        res.json(shares.contents(share, spaces.get(share.diskSpace), req.query.path || ''));
    }));
    shared.get('/:token/files/:id/download', wrap(async (req, res) => {
        const share = shares.resolve(req.params.token);
        const file = shares.file(share, spaces.get(share.diskSpace), req.params.id);
        const backend = file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
        const source = await telegram.read(backend, file);
        // Recheck revocation after an upstream wait, before releasing any bytes.
        try { shares.resolve(req.params.token); } catch (error) { source.destroy(); throw error; }
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(file.name));
        await pipeline(source, res);
    }));
    shared.use(failure);
    const csrf = (req, res, next) => {
        const origin = req.get('Origin');
        if (origin && origin !== getOrigin(req)) return res.status(403).json({ error: 'ORIGIN_MISMATCH' });
        next();
    };
    browser.use(csrf);

    admin.use(csrf);
    admin.get('/apps', (req, res) => res.json({ apps: auth.apps() }));
    admin.post('/apps', wrap(async (req, res) => res.json(await auth.saveApp(req.body || {}))));
    admin.delete('/apps/:id', (req, res) => { auth.deleteApp(req.params.id); res.json({ ok: true }); });
    admin.use(failure);

    external.post('/auth/token', limiter(), wrap(async (req, res) => {
        const app = await auth.authenticateApp(req.body?.app_id, req.body?.app_secret);
        const backend = await telegram.validate(req.body?.tg_bot_token, req.body?.tg_channel);
        res.json(auth.issueToken(app, backend, { app_secret: req.body.app_secret }));
    }));
    external.use(wrap((req, res, next) => {
        req.diskApp = auth.access(String(req.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
        next();
    }));
    function passkeys(router, externalMode) {
        router.post('/passkeys/:kind/options', limiter(), wrap(async (req, res) => {
            if (!externalMode && isMockRequest(req)) throw new Error('LOCAL_USE_OIDC_MOCK');
            const current = externalMode ? null : getIdentity(req);
            const origin = externalMode ? (req.diskApp.passkeyOrigin || getOrigin(req)) : getOrigin(req);
            const binding = externalMode ? req.diskApp.appId : crypto.randomBytes(32).toString('base64url');
            const result = await auth.passkeyOptions({ kind: req.params.kind, username: req.body?.username, existingUserId: current?.id || '', origin, binding });
            if (!externalMode) res.cookie('disk_passkey_flow', binding, { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/telegram/drive/passkeys', maxAge: 300000 });
            res.json(result);
        }));
        router.post('/passkeys/verify', limiter(), wrap(async (req, res) => {
            if (!externalMode && isMockRequest(req)) throw new Error('LOCAL_USE_OIDC_MOCK');
            const binding = externalMode ? req.diskApp.appId : (String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('disk_passkey_flow=')) || '').slice('disk_passkey_flow='.length);
            const current = externalMode ? null : getIdentity(req);
            const identity = await auth.passkeyVerify({ flowId: req.body?.flow_id, response: req.body?.response, binding, existingUserId: current?.id || '' });
            if (!externalMode) { res.clearCookie('disk_passkey_flow', { path: '/api/telegram/drive/passkeys', httpOnly: true, secure: true, sameSite: 'lax' }); setIdentity(req, res, identity); }
            res.json({ identity, user_id: identity.id });
        }));
    }
    passkeys(browser, false); passkeys(external, true);

    browser.use(wrap((req, res, next) => {
        const user = getIdentity(req);
        if (!user) throw new Error('LOGIN_REQUIRED');
        req.diskUser = user; req.diskScope = { userId: user.id, diskSpace: '' }; req.diskStore = defaultStore;
        next();
    }));
    external.use(wrap((req, res, next) => {
        const userId = req.get('X-Disk-User-Id') || req.query.user_id || req.body?.user_id;
        const telegramId = req.query.tg_user_id || req.body?.tg_user_id;
        const user = userId ? auth.user(userId) : (telegramId ? auth.fromTelegram({ id: telegramId }) : null);
        if (!user) throw new Error('USER_NOT_FOUND');
        if (telegramId) defaultStore.migrateOwner(String(telegramId), user.id);
        const diskSpace = req.get('X-Disk-Space') ?? req.query.disk_space ?? req.body?.disk_space ?? '';
        req.diskUser = user; req.diskScope = { userId: user.id, diskSpace }; req.diskStore = spaces.get(diskSpace);
        next();
    }));
    function contents(router) {
        const scope = req => req.diskScope;
        const owner = req => req.diskUser.id;
        const store = req => req.diskStore;
        const backend = req => req.diskApp ? req.diskApp.storage : getDefaultBackend();
        const fileBackend = (req, file) => file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
        const getFile = req => { const file = store(req).get(owner(req), req.params.id); if (!file) throw new Error('FILE_NOT_FOUND'); return file; };
        const jobResponse = (req, res, type, message, work) => {
            const job = operations.create(scope(req), type, message);
            operations.run(job.operation_id, update => mutate(req, () => work(update)));
            res.status(202).json({ operation_id: job.operation_id });
        };
        router.get('/users/me', (req, res) => res.json({ identity: req.diskUser, user_id: owner(req) }));
        router.get('/shares', (req, res) => res.json({ shares: shares.list(scope(req)) }));
        router.post('/shares', wrap((req, res) => res.status(201).json(shares.create(scope(req), store(req), req.body?.items))));
        router.delete('/shares/:id', wrap((req, res) => res.json(shares.stop(scope(req), req.params.id))));
        router.get('/operations', (req, res) => res.json({ operations: operations.list(scope(req), String(req.query.ids || '').split(',').slice(0, 100)) }));
        router.get('/operations/:id', wrap((req, res) => {
            const job = operations.get(req.params.id, scope(req));
            if (!job) throw new Error('OPERATION_NOT_FOUND');
            res.json(job);
        }));
        router.get('/list', wrap((req, res) => {
            const result = store(req).list(owner(req), req.query.path || '');
            res.json({ ...result, files: result.files.map(publicFile) });
        }));
        router.get('/directories', (req, res) => res.json({ directories: store(req).listDirectories(owner(req)) }));
        router.get('/directories/properties', wrap((req, res) => {
            const folder = store(req).getDirectory(owner(req), req.query.path || '');
            if (!folder) throw new Error('DIRECTORY_NOT_FOUND');
            res.json(folder);
        }));
        router.get('/tree', wrap((req, res) => {
            const tree = store(req).getDirectoryTree(owner(req), req.query.path || '');
            if (!tree) throw new Error('DIRECTORY_NOT_FOUND');
            res.json({ files: tree.files.map(publicFile), directories: tree.directories });
        }));
        router.post('/directories', wrap((req, res) => {
            jobResponse(req, res, 'mkdir', '正在创建目录', async update => {
                update({ phase: 'index-write', message: '正在逐级创建虚拟目录并保存索引' });
                return store(req).createDirectory(owner(req), req.body?.path || '', maxDepth());
            });
        }));
        router.patch('/directories', wrap((req, res) => {
            jobResponse(req, res, 'move-directory', '正在修改目录', async update => {
                update({ phase: 'index-write', message: '正在校验目录树并更新索引' });
                return Object.hasOwn(req.body || {}, 'destinationPath')
                    ? store(req).moveDirectory(owner(req), req.body.path, req.body.destinationPath, maxDepth(), req.body.name)
                    : store(req).renameDirectory(owner(req), req.body.path, req.body.name, maxDepth());
            });
        }));
        router.get('/files/:id', wrap((req, res) => res.json(publicFile(getFile(req)))));
        router.patch('/files/:id', wrap((req, res) => {
            const file = getFile(req);
            jobResponse(req, res, 'modify-file', '正在修改文件', async update => {
                update({ phase: 'index-write', message: '正在校验文件名称和目标目录' });
                return publicFile(store(req).modifyFile(owner(req), file.id, req.body || {}, maxDepth()));
            });
        }));
        router.delete('/files/:id', wrap((req, res) => {
            const file = getFile(req);
            jobResponse(req, res, 'delete-file', '正在删除 ' + file.name, async update => {
                update({ phase: 'telegram-delete', message: '正在请求 Telegram 删除：' + file.name });
                await telegram.remove(fileBackend(req, file), file);
                store(req).remove(owner(req), file.id); return { ok: true };
            });
        }));
        router.delete('/directories', wrap((req, res) => {
            const folderPath = normalizeTelegramDrivePath(req.query.path);
            if (!folderPath) throw new Error('ROOT_DELETE_FORBIDDEN');
            const tree = store(req).getDirectoryTree(owner(req), folderPath);
            if (!tree) throw new Error('DIRECTORY_NOT_FOUND');
            if (req.query.recursive !== 'true' && (tree.files.length || tree.directories.length > 1)) throw new Error('DIRECTORY_NOT_EMPTY');
            jobResponse(req, res, 'delete-directory', '正在删除目录', async update => {
                store(req).assertDirectoryWritable(owner(req), folderPath);
                const currentTree = store(req).getDirectoryTree(owner(req), folderPath);
                if (!currentTree) throw new Error('DIRECTORY_NOT_FOUND');
                let count = 0; const failures = [];
                for (const file of currentTree.files) {
                    update({ phase: 'telegram-delete', percent: null, message: '正在删除 ' + (++count) + '/' + tree.files.length + '：' + file.name });
                    try { await telegram.remove(fileBackend(req, file), file); store(req).remove(owner(req), file.id); }
                    catch (_) { failures.push(file.id); }
                }
                if (failures.length) throw new Error('DISK_DELETE_PARTIAL');
                update({ phase: 'index-write', message: '正在清理虚拟目录索引' });
                return store(req).removeDirectory(owner(req), folderPath, true);
            });
        }));
        router.post('/uploads', wrap((req, res) => {
            if (mutations.has(JSON.stringify([scope(req).userId, scope(req).diskSpace]))) throw new Error('DISK_BUSY');
            const storage = backend(req);
            if (!storage?.channelId || !storage?.token) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
            const files = (req.body?.files || []).map(file => {
                if (!file.source_path) return file;
                const parts = String(file.source_path).replace(/\\/g, '/').split('/');
                const name = parts.pop();
                if (!name) throw new Error('SOURCE_PATH_INVALID');
                return { ...file, name, folderPath: normalizeTelegramDrivePath(parts.join('/')) };
            });
            const limit = storage.baseUrl === 'https://api.telegram.org' ? 50 * 1024 * 1024 : 2 * 1024 * 1024 * 1024;
            const job = store(req).begin({ owner: req.diskUser, folderPath: req.body?.folderPath, files, maxDepth: maxDepth(), uploadLimit: limit, backendId: storage.id || '', metadata: req.body?.metadata || {} });
            job.storage = storage;
            const operation = operations.create(scope(req), 'upload', '上传 ' + job.files.length + ' 个文件：' + job.files[0].name, job.files.reduce((sum, file) => sum + file.size, 0) * 2);
            job.operationId = operation.operation_id;
            operations.update(job.operationId, { uploadId: job.id }, true);
            res.status(201).json({ uploadId: job.id, operation_id: operation.operation_id, uploadLimit: limit });
        }));
        router.put('/uploads/:uploadId/files/:index', wrap(async (req, res) => {
            if (!store(req).ownsUpload(owner(req), req.params.uploadId)) throw new Error('UPLOAD_NOT_FOUND');
            const job = store(req).upload(req.params.uploadId);
            if (job.finishing) throw new Error('UPLOAD_IN_PROGRESS');
            const file = job.files[Number(req.params.index)];
            if (!file) throw new Error('FILE_NOT_FOUND');
            operations.update(job.operationId, { status: 'running', phase: 'client-upload', percent: null, message: '正在接收客户端文件：' + file.name });
            try {
                const received = job.files.reduce((sum, file) => sum + file.received, 0);
                const totalBytes = job.files.reduce((sum, file) => sum + file.size, 0) * 2;
                res.json(await store(req).receive(job.id, req.params.index, req, bytes => operations.update(job.operationId, { phase: 'client-upload', message: '正在接收客户端文件：' + file.name, processedBytes: received + bytes, totalBytes, percent: totalBytes ? (received + bytes) / totalBytes * 100 : null })));
            } catch (error) { store(req).abort(job.id); operations.fail(job.operationId, error); throw error; }
        }));
        router.post('/uploads/:uploadId/phase', wrap((req, res) => {
            if (!store(req).ownsUpload(owner(req), req.params.uploadId)) throw new Error('UPLOAD_NOT_FOUND');
            const job = store(req).upload(req.params.uploadId);
            if (job.finishing) throw new Error('UPLOAD_IN_PROGRESS');
            operations.update(job.operationId, { status: 'running', phase: 'source-read', percent: null, message: '正在读取本机文件：' + (job.files[req.body?.index]?.name || '') });
            res.json({ ok: true });
        }));
        router.delete('/uploads/:uploadId', wrap((req, res) => {
            if (!store(req).ownsUpload(owner(req), req.params.uploadId)) throw new Error('UPLOAD_NOT_FOUND');
            const job = store(req).upload(req.params.uploadId);
            if (job.finishing) throw new Error('UPLOAD_IN_PROGRESS');
            store(req).abort(job.id);
            operations.update(job.operationId, { status: 'cancelled', phase: 'cancelled', message: '客户端已取消暂存上传' }, true);
            res.json({ ok: true });
        }));
        router.post('/uploads/:uploadId/finish', wrap((req, res) => {
            if (!store(req).ownsUpload(owner(req), req.params.uploadId)) {
                const previous = operations.findUpload(req.params.uploadId, scope(req));
                if (previous) return res.status(202).json({ operation_id: previous.operation_id });
                throw new Error('UPLOAD_NOT_FOUND');
            }
            const job = store(req).finish(req.params.uploadId);
            if (!job.finishing) {
                job.finishing = true;
                operations.run(job.operationId, update => mutate(req, async () => {
                    const sent = [];
                    try {
                        store(req).validateUpload(job.id);
                        const sourceBytes = job.files.reduce((sum, file) => sum + file.size, 0);
                        await telegram.upload(job.storage, job.files, patch => update({ ...patch, totalBytes: sourceBytes * 2, processedBytes: sourceBytes + (patch.processedBytes || 0), percent: Number.isFinite(patch.percent) ? 50 + patch.percent / 2 : null }), sent, scope(req));
                        update({ phase: 'index-write', percent: null, message: 'Telegram 已接收，正在写入文件索引' });
                        const items = store(req).commit(job.id, job.storage.channelId, sent);
                        if (!job.backendId) onDefaultUpload(job.storage.channelId);
                        const warnings = sent.filter(file => file.captionWarning).map(file => file.captionWarning);
                        if (warnings.length) update({ warnings });
                        return { ok: true, items: items.map(publicFile), warnings };
                    } catch (error) {
                        // Keep confirmed remote objects discoverable, even if a later album failed.
                        if (sent.length) {
                            job.files = job.files.slice(0, sent.length);
                            const items = store(req).commit(job.id, job.storage.channelId, sent);
                            operations.update(job.operationId, { result: { partialItems: items.map(publicFile) } });
                        } else store(req).abort(job.id);
                        throw error;
                    }
                }));
            }
            res.status(202).json({ operation_id: job.operationId });
        }));
        router.get('/files/:id/check', wrap((req, res) => {
            const file = getFile(req);
            jobResponse(req, res, 'check', '正在检测文件', async update => {
                update({ phase: 'telegram-check', message: '正在向 Telegram 检查文件有效性' });
                try { await telegram.call(fileBackend(req, file), 'getFile', { file_id: file.fileId }); store(req).update(owner(req), file.id, { lastCheckedAt: Date.now() }); return { valid: true }; }
                catch (_) { return { valid: false }; }
            });
        }));
        router.get('/files/:id/download', wrap(async (req, res) => {
            const file = getFile(req);
            const operation = operations.create(scope(req), 'read', '正在请求 Telegram：' + file.name, file.size);
            const id = operation.operation_id;
            operations.update(id, { status: 'running', phase: 'telegram-request' });
            try {
                const source = await telegram.read(fileBackend(req, file), file);
                res.set('Content-Type', file.type || 'application/octet-stream');
                res.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(file.name));
                res.set('X-Disk-Operation-Id', id);
                let bytes = 0;
                const meter = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; operations.update(id, { phase: 'download', message: '正在读取文件：' + file.name, processedBytes: bytes, totalBytes: file.size, percent: file.size ? Math.min(100, bytes / file.size * 100) : null }); callback(null, chunk); } });
                await pipeline(source, meter, res);
                operations.complete(id, { id: file.id });
            } catch (error) { operations.fail(id, error); throw error; }
        }));
        router.post('/files/:id/repair', wrap(async (req, res) => {
            const file = getFile(req); const storage = backend(req);
            if (!storage?.token || !storage?.channelId) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
            if (Number(req.get('X-Disk-File-Size') || req.get('X-Drop2Tunnel-File-Size')) !== file.size) throw new Error('REPAIR_SIZE_INVALID');
            const operation = operations.create(scope(req), 'repair', '正在接收本机修复副本', file.size);
            const job = store(req).begin({ owner: req.diskUser, folderPath: '', files: [{ name: crypto.randomUUID(), type: file.type, size: file.size }], maxDepth: maxDepth(), uploadLimit: storage.baseUrl === 'https://api.telegram.org' ? 50 * 1024 * 1024 : 2 * 1024 * 1024 * 1024 });
            try { await store(req).receive(job.id, 0, req); }
            catch (error) { store(req).abort(job.id); operations.fail(operation.operation_id, error); throw error; }
            operations.run(operation.operation_id, update => mutate(req, async () => {
                try {
                    if (!store(req).get(owner(req), file.id)) throw new Error('FILE_NOT_FOUND');
                    const [remote] = await telegram.upload(storage, [{ ...job.files[0], name: file.name, folderPath: file.folderPath }], update, [], scope(req));
                    store(req).update(owner(req), file.id, { ...remote, channelId: storage.channelId, backendId: storage.id || '', repairedAt: Date.now() });
                    return { ok: true };
                } finally { store(req).abort(job.id); }
            }));
            res.status(202).json({ operation_id: operation.operation_id });
        }));
    }
    contents(browser); contents(external);
    browser.use(failure); external.use(failure);
    return { browser, external, admin, shared, spaces, close() { clearInterval(cleanupTimer); } };
}
module.exports = { createDiskAPI, createDiskSpaces, publicFile };
