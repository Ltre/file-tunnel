'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { createDiskCollaborationStore } = require('../server/disk-collaboration');
const { createDiskCollaborationMountStore } = require('../server/disk-collaboration-mounts');
const { openDiskRepository } = require('../server/disk-repository');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-mount-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const drive = createTelegramDriveStore({ dataDir: dir });
    const collaborations = createDiskCollaborationStore(dir);
    const mounts = createDiskCollaborationMountStore(dir, { collaborations });
    const repository = openDiskRepository(dir);
    drive.createDirectory('guest', '本地/子目录', 20);
    drive.createDirectory('owner', '远端', 20);
    const { collaboration, invite } = collaborations.enable({ ownerId:'owner', kind:'directory', path:'远端', name:'远端' });
    collaborations.join(invite.token, 'guest');
    drive.setExternalNameGuard((ownerId, parentPath, name) => mounts.assertNameFree(ownerId, '', parentPath, name));
    const create = (parentPath = '本地', name = '挂载') => mounts.create({ ownerId:'guest', diskSpace:'', parentPath, name,
        collaborationId:collaboration.id, drive });
    return { dir, drive, collaborations, mounts, repository, collaboration, create };
}

test('Mount 是独立持久化叶节点；同一协同可多处挂载，撤权后原位失效', t => {
    const f = fixture(t);
    const first = f.create('本地', '共享项目');
    const second = f.create('本地/子目录', '共享项目');
    assert.notEqual(first.id, second.id);
    assert.equal(f.mounts.resolve(first.id, 'guest', '').grant.ownerId, 'owner');
    assert.equal(f.mounts.list('guest', '', '本地').length, 1);
    assert.equal(f.drive.getDirectoryTree('guest', '本地').files.length, 0, 'Mount 不是 Native 文件');
    const db = new DatabaseSync(path.join(f.dir, 'disk.sqlite'));
    try { assert.equal(db.prepare('SELECT count(*) AS count FROM disk_content_refs').get().count, 0, 'Mount 不产生 Content 引用'); }
    finally { db.close(); }
    assert.throws(() => f.create('本地', '共享项目'), /MOUNT_NAME_CONFLICT/);
    const reopened = createDiskCollaborationMountStore(f.dir, { collaborations: f.collaborations });
    assert.equal(reopened.find(second.id, 'guest', '').status, 'active');
    f.collaborations.kick(f.collaboration.id, 'guest', 'owner', '');
    assert.equal(reopened.find(first.id, 'guest', '').status, 'inaccessible');
    assert.throws(() => reopened.resolve(first.id, 'guest', ''), /MOUNT_ACCESS_REVOKED/);
    assert.deepEqual(reopened.remove(first.id, 'guest', ''), { removedMountId: first.id });
    assert.equal(reopened.find(second.id, 'guest', '').status, 'inaccessible');
    assert.equal(f.drive.getDirectory('owner', '远端').path, '远端', '本地移除不得触及远端');
});

test('Mount 与原生目录和 active 协同目录不能重叠，但允许兄弟节点', t => {
    const f = fixture(t);
    assert.throws(() => f.create('本地', '子目录'), /MOUNT_NAME_CONFLICT/);
    const own = f.collaborations.enable({ ownerId:'guest', kind:'directory', path:'本地/子目录', name:'子目录' });
    assert.throws(() => f.create('本地/子目录', '失败'), /MOUNT_COLLABORATION_OVERLAP/);
    const sibling = f.create('本地', '兄弟挂载');
    assert.ok(sibling.id);
    assert.throws(() => f.drive.createDirectory('guest', '本地/兄弟挂载', 20), /MOUNT_NAME_CONFLICT/);
    assert.throws(() => f.mounts.assertCanEnableDirectory('guest', '', '本地'), /MOUNT_COLLABORATION_OVERLAP/);
    assert.doesNotThrow(() => f.mounts.assertCanEnableDirectory('guest', '', '本地/子目录'));
    assert.throws(() => f.mounts.assertCanRelocateDirectory('guest', '', '本地/子目录', '本地'), /MOUNT_COLLABORATION_OVERLAP/);
    assert.equal(own.collaboration.path, '本地/子目录');
});

