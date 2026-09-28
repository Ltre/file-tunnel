'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { collect, parseArgs, redact, main } = require('../tools/collect-tgdisk-diagnostics.cjs');

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-diagnostics-'));
    const disposers = [];
    t.after(() => {
        for (const dispose of disposers.reverse()) dispose();
        const relative = path.relative(os.tmpdir(), dataDir);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
    const now = Date.now(), options = parseArgs(['--data-dir', dataDir], now);
    const entry = (event, offset, fields = {}) => ({ time: new Date(now + offset).toISOString(), event, ...fields });
    const write = (name, rows) => fs.writeFileSync(path.join(dataDir, name), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    return { dataDir, now, options, entry, write, dispose: handler => disposers.push(handler) };
}

test('collector merges rotated logs chronologically, deduplicates and limits its temporary time window', async t => {
    const { dataDir, now, options, entry, write } = fixture(t);
    const duplicated = entry('telegram.request', -500, { uploadId: 'upload-1', operationId: 'op-1' });
    write('disk-upload.log.1', [entry('upload.created', -3 * 60 * 60 * 1000), duplicated]);
    write('disk-upload.log', [entry('telegram.response', -100, { operationId: 'op-1', status: 400 }), duplicated, entry('future', 1000)]);
    fs.appendFileSync(path.join(dataDir, 'disk-upload.log'), '{"unfinished":');
    fs.writeFileSync(path.join(dataDir, 'disk-operations.json'), JSON.stringify([
        { type: 'upload', operation_id: 'op-1', status: 'failed', updatedAt: now - 100, uploadId: 'upload-1', result: { token: 'private-value' } },
        { type: 'upload', operation_id: 'old', updatedAt: now - 3 * 60 * 60 * 1000 },
        { type: 'read', operation_id: 'read', updatedAt: now - 100 }
    ]));
    const before = fs.readFileSync(path.join(dataDir, 'disk-upload.log'));
    const bundle = await collect(options);
    assert.deepEqual(bundle.logs.map(row => row.event), ['telegram.request', 'telegram.response']);
    assert.equal(bundle.logs[0].time, duplicated.time, 'timestamp colons must not be mistaken for Bot tokens');
    assert.equal(bundle.operations.length, 2); assert.equal(bundle.operations[0].operation_id, 'op-1');
    assert.equal(bundle.operations[0].result, undefined);
    assert.ok(bundle.warnings.some(message => /不完整/.test(message)));
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'disk-upload.log')), before);
    assert.equal(fs.existsSync(path.join(dataDir, 'disk.sqlite')), false, 'a JSON-only deployment must not initialize SQLite');
});

test('task filters collect retained old requests and infer operation IDs from upload IDs', async t => {
    const { dataDir, now, entry, write } = fixture(t);
    write('disk-upload.log', [entry('upload.created', -4 * 60 * 60 * 1000, { uploadId: 'u1' }),
        entry('telegram.network-error', -100, { operationId: 'o1' }), entry('unrelated', -100, { uploadId: 'u2' })]);
    fs.writeFileSync(path.join(dataDir, 'disk-operations.json'), JSON.stringify([{ type: 'upload', uploadId: 'u1', operation_id: 'o1', updatedAt: now - 100 }]));
    const byUpload = await collect(parseArgs(['--data-dir', dataDir, '--upload-id', 'u1'], now));
    assert.equal(byUpload.window.since, null); assert.equal(byUpload.logs.length, 2);
    const byOperation = await collect(parseArgs(['--data-dir', dataDir, '--operation-id', 'o1'], now));
    assert.equal(byOperation.logs.length, 2);
    const recent = await collect(parseArgs(['--data-dir', dataDir, '--upload-id', 'u1', '--minutes', '5'], now));
    assert.deepEqual(recent.logs.map(row => row.event), ['telegram.network-error']);
});

test('目录任务与排队、执行耗时可用同一渠道导出，结果正文不导出', async t => {
    const { dataDir, now, entry, write } = fixture(t);
    write('disk-upload.log', [entry('metadata.mutation-queued', -3000, { operationId: 'mkdir-1', queuedBehindMutation: true }),
        entry('metadata.mutation-end', -100, { operationId: 'mkdir-1', queuedMs: 2800, workMs: 12 })]);
    fs.writeFileSync(path.join(dataDir, 'disk-operations.json'), JSON.stringify([{ type: 'mkdir', operation_id: 'mkdir-1',
        folderPath: 'empty', status: 'completed', updatedAt: now - 100, result: { secret: 'private' } }]));
    const bundle = await collect(parseArgs(['--data-dir', dataDir, '--operation-id', 'mkdir-1'], now));
    assert.equal(bundle.operations.length, 1); assert.equal(bundle.operations[0].type, 'mkdir');
    assert.equal(bundle.logs[1].queuedMs, 2800); assert.equal(bundle.operations[0].result, undefined);
});

