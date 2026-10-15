'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const read = name => fs.readFileSync(name, 'utf8'), tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function destinationFixture(query, rawFile = async () => ({ file: { id: 'target-file', folderPath: 'video-collection' } })) {
    const source = read('client/disk-ui.js'), calls = [], disk = { account: '', space: 'last-space' };
    const context = vm.createContext({ telegramDriveEntryQuery: new URLSearchParams(query), telegramDriveEntryPending: /disk_file|disk_path/.test(query), telegramDriveEntryFlight: null,
        telegramDriveSpaceOwner: '', telegramDriveNavigationVersion: 0, telegramDriveRenderGeneration: 0, telegramDriveOidcPollGeneration: 0,
        telegramDriveOidcPopup: null, telegramDrivePendingSaveId: '', window: { DiskClient: {
            getAccount: () => disk.account, setAccount: id => { disk.account = id; }, getSpace: () => disk.space, setMount() {}, setCollaboration() {},
            json: (method, body) => ({ method, body }), raw: async (route, options) => {
                calls.push({ route, account: disk.account, options });
                if (route === '/me') return { identity: { id: options.accountId } };
                if (route === '/accounts/select') return {};
                return rawFile(route);
            }
        } }, rememberTelegramDriveAccountView() {}, cancelTelegramDrivePendingMount() {}, closeDiskCollaborationFrame() {}, closeDiskPreview() {},
        clearTelegramDriveSearch() {}, clearTelegramDriveSelection() {}, rememberTelegramDriveActiveAccount() {},
        renderTelegramDrive: async () => { context.telegramDriveSpaceOwner = disk.account; },
        switchTelegramDrivePartition: async space => { calls.push({ space }); disk.space = space; },
        navigateTelegramDrive: async path => { calls.push({ path }); context.telegramDriveNavigationVersion++; },
        navigateTelegramDriveInputPath: async path => { calls.push({ inputPath: path }); context.telegramDriveNavigationVersion++; },
        highlightTelegramDriveRow: item => calls.push({ highlight: item.id }), showAppToast() {}, alert: message => calls.push({ alert: message }) });
    vm.runInContext(source.slice(source.indexOf('async function switchTelegramDriveAccount('), source.indexOf('\nfunction appendTelegramDriveAddAccount(')), context);
    vm.runInContext(source.slice(source.indexOf('async function finishTelegramDriveOidcLogin('), source.indexOf('\nasync function pollTelegramDriveOidcLogin(')), context);
    return { context, calls, disk };
}
test('an unauthenticated file destination resumes after real login completion and account selection, then highlights only once', async () => {
    const f = destinationFixture('disk_account=target&disk_space=&disk_file=target-file&disk_path=old#ignored');
    assert.equal(await f.context.resumeTelegramDriveEntry(), false); assert.equal(f.calls.length, 0);
    await f.context.finishTelegramDriveOidcLogin('success', '', 'target');
    assert.equal(f.disk.account, 'target'); assert.equal(f.disk.space, '');
    assert.deepEqual(f.calls.filter(c => c.path), [{ path: 'video-collection' }]);
    assert.deepEqual(f.calls.filter(c => c.highlight), [{ highlight: 'target-file' }]);
    await f.context.switchTelegramDriveAccount('target'); assert.equal(f.calls.filter(c => c.highlight).length, 1);
});
test('wrong-account login cannot read the target; subsequent correct account selection still resumes it', async () => {
    const f = destinationFixture('disk_account=target&disk_file=target-file&disk_space=中文分区');
    await f.context.finishTelegramDriveOidcLogin('success', '', 'other'); assert.equal(f.calls.some(c => c.route.startsWith('/files/')), false);
    assert.equal(f.context.telegramDriveEntryPending, true); await f.context.switchTelegramDriveAccount('target');
    assert.equal(f.disk.space, '中文分区'); assert.equal(f.calls.filter(c => c.highlight).length, 1);
});
test('login cancellation and read failures retain the destination; late responses cannot navigate another account', async () => {
    const slow = deferred(), f = destinationFixture('disk_account=target&disk_file=file', () => slow.promise);
    await f.context.finishTelegramDriveOidcLogin('error', 'cancelled'); assert.equal(f.context.telegramDriveEntryPending, true);
    const first = f.context.switchTelegramDriveAccount('target'); await tick();
    const switched = f.context.switchTelegramDriveAccount('other'); await tick(); slow.resolve({ id: 'file', path: 'private' }); await Promise.all([first, switched]);
    assert.equal(f.calls.some(c => c.highlight || c.path), false); assert.equal(f.context.telegramDriveEntryPending, true);
    let fail = true; const retry = destinationFixture('disk_account=target&disk_file=file', async () => { if (fail) throw Error('network'); return { id: 'file', path: 'new' }; });
    await assert.rejects(retry.context.switchTelegramDriveAccount('target'), /network/); assert.equal(retry.context.telegramDriveEntryPending, true);
    fail = false; await retry.context.resumeTelegramDriveEntry(); assert.equal(retry.calls.filter(c => c.highlight).length, 1);
});
test('bare /disk never replaces the remembered directory and path-only links resume after login', async () => {
    const bare = destinationFixture(''); await bare.context.switchTelegramDriveAccount('target'); assert.equal(bare.calls.some(c => c.path || c.space), false);
    const path = destinationFixture('disk_account=target&disk_space=&disk_path=资料'); await path.context.finishTelegramDriveOidcLogin('success', '', 'target');
    assert.deepEqual(path.calls.filter(c => c.inputPath), [{ inputPath: '资料' }]);
});
test('selecting another account does not overwrite a pending destination account in the URL', () => {
    const source = read('client/disk-ui.js'); let current = new URL('https://fixture/disk?disk_account=target&disk_file=file#tunnel');
    const context = vm.createContext({ URL, location: { get href() { return current.href; }, origin: current.origin }, localStorage: { setItem() {}, removeItem() {} },
        telegramDriveEntryPending: true, telegramDriveEntryQuery: new URLSearchParams(current.search), history: { state: {}, replaceState(_s,_t,url) { current = new URL(url); } } });
    vm.runInContext(source.slice(source.indexOf('function rememberTelegramDriveActiveAccount('), source.indexOf('\nasync function switchTelegramDriveAccount(')), context);
    context.rememberTelegramDriveActiveAccount('other'); assert.equal(current.searchParams.get('disk_account'), 'target'); assert.equal(current.searchParams.get('disk_file'), 'file');
    context.telegramDriveEntryPending = false; context.rememberTelegramDriveActiveAccount('other'); assert.equal(current.searchParams.get('disk_account'), 'other');
});
test('YouTube auto-cache preference uses its actual endpoint, toggles both ways and reports errors', async () => {
    const source = read('pages/youtube-premium-dl.html'), start = source.indexOf("            const preference = document.createElement('button');"), end = source.indexOf("            const tagButton =", start);
    assert.ok(start > 0 && end > start);
    const calls = [], actions = { appendChild(node) { this.button = node; } }, task = { id: 'task/id', autoCacheEnabled: true }, notice = {};
    let reject = false;
    const context = vm.createContext({ task, actions, notice, document: { createElement: () => ({}) }, premiumBrowserCache: { cancelAutomatic: id => calls.push({ cancelled: id }) },
        api: async (route, options) => { calls.push({ route, body: JSON.parse(options.body) }); if (reject) throw Error('offline'); return {}; }, loadTasks: async () => calls.push({ reload: true }) });
    vm.runInContext(source.slice(start, end), context); const btn = actions.button;
    await btn.onclick(); assert.equal(task.autoCacheEnabled, false); assert.equal(btn.textContent, '允许自动缓存到浏览器');
    assert.equal(calls[1].route, '/api/youtube-premium/tasks/task%2Fid'); assert.deepEqual(calls[1].body, { autoCacheEnabled: false });
    await btn.onclick(); assert.equal(task.autoCacheEnabled, true); assert.equal(btn.textContent, '停止自动缓存到浏览器');
    reject = true; await btn.onclick(); assert.match(notice.textContent, /更新自动缓存设置失败.*offline/); assert.equal(task.autoCacheEnabled, true); assert.equal(btn.disabled, false);
});
test('collection jobs retain real transfer progress until the file reference is committed', async t => {
    const { createFixture } = require('./support/media-library-fixture.cjs'), f = createFixture(); t.after(() => f.close()); const s = f.service;
    const resource = s.createImport({ kind: 'disk', ...f.put('video') }, { id: 'alice' }); await s.pump();
    const session = s.createSession(resource.id, '进度'), clip = s.clip(session.id, { start: 0, end: 1 }); await s.pump();
    const gate = deferred(), entered = deferred(), original = f.disk.write;
    f.disk.write = async (...args) => {
        args[6]({ percent: 41, phase: 'upload', detail: '正在上传正文', telegramBytesSent: 41, telegramBytesConfirmed: 20, totalBytes: 100 }); entered.resolve(); await gate.promise; return original(...args);
    };
    const record = s.collect(clip.id), pending = s.pump(); await entered.promise;
    const job = s.list('job').find(j => j.context.collectionId === record.id);
    try {
        assert.equal(job.progress, 41); assert.equal(job.telegramBytesSent, 41); assert.equal(job.telegramBytesConfirmed, 20);
        assert.equal(s.get('collection', record.id).state, 'transferring'); assert.ok(!s.get('result', clip.id).savedId);
    } finally { gate.resolve(); await pending; }
    assert.equal(s.get('collection', record.id).state, 'ready'); assert.equal(s.get('job', job.id).progress, 100);
});
