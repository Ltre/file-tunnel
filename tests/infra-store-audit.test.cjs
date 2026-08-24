const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');
const { createInfraStore } = require('../server/infra-store');

async function run() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-tunnel-infra-audit-'));
    try {
        const store = await createInfraStore({ dataDir });
        const sessionId = '11111111-1111-4111-8111-111111111111';
        const deviceId = '22222222-2222-4222-8222-222222222222';
        const firstSeen = 1_700_000_000_000;

        assert.deepStrictEqual(
            store.recordTunnelMember(sessionId, { deviceId, deviceName: '浏览器 A' }, firstSeen),
            { inserted: true }
        );
        assert.deepStrictEqual(
            store.recordTunnelMember(sessionId, { deviceId, deviceType: 'browser' }, firstSeen + 1),
            { inserted: false }
        );
        store.recordTunnelMember(sessionId, {
            deviceId: '77777777-7777-4777-8777-777777777777',
            deviceName: '缓存节点',
            deviceType: 'vclient'
        }, firstSeen + 1);
        store.upsertDevice({ deviceId, sessionId, online: true, active: true, lastAccess: firstSeen + 2 });

        const firstMessage = {
            id: '33333333-3333-4333-8333-333333333333',
            type: 'file',
            sender: deviceId,
            timestamp: firstSeen + 3,
            fileInfo: { id: 'asset-one', name: 'one.bin', type: 'application/octet-stream', size: 10 }
        };
        const secondMessage = {
            id: '44444444-4444-4444-8444-444444444444',
            type: 'collection',
            sender: deviceId,
            timestamp: firstSeen + 4,
            collection: {
                files: [
                    { id: 'asset-one', name: 'one.bin', type: 'application/octet-stream', size: 10 },
                    { id: 'asset-two', name: 'two.bin', type: 'application/octet-stream', size: 20 }
                ]
            }
        };

        assert.strictEqual(store.recordHistoryMessage(sessionId, firstMessage).inserted, true);
        assert.strictEqual(store.recordHistoryMessage(sessionId, firstMessage).inserted, false, 'replay must be idempotent');
        assert.strictEqual(store.recordHistoryMessage(sessionId, secondMessage).fileCount, 2);
        const richMessage = {
            id: '66666666-6666-4666-8666-666666666666',
            type: 'rich',
            sender: deviceId,
            timestamp: firstSeen + 5,
            content: '<img data-tunnel-asset-id="editor-asset" alt="editor image">'
        };
        store.recordHistoryMessage(sessionId, richMessage, {
            fileAssets: new Map([['editor-asset', {
                metadata: { id: 'editor-asset', name: 'editor.png', type: 'image/png', size: 5 }
            }]])
        });

        let stats = store.listTunnelsWithStats()[0];
        assert.strictEqual(stats.active_device_count, 1);
        assert.strictEqual(stats.historical_device_count, 2);
        assert.strictEqual(stats.historical_real_device_count, 1);
        assert.strictEqual(stats.historical_vclient_device_count, 1);
        assert.strictEqual(stats.transfer_record_count, 3);
        assert.strictEqual(stats.transfer_file_count, 4, 'file references are counted once per record');
        assert.strictEqual(stats.unique_file_count, 3);
        assert.strictEqual(stats.total_file_size, 35, 'bytes are counted once per tunnel/file id');

        secondMessage.collection.files = [secondMessage.collection.files[0]];
        store.recordHistoryMessage(sessionId, secondMessage, { now: firstSeen + 5 });
        const removedReference = store.get(`
            SELECT removed_at FROM transfer_files
            WHERE session_id = ? AND message_id = ? AND file_id = ?
        `, [sessionId, secondMessage.id, 'asset-two']);
        assert.ok(removedReference.removed_at, 'an edited-away file reference remains as an audit tombstone');

        const page = store.listTransferRecords(sessionId, { limit: 1 });
        assert.strictEqual(page.total, 3);
        assert.strictEqual(page.items.length, 1);
        assert.ok(page.items[0].message);
        assert.strictEqual(page.items[0].files[0].name, 'editor.png');

        const directAsset = {
            id: 'direct-only-asset',
            name: 'direct.bin',
            type: 'application/octet-stream',
            size: 7
        };
        store.recordAssetTransferEvent(sessionId, 'announced', directAsset, {
            sourceDeviceId: deviceId,
            now: firstSeen + 10,
            transport: 'provider-announcement'
        });
        store.recordAssetTransferEvent(sessionId, 'requested', directAsset, {
            sourceDeviceId: deviceId,
            targetDeviceId: '88888888-8888-4888-8888-888888888888',
            now: firstSeen + 11,
            transport: 'negotiated-client-path'
        });
        store.recordAssetTransferEvent(sessionId, 'relay-completed', directAsset, {
            sourceDeviceId: deviceId,
            targetDeviceId: '88888888-8888-4888-8888-888888888888',
            bytesTransferred: 7,
            now: firstSeen + 12,
            transport: 'socket.io-relay'
        });
        const directStats = store.listTunnelsWithStats()[0];
        assert.strictEqual(directStats.transfer_record_count, 4, 'direct-only assets are visible as synthetic audit records');
        assert.strictEqual(directStats.transfer_file_count, 5);
        assert.strictEqual(directStats.unique_file_count, 4);
        assert.strictEqual(directStats.total_file_size, 42);
        const directPage = store.listTransferRecords(sessionId, { limit: 1 });
        assert.strictEqual(directPage.total, 4);
        assert.strictEqual(directPage.items[0].source, 'direct-file-asset');
        assert.strictEqual(directPage.items[0].files[0].name, 'direct.bin');
        const transferEvents = store.listAssetTransferEvents(sessionId);
        assert.strictEqual(transferEvents.length, 3);
        assert.strictEqual(transferEvents[0].event_type, 'relay-completed');
        assert.strictEqual(transferEvents[0].bytes_transferred, 7);
        store.recordFileAsset(sessionId, { ...directAsset, name: 'later-name.bin' }, { now: firstSeen + 13 });
        assert.strictEqual(
            store.listAssetTransferEvents(sessionId)[0].details.asset.name,
            'direct.bin',
            'append-only transfer evidence keeps its original metadata snapshot'
        );

        assert.strictEqual(store.markHistoryDeleted(sessionId, firstMessage.id, firstSeen + 6), true);
        assert.strictEqual(store.markHistoryDeleted(sessionId, 'never-existed', firstSeen + 6), false);
        assert.deepStrictEqual(store.listDeletedHistoryIds(sessionId), [firstMessage.id]);
        assert.strictEqual(store.listHistoryRecords(sessionId).length, 2);
        assert.strictEqual(store.listHistoryRecords(sessionId, { includeDeleted: true }).length, 3);

        let tunnelState = store.setVClientDesired(sessionId, true, firstSeen + 7);
        assert.strictEqual(tunnelState.desired_enabled, true);
        assert.strictEqual(tunnelState.state, 'starting');
        tunnelState = store.updateVClientStatus(sessionId, 'active', {
            instanceId: 'vclient-1',
            deviceId: '55555555-5555-4555-8555-555555555555',
            heartbeatAt: firstSeen + 8,
            statusDetail: { cached: 1 },
            cachedFiles: 1,
            cachedBytes: 10,
            lastSyncAt: firstSeen + 8
        });
        assert.strictEqual(tunnelState.state, 'active');
        assert.deepStrictEqual(tunnelState.details, { cached: 1 });
        assert.strictEqual(tunnelState.cached_files, 1);
        assert.strictEqual(tunnelState.cached_bytes, 10);

        const assetState = store.upsertVClientAssetState(sessionId, 'asset-one', 'cached', {
            bytesCached: 10,
            bytesTotal: 10,
            cachePath: 'cache/asset-one'
        });
        assert.strictEqual(assetState.state, 'cached');
        assert.strictEqual(assetState.bytes_cached, 10);
        assert.strictEqual(store.listVClientAssetStates(sessionId).length, 1);

        // Reopening the old file exercises additive migration and verifies durable,
        // idempotent audit data. Runtime-only device presence intentionally resets.
        const reopened = await createInfraStore({ dataDir });
        stats = reopened.listTunnelsWithStats()[0];
        assert.strictEqual(stats.active_device_count, 0);
        assert.strictEqual(stats.transfer_record_count, 4);
        assert.strictEqual(stats.transfer_file_count, 5);
        assert.strictEqual(stats.total_file_size, 42);
        assert.strictEqual(reopened.getVClientTunnel(sessionId).state, 'active');
        assert.strictEqual(reopened.getFileAsset(sessionId, 'asset-two').file_size, 20);
        reopened.deleteTunnel(sessionId);
        assert.strictEqual(reopened.getTunnel(sessionId), null);
        assert.strictEqual(reopened.listTunnelsWithStats({ includeDeleted: true })[0].transfer_record_count, 4);
        assert.strictEqual(reopened.getVClientTunnel(sessionId).desired_enabled, false);
        reopened.recordFileAsset(sessionId, { id: 'late-asset', name: 'late.bin', size: 1 }, { now: firstSeen + 20 });
        reopened.recordTunnelMember(sessionId, { deviceId: 'late-device' }, firstSeen + 21);
        assert.strictEqual(reopened.getTunnel(sessionId), null, 'late audit callbacks must not resurrect a deleted tunnel');

        const legacyDir = path.join(dataDir, 'legacy');
        fs.mkdirSync(legacyDir);
        const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
        const SQL = await initSqlJs({ locateFile: file => file === 'sql-wasm.wasm' ? wasmPath : file });
        const legacyDb = new SQL.Database();
        legacyDb.run(`
            CREATE TABLE tunnels (
                session_id TEXT PRIMARY KEY,
                short_code TEXT UNIQUE,
                created_at INTEGER NOT NULL,
                last_activity INTEGER NOT NULL,
                deleted_at INTEGER
            );
            CREATE TABLE devices (
                device_id TEXT PRIMARY KEY,
                session_id TEXT,
                device_name TEXT,
                device_model TEXT,
                local_ip TEXT,
                external_ip TEXT,
                ip TEXT,
                socket_id TEXT,
                user_agent TEXT,
                first_seen INTEGER NOT NULL,
                last_access INTEGER NOT NULL,
                online INTEGER NOT NULL DEFAULT 0,
                active INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO tunnels VALUES ('legacy-session', 'legacy', 10, 20, NULL);
            INSERT INTO devices VALUES (
                'legacy-device', 'legacy-session', 'old browser', '', '', '', '', '', '',
                11, 19, 0, 0
            );
        `);
        fs.writeFileSync(path.join(legacyDir, 'infra.sqlite'), Buffer.from(legacyDb.export()));
        legacyDb.close();
        const migratedLegacy = await createInfraStore({ dataDir: legacyDir });
        assert.strictEqual(migratedLegacy.getTunnel('legacy-session').short_code, 'legacy');
        assert.strictEqual(migratedLegacy.listTunnelsWithStats()[0].historical_device_count, 1);
        assert.strictEqual(migratedLegacy.listVClientTunnels().length, 0);

        console.log('infra-store audit persistence tests passed');
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

run().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
