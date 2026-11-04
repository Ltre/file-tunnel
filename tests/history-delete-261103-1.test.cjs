'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync(require.resolve('../app.js'),'utf8');
function section(a,b){return app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)));}
function fixture(){
    const stored=new Map(),rendered=new Set(),recovery=[];
    const state={sessionId:'tunnel',deviceId:'self',socket:{emit(){}}};
    const context=vm.createContext({state,console,historyLog(){},compareHistoryMessages:()=>0,summarizeHistoryMessage:x=>x,
        deletedHistoryMessageIds:new Map(),pendingHistoryMessageIds:new Set(),activeCollectionPreviewMessageId:null,activeFileDetailsMessageId:null,
        getFromStore:async(_store,id)=>stored.get(id),saveToStore:async(_store,value)=>stored.set(value.id,value),deleteFromStore:async(_store,id)=>stored.delete(id),
        document:{querySelector:selector=>({remove:()=>rendered.delete(selector.match(/data-message-id="([^"]+)/)[1])})},
        cleanupProgressForDeletedFile(){},enqueueFileCacheCleanup(){},getMessageElement:id=>rendered.has(id),
        isAuthoritativeHistoryMessageChanged:()=>false,applyHistoryMessageUpdate:async()=>{},addMessageToChat:async message=>rendered.add(message.id),
        storeInlineFileData:async()=>{},reorderRenderedMessages(){},getCurrentSessionMessages:async()=>[...stored.values()],
        reconcileLocalHistory:async()=>{},pruneLocalHistoryToCanonicalSnapshot:async()=>{},enqueueHistoryAssetRecovery:messages=>recovery.push(...messages)});
    if(app.includes('function isHistoryMessageDeleted('))vm.runInContext(section('function isHistoryMessageDeleted(', 'async function deleteHistoryMessageLocal('),context);
    vm.runInContext(section('async function deleteHistoryMessageLocal(', 'async function findReferencedFileIds(')+section('async function handleSessionHistory(', 'async function getCurrentSessionMessages('),context);
    return {stored,rendered,recovery,context};
}
test('a pre-delete snapshot arriving after a local deletion cannot restore an SNS photo',async()=>{
    const f=fixture(),message={id:'photo',sessionId:'tunnel',type:'file',sender:'sns-server',fileInfo:{id:'asset',isServerAsset:true}};
    f.stored.set(message.id,message);f.rendered.add(message.id);
    await f.context.deleteHistoryMessageLocal(message.id);
    await f.context.handleSessionHistory({sessionId:'tunnel',messages:[message],authoritative:true,deletedMessageIds:[]});
    assert.equal(f.rendered.has(message.id),false);assert.equal(f.stored.has(message.id),false);assert.equal(f.recovery.length,0);
});
test('deleting an as-yet uncached record still protects against its late snapshot',async()=>{
    const f=fixture();await f.context.deleteHistoryMessageLocal('late-photo');
    await f.context.handleSessionHistory({sessionId:'tunnel',messages:[{id:'late-photo',type:'file',fileInfo:{id:'asset'}}]});
    assert.equal(f.stored.size,0);assert.equal(f.rendered.size,0);
});

test('garbage cleanup preserves owned Markdown cache until the Markdown record is deleted', async () => {
    const f = fixture();
    const post = { id: 'post', type: 'markdown', sessionId: 'tunnel', markdownAttachments: [{ id: 'avatar', markdownOwnerId: 'post' }] };
    const avatar = { id: 'avatar', sessionId: 'tunnel', markdownOwnerId: 'post' };
    const orphan = { id: 'orphan', sessionId: 'tunnel' };
    const queued = [];
    f.stored.set(post.id, post);
    Object.assign(f.context, {
        getAllFromStore: async store => store === 'files' ? [avatar, orphan] : [...f.stored.values()],
        getCollectionFiles: () => [],
        fileAssetTransfer: null, deleteCacheStoreReference: async () => {}, releaseStoredFileUrl: () => {},
        enqueueFileCacheCleanup: ids => queued.push(...ids),
        window: {}
    });
    f.context.document.getElementById = () => null;
    vm.runInContext(section('async function findReferencedFileIds(', 'function extractAssetIds(') +
        section('async function findGarbageFileCaches(', 'async function showGarbageCleanupDialog('), f.context);
    assert.deepEqual(Array.from(await f.context.findGarbageFileCaches(), file => file.id), ['orphan']);
    assert.equal((await f.context.findReferencedFileIds(['avatar'])).has('avatar'), true);
    await f.context.deleteHistoryMessageLocal(post.id);
    assert.deepEqual(queued, ['avatar']);
    assert.deepEqual(Array.from(await f.context.findGarbageFileCaches(), file => file.id), ['avatar', 'orphan']);
});

