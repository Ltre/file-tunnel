'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('admin exposes durable tunnel audit fields and cache-node actions', () => {
    const page = read('pages/admin.html');
    for (const label of [
        '活跃设备', '历史总设备', '创建时间', '最后活动',
        '传输记录', '传输文件', '文件占用总大小',
        '启用缓存节点', '停止缓存节点', '查看缓存节点'
    ]) assert.match(page, new RegExp(label));
    assert.match(page, /\/vclient\?sessionId=/);
    assert.match(page, /若其他真实供源全部离线，尚未缓存完成的文件可能暂时无法获取/);
});

test('audit ledger covers direct file and editor protocols without synthetic delete spam', () => {
    const infra = read('server/infra-store.js');
    const server = read('server.js');
    const fileAssets = read('server/file-assets.js');
    assert.match(infra, /CREATE TABLE IF NOT EXISTS asset_transfer_events/);
    assert.match(infra, /INSERT OR IGNORE INTO tunnel_members/);
    assert.match(infra, /direct-file:/);
    assert.match(infra, /if \(!existing\) return false/);
    assert.doesNotMatch(infra, /'delete-tombstone'/);
    assert.match(fileAssets, /recordTransferEvent\(sessionId, 'announced'/);
    assert.match(fileAssets, /recordTransferEvent\(sessionId, status === 'completed' \? 'client-completed' : 'failed'/);
    assert.match(fileAssets, /recordTransferEvent\(sessionId, 'relay-completed'/);
    assert.match(server, /recordAssetTransferEvent\?\.\(sessionId, 'announced'/);
    assert.match(server, /recordAssetTransferEvent\?\.\(sessionId, 'relay-completed'/);
    assert.match(server, /auditFileAssets: getSessionAuditFileAssets\(sourceSession\)/);
});

test('VClient remains an independent multi-tunnel process with interruption containment', () => {
    const runtime = read('vclient/runtime.js');
    const cache = read('vclient/cache-store.js');
    const control = read('server/vclient-control.js');
    const app = read('app.js');
    const pkg = JSON.parse(read('package.json'));

    assert.equal(pkg.scripts.vclient, 'node vclient/index.js');
    assert.match(runtime, /this\.tunnels = new Map\(\)/);
    assert.match(runtime, /armReceiveIdleWatchdog/);
    assert.match(runtime, /socket\.on\('device-left'/);
    assert.match(runtime, /suspendTunnels\('control-superseded'\)/);
    assert.match(cache, /_sha256File/);
    assert.match(cache, /\.corrupt-/);
    assert.match(control, /controller\.emit\('superseded'/);
    assert.match(control, /forceDisconnectTunnel\(sessionId, 'vclient-tunnel-disabled'\)/);
    assert.match(app, /clientType === 'vclient'/);
    assert.match(app, /Cache nodes use Socket\.IO relay instead of WebRTC/);
});

test('/vclient is a read-only record/status view without misleading progress bars', () => {
    const page = read('pages/vclient.html');
    assert.match(page, /传输记录/);
    assert.match(page, /Album \/ 文件合集/);
    assert.match(page, /富文本记录/);
    assert.match(page, /showModal\(\)/);
    assert.match(page, /retrying:'重试中'/);
    assert.doesNotMatch(page, /<input\b/i);
    assert.doesNotMatch(page, /<textarea\b/i);
    assert.doesNotMatch(page, /<progress\b/i);
});
