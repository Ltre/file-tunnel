'use strict';
const { test, before, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), express = require('express');
const { chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const source = fs.readFileSync(path.resolve(__dirname, '../client/browser-logs.js'), 'utf8');
let browser, server, base;
before(async () => {
    const app = express();
    app.get('/case', (req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><script defer src="/logs.js?mode=' + (req.query.mode || 'production') + '"></script>'));
    app.get('/favicon.ico', (_req, res) => res.status(204).end());
    app.get('/logs.js', (req, res) => {
        let code = source;
        if (req.query.mode === 'count') code = code.replace('MAX_ENTRIES = 1000000', 'MAX_ENTRIES = 7');
        if (req.query.mode === 'bytes') code = code.replace('MAX_BYTES = 256 * 1024 * 1024', 'MAX_BYTES = 1800');
        res.type('js').send(code);
    });
    server = await require('./support/listen-http.cjs').listenHttp(app); base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
async function pageFor(t, mode = 'production') {
    const context = await browser.newContext(); t.after(() => context.close());
    const page = await context.newPage(); await page.goto(base + '/case?mode=' + mode); await page.waitForFunction(() => window.BrowserLogs);
    return { page, context };
}
// Read the actual persisted stores without calling flush, which is important
// when inspecting a deliberately aborted transaction.
async function snapshot(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const request = indexedDB.open('TunnelBrowserLogs', 1); request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result, tx = db.transaction(['entries', 'meta']), rows = tx.objectStore('entries').getAll(), stats = tx.objectStore('meta').get('stats');
            tx.oncomplete = () => { db.close(); resolve({ rows: rows.result, stats: stats.result }); }; tx.onabort = () => reject(tx.error);
        };
    }));
}
function coherent(value, maxCount = 1000000, maxBytes = 256 * 1024 * 1024) {
    assert.equal(value.stats.count, value.rows.length);
    assert.equal(value.stats.bytes, value.rows.reduce((sum, row) => sum + row.bytes, 0));
    assert.ok(value.stats.count <= maxCount); assert.ok(value.stats.bytes <= maxBytes);
}

test('production limits remain 256 MiB and one million entries; pending activity keeps recent errors', async t => {
    assert.match(source, /MAX_BYTES = 256 \* 1024 \* 1024, MAX_ENTRIES = 1000000/);
    const { page } = await pageFor(t);
    const found = await page.evaluate(async () => {
        for (let i = 0; i < 200; i++) BrowserLogs.record('operation', 'burst ' + i);
        BrowserLogs.record('error', 'CAONIMA-GPT latest evidence', { accessGrant: 'private-grant', password: 'private-password' });
        for (let i = 200; i < 600; i++) BrowserLogs.record('operation', 'burst ' + i);
        await BrowserLogs.flush();
        return { errors: await BrowserLogs.query({ kind: 'error', keyword: 'CAONIMA-GPT' }), operations: await BrowserLogs.query({ kind: 'operation' }, 300) };
    });
    assert.equal(found.errors.length, 1); assert.doesNotMatch(found.errors[0].message, /private-grant|private-password/);
    assert.equal(found.operations.length, 199); assert.equal(found.operations[0].message, 'burst 599');
    assert.equal(found.operations.some(row => row.message === 'burst 0'), false);
    coherent(await snapshot(page));
});

test('count rotation retires only oldest writes and keeps queries, export and manual deletion coherent', async t => {
    const { page } = await pageFor(t, 'count');
    const result = await page.evaluate(async () => {
        // This is a v1 database populated before the new logger first opens it.
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('TunnelBrowserLogs', 1);
            request.onupgradeneeded = () => { const entries = request.result.createObjectStore('entries', { keyPath: 'id', autoIncrement: true }); entries.createIndex('kindTime', ['kind', 'time']); request.result.createObjectStore('meta'); };
            request.onerror = () => reject(request.error); request.onsuccess = () => {
                const db = request.result, tx = db.transaction(['entries', 'meta'], 'readwrite');
                const row = { kind: 'operation', time: 1, message: 'retained old v1 evidence', sessionId: '', deviceId: '' }; row.bytes = new TextEncoder().encode(JSON.stringify(row)).byteLength;
                tx.objectStore('entries').add(row); tx.objectStore('meta').put({ count: 1, bytes: row.bytes }, 'stats');
                tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
            };
        });
        const old = await BrowserLogs.query({ kind: 'operation', keyword: 'old v1' });
        for (let batch = 0; batch < 4; batch++) { for (let i = batch * 4; i < batch * 4 + 4; i++) BrowserLogs.record(i % 3 ? 'operation' : 'error', 'rolling ' + i); await BrowserLogs.flush(); }
        const operations = await BrowserLogs.query({ kind: 'operation' }), errors = await BrowserLogs.query({ kind: 'error' });
        const exported = (await (await BrowserLogs.exportLogs({ kind: 'operation', keyword: 'rolling' })).text()).trim().split('\n').slice(1).map(JSON.parse);
        const removed = await BrowserLogs.remove({ kind: 'operation', keyword: 'rolling 14' });
        BrowserLogs.record('error', 'rolling newest after removal'); await BrowserLogs.flush();
        return { old, operations, errors, exported, removed, newest: await BrowserLogs.query({ kind: 'error', keyword: 'newest' }) };
    });
    assert.equal(result.old.length, 1, 'upgrading code does not clear the existing database');
    assert.deepEqual([...result.operations, ...result.errors].sort((a, b) => a.id - b.id).map(row => row.message), Array.from({ length: 7 }, (_, i) => 'rolling ' + (i + 9)));
    assert.deepEqual(result.exported.map(row => row.message), result.operations.map(row => row.message));
    assert.equal(result.removed, 1); assert.equal(result.newest.length, 1); coherent(await snapshot(page), 7);
});

