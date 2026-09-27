'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const between = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
async function waitUntil(predicate, timeoutMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), 'asynchronous clipboard probe did not settle');
}

test('网页工坊 header 从左到右为草稿箱、手册、最小化、红色关闭，关闭不调用最小化', () => {
    const js = source('client/web-workshop.js');
    const css = source('client/web-workshop.css');
    const header = between(js, "overlay.innerHTML='<header>", "</header><main");
    const positions = ['data-web-home', 'web-workshop-guide-link', 'data-web-minimize', 'data-web-close'].map(item => header.indexOf(item));
    assert.ok(positions.every(position => position >= 0));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    assert.match(js, /querySelector\('\[data-web-close\]'\)\.onclick=\(\)=>close\(\)/);
    assert.match(css, /\.web-workshop-close\{[^}]*background:#c73338/);
});

test('最小化期间发布仍保持隐藏；旧草稿来源关联走更新路径', async () => {
    const code = between(source('client/web-workshop.js'), 'async function publishDraft(', 'async function packageSandbox(');
    const calls = [];
    const draft = { id:'draft-1', name:'我的网页', sourceMessageId:'message-1', sourceFileId:'old-file' };
    const context = vm.createContext({
        clearTimeout() {}, saveTimer:null, editorSession:null, minimized:true,
        commitEditorBuffer() {}, updatePackageManifest() {}, setEditorSaveStatus() {},
        flushEditorDraft:async () => ({ archive:new Uint8Array([1]) }),
        safeName:name => name,
        File:class { constructor(parts, name) { this.parts = parts; this.name = name; } },
        config:{
            publishUpdate:async (_file, received) => { calls.push(`update:${received.sourceMessageId}`); return 'new-file'; },
            publishNew:async () => { calls.push('new'); return 'wrong'; },
            focusFile:id => calls.push(`focus:${id}`), toast:() => {}
        },
        remove:async (store, id) => calls.push(`remove:${store}:${id}`),
        renderHome:async () => calls.push('home'), close:() => calls.push('close'),
        setTimeout, Uint8Array
    });
    vm.runInContext(`${code}\nthis.publishDraft = publishDraft;`, context);
    await context.publishDraft(draft, null);
    assert.ok(calls.includes('update:message-1'));
    assert.ok(calls.includes('home'));
    assert.ok(!calls.includes('new') && !calls.includes('close'));
    assert.equal(context.minimized, true);
});

test('网页 ZIP 更新按消息与版本根标识定位当前文件，拒绝无关替换', async () => {
    const code = between(source('app.js'), 'async function publishWebZipUpdate(', 'function focusPublishedWebZip(');
    const original = { id:'old-file', webZipRootId:'root-file' };
    const current = { id:'current-file', webZipRootId:'root-file', webZipRevision:2, creatorDeviceId:'owner' };
    let message = { id:'message-1', type:'file', fileInfo:current };
    const changes = [];
    const context = vm.createContext({
        getCurrentSessionMessages:async () => [message], getCollectionFiles:() => [],
        canEditWebZip:() => true, generateId:() => 'next-file',
        createFileInfoFromFile:(_file, options) => ({ ...options, id:options.fileId }),
        state:{ deviceId:'owner', deviceName:'owner' },
        storeAndAnnounceFileAsset:async () => {},
        getFromStore:async () => ({ id:'next-file' }),
        materializeCachedFileRecord:async value => value,
        hasCompleteFileCache:() => true,
        updateHistoryMessage:async value => changes.push(value),
        refreshFileMessage:async () => {},
        recentlyPublishedWebZipMessages:new Map(),
        enqueueFileCacheCleanup:() => {},
        Date, JSON, Math
    });
    vm.runInContext(`${code}\nthis.publishUpdate = publishWebZipUpdate;`, context);
    const draft = { sourceMessageId:'message-1', sourceFileId:'old-file', sourceFileInfo:original };
    assert.equal(await context.publishUpdate({ name:'new.html.zip', size:5 }, draft), 'next-file');
    assert.equal(changes[0].fileInfo.replacesFileId, 'current-file');
    message = { id:'message-1', type:'file', fileInfo:{ id:'unrelated-file', webZipRootId:'other-root' } };
    await assert.rejects(context.publishUpdate({ name:'new.html.zip' }, draft), /不相关/);
});

test('迟到的已删除消息不会重新写入或广播', () => {
    const server = source('server.js');
    const addCode = between(server, 'function addToSessionHistory(', 'function calculateSessionHistoryRevision(');
    const context = vm.createContext({ historyLog() {}, summarizeHistoryMessage:() => ({}) });
    vm.runInContext(`${addCode}\nthis.addToSessionHistory = addToSessionHistory;`, context);
    const session = { deletedMessageIds:['deleted-id'], history:[] };
    const result = context.addToSessionHistory('session', session, { id:'deleted-id', type:'file' });
    assert.equal(result.stored, false);
    assert.equal(result.reason, 'deleted-tombstone');
    assert.equal(session.history.length, 0);
    assert.match(server, /if \(historyResult\.reason !== 'deleted-tombstone'\) \{\s*emitToReadableSessionDevices\(session, 'message'/);
    const deletion = between(server, "socket.on('delete-message'", "socket.on('update-message'");
    assert.match(deletion, /session\.deletedMessageIds\.push\(messageId\)/);
    assert.doesNotMatch(deletion, /historyIndex < 0[^\n]*return/);
});

test('先删除后到达的记录在服务重启后仍有持久删除标记', async () => {
    const { createInfraStore } = require('../server/infra-store');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-delete-race-'));
    const sessionId = 'race-session';
    const messageId = '11111111-1111-4111-8111-111111111111';
    try {
        const store = await createInfraStore({ dataDir });
        assert.equal(store.markHistoryDeleted(sessionId, messageId, Date.now(), { allowMissing:true }), true);
        assert.deepEqual(store.listDeletedHistoryIds(sessionId), [messageId]);
        const late = store.recordHistoryMessage(sessionId, { id:messageId, type:'file', fileInfo:{ id:'late-file', size:2 } });
        assert.equal(late.reason, 'deleted-tombstone');
        assert.equal(store.listHistoryRecords(sessionId).length, 0);
        store.flush();
        const reopened = await createInfraStore({ dataDir });
        assert.deepEqual(reopened.listDeletedHistoryIds(sessionId), [messageId]);
        assert.equal(reopened.listHistoryRecords(sessionId).length, 0);
    } finally {
        fs.rmSync(dataDir, { recursive:true, force:true });
    }
});

test('剪贴板忽略 0B 图片，发送后即使刷新也不会再次显示旧图片', async () => {
    const app = source('app.js');
    const extraction = between(app, 'function clipboardImageExtension(', 'function renderClipboardImagePasteArea()');
    const clipboard = between(app, 'function renderClipboardImagePasteArea()', 'function initClipboardImagePaste()');
    class ImageFile extends Blob {
        constructor(parts, name, options) { super(parts, options); this.name = name; this.lastModified = options.lastModified; }
    }
    const storage = new Map();
    let image = new Blob([], { type:'image/png' });
    const sent = [];
    const setup = () => {
        const zone = { hidden:true, disabled:false, setAttribute() {} };
        const context = vm.createContext({
            Blob, File:ImageFile, Uint8Array, Date, crypto:webcrypto,
            navigator:{ clipboard:{ read:async () => [{ types:['image/png'], getType:async () => image }] } },
            window:{ isSecureContext:true },
            document:{ getElementById:id => id === 'pasteImageZone' ? zone : { classList:{ toggle() {} } } },
            state:{ sessionId:'tunnel-1', socket:{ connected:true } },
            localStorage:{ getItem:key => storage.get(key) || null, setItem:(key, value) => storage.set(key, value) },
            requireTunnelPermission:() => true,
            sendSelectedFiles:async files => sent.push(...files),
            showAppToast() {}, historyLog() {}, alert() {}
        });
        vm.runInContext(`
            let pendingClipboardImageFiles = [];
            let clipboardImageAvailable = false;
            let clipboardImageSignature = '';
            let clipboardImageConsumedSignature = '';
            let clipboardImageConsumedSessionId = '';
            let clipboardImagePermissionStatus = null;
            let clipboardImageProbeRunning = false;
            let clipboardImageProbeQueuedSignature = '';
            let clipboardImageSendInProgress = false;
            let clipboardImageReadAllowed = false;
            let clipboardImagePermissionRetryAt = 0;
            let clipboardImageChangeSequence = 0;
            ${extraction}${clipboard}
            this.handleChange = handleClipboardImageChange;
            this.sendPending = sendClipboardImagesToTunnel;
            this.pendingCount = () => pendingClipboardImageFiles.length;
        `, context);
        return { context, zone };
    };
    const first = setup();
    first.context.handleChange({ types:['image/png'], changeId:'zero' });
    await new Promise(setImmediate);
    assert.equal(first.zone.hidden, true);
    assert.equal(first.context.pendingCount(), 0);

    image = new Blob([Uint8Array.from([1, 2, 3])], { type:'image/png' });
    first.context.handleChange({ types:['image/png'], changeId:'valid' });
    await waitUntil(() => !first.zone.hidden);
    assert.equal(first.zone.hidden, false);
    await Promise.all([first.context.sendPending(), first.context.sendPending()]);
    assert.equal(sent.length, 1);
    assert.equal(first.zone.hidden, true);
    assert.match(storage.get('drop2tunnel.clipboard-image-consumed:tunnel-1'), /^image:/);

    const reloaded = setup();
    reloaded.context.handleChange({ types:['image/png'], changeId:'after-refresh' });
    await new Promise(setImmediate);
    assert.equal(reloaded.zone.hidden, true);
    assert.equal(reloaded.context.pendingCount(), 0);
    assert.equal(sent.length, 1);
});
