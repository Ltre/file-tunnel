'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), os = require('node:os'), path = require('node:path');
const { createStreamingConsole } = require('../server/streaming-console');
const code = fs.readFileSync('client/streaming-console.js', 'utf8');
const section = (a, b) => code.slice(code.indexOf(a), code.indexOf(b, code.indexOf(a)));
class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.value = ''; this.dataset = {}; }
    append(...children) { this.children.push(...children); }
    add(option) { this.children.push(option); if (!this.value) this.value = option.value; }
    setAttribute() {}
    replaceChildren() { this.children = []; this.value = ''; }
    set selectedIndex(index) { this.value = this.children[index]?.value || ''; }
}
async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-import-261026-'));
    t.after(() => {
        assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
        assert.ok(path.basename(dir).startsWith('stream-import-261026-'));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const service = createStreamingConsole({ dataDir: dir, user: id => ({ id, name: id }), sources: {
        resolve: async source => ({ source, name: source.fileId + '.txt', type: 'text/plain', size: 10 })
    } });
    service.register('device', 'device'.repeat(8), 'Device');
    const actor = { deviceId: 'device', userId: null, logins: [] };
    const station = service.create(actor, { name: 'dell无账号' });
    const input = { name: station.name, loop: true, countdown: 'bottom-right', coverId: '', items: [{ id: 'first', stay: 10, source: { kind: 'local', fileId: 'first' } }] };
    await service.edit(station.id, actor, { ...input, configVersion: 1 });
    await service.edit(station.id, actor, { ...input, configVersion: 2 });
    const snapshot = () => {
        const s = service.station(station.id);
        return structuredClone({ name: s.name, configVersion: s.configVersion, items: s.items, loop: s.loop, countdown: s.countdown, coverId: '' });
    };
    let baseline = snapshot(), body, focus, navigation;
    const calls = [], ui = { drafts: {}, stationId: station.id };
    const context = { ready: Promise.resolve(), dirty: () => false, open: async () => {}, account: () => '', structuredClone,
        config: { tunnels: async () => [{ sessionId: 'tunnel', accessGrant: 'grant' }], currentTunnel: () => 'tunnel' },
        uid: () => 'inserted', ui, localConfig: () => structuredClone(baseline), saveConfig: (_id, value) => { baseline = structuredClone(value); }, saveUi() {}, closeDialog() {},
        navigate: (...args) => { navigation = args; }, pendingCovers: new Map(), saveFlights: new Map(), discardCover() {},
        document: { createElement: tag => new Node(tag) }, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
        t: value => value, showDialog: (_title, value) => { body = value; }, button: (_title, run) => ({ tag: 'button', run }),
        request: async (route, method, value) => {
            calls.push(route);
            if (route === '/tunnel-candidates') return { candidates: [{ name: 'inserted.txt', kind: 'text', size: 10, type: 'text/plain', source: { kind: 'tunnel', sessionId: 'tunnel', messageId: 'record', fileId: 'inserted' } }] };
            if (route === '/stations?kind=local') return { stations: service.list(actor, 'local') };
            if (route.endsWith('/edit-config')) return snapshot();
            if (route.endsWith('/revision')) return service.revision(station.id, actor, value);
            return service.edit(station.id, actor, value);
        } };
    vm.runInNewContext(section('    async function reconcileRevision(', '    function editor(') + section('    async function importRecord(', '    async function sendMarkdown('), context);
    return { context, ui, service, actor, station, snapshot, calls,
        baseline: value => { baseline = structuredClone(value); }, getBaseline: () => structuredClone(baseline), body: () => body,
        navigation: () => navigation,
        async choose() { await context.importRecord({ id: 'record', sessionId: 'tunnel' }); },
        async add() { await this.choose(); await body.children.find(node => node.tag === 'button').run(); },
        async changeServer() { await service.edit(station.id, actor, { ...snapshot(), name: '服务端新名称' }); } };
}

test('adding a tunnel record loads the current server playlist instead of saving a stale local baseline', async t => {
    const f = await fixture(t); await f.changeServer();
    await f.add();
    await assert.doesNotReject(f.context.persistDraft(f.station.id, () => {}), 'adding to a clean playlist must not hit the stale 3 → 4 conflict');
    assert.deepEqual(f.service.station(f.station.id).items.map(item => item.id), ['first', 'inserted']);
    assert.equal(f.service.station(f.station.id).name, '服务端新名称');
});

test('version-only changes advance both a local baseline and its modified draft without discarding inserted items', async t => {
    const f = await fixture(t); await f.add();
    const stored = f.service.station(f.station.id); stored.configVersion++;
    await f.context.persistDraft(f.station.id, () => {});
    assert.equal(f.service.station(f.station.id).items.length, 2);
});

test('real concurrent server changes still reject a stale draft and preserve all local edits', async t => {
    const f = await fixture(t); await f.add(); await f.changeServer();
    await assert.rejects(f.context.persistDraft(f.station.id, () => {}), /STREAM_CONFLICT/);
    assert.equal(f.ui.drafts[f.station.id].items.length, 2);
    assert.equal(f.service.station(f.station.id).name, '服务端新名称');
    assert.equal(f.service.station(f.station.id).items.length, 1);
});

test('an unsaved target draft is retained and must be explicitly discarded before loading a changed server playlist', async t => {
    const f = await fixture(t), original = f.snapshot(); original.name = '未保存的名称';
    f.ui.drafts[f.station.id] = original;
    await f.changeServer(); await f.choose();
    const add = f.body().children.find(node => node.tag === 'button');
    const reload = f.body().children.filter(node => node.tag === 'button')[1];
    assert.equal(add.disabled, true); assert.equal(reload.hidden, false);
    assert.equal(f.ui.drafts[f.station.id].name, '未保存的名称');
    await reload.run(); assert.equal(add.disabled, false); assert.equal(f.ui.drafts[f.station.id], undefined);
    await add.run(); await f.context.persistDraft(f.station.id, () => {});
    assert.equal(f.service.station(f.station.id).name, '服务端新名称');
    assert.deepEqual(f.service.station(f.station.id).items.map(item => item.id), ['first', 'inserted']);
});

test('an account change during playlist loading cannot replace the saved baseline or enable insertion', async t => {
    const f = await fixture(t), originalRequest = f.context.request; let release;
    f.context.request = async (...args) => {
        const response = await originalRequest(...args);
        if (args[0].endsWith('/edit-config')) await new Promise(resolve => { release = resolve; });
        return response;
    };
    const loading = f.choose(); await new Promise(setImmediate);
    f.context.account = () => 'other'; release(); await loading;
    const add = f.body().children.find(node => node.tag === 'button');
    assert.equal(add.disabled, true); assert.equal(f.ui.drafts[f.station.id], undefined);
    assert.equal(f.service.station(f.station.id).items.length, 1);
});

test('closing the insertion dialog ignores a late configuration response', async t => {
    const f = await fixture(t), originalRequest = f.context.request; let release;
    f.context.request = async (...args) => {
        const response = await originalRequest(...args);
        if (args[0].endsWith('/edit-config')) await new Promise(resolve => { release = resolve; });
        return response;
    };
    const loading = f.choose(); await new Promise(setImmediate);
    f.body().isConnected = false; release(); await loading;
    assert.equal(f.body().children.find(node => node.tag === 'button').disabled, true);
    assert.equal(f.ui.drafts[f.station.id], undefined);
});

test('reading a newer playlist does not replace the clean draft or its baseline until insertion is confirmed', async t => {
    const f = await fixture(t), old = f.snapshot();
    f.ui.drafts[f.station.id] = structuredClone(old); await f.changeServer(); await f.choose();
    assert.equal(f.getBaseline().configVersion, 3); assert.equal(f.ui.drafts[f.station.id].configVersion, 3);
    assert.equal(f.ui.drafts[f.station.id].name, 'dell无账号');
    await f.body().children.find(node => node.tag === 'button').run();
    assert.equal(f.getBaseline().configVersion, 4); assert.equal(f.ui.drafts[f.station.id].configVersion, 4);
    await assert.doesNotReject(f.context.persistDraft(f.station.id, () => {}));
});
