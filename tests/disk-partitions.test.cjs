'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./support/disk-content-admin-fixture.cjs');
const { createS3Credentials } = require('../server/s3/credentials');

test('分区稳定身份、显示名、Shared Content 复刻与删除隔离', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await createFixture(); t.after(() => f.close());
    const call = async (user, path, method = 'GET', body) => {
        const response = await fetch(f.base + '/api/telegram/drive' + path, {
            method, headers: { 'X-Test-User': user, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        return { status: response.status, data: await response.json() };
    };
    const initial = await call('alice', '/spaces');
    assert.equal(initial.status, 200);
    const old = initial.data.spaces.find(item => item.scopeKey === '相册&照片');
    const home = initial.data.spaces.find(item => item.isDefault);
    assert.ok(old?.id); assert.equal(home.scopeKey, '');
    const renamedDefault = await call('alice', '/spaces/' + home.id, 'PATCH', { name: '我的网盘' });
    assert.equal(renamedDefault.status, 200); assert.equal(renamedDefault.data.partition.scopeKey, '');
    assert.equal((await call('alice', '/spaces', 'POST', { name: '我的网盘' })).status, 409);
    assert.equal((await call('bob', '/spaces', 'POST', { name: '我的网盘' })).status, 201,
        '不同用户可以使用相同显示名称');
    assert.equal((await call('bob', '/spaces')).data.spaces.some(item => item.scopeKey === old.scopeKey), false);
    assert.equal((await call('bob', '/spaces/' + old.id, 'PATCH', { name: '偷改' })).status, 404);
    const scopesBeforeUnknown = f.repository.load('spaces').map(item => item.name);
    assert.equal((await call('alice', '/list?disk_space=malicious-unknown')).status, 404);
    assert.deepEqual(f.repository.load('spaces').map(item => item.name), scopesBeforeUnknown,
        '未知分区读取不得反向创建 Store');
    const renamed = await call('alice', '/spaces/' + old.id, 'PATCH', { name: '媒体库' });
    assert.equal(renamed.status, 200); assert.equal(renamed.data.partition.id, old.id);
    assert.equal(renamed.data.partition.scopeKey, old.scopeKey);
    const oldFile = f.repository.load('files', old.scopeKey).find(file => file.id === 'file-photo');
    assert.equal(oldFile.contentId, f.sharedId);
    assert.equal((await call('alice', '/spaces/' + home.id, 'DELETE', { confirm: true })).status, 422);

    const clonePreview = await call('alice', '/spaces/' + old.id + '/clone-preview');
    assert.equal(clonePreview.status, 200);
    assert.equal(clonePreview.data.impact.files, 1);
    const clone = await call('alice', '/spaces/' + old.id + '/clone', 'POST', { name: '媒体库 副本' });
    assert.equal(clone.status, 202, JSON.stringify(clone.data));
    assert.ok(clone.data.operation_id);
    let cloneJob;
    for (let attempt = 0; attempt < 100; attempt++) {
        cloneJob = await call('alice', '/operations/' + clone.data.operation_id + '?disk_space=' + encodeURIComponent(old.id));
        if (['completed', 'failed'].includes(cloneJob.data?.status)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(cloneJob.data?.status, 'completed', JSON.stringify({ response: cloneJob.data,
        operations: f.repository.load('operations') }));
    const clonedResult = cloneJob.data.result;
    assert.equal(clonedResult.files, 1); assert.equal(clonedResult.skippedMounts, 0);
    const cloned = clonedResult.partition;
    assert.notEqual(cloned.id, old.id); assert.notEqual(cloned.scopeKey, old.scopeKey);
    const clonedFile = f.repository.load('files', cloned.scopeKey)[0];
    assert.equal(clonedFile.ownerId, 'alice'); assert.notEqual(clonedFile.id, oldFile.id);
    assert.equal(clonedFile.contentId, f.sharedId);
    assert.equal(f.remoteCalls, 0, '复刻不得调用 Telegram');

    const preview = await call('alice', '/spaces/' + cloned.id + '/delete-preview');
    assert.equal(preview.status, 200); assert.equal(preview.data.impact.files, 1);
    const deletion = await call('alice', '/spaces/' + cloned.id, 'DELETE', { confirm: true });
    assert.equal(deletion.status, 202);
    let deletionJob;
    for (let attempt = 0; attempt < 100; attempt++) {
        deletionJob = await call('alice', '/operations/' + deletion.data.operation_id + '?disk_space=' + encodeURIComponent(cloned.id));
        if (['completed', 'failed'].includes(deletionJob.data?.status)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(deletionJob.data?.status, 'completed', JSON.stringify(deletionJob.data));
    assert.equal(f.repository.load('files', cloned.scopeKey).length, 0);
    assert.equal(f.repository.load('files', old.scopeKey).length, 1);
    assert.equal((await call('alice', '/list?disk_space=' + encodeURIComponent(cloned.scopeKey))).status, 404);
    assert.equal(f.content.resolve(f.sharedId).state, 'READY');
    const recreated = await call('alice', '/spaces', 'POST', { name: '媒体库 副本' });
    assert.equal(recreated.status, 201); assert.notEqual(recreated.data.diskSpace, cloned.scopeKey);
    assert.equal(f.repository.load('files', recreated.data.diskSpace).length, 0);
    f.repository.assertIntegrity();
});

test('同分区复制允许独立 Logical 引用，拒绝目录复制到自身后代', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await createFixture(); t.after(() => f.close());
    const space = (await (await fetch(f.base + '/api/telegram/drive/spaces')).json()).spaces
        .find(item => item.scopeKey === '相册&照片');
    const store = f.api.spaces.get(space.scopeKey);
    store.createDirectory('alice', '副本目标', 20);
    const request = body => fetch(f.base + '/api/telegram/drive/spaces/transfer?disk_space=' + encodeURIComponent(space.id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const copied = await request({ targetSpace: space.id, mode: 'copy', destinationPath: '副本目标',
        items: [{ kind: 'file', id: 'file-photo' }] });
    assert.equal(copied.status, 200, await copied.clone().text());
    const item = store.list('alice', '副本目标').files[0];
    assert.notEqual(item.id, 'file-photo'); assert.equal(item.contentId, f.sharedId);
    assert.ok(store.get('alice', 'file-photo'));
    const invalid = await request({ targetSpace: space.id, mode: 'copy',
        destinationPath: '日本語 & 测试/留档', items: [{ kind: 'directory', path: '日本語 & 测试' }] });
    assert.equal(invalid.status, 422);
    assert.equal(store.list('alice', '日本語 & 测试/留档').files.length, 1);
    f.repository.assertIntegrity();
});

test('并发复刻同名分区仅一个任务提交，失败者不留下半可见分区', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await createFixture(); t.after(() => f.close());
    const request = async (path, method = 'GET', body) => {
        const response = await fetch(f.base + '/api/telegram/drive' + path, {
            method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {})
        });
        return { status: response.status, data: await response.json() };
    };
    const source = (await request('/spaces')).data.spaces.find(item => item.scopeKey === '相册&照片');
    const accepted = await Promise.all([0, 1].map(() => request('/spaces/' + source.id + '/clone', 'POST', { name: '并发副本' })));
    assert.deepEqual(accepted.map(item => item.status), [202, 202]);
    const jobs = [];
    for (const item of accepted) {
        let job;
        for (let attempt = 0; attempt < 100; attempt++) {
            job = await request('/operations/' + item.data.operation_id + '?disk_space=' + encodeURIComponent(source.id));
            if (['completed', 'failed'].includes(job.data?.status)) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        jobs.push(job.data);
    }
    assert.deepEqual(jobs.map(job => job.status).sort(), ['completed', 'failed']);
    assert.equal((await request('/spaces')).data.spaces.filter(item => item.name === '并发副本').length, 1);
    f.repository.assertIntegrity();
});

test('分区删除预检阻止未结束任务和活跃协同', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await createFixture(); t.after(() => f.close());
    const request = async (path, method = 'GET', body) => {
        const response = await fetch(f.base + '/api/telegram/drive' + path, {
            method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {})
        });
        return { status: response.status, data: await response.json() };
    };
    const created = await request('/spaces', 'POST', { name: '待删除' });
    const partition = created.data.partition;
    const scope = partition.scopeKey;
    f.repository.replace('operations', [{ operation_id: 'ongoing', userId: 'alice', diskSpace: scope,
        type: 'upload', status: 'running', createdAt: Date.now() }], job => job.operation_id);
    const preview = await request('/spaces/' + partition.id + '/delete-preview');
    assert.equal(preview.data.impact.activeTasks, 1);
    assert.equal((await request('/spaces/' + partition.id, 'DELETE', { confirm: true })).status, 409);
    f.repository.replace('operations', [], job => job.operation_id);
    const store = f.api.spaces.get(scope);
    store.createDirectory('alice', '授权项目', 20);
    const active = await request('/collaborations/invitations?disk_space=' + encodeURIComponent(scope), 'POST',
        { kind: 'directory', path: '授权项目' });
    assert.equal(active.status, 201);
    assert.equal((await request('/spaces/' + partition.id, 'DELETE', { confirm: true })).status, 409);
    assert.ok(store.getDirectory('alice', '授权项目'));
    f.repository.assertIntegrity();
});

test('中断删除仅在原任务已失败时可显式恢复，原生数据保持完整', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await createFixture(); t.after(() => f.close());
    const request = async (path, method = 'GET') => {
        const response = await fetch(f.base + '/api/telegram/drive' + path, { method });
        return { status: response.status, data: await response.json() };
    };
    const space = (await request('/spaces')).data.spaces.find(item => item.scopeKey === '相册&照片');
    const partitions = f.repository.load('partitions');
    const row = partitions.find(item => item.id === space.id);
    row.state = 'DELETING'; row.updatedAt = Date.now();
    f.repository.replace('partitions', partitions, item => item.id);
    const job = { operation_id: 'interrupted-delete', userId: 'alice', diskSpace: space.scopeKey,
        type: 'space-delete', status: 'running', createdAt: Date.now() };
    f.repository.replace('operations', [job], item => item.operation_id);
    assert.equal((await request('/spaces/' + space.id + '/recover-delete', 'POST')).status, 409);
    job.status = 'failed'; job.errorCode = 'SERVER_RESTARTED';
    f.repository.replace('operations', [job], item => item.operation_id);
    const recovered = await request('/spaces/' + space.id + '/recover-delete?disk_space=' + encodeURIComponent(space.id), 'POST');
    assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
    assert.equal(recovered.data.partition.state, 'ACTIVE');
    assert.equal(f.repository.load('files', space.scopeKey).some(file => file.id === 'file-photo'), true);
    assert.equal((await request('/spaces/' + space.id + '/recover-delete', 'POST')).status, 422);
    f.repository.assertIntegrity();
});

test('删除分区只撤销本用户链接、S3 映射及 Logical 引用', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await createFixture(); t.after(() => f.close());
    const call = async (path, method = 'GET', body) => {
        const response = await fetch(f.base + '/api/telegram/drive' + path, {
            method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {})
        });
        return { status: response.status, data: await response.json() };
    };
    const partition = (await call('/spaces', 'POST', { name: '临时副本' })).data.partition;
    const query = '?disk_space=' + encodeURIComponent(partition.id);
    const copied = await call('/spaces/transfer', 'POST', { targetSpace: partition.id,
        mode: 'copy', destinationPath: '', items: [{ kind: 'file', id: 'file-a' }] });
    assert.equal(copied.status, 200);
    const copiedId = copied.data.copied[0].id;
    const share = await call('/shares' + query, 'POST', { items: [{ kind: 'file', id: copiedId }] });
    assert.equal(share.status, 201);
    const staticLink = await call('/static-resources' + query, 'POST',
        { items: [{ kind: 'file', id: copiedId }], preset: 'day' });
    assert.equal(staticLink.status, 201);
    const credentials = createS3Credentials(f.dataDir);
    const credential = credentials.create({ userId: 'alice',
        bucketMappings: [{ bucket: 'partition-delete-test', diskSpace: partition.scopeKey }] });
    assert.equal(credential.enabled, true);
    const deleted = await call('/spaces/' + partition.id, 'DELETE', { confirm: true });
    assert.equal(deleted.status, 202, JSON.stringify(deleted.data));
    let job;
    for (let attempt = 0; attempt < 100; attempt++) {
        job = await call('/operations/' + deleted.data.operation_id + query);
        if (['completed', 'failed'].includes(job.data?.status)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(job.data?.status, 'completed', JSON.stringify(job.data));
    assert.equal(job.data.result.revokedS3Credentials, 1);
    assert.equal(f.repository.load('files', partition.scopeKey).length, 0);
    assert.equal(f.repository.load('shares').some(item => item.diskSpace === partition.scopeKey && item.ownerId === 'alice'), false);
    assert.equal(f.repository.load('static_resources').some(item => item.diskSpace === partition.scopeKey && item.ownerId === 'alice'), false);
    assert.equal(credentials.list().find(item => item.accessKeyId === credential.accessKeyId).enabled, false);
    assert.equal(f.repository.load('files').find(item => item.id === 'file-a').contentId, f.sharedId);
    assert.equal(f.content.resolve(f.sharedId).state, 'READY');
    f.repository.assertIntegrity();
});

test('SQLite 在多节点类型间原子阻止 Mount 与原生文件目录重名', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await createFixture(); t.after(() => f.close());
    const mount = { id: 'mount-one', ownerId: 'alice', diskSpace: '',
        parentPath: '', folderPath: '', name: '冲突入口', collaborationId: 'foreign' };
    f.repository.replace('collaboration_mounts', [mount], item => item.id);
    const directories = f.repository.load('directories');
    assert.throws(() => f.repository.replace('directories', [...directories,
        { ownerId: 'alice', path: '冲突入口', createdAt: Date.now() }],
    item => `${item.ownerId}:${item.path}`), /MOUNT_NAME_CONFLICT/);
    const files = f.repository.load('files');
    assert.throws(() => f.repository.replace('files', [...files,
        { id: 'collision-file', ownerId: 'alice', name: '冲突入口', folderPath: '',
            type: 'application/octet-stream', size: 0, parts: [], createdAt: Date.now() }], item => item.id),
    /MOUNT_NAME_CONFLICT/);
    assert.throws(() => f.repository.replace('collaboration_mounts', [mount,
        { ...mount, id: 'mount-two', parentPath: '资料/同名', folderPath: '资料/同名', name: '相同.har' }], item => item.id),
    /MOUNT_NAME_CONFLICT/);
    f.repository.assertIntegrity();
});
