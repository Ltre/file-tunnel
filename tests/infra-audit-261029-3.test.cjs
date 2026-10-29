'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createInfraStore } = require('../server/infra-store');
const { spawnSync } = require('node:child_process');

test('an automatic SQLite rollback during an operation cannot strand its savepoint depth after storage recovers', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-audit-261029-3-'));
    const store = await createInfraStore({ dataDir });
    t.after(() => {
        clearTimeout(store.saveTimer); clearTimeout(store.saveRetryTimer);
        try { store.db.close(); } catch {}
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
    store.touchTunnel('previous-batch', { shortCode: 'GOOD1' });
    const execute = store.execute.bind(store);
    const storageError = new Error('injected SQLite I/O failure');
    let unavailable = false;
    store.execute = (sql, params) => {
        if (/INSERT INTO transfer_records/.test(sql)) {
            store.db.exec('ROLLBACK');
            unavailable = true;
        }
        if (unavailable) throw storageError;
        return execute(sql, params);
    };
    assert.throws(() => store.recordHistoryMessage('failed-operation', {
        id: 'not-completed', type: 'text', text: 'must not be replayed'
    }), error => error === storageError);
    unavailable = false;
    store.execute = execute;
    store.upsertDevice({ deviceId: 'recovered-heartbeat', sessionId: 'previous-batch', online: true });
    const originalError = console.error;
    let flushed;
    try { console.error = () => {}; flushed = store.flush(); }
    finally { console.error = originalError; }
    assert.equal(flushed, true, 'a failed rollback cleanup must not poison every subsequent save');
    assert.equal(store.operationDepth, 0);
    assert.ok(store.getTunnel('previous-batch'), 'unrelated queued data survives the automatic rollback');
    assert.equal(store.getTunnel('failed-operation'), null, 'the failed operation must be discarded');
    assert.equal(store.getDevice('recovered-heartbeat').online, 1);
    assert.deepEqual(store.query('PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
    const persisted = new (require('node:sqlite').DatabaseSync)(path.join(dataDir, 'infra.sqlite'), { readOnly: true });
    try {
        assert.equal(persisted.prepare('SELECT count(*) AS n FROM tunnels WHERE session_id=?').get('previous-batch').n, 1);
        assert.equal(persisted.prepare('SELECT count(*) AS n FROM tunnels WHERE session_id=?').get('failed-operation').n, 0);
        assert.equal(persisted.prepare('SELECT online FROM devices').get().online, 1);
    } finally { persisted.close(); }
});

test('real SQLite RAISE(ROLLBACK) cancels only the failed audit operation when its queued batch is restored', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-native-rollback-261029-3-'));
    const store = await createInfraStore({ dataDir });
    t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    store.db.exec(`CREATE TRIGGER reject_fixture BEFORE INSERT ON transfer_records
        WHEN NEW.message_id = 'rejected-record' BEGIN SELECT RAISE(ROLLBACK, 'fixture rollback'); END`);
    store.touchTunnel('keep-batched', { shortCode: 'KEEP1' });
    assert.throws(() => store.recordHistoryMessage('discard-this-operation', {
        id: 'rejected-record', type: 'text', text: 'never publish'
    }), /fixture rollback/);
    assert.equal(store.operationDepth, 0);
    store.recordHistoryMessage('keep-batched', { id: 'after-recovery', type: 'text', text: 'saved' });
    assert.equal(store.flush(), true);
    assert.equal(store.getTunnel('discard-this-operation'), null);
    assert.equal(store.listHistoryRecords('keep-batched')[0].message.text, 'saved');
});

test('abrupt process exit preserves committed WAL data and does not publish an unfinished audit batch', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-exit-recovery-261029-3-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const program = `
        const { createInfraStore } = require(process.argv[1]);
        (async () => {
            const store = await createInfraStore({ dataDir: process.argv[2] });
            store.recordHistoryMessage('recovery', { id: 'committed', type: 'text', text: 'durable' });
            if (!store.flush()) throw store.lastSaveError;
            store.recordHistoryMessage('recovery', { id: 'unfinished', type: 'text', text: 'not committed' });
            process.exit(23);
        })().catch(error => { console.error(error); process.exit(1); });
    `;
    const child = spawnSync(process.execPath, ['-e', program, require.resolve('../server/infra-store'), dataDir], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 23, child.stderr);
    const store = await createInfraStore({ dataDir });
    try {
        assert.deepEqual(store.listHistoryRecords('recovery').map(record => record.message.id), ['committed']);
        assert.equal(store.get('PRAGMA integrity_check').integrity_check, 'ok');
        store.upsertDevice({ deviceId: 'next-process', sessionId: 'recovery', online: true });
        assert.equal(store.flush(), true);
        assert.equal(store.getDevice('next-process').online, 1);
    } finally { store.close(); }
});

const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const diagnostics = serverSource.slice(serverSource.indexOf('// Observe exits without replacing'), serverSource.indexOf('startServer().catch'));

for (const [name, action, code, expected] of [
    ['normal empty event loop', '', 0, /code=0 signal=none/],
    ['explicit nonzero exit', 'process.exit(7);', 7, /code=7 signal=none/],
    ['uncaught exception', "throw Error('fixture-fatal');", 1, /origin=uncaughtException/],
    ['unhandled rejection', "Promise.reject(Error('fixture-rejection'));", 1, /origin=unhandledRejection/]
]) test(`process exit diagnostics retain Node's default termination behavior: ${name}`, () => {
    assert.ok(diagnostics.includes("process.on('exit'"));
    const child = spawnSync(process.execPath, ['-e', diagnostics + '\n' + action], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, code);
    assert.match(child.stderr, /\[server-exit\] pid=\d+/);
    assert.match(child.stderr, expected);
});

test('a requested shutdown is logged before asynchronous cleanup and retains its signal in the exit record', () => {
    const shutdown = serverSource.slice(serverSource.indexOf('let shutdownStarted = false;'));
    const stubs = `
        const telegramForwardJobs = { close() {} }, streamingConsole = { close() {} };
        const systemBackup = { close: async () => {} }, mediaLibrary = { close: async () => {} };
        const diskAPI = { close() {} }, diskOperations = { flush() {} }, webServer = { listening: false };
        function flushInfraAuditQueue() {}
    `;
    const child = spawnSync(process.execPath, ['-e', diagnostics + stubs + shutdown + "\nprocess.emit('SIGINT');"], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
    assert.match(child.stdout, /\[server-shutdown\] pid=\d+ signal=SIGINT/);
    assert.match(child.stderr, /code=0 signal=SIGINT/);
});
