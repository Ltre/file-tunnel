'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiskOperations } = require('../server/disk-operations');
const order = require('../client/disk-operation-order');

test('合并、追加更新后统一倒序，进度updatedAt不使陈旧任务插队', () => {
    const old = { operation_id: 'old', createdAt: 100, updatedAt: 10000 };
    const recent = { operation_id: 'recent', createdAt: 1000, finishedAt: 1200 };
    const completed = { operation_id: 'completed', createdAt: 50, finishedAt: 1300 };
    assert.deepEqual(order.sort([old, recent, completed]).map(job => job.operation_id), ['completed', 'recent', 'old']);
    const afterSSE = [recent, completed, { ...old, updatedAt: 20000 }];
    assert.deepEqual(order.sort(afterSSE).map(job => job.operation_id), ['completed', 'recent', 'old']);
    assert.equal(order.time({ createdAt: '2026-10-12T00:00:00Z' }), Date.parse('2026-10-12T00:00:00Z'));
    assert.deepEqual(order.sort([{ operation_id: 'z' }, { operation_id: 'a' }]).map(job => job.operation_id), ['a', 'z']);
});
test('持久化任务先排序后限量：最晚完成的早期任务保留在顶部，用户和分区隔离', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-order-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    let now = 1;
    const operations = createDiskOperations({ dataDir, now: () => now });
    const scope = { userId: 'one', diskSpace: 'a' };
    const earliest = operations.create(scope, 'transfer-history', 'earliest');
    for (let i = 0; i < 105; i++) { now += 10; const job = operations.create(scope, 'transfer-history', 'job'); operations.complete(job.operation_id, {}); }
    now += 10; operations.complete(earliest.operation_id, {});
    assert.equal(operations.list(scope)[0].operation_id, earliest.operation_id);
    assert.equal(operations.list(scope).length, 100);
    assert.equal(operations.list({ ...scope, userId: 'two' }).length, 0);
    assert.equal(operations.list({ ...scope, diskSpace: 'b' }).length, 0);
    assert.equal(createDiskOperations({ dataDir, now: () => now }).list(scope)[0].operation_id, earliest.operation_id);
});
