'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createInfraStore } = require('../server/infra-store');

test('audit bursts commit once at flush without exporting or rewriting the entire database', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-tunnel-infra-batch-'));
    const stores = [];
    t.after(() => { for (const store of stores) store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

    const store = await createInfraStore({ dataDir });
    stores.push(store);
    const originalExec = store.db.exec.bind(store.db);
    let commitCount = 0;
    store.db.exec = sql => {
        if (sql === 'COMMIT') commitCount++;
        return originalExec(sql);
    };

    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    for (let index = 0; index < 200; index++) {
        const result = store.recordHistoryMessage(sessionId, {
            id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`,
            type: 'text',
            sender: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            timestamp: 1_800_000_000_000 + index,
            text: `audit-record-${index}`
        });
        assert.equal(result.inserted, true);
    }

    assert.equal(store.listTunnelsWithStats()[0].transfer_record_count, 200);
    assert.equal(commitCount, 0, 'hot audit mutations must not commit separately for every record');
    assert.equal(store.flush(), true);
    assert.equal(commitCount, 1, 'one flush commits the whole queued burst');

    const reopened = await createInfraStore({ dataDir });
    stores.push(reopened);
    assert.equal(reopened.listTunnelsWithStats()[0].transfer_record_count, 200);
    assert.equal(reopened.listHistoryRecords(sessionId, { limit: 500 }).length, 200);
});
