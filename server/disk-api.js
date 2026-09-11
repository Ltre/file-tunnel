'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const { Transform, Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { createTelegramDriveStore, normalizeTelegramDrivePath } = require('./telegram-drive');
const { readJson, writeJson } = require('./disk-data');
const { createDiskShares } = require('./disk-shares');
const { MAX_TELEGRAM_PART_SIZE } = require('./disk-limits');
const { createDiskUploadLog, networkDetails } = require('./disk-upload-log');
const { createDiskPartCache } = require('./disk-part-cache');
const LOGICAL_FILE_UPLOAD_LIMIT = 2000 * 1024 * 1024;

const publicFile = item => item ? {
    id: item.id, kind: 'file', name: item.name, type: item.type, size: item.size,
    folderPath: item.folderPath || '', createdAt: item.createdAt, updatedAt: item.updatedAt,
    lastCheckedAt: item.lastCheckedAt || 0, repairedAt: item.repairedAt || 0,
    metadata: item.metadata || {}, reviewStatus: item.reviewStatus || 'active', reviewUpdatedAt: item.reviewUpdatedAt || 0,
    partCount: Number(item.partCount) || (Array.isArray(item.parts) && item.parts.length) || 1,
    mediaIndex: item.mediaIndex || { mode: 'unavailable' }
} : null;
const uploadResultFile = item => item ? {
    ...publicFile(item),
    telegramFileId: item.fileId || '',
    telegramFileUniqueId: item.fileUniqueId || '',
    telegramPartFileIds: (item.parts || []).map(part => part.fileId),
    serverAssetUrl: `/api/telegram/drive/files/${encodeURIComponent(item.id)}/stream`
} : null;
function createDiskSpaces(dataDir, defaultStore) {
    const stores = new Map([['', defaultStore]]);
    const manifest = path.join(dataDir, 'disk-spaces.json');
    const spaces = readJson(manifest, []);
    const usageFile = path.join(dataDir, 'disk-space-usage.json');
    const usages = readJson(usageFile, []);
    const track = (appId, userId, diskSpace) => {
        const now = Date.now();
        let item = usages.find(entry => entry.appId === appId && entry.userId === userId && entry.diskSpace === diskSpace);
        if (!item) { item = { appId, userId, diskSpace, createdAt: now, lastUsedAt: now }; usages.push(item); writeJson(usageFile, usages); }
        else if (now - item.lastUsedAt > 60 * 60 * 1000) { item.lastUsedAt = now; writeJson(usageFile, usages); }
    };
    return {
        cleanup() { return [...stores.values()].flatMap(store => store.cleanup().map(job => ({ store, job }))); },
        recoveries() { return this.entries().flatMap(({ store }) => store.recoveredUploads().map(job => ({ store, job }))); },
        entries() { return ['', ...new Set(spaces)].map(diskSpace => ({ diskSpace, store: this.get(diskSpace) })); },
        usages() { return usages.map(item => ({ ...item })); },
        track(appId, userId, diskSpace = '') { track(String(appId || 'system'), String(userId), String(diskSpace || '')); },
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
    if (code === 'FILE_REMOVED_BY_REVIEW') return 410;
    if (/ACCESS_TOKEN_|APP_AUTH_|LOGIN_REQUIRED|PASSKEY_FLOW_INVALID/.test(code)) return 401;
    if (/NOT_FOUND|not-found/.test(code)) return 404;
    if (/CONFLICT|EXISTS|exists|not-empty|BUSY|IN_PROGRESS/.test(code)) return 409;
    if (/TELEGRAM_|STORAGE_/.test(code)) return 502;
    return 422;
}
function createDiskAPI({ dataDir, defaultStore, auth, operations, telegram, getDefaultBackend, getIdentity, setIdentity, getOrigin, isMockRequest, maxDepth, onDefaultUpload = () => {} }) {
    const log = createDiskUploadLog(dataDir);
    const partCache = createDiskPartCache({ dataDir });
    const browser = express.Router();
    const external = express.Router();
    const admin = express.Router();
    const spaces = createDiskSpaces(dataDir, defaultStore);
    const shares = createDiskShares({ dataDir });
    const shared = express.Router();
    let retryingCaptions = false, closed = false;
    let recoveringUploads = false, recoveryRetryTimer = null;
    const recoveryBacklog = [];
    const queueUploadRecovery = entry => {
        if (!entry?.job?.id || recoveryBacklog.some(item => item.store === entry.store && item.job.id === entry.job.id)) return;
        recoveryBacklog.push(entry);
        if (!closed && !recoveryRetryTimer) {
            recoveryRetryTimer = setTimeout(() => { recoveryRetryTimer = null; cleanupRecoveredUploads().catch(() => {}); }, 60000);
            recoveryRetryTimer.unref?.();
        }
    };
    const cleanupTimer = setInterval(() => {
        cleanupExpiredUploads().catch(() => console.warn('[网盘] 暂存清理失败，请检查数据目录权限'));
        retryCaptions().catch(() => {});
    }, 60000);
    cleanupTimer.unref();
    async function cleanupExpiredUploads() {
        for (const { store, job } of spaces.cleanup()) {
            if (job.operationId) operations.fail(job.operationId, new Error('UPLOAD_EXPIRED'));
            const parts = job.files.flatMap(file => file.chunks.map(chunk => chunk.remote).filter(Boolean));
            if (!parts.length) { store.finalizeExpired(job.id); continue; }
            const storage = job.storage || (job.backendId ? auth.backend(job.backendId) : getDefaultBackend(job.channelId));
            try {
                await telegram.remove(storage, { name: job.files[0]?.name || '过期上传', channelId: job.channelId || storage.channelId, createdAt: job.createdAt, parts });
                log('upload.expired-cleanup-complete', { uploadId: job.id, operationId: job.operationId, parts: parts.length });
                store.finalizeExpired(job.id);
            } catch (error) {
                log('upload.expired-cleanup-failed', { uploadId: job.id, operationId: job.operationId, parts: parts.length, error: networkDetails(error) });
                store.preserveForRecovery(job.id);
                queueUploadRecovery({ store, job });
            }
        }
    }
    async function cleanupRecoveredUploads() {
        if (recoveringUploads || closed) return;
        recoveringUploads = true;
        const pending = recoveryBacklog.splice(0);
        try { for (const { store, job } of pending) {
            const parts = (job.files || []).flatMap(file => (file.chunks || []).map(chunk => chunk.remote).filter(Boolean));
            try {
                if (parts.length) {
                    const storage = job.storage || (job.backendId ? auth.backend(job.backendId) : getDefaultBackend(job.channelId));
                    await telegram.remove(storage, { name: job.files?.[0]?.name || '未完成上传', channelId: job.channelId || storage.channelId, createdAt: job.createdAt, parts });
                    log('upload.restart-cleanup-complete', { uploadId: job.id, operationId: job.operationId, parts: parts.length });
                }
                store.discardRecovered(job);
            } catch (error) {
                log('upload.restart-cleanup-failed', { uploadId: job.id, operationId: job.operationId, parts: parts.length, error: networkDetails(error) });
                queueUploadRecovery({ store, job });
            }
        } } finally { recoveringUploads = false; }
    }
    queueMicrotask(() => {
        for (const entry of spaces.recoveries()) queueUploadRecovery(entry);
        cleanupRecoveredUploads().catch(error => console.warn('[网盘] 重启上传回滚失败：', error.message));
    });
    const mutations = new Map();
    let telegramUploadTail = Promise.resolve();
    async function enqueueTelegramUpload(job, work) {
        const previous = telegramUploadTail;
        const queuedAt = Date.now();
        let release;
        const slot = new Promise(resolve => { release = resolve; });
        telegramUploadTail = previous.catch(() => {}).then(() => slot);
        log('telegram.queue-wait', { uploadId: job.id, operationId: job.operationId });
        await previous.catch(() => {});
        log('telegram.queue-start', { uploadId: job.id, operationId: job.operationId, waitedMs: Date.now() - queuedAt });
        try { return await work(); }
        finally { log('telegram.queue-release', { uploadId: job.id, operationId: job.operationId, elapsedMs: Date.now() - queuedAt }); release(); }
    }
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
    async function syncCaptions(store, scope, files, update) {
        let failed = false;
        for (const file of files) {
            if (file.reviewStatus === 'deleted') continue;
            try {
                const storage = file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
                await telegram.syncCaption(storage, file, scope, update);
                store.update(scope.userId, file.id, { captionSyncPending: false, captionWarning: '' });
            } catch (_) { failed = true; }
        }
        if (failed) throw new Error('TELEGRAM_CAPTION_SYNC_PENDING');
    }
    async function retryCaptions() {
        if (retryingCaptions || closed) return;
        retryingCaptions = true;
        try {
            for (const { diskSpace, store } of spaces.entries()) {
                for (const saved of store.adminFiles().filter(file => file.captionSyncPending && file.reviewStatus !== 'deleted')) {
                    if (closed) return;
                    const scope = { userId: saved.ownerId, diskSpace };
                    await mutate({ diskScope: scope }, async () => {
                        const current = store.get(scope.userId, saved.id);
                        if (current?.captionSyncPending && current.reviewStatus !== 'deleted') await syncCaptions(store, scope, [current]);
                    }).catch(() => {});
                }
            }
        } finally { retryingCaptions = false; }
    }
    const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function openRemoteRange(backend, file, start = 0, end = Number(file.size) - 1, signal) {
        if (typeof telegram.parts !== 'function' || typeof telegram.readPart !== 'function') {
            const source = await telegram.read(backend, file);
            if (start === 0 && end === Number(file.size) - 1) return source;
            let skipped = 0, emitted = 0;
            async function* sliceLegacy() {
                for await (const chunk of source) {
                    if (signal?.aborted) throw new Error('OPERATION_CANCELLED');
                    if (skipped + chunk.length <= start) { skipped += chunk.length; continue; }
                    const from = Math.max(0, start - skipped), take = Math.min(chunk.length - from, end - start + 1 - emitted);
                    if (take > 0) { emitted += take; yield chunk.subarray(from, from + take); }
                    skipped += chunk.length; if (emitted >= end - start + 1) { source.destroy?.(); break; }
                }
            }
            return Readable.from(sliceLegacy());
        }
        const parts = telegram.parts(file);
        const backendKey = crypto.createHash('sha256').update(String(backend.baseUrl || '') + '\0' + String(backend.token || '')).digest('hex');
        async function* combine() {
            for (const part of parts) {
                const partStart = Number(part.offset) || 0, partEnd = partStart + part.size - 1;
                if (partEnd < start || partStart > end) continue;
                const localStart = Math.max(0, start - partStart), localEnd = Math.min(part.size - 1, end - partStart);
                const block = 1024 * 1024;
                const cacheStart = Math.floor(localStart / block) * block;
                const cacheEnd = Math.min(part.size - 1, Math.ceil((localEnd + 1) / block) * block - 1);
                const key = [backendKey, part.fileId, cacheStart, cacheEnd].join(':');
                const source = await partCache.open({
                    key, size: cacheEnd - cacheStart + 1,
                    start: localStart - cacheStart, end: localEnd - cacheStart, signal,
                    source: () => telegram.readPart(backend, part, { start: cacheStart, end: cacheEnd, signal })
                });
                for await (const chunk of source) yield chunk;
            }
        }
        return Readable.from(combine());
    }
    async function readRemote(backend, file, start, end, signal) {
        try { return await openRemoteRange(backend, file, start, end, signal); }
        catch (error) {
            if (!/TELEGRAM_(?:DOWNLOAD_NETWORK|NETWORK_ERROR|DOWNLOAD_FAILED)/.test(error.message)) throw error;
            await wait(250); return openRemoteRange(backend, file, start, end, signal);
        }
    }
    const parseRange = (header, size) => {
        if (!header) return { start: 0, end: size - 1, partial: false };
        const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
        if (!match || (!match[1] && !match[2])) return null;
        let start, end;
        if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return null; start = Math.max(0, size - suffix); end = size - 1; }
        else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
        if (![start, end].every(Number.isSafeInteger) || start < 0 || start >= size || end < start) return null;
        return { start, end: Math.min(end, size - 1), partial: true };
    };
    async function prepareRemoteResponse(req, res, backend, file, { inline = false, operationId = '' } = {}) {
        if (!Number(file.size)) {
            res.status(200).set({ 'Accept-Ranges': 'bytes', 'Content-Type': file.type || 'application/octet-stream', 'Content-Length': '0', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}` });
            return { source: Readable.from([]), range: { start: 0, end: -1, partial: false }, abort: new AbortController() };
        }
        const range = parseRange(req.get('Range'), file.size);
        if (!range) { res.status(416).set('Content-Range', `bytes */${file.size}`).end(); return null; }
        const abort = new AbortController();
        res.on('close', () => { if (!res.writableEnded) abort.abort(); });
        const source = await readRemote(backend, file, range.start, range.end, abort.signal);
        const length = range.end - range.start + 1;
        res.status(range.partial ? 206 : 200);
        res.set('Accept-Ranges', 'bytes');
        res.set('Content-Type', file.type || 'application/octet-stream');
        res.set('Content-Length', String(length));
        if (range.partial) res.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
        res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        if (operationId) res.set('X-Disk-Operation-Id', operationId);
        return { source, range, abort };
    }
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
        const started = performance.now();
        const share = shares.resolve(req.params.token);
        const data = shares.contents(share, spaces.get(share.diskSpace), req.query.path || '');
        const elapsedMs = Math.round(performance.now() - started);
        res.set('Server-Timing', `share-metadata;dur=${elapsedMs}`);
        log('share.metadata', { elapsedMs, files: data.files.length, folders: data.folders.length });
        res.json(data);
    }));
    shared.get('/:token/files/:id/download', wrap(async (req, res) => {
        const share = shares.resolve(req.params.token);
        const file = shares.file(share, spaces.get(share.diskSpace), req.params.id);
        const backend = file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
        const remote = await prepareRemoteResponse(req, res, backend, file, { inline: req.query.inline === '1' });
        if (!remote) return;
        // Recheck revocation after an upstream wait, before releasing any bytes.
        try { shares.resolve(req.params.token); } catch (error) { remote.source.destroy(); throw error; }
        await pipeline(remote.source, res);
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
    const appLabel = id => {
        if (id === 'system') return '本系统';
        if (id === 'legacy') return '历史数据（来源未知）';
        if (id === 'unassigned') return '尚未使用网盘';
        const app = auth.apps().find(item => item.app_id === id);
        return app?.remark ? `${id}（${app.remark}）` : id;
    };
    const adminUserMap = () => new Map(auth.users().map(user => [user.id, user]));
    const inferSourceAppId = (file, diskSpace, usages = spaces.usages()) => {
        if (file.sourceAppId) return file.sourceAppId;
        const candidates = [...new Set(usages.filter(item => item.userId === file.ownerId && item.diskSpace === diskSpace).map(item => item.appId))];
        return candidates.length === 1 ? candidates[0] : 'legacy';
    };
    admin.get('/storage-overview', (req, res) => {
        const users = adminUserMap(), groups = new Map();
        const add = (appId, userId, diskSpace) => {
            const key = JSON.stringify([appId, userId, diskSpace]);
            if (!groups.has(key)) groups.set(key, { appId, appLabel: appLabel(appId), userId, user: users.get(userId) || { id: userId, name: '历史用户' }, diskSpace, fileCount: 0, size: 0, lastActivity: 0 });
            return groups.get(key);
        };
        const usages = spaces.usages();
        for (const usage of usages) add(usage.appId, usage.userId, usage.diskSpace).lastActivity = usage.lastUsedAt;
        for (const { diskSpace, store } of spaces.entries()) for (const file of store.adminFiles()) {
            const group = add(inferSourceAppId(file, diskSpace, usages), file.ownerId, diskSpace);
            group.fileCount++; group.size += Number(file.size) || 0; group.lastActivity = Math.max(group.lastActivity, Number(file.updatedAt || file.createdAt) || 0);
        }
        const assignedUsers = new Set([...groups.values()].map(group => group.userId));
        for (const user of users.values()) if (!assignedUsers.has(user.id)) add('unassigned', user.id, '');
        const systems = new Map();
        for (const group of groups.values()) {
            if (!systems.has(group.appId)) systems.set(group.appId, { appId: group.appId, label: group.appLabel, users: new Map() });
            const system = systems.get(group.appId);
            if (!system.users.has(group.userId)) system.users.set(group.userId, { ...group.user, userId: group.userId, spaces: [] });
            system.users.get(group.userId).spaces.push({ diskSpace: group.diskSpace, fileCount: group.fileCount, size: group.size, lastActivity: group.lastActivity });
        }
        res.json({ systems: [...systems.values()].map(system => ({ appId: system.appId, label: system.label, users: [...system.users.values()] })) });
    });
    admin.get('/storage-contents', wrap((req, res) => {
        const diskSpace = String(req.query.disk_space || ''), userId = String(req.query.user_id || '');
        if (!userId) throw new Error('USER_NOT_FOUND');
        const result = spaces.get(diskSpace).list(userId, req.query.path || '');
        res.json({ ...result, files: result.files.map(file => ({ ...publicFile(file), sourceAppId: inferSourceAppId(file, diskSpace) })) });
    }));
    const adminFile = req => {
        const userId = String(req.query.user_id || req.body?.user_id || ''), diskSpace = String(req.query.disk_space || req.body?.disk_space || '');
        const store = spaces.get(diskSpace), file = store.get(userId, req.params.id);
        if (!file) throw new Error('FILE_NOT_FOUND');
        return { userId, diskSpace, store, file };
    };
    const adminFileBackend = file => file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
    admin.get('/files/:id/download', wrap(async (req, res) => {
        const { file } = adminFile(req);
        if (file.reviewStatus === 'deleted') throw new Error('FILE_REMOVED_BY_REVIEW');
        const remote = await prepareRemoteResponse(req, res, adminFileBackend(file), file, { inline: true });
        if (remote) await pipeline(remote.source, res);
    }));
    admin.get('/reviews', (req, res) => {
        const users = adminUserMap(), files = [];
        for (const { diskSpace, store } of spaces.entries()) for (const file of store.adminFiles()) files.push({ ...publicFile(file), userId: file.ownerId, user: users.get(file.ownerId) || { id: file.ownerId, name: '历史用户' }, diskSpace, appId: inferSourceAppId(file, diskSpace) });
        files.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
        res.json({ files: files.slice(0, 50) });
    });
    admin.patch('/reviews/:id', wrap(async (req, res) => {
        const userId = String(req.body?.user_id || ''), diskSpace = String(req.body?.disk_space || ''), action = String(req.body?.action || '');
        const store = spaces.get(diskSpace), file = store.get(userId, req.params.id);
        if (!file) throw new Error('FILE_NOT_FOUND');
        if (action === 'block') return res.json(publicFile(store.setReviewStatus(userId, file.id, 'blocked')));
        if (action === 'unblock') return res.json(publicFile(store.setReviewStatus(userId, file.id, 'active')));
        if (action !== 'delete') throw new Error('REVIEW_ACTION_INVALID');
        if (file.reviewStatus !== 'deleted') {
            const backend = file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
            await telegram.remove(backend, file);
        }
        res.json(publicFile(store.tombstone(userId, file.id)));
    }));
    admin.patch('/directories/review', wrap(async (req, res) => {
        const userId = String(req.body?.user_id || ''), diskSpace = String(req.body?.disk_space || '');
        const folderPath = normalizeTelegramDrivePath(req.body?.path || ''), action = String(req.body?.action || '');
        const store = spaces.get(diskSpace), tree = store.getDirectoryTree(userId, folderPath);
        if (!folderPath || !tree) throw new Error('DIRECTORY_NOT_FOUND');
        if (action === 'block' || action === 'unblock') return res.json(store.setDirectoryReviewStatus(userId, folderPath, action === 'block' ? 'blocked' : 'active'));
        if (action !== 'delete') throw new Error('REVIEW_ACTION_INVALID');
        for (const file of tree.files) {
            if (file.reviewStatus === 'deleted') continue;
            await telegram.remove(adminFileBackend(file), file);
        }
        res.json(store.tombstoneDirectory(userId, folderPath));
    }));
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
        spaces.track('system', user.id, '');
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
        spaces.track(req.diskApp.appId, user.id, diskSpace);
        next();
    }));
    function contents(router) {
        const scope = req => ({ ...req.diskScope, deviceId: /^[a-zA-Z0-9_-]{8,120}$/.test(req.get('X-Disk-Device-Id') || '') ? req.get('X-Disk-Device-Id') : '' });
        const owner = req => req.diskUser.id;
        const store = req => req.diskStore;
        const backend = req => req.diskApp ? req.diskApp.storage : getDefaultBackend();
        const fileBackend = (req, file) => file.backendId ? auth.backend(file.backendId) : getDefaultBackend(file.channelId);
        const getFile = req => { const file = store(req).get(owner(req), req.params.id); if (!file) throw new Error('FILE_NOT_FOUND'); return file; };
        const requireEntity = file => { if (file.reviewStatus === 'deleted') throw new Error('FILE_REMOVED_BY_REVIEW'); return file; };
        const jobResponse = (req, res, type, message, work) => {
            const job = operations.create(scope(req), type, message);
            operations.run(job.operation_id, (update, control) => mutate(req, async () => {
                control.throwIfCancelled();
                const result = await work(update, control);
                control.throwIfCancelled();
                return result;
            }));
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
        router.delete('/operations/:id', wrap(async (req, res) => {
            const job = await operations.cancel(req.params.id, scope(req));
            if (!job) throw new Error('OPERATION_NOT_FOUND');
            res.json(job);
        }));
        router.get('/list', wrap((req, res) => {
            const result = store(req).list(owner(req), req.query.path || '');
            res.json({ ...result, files: result.files.map(publicFile) });
        }));
        router.get('/search', wrap((req, res) => {
            const result = store(req).search(owner(req), req.query.q || '', 500);
            res.json({ query: String(req.query.q || ''), folders: result.folders, files: result.files.map(publicFile), summary: { folderCount: result.folders.length, fileCount: result.files.length } });
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
                return store(req).createDirectory(owner(req), req.body?.path || '', maxDepth(), req.diskApp?.appId || 'system');
            });
        }));
        router.patch('/directories', wrap((req, res) => {
            jobResponse(req, res, 'move-directory', '正在修改目录', async update => {
                update({ phase: 'index-write', message: '正在校验目录树并更新索引' });
                const result = Object.hasOwn(req.body || {}, 'destinationPath')
                    ? store(req).moveDirectory(owner(req), req.body.path, req.body.destinationPath, maxDepth(), req.body.name)
                    : store(req).renameDirectory(owner(req), req.body.path, req.body.name, maxDepth());
                await syncCaptions(store(req), scope(req), store(req).getDirectoryTree(owner(req), result.path).files, update);
                return result;
            });
        }));
        router.get('/files/:id', wrap((req, res) => res.json(publicFile(getFile(req)))));
        router.patch('/files/:id', wrap((req, res) => {
            const file = requireEntity(getFile(req));
            jobResponse(req, res, 'modify-file', '正在修改文件', async update => {
                update({ phase: 'index-write', message: '正在校验文件名称和目标目录' });
                const modified = store(req).modifyFile(owner(req), file.id, req.body || {}, maxDepth());
                await syncCaptions(store(req), scope(req), [modified], update);
                return publicFile(modified);
            });
        }));
        router.delete('/files/:id', wrap((req, res) => {
            const file = getFile(req);
            jobResponse(req, res, 'delete-file', '正在删除 ' + file.name, async update => {
                if (file.reviewStatus === 'deleted') { store(req).remove(owner(req), file.id); return { ok: true, removedPlaceholder: true }; }
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
                    try { if (file.reviewStatus !== 'deleted') await telegram.remove(fileBackend(req, file), file); store(req).remove(owner(req), file.id); }
                    catch (_) { failures.push(file.id); }
                }
                if (failures.length) throw new Error('DISK_DELETE_PARTIAL');
                update({ phase: 'index-write', message: '正在清理虚拟目录索引' });
                return store(req).removeDirectory(owner(req), folderPath, true);
            });
        }));
        const pipelineWake = job => {
            for (const wake of job.pipelineWaiters || []) wake();
            job.pipelineWaiters?.clear();
        };
        const pipelineWait = (job, timeout = 30000) => new Promise(resolve => {
            job.pipelineWaiters ||= new Set();
            let settled = false;
            const wake = () => { if (settled) return; settled = true; clearTimeout(timer); job.pipelineWaiters.delete(wake); resolve(); };
            const timer = setTimeout(wake, timeout);
            timer.unref?.();
            job.pipelineWaiters.add(wake);
        });
        const physicalPart = (file, fileIndex, chunk) => {
            const count = file.parts.length, width = Math.max(2, String(count).length);
            const suffix = `.part${String(chunk.partIndex).padStart(width, '0')}-of-${String(count).padStart(width, '0')}`;
            return { fileIndex, logicalFileId: file.logicalId, partIndex: chunk.partIndex, partCount: count, originalSize: file.size, offset: chunk.offset, start: 0, end: chunk.size ? chunk.size - 1 : undefined, size: chunk.size, path: chunk.path, type: count === 1 ? file.type : 'application/octet-stream', name: count === 1 ? file.name : file.name.slice(0, Math.max(1, 180 - suffix.length)) + suffix };
        };
        const nextPipelineBatch = job => {
            const batch = []; let bytes = 0;
            outer: for (let fileIndex = 0; fileIndex < job.files.length; fileIndex++) {
                const file = job.files[fileIndex];
                for (let partIndex = 1; partIndex <= file.parts.length; partIndex++) {
                    const chunk = file.chunks.find(item => item.partIndex === partIndex);
                    if (!chunk || chunk.status === 'receiving') break outer;
                    if (chunk.status === 'uploaded') continue;
                    if (chunk.status !== 'queued') break outer;
                    if (batch.length >= 2 || bytes + chunk.size > MAX_TELEGRAM_PART_SIZE * 2) break outer;
                    batch.push(physicalPart(file, fileIndex, chunk)); bytes += chunk.size;
                }
            }
            return batch;
        };
        const cleanupPipelineRemote = async job => {
            const parts = job.files.flatMap(file => file.chunks.map(chunk => chunk.remote).filter(Boolean));
            if (!parts.length) return;
            await telegram.remove(job.storage, { name: job.files[0]?.name || '已取消文件', channelId: job.storage.channelId, createdAt: job.createdAt, parts });
        };
        const rollbackPipelineRemote = (job, diskStore, event) => {
            if (job.rollbackState === 'cleaned') return Promise.resolve(true);
            if (job.rollbackPromise) return job.rollbackPromise;
            job.rollbackPromise = (async () => {
                try {
                    await cleanupPipelineRemote(job);
                    job.rollbackState = 'cleaned'; diskStore.abort(job.id); return true;
                } catch (error) {
                    job.rollbackState = 'pending';
                    diskStore.preserveForRecovery(job.id);
                    queueUploadRecovery({ store: diskStore, job });
                    log(event, { uploadId: job.id, operationId: job.operationId, error: networkDetails(error), retryScheduled: true });
                    return false;
                } finally { job.rollbackPromise = null; }
            })();
            return job.rollbackPromise;
        };
        const runUploadPipeline = async (req, job, update, control) => {
            job.pipelineAbort = new AbortController();
            operations.onCancel(job.operationId, async () => { job.pipelineAbort.abort(); pipelineWake(job); });
            try {
                while (true) {
                    control.throwIfCancelled();
                    const state = store(req).uploadQueue(job.id);
                    if (!state) throw new Error('UPLOAD_NOT_FOUND');
                    update({ clientPartsReceived: state.receivedParts, clientPartsTotal: state.totalParts, telegramPartsUploaded: state.uploadedParts, queueParts: state.pendingParts, queueBytes: state.pendingBytes });
                    if (job.clientDone && state.uploadedParts === state.totalParts) {
                        update({ phase: 'index-write', percent: null, message: 'Telegram 已接收全部分片，正在写入逻辑文件索引' });
                        return mutate(req, async () => {
                            store(req).validateUpload(job.id);
                            const sent = store(req).uploadResults(job.id);
                            if (sent.some(result => !result)) throw new Error('TELEGRAM_PARTS_INVALID');
                            const items = store(req).commit(job.id, job.storage.channelId, sent);
                            for (const item of items) log('upload.file-committed', { uploadId: job.id, operationId: job.operationId, fileId: item.id, bytes: item.size });
                            if (!job.backendId) onDefaultUpload(job.storage.channelId);
                            const warnings = sent.filter(file => file.captionWarning).map(file => file.captionWarning);
                            return { ok: true, items: items.map(uploadResultFile), warnings };
                        });
                    }
                    let batch = nextPipelineBatch(job);
                    if (batch.length === 1 && !job.clientDone) { await pipelineWait(job, 350); batch = nextPipelineBatch(job); }
                    if (!batch.length) { await pipelineWait(job); continue; }
                    for (const part of batch) store(req).markPartUploading(job.id, part.fileIndex, part.partIndex);
                    update({ phase: 'telegram-queue', message: `服务器队列正在提交 ${batch.length} 个连续分片到 Telegram`, queueParts: Math.max(0, state.pendingParts - batch.length) });
                    try {
                        const progress = patch => update({ ...patch, telegramBytesUploaded: patch.processedBytes, telegramTotalBytes: patch.totalBytes, message: '阶段 2/2 · 服务器 → Telegram · ' + patch.message });
                        const context = { ...scope(req), uploadId: job.id, operationId: job.operationId, totalBytes: job.files.reduce((sum, file) => sum + file.size, 0), confirmedBytes: job.files.flatMap(file => file.chunks).filter(chunk => chunk.status === 'uploaded').reduce((sum, chunk) => sum + chunk.size, 0), signal: job.pipelineAbort.signal };
                        const remotes = await enqueueTelegramUpload(job, () => typeof telegram.uploadPhysical === 'function'
                            ? telegram.uploadPhysical(job.storage, job.files, batch, progress, context)
                            : telegram.upload(job.storage, batch.map(part => ({ ...job.files[part.fileIndex], name: part.name, size: part.size, path: part.path, chunks: [{ path: part.path, offset: 0, size: part.size }] })), progress, [], context).then(results => results.map((remote, index) => ({ ...remote, fileIndex: batch[index].fileIndex, logicalFileId: batch[index].logicalFileId, partIndex: batch[index].partIndex, partCount: batch[index].partCount, originalSize: batch[index].originalSize, size: batch[index].size, offset: batch[index].offset }))));
                        for (const remote of remotes) store(req).markPartUploaded(job.id, remote.fileIndex, remote.partIndex, remote);
                    } catch (error) {
                        store(req).resetUploadingParts(job.id); job.pipelineError = error.message; throw error;
                    }
                    pipelineWake(job);
                }
            } catch (error) {
                if (!control.cancelled) {
                    await rollbackPipelineRemote(job, store(req), 'upload.failure-cleanup-failed');
                }
                throw error;
            } finally {
                if (control.cancelled) {
                    await rollbackPipelineRemote(job, store(req), 'upload.cancel-cleanup-failed');
                }
                pipelineWake(job);
                job.pipelineDoneResolve?.();
            }
        };
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
            const limit = LOGICAL_FILE_UPLOAD_LIMIT;
            const job = store(req).begin({ owner: req.diskUser, folderPath: req.body?.folderPath, files, maxDepth: maxDepth(), uploadLimit: limit, backendId: storage.id || '', channelId: storage.channelId, sourceAppId: req.diskApp?.appId || 'system', metadata: req.body?.metadata || {} });
            job.storage = storage;
            const operation = operations.create(scope(req), 'upload', '上传 ' + job.files.length + ' 个文件：' + job.files[0].name, job.files.reduce((sum, file) => sum + file.size, 0));
            job.operationId = operation.operation_id;
            store(req).setUploadContext(job.id, { operationId: job.operationId, channelId: storage.channelId });
            operations.update(job.operationId, { uploadId: job.id }, true);
            job.pipelineDone = new Promise(resolve => { job.pipelineDoneResolve = resolve; });
            operations.run(job.operationId, (update, control) => runUploadPipeline(req, job, update, control));
            for (const file of job.files) log('upload.created', { uploadId: job.id, operationId: job.operationId, fileId: file.logicalId, bytes: file.size });
            res.status(201).json({ uploadId: job.id, operation_id: operation.operation_id, uploadLimit: limit, partSize: MAX_TELEGRAM_PART_SIZE, files: job.files.map(file => ({ logicalFileId: file.logicalId, partCount: file.parts.length })) });
        }));
        router.put('/uploads/:uploadId/files/:index', wrap(async (req, res) => {
            if (!store(req).ownsUpload(owner(req), req.params.uploadId)) throw new Error('UPLOAD_NOT_FOUND');
            const job = store(req).upload(req.params.uploadId);
            if (job.finishing) throw new Error('UPLOAD_IN_PROGRESS');
            if (job.pipelineError) throw new Error(job.pipelineError);
            // Apply backpressure inside the open request. Returning HTTP 429 made
            // the browser resend the same 20 MB chunk and poll operations between
            // retries, which then exhausted the unrelated global IP limiter.
            // Waiting here also lets the request socket provide natural TCP
            // backpressure without buffering another chunk in memory.
            while (true) {
                if (job.pipelineError) throw new Error(job.pipelineError);
                if (!store(req).ownsUpload(owner(req), job.id)) throw new Error('UPLOAD_NOT_FOUND');
                const queue = store(req).uploadQueue(job.id);
                if (queue.pendingParts < 5 && queue.pendingBytes < 100_000_000) break;
                log('browser.backpressure-wait', { uploadId: job.id, operationId: job.operationId, pendingParts: queue.pendingParts, pendingBytes: queue.pendingBytes });
                await pipelineWait(job, 30000);
            }
            const file = job.files[Number(req.params.index)];
            if (!file) throw new Error('FILE_NOT_FOUND');
            const trace = { uploadId: job.id, operationId: job.operationId, fileId: file.logicalId, range: req.get('Content-Range'), contentLength: req.get('Content-Length') };
            const started = Date.now(); let receivedBytes = 0, lastProgressAt = started;
            log('browser.receive-start', trace);
            const heartbeat = setInterval(() => log('browser.receive-progress', { ...trace, receivedBytes, elapsedMs: Date.now() - started, idleMs: Date.now() - lastProgressAt }), 10000);
            heartbeat.unref?.();
            operations.update(job.operationId, { status: 'running', phase: 'client-upload', percent: null, message: '正在接收客户端文件：' + file.name });
            try {
                const received = job.files.reduce((sum, file) => sum + file.received, 0);
                const totalBytes = job.files.reduce((sum, file) => sum + file.size, 0);
                const progress = bytes => { receivedBytes = bytes; lastProgressAt = Date.now(); operations.update(job.operationId, { phase: 'client-upload', message: '阶段 1/2 · 浏览器 → 服务器：' + file.name, clientBytesReceived: received + bytes, clientTotalBytes: totalBytes, processedBytes: received + bytes, totalBytes, percent: totalBytes ? (received + bytes) / totalBytes * 100 : null }); };
                res.json(req.get('Content-Range')
                    ? await store(req).receivePart(job.id, req.params.index, req, req.get('Content-Range'), progress)
                    : await store(req).receive(job.id, req.params.index, req, progress));
                pipelineWake(job);
                log('browser.receive-complete', { ...trace, receivedBytes, elapsedMs: Date.now() - started });
            } catch (error) {
                log('browser.receive-failed', { ...trace, receivedBytes, elapsedMs: Date.now() - started, error: networkDetails(error) });
                job.pipelineAbort?.abort(); pipelineWake(job);
                await job.pipelineDone?.catch(() => {});
                store(req).abort(job.id); operations.fail(job.operationId, error); throw error;
            }
            finally { clearInterval(heartbeat); }
        }));
        router.post('/uploads/:uploadId/phase', wrap((req, res) => {
            if (!store(req).ownsUpload(owner(req), req.params.uploadId)) throw new Error('UPLOAD_NOT_FOUND');
            const job = store(req).upload(req.params.uploadId);
            if (job.finishing) throw new Error('UPLOAD_IN_PROGRESS');
            operations.update(job.operationId, { status: 'running', phase: 'source-read', percent: null, message: '正在读取本机文件：' + (job.files[req.body?.index]?.name || '') });
            res.json({ ok: true });
        }));
        router.delete('/uploads/:uploadId', wrap(async (req, res) => {
            if (!store(req).ownsUpload(owner(req), req.params.uploadId)) throw new Error('UPLOAD_NOT_FOUND');
            const job = store(req).upload(req.params.uploadId);
            job.pipelineAbort?.abort(); pipelineWake(job);
            await job.pipelineDone?.catch(() => {});
            await rollbackPipelineRemote(job, store(req), 'upload.cancel-cleanup-failed');
            log('upload.cancelled', { uploadId: job.id, operationId: job.operationId });
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
            job.clientDone = true; job.finishing = true; pipelineWake(job);
            log('upload.handoff', { uploadId: job.id, operationId: job.operationId, files: job.files.length, bytes: job.files.reduce((sum, file) => sum + file.size, 0) });
            res.status(202).json({ operation_id: job.operationId });
        }));
        router.get('/files/:id/check', wrap((req, res) => {
            const file = requireEntity(getFile(req));
            jobResponse(req, res, 'check', '正在检测文件', async update => {
                update({ phase: 'telegram-check', message: '正在向 Telegram 检查文件有效性' });
                try {
                    if (typeof telegram.check === 'function') await telegram.check(fileBackend(req, file), file);
                    else await telegram.call(fileBackend(req, file), 'getFile', { file_id: file.fileId });
                    store(req).update(owner(req), file.id, { lastCheckedAt: Date.now() }); return { valid: true };
                }
                catch (_) { return { valid: false }; }
            });
        }));
        router.get('/files/:id/download', wrap(async (req, res) => {
            const file = requireEntity(getFile(req));
            const operation = operations.create(scope(req), 'read', '正在请求 Telegram：' + file.name, file.size);
            const id = operation.operation_id;
            operations.update(id, { status: 'running', phase: 'telegram-request' });
            try {
                const remote = await prepareRemoteResponse(req, res, fileBackend(req, file), file, { operationId: id });
                if (!remote) return operations.fail(id, new Error('RANGE_NOT_SATISFIABLE'));
                let bytes = 0;
                const meter = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; operations.update(id, { phase: 'download', message: '正在读取文件：' + file.name, processedBytes: bytes, totalBytes: remote.range.end - remote.range.start + 1, percent: file.size ? Math.min(100, bytes / (remote.range.end - remote.range.start + 1) * 100) : null }); callback(null, chunk); } });
                await pipeline(remote.source, meter, res);
                operations.complete(id, { id: file.id });
            } catch (error) { operations.fail(id, error); throw error; }
        }));
        router.get('/files/:id/stream', wrap(async (req, res) => {
            const file = requireEntity(getFile(req));
            const remote = await prepareRemoteResponse(req, res, fileBackend(req, file), file, { inline: true });
            if (remote) await pipeline(remote.source, res);
        }));
        router.post('/files/:id/repair', wrap(async (req, res) => {
            const file = requireEntity(getFile(req)); const storage = backend(req);
            if (!storage?.token || !storage?.channelId) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
            if (Number(req.get('X-Disk-File-Size') || req.get('X-Drop2Tunnel-File-Size')) !== file.size) throw new Error('REPAIR_SIZE_INVALID');
            const operation = operations.create(scope(req), 'repair', '正在接收本机修复副本', file.size);
            const job = store(req).begin({ owner: req.diskUser, folderPath: '', files: [{ name: crypto.randomUUID(), type: file.type, size: file.size }], maxDepth: maxDepth(), uploadLimit: LOGICAL_FILE_UPLOAD_LIMIT });
            try { await store(req).receive(job.id, 0, req); }
            catch (error) { store(req).abort(job.id); operations.fail(operation.operation_id, error); throw error; }
            operations.run(operation.operation_id, update => mutate(req, async () => {
                try {
                    if (!store(req).get(owner(req), file.id)) throw new Error('FILE_NOT_FOUND');
                    const [remote] = await telegram.upload(storage, [{ ...job.files[0], logicalId: file.id, name: file.name, folderPath: file.folderPath }], update, [], scope(req));
                    const previous = { fileId: file.fileId, fileUniqueId: file.fileUniqueId, messageId: file.messageId, mediaGroupId: file.mediaGroupId, parts: file.parts || [] };
                    store(req).update(owner(req), file.id, { ...remote, channelId: storage.channelId, backendId: storage.id || '', repairedAt: Date.now(), fileIdHistory: [...(file.fileIdHistory || []), previous] });
                    return { ok: true };
                } finally { store(req).abort(job.id); }
            }));
            res.status(202).json({ operation_id: operation.operation_id });
        }));
    }
    contents(browser); contents(external);
    browser.use(failure); external.use(failure);
    return { browser, external, admin, shared, spaces, retryCaptions, close() { closed = true; clearInterval(cleanupTimer); if (recoveryRetryTimer) clearTimeout(recoveryRetryTimer); } };
}
module.exports = { createDiskAPI, createDiskSpaces, publicFile };
