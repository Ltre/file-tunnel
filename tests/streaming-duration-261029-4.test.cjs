'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const code = fs.readFileSync('client/streaming-console.js', 'utf8');
function runtime() {
    const probes = [], timers = [], d = { items: [] };
    const context = { durationJobs: new Map(), durationQueue: [], durationActive: 0, previewTickets: new Map(),
        account: () => '', candidateKey: item => item.source.fileId, structuredClone,
        saveUi() {}, refreshEditorItems: null, localBlob: async () => new Blob(['unchanged']),
        AbortController, Number, Error, URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
        document: { createElement() { const media = { duration: NaN, removeAttribute() {}, load() {}, set src(value) { probes.push(this); } }; return media; } },
        setTimeout(run, ms) { timers.push({ run, ms }); return timers.length; }, clearTimeout() {} };
    vm.runInNewContext(code.slice(code.indexOf('    const durationKey ='), code.indexOf('    async function preview(')), context);
    return { context, probes, timers, d };
}
const tick = () => new Promise(setImmediate);
const item = () => ({ id: 'old', name: 'unchanged.mp4', kind: 'video', size: 9, source: { kind: 'local', fileId: 'original', name: 'unchanged.mp4', size: 9 } });

test('a local media duration may become finite after loadedmetadata; an early unknown value is not a permanent failure', async () => {
    const f = runtime(), value = item(), job = f.context.duration(value, '');
    const outcome = job.then(value => ({ value }), error => ({ error: error.message }));
    await tick(); f.probes[0].onloadedmetadata();
    f.probes[0].duration = 42;
    f.probes[0].ondurationchange?.();
    assert.deepEqual(await outcome, { value: 42 });
});

test('a failed shared probe does not poison the same unchanged file when checking it again', async () => {
    const f = runtime(), value = item(); f.context.ensureDuration(value); await tick();
    f.probes[0].onerror(); await tick();
    assert.ok(value.durationError);
    f.context.ensureDuration(value); await tick();
    assert.equal(f.probes.length, 2);
    f.probes[1].duration = 42; f.probes[1].onloadedmetadata(); await tick();
    assert.equal(value.duration, 42); assert.equal(value.durationError, '');
});

test('a media source that never supplies a finite positive duration still fails at its bounded deadline', async () => {
    const f = runtime(), job = f.context.duration(item(), ''); const rejected = assert.rejects(job, /STREAM_DURATION_REQUIRED/);
    await tick(); f.probes[0].duration = Infinity; f.probes[0].onloadedmetadata();
    f.timers.find(t => t.ms === 30000).run(); await rejected;
});
