'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const test = require('node:test');

const serverPath = path.resolve(__dirname, '../server.js');
const serverSource = fs.readFileSync(serverPath, 'utf8');
const bootstrap = serverSource.slice(0, serverSource.indexOf("const express = require('express');"));

function tempDirectory(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-diagnostics-261101-4-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    return dataDir;
}

function runBootstrap(t, { action = '', proxy = false, spawnError = false, killChild = false } = {}) {
    // Execute the actual entry prefix, replacing only child launch or the first
    // application dependency. No application data, media tool or service is opened.
    const dataDir = tempDirectory(t);
    const program = `
        const { createRequire } = require('node:module');
        const { compileFunction } = require('node:vm');
        const realRequire = createRequire(${JSON.stringify(serverPath)});
        const childProcess = require('node:child_process');
        const isolatedRequire = name => {
            if (name === 'child_process') return { spawn(_command, _args, options) {
                const child = childProcess.spawn(${spawnError ? "process.execPath + '.missing-fixture'" : 'process.execPath'}, ['-e', ${JSON.stringify(action)}], options);
                ${killChild ? "child.once('spawn', () => child.kill('SIGTERM'));" : ''}
                return child;
            } };
            if (name === 'express') throw Error('fixture-initialize-fatal');
            return realRequire(name);
        };
        compileFunction(${JSON.stringify(bootstrap + (proxy ? '' : "\nrequire('express');"))}, ['require'], { filename: ${JSON.stringify(serverPath)} })(isolatedRequire);
    `;
    return spawnSync(process.execPath, ['-e', program], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, TUNNEL_DATA_DIR: dataDir, NODE_USE_ENV_PROXY: proxy ? '' : '1', DR2T_PROXY_REEXEC: '',
            DR2T_PROXY: proxy ? 'http://127.0.0.1:9' : '', DR2T_ALL_PROXY: '', HTTPS_PROXY: '', HTTP_PROXY: '', ALL_PROXY: '' }
    });
}

test('initialization failures are diagnosed before the first application dependency is loaded', t => {
    const child = runBootstrap(t);
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /\[server-fatal\].*origin=uncaughtException/);
    assert.match(child.stderr, /fixture-initialize-fatal/);
    assert.match(child.stderr, /\[server-exit\] pid=\d+ code=1 signal=none/);
});

test('the proxy parent reports an OS-terminated child even when that child cannot write an exit record', t => {
    const child = runBootstrap(t, { proxy: true, action: 'setInterval(() => {}, 1000);', killChild: true });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /\[server-proxy-exit\].*childPid=\d+ code=none signal=SIGTERM/);
    assert.match(child.stderr, /\[server-exit\] pid=\d+ code=1 signal=none/);
});

const diagnosticSetup = 'const diagnostics = require(' + JSON.stringify(require.resolve('../server/process-diagnostics')) +
    ').installProcessDiagnostics();\n';

function runDiagnostics(t, action, dataDir = tempDirectory(t), before = '') {
    const child = spawnSync(process.execPath, ['-e', before + diagnosticSetup + action], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, TUNNEL_DATA_DIR: dataDir, DIAGNOSTIC_FIXTURE_SECRET: 'private-environment-fixture' }
    });
    assert.equal(child.error, undefined);
    return { child, dataDir };
}

test('lifecycle records persist with memory context and exclude error messages, environment and argv', t => {
    const { child, dataDir } = runDiagnostics(t, `
        diagnostics.setPhase('ready');
        throw Error('private-message-fixture');
    `);
    assert.equal(child.status, 1);
    const log = fs.readFileSync(path.join(dataDir, 'server-process.log'), 'utf8');
    assert.match(log, /\[server-start\].*node=v/);
    assert.match(log, /\[server-phase\].*phase=ready/);
    assert.match(log, /\[server-fatal\].*origin=uncaughtException name=Error code=unknown/);
    assert.match(log, /\[server-exit\].*code=1 signal=none/);
    assert.match(log, /time=\d{4}-\d\d-\d\dT.* rss=\d+ heapUsed=\d+ heapTotal=\d+ external=\d+ arrayBuffers=\d+/);
    assert.doesNotMatch(log, /private-message-fixture|private-environment-fixture|TUNNEL_DATA_DIR|DIAGNOSTIC_FIXTURE_SECRET|throw Error/);
    assert.match(child.stderr, /private-message-fixture/, 'Node still prints its original uncaught error to stderr');
});

test('an unwritable diagnostics destination warns once without changing the business exit code', t => {
    const dataDir = tempDirectory(t);
    const blocked = path.join(dataDir, 'private-path-fixture');
    fs.writeFileSync(blocked, 'fixture');
    const { child } = runDiagnostics(t, "diagnostics.setPhase('ready'); process.exit(7);", blocked);
    assert.equal(child.status, 7);
    assert.equal((child.stderr.match(/\[server-diagnostics-warning\]/g) || []).length, 1);
    assert.match(child.stderr, /\[server-exit\] pid=\d+ code=7 signal=none/);
    assert.doesNotMatch(child.stderr, /private-path-fixture/);
    assert.equal(fs.readFileSync(blocked, 'utf8'), 'fixture');
});

