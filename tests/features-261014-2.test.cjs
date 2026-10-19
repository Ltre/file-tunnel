'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { createTelegramForwardJobs } = require('../server/telegram-forward-jobs');
const { registerAdminLayout } = require('../server/admin-layout');
const source = file => fs.readFileSync(file, 'utf8');
const turn = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function queueFixture(t, overrides = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr2t-forward-'));
    const validate = (_source, _task, input) => ({ targets: input.targets.map(String), fingerprint: 'version-1' });
    const queue = createTelegramForwardJobs({ dataDir, validate, send: async () => ({ messageId: 1 }), autoStart: false, ...overrides });
    t.after(() => { queue.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    return { queue, dataDir, validate };
}
test('persistent queue serializes targets across workers, reports real progress, retains failures and deduplicates submissions', async t => {
    const gate = deferred(), sent = [];
    const f = queueFixture(t, { send: async (_source, _task, input) => {
        sent.push(input.target); input.onProgress({ phase: 'upload', detail: '发送正文', progress: 42, sentBytes: 42, totalBytes: 100 });
        if (input.target.toLowerCase() === '@first') await gate.promise;
        if (input.target === '@bad') throw Error('ECONNRESET');
        return { messageId: sent.length };
    } });
    const body = { targets: ['@first', '@FIRST', '@bad', '-100123'], requestId: 'request-12345', caption: '备注' };
    const job = f.queue.create('sns', 'task', body);
    assert.equal(job.targets.length, 3);
    assert.equal(f.queue.create('sns', 'task', body).id, job.id);
    assert.throws(() => f.queue.create('sns', 'task', { ...body, caption: 'changed' }), /已改变/);
    const running = f.queue.pump(); await turn();
    const inFlight = f.queue.get(job.id); assert.equal(inFlight.targets[0].progress, 42); assert.equal(inFlight.progress, 14); assert.equal(inFlight.completedTargets, 0);
    const worker = createTelegramForwardJobs({ dataDir: f.dataDir, validate: f.validate, autoStart: false, send: async () => { throw Error('must not run'); } });
    try { await worker.pump(); assert.equal(sent.length, 1); } finally { worker.close(); }
    gate.resolve(); await running;
    const result = f.queue.get(job.id);
    assert.deepEqual(sent, ['@FIRST', '@bad', '-100123']);
    assert.equal(result.state, 'partial'); assert.equal(result.completedTargets, 2); assert.equal(result.failedTargets, 1); assert.equal(result.progress, 100);
    assert.match(result.targets[1].error, /ECONNRESET/);
    await f.queue.pump(); assert.equal(sent.length, 3, 'an ambiguous network failure is never automatically resent');
});
test('queued source is revalidated; restarting after an unknown remote outcome does not duplicate a send', async t => {
    let changed = false, sends = 0;
    const f = queueFixture(t, { validate: (_s, _t, input) => ({ targets: input.targets, fingerprint: changed ? 'new' : 'old' }), send: async () => { sends++; return {}; } });
    const job = f.queue.create('youtube', 'task', { targets: ['-1001', '-1002'] }); changed = true; await f.queue.pump();
    assert.equal(sends, 0); assert.equal(f.queue.get(job.id).state, 'failed'); assert.match(f.queue.get(job.id).targets[0].error, /来源成品/);
    const db = new DatabaseSync(path.join(f.dataDir, 'telegram-forward.sqlite'));
    const value = f.queue.get(job.id); value.state = 'running'; value.targets[0].state = 'running'; value.targets[1].state = 'queued';
    db.prepare('UPDATE forward_jobs SET state=?,pid=?,payload=? WHERE id=?').run('running', 2147483647, JSON.stringify(value), job.id); db.close();
    await f.queue.pump(); const recovered = f.queue.get(job.id);
    assert.equal(recovered.state, 'interrupted'); assert.equal(recovered.targets[0].state, 'uncertain'); assert.equal(recovered.targets[1].state, 'queued'); assert.equal(sends, 0);
});
test('admin routes wrap top-level entries, preserve existing inner pages, and enforce authentication before either response', async t => {
    const express = require('express'), app = express();
    registerAdminLayout(app, { root: path.resolve('.'), requireAuth: (req, res, next) => req.headers['x-admin'] === '1' ? next() : res.sendStatus(401) });
    app.get('/sns-dl', (_req, res) => res.send('original SNS page'));
    const server = app.listen(0, '127.0.0.1'); await new Promise(done => server.once('listening', done));
    t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
    const base = 'http://127.0.0.1:' + server.address().port, headers = { 'x-admin': '1' };
    for (const route of ['/admin', '/admin/home', '/sns-dl', '/sns-dl?admin_frame=1']) assert.equal((await fetch(base + route)).status, 401);
    assert.match(await (await fetch(base + '/sns-dl?media_import=abc&media_bind=signed', { headers })).text(), /id="admin-content"/);
    assert.equal(await (await fetch(base + '/sns-dl?admin_frame=1', { headers })).text(), 'original SNS page');
    assert.equal(await (await fetch(base + '/sns-dl', { headers: { ...headers, 'Sec-Fetch-Dest': 'iframe' } })).text(), 'original SNS page');
    assert.match(await (await fetch(base + '/admin/home', { headers })).text(), /SNS 媒体下载/);
});
test('real session initialization retains a disk destination on both hash and recent-session startup paths', async () => {
    const app = source('app.js');
    for (const suffix of ['', '#session-12345']) {
        let url = new URL('http://localhost/disk?disk_account=alice&disk_space=&disk_path=video-collection&disk_file=file' + suffix);
        const context = vm.createContext({ state: {}, navigator: { userAgent: 'test' }, window: { location: { get href() { return url.href; } } }, URL,
            localStorage: { getItem: () => 'device-test', setItem() {} }, detectDeviceModel: () => '',
            getFromStore: async () => ({ shortCode: 'ABCDE' }), countFromStore: async () => 0,
            readSessionDirectoryCache: () => [{ sessionId: 'session-recent', shortCode: 'ABCDE' }],
            history: { replaceState(_a, _b, value) { url = new URL(value, url); } }, updateSessionIdentityUi() {} });
        vm.runInContext(app.slice(app.indexOf('function savedTunnelGrant('), app.indexOf('\nfunction updateSessionIdentityUi()')), context);
        assert.equal(await context.initSession(), true); assert.equal(url.searchParams.get('disk_file'), 'file'); assert.equal(url.searchParams.get('disk_account'), 'alice'); assert.equal(url.searchParams.get('disk_space'), '');
        assert.equal(url.hash, suffix || '#session-recent');
    }
});
test('foreign workshop record asks before leaving an active transfer; a known legacy record resolves its original tunnel', async () => {
    const app = source('app.js'), calls = []; let accepted = false, active = true;
    const context = vm.createContext({ state: { sessionId: 'current-tunnel' }, getFromStore: async () => ({ sessionId: 'source-tunnel' }),
        hasActiveTransferTasks: () => active, confirm: message => { calls.push(message); return accepted; },
        window: { location: { assign: url => calls.push(url) } }, getTransferRecordAnchorUrl: (id, session) => '/?record=' + id + '#' + session, showAppToast: text => calls.push(text) });
    vm.runInContext(app.slice(app.indexOf('async function focusTransferRecordById('), app.indexOf('\nasync function handlePendingRecordNavigation(')), context);
    assert.equal(await context.focusTransferRecordById('record', { allowTunnelSwitch: true }), false); assert.equal(calls.length, 1);
    accepted = true; assert.equal(await context.focusTransferRecordById('record', { allowTunnelSwitch: true }), true); assert.equal(calls.at(-1), '/?record=record#source-tunnel');
    active = false; calls.length = 0; await context.focusTransferRecordById('record', { allowTunnelSwitch: true }); assert.equal(calls.length, 1);
});
test('existing saved mobile tile orders acquire exactly one music entry', () => {
    const app = source('app.js'), start = app.indexOf('function normalizeControlCenterOrder('), end = app.indexOf('\nfunction ', start + 1), context = vm.createContext({});
    vm.runInContext(app.slice(start, end), context);
    const values = context.normalizeControlCenterOrder(['tunnels', 'resources', 'music', 'music']);
    assert.equal(values.filter(id => id === 'music').length, 1); assert.ok(context.normalizeControlCenterOrder(['tunnels']).includes('music'));
});

test('work segment reports source, encoding bytes/time, validation and commit phases before completion', async t => {
    const { createFixture } = require('./support/media-library-fixture.cjs'); let f; const phases = [];
    f = createFixture({ processing: {
        probe: async () => ({ format: { duration: '4' }, streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac' }] }),
        async cut(_url, _start, _end, output, options) {
            const current = () => f.service.list('job').find(job => job.type === 'segment');
            assert.equal(current().phase, 'source');
            for (const phase of ['transcoding', 'validating', 'decoding', 'timeline']) {
                options.onStage(phase); phases.push(current().phase); assert.equal(current().phase, phase);
                if (phase === 'transcoding') { f.advance(250); options.onOutput('out_time_u'); options.onOutput('s=500000\n'); assert.equal(current().processedSeconds, .5); assert.equal(current().durationSeconds, 1); assert.ok(current().progress > 5 && current().progress < 82); }
            }
            fs.writeFileSync(output, 'fixture-clip'); return { precise: true };
        }
    } }); t.after(() => f.close());
    const resource = f.service.createImport({ kind: 'disk', ...f.put('source') }, { id: 'alice' }); await f.service.pump();
    const session = f.service.createSession(resource.id, '进度验证'), job = f.service.clip(session.id, { start: 0, end: 1 }, true); await f.service.pump();
    assert.deepEqual(phases, ['transcoding', 'validating', 'decoding', 'timeline']);
    const complete = f.service.get('job', job.id); assert.equal(complete.state, 'completed'); assert.equal(complete.progress, 100); assert.equal(complete.phase, 'committing'); assert.ok(complete.result.cacheId);
});

test('real multipart HTTP progress counts payload bytes and waits for Telegram confirmation before reporting success', async t => {
    const http = require('node:http'), multipart = require('../server/telegram-multipart'), { observeTelegramUpload } = require('../server/telegram-upload-progress');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr2t-forward-wire-')), filename = path.join(dir, 'body.mp4'); fs.writeFileSync(filename, Buffer.alloc(512 * 1024, 0xaa));
    const received = deferred(), confirm = deferred(), updates = []; let body;
    const listener = http.createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); body = Buffer.concat(chunks); received.resolve(); await confirm.promise; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result: { message_id: 77, chat: { id: '-1001' } } })); });
    listener.listen(0, '127.0.0.1'); await new Promise(done => listener.once('listening', done));
    t.after(() => { listener.closeAllConnections(); listener.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const base = 'http://127.0.0.1:' + listener.address().port;
    const context = vm.createContext({ fs, audioTrackRepair: {}, resolveTelegramForwardFile: () => ({ path: filename, name: '正文.mp4' }), getTelegramBotToken: () => 'fixture', getTelegramBotApiBaseUrl: () => base,
        resolveTelegramForwardTarget: () => ({ target: '-1001', chatId: '-1001' }), getMimeTypeFromFileName: () => 'video/mp4', prepareTelegramForwardVideoThumbnail: async () => null,
        ...multipart, observeTelegramUpload, rememberTelegramForwardTarget: () => [], telegramFetchJson: async (method, request) => (await fetch(base + '/botfixture/' + method, request)).json() });
    const server = source('server.js'); vm.runInContext(server.slice(server.indexOf('async function forwardTaskFileToTelegram'), server.indexOf('\nfunction loadYoutubePremiumMetadataCache')), context);
    let done = false; const pending = context.forwardTaskFileToTelegram({}, 'task', { target: '-1001', supportVideoPreview: true, onProgress: update => updates.push(update) }, 'fixture').then(result => { done = true; return result; });
    await received.promise; await turn(); assert.equal(done, false); assert.ok(body.includes(fs.readFileSync(filename)));
    const sent = updates.find(update => update.phase === 'response'); assert.ok(sent); assert.equal(sent.sentBytes, 512 * 1024); assert.equal(sent.totalBytes, 512 * 1024); assert.equal(sent.progress, 99);
    confirm.resolve(); assert.equal((await pending).messageId, 77);
});