test('SQLite collection sees committed WAL records using a read-only connection without rewriting data', async t => {
    const { dataDir, now, options, entry, write, dispose } = fixture(t);
    const db = new DatabaseSync(path.join(dataDir, 'disk.sqlite'));
    dispose(() => db.close());
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE disk_operations(payload TEXT)');
    db.prepare('INSERT INTO disk_operations(payload) VALUES (?)').run(JSON.stringify({ type: 'upload', uploadId: 'u1', operation_id: 'o1', updatedAt: now - 100, errorCode: 'TELEGRAM_NETWORK_ERROR' }));
    write('disk-upload.log', [entry('telegram.network-error', -100, { operationId: 'o1' })]);
    fs.writeFileSync(path.join(dataDir, 'disk-operations.json'), JSON.stringify([{ type: 'upload', operation_id: 'stale', updatedAt: now }]));
    const database = fs.readFileSync(path.join(dataDir, 'disk.sqlite')), wal = fs.readFileSync(path.join(dataDir, 'disk.sqlite-wal'));
    const bundle = await collect(options);
    assert.equal(bundle.operationsSource, 'disk.sqlite'); assert.equal(bundle.operations[0].operation_id, 'o1');
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'disk.sqlite')), database);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'disk.sqlite-wal')), wal);
});

test('unreadable SQLite and malformed logs produce a useful bundle without using stale JSON', async t => {
    const { dataDir, now, options, entry, write } = fixture(t);
    fs.writeFileSync(path.join(dataDir, 'disk.sqlite'), 'not a database');
    fs.writeFileSync(path.join(dataDir, 'disk-operations.json'), JSON.stringify([{ type: 'upload', operation_id: 'stale', updatedAt: now }]));
    write('disk-upload.log', [entry('telegram.network-error', -10, { causeCode: 'ECONNRESET' })]);
    const bundle = await collect(options);
    assert.equal(bundle.logs.length, 1); assert.deepEqual(bundle.operations, []);
    assert.ok(bundle.warnings.some(message => /SQLite.*读取失败/.test(message)));
});

test('packaged deployments report release metadata without collecting unrelated configuration', async t => {
    const { dataDir, options } = fixture(t);
    fs.writeFileSync(path.join(dataDir, 'release.json'), JSON.stringify({ sourceCommit: 'c2997b3', sourceBranch: 'gray', buildId: 'test-build', domain: 'tun-test.miku.us', secret: 'private-value' }));
    const bundle = await collect({ ...options, repoDir: dataDir });
    assert.equal(bundle.deployment.source, 'release.json'); assert.equal(bundle.deployment.commit, 'c2997b3');
    assert.equal(bundle.deployment.buildId, 'test-build'); assert.equal(bundle.deployment.secret, undefined);
});

test('diagnostic export redacts credentials and bodies while retaining IDs, times and network causes', () => {
    const token = '123456789:abcdefghijklmnopqrstuvwxyz0123456789';
    const input = { time: '2026-09-28T12:00:00+08:00', uploadId: 'abc', requestNotAccepted: true,
        error: { causeCode: 'ECONNRESET', message: `failed https://example.test/bot${token}/sendDocument ${token} Bearer abc.def.ghi` },
        caption: 'private message', headers: { cookie: 'private-cookie' }, botToken: token,
        nested: { access_token: 'private-token', encryptedToken: 'encrypted', body: 'private bytes' } };
    const output = redact(input), text = JSON.stringify(output);
    assert.equal(output.time, input.time); assert.equal(output.error.causeCode, 'ECONNRESET');
    assert.equal(output.uploadId, 'abc'); assert.equal(output.requestNotAccepted, true);
    for (const value of [token, 'private', 'abc.def.ghi', 'example.test', 'encrypted']) assert.ok(!text.includes(value));
});

test('CLI rejects ambiguous arguments and refuses to overwrite a live diagnostic source', async t => {
    const { dataDir, options, entry, write } = fixture(t);
    for (const argv of [['--minutes', '0'], ['--minutes', '--since'], ['--minutes', '3', '--since', '2026-09-28T12:00:00Z'],
        ['--since', '2026-09-28T12:00:00'], ['--upload-id', '../escape'], ['--unknown']]) assert.throws(() => parseArgs(argv));
    write('disk-upload.log', [entry('telegram.network-error', -10)]);
    const filename = path.join(dataDir, 'disk-upload.log'), before = fs.readFileSync(filename);
    await assert.rejects(main(['--data-dir', dataDir, '--output', filename]), error => error.code === 'EEXIST');
    assert.deepEqual(fs.readFileSync(filename), before);
    t.mock.method(console, 'log', () => {});
    const output = path.join(dataDir, 'diagnostics', 'test.json');
    const report = await main(['--data-dir', dataDir, '--output', output]);
    assert.equal(report.output, output);
    assert.equal(JSON.parse(fs.readFileSync(output)).format, 'drop2tunnel-tgdisk-diagnostics-v1');
    assert.equal((await collect(options)).logs.length, 1);
});
