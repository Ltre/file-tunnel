'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { parseTrojanNodes, exportTrojanNodes, FORMATS } = require('../server/trojan-node-formats');
const { createUpstreamExits } = require('../server/upstream-exits');
const samples = [
    { name: '节点 Ａ / 测试', server: 'edge.fixture.invalid', port: 443, password: 'fixture@pass:word/#中文', serverName: 'tls.fixture.invalid', verifyTls: true, remark: '仅用于隔离回归' },
    { name: 'IPv6 节点', server: '2001:db8::25', port: 8443, password: 'fixture-password-2', serverName: '', verifyTls: false, remark: '' }
];
const connection = n => ({ name: n.name, server: n.server, port: n.port, password: n.password, serverName: n.serverName || n.server, verifyTls: n.verifyTls });
for (const format of Object.keys(FORMATS)) test(format + ' exports an importable file, preserving effective Trojan connection fields', () => {
    const file = exportTrojanNodes(samples, format), parsed = parseTrojanNodes(file.body);
    assert.ok(file.filename && file.contentType); assert.equal(parsed.skipped, 0);
    assert.deepEqual(parsed.nodes.map(connection), samples.map(connection));
    if (format === 'native') assert.deepEqual(parsed.nodes, samples);
    if (format === 'clash') assert.match(file.body, /proxies:/);
    if (format === 'igniter' || format === 'trojan-qt5') assert.equal(file.filename, 'gui-config.json');
});
test('Clash mixed configurations skip non-Trojan and unsupported transport without exposing credentials', () => {
    const parsed = parseTrojanNodes(JSON.stringify({ proxies: [
        { name: 'other', type: 'ss', server: 'ss.invalid', password: 'do-not-show' },
        { ...samples[0], type: 'trojan', network: 'ws', 'ws-opts': { path: '/path' } },
        { name: 'valid', type: 'trojan', server: 'ok.invalid', port: 443, password: 'fixture', 'skip-cert-verify': false }
    ] }));
    assert.equal(parsed.nodes.length, 1); assert.equal(parsed.skipped, 2);
    assert.doesNotMatch(JSON.stringify(parsed.issues), /do-not-show|fixture@/);
});
test('v2ray Trojan outbound JSON and native Trojan config are mapped without applying client routing', () => {
    const parsed = parseTrojanNodes(JSON.stringify({ routing: { rules: [{ arbitrary: true }] }, outbounds: [{ protocol: 'trojan', tag: 'V2 node', settings: { servers: [{ address: 'v2.invalid', port: 443, password: 'fixture' }] }, streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'sni.invalid', allowInsecure: true } } }] }));
    assert.equal(parsed.nodes[0].verifyTls, false); assert.equal(parsed.nodes[0].serverName, 'sni.invalid'); assert.equal(parsed.nodes[0].routing, undefined);
    const native = parseTrojanNodes(JSON.stringify({ remote_addr: 'trojan.invalid', remote_port: 443, password: ['fixture'], ssl: { sni: 'sni.invalid', verify: true } }));
    assert.equal(native.nodes[0].password, 'fixture');
});
test('Clash flow YAML and ordinary shared anchors are supported without executing tags or echoing parse input', () => {
    assert.equal(parseTrojanNodes('{proxies: [{name: flow, type: trojan, server: proxy.invalid, port: 443, password: fixture}]}').nodes.length, 1);
    assert.equal(parseTrojanNodes('base: &base\n  type: trojan\n  server: proxy.invalid\n  port: 443\n  password: fixture\nproxies:\n  - <<: *base\n    name: shared\n').nodes[0].name, 'shared');
    assert.throws(() => parseTrojanNodes('proxies: !unsafe private-secret'), error => !error.message.includes('private-secret') && /无法读取/.test(error.message));
});
test('malformed files, oversized input, unsafe transport and partial TLS policies fail without leaking content', () => {
    assert.throws(() => parseTrojanNodes('password: [private-secret'), /无法读取/);
    assert.throws(() => parseTrojanNodes('x'.repeat(2 * 1024 * 1024 + 1)), /2 MiB/);
    assert.throws(() => parseTrojanNodes(JSON.stringify({ configs: [{ ...samples[0], verify: true, verify_hostname: false }] })), /不同验证策略/);
    for (const option of ['type=ws', 'security=reality', 'alpn=h2', 'fp=chrome', 'headerType=http', 'certsha256=fixture-pin']) assert.throws(() => parseTrojanNodes('trojan://fixture@proxy.invalid:443?' + option), /不支持/);
    assert.throws(() => exportTrojanNodes(samples, '__proto__'), /格式/);
    assert.throws(() => exportTrojanNodes([], 'native'), /至少/);
});
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trojan-interchange-'));
    const exits = createUpstreamExits({ dataDir: dir, startRuntime: () => { throw Error('import/export must not start networking'); } });
    t.after(async () => { await exits.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { dir, exits };
}
test('bulk import appends fresh IDs once, keeps existing nodes/policies, and never returns passwords', t => {
    const { dir, exits } = fixture(t), existing = exits.saveNode(null, samples[0]);
    exits.saveService('youtube', { defaultExit: existing.id, mode: 'ordered', order: [], enabledNodes: [], includeDirect: false });
    const policy = exits.publicConfig().services, result = exits.importNodes(exportTrojanNodes(samples, 'native').body);
    assert.equal(result.imported, 2); assert.equal(exits.publicConfig().nodes.length, 3);
    assert.equal(new Set(exits.publicConfig().nodes.map(n => n.id)).size, 3);
    assert.deepEqual(exits.publicConfig().services, policy);
    assert.doesNotMatch(JSON.stringify(result), /fixture@pass|fixture-password/);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'upstream-exits.json'), 'utf8'));
    assert.equal(saved.nodes.length, 3); assert.equal(saved.nodes[0].id, existing.id);
    assert.equal(parseTrojanNodes(exits.exportNodes([existing.id], 'native').body).nodes.length, 1);
    assert.throws(() => exits.exportNodes(['deleted-node'], 'native'), /有效/);
});
test('an import write failure rolls back the entire batch and preserves the original file', t => {
    const { dir, exits } = fixture(t); exits.saveNode(null, samples[0]);
    const before = fs.readFileSync(path.join(dir, 'upstream-exits.json'), 'utf8'), rename = fs.renameSync;
    fs.renameSync = () => { throw Error('fixture atomic rename failure'); };
    try { assert.throws(() => exits.importNodes(exportTrojanNodes(samples, 'native').body), /rename failure/); }
    finally { fs.renameSync = rename; }
    assert.equal(exits.publicConfig().nodes.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'upstream-exits.json'), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dir), ['upstream-exits.json']);
});
test('bulk import and password-bearing downloads require admin auth and are never cacheable', async t => {
    const { exits } = fixture(t), express = require('express'), app = express(); app.use(express.json());
    const auth = (req, res, next) => req.get('x-fixture-auth') === 'admin' ? next() : res.sendStatus(401);
    require('../server/upstream-exit-routes').registerUpstreamExitRoutes(app, { exits, requireAuth: auth, root: path.resolve(__dirname, '..') });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); t.after(() => server.close());
    const url = 'http://127.0.0.1:' + server.address().port + '/api/upstream-exits/nodes';
    const body = { content: exportTrojanNodes(samples, 'native').body };
    assert.equal((await fetch(url + '/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
    const imported = await fetch(url + '/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-auth': 'admin' }, body: JSON.stringify(body) });
    assert.equal(imported.status, 200); const result = await imported.json(); assert.equal(result.imported, 2);
    const request = { ids: [result.nodes[0].id], format: 'clash' };
    assert.equal((await fetch(url + '/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })).status, 401);
    const download = await fetch(url + '/export', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-auth': 'admin' }, body: JSON.stringify(request) });
    assert.equal(download.status, 200); assert.equal(download.headers.get('cache-control'), 'no-store');
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.equal(parseTrojanNodes(await download.text()).nodes[0].password, samples[0].password);
});
