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

function temp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr2t-task-save-261019-'));
    return dir;
}
async function fixture(t) {
    const dataDir = temp(t), auth = createDiskAuth({ dataDir }), operations = createDiskOperations({ dataDir });
    const user = auth.fromTelegram({ id: '1' }, 'mock'), other = auth.fromTelegram({ id: '2' }, 'mock');
    const sources = new Map(), sent = [];
    for (const source of ['sns', 'youtube']) {
        const filename = source + '.mp4', file = path.join(dataDir, filename); fs.writeFileSync(file, source);
        sources.set(source, { path: file, name: filename, size: source.length, version: '1000-' + source.length });
    }
    let fail = false, release;
    const telegram = { async upload(_backend, files) {
        if (release) await new Promise(resolve => { release.resolve = resolve; });
        if (fail) throw Error('fixture-upload-failed');
        return files.map((file, i) => { sent.push(fs.readFileSync(file.path).subarray(file.start || 0, file.end === undefined ? undefined : file.end + 1).toString()); return { fileId: 'remote-' + sent.length, messageId: sent.length, size: file.size }; });
    }, remove: async () => {}, syncCaption: async () => {} };
    const api = createDiskAPI({ dataDir, auth, operations, telegram, defaultStore: createTelegramDriveStore({ dataDir }),
        getIdentity: req => req.get('test-user') === 'other' ? other : user, getDefaultBackend: () => ({ token: 'fixture', channelId: '-1001' }),
        setIdentity() {}, getOrigin: () => 'http://localhost', isMockRequest: () => true, contentReuseMode: 'off',
        resolveTaskSource(req, input) {
            if (req.get('test-admin') !== 'yes') throw Error('TASK_SAVE_ADMIN_AUTH_REQUIRED');
            const value = sources.get(input.source);
            if (!value || input.taskId !== 'fixture-task') throw Error('TASK_SAVE_SOURCE_UNAVAILABLE');
            if (input.version !== value.version) throw Error('TASK_SAVE_VERSION_CONFLICT');
            return { ...value, type: 'video/mp4', sourceInfo: { title: 'Fixture' } };
        }
    });
    const app = express(); app.use(express.json()); app.use('/drive', api.browser);
    const server = await require('./support/listen-http.cjs').listenHttp(app);
    t.after(async () => {
        release?.resolve?.(); release = null;
        for (let i = 0; i < 100 && operations.list({ userId: user.id, diskSpace: '' }).some(job => !['completed','failed','cancelled'].includes(job.status)); i++) await new Promise(resolve => setTimeout(resolve, 10));
        api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); fs.rmSync(dataDir, { recursive: true, force: true });
    });
    const request = async (url, body, headers = {}) => {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/drive' + url, { method: body ? 'POST' : 'GET',
            headers: { 'content-type': 'application/json', 'test-admin': 'yes', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const text = await response.text(); let data; try { data = JSON.parse(text); } catch (_) { data = { error: 'HTTP ' + response.status }; }
        return { status: response.status, data };
    };
    const body = source => ({ pendingSaveId: crypto.randomUUID(), source, taskId: 'fixture-task', version: sources.get(source).version, folderPath: '' });
    const completed = async (id, headers = {}) => { let value; for (let i = 0; i < 150; i++) { value = (await request('/pending-saves/' + id, null, headers)).data; if (value.state === 'completed' || value.safeRetry) break; await new Promise(resolve => setTimeout(resolve, 5)); } return value; };
    return { dataDir, api, auth, operations, user, sources, sent, request, body, completed, pause: () => release = {}, resume: () => { release?.resolve?.(); release = null; }, fail: value => fail = value };
}

test('SNS and Premium task files reach the disk through the server without browser file uploads', async t => {
    const f = await fixture(t);
    for (const source of ['sns', 'youtube']) {
        const body = f.body(source), accepted = await f.request('/task-saves', body);
        assert.equal(accepted.status, 202, JSON.stringify(accepted.data)); assert.ok(accepted.data.operation_id);
        const result = await f.completed(body.pendingSaveId); assert.equal(result.state, 'completed'); assert.equal(result.result.items.length, 1);
        assert.equal((await f.request('/task-saves', body)).status, 409);
        assert.equal((await f.request('/pending-saves/' + body.pendingSaveId, null, { 'test-user': 'other' })).data.found, false);
    }
    assert.deepEqual(f.sent, ['sns', 'youtube']);
});

test('task transfer rejects missing admin authorization, changed versions and unavailable sources before upload', async t => {
    const f = await fixture(t), body = f.body('sns');
    assert.equal((await f.request('/task-saves', body, { 'test-admin': 'no' })).status, 401);
    assert.equal((await f.request('/task-saves', { ...body, version: 'old' })).data.error, 'TASK_SAVE_VERSION_CONFLICT');
    fs.unlinkSync(f.sources.get('sns').path);
    assert.equal((await f.request('/task-saves', body)).data.error, 'TASK_SAVE_SOURCE_UNAVAILABLE');
    assert.equal((await f.request('/pending-saves/' + body.pendingSaveId)).data.found, false); assert.equal(f.sent.length, 0);
});

