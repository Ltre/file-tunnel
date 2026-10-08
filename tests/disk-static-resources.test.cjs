'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiskStaticResources } = require('../server/disk-static-resources');

test('静态链接绑定用户、分区和选中范围；跨进程撤销立即阻止新请求', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-static-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const scope = { userId: 'owner', diskSpace: 'photos' };
    const files = [
        { id: 'file-a', name: '封面.jpg', folderPath: '公开', ownerId: 'owner', size: 10, type: 'image/jpeg' },
        { id: 'file-b', name: '私密.jpg', folderPath: '私密', ownerId: 'owner', size: 10, type: 'image/jpeg' }
    ];
    const store = {
        get(_owner, id) { return files.find(file => file.id === id); },
        getDirectory(_owner, folder) { return folder === '公开' || folder === '私密' ? { path: folder } : null; },
        list(_owner, folder) { return { files: files.filter(file => file.folderPath === folder) }; }
    };
    const first = createDiskStaticResources({ dataDir }), second = createDiskStaticResources({ dataDir });
    const link = first.create(scope, store, { preset: 'day', items: [{ kind: 'directory', path: '公开' }] });
    assert.ok(link.expiresAt > Date.now());
    assert.equal(second.file(second.resolve(link.token), store, '公开/封面.jpg').id, 'file-a');
    assert.throws(() => second.file(second.resolve(link.token), store, '私密/私密.jpg'), /FILE_NOT_FOUND/);
    assert.deepEqual(first.list({ userId: 'other', diskSpace: 'photos' }), []);
    assert.deepEqual(first.list({ userId: 'owner', diskSpace: '' }), []);
    const permanent = second.create(scope, store, { preset: 'permanent', items: [{ kind: 'file', id: 'file-b' }] });
    assert.equal(permanent.expiresAt, 0);
    assert.equal(first.list(scope).length, 2, '多次写入不能使用过期 revision 覆盖已有链接');
    second.revoke(scope, link.id);
    assert.throws(() => first.resolve(link.token), /STATIC_NOT_FOUND/);
    assert.equal(first.file(first.resolve(permanent.token), store, '私密/私密.jpg').id, 'file-b');
});
test('目录默认缓存期限与独立子项设置分层生效；停用父目录保留子项', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-static-tree-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const scope = { userId: 'owner', diskSpace: '中文分区' };
    const files = [
        { id: 'parent-file', name: 'a.txt', folderPath: '公开' },
        { id: 'child-file', name: 'b.txt', folderPath: '公开/子目录' }
    ];
    const store = {
        get(_owner, id) { return files.find(file => file.id === id); },
        getDirectory(_owner, folder) { return ['公开', '公开/子目录'].includes(folder) ? { path: folder } : null; },
        list(_owner, folder) { return { files: files.filter(file => file.folderPath === folder) }; }
    };
    const staticResources = createDiskStaticResources({ dataDir });
    const parent = staticResources.configureTarget(scope, store, { item: { kind: 'directory', path: '公开' }, preset: 'month' });
    const child = staticResources.configureTarget(scope, store, { item: { kind: 'file', id: 'child-file' }, preset: 'week' });
    staticResources.updateCache(scope, parent.id, { path: '公开', preset: 'day' });
    assert.ok(staticResources.effectiveCacheSeconds(staticResources.resolve(parent.token), files[0]) >= 86399);
    assert.ok(staticResources.effectiveCacheSeconds(staticResources.resolve(parent.token), files[1]) > 6 * 86400);
    assert.equal(staticResources.protectFile(scope, files[1]), true);
    assert.equal(staticResources.protectDirectory(scope, store, '公开'), true);
    staticResources.stopTarget(scope, store, { kind: 'directory', path: '公开' });
    assert.throws(() => staticResources.resolve(parent.token), /STATIC_NOT_FOUND/);
    assert.equal(staticResources.resolve(child.token).id, child.id);
    assert.equal(staticResources.protectDirectory(scope, store, '公开'), true, '子项仍开放时不可移动其父路径');
});
