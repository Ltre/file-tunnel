'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function readBlock(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0, `missing block start: ${startMarker}`);
    assert.ok(end > start, `missing block end: ${endMarker}`);
    return source.slice(start, end);
}

function assertAppearsBefore(source, earlier, later, message) {
    const earlierIndex = source.indexOf(earlier);
    const laterIndex = source.indexOf(later);
    assert.ok(earlierIndex >= 0, `missing earlier operation: ${earlier}`);
    assert.ok(laterIndex >= 0, `missing later operation: ${later}`);
    assert.ok(earlierIndex < laterIndex, message);
}

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

test('audit ledger stays durable without putting synchronous persistence on the live file path', () => {
    const infra = read('server/infra-store.js');
    const server = read('server.js');
    const fileAssets = read('server/file-assets.js');
    const availableHandler = readBlock(
        fileAssets,
        "socket.on('file-asset-available'",
        "socket.on('file-asset-request'"
    );
    const requestHandler = readBlock(
        fileAssets,
        "socket.on('file-asset-request'",
        "socket.on('file-asset-unavailable'"
    );
    const statusHandler = readBlock(
        fileAssets,
        "socket.on('file-asset-transfer-status'",
        "socket.on('file-asset-relay-start'"
    );
    const relayCompleteHandler = readBlock(
        fileAssets,
        "socket.on('file-asset-relay-complete'",
        '\nfunction cleanupFileAssetRelays'
    );

    assert.match(infra, /CREATE TABLE IF NOT EXISTS asset_transfer_events/);
    assert.match(infra, /INSERT OR IGNORE INTO tunnel_members/);
    assert.match(infra, /direct-file:/);
    assert.match(infra, /if \(!existing\) return false/);
    assert.doesNotMatch(infra, /'delete-tombstone'/);
    for (const field of [
        'active_device_count',
        'historical_device_count',
        'transfer_record_count',
        'transfer_file_count',
        'total_file_size'
    ]) assert.match(infra, new RegExp(field));

    assert.match(fileAssets, /const enqueueAudit = typeof context\.enqueueAudit === 'function'/);
    assert.match(fileAssets, /const enqueueAuditTask = task =>/);
    assert.doesNotMatch(availableHandler, /recordTransferEvent|['"]announced['"]/);
    assert.match(availableHandler, /enqueueAuditTask\(\(\) => recordFileAsset/);
    assertAppearsBefore(
        availableHandler,
        "socket.to(sessionId).emit('file-asset-available'",
        'enqueueAuditTask(() => recordFileAsset',
        'provider availability must be broadcast before its metadata audit is queued'
    );

    assert.match(requestHandler, /recordTransferEvent\(sessionId, 'requested'/);
    assertAppearsBefore(
        requestHandler,
        "providerSocket.emit('file-asset-request'",
        'enqueueAuditTask(() => {',
        'the provider request must leave the server before request auditing is queued'
    );

    assert.match(statusHandler, /status === 'completed' \? 'client-completed' : 'failed'/);
    assertAppearsBefore(
        statusHandler,
        "targetSocket.emit('file-asset-transfer-status'",
        'enqueueAuditTask(() => recordTransferEvent',
        'the receiver status must be delivered before terminal auditing is queued'
    );

    assert.match(relayCompleteHandler, /recordTransferEvent\(sessionId, 'relay-completed'/);
    assertAppearsBefore(
        relayCompleteHandler,
        'ackOk(ack);',
        "enqueueAuditTask(() => recordTransferEvent(sessionId, 'relay-completed'",
        'relay completion must be acknowledged before its audit is queued'
    );

    assert.match(server, /function enqueueInfraAudit\(task, key = '', options = \{\}\)/);
    assert.match(server, /INFRA_AUDIT_MAX_ATTEMPTS = 3/);
    assert.match(
        server,
        /registerFileAssetHandlers\(socket, \{[\s\S]*?enqueueAudit: enqueueInfraAudit/
    );
    assert.match(server, /enqueueInfraAudit\(\(\) => infraStore\?\.recordAssetTransferEvent\?\.\(sessionId, 'relay-completed'/);
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
