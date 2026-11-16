'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
    const logs = [], stored = [], received = [];
    const context = {
        window: {}, ArrayBuffer, Uint8Array, Blob, setTimeout, clearTimeout,
        setInterval: () => 0, console: { info() {} }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/file-assets.js'), 'utf8'), context);
    const transfer = new context.window.FileAssetTransfer({
        log: (event, details) => logs.push({ event, details }),
        getSocket: () => null,
        getSessionId: () => 'fixture',
        store: async asset => { stored.push(asset); },
        onProgress() {},
        onReceived: async asset => { received.push(asset); }
    });
    const asset = { id: 'file', name: 'fixture.bin', size: 1 };
    return { transfer, asset, logs, stored, received };
}

function activeTransfer(transfer, asset, ranged) {
    const data = new Uint8Array([42]).buffer;
    if (!ranged) {
        const active = { from: 'current-provider', attemptId: 'current-attempt', asset, receivedSize: 1, chunks: [data], pendingChunks: Promise.resolve() };
        transfer.transfers.set(asset.id, active);
        return active;
    }
    const range = { transferId: 'part', from: 'current-provider', attemptId: 'current-attempt', active: true, completed: false, rangeStart: 0, rangeEnd: 1, receivedSize: 1, pendingChunks: Promise.resolve() };
    const active = { asset, ranges: new Map([['part', range]]), activeRangeIds: new Set(['part']), completedBytes: 0, buffer: new Uint8Array(data) };
    transfer.multiSourceTransfers.set(asset.id, active);
    return active;
}

for (const ranged of [false, true]) {
    const mode = ranged ? 'range' : 'full file';
    for (const staleProvider of [true, false]) {
        test(`relay completion for a ${mode} from an obsolete ${staleProvider ? 'provider' : 'attempt'} cannot acknowledge success`, async () => {
            const { transfer, asset, logs, stored, received } = harness();
            const active = activeTransfer(transfer, asset, ranged);
            const result = await transfer.handleRelayComplete({
                assetId: asset.id,
                from: staleProvider ? 'old-provider' : 'current-provider',
                attemptId: 'old-attempt',
                ...(ranged ? { transferId: 'part' } : {})
            });
            assert.equal(result.ok, false);
            assert.equal(result.reason, 'stale-transfer');
            assert.equal((ranged ? transfer.multiSourceTransfers : transfer.transfers).get(asset.id), active);
            assert.equal(stored.length, 0);
            assert.equal(received.length, 0);
            assert.equal(logs.some(row => row.event === 'file-asset-route-receiver-relay-complete'), false);
        });
    }

    test(`a valid ${mode} relay completion still stores the content and acknowledges success`, async () => {
        const { transfer, asset, logs, stored, received } = harness();
        activeTransfer(transfer, asset, ranged);
        const result = await transfer.handleRelayComplete({ assetId: asset.id, from: 'current-provider', attemptId: 'current-attempt', ...(ranged ? { transferId: 'part' } : {}) });
        assert.equal(result.ok, true);
        assert.equal(stored.length, 1);
        assert.deepEqual([...new Uint8Array(stored[0].data)], [42]);
        assert.equal(received.length, 1);
        assert.equal(logs.some(row => row.event === 'file-asset-route-receiver-relay-complete'), true);
    });
}
