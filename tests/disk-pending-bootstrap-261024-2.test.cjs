'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const diskSource = fs.readFileSync('client/disk-ui.js', 'utf8'), accountSource = fs.readFileSync('client/account-ui.js', 'utf8');
const turn = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const section = (start, end) => diskSource.slice(diskSource.indexOf(start), diskSource.indexOf(end, diskSource.indexOf(start)));
class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.hidden = false; this.isConnected = true; this.classes = new Set(); this.classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value), contains: value => this.classes.has(value) }; }
    append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attrs[key] = value; }
    remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(value => value !== this); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]).filter(child => selector === 'button' ? child.tagName === 'button' : selector === '[aria-pressed]' ? child.attrs['aria-pressed'] !== undefined : false); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function fixture({ pendingSave = '' } = {}) {
    const directory = deferred(), calls = [], body = new Element('body'), overlay = new Element('div'); overlay.hidden = true;
    let account = 'alice'; const users = [{ identity: { id: 'alice', name: 'Alice' } }, { identity: { id: 'bob', name: 'Bob' } }];
    const document = { body, createElement: tag => new Element(tag), addEventListener() {}, getElementById: id => id === 'telegramDriveOverlay' ? overlay : null };
    const history = { state: {}, pushState(state) { this.state = state; }, replaceState(state) { this.state = state; } };
    const window = { addEventListener() {}, dispatchEvent() {}, DiskClient: {
        getAccount: () => account, setAccount: value => { account = value; }, setMount() {}, setCollaboration() {},
        accountOperations: async id => ({ accountId:id,operations:[] }),
        json: (method, value) => ({ method, body: JSON.stringify(value) }),
        raw: async (route, options) => { calls.push(route); if (route === '/me') return { accounts: users }; if (route === '/accounts/select') return { identity: { id: JSON.parse(options.body).accountId } }; throw Error('unexpected ' + route); }
    } };
    const context = vm.createContext({ window, document, history, AbortController, setTimeout, clearTimeout, location: { href: 'http://localhost/disk', origin: 'http://localhost' }, URL, URLSearchParams, Date, Math,
        telegramDriveEntryQuery: new URLSearchParams(pendingSave ? 'pendingSave=' + pendingSave : ''), telegramDriveEntryUrl: { pathname: '/disk' }, telegramDrivePendingSaveId: pendingSave,
        telegramDriveHistorySession: '', telegramDriveCurrentData: null, telegramDriveContentStale: true, diskWindowState: { retained: false }, telegramDrivePath: '',
        telegramDriveNavigationVersion: 0, telegramDriveRenderGeneration: 0, telegramDriveMountContext: null, telegramDriveStaticLinks: [], telegramDriveSpaceOwner: '', telegramDriveOidcPopup: null,
        renderTelegramDrive: () => { calls.push('render'); return directory.promise; }, resumeTelegramDrivePendingSave: async () => { calls.push('resume-pending'); },
        resumeTelegramDriveEntry: async () => { calls.push('resume-entry'); return false; }, telegramDriveEntryPending: false,
        rememberTelegramDriveAccountView() {}, rememberTelegramDriveActiveAccount() {}, cancelTelegramDrivePendingMount() {}, closeDiskCollaborationFrame() {}, closeDiskPreview() {}, clearTelegramDriveSearch() {}, clearTelegramDriveSelection() {},
        renderTelegramDriveBreadcrumbs() {}, renderTelegramDriveItems() {}, updateDiskCacheLabels() {}, highlightTelegramDriveUploadedFiles() {}, appendTelegramDriveAddAccount() {},
        telegramDriveErrorText: error => error.message, alert: value => calls.push('alert:' + value), showAppToast: value => calls.push('toast:' + value)
    });
    vm.runInContext(accountSource, context);
    vm.runInContext(section('async function switchTelegramDriveAccount(', 'async function resumeTelegramDriveEntry(') + section('async function manageTelegramDriveAccounts(', 'async function showTelegramDrivePendingSaveBanner(') + section('async function openTelegramDrive(', 'function closeTelegramDrive('), context);
    const bootstrap = section('    const entryQuery = telegramDriveEntryQuery;', '\n}\nwindow.addEventListener');
    return { calls, body, overlay, directory, context, account: () => account, start: () => vm.runInContext(bootstrap, context), open: options => context.openTelegramDrive(options), switchAccount: id => context.switchTelegramDriveAccount(id), chooseAccount: () => context.manageTelegramDriveAccounts({ choose: true }) };
}

test('pending-save disk startup opens its shell and starts target selection before ordinary directory loading completes', async () => {
    const f = fixture({ pendingSave: 'pending' }); f.start(); await turn();
    assert.equal(f.overlay.hidden, false); assert.ok(f.calls.includes('resume-pending'), 'pending selection must not be gated on the ordinary disk directory');
    f.directory.resolve(); await turn();
});