test('Native 目录移动与后代 Mount 路径同事务提交或一同回滚', t => {
    const f = fixture(t);
    f.drive.createDirectory('guest', '目标', 20);
    const item = f.create('本地/子目录', '入口');
    const rollback = () => { f.drive.reloadPersistence(); f.mounts.reloadPersistence(); f.collaborations.reloadPersistence(); };
    assert.throws(() => f.repository.atomic(() => {
        const moved = f.drive.moveDirectory('guest', '本地', '目标', 20);
        f.mounts.relocateDirectory('guest', '', '本地', moved.path);
        throw new Error('rollback');
    }, rollback), /rollback/);
    assert.equal(f.mounts.find(item.id, 'guest', '').parentPath, '本地/子目录');
    f.repository.atomic(() => {
        const moved = f.drive.moveDirectory('guest', '本地', '目标', 20);
        f.mounts.relocateDirectory('guest', '', '本地', moved.path);
    }, rollback);
    assert.equal(f.mounts.find(item.id, 'guest', '').parentPath, '目标/本地/子目录');
    f.repository.atomic(() => {
        f.mounts.removeTree('guest', '', '目标/本地');
        f.drive.removeDirectory('guest', '目标/本地', true);
    }, rollback);
    assert.equal(f.mounts.find(item.id, 'guest', ''), null);
    assert.ok(f.drive.getDirectory('owner', '远端'));
});

test('旧成员默认为 editor，降级后版本递增并持久化', t => {
    const f = fixture(t);
    const grant = f.collaborations.authorized(f.collaboration.id, 'guest');
    assert.equal(grant.role, 'editor');
    const oldVersion = grant.grantVersion;
    f.collaborations.setRole(f.collaboration.id, 'guest', 'viewer', 'owner', '');
    const current = f.collaborations.authorized(f.collaboration.id, 'guest');
    assert.equal(current.role, 'viewer');
    assert.ok(current.grantVersion > oldVersion);
    const reopened = createDiskCollaborationStore(f.dir);
    assert.equal(reopened.authorized(f.collaboration.id, 'guest').role, 'viewer');
    assert.throws(() => reopened.setRole(f.collaboration.id, 'missing', 'viewer', 'owner', ''), /COLLABORATION_MEMBER_NOT_FOUND/);
    assert.equal(f.collaborations.authorized(f.collaboration.id, 'guest').role, 'viewer');
    reopened.kick(f.collaboration.id, 'guest', 'owner', '');
    assert.equal(f.collaborations.authorizedFresh(f.collaboration.id, 'guest'), null, '跨实例踢出需立即使旧授权失效');
});

test('没有 memberRoles 字段的旧协同成员继续拥有 editor 权限', t => {
    const f = fixture(t);
    const db = new DatabaseSync(path.join(f.dir, 'disk.sqlite'));
    try {
        const row = db.prepare("SELECT payload FROM disk_collaborations WHERE scope='' AND id=?").get(f.collaboration.id);
        const legacy = JSON.parse(row.payload);
        delete legacy.memberRoles;
        db.prepare("UPDATE disk_collaborations SET payload=? WHERE scope='' AND id=?").run(JSON.stringify(legacy), f.collaboration.id);
    } finally { db.close(); }
    const reopened = createDiskCollaborationStore(f.dir);
    assert.equal(reopened.authorized(f.collaboration.id, 'guest').role, 'editor');
    assert.equal(reopened.publicEntry(reopened.find(f.collaboration.id)).memberRoles.guest, 'editor');
});

test('远端目标失效时只保留本地挂载指针，不允许再访问或新建挂载', t => {
    const f = fixture(t);
    const item = f.create();
    let available = true;
    const guarded = createDiskCollaborationMountStore(f.dir, {
        collaborations: f.collaborations,
        isTargetAvailable: () => available
    });
    assert.equal(guarded.find(item.id, 'guest', '').status, 'active');
    available = false;
    assert.equal(guarded.find(item.id, 'guest', '').status, 'inaccessible');
    assert.throws(() => guarded.resolve(item.id, 'guest', ''), /MOUNT_ACCESS_REVOKED/);
    assert.throws(() => guarded.create({ ownerId:'guest', diskSpace:'', parentPath:'本地', name:'另一个入口',
        collaborationId:f.collaboration.id, drive:f.drive }), /MOUNT_GRANT_NOT_AVAILABLE/);
    assert.equal(guarded.remove(item.id, 'guest', '').removedMountId, item.id);
    assert.ok(f.drive.getDirectory('owner', '远端'));
});

test('Mount 可跨本人 Native 分区移动指针，回滚不产生双挂载', t => {
    const f = fixture(t);
    const targetDrive = createTelegramDriveStore({ dataDir:path.join(f.dir, 'target'), repositoryDir:f.dir, diskSpace:'other' });
    targetDrive.createDirectory('guest', '目标', 20);
    targetDrive.setExternalNameGuard((ownerId, parentPath, name) => f.mounts.assertNameFree(ownerId, 'other', parentPath, name));
    const item = f.create('本地', '入口');
    const rollback = () => { f.mounts.reloadPersistence(); targetDrive.reloadPersistence(); };
    assert.throws(() => f.repository.atomic(() => {
        f.mounts.moveAcrossPartition(item.id, 'guest', '', 'other', '目标', targetDrive);
        throw new Error('rollback');
    }, rollback), /rollback/);
    assert.ok(f.mounts.find(item.id, 'guest', ''));
    assert.equal(f.mounts.find(item.id, 'guest', 'other'), null);
    f.repository.atomic(() => f.mounts.moveAcrossPartition(item.id, 'guest', '', 'other', '目标', targetDrive), rollback);
    assert.equal(f.mounts.find(item.id, 'guest', ''), null);
    assert.equal(f.mounts.find(item.id, 'guest', 'other').parentPath, '目标');
    assert.throws(() => targetDrive.createDirectory('guest', '目标/入口', 20), /MOUNT_NAME_CONFLICT/);
    assert.ok(f.drive.getDirectory('owner', '远端'));
});