test('concurrent submissions reserve one server transfer and never overwrite an existing disk file', async t => {
    const f = await fixture(t), body = f.body('sns');
    const responses = await Promise.all([f.request('/task-saves', body), f.request('/task-saves', body)]);
    assert.deepEqual(responses.map(value => value.status).sort(), [202, 409]); assert.equal((await f.completed(body.pendingSaveId)).state, 'completed');
    const duplicate = await f.request('/task-saves', f.body('sns')); assert.notEqual(duplicate.status, 202);
    assert.equal(f.sent.length, 1);
});

test('a confirmed server upload failure can retry, while a live transfer cannot be resubmitted', async t => {
    const f = await fixture(t), body = f.body('youtube'); f.fail(true);
    assert.equal((await f.request('/task-saves', body)).status, 202);
    assert.equal((await f.completed(body.pendingSaveId)).safeRetry, true); f.fail(false);
    assert.equal((await f.request('/task-saves', body)).status, 202);
    assert.equal((await f.completed(body.pendingSaveId)).state, 'completed'); assert.equal(f.sent.length, 1);
});

test('server transfer stays bound to the chosen partition and continues after the source pathname is removed', async t => {
    const f = await fixture(t), partition = (await f.request('/spaces', { name: '目标分区' })).data;
    const body = { ...f.body('sns'), partitionId: partition.partition.id }, headers = { 'X-Disk-Space': partition.diskSpace };
    assert.equal((await f.request('/task-saves', body)).data.error, 'PENDING_SAVE_TARGET_CONFLICT');
    assert.notEqual((await f.request('/task-saves', body, { ...headers, 'test-user': 'other' })).status, 202);
    f.pause(); const accepted = await f.request('/task-saves', body, headers); assert.equal(accepted.status, 202);
    assert.equal((await f.request('/task-saves', body, headers)).status, 409);
    fs.unlinkSync(f.sources.get('sns').path); f.resume();
    assert.equal((await f.completed(body.pendingSaveId, headers)).state, 'completed');
    assert.equal(f.api.spaces.get(partition.diskSpace).list(f.user.id, '').files.length, 1);
    assert.equal(f.api.spaces.get('').list(f.user.id, '').files.length, 0); assert.deepEqual(f.sent, ['sns']);
});

test('the production source resolver checks administrator access and task version and never accepts a caller file path', () => {
    const { createDownloadTaskSource } = require('../server/download-task-source');
    const task = { id: 'task', status: 'completed', hasFile: true, completedAt: 42, outputFileSize: 3, url: 'https://name:secret@example.com/watch?v=1&token=secret' };
    const resolve = createDownloadTaskSource({ isAdmin: req => req.admin, services: { sns: { get: () => task, getFile: () => ({ path: '/trusted-output/file.mp4', name: 'file.mp4' }) } } });
    const input = { source: 'sns', taskId: 'task', version: '42-3', path: '/private/arbitrary-file' };
    assert.throws(() => resolve({}, input), /TASK_SAVE_ADMIN_AUTH_REQUIRED/);
    assert.throws(() => resolve({ admin: true }, { ...input, version: 'old' }), /TASK_SAVE_VERSION_CONFLICT/);
    const source = resolve({ admin: true }, input); assert.equal(source.path, '/trusted-output/file.mp4'); assert.equal(source.sourceInfo.url, 'https://example.com/watch?v=1');
    task.status = 'cleared'; assert.throws(() => resolve({ admin: true }, input), /TASK_SAVE_SOURCE_UNAVAILABLE/);
});

test('migrated retries preserve an old browser reservation and use a new version-bound server reservation', async t => {
    const f=await fixture(t),{openDiskRepository}=require('../server/disk-repository'),{createDiskPendingSaves}=require('../server/disk-pending-saves');
    const journal=createDiskPendingSaves(openDiskRepository(f.dataDir)),body=f.body('sns'),legacyId=body.pendingSaveId;
    journal.reserve(f.user.id,legacyId,'','',[{name:'sns.mp4',size:3,type:'video/mp4'}]);journal.safeFailure(f.user.id,legacyId);
    assert.equal((await f.request('/task-saves',body)).data.error,'PENDING_SAVE_TARGET_CONFLICT');
    const serverId=crypto.randomUUID();assert.equal((await f.request('/task-saves',{...body,pendingSaveId:serverId})).status,202);
    assert.equal((await f.completed(serverId)).state,'completed');assert.equal(journal.get(f.user.id,legacyId).state,'failed');assert.equal(f.sent.length,1);
});