test('byte rotation continues accepting new logs while total bytes and mixed-kind counts stay bounded', async t => {
    const { page } = await pageFor(t, 'bytes');
    await page.evaluate(async () => {
        for (let i = 0; i < 8; i++) { for (let n = 0; n < 4; n++) BrowserLogs.record(n % 2 ? 'error' : 'operation', 'byte ' + (i * 4 + n) + ' ' + '中文'.repeat(30)); await BrowserLogs.flush(); }
        BrowserLogs.record('error', 'CAONIMA-GPT retained after byte rotation'); await BrowserLogs.flush();
    });
    const state = await snapshot(page); coherent(state, 1000000, 1800);
    assert.ok(state.rows.length >= 3); assert.equal(state.rows.at(-1).message, 'CAONIMA-GPT retained after byte rotation');
    assert.equal(state.rows.some(row => row.message.startsWith('byte 0 ')), false);
    assert.equal(await page.evaluate(async () => (await BrowserLogs.query({ kind: 'error', keyword: 'CAONIMA-GPT' })).length), 1);
});

test('two tabs serialize eviction and stats updates in the same transaction', async t => {
    const { page, context } = await pageFor(t, 'count'), other = await context.newPage();
    await other.goto(base + '/case?mode=count'); await other.waitForFunction(() => window.BrowserLogs);
    await Promise.all([page, other].map((target, tab) => target.evaluate(async tab => {
        for (let i = 0; i < 5; i++) BrowserLogs.record('operation', 'tab ' + tab + ' item ' + i); await BrowserLogs.flush();
    }, tab)));
    const state = await snapshot(page); coherent(state, 7);
    assert.equal(state.rows.length, 7); assert.ok(state.rows.some(row => row.message === 'tab 0 item 4')); assert.ok(state.rows.some(row => row.message === 'tab 1 item 4'));
});

test('an aborted rotating write preserves old entries and counters, then a later write recovers', async t => {
    const { page } = await pageFor(t, 'count');
    await page.evaluate(async () => { for (let i = 0; i < 7; i++) BrowserLogs.record('operation', 'atomic before ' + i); await BrowserLogs.flush(); });
    const before = await snapshot(page);
    await page.evaluate(async () => {
        const original = IDBObjectStore.prototype.add; let aborted = false;
        IDBObjectStore.prototype.add = function (...args) { const request = original.apply(this, args); if (this.name === 'entries' && !aborted) { aborted = true; request.addEventListener('success', () => this.transaction.abort(), { once: true }); } return request; };
        try { BrowserLogs.record('operation', 'atomic aborted'); await BrowserLogs.flush(); } finally { IDBObjectStore.prototype.add = original; }
    });
    const after = await snapshot(page); coherent(after, 7); assert.deepEqual(after, before);
    await page.evaluate(async () => { BrowserLogs.record('error', 'CAONIMA-GPT atomic recovery'); await BrowserLogs.flush(); });
    const recovered = await snapshot(page); coherent(recovered, 7); assert.equal(recovered.rows.at(-1).message, 'CAONIMA-GPT atomic recovery');
});

test('a browser quota error retires only this log and retries once without touching business caches', async t => {
    const { page } = await pageFor(t);
    const result = await page.evaluate(async () => {
        const business = await caches.open('fixture-business-cache'); await business.put('/retained-business-content', new Response('preserved'));
        for (let i = 0; i < 80; i++) BrowserLogs.record('operation', 'quota old ' + i); await BrowserLogs.flush();
        const original = IDBObjectStore.prototype.add; let attempts = 0;
        IDBObjectStore.prototype.add = function (...args) { if (this.name === 'entries' && ++attempts === 1) throw new DOMException('fixture quota', 'QuotaExceededError'); return original.apply(this, args); };
        try { BrowserLogs.record('error', 'CAONIMA-GPT quota recovery'); await BrowserLogs.flush(); }
        finally { IDBObjectStore.prototype.add = original; }
        return { attempts, content: await (await business.match('/retained-business-content')).text(), retained: await BrowserLogs.query({ kind: 'error', keyword: 'CAONIMA-GPT' }) };
    });
    assert.equal(result.attempts, 2); assert.equal(result.content, 'preserved'); assert.equal(result.retained.length, 1);
    const state = await snapshot(page); coherent(state); assert.ok(state.rows.length > 1 && state.rows.length < 80);
    assert.equal(state.rows.at(-1).message, 'CAONIMA-GPT quota recovery');
});
