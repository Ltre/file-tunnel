const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// A transaction-aware IDB fixture: requests finish asynchronously and aborts
// discard staged writes, matching the browser paths used by the cache adapters.
function indexedDatabase() {
    const databases = new Map();
    return { databases, open(name) {
        const request = {};
        queueMicrotask(() => {
            const fresh = !databases.has(name);
            if (fresh) databases.set(name, new Map());
            const stores = databases.get(name);
            request.result = {
                objectStoreNames: { contains: key => stores.has(key) },
                createObjectStore(key) { stores.set(key, new Map()); },
                transaction(key, mode) {
                    const actual = stores.get(key), working = new Map(actual);
                    let pending = 0, aborted = false, timer;
                    const transaction = { error: null, abort() { aborted = true; clearImmediate(timer); queueMicrotask(() => transaction.onabort?.()); }, objectStore() { return {
                        get(id) { return schedule(() => structuredClone(working.get(id))); },
                        getAll() { return schedule(() => [...working.values()].map(value => structuredClone(value))); },
                        put(record) { return schedule(() => { working.set(record.id, structuredClone(record)); }); },
                        delete(id) { return schedule(() => working.delete(id)); }
                    }; } };
                    function schedule(run) {
                        const item = {}; pending++; clearImmediate(timer);
                        queueMicrotask(() => {
                            if (!aborted) { item.result = run(); item.onsuccess?.(); }
                            pending--;
                            if (!pending && !aborted) timer = setImmediate(() => {
                                if (mode === 'readwrite') { actual.clear(); for (const entry of working) actual.set(...entry); }
                                transaction.oncomplete?.();
                            });
                        });
                        return item;
                    }
                    return transaction;
                }
            };
            if (fresh) request.onupgradeneeded?.();
            request.onsuccess?.();
        });
        return request;
    } };
}
function browser(source = 'sns', shared) {
    const idb = shared || indexedDatabase();
    const tasks = new Map();
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const downloads = [], opens = [], lockTails = new Map();
    const context = vm.createContext({ console, setTimeout, clearTimeout, queueMicrotask, URL, Blob, ArrayBuffer, Uint8Array, crypto: crypto.webcrypto,
        navigator: { locks: { request(name, options, callback) {
            if (typeof options === 'function') { callback = options; options = {}; }
            if (options.ifAvailable && lockTails.has(name)) return Promise.resolve().then(() => callback(null));
            const result = (lockTails.get(name) || Promise.resolve()).catch(() => {}).then(() => callback({ name }));
            lockTails.set(name, result);
            result.finally(() => { if (lockTails.get(name) === result) lockTails.delete(name); }).catch(() => {});
            return result;
        } } },
        indexedDB: idb, open: (url, ...options) => { opens.push({ url, options }); return {}; }, confirm: () => true,
        fetch: async url => {
            if (String(url).includes('/api/')) {
                const id = String(url).split('/').pop(), task = tasks.get(id);
                return new Response(task ? JSON.stringify(task) : '{}', { status: task ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
            }
            downloads.push(url); return new Response(bytes, { headers: { 'Content-Length': String(bytes.length), 'Content-Type': 'video/mp4' } });
        }
    });
    context.window = context;
    for (const file of ['cache-store.js', 'sns-download-cache.js', 'youtube-premium-cache.js', 'disk-pending-save.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../client', file), 'utf8'), context);
    }
    const task = { id: 'task-1', completedAt: 1000, outputFileSize: 6, outputFileName: '电影.mp4', status: 'completed', hasFile: true, downloadUrl: '/download/task-1', title: '影片', url: 'https://user:secret@example.com/watch?v=abc&token=secret' };
    tasks.set(task.id, task);
    const factory = source === 'sns' ? context.createSnsDownloadBrowserCache : context.createYoutubePremiumBrowserCache;
    return { idb, tasks, task, source, bytes, context, api: context.DiskPendingSave, cache: factory(), downloads, opens };
}
async function prepare(f) { return f.api.prepare({ source: f.source, task: f.task, cache: f.cache }); }
function hooks(overrides = {}) {
    return { chooseAccount: async () => ({ id: 'account-1' }), chooseTarget: async () => ({ accountId: 'account-1', partitionId: 'part-1', diskSpace: '', path: '资料' }),
        confirm: async () => true, upload: async () => ({ items: [{ id: 'file-1' }] }), ...overrides };
}

test('pending transfer keeps only immutable metadata, pins current complete cache and opens ID-only URL', async () => {
    const f = browser(), record = await prepare(f);
    assert.equal(record.status, 'pending'); assert.equal(record.file.name, '电影.mp4');
    assert.deepEqual([...new Uint8Array(await (await f.api.getBlob(record)).arrayBuffer())], [...f.bytes]);
    assert.equal(record.data, undefined); assert.equal(record.sourceInfo.url, 'https://example.com/watch?v=abc');
    assert.equal(JSON.stringify(record).includes('secret'), false);
    f.api.open(record); assert.equal(f.opens[0].url, '/disk?pendingSave=' + record.id);
    assert.equal((await f.cache.getRecord(f.task.id)).pendingTransferPins[0], record.id);
    assert.equal((await prepare(f)).id, record.id); assert.equal(f.downloads.length, 1);
});

