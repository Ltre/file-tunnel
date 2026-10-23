'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const read = name => fs.readFileSync(require.resolve('../' + name), 'utf8');

test('history reconciliation restores old Markdown alongside other records without reviving tombstones', () => {
    const source = read('server.js'), start = source.indexOf("    socket.on('history-reconcile'");
    const session = { devices: new Map([['device', {}]]), history: [], deletedMessageIds: ['removed'] };
    let reconcile, snapshot;
    vm.runInNewContext(source.slice(start, source.indexOf("    socket.on('session-history-ack'", start)), {
        socket: { id: 'socket', on: (_name, handler) => { reconcile = handler; } }, currentSession: 'tunnel', currentDevice: 'device',
        sessions: new Map([['tunnel', session]]), MAX_HISTORY_MESSAGES: 5000, MAX_MESSAGE_SIZE: 1000000,
        isValidDeviceId: value => typeof value === 'string', infraStore: { findDeletedHistoryIds: () => [] }, clientIp: 'test',
        canUseTunnelCapability: (_s, _d, operation) => operation === 'read',
        addToSessionHistory: (_id, target, message) => { target.history.push({ message }); return { stored: true }; },
        resumePendingSnsMetadataScans() {}, emitToReadableSessionDevices: (_s, _event, payload) => { snapshot = payload; }, historyLog() {}, console
    });
    reconcile({ sessionId: 'tunnel', messages: [{ id: 'old', type: 'markdown', markdown: '旧记录\n第二行' }, { id: 'removed', type: 'markdown', markdown: 'deleted' }, { id: 'text', type: 'text', text: 'ok' }] });
    assert.deepEqual(Array.from(snapshot.messages, item => item.id), ['old', 'text']);
});

