'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), os = require('node:os'), path = require('node:path');
const { createInfraStore } = require('../server/infra-store');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const section = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

async function fixture(t, type, sourceSessionId = 'source-A') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwarded-server-assets-261117-'));
    const infraStore = await createInfraStore({ dataDir: dir });
    t.after(() => { infraStore.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const file = { id: 'copy-media', name: 'clip.mp4', size: 1024, type: 'video/mp4', isAsset: false,
        isServerAsset: true, serverAssetUrl: '/api/server-assets/source-media', backupSourceSessionId: sourceSessionId, forwardedToSessionId: 'target-B' };
    const message = { id: 'older-copy-record', type, sender: 'forwarder', forwardedFrom: { sessionId: sourceSessionId, messageId: 'source-record' },
        ...(type === 'file' ? { fileInfo: file } : { collection: { files: [file] } }) };
    infraStore.recordHistoryMessage('target-B', message, { source: 'cross-tunnel-forward' });
    const target = { devices: new Map([['target-only-viewer', {}]]), history: [], fileAssets: new Map() };
    const events = [], errors = []; let middleware;
    const gate = { sessions: new Map([['target-B', target]]), infraStore, currentSession: 'target-B', currentDevice: 'target-only-viewer',
        trustedInternalClient: false, canUseTunnelCapability: () => true, tunnelAccess: { verify: () => false, verifyFileForward: () => false },
        socket: { data: {}, use: fn => { middleware = fn; }, to: () => ({ emit() {} }) }, emitSocketError: (name, message) => errors.push({ name, message }) };
    vm.runInNewContext(section(server, 'function canReadForwardedFile(', 'function getSessionPermissionPayload(') +
        section(server, '    socket.use(([event,data],next)=>{', "    socket.on('session-short-code-update'"), gate);
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/file-assets.js'), 'utf8'), {
        window, Blob, ArrayBuffer, Uint8Array, DataView, setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout,
        console: { log() {}, warn() {}, error() {} }
    });
    const transfer = new window.FileAssetTransfer({ getSessionId: () => 'target-B', load: async () => null,
        getTunnelAuthorization: () => null, log() {}, getSocket: () => ({ connected: true, emit: (name, data) => {
            let accepted = false; middleware([name, data], () => { accepted = true; }); events.push({ name, data, accepted });
        } }) });
    const scheduled = [], jobs = [];
    const context = { fileAssetTransfer: transfer, getCollectionFiles: value => value.collection.files,
        getFromStore: async () => null, shouldAutoRequestFileAssetCache: () => true, historyLog() {}, summarizeHistoryMessage: value => value.id,
        scheduleServerAssetRecovery: (metadata, owner, reason) => { scheduled.push({ metadata, owner, reason }); jobs.push(transfer.request(metadata.id, owner, metadata)); } };
    vm.runInNewContext(section(app, 'async function requestMissingFileAssetCache(', 'async function handleMessage('), context);
    return { context, message, file, scheduled, jobs, events, errors, target, transfer, gate, infraStore };
}

for (const type of ['file', 'collection']) test('forwarded SNS ' + type + ' backfill keeps its persisted destination anchor without source membership', async t => {
    const f = await fixture(t, type);
    if (type === 'file') await f.context.requestMissingFileAssetCache(f.message, 'snapshot-background');
    else await f.context.requestMissingCollectionAssetCaches(f.message, 'snapshot-collection-background');
    await Promise.all(f.jobs);
    assert.equal(f.scheduled[0].metadata.recordMessageId, f.message.id);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].data.sourceSessionId, 'source-A');
    assert.equal(f.events[0].data.recordMessageId, f.message.id);
    assert.equal(f.events[0].accepted, true, JSON.stringify(f.errors));
    assert.deepEqual(f.errors, []);
    assert.equal(f.target.devices.size, 1, 'read authorization must not join the private source');
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', 'source-original', f.message.id), false);
    f.infraStore.markHistoryDeleted('target-B', f.message.id);
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', f.file.id, f.message.id), false, 'a deleted copy grants no access');
});

for (const scope of ['messageId', 'collectionMessageId']) test('a forwarded Web ZIP preview carries its ' + scope + ' anchor into cache recovery', async t => {
    const f = await fixture(t, 'file'), jobs = [], seen = [];
    const context = { state: { sessionId: 'target-B' }, filePreviewLoadVersion: 0,
        openWebZipStandalone: (metadata, options) => { seen.push({ metadata, options }); jobs.push(f.transfer.request(metadata.id, 'forwarder', metadata)); return true; } };
    vm.runInNewContext(section(app, 'async function openFilePreviewForInfo(', 'async function openFileRecord('), context);
    assert.equal(await context.openFilePreviewForInfo({ ...f.file, name: 'web.html.zip' }, { [scope]: f.message.id }), true);
    await Promise.all(jobs);
    assert.equal(seen[0].metadata.recordMessageId, f.message.id);
    assert.equal(f.events[0].accepted, true, JSON.stringify(f.errors));
    assert.deepEqual(f.errors, []);
});

test('a twice-forwarded media copy reads its immediate predecessor without granting the original private asset', async t => {
    const f = await fixture(t, 'collection', 'middle-C');
    await f.context.requestMissingCollectionAssetCaches(f.message, 'snapshot-collection-background');
    await Promise.all(f.jobs);
    assert.equal(f.events[0].data.sourceSessionId, 'middle-C');
    assert.equal(f.events[0].accepted, true, JSON.stringify(f.errors));
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'source-A', f.file.id, f.message.id), false);
    assert.equal(f.gate.canReadForwardedFile('target-B', 'target-only-viewer', 'middle-C', 'private-original', f.message.id), false);
    assert.deepEqual(f.errors, []);
});
