'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const execute = promisify(execFile), ROOT = path.resolve(__dirname, '..');

test('真实发布构建覆盖所有网盘入口与hash重写，保留服务端共享模块且verify识别缺失', { timeout: 120000 }, async t => {
    const temporary = path.resolve(ROOT, '.npm-cache', 'deploy-drive-test-' + crypto.randomUUID());
    assert.ok(temporary.startsWith(path.join(ROOT, '.npm-cache') + path.sep));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const relative = path.relative(ROOT, temporary);
    const run = args => execute(process.execPath, args, { cwd: ROOT, timeout: 110000, maxBuffer: 8 * 1024 * 1024 });
    await run(['tools/deploy/build.mjs', '--profile', 'txsl', '--out', relative, '--source-branch', 'fixture-261012', '--source-commit', '0123456789abcdef0123456789abcdef01234567']);
    const manifest = JSON.parse(fs.readFileSync(path.join(temporary, 'build-manifest.json')));
    assert.deepEqual(fs.readFileSync(path.join(temporary, 'client/icons/streaming.png')), fs.readFileSync(path.join(ROOT, 'prompts/resources/icons/streaming.png')));
    assert.ok(manifest.appShell.includes('/client/icons/streaming.png'));
    const required = ['disk-error-messages', 'disk-copy-picker', 'disk-trash-ui', 'disk-import-picker', 'disk-file-editor', 'disk-upload-names', 'disk-folder-upload', 'disk-mount-ui', 'disk-operation-order', 'disk-pending-save', 'disk-saved-location', 'account-ui', 'streaming-console', 'streaming-player', 'streaming-i18n'];
    const sourcePages = ['index.html', 'disk-share.html', 'disk-collaboration.html', 'sns-dl.html', 'youtube-premium-dl.html'];
    for (const name of required) {
        const source = 'client/' + name + '.js', asset = manifest.scripts[source];
        assert.match(asset, /^\/assets\/.+\.[a-f0-9]{10}\.min\.js$/);
        assert.ok(fs.existsSync(path.join(temporary, asset.slice(1))));
        assert.ok(manifest.appShell.includes(asset));
        for (const page of sourcePages) {
            const original = fs.readFileSync(path.join(ROOT, 'pages', page), 'utf8');
            if (!original.includes('/' + source)) continue;
            const built = fs.readFileSync(path.join(temporary, 'pages', page), 'utf8');
            assert.ok(built.includes(asset), page + ' must load ' + source);
            assert.ok(!built.includes('/' + source), page + ' must rewrite source path ' + source);
        }
    }
    for (const source of ['client/disk-error-messages.js', 'client/disk-operation-order.js']) {
        assert.deepEqual(fs.readFileSync(path.join(temporary, source)), fs.readFileSync(path.join(ROOT, source)));
    }
    // Load the copied server API, rather than merely checking JavaScript syntax.
    // Module loading creates no server, database or Telegram connection.
    const probe = await run(['-e', 'const api=require(process.argv[1]); if(typeof api.createDiskAPI!=="function")process.exit(1);', path.join(temporary, 'server/disk-api.js')]);
    assert.equal(probe.stdout, '');
    const checked = await run(['tools/deploy/verify.mjs', '--dist', relative, '--profile', 'txsl']);
    assert.match(checked.stdout, /verify ok: txsl/);
    assert.ok(fs.existsSync(path.join(temporary, 'docs/media-library.md')));
    for (const source of ['client/media-library.js', 'client/media-task-link.js', 'client/admin-layout.js']) {
        const asset = manifest.scripts[source]; assert.ok(fs.existsSync(path.join(temporary, asset.slice(1))));
        assert.ok(!manifest.appShell.includes(asset), 'independent administrator subsystem must not expand the PWA shell');
    }
    assert.ok(fs.readFileSync(path.join(temporary, 'pages/media-library.html'), 'utf8').includes(manifest.scripts['client/media-library.js']));
    assert.ok(fs.readFileSync(path.join(temporary, 'pages/admin-layout.html'), 'utf8').includes(manifest.scripts['client/admin-layout.js']));
    assert.ok(fs.existsSync(path.join(temporary, 'server/admin-layout.js')));
    for (const name of ['markdown-records', 'streaming-buffer', 'streaming-covers']) assert.ok(fs.existsSync(path.join(temporary, 'server/' + name + '.js')));
    assert.ok(fs.existsSync(path.join(temporary, 'server/telegram-forward-jobs.js')));
    await run(['-e', 'const api=require(process.argv[1]); if(typeof api.registerMediaLibrary!=="function")process.exit(1);', path.join(temporary, 'server/media-library/index.js')]);
    // A manifest entry alone must not conceal a missing runtime helper.
    fs.unlinkSync(path.join(temporary, 'client/disk-operation-order.js'));
    fs.unlinkSync(path.join(temporary, 'client/icons/streaming.png'));
    fs.unlinkSync(path.join(temporary, 'client/icons/quit-fullscreen.png'));
    await assert.rejects(run(['tools/deploy/verify.mjs', '--dist', relative, '--profile', 'txsl']), error => {
        assert.match(error.stderr, /missing shared server module: client\/disk-operation-order\.js/); assert.match(error.stderr, /missing.*client\/icons\/streaming\.png/); assert.match(error.stderr, /missing.*client\/icons\/quit-fullscreen\.png/); return true;
    });
});