test('pending references survive manual cleanup and orphan sweeps for both source adapters', async () => {
    for (const source of ['sns', 'youtube']) {
        const f = browser(source), record = await prepare(f);
        await assert.rejects(() => f.cache.clear(f.task), /待转存|转存到网盘/);
        assert.equal(await f.cache.cleanupOrphans([]), 0);
        await assert.rejects(() => f.cache.store({ ...f.task, completedAt: 2000 }), /旧版本缓存/);
        assert.equal((await f.api.getBlob(record)).size, 6);
        await f.api.cancel(record.id); assert.equal(await f.cache.cleanupOrphans([]), 1);
    }
});

test('login cancellation and page reload retain record, then resume reaches exactly one committed result', async () => {
    const f = browser(), record = await prepare(f);
    await f.api.resume(record.id, hooks({ chooseAccount: async () => null }));
    assert.equal((await f.api.get(record.id)).status, 'pending');
    const reloaded = browser('sns', f.idb); let uploaded = 0;
    const record2 = await reloaded.api.resume(record.id, hooks({ upload: async (_record, blob, target, metadata) => {
        uploaded++; assert.equal(blob.size, 6); assert.equal(metadata.pendingSaveId, record.id); assert.equal(target.accountId, 'account-1'); return { items: [{ id: 'file-1' }] };
    } }));
    assert.equal(record2.status, 'completed'); assert.equal(uploaded, 1);
    reloaded.tasks.clear(); await reloaded.cache.clear(reloaded.task);
    await reloaded.api.resume(record.id, hooks({ upload: async () => { throw new Error('重复上传'); } }));
    assert.equal((await reloaded.api.get(record.id)).status, 'completed');
});

test('unknown upload outcome is never blindly retried and can recover confirmed completion', async () => {
    const f = browser(), record = await prepare(f); let uploads = 0;
    await assert.rejects(() => f.api.resume(record.id, hooks({ upload: async () => { uploads++; throw new Error('Failed to fetch'); } })), /Failed to fetch/);
    assert.equal((await f.api.get(record.id)).status, 'verification-required');
    await assert.rejects(() => f.api.cancel(record.id), /尚未确认/);
    await f.api.resume(record.id, hooks({ lookup: async () => ({ status: 'running' }), upload: async () => { uploads++; } }));
    assert.equal(uploads, 1);
    await f.api.resume(record.id, hooks({ lookup: async () => ({ status: 'completed', result: { items: [{ id: 'file-1' }] } }), upload: async () => { uploads++; } }));
    assert.equal(uploads, 1); assert.equal((await f.api.get(record.id)).status, 'completed');
    assert.equal((await f.cache.getRecord(f.task.id)).pendingTransferPins.length, 0);
});

test('source version changes do not replace pinned content and cancelled cache refill creates no pending record', async () => {
    const f = browser(), record = await prepare(f);
    f.tasks.set(f.task.id, { ...f.task, completedAt: 3000 });
    await assert.rejects(() => f.api.resume(record.id, hooks()), /来源任务版本已变化/);
    assert.equal((await f.api.get(record.id)).status, 'pending'); assert.equal((await f.api.getBlob(record)).size, 6);
    const fresh = browser();
    assert.equal(await fresh.api.prepare({ source: 'sns', task: fresh.task, cache: fresh.cache, ensureCache: async () => false }), null);
    assert.equal((await fresh.api.list()).length, 0);
});

test('concurrent resume calls share one upload, with fixed target and metadata id', async () => {
    const f = browser(), record = await prepare(f); let uploads = 0;
    const options = hooks({ upload: async () => { uploads++; await new Promise(resolve => setTimeout(resolve, 5)); return { items: [{ id: 'done' }] }; } });
    await Promise.all([f.api.resume(record.id, options), f.api.resume(record.id, options)]);
    assert.equal(uploads, 1); assert.equal((await f.api.get(record.id)).status, 'completed');
});

test('starting a transfer publishes its persisted running state before sending any content', async () => {
    const f = browser(), record = await prepare(f); const events = [];
    await f.api.resume(record.id, hooks({
        onStarted: async current => { events.push('started'); assert.equal((await f.api.get(current.id)).status, 'uploading'); },
        upload: async () => { events.push('content'); return { items: [{ id: 'done' }] }; }
    }));
    assert.deepEqual(events, ['started', 'content']);
});

test('a post-commit navigation error never changes completed outcome or triggers reupload', async () => {
    const f = browser(), record = await prepare(f); let uploads = 0;
    await assert.rejects(() => f.api.resume(record.id, hooks({ upload: async () => { uploads++; return { items: [{ id: 'done' }] }; },
        onCompleted: async () => { throw new Error('页面切换失败'); } })), /页面切换失败/);
    assert.equal((await f.api.get(record.id)).status, 'completed');
    await f.api.resume(record.id, hooks({ upload: async () => { uploads++; } }));
    assert.equal(uploads, 1);
});

