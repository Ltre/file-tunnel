'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const test = require('node:test');
const { argumentsFor, main, inspect, validatePlan, vulnerable, treeHash, assertStopped, probe } = require('../tools/repair-engineio-security.cjs');

const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
function writePackage(root, name, version) {
    const folder = path.join(root, 'node_modules', name);
    fs.mkdirSync(folder, { recursive: true });
    writeJSON(path.join(folder, 'package.json'), { name, version, main: 'index.js' });
    fs.writeFileSync(path.join(folder, 'index.js'), `// ${name} ${version}\nmodule.exports = {};\n`);
}

function fixture(t, version = '6.6.9') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engineio-repair-test-'));
    t.after(() => {
        assert.ok(path.basename(root).startsWith('engineio-repair-test-'));
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const manifest = { name: 'instant-tunnel', version: '1.0.0', dependencies: { 'socket.io': '4.8.3' } };
    const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: {
        '': { ...manifest }, 'node_modules/socket.io': { version: '4.8.3', dependencies: { 'engine.io': '~6.6.0' } },
        'node_modules/engine.io': { version, integrity: `original-${version}` }, 'node_modules/ws': { version: '8.21.0' }
    } };
    writeJSON(path.join(root, 'package.json'), manifest); writeJSON(path.join(root, 'package-lock.json'), lock);
    writePackage(root, 'socket.io', '4.8.3'); writePackage(root, 'engine.io', version); writePackage(root, 'ws', '8.21.0');
    return root;
}

function hooks(overrides = {}) {
    const calls = [];
    return { calls, assertStopped: async () => {}, progress: () => {},
        audit: async () => ({ status: 'available', vulnerabilities: { total: 0 } }),
        probe: async root => {
            assert.equal(inspect(root).engines[0].installedVersion, '6.6.11');
            return { protocolMismatchRejected: true, binary: true };
        },
        runNpm: async (args, cwd) => {
            calls.push(args[0]);
            assert.equal(path.basename(cwd), 'stage');
            if (args[0] === 'update') {
                const lockFile = path.join(cwd, 'package-lock.json');
                const lock = JSON.parse(fs.readFileSync(lockFile));
                lock.packages['node_modules/engine.io'] = { version: '6.6.11', integrity: 'patched' }; writeJSON(lockFile, lock);
            } else {
                assert.equal(args[0], 'ci');
                writePackage(cwd, 'socket.io', '4.8.3'); writePackage(cwd, 'engine.io', '6.6.11');
            }
        }, ...overrides };
}

const applyOptions = root => ({ projectDir: root, apply: true, stopped: true, port: 45678 });

test('CLI requires a stopped service and explicit actual Node port for every mutation', () => {
    assert.throws(() => argumentsFor(['--apply']), /停止/);
    assert.throws(() => argumentsFor(['--apply', '--service-stopped']), /端口/);
    assert.throws(() => argumentsFor(['--apply', '--rollback', 'backup']), /不能同时/);
    assert.throws(() => argumentsFor(['--port', '70000']), /1–65535/);
    assert.equal(argumentsFor([]).apply, false);
});

test('dry-run inspects the actual Socket.IO dependency and creates no files', async t => {
    const root = fixture(t), original = treeHash(root);
    const report = await main({ projectDir: root }, hooks({ runNpm: async () => assert.fail('dry-run must be offline') }));
    assert.equal(report.needsRepair, true); assert.equal(report.runtimePath, 'node_modules/engine.io');
    assert.equal(treeHash(root), original);
});

test('a safe installation is idempotent and does not acquire a lock or contact npm', async t => {
    const root = fixture(t, '6.6.11'), before = treeHash(root);
    assert.equal((await main(applyOptions(root), hooks())).mode, 'already-safe');
    assert.equal(treeHash(root), before);
});

test('only Engine.IO files and lock metadata change, and manual rollback restores exact originals', async t => {
    const root = fixture(t), deps = path.join(root, 'node_modules');
    const manifest = fs.readFileSync(path.join(root, 'package.json')), originalLock = fs.readFileSync(path.join(root, 'package-lock.json'));
    const engineBefore = treeHash(path.join(deps, 'engine.io')), otherBefore = treeHash(path.join(deps, 'ws'));
    const env = hooks();
    const result = await main(applyOptions(root), env);
    assert.deepEqual(env.calls, ['update', 'ci']); assert.equal(result.mode, 'applied');
    assert.equal(inspect(root).needsRepair, false);
    assert.deepEqual(fs.readFileSync(path.join(root, 'package.json')), manifest);
    assert.equal(treeHash(path.join(deps, 'ws')), otherBefore);
    assert.equal(fs.existsSync(path.join(result.backupDir, 'stage')), false);
    const rollback = await main({ projectDir: root, rollback: result.backupDir, stopped: true, port: 45678 }, hooks());
    assert.equal(rollback.mode, 'rolled-back');
    assert.deepEqual(fs.readFileSync(path.join(root, 'package-lock.json')), originalLock);
    assert.equal(treeHash(path.join(deps, 'engine.io')), engineBefore);
    assert.equal((await main({ projectDir: root, rollback: result.backupDir, stopped: true, port: 45678 }, hooks())).mode, 'rolled-back');
});

test('a copied safe lock with an old installed package is repaired without a version downgrade', async t => {
    const root = fixture(t, '6.6.11'); writePackage(root, 'engine.io', '6.6.9');
    const result = await main(applyOptions(root), hooks());
    assert.equal(result.engines[0].installedVersion, '6.6.11'); assert.equal(result.mode, 'applied');
});