test('ordinary disk startup still waits for its directory before resolving', async () => {
    const f = fixture(); let done = false; const opened = f.open().then(() => { done = true; }); await turn();
    assert.equal(f.overlay.hidden, false); assert.equal(done, false); assert.deepEqual(f.calls, ['render']);
    f.directory.resolve(); await opened; assert.equal(done, true);
});

test('shared account chooser confirms after account selection without waiting for the old directory request', async () => {
    const f = fixture(); let chosen; const choice = f.chooseAccount().then(value => { chosen = value; }); await turn();
    const buttons = f.body.querySelectorAll('button'), bob = buttons.find(button => button.textContent === 'Bob'); await bob.onclick();
    const confirmation = buttons.find(button => button.textContent === '选择此账号'); const clicked = confirmation.onclick(); await turn();
    assert.equal(f.account(), 'bob'); assert.equal(chosen?.id, 'bob'); assert.equal(f.context.window.AccountUI.isOpen(), false);
    f.directory.resolve(); await clicked; await choice;
});

test('ordinary account switching keeps waiting for its directory and entry restoration', async () => {
    const f = fixture(); let done = false; const switched = f.switchAccount('bob').then(() => { done = true; }); await turn();
    assert.equal(f.account(), 'bob'); assert.equal(done, false); assert.deepEqual(f.calls, ['/accounts/select', 'render']);
    f.directory.resolve(); await switched; assert.equal(done, true); assert.ok(f.calls.includes('resume-entry'));
});

function transferFixture({ stall = '', fail = '', bodyStall = '' } = {}) {
    const pendingSource = fs.readFileSync('client/disk-pending-save.js', 'utf8');
    const fromPending = (start, end) => pendingSource.slice(pendingSource.indexOf(start), pendingSource.indexOf(end, pendingSource.indexOf(start)));
    const target = { accountId: 'original-account', partitionId: 'part-id', diskSpace: 'original-space', path: '原目录', partitionName: '原分区' };
    let record = { id: 'pending-id', source: 'sns', task: { id: 'source-task' }, transferMode: 'server', version: '1000-5', status: 'pending', file: { name: 'video.mp4', size: 5 }, target };
    const calls = [], stages = [], timers = new Map(); let nextTimer = 0;
    const task = { id: 'source-task', completedAt: 1000, outputFileSize: 5, status: 'completed', hasFile: true };
    const waitForAbort = signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    const window = { AbortController, navigator: { locks: { request: async (_name, _options, run) => run({ name: 'owned' }) } },
        fetch: async (url, options) => { calls.push({ url, options, kind: 'source' }); if (stall === 'source') return waitForAbort(options.signal); return { ok: true, status: 200, json: async () => bodyStall === 'source' ? waitForAbort(options.signal) : task }; },
        DiskClient: {
            getAccount: () => 'different-current-account', json: (method, body) => ({ method, body: JSON.stringify(body) }),
            raw: async (url, options) => { calls.push({ url, options, kind: 'metadata' });
                if (url === stall) return waitForAbort(options.signal); if (url === fail) throw Error('metadata-read-failed');
                // DiskClient.raw historically turns response.json() failures
                // into {}, including cancellation after headers arrive.
                if (url === bodyStall) return waitForAbort(options.signal).catch(() => ({}));
                if (url === '/accounts') return { accounts: [{ identity: { id: target.accountId } }] };
                if (url === '/spaces') return { spaces: [{ id: target.partitionId, scopeKey: target.diskSpace, state: 'ACTIVE' }] };
                if (url.startsWith('/list?path=')) return { files: [] };
                throw Error('unexpected metadata route ' + url);
            },
            request: async (url, options) => { calls.push({ url, options, kind: 'submit' }); return { items: [{ id: 'saved-file' }] }; },
            upload: () => { throw Error('browser upload is forbidden'); }
        }
    };
    const context = vm.createContext({ window, global: window, AbortController, Date, Promise, Map, DOMException, encodeURIComponent,
        setTimeout: (run, ms) => { const id = ++nextTimer; timers.set(id, { run, ms }); return id; }, clearTimeout: id => timers.delete(id),
        active: new Map(), get: async () => structuredClone(record), update: async (_id, patch) => record = { ...record, ...patch }, complete: async (_id, result) => record = { ...record, result, status: 'completed' },
        versionOf: value => `${value.completedAt}-${value.outputFileSize}`, getBlob: () => { throw Error('must not read file body'); },
        telegramDrivePendingSaveId: record.id, telegramDrivePendingSaveRunning: false,
        telegramDriveSpaceKey: space => String(space.scopeKey), pendingSaveFeedback: value => stages.push(value),
        showTelegramDrivePendingSaveBanner: async () => {}, showAppToast() {}, telegramDriveErrorText: error => error.message,
        confirmTelegramDriveAction: async () => true, formatFileSize: String, telegramDriveDisplayPath: value => '/' + value,
        manageTelegramDriveAccounts: () => { throw Error('original account remains authenticated'); }
    });
    vm.runInContext(fromPending('    function describeTarget(', '    function decorateButton(') + fromPending('    async function verifySource(', '    async function prepare(') + fromPending('    async function resume(', '    global.DiskPendingSave =') + ';global.DiskPendingSave={resume,verifySource,describeTarget};', context);
    context.switchTelegramDriveAccount=async()=>true; context.revealTelegramDriveUploadedDirectory=async()=>true; context.telegramDriveNavigationVersion=1;
    vm.runInContext(section('function pendingSaveTransferId(', 'function pendingSaveFeedback(') + section('async function pendingSaveRead(', 'async function showTelegramDrivePendingSaveBanner(') + section('async function choosePendingSaveTarget(', 'function telegramDriveErrorText('), context);
    return { calls, stages, timers, record: () => record, run: () => context.resumeTelegramDrivePendingSave(), fire: () => { const entry = [...timers.values()][0]; assert.equal(entry.ms, 20000); entry.run(); } };
}