test('forward UI submits multiple targets once, updates while collapsed and restores persisted progress on a new component', async () => {
    function element(tag) { return { tag, children: [], handlers: {}, isConnected: true, value: '', append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; }, setAttribute() {}, addEventListener(event, fn) { this.handlers[event] = fn; }, contains() { return false; }, focus() {} }; }
    const timers = [], calls = [], window = {}; let current = null;
    vm.runInNewContext(source('client/telegram-target-forward.js'), { window, setTimeout: fn => { timers.push(fn); return timers.length; }, document: { createElement: element, createTextNode: text => text, addEventListener() {} } });
    const request = async (url, options) => {
        calls.push({ url, options });
        if (url.includes('/telegram-forward-jobs')) return { jobs: current ? [current] : [] };
        if (url.endsWith('/telegram-forward')) { const input = JSON.parse(options.body); current = { id: 'job', state: 'queued', progress: 0, completedTargets: 0, detail: '等待队列', targets: input.targets.map(target => ({ target, state: 'queued' })) }; return { job: current }; }
        return { targets: [] };
    };
    const task = { id: 'task', status: 'completed' }, details = window.TelegramTargetForward.create(task, '/api/sns-dl', request); await turn();
    const menu = details.children[1]; menu.children[1].value = '@first\n-100123\n@FIRST'; await menu.children[5].onclick();
    const posted = calls.find(call => call.options?.method === 'POST'); assert.deepEqual(JSON.parse(posted.options.body).targets, ['@FIRST', '-100123']); assert.ok(JSON.parse(posted.options.body).requestId);
    details.open = false; current = { ...current, state: 'running', progress: 42, completedTargets: 0, detail: '正在发送正文', currentTarget: '@FIRST' };
    timers.shift()(); await turn(); assert.match(details.children[0].children[0].textContent, /42%.*0\/2/); assert.match(menu.children[6].textContent, /发送正文/); assert.equal(menu.children[5].disabled, true);
    details.isConnected = false; current = { ...current, state: 'completed', progress: 100, completedTargets: 2, detail: '发送结束', targets: current.targets.map(target => ({ ...target, state: 'completed' })) };
    const replacement = window.TelegramTargetForward.create(task, '/api/sns-dl', request); await turn();
    assert.match(replacement.children[0].children[0].textContent, /42%.*0\/2/);
    timers.shift()(); await turn();
    assert.match(replacement.children[0].children[0].textContent, /100%.*2\/2/); assert.equal(replacement.children[1].children[5].disabled, false);
    assert.equal(calls.filter(call => call.options?.method === 'POST').length, 1);
});

