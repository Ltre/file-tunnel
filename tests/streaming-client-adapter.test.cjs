'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture(deps = {}) {
    let markdown, selectedAccount = 'alice'; const calls = [];
    const target = { path: 'chosen', transportContext: { accountId: 'alice', diskSpace: 'private', requestBase: '/api/telegram/drive' } };
    const window = { TunnelMarkdown: { init(value) { markdown = value; } },
        DiskUI: { chooseAccount: async () => ({ id: 'alice' }), chooseSaveDestination: async () => { selectedAccount = 'bob'; return target; } },
        DiskClient: { context: () => ({ accountId: selectedAccount }), upload: async (...args) => { calls.push(args); return { items: [{ id: 'saved' }] }; } },
        StreamingConsole: { whenReady: async () => {}, request: async route => route === '/tunnel-resources' ? { candidates: [{ name: 'a/b.png', source: { sessionId: 'tunnel1', messageId: 'message1', fileId: 'asset1' } }] } : { url: '/media/reference' } } };
    let cancelled = false;
    const context = { window, localStorage: { getItem: () => 'device1' }, Blob,
        fetch: async () => ({ ok: true, headers: new Map([['Content-Length', '100']]), body: { cancel: async () => { cancelled = true; } }, blob: async () => new Blob(['x']) }) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/streaming-app-adapter.js'), 'utf8'), context);
    const adapter = window.StreamingAppAdapter.create({ state: { devices: new Map(), contacts: new Map() },
        listSessions: async () => [{ sessionId: 'tunnel1' }], authorization: () => ({ grant: 'proof' }), ...deps });
    return { markdown, window, calls, target, adapter, runtime: context, cancelled: () => cancelled };
}
test('Markdown save keeps the selected destination identity when the active account changes', async () => {
    const f = fixture(), zip = new Blob(['zip']); await f.markdown.upload(zip);
    assert.equal(f.calls[0][0][0], zip); assert.equal(f.calls[0][1], 'chosen');
    assert.equal(f.calls[0][3].transportContext.accountId, 'alice'); assert.equal(f.calls[0][3].transportContext.diskSpace, 'private');
    f.window.DiskUI.chooseSaveDestination = async () => null;
    await assert.rejects(f.markdown.upload(zip), /SAVE_CANCELLED/); assert.equal(f.calls.length, 1);
});
test('tunnel provider slices cached bytes and consumes only an existing selected server-asset Range', async () => {
    const source = { sessionId: 'tunnel1', messageId: 'message1', fileId: 'asset1' };
    let cached = true;
    const f = fixture({ file: async () => cached ? { data: new Blob(['abcdefghij']) } : null, complete: () => true,
        message: async () => ({ sessionId: 'tunnel1', type: 'file', fileInfo: { id: 'asset1', size: 10, serverAssetUrl: '/api/server-assets/original-asset' } }) });
    assert.equal(await (await f.adapter.readTunnel(source, { start: 3, end: 6 })).text(), 'defg');
    cached = false; let requests = 0;
    f.runtime.fetch = async (url, options) => { requests++; assert.equal(url, '/api/server-assets/original-asset'); assert.equal(options.headers.Range, 'bytes=3-6');
        return { status: 206, headers: new Map([['Content-Range', 'bytes 3-6/10']]), blob: async () => new Blob(['defg']) }; };
    assert.equal(await (await f.adapter.readTunnel(source, { start: 3, end: 6 })).text(), 'defg');
    await assert.rejects(f.adapter.readTunnel({ ...source, sessionId: 'other' }, { start: 3, end: 6 }), /missing/); assert.equal(requests, 1);
});
test('Markdown resources require a local tunnel grant and enforce the remaining archive byte budget', async () => {
    const f = fixture();
    await assert.rejects(f.markdown.readReference('tunnel-blob:other/message1/asset1'), /TUNNEL_DENIED/);
    await assert.rejects(f.markdown.readReference('tunnel-blob:tunnel1/message1/asset1', { maxBytes: 50 }), /REFERENCE_LIMIT/);
    assert.equal(f.cancelled(), true);
    assert.equal((await f.markdown.readReference('tunnel-blob:tunnel1/message1/asset1')).size, 1);
    assert.equal(f.markdown.referenceName('tunnel-blob:tunnel1/message1/asset1'), 'a_b.png');
});