test('pending target metadata timeout aborts its read, clears its timer, and never submits a transfer', async () => {
    const f = transferFixture({ stall: '/spaces' }), running = f.run(); await turn();
    assert.equal(f.timers.size, 1); f.fire(); await assert.rejects(running, /读取转存信息超时/);
    assert.equal(f.timers.size, 0); assert.equal(f.record().status, 'pending'); assert.equal(f.calls.some(call => call.kind === 'submit'), false);
    const read = f.calls.find(call => call.url === '/spaces'); assert.equal(read.options.signal.aborted, true);
    assert.equal(read.options.accountId, 'original-account'); assert.equal(read.options.diskSpace, 'original-space');
});

test('failed target metadata read preserves the pending record without task submission and releases timers', async () => {
    const f = transferFixture({ fail: '/list?path=' + encodeURIComponent('原目录') });
    await assert.rejects(f.run(), /metadata-read-failed/);
    assert.equal(f.timers.size, 0); assert.equal(f.record().status, 'pending'); assert.equal(f.calls.some(call => call.kind === 'submit'), false);
});

test('resuming a bound pending transfer retains the original account and partition despite another active account', async () => {
    const f = transferFixture(); await f.run(); assert.equal(f.record().status, 'completed'); assert.equal(f.timers.size, 0);
    const scoped = f.calls.filter(call => call.url === '/spaces' || call.url.startsWith('/list?') || call.kind === 'submit');
    assert.equal(scoped.length, 3);
    for (const call of scoped) { assert.equal(call.options.accountId, 'original-account'); assert.equal(call.options.diskSpace, 'original-space'); assert.equal(call.options.requestBase, '/api/telegram/drive'); }
    const submitted = f.calls.find(call => call.kind === 'submit'); assert.equal(submitted.url, '/task-saves');
    assert.deepEqual(JSON.parse(submitted.options.body), { pendingSaveId: 'pending-id', source: 'sns', taskId: 'source-task', version: '1000-5', partitionId: 'part-id', folderPath: '原目录' });
    assert.ok(f.stages.includes('正在核验原转存账号…')); assert.ok(f.stages.includes('正在核验目标目录和来源版本…'));
});

test('source verification timeout aborts before submission and preserves pending metadata for retry', async () => {
    const f = transferFixture({ stall: 'source' }), running = f.run(); await turn();
    assert.equal(f.timers.size, 1); f.fire(); await assert.rejects(running, /来源任务核验超时/);
    assert.equal(f.timers.size, 0); assert.equal(f.record().status, 'pending'); assert.equal(f.calls.some(call => call.kind === 'submit'), false);
    assert.equal(f.calls.find(call => call.kind === 'source').options.signal.aborted, true);
});

test('timeouts during metadata or source response bodies keep the agreed timeout message instead of a shape error', async () => {
    for (const [bodyStall, message] of [['/spaces', /读取转存信息超时/], ['source', /来源任务核验超时/]]) {
        const f = transferFixture({ bodyStall }), running = f.run(); await turn();
        assert.equal(f.timers.size, 1); f.fire();
        await assert.rejects(running, error => { assert.notEqual(error.name, 'TypeError'); assert.match(error.message, message); return true; });
        assert.equal(f.timers.size, 0); assert.equal(f.record().status, 'pending');
        assert.equal(f.calls.some(call => call.kind === 'submit'), false);
    }
});
