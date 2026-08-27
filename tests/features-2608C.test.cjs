'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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
    assert.match(page, /5 位短码：<code>\$\{safeShortCode\}<\/code>/);
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
    assert.match(page, /id="tunnelSelect"/);
    assert.match(page, /Number\(row\.desired_enabled\)===1/);
    assert.match(page, /row\.shortCode\|\|'-----'/);
    assert.doesNotMatch(page, /<input\b/i);
    assert.doesNotMatch(page, /<textarea\b/i);
    assert.doesNotMatch(page, /<progress\b/i);
});

test('contact calls and remote preview commands are authenticated state machines', () => {
    assert.match(read('server.js'), /registerMediaHandlers\(socket, \{[\s\S]{0,180}getDeviceId: \(\) => currentDevice \|\| profileDevice/);
    const { registerMediaHandlers, cleanupMediaDevice } = require('../server/media-session');
    class FakeSocket {
        constructor(id) {
            this.id = id;
            this.data = {};
            this.handlers = new Map();
            this.events = [];
        }
        on(event, handler) { this.handlers.set(event, handler); }
        emit(event, payload) { this.events.push({ event, payload }); }
        to() { return { emit() {} }; }
        trigger(event, payload, ack) { return this.handlers.get(event)?.(payload, ack); }
        last(event) { return this.events.filter(entry => entry.event === event).at(-1); }
    }

    const sessionOne = { devices:new Map(), media:null };
    const sessionTwo = { devices:new Map(), media:null };
    const sessions = new Map([['session-0001', sessionOne], ['session-0002', sessionTwo]]);
    const sockets = new Map();
    const identities = new Map();
    const add = (deviceId, sessionId) => {
        const socket = new FakeSocket(`socket-${deviceId}`);
        identities.set(socket, { deviceId, sessionId });
        sessions.get(sessionId).devices.set(deviceId, {});
        sockets.set(deviceId, socket);
        registerMediaHandlers(socket, {
            sessions,
            deviceSockets:sockets,
            getSessionId:() => identities.get(socket).sessionId,
            getDeviceId:() => identities.get(socket).deviceId,
            isValidId:value => /^[a-zA-Z0-9_-]{8,64}$/.test(String(value || '')),
            canUseCapability:() => true,
            historyLog() {},
            clientIp:'127.0.0.1'
        });
        return socket;
    };
    const caller = add('device-caller', 'session-0001');
    const callee = add('device-callee', 'session-0001');
    const outsider = add('device-outside', 'session-0002');

    caller.trigger('contact-call-request', { to:'device-callee', callId:'call-0000001', caller:{ name:'主叫' } });
    assert.equal(callee.last('contact-call-request').payload.caller.name, '主叫');
    outsider.trigger('contact-call-request', { to:'device-callee', callId:'call-0000002', caller:{ name:'第三方' } });
    assert.equal(outsider.last('contact-call-rejected').payload.reason, 'busy');
    callee.trigger('contact-call-accepted', { to:'device-caller', callId:'call-0000001', callee:{ name:'被叫' } });
    assert.equal(caller.last('contact-call-accepted').payload.callee.name, '被叫');
    const beforeForgedSignals = callee.events.filter(entry => entry.event === 'contact-media-signal').length;
    outsider.trigger('contact-media-signal', { to:'device-callee', kind:'contactVoice', sessionKey:'call-0000001', type:'offer', sdp:{} });
    assert.equal(callee.events.filter(entry => entry.event === 'contact-media-signal').length, beforeForgedSignals);
    caller.trigger('contact-media-signal', { to:'device-callee', kind:'contactVoice', sessionKey:'call-0000001', type:'offer', sdp:{} });
    assert.equal(callee.last('contact-media-signal').payload.from, 'device-caller');
    caller.trigger('contact-call-ended', { to:'device-callee', callId:'call-0000001', reason:'ended' });
    assert.equal(callee.last('contact-call-ended').payload.reason, 'ended');

    let crossSessionAck;
    outsider.trigger('remote-preview-cache-check', {
        requestId:'preview-00001', to:'device-callee', fileId:'file-00000001', fileInfo:{ id:'file-00000001', type:'image/png' }
    }, result => { crossSessionAck = result; });
    assert.equal(crossSessionAck.ok, false);

    let checkAck;
    caller.trigger('remote-preview-cache-check', {
        requestId:'preview-00002', to:'device-callee', fileId:'file-00000001', fileInfo:{ id:'file-00000001', name:'图.png', type:'image/png', size:12 }
    }, result => { checkAck = result; });
    assert.equal(checkAck.ok, true);
    assert.equal(callee.last('remote-preview-cache-check').payload.fileInfo.name, '图.png');
    let prematureOpenAck;
    caller.trigger('remote-preview-open', { requestId:'preview-00002', to:'device-callee' }, result => { prematureOpenAck = result; });
    assert.equal(prematureOpenAck.ok, false);
    callee.trigger('remote-preview-cache-result', { requestId:'preview-00002', to:'device-caller', fileId:'file-00000001', available:true });
    assert.equal(caller.last('remote-preview-cache-result').payload.available, true);
    let openAck;
    caller.trigger('remote-preview-open', { requestId:'preview-00002', to:'device-callee' }, result => { openAck = result; });
    assert.equal(openAck.ok, true);
    assert.equal(callee.last('remote-preview-open').payload.fileId, 'file-00000001');
    callee.trigger('remote-preview-open-result', { requestId:'preview-00002', to:'device-caller', ok:true });
    assert.equal(caller.last('remote-preview-open-result').payload.ok, true);
    assert.equal(caller.last('remote-preview-open-result').payload.controlId, 'preview-00002');
    let controlAck;
    caller.trigger('remote-preview-control', { controlId:'preview-00002', to:'device-callee', action:'previous' }, result => { controlAck = result; });
    assert.equal(controlAck.ok, true);
    assert.equal(callee.last('remote-preview-control').payload.action, 'previous');
    let forgedControlAck;
    outsider.trigger('remote-preview-control', { controlId:'preview-00002', to:'device-callee', action:'exit' }, result => { forgedControlAck = result; });
    assert.equal(forgedControlAck.ok, false);
    callee.trigger('remote-preview-control-result', {
        controlId:'preview-00002', to:'device-caller', action:'previous', ok:true,
        fileId:'file-00000003', fileName:'上一张图.png', mediaType:'image/png'
    });
    assert.equal(caller.last('remote-preview-control-result').payload.fileName, '上一张图.png');

    caller.trigger('remote-preview-cache-check', {
        requestId:'preview-00003', to:'device-callee', fileId:'file-00000002', fileInfo:{ id:'file-00000002', name:'第二张图.png', type:'image/png', size:24 }
    });
    callee.trigger('remote-preview-cache-result', { requestId:'preview-00003', to:'device-caller', fileId:'file-00000002', available:true });
    let repeatedOpenAck;
    caller.trigger('remote-preview-open', { requestId:'preview-00003', to:'device-callee' }, result => { repeatedOpenAck = result; });
    assert.equal(repeatedOpenAck.ok, true, 'a completed remote open must not make the target unusable for the next file');
    assert.equal(callee.last('remote-preview-open').payload.fileId, 'file-00000002');
    callee.trigger('remote-preview-open-result', { requestId:'preview-00003', to:'device-caller', ok:true });
    assert.equal(caller.last('remote-preview-open-result').payload.fileId, 'file-00000002');
    assert.equal(caller.last('remote-preview-open-result').payload.controlId, 'preview-00003');
    caller.trigger('remote-preview-control', { controlId:'preview-00003', to:'device-callee', action:'toggle-playback' });
    assert.equal(callee.last('remote-preview-control').payload.action, 'toggle-playback');
    callee.trigger('remote-preview-control-result', {
        controlId:'preview-00003', to:'device-caller', action:'toggle-playback', ok:true,
        fileId:'file-00000002', fileName:'第二张图.png', mediaType:'video/mp4', playing:true
    });
    assert.equal(caller.last('remote-preview-control-result').payload.playing, true);
    caller.trigger('remote-preview-control', { controlId:'preview-00003', to:'device-callee', action:'exit' });
    callee.trigger('remote-preview-control-result', { controlId:'preview-00003', to:'device-caller', action:'exit', ok:true });
    let expiredControlAck;
    caller.trigger('remote-preview-control', { controlId:'preview-00003', to:'device-callee', action:'next' }, result => { expiredControlAck = result; });
    assert.equal(expiredControlAck.ok, false);
    cleanupMediaDevice(sessionOne, 'device-caller', () => {}, () => {});
});

test('preview remote-control UI keeps the command next to music and supports every previewable media type', () => {
    const page = read('pages/index.html');
    const app = read('app.js');
    assertAppearsBefore(page, 'id="filePreviewRemoteBtn"', 'id="filePreviewMusicBtn"', 'remote preview button must sit immediately before music');
    assert.match(page, /id="remotePreviewDeviceModal"/);
    assert.match(app, /hasCompleteFileCache\(storedFile, data\.fileInfo\)/);
    assert.match(app, /clientType !== 'vclient'/);
    assert.match(app, /function isFullscreenPreviewableType\(type\) \{\s*return isPreviewableFileType\(type\);/);
    assert.match(app, /media-fullscreen-audio-card/);
});

test('remote preview picker stays above preview G and repeated commands are idempotent and retryable', () => {
    const page = read('pages/index.html');
    const app = read('app.js');
    const previewZ = Number(page.match(/#filePreviewViewer\s*\{\s*z-index:\s*(\d+)/)?.[1]);
    const pickerZ = Number(page.match(/\.remote-preview-device-layer\s*\{[\s\S]*?z-index:\s*(\d+)/)?.[1]);
    assert.ok(pickerZ > previewZ, `remote picker z-index ${pickerZ} must exceed preview G z-index ${previewZ}`);
    assert.match(page, /<dialog class="remote-preview-device-layer" id="remotePreviewDeviceModal"/);
    assert.match(app, /typeof modal\.showModal === 'function'/);
    assert.match(app, /modal\.showModal\(\)/);

    const pickerOpen = readBlock(app, 'function openRemotePreviewDeviceModal()', 'async function handleRemotePreviewCacheCheck');
    assert.doesNotMatch(pickerOpen, /closeFilePreview|classList\.remove\(['"]active['"]\)/);
    assert.match(pickerOpen, /showRemotePreviewDeviceModal\(\)/);

    const targetOpen = readBlock(app, 'async function handleRemotePreviewOpen(data)', 'function handleRemotePreviewOpenResult');
    assertAppearsBefore(
        targetOpen,
        "currentFullscreenFileId === data.fileId",
        'closeFilePreview({ fromHistory:true, forceClose:true })',
        'the target must acknowledge an already-open file before replacing its active fullscreen'
    );
    assert.doesNotMatch(targetOpen, /closeMediaFullscreen/);
    assert.match(targetOpen, /openActivePreviewFullscreen\(\{ focusedOnly:true/);
    assert.match(app, /entry\.status === 'unavailable' \? '重新检测'/);
    assert.match(app, /setTimeout\(\(\) => beginRemotePreviewCacheCheck\(entry\), 500\)/);
});

test('remote preview control panel exposes authenticated navigation, playback and exit commands', () => {
    const page = read('pages/index.html');
    const app = read('app.js');
    const server = read('server/media-session.js');
    for (const id of [
        'remotePreviewControlPanel', 'remotePreviewControlPrevBtn', 'remotePreviewControlNextBtn',
        'remotePreviewControlPlaybackBtn', 'remotePreviewControlExitBtn'
    ]) assert.match(page, new RegExp(`id="${id}"`));
    assert.match(page, /远程预览控制/);
    assert.match(app, /sendRemotePreviewControl\('previous'\)/);
    assert.match(app, /sendRemotePreviewControl\('next'\)/);
    assert.match(app, /sendRemotePreviewControl\('toggle-playback'\)/);
    assert.match(app, /sendRemotePreviewControl\('exit'\)/);
    assert.match(app, /findRemotePreviewAdjacentItem/);
    assert.match(app, /querySelector\('video, audio'\)/);
    assert.match(server, /REMOTE_PREVIEW_CONTROL_ACTIONS/);
    assert.match(server, /control\.controllerId !== deviceId/);
    assert.match(server, /control\.targetId !== deviceId/);
});

test('remote preview target keeps the same fullscreen open and switches other files through the focused fast path', async () => {
    const app = read('app.js');
    const targetOpen = readBlock(app, 'async function handleRemotePreviewOpen(data)', 'function handleRemotePreviewOpenResult');
    const incomingRemotePreviewRequests = new Map();
    const emitted = [];
    const calls = { close:0, history:0, preview:0, fullscreen:[] };
    const context = vm.createContext({
        incomingRemotePreviewRequests,
        mediaFullscreenItems:[{ fileInfo:{ id:'file-same' } }],
        mediaFullscreenIndex:0,
        document:{ getElementById:() => ({ classList:{ contains:() => true } }) },
        getFromStore:async (_store, fileId) => ({ id:fileId, name:`${fileId}.png`, type:'image/png', size:16, data:new Uint8Array([1]) }),
        materializeCachedFileRecord:async value => value,
        hasCompleteFileCache:() => true,
        isPreviewableFileType:() => true,
        closeFilePreview:() => { calls.close += 1; },
        replaceCurrentHistoryWithoutPreviewLayers:() => { calls.history += 1; },
        openFilePreviewForInfo:async () => { calls.preview += 1; return true; },
        openActivePreviewFullscreen:async options => { calls.fullscreen.push(options); return true; },
        getRemotePreviewFullscreenState:() => ({ fileId:'file-same', fileName:'同一张图.png', mediaType:'image/png', playing:false }),
        activeRemotePreviewControl:null,
        state:{ socket:{ emit:(event, payload) => emitted.push({ event, payload }) } },
        historyLog() {}
    });
    vm.runInContext(`${targetOpen}\nthis.testHandleRemotePreviewOpen = handleRemotePreviewOpen;`, context);

    incomingRemotePreviewRequests.set('request-same', {
        requestId:'request-same', from:'device-controller', fileId:'file-same', fileInfo:{ id:'file-same', type:'image/png', size:16 }
    });
    await context.testHandleRemotePreviewOpen({ requestId:'request-same', from:'device-controller', fileId:'file-same' });
    assert.equal(calls.close, 0, 'an idempotent command must not tear down the current fullscreen');
    assert.equal(calls.preview, 0);
    assert.equal(emitted.at(-1).payload.ok, true);

    incomingRemotePreviewRequests.set('request-other', {
        requestId:'request-other', from:'device-controller', fileId:'file-other', fileInfo:{ id:'file-other', type:'image/png', size:16 }
    });
    await context.testHandleRemotePreviewOpen({ requestId:'request-other', from:'device-controller', fileId:'file-other' });
    assert.equal(calls.close, 1);
    assert.equal(calls.history, 1);
    assert.equal(calls.preview, 1);
    assert.equal(calls.fullscreen.length, 1);
    assert.equal(calls.fullscreen[0].focusedOnly, true, 'remote switching must not scan the whole tunnel history');
    assert.equal(emitted.at(-1).payload.ok, true);
});

test('remote preview target executes navigation, media playback and fullscreen exit controls', async () => {
    const app = read('app.js');
    const targetControl = readBlock(app, 'async function handleRemotePreviewControl(data)', 'function navigateMediaFullscreen(delta)');
    const emitted = [];
    const calls = { render:0, close:0 };
    const media = {
        paused:true,
        ended:false,
        async play() { this.paused = false; },
        pause() { this.paused = true; }
    };
    const nextItem = { fileInfo:{ id:'file-next', name:'下一段.mp4', type:'video/mp4' }, type:'video/mp4' };
    const context = vm.createContext({
        activeRemotePreviewControl:{ controlId:'control-0001', controllerDeviceId:'device-controller', fileId:'file-current' },
        mediaFullscreenItems:[{ fileInfo:{ id:'file-current', name:'当前图片.png', type:'image/png' }, type:'image/png' }],
        mediaFullscreenIndex:0,
        document:{ getElementById:id => id === 'mediaFullscreenViewer'
            ? { classList:{ contains:() => true } }
            : { querySelector:() => media } },
        findRemotePreviewAdjacentItem:async () => nextItem,
        renderMediaFullscreenItem:() => { calls.render += 1; },
        closeMediaFullscreen:() => { calls.close += 1; },
        getRemotePreviewFullscreenState:() => ({ fileId:'file-next', fileName:'下一段.mp4', mediaType:'video/mp4', playing:!media.paused }),
        state:{ socket:{ emit:(event, payload) => emitted.push({ event, payload }) } },
        historyLog() {}
    });
    vm.runInContext(`${targetControl}\nthis.testHandleRemotePreviewControl = handleRemotePreviewControl;`, context);

    await context.testHandleRemotePreviewControl({ controlId:'control-0001', from:'device-controller', action:'next' });
    assert.equal(calls.render, 1);
    assert.equal(emitted.at(-1).payload.fileId, 'file-next');
    assert.equal(emitted.at(-1).payload.ok, true);

    await context.testHandleRemotePreviewControl({ controlId:'control-0001', from:'device-controller', action:'toggle-playback' });
    assert.equal(media.paused, false);
    assert.equal(emitted.at(-1).payload.playing, true);

    await context.testHandleRemotePreviewControl({ controlId:'control-0001', from:'device-controller', action:'exit' });
    assert.equal(calls.close, 1);
    assert.equal(context.activeRemotePreviewControl, null);
    assert.equal(emitted.at(-1).payload.action, 'exit');
});

test('homepage exposes visible global voice-call entries above preview overlays', () => {
    const page = read('pages/index.html');
    const app = read('app.js');
    assert.match(page, /id="deviceVoiceCallBtn"[^>]*>☎ 语音通话</);
    assert.match(page, /\.contact-call-overlay\s*\{[\s\S]*?z-index:\s*10000/);
    const deviceRow = readBlock(app, 'function renderDeviceRow(device, options = {})', 'function renderContacts()');
    assert.match(deviceRow, /voiceButton\.textContent = '☎'/);
    assert.match(deviceRow, /startContactVoiceCall\(normalized\)/);
    const profile = readBlock(app, 'function showDeviceProfile(device, options = {})', 'function closeDeviceProfile()');
    assert.match(profile, /deviceVoiceCallBtn/);
    assert.match(profile, /startContactVoiceCall\(profile\)/);
});
