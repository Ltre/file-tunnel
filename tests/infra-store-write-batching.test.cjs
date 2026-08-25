'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createInfraStore } = require('../server/infra-store');

test('audit bursts are persisted by one explicit flush instead of one full database rewrite per record', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-tunnel-infra-batch-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    const store = await createInfraStore({ dataDir });
    const originalWriteDatabaseFile = store.writeDatabaseFile.bind(store);
    let physicalWriteCount = 0;
    store.writeDatabaseFile = bytes => {
        physicalWriteCount++;
        return originalWriteDatabaseFile(bytes);
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
    assert.equal(physicalWriteCount, 0, 'hot audit mutations must not export and rewrite the full database');
    assert.equal(store.flush(), true);
    assert.equal(physicalWriteCount, 1, 'one flush persists the whole queued burst');

    const reopened = await createInfraStore({ dataDir });
    assert.equal(reopened.listTunnelsWithStats()[0].transfer_record_count, 200);
    assert.equal(reopened.listHistoryRecords(sessionId, { limit: 500 }).length, 200);
});
