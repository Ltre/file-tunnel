'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiskCollaborationStore } = require('../server/disk-collaboration');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { openDiskRepository } = require('../server/disk-repository');

test('SQLite 重启后仍保留协同邀请、成员、路径和删除保护', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-collaboration-db-'));
    t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
    const store = createDiskCollaborationStore(dir);
    const { collaboration, invite } = store.enable({ ownerId:'owner', diskSpace:'', kind:'directory', path:'共同/资料', name:'资料' });
    store.join(invite.token, 'guest');
    store.relocateDirectory('owner', '', '共同', '归档');
    const reopened = createDiskCollaborationStore(dir);
    assert.equal(reopened.authorized(collaboration.id, 'guest').path, '归档/资料');
    assert.equal(reopened.protectDirectory('owner', '', '归档'), true);
    assert.equal(reopened.byInvite(invite.token), null, '加入后一次性邀请必须失效');
    reopened.kick(collaboration.id, 'guest', 'owner', '');
    const afterKick = createDiskCollaborationStore(dir);
    assert.equal(afterKick.authorized(collaboration.id, 'guest'), null);
    afterKick.disable(collaboration.id, 'owner', '');
    const afterStop = createDiskCollaborationStore(dir);
    assert.equal(afterStop.protectDirectory('owner', '', '归档'), false);
});

test('并存的协同存储实例不能抹掉新邀请或重复消费一次性链接', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-collaboration-writers-'));
    t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
    const first = createDiskCollaborationStore(dir);
    const second = createDiskCollaborationStore(dir);
    first.enable({ ownerId:'alice', kind:'directory', path:'A', name:'A' });
    second.enable({ ownerId:'bob', kind:'directory', path:'B', name:'B' });
    const reopened = createDiskCollaborationStore(dir);
    assert.equal(reopened.forOwner('alice', '').length, 1);
    assert.equal(reopened.forOwner('bob', '').length, 1);
    const { invite } = reopened.enable({ ownerId:'alice', kind:'directory', path:'A', name:'A' });
    const stale = createDiskCollaborationStore(dir);
    reopened.join(invite.token, 'guest-1');
    assert.throws(() => stale.join(invite.token, 'guest-2'), /DISK_WRITE_CONFLICT/);
    assert.equal(stale.authorized(stale.forOwner('alice', '')[0].id, 'guest-2'), null);
    assert.equal(createDiskCollaborationStore(dir).byInvite(invite.token), null);
});

test('目录移动与协同授权路径同事务提交，失败后一同回滚', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-collaboration-atomic-'));
    t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
    const drive = createTelegramDriveStore({ dataDir:dir });
    const collaborations = createDiskCollaborationStore(dir);
    const repository = openDiskRepository(dir);
    drive.createDirectory('owner', '原目录', 20);
    drive.createDirectory('owner', '目的地', 20);
    const { collaboration } = collaborations.enable({ ownerId:'owner', kind:'directory', path:'原目录', name:'原目录' });
    const rollback = () => { drive.reloadPersistence(); collaborations.reloadPersistence(); };
    assert.throws(() => repository.atomic(() => {
        drive.moveDirectory('owner', '原目录', '目的地', 20);
        collaborations.relocateDirectory('owner', '', '原目录', '目的地/原目录');
        throw new Error('模拟事务提交前失败');
    }, rollback), /模拟事务提交前失败/);
    assert.ok(drive.getDirectory('owner', '原目录'));
    assert.equal(drive.getDirectory('owner', '目的地/原目录'), null);
    assert.equal(collaborations.authorized(collaboration.id, 'owner').path, '原目录');
    repository.atomic(() => {
        drive.moveDirectory('owner', '原目录', '目的地', 20);
        collaborations.relocateDirectory('owner', '', '原目录', '目的地/原目录');
    }, rollback);
    const reopenedDrive = createTelegramDriveStore({ dataDir:dir });
    const reopenedCollaboration = createDiskCollaborationStore(dir);
    assert.ok(reopenedDrive.getDirectory('owner', '目的地/原目录'));
    assert.equal(reopenedCollaboration.authorized(collaboration.id, 'owner').path, '目的地/原目录');
});