function notifications(storage = new Map()) {
    const window = {}, runtime = { window, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, document: { querySelectorAll: () => [] } };
    vm.runInNewContext(read('client/notification-center.js'), runtime);
    return { api: window.NotificationCenter, storage };
}
test('refreshing the same invitation preserves its persisted read state', () => {
    const f = notifications(), notice = { id: 'stream:invite', type: 'stream-invitation', resolved: 'revoked', createdAt: 1 };
    f.api.add(notice);
    f.storage.set('tunnelDeviceNotifications:v1:local', JSON.stringify([{ ...notice, read: true }]));
    const reloaded = notifications(f.storage); reloaded.api.add(notice);
    assert.equal(reloaded.api.list()[0].read, true);
});
test('Markdown without tunnel resources exports directly as md even with external links', async () => {
    let zipped = 0; const window = { FolderArchive: { createZip: async () => { zipped++; return new Blob(['zip']); } } };
    vm.runInNewContext(read('client/tunnel-markdown.js'), { window, Blob, File, URL });
    const markdown = '# 标题\n[外链](https://example.com/)';
    const result = await window.TunnelMarkdown.archive({ id: 'record', markdown });
    assert.equal(result.type, 'text/markdown'); assert.match(result.name, /\.md$/); assert.equal(await result.text(), markdown); assert.equal(zipped, 0);
});
test('cleared invitations remain dismissed after reload but a changed state can notify again', () => {
    const f = notifications(), notice = { id: 'stream:invite', type: 'stream-invitation', body: '已撤销', resolved: 'revoked', createdAt: 1 };
    f.storage.set('tunnelDeviceNotifications:v1:local', JSON.stringify([{ ...notice, read: true }])); f.api.clearRead();
    const reloaded = notifications(f.storage); reloaded.api.add(notice); assert.equal(reloaded.api.list().length, 0);
    reloaded.api.add({ ...notice, body: '待处理', resolved: '' }); assert.equal(reloaded.api.list().length, 1); assert.equal(reloaded.api.list()[0].read, false);
});
test('Markdown edit records revisions and rejects stale saves without losing either version', () => {
    const { editMarkdownRecord } = require('../server/markdown-records');
    const original = { id: 'record', type: 'markdown', markdown: '第一行\n第二行', timestamp: 1, sender: 'A' };
    const args = { baseVersion: 1, content: '新第一行\n第二行', deviceId: 'B', deviceName: '乙', maxBytes: 10000, now: 2 };
    const saved = editMarkdownRecord(original, args); assert.equal(saved.ok, true); assert.equal(saved.message.markdownVersion, 2);
    assert.equal(saved.message.markdownHistory[0].content, original.markdown); assert.equal(saved.message.markdownHistory[1].editorDeviceId, 'B');
    const conflict = editMarkdownRecord(saved.message, { ...args, content: '丙的修改' }); assert.equal(conflict.conflict, true); assert.equal(conflict.message, saved.message);
    assert.equal(editMarkdownRecord(original, { ...args, maxBytes: 1 }).error, 'content-too-large');
});
test('real bundled Markdown parser keeps ordinary newlines as visible line breaks', () => {
    const window = { DOMPurify: { sanitize: value => value } }, context = vm.createContext({ window, Blob, File, URL });
    vm.runInContext(read('client/vendor/web-markdown/marked-18.0.14.umd.js'), context); window.marked = context.marked;
    vm.runInContext(read('client/tunnel-markdown.js'), context);
    const target = { innerHTML: '', querySelectorAll: () => [] }; window.TunnelMarkdown.render(target, '第一行\n第二行\n第三行');
    assert.equal((target.innerHTML.match(/<br\s*\/?>/g) || []).length, 2);
});
test('the plain-text fallback preserves line breaks when Markdown dependencies are unavailable', () => {
    const window = {}, classes = new Map(); vm.runInNewContext(read('client/tunnel-markdown.js'), { window });
    const target = { textContent: '', classList: { toggle: (name, value) => classes.set(name, value) } };
    window.TunnelMarkdown.render(target, '第一行\n第二行'); assert.equal(target.textContent, '第一行\n第二行'); assert.equal(classes.get('sc-markdown-plain'), true);
});
test('opening an invitation intercepts navigation and leaves the original URL intact', () => {
    let click, opened, prevented = false; const location = { href: 'http://lan/?record=existing#tunnel', origin: 'http://lan' };
    const anchor = { href: '/?stream_invite=token', getAttribute() { return this.href; }, addEventListener: (_name, handler) => { click = handler; } };
    const window = { DOMPurify: { sanitize: value => value }, marked: { parse: () => '<a>邀请</a>' }, StreamingConsole: { openInvitation: token => { opened = token; } } };
    vm.runInNewContext(read('client/tunnel-markdown.js'), { window, location, URL });
    window.TunnelMarkdown.render({ querySelectorAll: selector => selector === 'a' ? [anchor] : [] }, 'invite');
    click({ button: 0, preventDefault() { prevented = true; } }); assert.equal(prevented, true); assert.equal(opened, 'token'); assert.equal(location.href, 'http://lan/?record=existing#tunnel');
    anchor.href = null; location.href = 'http://lan/?stream_invite=other'; prevented = false; opened = undefined;
    click({ button: 0, preventDefault() { prevented = true; } }); assert.equal(prevented, false); assert.equal(opened, undefined);
});
test('ticket read-ahead is bounded, expires, and cannot be reused across viewers', () => {
    const { createStreamingBuffer } = require('../server/streaming-buffer'); let now = 0;
    const buffer = createStreamingBuffer({ now: () => now, maxBytes: 12, perTicket: 8, ttl: 10 });
    buffer.put('A', 0, Buffer.from('12345678')); assert.equal(buffer.get('A', 2, 4).toString(), '345'); assert.equal(buffer.get('B', 2, 4), null);
    buffer.put('A', 8, Buffer.from('abcdefgh')); assert.equal(buffer.get('A', 0, 1), null); assert.equal(buffer.bytes, 8);
    buffer.put('B', 0, Buffer.from('zzzzzzzz')); assert.ok(buffer.bytes <= 12); now = 11; assert.equal(buffer.bytes, 0);
});
test('a direct station or invitation entry resumes the existing home tunnel and retains its destination', async () => {
    const source = read('app.js'), start = source.indexOf('async function initSession()');
    for (const query of ['stream=station', 'stream_invite=invitation']) {
        const changes = [], state = {}, recent = { sessionId: 'saved-tunnel', shortCode: 'ABCDE', lastActive: 1, remark: '已加入隧道' };
        const context = vm.createContext({ state, localStorage: { getItem: () => 'device', setItem() {} }, navigator: { userAgent: 'test' }, URL,
            window: { location: { href: 'http://lan/?' + query } }, history: { replaceState: (_a, _b, url) => changes.push(url) },
            detectDeviceModel: () => 'test', generateId: () => 'generated', readSessionDirectoryCache: () => [recent], countFromStore: async () => 0,
            normalizeLocalShortCode: value => value || '', tunnelDeviceId: () => 'device', updateSessionIdentityUi() {} });
        vm.runInContext(source.slice(start, source.indexOf('function normalizeLocalShortCode(', start)), context);
        assert.equal(await context.initSession(), true); assert.equal(state.sessionId, 'saved-tunnel'); assert.ok(changes[0].includes(query));
    }
});
test('a streaming entry without a joined tunnel initializes the real home UI without joining or loading another tunnel', async () => {
    const source = read('app.js'), start = source.indexOf('async function startTunnelApplication('), calls = [];
    const nodes = new Map(['sessionLanding', 'appShell', 'tunnelTopbar', 'leaveTunnelBtn', 'mobileForceRefreshBtn'].map(id => [id, { hidden: true, removeAttribute() { this.hidden = false; } }]));
    const context = vm.createContext({ document: { getElementById: id => nodes.get(id) }, runStartupStage: async (_label, run) => run(),
        ...Object.fromEntries(['initFileAssetTransfer','initMediaController','initUI','initEditor','initDragDrop','initClipboardImagePaste','restoreMusicPlayerState','loadContacts','loadSessionData','initSocket','initAssetPresenceRefresh','ensureHomeHistoryGuard','initLandingNearbyPresence','applyTunnelPermissionUi'].map(name => [name, () => calls.push(name)])),
        markStartupShellReady() {}, handlePendingRecordNavigation: async () => {}, handlePendingDeviceCallOrIntercom: async () => {}, historyLog() {} });
    const startHome = vm.runInContext('(' + source.slice(start, source.indexOf('function registerServiceWorker(', start)) + ')', context);
    await startHome({ joined: false }); assert.equal(nodes.get('appShell').hidden, false); assert.ok(calls.includes('initUI')); assert.ok(calls.includes('initEditor'));
    assert.ok(!calls.includes('initSocket')); assert.ok(!calls.includes('loadSessionData')); assert.equal(nodes.get('leaveTunnelBtn').hidden, true);
});
test('invitation links enter viewing directly through the verified grant without an accept or reject dialog', async () => {
    const source = read('client/streaming-console.js'), start = source.indexOf('    async function inspectInvitation('), calls = [];
    const context = vm.createContext({ URL, location: { origin: 'http://fixture' },
        request: async (route, method, body) => { calls.push({ route, method, body }); return { stationId: 'station' }; }, closeDialog() {}, open: async () => {},
        navigate: (view, id) => calls.push({ view, id }), sync: async () => {}, showDialog() { throw Error('interstitial must not open'); } });
    const inspect = vm.runInContext('(' + source.slice(start, source.indexOf('    async function notification(', start)).trim() + ')', context);
    await inspect('http://fixture/?stream_invite=token%20');
    assert.equal(calls[0].route, '/invitations/token'); assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].body.decision, 'accept');
    assert.deepEqual(calls[1], { view: 'watch', id: 'station' });
});
test('Markdown socket edits enforce tunnel membership, permissions, and version conflicts', () => {
    const source = read('server.js'), start = source.indexOf("    socket.on('markdown-message-edit'"); let edit, response, broadcasts = 0, allowed = false;
    const message = { id: 'record', type: 'markdown', markdown: 'v1', sender: 'A' }, size = Buffer.byteLength(JSON.stringify(message));
    const session = { devices: new Map([['device', { deviceName: '乙' }]]), history: [{ message, size }], historySize: size };
    vm.runInNewContext(source.slice(start, source.indexOf("    socket.on('history-reconcile'", start)), {
        socket: { on: (_event, handler) => { edit = handler; } }, sessions: new Map([['tunnel', session]]), currentSession: 'tunnel', currentDevice: 'device',
        Buffer, MAX_EDITOR_CONTENT_SIZE: 200000, MAX_MESSAGE_SIZE: 1000000, MAX_HISTORY_SIZE: 5000000, canUseTunnelCapability: () => allowed,
        editMarkdownRecord: require('../server/markdown-records').editMarkdownRecord, createHistoryMessage: value => value, persistHistoryAudit() {},
        emitToReadableSessionDevices() { broadcasts++; }, scheduleSessionHistoryBroadcast() {}, console });
    const request = { sessionId: 'tunnel', messageId: 'record', baseVersion: 1, content: 'v2' }, ack = value => { response = value; };
    edit(request, ack); assert.equal(response.error, 'permission-denied'); assert.equal(session.history[0].message.markdown, 'v1');
    allowed = true; edit(request, ack); assert.equal(response.ok, true); assert.equal(session.history[0].message.markdownVersion, 2); assert.equal(broadcasts, 1);
    edit({ ...request, content: 'stale' }, ack); assert.equal(response.conflict, true); assert.equal(broadcasts, 1);
});
test('later Markdown history can extend a restored older record without a stale client erasing it', () => {
    const source = read('server.js'), start = source.indexOf("    socket.on('history-reconcile'"); let reconcile, snapshot, allowed = true;
    const old = { id: 'record', type: 'markdown', markdown: 'v1', sender: 'A', timestamp: 1 }, size = Buffer.byteLength(JSON.stringify(old));
    const newer = require('../server/markdown-records').editMarkdownRecord(old, { content: 'v2', baseVersion: 1, deviceId: 'B', maxBytes: 10000, now: 2 }).message;
    const session = { devices: new Map([['device', {}]]), history: [{ message: old, size }], historySize: size, deletedMessageIds: [] };
    vm.runInNewContext(source.slice(start, source.indexOf("    socket.on('session-history-ack'", start)), {
        socket: { id: 'socket', on: (_event, handler) => { reconcile = handler; } }, sessions: new Map([['tunnel', session]]), currentSession: 'tunnel', currentDevice: 'device',
        MAX_HISTORY_MESSAGES: 5000, MAX_MESSAGE_SIZE: 1000000, MAX_HISTORY_SIZE: 5000000, Buffer, clientIp: 'test', infraStore: {}, isValidDeviceId: value => typeof value === 'string',
        canUseTunnelCapability: (_s, _d, operation) => operation === 'read' || allowed, recoverMarkdownRecord: require('../server/markdown-records').recoverMarkdownRecord, persistHistoryAudit() {},
        addToSessionHistory: () => ({ stored: false }), resumePendingSnsMetadataScans() {}, emitToReadableSessionDevices: (_s, _name, data) => { snapshot = data; }, historyLog() {}, console });
    reconcile({ sessionId: 'tunnel', messages: [newer] }); assert.equal(snapshot.messages[0].markdown, 'v2');
    reconcile({ sessionId: 'tunnel', messages: [old] }); assert.equal(snapshot.messages[0].markdown, 'v2');
    allowed = false; const third = require('../server/markdown-records').editMarkdownRecord(newer, { content: 'v3', baseVersion: 2, deviceId: 'B', maxBytes: 10000 }).message;
    reconcile({ sessionId: 'tunnel', messages: [third] }); assert.equal(snapshot.messages[0].markdown, 'v2');
    assert.equal(require('../server/markdown-records').recoverMarkdownRecord(old, { ...newer, sender: 'forged' }), null);
});
