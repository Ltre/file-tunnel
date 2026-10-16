'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createFixture } = require('./support/media-library-fixture.cjs');
const turn = () => new Promise(setImmediate);
async function drain(service) { for (let index = 0; index < 20; index++) { if (!service.list('job').some(job => job.state === 'queued')) return; await service.pump(); } throw Error('fixture queue did not drain'); }
async function videoFixture(t) {
    const f = createFixture(); t.after(() => f.close()); const s = f.service;
    const resource = s.createImport({ kind: 'disk', ...f.put('video') }, { id: 'alice' }); await s.pump();
    const session = s.createSession(resource.id, '批次验收'); return { ...f, s, session, resource };
}
test('frame batches reserve session-local numbers and report persisted frame counts plus processing details', async t => {
    const f = await videoFixture(t), { s, session } = f;
    const first = s.extract(session.id, { mode: 'interval', ranges: '0-1', intervalMs: 500 }), second = s.extract(session.id, { mode: 'interval', ranges: '1-2', intervalMs: 500 });
    assert.equal(first.batch.ordinal, 1); assert.equal(second.batch.ordinal, 2);
    await drain(s); const complete = s.get('batch', first.batch.id), job = s.get('job', first.job.id);
    assert.equal(complete.actualCount, complete.times.length); assert.equal(job.framesDone, complete.times.length); assert.equal(job.framesTotal, complete.times.length); assert.match(job.detail, /已提取/);
    const another = s.createSession(f.resource.id, '另一会话'); assert.equal(s.extract(another.id, { mode: 'interval', ranges: '0-1', intervalMs: 500 }).batch.ordinal, 1);
    s.db.patch('batch', first.batch.id, 'alice', { ordinal: undefined });
    assert.equal(s.extract(session.id, { mode: 'interval', ranges: '2-3', intervalMs: 500 }).batch.ordinal, 3, 'legacy rows without numbers are counted without renumbering newer batches');
});
test('compression numbers are reserved before execution and survive failure, retry and legacy jobs', async t => {
    const f = await videoFixture(t), { s, session } = f, clip = s.clip(session.id, { start: 0, end: 1 }); await s.pump();
    let fail = true;
    s.processing.compress = async (_input, output, options) => { if (options.crf === 28 && fail) { fail = false; throw Error('fixture compression failure'); } fs.writeFileSync(output, 'compressed'); return { width: 160, height: 90, duration: 1, bytes: 10 }; };
    s.processing.thumbnail = async (_input, output) => { fs.writeFileSync(output, 'thumbnail'); };
    const first = s.transcode(clip.id, { crf: 28 }), second = s.transcode(clip.id, { crf: 30 });
    assert.equal(first.context.ordinal, 1); assert.equal(second.context.ordinal, 2); await drain(s);
    assert.equal(s.get('job', first.id).state, 'failed'); assert.equal(s.get('compression', second.id).ordinal, 2);
    s.retry(first.id); const third = s.transcode(clip.id, {}); assert.equal(third.context.ordinal, 3); await drain(s);
    assert.equal(s.get('compression', first.id).ordinal, 1); assert.equal(s.get('compression', third.id).ordinal, 3);
    const previous = s.get('job', second.id); s.db.patch('job', second.id, 'alice', { context: { ...previous.context, ordinal: undefined } });
    const legacy = s.db.create('job', 'alice', { type: 'transcode', context: { ...third.context, ordinal: undefined }, state: 'queued', progress: 0, attempts: 0 });
    const next = s.transcode(clip.id, {}); assert.equal(next.context.ordinal, 5); assert.equal(s.get('job', legacy.id).context.ordinal, 4); assert.equal(s.get('job', second.id).context.ordinal, 2);
    await drain(s); assert.equal(s.get('compression', legacy.id).ordinal, 4); assert.equal(s.get('compression', next.id).ordinal, 5);
});
test('retried frame batches immediately return to queued and do not retain stale failure text after recovery', async t => {
    const { s, session } = await videoFixture(t); const frame = s.processing.frame; let fail = true;
    s.processing.frame = async (...args) => { if (fail) { fail = false; throw Error('fixture decode failure'); } return frame(...args); };
    const batch = s.extract(session.id, { mode: 'interval', ranges: '0-1', intervalMs: 500 }); await drain(s);
    assert.equal(s.get('batch', batch.batch.id).state, 'failed'); assert.ok(s.get('batch', batch.batch.id).error);
    s.retry(batch.job.id); assert.equal(s.get('batch', batch.batch.id).state, 'queued'); assert.equal(s.get('batch', batch.batch.id).error, '');
    await drain(s); assert.equal(s.get('batch', batch.batch.id).state, 'completed'); assert.equal(s.get('batch', batch.batch.id).error, '');
});
function forwardingFixture() {
    const calls = [], timers = []; let now = 0, current = null, fail = false;
    function element(tag) { return { tag, children: [], handlers: {}, isConnected: true, value: '', append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; }, setAttribute() {}, addEventListener(event, fn) { this.handlers[event] = fn; }, contains() { return false; }, focus() {} }; }
    const window = {}, context = vm.createContext({ window, Date: class extends Date { static now() { return now; } }, setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, document: { createElement: element, createTextNode: text => text, addEventListener() {} } });
    vm.runInContext(fs.readFileSync('client/telegram-target-forward.js', 'utf8'), context);
    const request = async (url, options) => { calls.push({ url, options }); if (fail) throw Error('offline'); if (url.endsWith('/cancel')) return { job: { ...current, cancelRequested: true } }; if (url.includes('/telegram-forward-jobs')) return { jobs: current ? [current] : [] }; return { targets: [] }; };
    return { calls, timers, setJob(value) { current = value; }, setTime(value) { now = value; }, fail(value) { fail = value; },
        create: (id = 'task') => window.TelegramTargetForward.create({ id, status: 'completed' }, '/api/youtube-premium', request) };
}
const job = state => ({ id: 'job', state, progress: state === 'completed' ? 100 : 36, completedTargets: state === 'completed' ? 1 : 0, targets: [{ target: '@fixture', state }], detail: state });
test('idle forwarding queries are shared across rebuilt cards for 60 seconds; opening the panel refreshes immediately', async () => {
    const f = forwardingFixture(); let last = f.create(); await turn();
    for (let i = 1; i <= 29; i++) { f.setTime(i * 2000); last.isConnected = false; last = f.create(); await turn(); }
    assert.equal(f.calls.length, 1); f.setTime(60000); last = f.create(); await turn(); assert.equal(f.calls.length, 2);
    f.setJob(job('running')); last.open = true; await last.handlers.toggle(); assert.equal(f.calls.filter(call => call.url.includes('/telegram-forward-jobs')).length, 3);
    assert.match(last.children[0].children[0].textContent, /36%/); assert.equal(f.timers[0].delay, 1000);
});
test('active forwarding remains live while collapsed, stops polling on completion and keeps cancellation immediate', async () => {
    const f = forwardingFixture(); f.setJob(job('running')); const view = f.create(); await turn();
    assert.equal(f.timers[0].delay, 1000); view.open = false; f.setJob(job('completed')); f.setTime(1000); f.timers.shift().fn(); await turn();
    assert.match(view.children[0].children[0].textContent, /100%.*1\/1/); assert.equal(f.timers.length, 0);
    f.setTime(61000); f.setJob(job('running')); const active = f.create(); await turn();
    await active.children[1].children.at(-1).onclick(); assert.ok(f.calls.some(call => call.url === '/api/telegram-forward-jobs/job/cancel' && call.options.method === 'POST'));
    assert.equal(active.children[1].children.at(-1).disabled, true);
});
test('failed idle history reads are also throttled, but explicit opening can retry them without waiting', async () => {
    const f = forwardingFixture(); f.fail(true); const initial = f.create(); await turn(); f.setTime(2000); f.create(); await turn(); assert.equal(f.calls.length, 1);
    f.fail(false); initial.open = true; await initial.handlers.toggle(); assert.ok(f.calls.some(call => call.url.includes('/telegram-forward-jobs'))); assert.ok(f.calls.length > 1);
});