test('completed transfer rows do not trigger a false tunnel-switch warning, active rows and fresh queue snapshots do', () => {
    const app = source('app.js'), start = app.indexOf('function hasActiveTransferTasks()'), end = app.indexOf('\nfunction ', start + 1);
    let rows = [{ isConnected: true, dataset: { progressActivity: 'completed' } }];
    const context = vm.createContext({ document: { getElementById: () => ({ get children() { return rows; } }) }, progressQueueSnapshot: { updatedAt: 0, queueLength: 0, activeDownloads: 0 }, PROGRESS_QUEUE_SNAPSHOT_TTL: 1000 });
    vm.runInContext(app.slice(start, end), context); assert.equal(context.hasActiveTransferTasks(), false);
    rows[0].dataset.progressActivity = 'moving'; assert.equal(context.hasActiveTransferTasks(), true); rows = [];
    context.progressQueueSnapshot.updatedAt = Date.now(); context.progressQueueSnapshot.queueLength = 1; assert.equal(context.hasActiveTransferTasks(), true);
});

test('admin shell preserves signed task passthrough parameters and rejects external or non-admin frame destinations', () => {
    function page(address) {
        const nodes = new Map(); let url = new URL(address);
        const node = () => ({ dataset: {}, children: [], classList: { remove() {}, toggle() { return true; } }, setAttribute() {}, removeAttribute() {}, addEventListener() {},
            append(...values) { this.children.push(...values); }, querySelectorAll() { return this.children.filter(value => value.dataset); } });
        const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
        const context = vm.createContext({ URL, location: { get href() { return url.href; }, origin: url.origin }, history: { pushState(_a, _b, value) { url = new URL(value, url); } },
            document: { getElementById: get, querySelector: () => node(), createElement: node, createTextNode: text => text }, addEventListener() {} });
        vm.runInContext(source('client/admin-layout.js'), context); return get('admin-content').src;
    }
    const frame = new URL(page('http://localhost/sns-dl?media_import=abc&media_bind=signature&url=https%3A%2F%2Fexample.test'), 'http://localhost');
    assert.equal(frame.pathname, '/sns-dl'); assert.equal(frame.searchParams.get('media_bind'), 'signature'); assert.equal(frame.searchParams.get('admin_frame'), '1');
    for (const destination of ['https://outside.test/sns-dl', '/api/telegram/drive/list', 'javascript:alert(1)']) assert.equal(new URL(page('http://localhost/admin?view=' + encodeURIComponent(destination)), 'http://localhost').pathname, '/admin/home');
});
