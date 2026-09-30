'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const { openDiskRepository } = require('../disk-repository');
const { guidePage } = require('./guide');

function registerS3Admin(app, { dataDir, credentials, requireAuth, root, getOrigin = req => `${req.protocol}://${req.get('host')}` }) {
    const repository = openDiskRepository(dataDir), api = express.Router();
    api.use(requireAuth);
    api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    api.use((req, res, next) => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
        const origin = req.get('origin');
        const allowed = [getOrigin(req).replace(/\/$/, ''), `${req.protocol}://${req.get('host')}`];
        if (req.get('sec-fetch-site') === 'cross-site' || origin && !allowed.includes(origin)) return res.status(403).json({ error: '管理操作只允许从当前后台页面发起', code: 'S3_ADMIN_ORIGIN_INVALID' });
        next();
    });
    const error = (res, err) => {
        const messages = {
            S3_CREDENTIAL_INPUT_INVALID: '请填写有效的备注、网盘用户 UUID 和 Bucket / 分区映射',
            S3_USER_NOT_FOUND: '绑定的网盘用户不存在，请先建立网盘账号',
            S3_BACKEND_NOT_FOUND: '选择的存储后端不存在',
            S3_SPACE_NOT_FOUND: '所选分区不属于绑定的网盘用户，请刷新并重新选择',
            S3_ACCESS_KEY_NOT_FOUND: '该接入凭据不存在',
            S3_CREDENTIAL_CONFLICT: '此凭据已被其它操作修改，请刷新后重新编辑',
            S3_CREDENTIALS_BUSY: '凭据配置正由其它进程修改，请稍后重试',
            S3_REVISION_REQUIRED: '更新凭据需要当前版本，请刷新后重试'
        };
        const code = messages[err.message] ? err.message : 'S3_CREDENTIALS_FAILED';
        const status = code === 'S3_ACCESS_KEY_NOT_FOUND' ? 404 : /BUSY|CONFLICT/.test(code) ? 409 : code === 'S3_CREDENTIALS_FAILED' ? 500 : 400;
        if (code === 'S3_CREDENTIALS_BUSY') res.set('Retry-After', '1');
        res.status(status).json({ error: messages[code] || 'S3 接入配置操作失败，请检查服务端数据目录', code });
    };
    function userSpaces(userId) {
        const result = new Set(['']);
        for (const item of repository.load('space_usage')) if (item.userId === userId && typeof item.diskSpace === 'string') result.add(item.diskSpace);
        for (const { name } of repository.load('spaces')) if (repository.load('files', name).some(item => item.ownerId === userId) || repository.load('directories', name).some(item => item.ownerId === userId)) result.add(name);
        return [...result];
    }
    function fields(input) {
        const result = { userId: input?.userId, remark: input?.remark ?? '', bucketMappings: input?.bucketMappings, enabled: input?.enabled ?? true };
        if (typeof result.userId !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(result.userId)
            || !repository.load('users').some(user => user.id === result.userId)) throw new Error('S3_USER_NOT_FOUND');
        if (Array.isArray(result.bucketMappings)) {
            const backends = new Set(repository.load('backends').map(item => item.id));
            const spaces = new Set(userSpaces(result.userId));
            for (const mapping of result.bucketMappings) {
                if (mapping?.backendId && !backends.has(mapping.backendId)) throw new Error('S3_BACKEND_NOT_FOUND');
                if (mapping && !spaces.has(mapping.diskSpace)) throw new Error('S3_SPACE_NOT_FOUND');
            }
        }
        return result;
    }
    function revision(input) {
        if (!Number.isSafeInteger(input?.updatedAt) || input.updatedAt <= 0) throw new Error('S3_REVISION_REQUIRED');
        return { expectedUpdatedAt: input.updatedAt };
    }
    api.get('/', (req, res) => {
        try {
            const users = repository.load('users').map(user => ({ id: user.id, name: user.name || user.username || '网盘用户', username: user.username || '', provider: user.provider || (user.telegramId ? 'telegram' : 'passkey') }));
            const spacesByUser = Object.fromEntries(users.map(user => [user.id, userSpaces(user.id)]));
            const backends = repository.load('backends').map(item => ({ id: item.id, channelId: item.channelId || '' }));
            res.json({ credentials: credentials.list(), users, spacesByUser, backends,
                connection: { endpoint: getOrigin(req).replace(/\/$/, '') + '/S3API', region: 'us-east-1', pathStyle: true, signature: 'AWS Signature Version 4' } });
        } catch (err) { error(res, err); }
    });
    api.post('/', (req, res) => {
        try { res.status(201).json({ credential: credentials.create(fields(req.body)) }); }
        catch (err) { error(res, err); }
    });
    api.patch('/:accessKeyId', (req, res) => {
        try {
            const statusOnly = req.body && Object.keys(req.body).every(name => ['enabled', 'updatedAt'].includes(name));
            let changes;
            if (statusOnly) {
                if (typeof req.body.enabled !== 'boolean') throw new Error('S3_CREDENTIAL_INPUT_INVALID');
                if (req.body.enabled) {
                    const current = credentials.list().find(item => item.accessKeyId === req.params.accessKeyId);
                    if (!current) throw new Error('S3_ACCESS_KEY_NOT_FOUND');
                    fields(current);
                }
                changes = { enabled: req.body.enabled };
            } else changes = fields(req.body);
            res.json({ credential: credentials.update(req.params.accessKeyId, changes, revision(req.body)) });
        }
        catch (err) { error(res, err); }
    });
    api.post('/:accessKeyId/rotate', (req, res) => {
        try { res.json({ credential: credentials.rotate(req.params.accessKeyId, revision(req.body)) }); }
        catch (err) { error(res, err); }
    });
    app.use('/api/admin/s3-credentials', api);
    app.get('/s3-management', requireAuth, (_req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(root, 'pages', 's3-management.html')));
    app.get('/s3-api-guide', requireAuth, async (_req, res) => {
        try {
            const markdown = await fs.readFile(path.join(root, 'docs', 'telegram-drive-s3-compatible.md'), 'utf8');
            res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'" }).type('html').send(guidePage(markdown));
        } catch (_) { res.status(503).type('text').send('S3 接入手册暂时无法读取，请检查部署是否包含 docs/telegram-drive-s3-compatible.md'); }
    });
    return { api };
}
module.exports = { registerS3Admin };