test('live verification failure automatically restores original dependency and lock', async t => {
    const root = fixture(t), before = treeHash(path.join(root, 'node_modules')), lock = fs.readFileSync(path.join(root, 'package-lock.json'));
    let checks = 0;
    await assert.rejects(main(applyOptions(root), hooks({ probe: async () => {
        if (++checks === 2) throw new Error('simulated installed verification failure'); return { ok: true };
    } })), /已自动回滚/);
    assert.equal(treeHash(path.join(root, 'node_modules')), before);
    assert.deepEqual(fs.readFileSync(path.join(root, 'package-lock.json')), lock);
    const backups = fs.readdirSync(path.join(root, '.dependency-maintenance')).filter(name => name.startsWith('engineio-'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.dependency-maintenance', backups[0], 'repair.json'))).status, 'rolled-back');
});

test('reject unrelated dependency changes before replacing any live files', async t => {
    const root = fixture(t), before = treeHash(path.join(root, 'node_modules')), lock = fs.readFileSync(path.join(root, 'package-lock.json'));
    await assert.rejects(main(applyOptions(root), hooks({ runNpm: async (_, cwd) => {
        const filename = path.join(cwd, 'package-lock.json'), data = JSON.parse(fs.readFileSync(filename));
        data.packages['node_modules/ws'].version = '9.0.0'; writeJSON(filename, data);
    } })), /之外的依赖/);
    assert.equal(treeHash(path.join(root, 'node_modules')), before); assert.deepEqual(fs.readFileSync(path.join(root, 'package-lock.json')), lock);
});

test('reject a registry/network failure without changing the deployed lock or modules', async t => {
    const root = fixture(t), before = treeHash(path.join(root, 'node_modules')), lock = fs.readFileSync(path.join(root, 'package-lock.json'));
    await assert.rejects(main(applyOptions(root), hooks({ runNpm: async () => { throw new Error('registry unavailable'); } })), /registry unavailable/);
    assert.equal(treeHash(path.join(root, 'node_modules')), before); assert.deepEqual(fs.readFileSync(path.join(root, 'package-lock.json')), lock);
});

test('a service restarting during preparation blocks application', async t => {
    const root = fixture(t), before = treeHash(path.join(root, 'node_modules'));
    let calls = 0;
    await assert.rejects(main(applyOptions(root), hooks({ assertStopped: async () => { if (++calls === 2) throw new Error('port listening'); } })), /port listening/);
    assert.equal(treeHash(path.join(root, 'node_modules')), before);
});

test('rollback refuses to overwrite a later deployment or tampered backup', async t => {
    const root = fixture(t), applied = await main(applyOptions(root), hooks());
    fs.appendFileSync(path.join(root, 'package-lock.json'), '\n');
    await assert.rejects(main({ projectDir: root, rollback: applied.backupDir, stopped: true, port: 45678 }, hooks()), /发生变化/);
    assert.equal(inspect(root).needsRepair, false);
});

test('rollback can recover an interrupted directory swap with a missing live Engine.IO', async t => {
    const root = fixture(t), applied = await main(applyOptions(root), hooks());
    fs.rmSync(path.join(root, 'node_modules', 'engine.io'), { recursive: true });
    await main({ projectDir: root, rollback: applied.backupDir, stopped: true, port: 45678 }, hooks());
    assert.equal(inspect(root).engines[0].installedVersion, '6.6.9');
});

test('maintenance lock blocks concurrent repair without changing live modules', async t => {
    const root = fixture(t), before = treeHash(path.join(root, 'node_modules'));
    fs.mkdirSync(path.join(root, '.dependency-maintenance'));
    fs.writeFileSync(path.join(root, '.dependency-maintenance', 'maintenance.lock'), '{}');
    await assert.rejects(main(applyOptions(root), hooks()), /已有维护锁/);
    assert.equal(treeHash(path.join(root, 'node_modules')), before);
});

test('lockfile v2 legacy dependency metadata may change only for Engine.IO', () => {
    const before = { lockfileVersion: 2, packages: { '': {}, 'node_modules/engine.io': { version: '6.6.9' } },
        dependencies: { 'socket.io': { version: '4.8.3' }, 'engine.io': { version: '6.6.9', requires: { base64id: '2.0.0' } } } };
    const after = structuredClone(before); after.packages['node_modules/engine.io'].version = '6.6.11';
    after.dependencies['engine.io'] = { version: '6.6.11' };
    validatePlan(before, after);
    after.dependencies['socket.io'].version = '4.8.4'; assert.throws(() => validatePlan(before, after), /之外的依赖/);
});

test('unsafe major/minor updates and an unfixed override are rejected', () => {
    const before = { packages: { '': {}, 'node_modules/engine.io': { version: '6.6.9' } } };
    assert.throws(() => validatePlan(before, before), /阻止/);
    for (const version of ['6.7.0', '7.0.0', '6.6.10-beta.1']) {
        const after = structuredClone(before); after.packages['node_modules/engine.io'].version = version;
        assert.throws(() => validatePlan(before, after), /只允许/);
    }
    assert.equal(vulnerable('6.6.9'), true); assert.equal(vulnerable('6.6.10'), false);
});

test('an open actual Node port is rejected even with the stopped-service assertion', async t => {
    const server = net.createServer(socket => socket.end());
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    await assert.rejects(assertStopped(server.address().port), /仍有监听/);
});

test('the standalone fresh-process probe validates the real installed package', { timeout: 20000 }, async () => {
    const result = await probe(path.resolve(__dirname, '..'));
    assert.deepEqual(result, { protocolMismatchRejected: true, polling: true, websocketUpgrade: true, binary: true });
});
