'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { createFixture } = require('./support/disk-content-admin-fixture.cjs');
const { createDiskMetadataTiming } = require('../server/disk-metadata-timing');

async function fixture(t) {
    const f = await createFixture(); t.after(() => f.close());
    const drive = f.api.spaces.get(''), root = 'backup/一/二/三';
    drive.createDirectory('bob', root, 30);
    for (let n = 0; n < 18; n++) drive.createDirectory('bob', root + '/目录' + n, 30);
    drive.createDirectory('bob', 'private/irrelevant', 30);
    const file = drive.get('bob', 'file-b');
    const extras = Array.from({ length: 49 }, (_, index) => ({ ...file, id: 'benchmark-' + index, name: '资料' + index, folderPath: 'private/irrelevant' }));
    f.repository.replace('files', [...f.repository.load('files'), ...extras], value => value.id); drive.reloadPersistence();
    const call = async (route, user = 'alice', body) => {
        const response = await fetch(f.base + '/api/telegram/drive' + route, { method: body ? 'POST' : 'GET',
            headers: { 'X-Test-User': user, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { response, data: await response.json() };
    };
    const grant = (await call('/collaborations/invitations', 'bob', { kind: 'directory', path: root })).data;
    await call('/collaborations/join', 'alice', { token: grant.url.split('/').at(-1) });
    const mount = (await call('/mounts', 'alice', { parentPath: '', name: '测试挂载', collaborationId: grant.collaboration.id })).data.mount;
    return { ...f, drive, root, grant: grant.collaboration, mount, call, route: '/mount-scope/' + mount.id + '/directories' };
}

test('小目录树不再按每层祖先遍历全部 Logical/Content；返回一致且提供阶段耗时', async t => {
    const f = await fixture(t);
    let projections = 0, snapshots = 0;
    const project = f.repository.projectFiles.bind(f.repository), get = f.drive.getDirectory.bind(f.drive);
    t.mock.method(f.repository, 'projectFiles', (...args) => { projections++; return project(...args); });
    t.mock.method(f.drive, 'getDirectory', (...args) => { snapshots++; return get(...args); });
    // Reproduce the former metadata check using the aggregate reader, then run
    // the current endpoint against the very same isolated database.
    const legacy = t.mock.method(f.drive, 'getDirectoryRecord', (...args) => f.drive.getDirectory(...args));
    let began = performance.now(); const old = await f.call(f.route); const oldMs = performance.now() - began;
    const oldProjections = projections; legacy.mock.restore(); projections = snapshots = 0;
    began = performance.now(); const next = await f.call(f.route); const nextMs = performance.now() - began;
    assert.equal(next.response.status, 200); assert.deepEqual(next.data, old.data); assert.equal(next.data.directories.length, 19);
    assert.ok(oldProjections > 90); assert.equal(projections, 0); assert.equal(snapshots, 0);
    assert.match(next.response.headers.get('server-timing'), /disk-mount-resolve;dur=\d/);
    assert.match(next.response.headers.get('server-timing'), /disk-directory-tree;dur=\d/);
    assert.ok(next.response.headers.get('x-disk-request-id'));
    assert.ok(next.data.directories.every(item => item.path === f.root || item.path.startsWith(f.root + '/')));
    const property = f.drive.getDirectory('bob', f.root); assert.equal(property.fileCount, 0); assert.equal(property.folderCount, 18);
    t.diagnostic(`isolated legacy=${oldMs.toFixed(1)}ms / current=${nextMs.toFixed(1)}ms; aggregate Content projections ${oldProjections} -> 0`);
});

test('轻量目录检查仍隔离用户、挂载及分区，并拒绝新近撤权或隐藏祖先', async t => {
    const f = await fixture(t);
    assert.equal(f.drive.getDirectoryRecord('alice', f.root), null); assert.equal(f.drive.getDirectoryRecord('bob', 'missing'), null);
    assert.equal((await f.call(f.route, 'bob')).response.status, 404);
    assert.equal((await f.call(f.route + '?disk_space=' + encodeURIComponent('相册&照片'))).response.status, 404);
    f.drive.setDirectoryReviewStatus('bob', 'backup/一', 'blocked');
    assert.notEqual((await f.call(f.route)).response.status, 200);
    f.drive.setDirectoryReviewStatus('bob', 'backup/一', 'active');
    assert.equal((await f.call(f.route)).response.status, 200);
    const kicked = await fetch(f.base + '/api/telegram/drive/collaborations/' + f.grant.id + '/members/alice', { method: 'DELETE', headers: { 'X-Test-User': 'bob' } });
    assert.equal(kicked.status, 200); assert.notEqual((await f.call(f.route)).response.status, 200);
    assert.equal(f.drive.getDirectory('bob', f.root).folderCount, 18);
});

test('分阶段计时累计重复阶段，异常也记耗时，不泄露路径、Cookie 或正文', () => {
    let time = 0; const logs = [], handlers = {}, headers = {};
    const timing = createDiskMetadataTiming((event, fields) => logs.push({ event, ...fields }), { slowMs: 0, now: () => time });
    const req = { path: '/mount-scope/test/directories', method: 'GET', headers: { cookie: 'sensitive-cookie' }, body: { path: 'secret-path' } };
    const res = { statusCode: 200, writableFinished: true, headersSent: false,
        json: value => value, set: (key, value) => { headers[key] = value; }, append: (key, value) => { headers[key] = value; }, once: (event, callback) => { handlers[event] = callback; } };
    timing(req, res, () => {});
    req.diskMetadataTiming.measure('disk-mount-resolve', () => { time += 20; });
    assert.throws(() => req.diskMetadataTiming.measure('disk-mount-resolve', () => { time += 30; throw Error('fault'); }));
    req.diskMetadataTiming.measure('disk-directory-tree', () => { time += 10; });
    res.json({ directories: [] }); handlers.finish(); handlers.close();
    assert.equal(headers['Server-Timing'], 'disk-metadata;dur=60.0, disk-mount-resolve;dur=50.0, disk-directory-tree;dur=10.0');
    assert.equal(logs.length, 1); assert.deepEqual(logs[0].phases, { 'disk-mount-resolve': 50, 'disk-directory-tree': 10 });
    assert.ok(!JSON.stringify(logs).includes('secret-path')); assert.ok(!JSON.stringify(logs).includes('sensitive-cookie'));
});
