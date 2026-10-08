'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./support/disk-content-admin-fixture.cjs');

test('Native→Foreign、Foreign A→B 与 Foreign→Native 显式 Copy 共享 Content 且保留源', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await createFixture(); t.after(() => f.close());
    const drive = f.api.spaces.get('');
    drive.createDirectory('alice', '资料/同名', 20);
    for (const path of ['backup', '投递一', '投递二']) drive.createDirectory('bob', path, 20);
    drive.createDirectory('alice', '收件', 20);
    const call = async (user, route, method = 'GET', body) => {
        const response = await fetch(f.base + '/api/telegram/drive' + route, {
            method, headers: { 'X-Test-User': user, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        return { status: response.status, data: await response.json() };
    };
    const grant = async path => {
        const created = await call('bob', '/collaborations/invitations', 'POST', { kind: 'directory', path });
        assert.equal(created.status, 201, JSON.stringify(created.data));
        const token = created.data.url.split('/').at(-1);
        assert.equal((await call('alice', '/collaborations/join', 'POST', { token })).status, 200);
        return created.data.collaboration.id;
    };
    const sourceGrant = await grant('backup');
    const targetOne = await grant('投递一');
    const targetTwo = await grant('投递二');
    const requestCopy = (source, target, mode = 'copy') => call('alice', '/cross-scope/copy', 'POST', { mode, source, target });
    const nativeSource = { kind: 'native', selection: { kind: 'file', id: 'file-a' } };
    const foreignSource = { kind: 'collaboration', collaborationId: sourceGrant,
        selection: { kind: 'file', id: 'file-b' } };
    const first = await requestCopy(nativeSource,
        { kind: 'collaboration', collaborationId: targetOne, destinationPath: '投递一' });
    assert.equal(first.status, 201, JSON.stringify(first.data));
    assert.equal(first.data.sourceKind, 'native'); assert.equal(first.data.targetKind, 'collaboration');
    assert.equal(first.data.copied.length, 1);
    const firstFile = drive.get('bob', first.data.copied[0].id);
    assert.equal(firstFile.contentId, f.sharedId); assert.notEqual(firstFile.id, 'file-a');
    assert.ok(drive.get('alice', 'file-a'));

    const second = await requestCopy(foreignSource,
        { kind: 'collaboration', collaborationId: targetTwo, destinationPath: '投递二' });
    assert.equal(second.status, 201, JSON.stringify(second.data));
    assert.equal(second.data.sourceKind, 'collaboration'); assert.equal(second.data.targetKind, 'collaboration');
    assert.equal(drive.get('bob', second.data.copied[0].id).contentId, f.sharedId);
    assert.ok(drive.get('bob', 'file-b'));

    const third = await requestCopy(foreignSource, { kind: 'native', destinationPath: '收件' });
    assert.equal(third.status, 201, JSON.stringify(third.data));
    assert.equal(drive.get('alice', third.data.copied[0].id).contentId, f.sharedId);
    assert.ok(drive.get('bob', 'file-b'));
    const directory = await requestCopy({ kind: 'collaboration', collaborationId: sourceGrant,
        selection: { kind: 'directory', path: 'backup' } }, { kind: 'native', destinationPath: '收件' });
    assert.equal(directory.status, 201, JSON.stringify(directory.data));
    assert.equal(directory.data.directoryCount, 1);
    assert.equal(directory.data.destination, '收件/backup');
    assert.equal(drive.list('alice', '收件/backup').files.length, 1);
    const mount = await call('alice', '/mounts', 'POST',
        { parentPath: '资料/同名', name: '外来入口', collaborationId: sourceGrant });
    assert.equal(mount.status, 201, JSON.stringify(mount.data));
    const mountedDirectory = await requestCopy({ kind: 'native',
        selection: { kind: 'directory', path: '资料/同名' } },
    { kind: 'collaboration', collaborationId: targetOne, destinationPath: '投递一' });
    assert.equal(mountedDirectory.status, 409);
    assert.equal(drive.getDirectory('bob', '投递一/同名'), null);
    assert.equal(f.remoteCalls, 0, '显式 Copy 不重新上传或删除 Telegram 正文');
    assert.equal((await requestCopy(foreignSource,
        { kind: 'collaboration', collaborationId: targetOne, destinationPath: '投递一' }, 'move')).status, 422);
    assert.ok(drive.get('bob', 'file-b'), '跨授权边界 Move 不删除源');
    f.repository.assertIntegrity();
});

test('跨授权边界 Copy 拒绝 viewer 目标、越界源目标及撤权，并在 SQL 写入时重验目标角色', async t => {
    t.mock.method(console, 'info', () => {});
    const f = await createFixture(); t.after(() => f.close());
    const drive = f.api.spaces.get('');
    drive.createDirectory('alice', '资料/同名', 20);
    for (const path of ['backup', '授权目录', '私有目录']) drive.createDirectory('bob', path, 20);
    const call = async (user, route, method = 'GET', body) => {
        const response = await fetch(f.base + '/api/telegram/drive' + route, {
            method, headers: { 'X-Test-User': user, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        return { status: response.status, data: await response.json() };
    };
    const invite = await call('bob', '/collaborations/invitations', 'POST', { kind: 'directory', path: '授权目录' });
    assert.equal(invite.status, 201);
    const collaborationId = invite.data.collaboration.id;
    assert.equal((await call('alice', '/collaborations/join', 'POST',
        { token: invite.data.url.split('/').at(-1) })).status, 200);
    const target = { kind: 'collaboration', collaborationId, destinationPath: '授权目录' };
    const nativeSource = { kind: 'native', selection: { kind: 'file', id: 'file-a' } };
    const copy = (source, destination) => call('alice', '/cross-scope/copy', 'POST',
        { mode: 'copy', source, target: destination });
    assert.equal((await copy(nativeSource, { ...target, destinationPath: '私有目录' })).status, 403);
    assert.equal((await copy({ kind: 'collaboration', collaborationId,
        selection: { kind: 'file', id: 'file-b' } }, { kind: 'native', destinationPath: '' })).status, 422);
    const version = f.repository.load('collaborations').find(item => item.id === collaborationId).memberVersions.alice;
    const lease = f.content.lease(f.sharedId, 'bob', 'stale-copy', 'reuse');
    try {
        const sourceFile = drive.get('alice', 'file-a'), physical = f.content.resolve(f.sharedId).physical;
        const directCopy = (folderPath, name) => f.repository.atomic(() => drive.putCopiedObject({ id: 'bob' }, folderPath, name,
            { ...sourceFile, ...physical, contentId: f.sharedId, contentLease: lease,
                contentCopyGrant: { kind: 'cross-scope', actorId: 'alice',
                    source: { kind: 'native', ownerId: 'alice', diskSpace: '', fileId: 'file-a' },
                    target: { kind: 'collaboration', ownerId: 'bob', diskSpace: '', id: collaborationId, version } } },
            physical.parts || [], { id: '', channelId: '-1001234567890' }, 20),
        () => drive.reloadPersistence());
        assert.throws(() => directCopy('私有目录', 'out-of-scope.har'), /COLLABORATION_OUT_OF_SCOPE/,
            'SQL 写入边界不得信任预检传入的目标路径');
        assert.equal((await call('bob', `/collaborations/${collaborationId}/members/alice`, 'PATCH',
            { role: 'viewer' })).status, 200);
        assert.equal((await copy(nativeSource, target)).status, 403);
        assert.throws(() => directCopy('授权目录', 'stale.har'), /COLLABORATION_NOT_FOUND/,
            'SQL 写入边界须拒绝已降为 viewer 的旧版本授权');
        assert.equal(drive.list('bob', '授权目录').files.length, 0);
    } finally { f.content.releaseLease(lease); }
    assert.equal((await call('bob', `/collaborations/${collaborationId}/members/alice`, 'DELETE')).status, 200);
    assert.equal((await copy(nativeSource, target)).status, 404);
    drive.createDirectory('alice', '收件', 20);
    const sourceInvite = await call('bob', '/collaborations/invitations', 'POST',
        { kind: 'directory', path: 'backup' });
    assert.equal(sourceInvite.status, 201);
    const sourceGrantId = sourceInvite.data.collaboration.id;
    assert.equal((await call('alice', '/collaborations/join', 'POST',
        { token: sourceInvite.data.url.split('/').at(-1) })).status, 200);
    const sourceVersion = f.repository.load('collaborations').find(item => item.id === sourceGrantId).memberVersions.alice;
    assert.equal((await call('bob', `/collaborations/${sourceGrantId}/members/alice`, 'DELETE')).status, 200);
    const sourceLease = f.content.lease(f.sharedId, 'alice', 'revoked-source', 'reuse');
    try {
        const sourceFile = drive.get('bob', 'file-b'), physical = f.content.resolve(f.sharedId).physical;
        assert.throws(() => f.repository.atomic(() => drive.putCopiedObject({ id: 'alice' }, '收件', 'revoked.har',
            { ...sourceFile, ...physical, contentId: f.sharedId, contentLease: sourceLease,
                contentCopyGrant: { kind: 'cross-scope', actorId: 'alice',
                    source: { kind: 'collaboration', ownerId: 'bob', diskSpace: '', fileId: 'file-b',
                        id: sourceGrantId, version: sourceVersion },
                    target: { kind: 'native', ownerId: 'alice', diskSpace: '' } } },
            physical.parts || [], { id: '', channelId: '-1001234567890' }, 20),
        () => drive.reloadPersistence()), /COLLABORATION_NOT_FOUND/,
        'SQL 写入边界须拒绝已撤销的来源授权');
        assert.equal(drive.list('alice', '收件').files.length, 0);
    } finally { f.content.releaseLease(sourceLease); }
    f.repository.assertIntegrity();
});