test('the client waits for durable deletion confirmation before clearing local history', async () => {
    let receive, removals = 0;
    const context = vm.createContext({
        state: { sessionId: 'tunnel', socket: { connected: true, timeout() { return this; },
            emitWithAck: () => new Promise(resolve => { receive = resolve; }) } },
        requireTunnelPermission: () => true, confirm: () => true, deleteHistoryMessageLocal: async () => { removals++; }
    });
    vm.runInContext(section('async function deleteHistoryMessage(', 'async function applyHistoryMessageUpdate('), context);
    const pending = context.deleteHistoryMessage('post');
    assert.equal(removals, 0);
    receive({ ok: true });
    await pending;
    assert.equal(removals, 1);
});

test('legacy SNS image deletion accepts the reported ID and persists its tombstone', async t => {
    const os = require('node:os'), path = require('node:path');
    const { createInfraStore } = require('../server/infra-store');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-sns-delete-'));
    const infraStore = await createInfraStore({ dataDir });
    let reopened;
    t.after(() => { (reopened || infraStore).close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const id = 'a5a795b1-f3a2-6606-aab2-f01c392af82b';
    const row = { message: { id, type: 'file', snsAcquisition: { source: 'sns-post-image' } }, size: 10 };
    const session = { devices: new Map([['device', {}]]), history: [row], historySize: 10 };
    infraStore.recordHistoryMessage('tunnel', row.message);
    let handler, pending;
    const context = vm.createContext({
        socket: { on: (_event, callback) => { handler = callback; } },
        currentSession: 'tunnel', currentDevice: 'device', clientIp: '127.0.0.1', sessions: new Map([['tunnel', session]]),
        MAX_HISTORY_MESSAGES: 100, canUseTunnelCapability: () => true, historyLog() {}, console,
        emitToReadableSessionDevices() {}, enqueueInfraAudit: (task, _key, { onSuccess }) => { pending = () => { task(); onSuccess(); }; },
        infraStore
    });
    vm.runInContext(server.slice(server.indexOf('function isValidDeviceId('), server.indexOf('function isValidEditorAsset(')) +
        server.slice(server.indexOf("socket.on('delete-message'"), server.indexOf("socket.on('update-message'")), context);
    let response;
    const remove = (sessionId, messageId) => { response = undefined; handler({ sessionId, messageId }, result => { response = result; }); };
    remove('other-tunnel', id);
    assert.equal(response?.error, 'invalid-session');
    remove('tunnel', 'deadbeef-f3a2-6606-aab2-f01c392af82b');
    assert.equal(response?.error, 'invalid-record');
    remove('tunnel', id);
    assert.equal(response, undefined, 'wait for durable deletion');
    assert.equal(session.history.length, 0);
    pending();
    assert.equal(response?.ok, true);
    assert.deepEqual(infraStore.findDeletedHistoryIds('tunnel', [id]), [id]);
    remove('tunnel', id);
    pending();
    assert.equal(response?.ok, true, 'a retry after a lost acknowledgement succeeds');
    infraStore.close();
    reopened = await createInfraStore({ dataDir });
    assert.equal(reopened.getHistoryMessage('tunnel', id), null);
    assert.equal(reopened.recordHistoryMessage('tunnel', row.message).reason, 'deleted-tombstone');
});

test('SNS reconciliation restores canonical progress and marks an interrupted job as failed', () => {
    const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const running = { id: 'running', type: 'markdown', markdown: '', snsMarkdownRevision: 3,
        snsMarkdownProgress: { stage: 'resources', frameworkReady: true, done: 1, total: 3 } };
    const complete = { id: 'complete', type: 'markdown', markdown: '# Post', snsMarkdownRevision: 5, markdownAttachments: [] };
    const rows = new Map([[running.id, running], [complete.id, complete]]);
    const session = { devices: new Map([['device', {}]]), history: [], deletedMessageIds: [] };
    let reconcile;
    const context = vm.createContext({
        currentSession: 'tunnel', currentDevice: 'device', clientIp: '127.0.0.1', MAX_HISTORY_MESSAGES: 100, MAX_MESSAGE_SIZE: 10000, console,
        socket: { on: (_event, handler) => { reconcile = handler; } }, sessions: new Map([['tunnel', session]]),
        infraStore: { findDeletedHistoryIds: () => [], getHistoryMessage: (_sid, id) => rows.get(id) },
        isValidDeviceId: () => true, getHistoryMessageEntry: (_session, id) => session.history.find(row => row.message.id === id),
        snsPostPublisher: { isRunning: () => false }, canUseTunnelCapability: () => true,
        addToSessionHistory: (_sid, _session, message) => { session.history.push({ message }); return { stored: true }; },
        emitToReadableSessionDevices() {}, resumePendingSnsMetadataScans() {}, historyLog() {}
    });
    vm.runInContext(server.slice(server.indexOf("socket.on('history-reconcile'"), server.indexOf("socket.on('", server.indexOf("socket.on('history-reconcile'") + 1)), context);
    const stale = { type: 'markdown', markdown: '', snsMarkdownRevision: 1, snsMarkdownProgress: { stage: 'inspect' } };
    reconcile({ sessionId: 'tunnel', messages: [{ ...stale, id: 'running' }, { ...stale, id: 'complete' }, { ...stale, id: 'unverified' }] });
    assert.equal(session.history.length, 2);
    assert.equal(session.history[0].message.snsMarkdownRevision, 4);
    assert.equal(session.history[0].message.snsMarkdownProgress.error, 'SNS_POST_INTERRUPTED');
    assert.equal(session.history[0].message.snsMarkdownProgress.done, 1);
    assert.equal(session.history[1].message, complete);
});

test('forwarded Markdown owns independent attachment identities and survives deleting the source group', async t => {
    const os = require('node:os'), path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-forward-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    const source = { id: 'post-a', type: 'markdown', markdown: '![img](tunnel-blob:tunnel-a/post-a/asset-a)',
        markdownAttachments: [{ id: 'asset-a', markdownOwnerId: 'post-a', isServerAsset: true, size: 3 }] };
    const original = { id: 'asset-a', name: 'picture.png', path: path.join(dir, 'asset-a'),
        sessionId: 'tunnel-a', markdownOwnerId: 'post-a', size: 3 };
    fs.writeFileSync(original.path, 'img');
    const assets = new Map([[original.id, original]]);
    const context = vm.createContext({
        fs, path, TELEGRAM_ASSET_DIR: dir, telegramServerAssets: assets,
        getTelegramAssetMetadataPath: id => path.join(dir, id + '.json'),
        resolveTelegramServerAsset: id => assets.get(id), createServerAssetId: () => 'asset-b',
        createServerAssetFileInfo: ({ id, markdownOwnerId }) => ({ id, markdownOwnerId }),
        persistTelegramServerAsset: asset => assets.set(asset.id, asset)
    });
    vm.runInContext(server.slice(server.indexOf('function removeMarkdownAttachmentAssets('),
        server.indexOf('function hydrateTelegramServerAssets(')), context);
    const target = { id: 'post-b' };
    await context.copyMarkdownAttachmentGroup(source, 'tunnel-a', target, 'tunnel-b');
    assert.match(target.markdown, /tunnel-blob:tunnel-b\/post-b\/asset-b/);
    context.removeMarkdownAttachmentAssets('tunnel-a', source.id, source.markdownAttachments);
    assert.equal(fs.existsSync(original.path), false);
    assert.equal(fs.readFileSync(assets.get('asset-b').path, 'utf8'), 'img');
    context.removeMarkdownAttachmentAssets('tunnel-b', target.id, target.markdownAttachments);
    assert.equal(fs.existsSync(path.join(dir, 'asset-b')), false);

    const legacy = { id: 'old-post', type: 'markdown', markdown: '![img](tunnel-blob:tunnel-a/photo-record/asset-a)' };
    delete original.markdownOwnerId;
    fs.writeFileSync(original.path, 'img'); assets.set(original.id, original);
    const legacyPhoto = { id: 'photo-record', type: 'file', fileInfo: { id: 'asset-a', isServerAsset: true, size: 3 } };
    await context.copyMarkdownAttachmentGroup(legacy, 'tunnel-a', target, 'tunnel-b', id => id === legacyPhoto.id && legacyPhoto);
    assert.equal(target.markdownAttachments.length, 1);
    assert.match(target.markdown, /tunnel-blob:tunnel-b\/post-b\/asset-b/);
    fs.rmSync(original.path);
    assert.equal(fs.readFileSync(assets.get('asset-b').path, 'utf8'), 'img');
});
