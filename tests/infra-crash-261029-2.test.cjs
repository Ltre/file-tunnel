'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { DatabaseSync, backup } = require('node:sqlite');
const { createInfraStore } = require('../server/infra-store');

test('infra flush must not allocate a database-sized JavaScript snapshot or poison later heartbeat writes', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-crash-261029-'));
    const store = await createInfraStore({ dataDir });
    t.after(() => {
        clearTimeout(store.saveTimer); clearTimeout(store.saveRetryTimer);
        try { store.db.close(); } catch {}
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
    store.touchTunnel('tunnel-one', { shortCode: 'ABCDE' });
    const databaseBytes = fs.statSync(path.join(dataDir, 'infra.sqlite')).size;
    const OriginalUint8Array = global.Uint8Array;
    let attemptedSnapshots = 0;
    global.Uint8Array = new Proxy(OriginalUint8Array, {
        construct(Target, args) {
            if (args[0] === databaseBytes) {
                attemptedSnapshots++;
                throw new RangeError('Array buffer allocation failed');
            }
            return Reflect.construct(Target, args);
        }
    });
    let persisted;
    try { persisted = store.flush(); }
    finally { global.Uint8Array = OriginalUint8Array; }
    let heartbeatError;
    try { store.upsertDevice({ deviceId: 'browser-one', sessionId: 'tunnel-one', online: true }); }
    catch (error) { heartbeatError = error; }
    assert.deepEqual({ persisted, attemptedSnapshots, heartbeatError: heartbeatError?.message }, {
        persisted: true, attemptedSnapshots: 0, heartbeatError: undefined
    }, 'the allocation failure must not leave a closed database handle behind');
    assert.equal(store.flush(), true);
    assert.equal(store.getDevice('browser-one').online, 1);
});

async function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-recovery-261029-'));
    const stores = [];
    t.after(() => {
        for (const store of stores) store.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
    return { dataDir, open: async () => {
        const store = await createInfraStore({ dataDir });
        stores.push(store);
        return store;
    } };
}

for (const rollback of [false, true]) test(`failed commit preserves durable data and retries all pending records (SQLite rollback: ${rollback})`, async t => {
    const { dataDir, open } = await fixture(t);
    const store = await open();
    store.touchTunnel('durable', { shortCode: 'ABCDE' });
    assert.equal(store.flush(), true);
    store.recordHistoryMessage('durable', { id: 'pending-message', type: 'text', text: 'keep queued text' });
    const originalExec = store.db.exec.bind(store.db);
    const fault = new Error('injected transient commit I/O failure');
    let failed = false;
    store.db.exec = sql => {
        if (sql === 'COMMIT' && !failed) {
            failed = true;
            if (rollback) originalExec('ROLLBACK');
            throw fault;
        }
        return originalExec(sql);
    };
    const originalError = console.error;
    try { console.error = () => {}; assert.equal(store.flush(), false); }
    finally { console.error = originalError; }
    assert.equal(store.lastSaveError, fault);
    assert.equal(store.saveDirty, true);
    const persisted = new DatabaseSync(path.join(dataDir, 'infra.sqlite'), { readOnly: true });
    try {
        assert.equal(persisted.prepare('SELECT count(*) AS n FROM tunnels WHERE session_id=?').get('durable').n, 1);
        assert.equal(persisted.prepare('SELECT count(*) AS n FROM transfer_records').get().n, 0);
        assert.equal(persisted.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { persisted.close(); }
    store.upsertDevice({ deviceId: 'later-heartbeat', sessionId: 'durable', online: true });
    store.touchTunnel('later-audit', { shortCode: 'FGHIJ' });
    assert.equal(store.flush(), true);
    assert.equal(store.lastSaveError, null);
    assert.equal(store.pendingStatements.length, 0);
    const reopened = await open();
    assert.equal(reopened.listHistoryRecords('durable')[0].message.text, 'keep queued text');
    assert.ok(reopened.getDevice('later-heartbeat'));
    assert.ok(reopened.getTunnel('later-audit'));
});

test('a failed audit operation rolls back only its own savepoint and keeps previous batched work', async t => {
    const { open } = await fixture(t);
    const store = await open();
    store.touchTunnel('previous-good', { shortCode: 'ABCDE' });
    store.run('BEGIN');
    try {
        store.touchTunnelRow('do-not-save', { shortCode: 'FGHIJ' });
        store.touchTunnelRow('duplicate-code', { shortCode: 'ABCDE' });
        assert.fail('expected a uniqueness conflict');
    } catch (error) {
        assert.match(error.message, /UNIQUE constraint/);
        store.run('ROLLBACK');
    }
    assert.equal(store.flush(), true);
    const reopened = await open();
    assert.ok(reopened.getTunnel('previous-good'));
    assert.equal(reopened.getTunnel('do-not-save'), null);
});

test('an existing sql.js SQLite file preserves tables, indexes, rows and can be snapshotted without a full JS export', async t => {
    const { dataDir, open } = await fixture(t);
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    const legacy = new SQL.Database();
    legacy.run("CREATE TABLE business_evidence(id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE INDEX evidence_value ON business_evidence(value); INSERT INTO business_evidence VALUES ('preserve-me', '历史证据');");
    fs.writeFileSync(path.join(dataDir, 'infra.sqlite'), Buffer.from(legacy.export()));
    legacy.close();
    const store = await open();
    assert.deepEqual(store.get('SELECT * FROM business_evidence'), { id: 'preserve-me', value: '历史证据' });
    assert.ok(store.get("SELECT name FROM sqlite_schema WHERE name='evidence_value'"));
    store.touchTunnel('snapshot-tunnel', { shortCode: 'ABCDE' });
    assert.equal(store.flush(), true);
    const destination = path.join(dataDir, 'snapshot.sqlite');
    const source = new DatabaseSync(path.join(dataDir, 'infra.sqlite'), { readOnly: true });
    try { await backup(source, destination, { rate: 16 }); }
    finally { source.close(); }
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    try {
        assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.equal(snapshot.prepare('SELECT value FROM business_evidence').get().value, '历史证据');
        assert.equal(snapshot.prepare('SELECT short_code FROM tunnels').get().short_code, 'ABCDE');
    } finally { snapshot.close(); }
});

test('device-disconnect persistence failure is queued for audit retry without interrupting presence cleanup', () => {
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const start = source.indexOf('function touchAccessDevice(');
    const end = source.indexOf('function pruneAccessDevices(', start);
    const queued = [], accessDevices = new Map();
    let writes = 0, pruned = 0;
    const context = {
        accessDevices, Date, console: { error() {} },
        infraStore: { upsertDevice: record => { if (++writes === 1) throw Error('temporary I/O failure'); assert.equal(record.online, false); } },
        enqueueInfraAudit: (task, key) => queued.push({ task, key }),
        pruneAccessDevices: () => pruned++
    };
    vm.runInNewContext(source.slice(start, end), context);
    assert.doesNotThrow(() => context.markAccessDeviceOffline('browser-one', { deviceId: 'browser-one' }));
    assert.equal(pruned, 1);
    assert.equal(accessDevices.get('browser-one').online, false);
    assert.equal(queued.length, 1);
    queued[0].task();
    assert.equal(writes, 2);
});

test('a delayed failed presence write uses the newest device state after reconnect', () => {
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const start = source.indexOf('function touchAccessDevice(');
    const end = source.indexOf('function pruneAccessDevices(', start);
    const queued = [], saved = [], accessDevices = new Map();
    let failed = false;
    const context = {
        accessDevices, Date, console: { error() {} }, pruneAccessDevices() {},
        infraStore: { upsertDevice: record => {
            if (!failed) { failed = true; throw Error('temporary I/O failure'); }
            saved.push(record);
        } },
        enqueueInfraAudit: task => queued.push(task)
    };
    vm.runInNewContext(source.slice(start, end), context);
    context.markAccessDeviceOffline('browser-one', { deviceId: 'browser-one' });
    context.touchAccessDevice('browser-one', { deviceId: 'browser-one', online: true, socketId: 'new-socket' });
    queued[0]();
    assert.equal(saved.length, 2);
    assert.equal(saved.at(-1).online, true);
    assert.equal(saved.at(-1).socketId, 'new-socket');
});

test('an unreadable legacy database is rejected without replacing its previous bytes with an empty store', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-invalid-261029-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const filename = path.join(dataDir, 'infra.sqlite');
    const original = Buffer.from('invalid fixture database; preserve for recovery');
    fs.writeFileSync(filename, original);
    await assert.rejects(createInfraStore({ dataDir }), /not a database/);
    assert.deepEqual(fs.readFileSync(filename), original);
});
