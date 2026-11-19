'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createUpstreamExits } = require('../server/upstream-exits');
const { createDiskTelegram } = require('../server/disk-telegram');
const { openDiskRepository } = require('../server/disk-repository');
const { createFixture } = require('./support/disk-content-admin-fixture.cjs');

async function fixture(t, configured) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-admin-exit-'));
    const bytes = Buffer.from('shared-fixture'), requests = [];
    const exits = createUpstreamExits({ dataDir: dir, log() {}, nativeFetch: async (url, init) => {
        requests.push({ url: String(url), range: init?.headers?.Range, route: exits.current()?.selected?.id });
        if (String(url).endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'fixture.txt', file_size: bytes.length } });
        if (String(url).endsWith('/fixture.txt')) return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
        throw Error('UNEXPECTED_TEST_NETWORK');
    } });
    if (configured) exits.saveService('telegram', { revision: 0, defaultExit: 'direct', mode: 'ordered', order: [], includeDirect: false });
    t.after(async () => { await exits.close(); openDiskRepository(dir).close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const original = createDiskTelegram({ dataDir: dir, fetchImpl: exits.fetch });
    const telegram = exits.wrapService('telegram', original);
    const f = await createFixture({ telegram });
    t.after(() => f.close());
    f.api.spaces.get('').update('alice', 'file-a', { name: '预览.txt', type: 'text/plain' });
    const get = (id = 'file-a', space = '', user = 'alice', headers = {}) => fetch(f.base + '/api/telegram/disk-admin/files/' + id + '/download?' + new URLSearchParams({ user_id: user, disk_space: space }), { headers: { 'X-Test-Admin': '1', ...headers } });
    return { ...f, original, telegram, exits, bytes, requests, get };
}

for (const configured of [false, true]) test(`admin TXT/full and named-partition reads retain bytes through Telegram exit adapter (configured=${configured})`, async t => {
    const f = await fixture(t, configured);
    const response = await f.get();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Disposition'), /^inline;/);
    assert.match(response.headers.get('Content-Type'), /^text\/plain/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
    const named = await f.get('file-photo', '相册&照片');
    assert.equal(named.status, 200);
    assert.deepEqual(Buffer.from(await named.arrayBuffer()), f.bytes);
    assert.ok(f.requests.some(item => item.url.endsWith('/getFile')));
    assert.ok(f.requests.some(item => item.url.endsWith('/fixture.txt')));
    if (configured) assert.ok(f.requests.every(item => item.route === 'direct'));
});

test('admin Range, HEAD, owner/partition and review rules survive wrapped Telegram reads', async t => {
    const f = await fixture(t, true);
    const range = await f.get('file-a', '', 'alice', { Range: 'bytes=2-5' });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('Content-Range'), `bytes 2-5/${f.bytes.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), f.bytes.subarray(2, 6));
    const invalid = await f.get('file-a', '', 'alice', { Range: 'bytes=200-300' });
    assert.equal(invalid.status, 416); await invalid.arrayBuffer();
    const wrongUser = await f.get('file-a', '', 'bob');
    assert.equal(wrongUser.status, 404); await wrongUser.arrayBuffer();
    const wrongSpace = await f.get('file-a', '相册&照片');
    assert.equal(wrongSpace.status, 404); await wrongSpace.arrayBuffer();
    const reviewed = await f.get('audit-marker');
    assert.equal(reviewed.status, 410); await reviewed.arrayBuffer();
    const denied = await fetch(f.base + '/api/telegram/disk-admin/files/file-a/download?user_id=alice&disk_space=');
    assert.equal(denied.status, 401); await denied.arrayBuffer();
    const head = await fetch(f.base + '/api/telegram/disk-admin/files/file-a/download?user_id=alice&disk_space=', { method: 'HEAD', headers: { 'X-Test-Admin': '1' } });
    assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('Telegram synchronous part validation and guard setup preserve return and throw contracts', async t => {
    const f = await fixture(t, false);
    const item = { id: 'synchronous', size: 3, fileId: 'fixture', messageId: 9 };
    assert.deepEqual(f.telegram.parts(item), f.original.parts(item));
    assert.throws(() => f.telegram.parts({ ...item, size: -1 }), /TELEGRAM_PARTS_INVALID/);
    assert.equal(f.telegram.setAnchorGuard(() => false), undefined);
    await assert.rejects(f.telegram.remove({ token: 'fixture', channelId: '-1001', baseUrl: 'https://api.telegram.org' }, item), /CONTENT_ANCHOR_IN_USE/);
});

test('all actual async Telegram operations retain scope; local accessors, symbols and this remain synchronous', async t => {
    const f = await fixture(t, false), key = Symbol('local'), marker = Error('local-guard');
    const local = { value: 17, parts() { return this.value; }, setAnchorGuard() { throw marker; },
        get label() { return this.value; }, [key]() { return this.value; } };
    const wrapped = f.exits.wrapService('telegram', local);
    assert.equal(wrapped.parts(), 17);
    assert.equal(wrapped.parts, wrapped.parts);
    assert.equal(wrapped.label, 17);
    assert.equal(wrapped[key](), 17);
    assert.throws(() => wrapped.setAnchorGuard(), error => error === marker);
    const remote = {};
    for (const [name, value] of Object.entries(f.original)) if (typeof value === 'function' && value.constructor.name === 'AsyncFunction') {
        remote[name] = function () { assert.equal(this, remote); assert.equal(f.exits.current()?.service, 'telegram'); return Promise.resolve(name); };
    }
    const routed = f.exits.wrapService('telegram', remote);
    for (const name of Object.keys(remote)) assert.equal(await routed[name](), name);
});
