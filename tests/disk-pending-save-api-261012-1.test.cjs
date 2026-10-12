'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { createDiskAPI } = require('../server/disk-api');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskOperations } = require('../server/disk-operations');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { openDiskRepository } = require('../server/disk-repository');
const { createDiskPendingSaves } = require('../server/disk-pending-saves');
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-save-api-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
test('待转存唯一预约、固定目标及账号隔离，确认失败才允许重试', t => {
    const dataDir = temp(t), repository = openDiskRepository(dataDir), journal = createDiskPendingSaves(repository);
    const id = crypto.randomUUID(), files = [{ name: 'a.txt', size: 3 }];
    journal.reserve('a', id, '', '', files);
    assert.equal(createDiskPendingSaves(repository).get('a', id).safeRetry, false, '另一个API实例不得抢占仍在执行的预约');
    assert.throws(() => journal.reserve('a', id, '', '', files), /ALREADY_STARTED/);
    assert.throws(() => journal.reserve('a', id, 'other', '', files), /TARGET_CONFLICT/);
    assert.equal(journal.get('b', id), null);
    journal.safeFailure('a', id); journal.reserve('a', id, '', '', files);
    journal.complete('a', id, [{ id: 'logical-a' }]);
    assert.throws(() => journal.reserve('a', id, '', '', files), /ALREADY_STARTED/);
    assert.equal(createDiskPendingSaves(repository).get('a', id).fileIds[0], 'logical-a');
    repository.assertIntegrity();
});
test('真实HTTP转存：重复创建被拦截、发布完成可恢复、丢失完成凭据仍从已发布记录确认', async t => {
    const dataDir = temp(t), auth = createDiskAuth({ dataDir }), operations = createDiskOperations({ dataDir });
    const user = auth.fromTelegram({ id: '1' }, 'mock'), other = auth.fromTelegram({ id: '2' }, 'mock');
    const drive = createTelegramDriveStore({ dataDir }); let sends = 0;
    const telegram = { upload: async (_backend, files) => { sends++; return files.map((file, i) => ({ fileId: 'file-' + i, messageId: i + 1, size: file.size })); }, remove: async () => {}, syncCaption: async () => {} };
    const api = createDiskAPI({ dataDir, auth, operations, telegram, defaultStore: drive, getIdentity: req => req.get('test-user') === 'other' ? other : user,
        getDefaultBackend: () => ({ token: 'test', channelId: '-1001' }), setIdentity: () => {}, getOrigin: () => 'http://localhost', isMockRequest: () => true, contentReuseMode: 'off' });
    const app = express(); app.use(express.json()); app.use('/api/telegram/drive', api.browser);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { api.close(); await new Promise(resolve => server.close(resolve)); });
    const request = async (url, body, headers = {}) => { const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/telegram/drive' + url,
        { method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}), headers: { 'content-type': 'application/json', ...headers } }); return { code: response.status, data: await response.json() }; };
    const id = crypto.randomUUID(), body = { folderPath: '', files: [{ name: 'cached.txt', size: 3, type: 'text/plain' }], metadata: { pendingSaveId: id } };
    const created = await request('/uploads', body); assert.equal(created.code, 201);
    assert.equal((await request('/uploads', body)).data.error, 'PENDING_SAVE_ALREADY_STARTED');
    const url = 'http://127.0.0.1:' + server.address().port + '/api/telegram/drive/uploads/' + created.data.uploadId;
    assert.equal((await fetch(url + '/files/0', { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-2/3' }, body: 'abc' })).status, 200);
    await request('/uploads/' + created.data.uploadId + '/finish', {});
    let found;
    for (let i = 0; i < 100; i++) { found = (await request('/pending-saves/' + id)).data; if (found.state === 'completed') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(found.state, 'completed'); assert.equal(found.result.items.length, 1); assert.equal(sends, 1);
    assert.equal((await request('/pending-saves/' + id, null, { 'test-user': 'other' })).data.found, false);
    const repository = openDiskRepository(dataDir), row = repository.load('pending_saves', user.id)[0];
    row.state = 'uploading'; row.fileIds = []; repository.replace('pending_saves', [row], item => item.id, user.id);
    assert.equal((await request('/pending-saves/' + id)).data.state, 'completed');
    assert.equal((await request('/uploads', body)).data.error, 'PENDING_SAVE_ALREADY_STARTED');
    assert.equal(sends, 1); repository.assertIntegrity();
});