test('SQLite 约束直接阻止绕过 API 的原生文件或目录与 Mount 重名', t => {
    const f = fixture(t);
    f.create('本地', '入口');
    const db = new DatabaseSync(path.join(f.dir, 'disk.sqlite'));
    try {
        assert.throws(() => db.prepare('INSERT INTO disk_files(scope,id,owner_id,folder_path,name,payload) VALUES (?,?,?,?,?,?)')
            .run('', 'bypass-file', 'guest', '本地', '入口', JSON.stringify({ id:'bypass-file', ownerId:'guest', folderPath:'本地', name:'入口' })), /MOUNT_NAME_CONFLICT/);
        assert.throws(() => db.prepare('INSERT INTO disk_directories(scope,id,owner_id,folder_path,name,payload) VALUES (?,?,?,?,?,?)')
            .run('', 'bypass-folder', 'guest', '本地/入口', '', JSON.stringify({ ownerId:'guest', path:'本地/入口' })), /MOUNT_NAME_CONFLICT/);
    } finally { db.close(); }
});

test('删除 S3 目录 marker 不会修剪包含 Mount 的原生父目录', t => {
    const f = fixture(t);
    f.drive.setFolderMarker('guest', 'S3根/深层', {}, 20);
    const mount = f.create('S3根/深层', '入口');
    f.drive.clearFolderMarker('guest', 'S3根/深层');
    assert.ok(f.drive.getDirectory('guest', 'S3根/深层'));
    assert.ok(f.drive.getDirectory('guest', 'S3根'));
    assert.equal(f.mounts.find(mount.id, 'guest', '').parentPath, 'S3根/深层');
    f.mounts.remove(mount.id, 'guest', '');
    f.drive.setFolderMarker('guest', 'S3根/深层', {}, 20);
    f.drive.clearFolderMarker('guest', 'S3根/深层');
    assert.equal(f.drive.getDirectory('guest', 'S3根/深层'), null);
    assert.equal(f.drive.getDirectory('guest', 'S3根'), null);
});

test('附加 Mount 搜索只返回授权根内可见内容，同一 Grant 多挂载不重复结果', t => {
    const f = fixture(t);
    f.drive.createDirectory('owner', '远端/关键词目录', 20);
    f.drive.createDirectory('owner', '私有/关键词秘密', 20);
    const firstMount = f.create('本地', '入口一');
    f.create('本地/子目录', '入口二');
    const search = () => f.mounts.searchMounted('guest', '', '关键词', () => f.drive);
    assert.deepEqual(search().results.map(item => item.path), ['远端/关键词目录']);
    assert.deepEqual(search().results.map(item => ({ origin:item.origin, mountId:item.mountId,
        collaborationId:item.collaborationId, mountName:item.mountName, relativePath:item.relativePath })),
    [{ origin:'collaboration', mountId:firstMount.id, collaborationId:f.collaboration.id,
        mountName:'入口一', relativePath:'关键词目录' }]);
    assert.equal(search().searchedGrants, 1);
    assert.deepEqual(f.mounts.searchMounted('guest', '', '', () => f.drive).results, []);
    f.collaborations.setRole(f.collaboration.id, 'guest', 'viewer', 'owner', '');
    assert.equal(search().results.length, 1, 'viewer 仍可搜索授权内容');
    f.collaborations.kick(f.collaboration.id, 'guest', 'owner', '');
    assert.deepEqual(search().results, []);
});

test('附加 Mount 搜索达到结果上限时标记截断且始终限定协同根', t => {
    const f = fixture(t);
    f.create('本地', '入口');
    const found = f.mounts.searchMounted('guest', '', '关键词', grant => ({
        search(ownerId, query, limit, root) {
            assert.equal(grant.id, f.collaboration.id);
            assert.equal(ownerId, 'owner');
            assert.equal(query, '关键词');
            assert.equal(limit, 201);
            assert.equal(root, '远端');
            return { folders: Array.from({ length: 201 }, (_, index) => ({
                path: `远端/关键词${index}`, name: `关键词${index}`, reviewStatus: 'active'
            })), files: [] };
        }
    }));
    assert.equal(found.results.length, 200);
    assert.equal(found.truncated, true);
    assert.ok(found.results.every(item => item.origin === 'collaboration' && item.path.startsWith('远端/')));
});
