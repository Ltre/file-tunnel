'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function action(kind, task, request) {
    const source = read(`pages/${kind}.html`), actions = { append(button) { this.button = button; } };
    const notice = {}, alerts = [], calls = [];
    const button = () => ({ disabled:false, addEventListener(_name, handler) { this.onclick = handler; } });
    const context = {
        task, actions, notice, encodeURIComponent,
        document:{ createElement:button }, element:(_tag, _className, textContent) => ({ ...button(), textContent }),
        api:async (url, options) => { calls.push({url, options}); await request(); },
        loadTasks:async options => { calls.push({refresh:options}); },
        alert:message => alerts.push(message), confirm:() => true, API_ROOT:'/api/sns-download'
    };
    if (kind === 'sns-dl') {
        const helperStart = source.indexOf('    function makeAction(');
        vm.runInNewContext(source.slice(helperStart, source.indexOf('    function taskReferenceDetails(', helperStart)), context);
        const start = source.indexOf('        actions.append(makeAction(task.handled');
        vm.runInNewContext(source.slice(start, source.indexOf('        if (task.hasFile)', start)), context);
    } else {
        const saveStart = source.indexOf('    async function saveTaskDetails(');
        vm.runInNewContext(source.slice(saveStart, source.indexOf('    function renderTagEditor(', saveStart)), context);
        const start = source.indexOf("        const handled = document.createElement('button')");
        vm.runInNewContext(source.slice(start, source.indexOf('        const running =', start)), context);
    }
    return {button:actions.button, calls, notice, alerts};
}

for (const kind of ['sns-dl', 'youtube-premium-dl']) {
    test(`${kind}: handled action waits for successful PATCH before refreshing the current category`, async () => {
        let resolveRequest;
        const pending = new Promise(resolve => { resolveRequest = resolve; });
        const task = {id:'task/1', handled:true, status:'completed'};
        const runtime = action(kind, task, () => pending);
        assert.equal(runtime.button.textContent, '标记为·待处理');
        assert.equal(runtime.button.disabled, false);
        const click = runtime.button.onclick();
        assert.equal(runtime.button.disabled, true);
        assert.equal(runtime.calls.length, 1);
        assert.equal(runtime.calls[0].options.method, 'PATCH');
        assert.match(runtime.calls[0].url, /\/tasks\/task%2F1$/);
        assert.deepEqual(JSON.parse(runtime.calls[0].options.body), {handled:false});
        resolveRequest(); await click;
        assert.equal(runtime.calls.length, 2);
        assert.equal(runtime.calls[1].refresh.force, true);
        assert.equal(task.status, 'completed');
    });

    test(`${kind}: failed reverse marking remains retryable and does not refresh away the task`, async () => {
        const runtime = action(kind, {id:'failed', handled:true}, async () => { throw Error('fixture unavailable'); });
        await runtime.button.onclick();
        assert.equal(runtime.button.disabled, false);
        assert.equal(runtime.calls.length, 1);
        assert.match(runtime.notice.textContent || runtime.alerts.join(' '), /fixture unavailable/);
    });
}

test('reverse manual categorization persists without changing execution state or cache ownership', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handled-reverse-261024-2-'));
    t.after(() => {
        assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
        assert.ok(path.basename(dir).startsWith('handled-reverse-261024-2-'));
        fs.rmSync(dir, {recursive:true, force:true});
    });
    for (const [kind, create] of [
        ['sns', require('../server/sns-downloader').createSnsDownloadService],
        ['youtube-premium', require('../server/youtube-premium').createYoutubePremiumService]
    ]) {
        const filename = kind === 'sns' ? 'sns-download-tasks.json' : `${kind}-tasks.json`;
        fs.writeFileSync(path.join(dir, filename), JSON.stringify([{id:'task', status:'failed', createdAt:1, completedAt:2, handled:true, handledAt:3, remark:'retain'}]));
        const options = {dataDir:dir, analyze:async () => { throw Error('not used'); }, download:async () => { throw Error('not used'); }};
        const service = create(options);
        service.updateDetails('task', {handled:false});
        assert.equal(service.list(1, 10, 'handled').total, 0);
        assert.equal(service.list(1, 10, 'pending').tasks[0].id, 'task');
        assert.deepEqual(service.list(1, 10, 'pending').ids, ['task']);
        const saved = create(options).get('task');
        assert.equal(saved.handled, false);
        assert.equal(saved.status, 'failed');
        assert.equal(saved.completedAt, 2);
        assert.equal(saved.remark, 'retain');
    }
});