test('a failed append keeps stderr diagnostics and default fatal termination', t => {
    const { child } = runDiagnostics(t, "throw Error('private-fatal-fixture');", undefined, `
        require('node:fs').appendFileSync = () => { throw Object.assign(Error('private-write-fixture'), { code: 'EACCES' }); };
    `);
    assert.equal(child.status, 1);
    assert.equal((child.stderr.match(/\[server-diagnostics-warning\]/g) || []).length, 1);
    assert.match(child.stderr, /\[server-fatal\].*origin=uncaughtException/);
    assert.match(child.stderr, /\[server-exit\] pid=\d+ code=1 signal=none/);
    assert.doesNotMatch(child.stderr, /private-write-fixture/);
});

test('multiline error messages cannot inject fake stack locations into persisted diagnostics', t => {
    const { child, dataDir } = runDiagnostics(t, "throw Error('private-message-fixture\\n    at private-frame-fixture.js:1:2');");
    assert.equal(child.status, 1);
    const log = fs.readFileSync(path.join(dataDir, 'server-process.log'), 'utf8');
    assert.match(log, /\[server-fatal\]/);
    assert.doesNotMatch(log, /private-message-fixture|private-frame-fixture/);
});

function assertBoundedLogs(dataDir) {
    const files = fs.readdirSync(dataDir).sort();
    assert.deepEqual(files, ['server-process.log', 'server-process.log.1']);
    for (const file of files) {
        const size = fs.statSync(path.join(dataDir, file)).size;
        assert.ok(size > 0 && size <= 512 * 1024, file + ' must stay within 512 KiB, actual=' + size);
        for (const line of fs.readFileSync(path.join(dataDir, file), 'utf8').trim().split('\n')) {
            assert.match(line, /^\[server-(?:start|phase|exit)\] pid=\d+/);
        }
    }
}

test('diagnostics retain at most one bounded rotated segment', t => {
    const { child, dataDir } = runDiagnostics(t, "for (let i = 0; i < 5000; i++) diagnostics.setPhase('fixture-' + i);");
    assert.equal(child.status, 0);
    assertBoundedLogs(dataDir);
    assert.match(fs.readFileSync(path.join(dataDir, 'server-process.log'), 'utf8'), /\[server-exit\]/);
});

test('two existing process roles can append and rotate concurrently without affecting exit status', async t => {
    const dataDir = tempDirectory(t);
    const line = '[server-phase] pid=1 fixture\n';
    fs.writeFileSync(path.join(dataDir, 'server-process.log'), line.repeat(Math.floor((512 * 1024 - 8192) / line.length)));
    const program = diagnosticSetup + "for (let i = 0; i < 200; i++) diagnostics.setPhase('fixture-' + i);";
    const launch = () => new Promise((resolve, reject) => {
        execFile(process.execPath, ['-e', program], {
            encoding: 'utf8', timeout: 5000, env: { ...process.env, TUNNEL_DATA_DIR: dataDir }
        }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    });
    const children = await Promise.all([launch(), launch()]);
    for (const child of children) assert.match(child.stderr, /\[server-exit\].*code=0 signal=none/);
    assertBoundedLogs(dataDir);
});

test('a failed rotation cannot grow the existing log or alter the requested exit code', t => {
    const dataDir = tempDirectory(t);
    const logPath = path.join(dataDir, 'server-process.log');
    const previous = '[server-phase] pid=1 ' + 'x'.repeat(512 * 1024 - 128) + '\n';
    fs.writeFileSync(logPath, previous);
    const { child } = runDiagnostics(t, "diagnostics.setPhase('ready'); process.exit(7);", dataDir, `
        require('node:fs').renameSync = () => { throw Object.assign(Error('private-rotation-fixture'), { code: 'EACCES' }); };
    `);
    assert.equal(child.status, 7);
    assert.equal((child.stderr.match(/\[server-diagnostics-warning\]/g) || []).length, 1);
    assert.match(child.stderr, /\[server-exit\] pid=\d+ code=7 signal=none/);
    assert.doesNotMatch(child.stderr, /private-rotation-fixture/);
    assert.equal(fs.readFileSync(logPath, 'utf8'), previous);
});

test('the existing proxy parent reports a quiet child exit and preserves its exit status', t => {
    const child = runBootstrap(t, { proxy: true, action: 'process.exit(23);' });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 23);
    assert.match(child.stderr, /\[server-proxy-exit\].*childPid=\d+ code=23 signal=none/);
    assert.match(child.stderr, /\[server-exit\] pid=\d+ code=23 signal=none/);
});

test('proxy child launch failure is diagnosed and still terminates unsuccessfully', t => {
    const child = runBootstrap(t, { proxy: true, spawnError: true });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /\[server-proxy-error\].*code=ENOENT/);
    assert.match(child.stderr, /\[server-exit\] pid=\d+ code=1 signal=none/);
});