test('OPFS source returns a file-backed Blob without full materialization', async () => {
    const f = browser(), file = new Blob([f.bytes]);
    f.context.navigator.storage = { getDirectory: async () => ({ getDirectoryHandle: async name => {
        assert.equal(name, 'drop2tunnel-file-cache'); return { getFileHandle: async name => { assert.equal(name, 'cached.bin'); return { getFile: async () => file }; } };
    } }) };
    await f.cache.writeRecord({ id: f.task.id, version: '1000-6', name: f.task.outputFileName, size: 6, cacheStoreRef: { driver: 'opfs', path: 'cached.bin', complete: true, size: 6 } });
    (await f.cache.cacheStorePromise).materialize = () => { throw new Error('不应复制整个大文件'); };
    assert.equal(await f.cache.getBlob(f.task), file);
});

test('new source caches retain Blob references; pinned reads load legacy bytes only once', async () => {
    for (const source of ['sns', 'youtube']) {
        const f = browser(source), record = await prepare(f);
        assert.ok((await f.cache.getRecord(f.task.id)).data instanceof Blob);
        const store = f.idb.databases.get(source === 'sns' ? 'Drop2TunnelSnsDownloadCache' : 'Drop2TunnelYoutubePremiumCache').get('files');
        const legacy = store.get(f.task.id); store.set(f.task.id, { ...legacy, data: f.bytes.buffer });
        let reads = 0; const original = f.cache.getRecord.bind(f.cache);
        f.cache.getRecord = async id => { reads++; return original(id); };
        const blob = await f.api.getBlob(record);
        assert.equal(reads, 1); assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [...f.bytes]);
        await f.cache.unpin(f.task.id, record.id);
        await assert.rejects(() => f.api.getBlob(record), /缓存不完整/);
    }
});

test('cancel verification and pin release share resume lock and cannot demote a committed upload', async () => {
    const f = browser(), record = await prepare(f); let started;
    const ready = new Promise(resolve => { started = resolve; }); let release;
    const upload = f.api.resume(record.id, hooks({ upload: async () => { started(); await new Promise(resolve => { release = resolve; }); return { items: [{ id: 'done' }] }; } }));
    await ready;
    let verified = 0;
    const cancelled = f.api.cancel(record.id, async () => { verified++; return { status: 'missing', retryable: true }; });
    assert.equal((await f.api.get(record.id)).status, 'uploading');
    assert.equal((await f.cache.getRecord(f.task.id)).pendingTransferPins.length, 1);
    release(); await upload; const result = await cancelled;
    assert.equal(result.status, 'completed'); assert.equal(verified, 0);
    assert.equal((await f.api.get(record.id)).status, 'completed');
});

test('locked cancellation checks unknown outcomes before changing status or releasing cache references', async () => {
    const f = browser(), record = await prepare(f);
    await assert.rejects(() => f.api.resume(record.id, hooks({ upload: async () => { throw Error('Failed to fetch'); } })), /Failed to fetch/);
    await assert.rejects(() => f.api.cancel(record.id, async () => ({ status: 'running' })), /仍在处理/);
    await assert.rejects(() => f.api.cancel(record.id, async () => ({ status: 'missing' })), /尚未确认/);
    assert.equal((await f.api.get(record.id)).status, 'verification-required');
    assert.equal((await f.cache.getRecord(f.task.id)).pendingTransferPins.length, 1);
    const cancelled = await f.api.cancel(record.id, async snapshot => {
        assert.equal(snapshot.target.accountId, 'account-1'); return { status: 'failed', retryable: true };
    });
    assert.equal(cancelled.status, 'cancelled'); assert.equal((await f.cache.getRecord(f.task.id)).pendingTransferPins.length, 0);
    const another = browser(), current = await prepare(another);
    await assert.rejects(() => another.api.resume(current.id, hooks({ upload: async () => { throw Error('Failed to fetch'); } })), /Failed to fetch/);
    const recovered = await another.api.cancel(current.id, async () => ({ status: 'completed', result: { items: [{ id: 'server-done' }] } }));
    assert.equal(recovered.status, 'completed'); assert.equal(recovered.result.items[0].id, 'server-done');
});

test('without Web Locks this page still serializes cancellation with active resume', async () => {
    const f = browser(), record = await prepare(f); delete f.context.navigator.locks;
    let started, release; const ready = new Promise(resolve => { started = resolve; });
    const uploading = f.api.resume(record.id, hooks({ upload: async () => { started(); await new Promise(resolve => { release = resolve; }); return { items: [{ id: 'no-lock-done' }] }; } }));
    await ready;
    let verified = 0; const cancelling = f.api.cancel(record.id, async () => { verified++; return { status: 'missing', retryable: true }; });
    assert.equal((await f.api.get(record.id)).status, 'uploading');
    release(); await uploading;
    assert.equal((await cancelling).status, 'completed'); assert.equal(verified, 0);
    assert.equal((await f.api.get(record.id)).result.items[0].id, 'no-lock-done');
});
