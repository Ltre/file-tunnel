'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createDiskOperations } = require('../server/disk-operations');

test('服务重启后有 uploadId 的上传先进入 recovering，恢复扫描后才决定失败', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-operations-recovery-'));
    t.after(() => fs.rmSync(dataDir, { recursive:true, force:true }));
    const scope = { userId:'u1', diskSpace:'music' };
    const first = createDiskOperations({ dataDir, now:() => 1000 });
    const created = first.create(scope, 'upload', '上传文件', 10);
    first.update(created.operation_id, { status:'running', uploadId:'upload-1', phase:'client-upload' }, true);
    first.flush();

    const restarted = createDiskOperations({ dataDir, now:() => 2000 });
    const recovering = restarted.get(created.operation_id, scope);
    assert.equal(recovering.status, 'queued');
    assert.equal(recovering.phase, 'recovering');
    assert.equal(recovering.errorCode, '');

    restarted.finalizeRestartRecovery([created.operation_id]);
    assert.equal(restarted.get(created.operation_id, scope).phase, 'recovering', '有 staging manifest 的任务应留给恢复扫描处理');

    restarted.finalizeRestartRecovery([]);
    const failed = restarted.get(created.operation_id, scope);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.phase, 'interrupted');
    assert.equal(failed.errorCode, 'SERVER_RESTARTED');
});

test('非上传任务仍在启动时直接标记 SERVER_RESTARTED', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-operations-read-restart-'));
    t.after(() => fs.rmSync(dataDir, { recursive:true, force:true }));
    const scope = { userId:'u1', diskSpace:'', deviceId:'d1' };
    const first = createDiskOperations({ dataDir, now:() => 1000 });
    const created = first.create(scope, 'read', '读取文件', 10);
    first.update(created.operation_id, { status:'running' }, true);
    const restarted = createDiskOperations({ dataDir, now:() => 2000 });
    const failed = restarted.get(created.operation_id, scope);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'SERVER_RESTARTED');
});
