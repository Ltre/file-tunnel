'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');

function indexedDatabase() {
    const databases = new Map();
    return { databases, open(name) {
        const request = {};
        queueMicrotask(() => {
            const fresh = !databases.has(name); if (fresh) databases.set(name, new Map()); const stores = databases.get(name);
            request.result = { createObjectStore: key => stores.set(key, new Map()), transaction(key, mode) {
                const actual = stores.get(key), working = new Map(actual); let pending = 0, timer;
                const transaction = { objectStore: () => ({ get: id => schedule(() => working.get(id)), getAll: () => schedule(() => [...working.values()]), put: item => schedule(() => working.set(item.id, structuredClone(item))) }) };
                function schedule(run) { const item = {}; pending++; clearImmediate(timer); queueMicrotask(() => { item.result = structuredClone(run()); item.onsuccess?.(); if (!--pending) timer = setImmediate(() => { if (mode === 'readwrite') { actual.clear(); for (const entry of working) actual.set(...entry); } transaction.oncomplete?.(); }); }); return item; }
                return transaction;
            } };
            if (fresh) request.onupgradeneeded?.(); request.onsuccess?.();
        }); return request;
    } };
}
function browser(shared = indexedDatabase()) {
    const task = { id: 'task', completedAt: 1000, outputFileSize: 3, outputFileName: '视频.mp4', status: 'completed', hasFile: true };
    let source = task; const urls = [], locks = new Map();
    const context = { URL, crypto: crypto.webcrypto, indexedDB: shared,
        navigator: { locks: { request(name, action) { const next = (locks.get(name) || Promise.resolve()).catch(() => {}).then(action); locks.set(name, next); return next; } } },
        createSnsDownloadBrowserCache() { throw Error('browser cache must not be used'); },
        createYoutubePremiumBrowserCache() { throw Error('browser cache must not be used'); },
        fetch: async url => { urls.push(url); return { ok: true, status: 200, json: async () => source }; }
    };
    context.window = context; vm.runInNewContext(fs.readFileSync('client/disk-pending-save.js', 'utf8'), context);
    return { api: context.DiskPendingSave, task, urls, idb: shared, changeSource: next => source = next };
}
const hooks = changes => ({ chooseAccount: async () => ({ id: 'account' }), chooseTarget: async () => ({ accountId: 'account', partitionId: 'part', diskSpace: '', path: '' }), confirm: async () => true,
    transferServer: async () => ({ items: [{ id: 'file' }] }), upload: async () => { throw Error('browser upload must not be used'); }, ...changes });

test('new pending transfers persist metadata, survive reload and submit no browser file/cache operations', async () => {
    for (const source of ['sns', 'youtube']) {
        const f = browser(), record = await f.api.prepareServer({ source, task: f.task });
        assert.equal(record.transferMode, 'server'); assert.equal(record.cache, undefined); assert.equal(record.data, undefined);
        assert.equal((await f.api.prepareServer({ source, task: f.task })).id, record.id);
        const restored = browser(f.idb); let transfers = 0;
        await restored.api.resume(record.id, hooks({ transferServer: async (value, target) => { transfers++; assert.equal(value.version, '1000-3'); assert.equal(target.accountId, 'account'); return { items: [{ id: 'done' }] }; } }));
        await restored.api.resume(record.id, hooks({ transferServer: async () => { throw Error('duplicate server transfer'); } }));
        assert.equal(transfers, 1); assert.equal((await restored.api.get(record.id)).status, 'completed');
        assert.ok([...f.urls, ...restored.urls].every(url => /\/tasks\/task$/.test(url)));
        assert.equal(f.idb.databases.size, 1, 'only the pending metadata database may be created');
    }
});

test('login cancellation retains a server transfer and unknown outcomes are queried before resubmission', async () => {
    const f = browser(), record = await f.api.prepareServer({ source: 'sns', task: f.task }); let transfers = 0;
    await f.api.resume(record.id, hooks({ chooseAccount: async () => null })); assert.equal((await f.api.get(record.id)).status, 'pending');
    await assert.rejects(() => f.api.resume(record.id, hooks({ transferServer: async () => { transfers++; throw Error('connection-lost'); } })), /connection-lost/);
    await assert.rejects(() => f.api.cancel(record.id), /尚未确认/);
    await f.api.resume(record.id, hooks({ lookup: async () => ({ status: 'processing' }) })); assert.equal(transfers, 1);
    await f.api.resume(record.id, hooks({ lookup: async () => ({ status: 'completed', result: { items: [{ id: 'done' }] } }), transferServer: async () => { throw Error('must not repeat'); } }));
    assert.equal((await f.api.get(record.id)).status, 'completed');
});

test('legacy cache records migrate after outcome confirmation and never retry by uploading cached bytes', async () => {
    const f = browser(); let unpins = 0, transfers = 0;
    const cache = { inspect: async () => ({ status: 'cached' }), pin: async () => ({ id: 'task', name: '视频.mp4', size: 3, type: 'video/mp4', version: '1000-3' }), unpin: async () => { if (++unpins === 1) throw Error('pin-release-failed'); }, getBlob() { throw Error('must not read legacy cached bytes'); } };
    const record = await f.api.prepare({ source: 'sns', task: f.task, cache });
    await f.api.update(record.id, { status: 'uploading' });
    await f.api.resume(record.id, hooks({ lookup: async () => ({ status: 'processing' }) })); assert.equal(unpins, 0);
    let serverId;
    await assert.rejects(() => f.api.resume(record.id, hooks({ lookup: async () => ({ status: 'failed', retryable: true }), transferServer: async value => { transfers++; serverId=value.serverTransferId; assert.notEqual(serverId, record.id); throw Error('lost-receipt'); } })), /lost-receipt/);
    assert.equal(unpins, 0, 'old cache stays pinned while the new transfer outcome is unknown');
    await assert.rejects(() => f.api.resume(record.id, hooks({ lookup: async value => { assert.equal(value.serverTransferId, serverId); return { status: 'completed', result: { items: [{ id: 'done' }] } }; } })), /pin-release-failed/);
    assert.equal((await f.api.get(record.id)).status, 'completed');
    await f.api.resume(record.id, hooks({ transferServer: async () => { throw Error('must not retransfer after a cleanup failure'); } }));
    assert.equal(transfers, 1); assert.equal(unpins, 2); assert.equal((await f.api.get(record.id)).transferMode, 'server');
});

test('drive UI submits and queries the migrated server identity while keeping its original local record', async () => {
    const source=fs.readFileSync('client/disk-ui.js','utf8'),start=source.indexOf('function pendingSaveTransferId('),end=source.indexOf('async function showTelegramDrivePendingSaveBanner()',start);
    const transferId=vm.runInNewContext(source.slice(start,end)+';pendingSaveTransferId');
    assert.equal(transferId({id:'legacy',serverTransferId:'new-server'}),'new-server');assert.equal(transferId({id:'original'}),'original');
    const record={id:'local-record',serverTransferId:'server-retry',source:'sns',version:'1000-3',task:{id:'task'},target:{accountId:'account',partitionId:'part',diskSpace:'space',path:'目录'}},calls=[];
    const context={telegramDrivePendingSaveId:record.id,telegramDrivePendingSaveRunning:false,pendingSaveTransferId:transferId,showTelegramDrivePendingSaveBanner:async()=>{},showAppToast(){},choosePendingSaveTarget(){},confirmTelegramDriveAction(){},window:{
        DiskPendingSave:{resume:async(id,hooks)=>{assert.equal(id,record.id);await hooks.lookup(record);await hooks.transferServer(record,record.target);}},
        DiskClient:{raw:async(url,options)=>{calls.push({url,options});return url==='/accounts'?{accounts:[{identity:{id:'account'}}]}:{found:false};},json:(method,body)=>({method,body:JSON.stringify(body)}),request:async(url,options)=>calls.push({url,options})}
    }};
    const run=vm.runInNewContext(source.slice(source.indexOf('async function resumeTelegramDrivePendingSave('),source.indexOf('function telegramDriveErrorText('))+';resumeTelegramDrivePendingSave',context);
    await run(record.id);
    assert.equal(calls[1].url,'/pending-saves/server-retry');assert.equal(calls[1].options.accountId,'account');assert.equal(calls[1].options.diskSpace,'space');
    const submitted=JSON.parse(calls[2].options.body);assert.equal(submitted.pendingSaveId,'server-retry');assert.equal(submitted.taskId,'task');assert.equal(submitted.folderPath,'目录');
});

test('cleared or changed server sources do not silently use a browser cache fallback', async () => {
    const f = browser(); f.changeSource({ ...f.task, hasFile: false, status: 'cleared' });
    await assert.rejects(() => f.api.prepareServer({ source: 'youtube', task: f.task }), /服务端成品/);
    assert.equal((await f.api.list()).length, 0);
    f.changeSource({ ...f.task, completedAt: 2000 });
    await assert.rejects(() => f.api.prepareServer({ source: 'youtube', task: f.task }), /版本已变化/);
});

test('transfer labels translate in every supported language without translating filenames or formatting their literal braces', () => {
    const context=vm.createContext({window:{},DEFAULT_LANG:'zh-Hans',currentLanguage:()=> 'en'});
    vm.runInContext(fs.readFileSync('client/i18n-catalog.js','utf8'),context);
    const catalog=context.window.Drop2TunnelI18nCatalog;
    context.CATALOG=new Map(Object.entries(catalog).map(([key,translations])=>[key,{source:key,translations}]));
    context.resolveCatalogKey=value=>context.CATALOG.has(String(value).replace(/\s+/g,''))?String(value).replace(/\s+/g,''):'';
    const source=fs.readFileSync('client/i18n.js','utf8');
    const translate=vm.runInContext(source.slice(source.indexOf('const DYNAMIC_LANGUAGES'),source.indexOf('function canonicalKey('))+source.slice(source.indexOf('function translateDynamic('),source.indexOf('function shouldSkipTextNode('))+';translateText',context);
    for(const language of Object.keys(catalog['抓取任务转存'])) {
        assert.ok(translate('抓取任务转存：发送',language).endsWith('发送'));
        assert.ok(translate('抓取任务转存：{1}.txt',language).endsWith('{1}.txt'));
    }
    assert.match(translate('后台登录已失效，未发起转存。请重新登录后台后继续。 [TASK_SAVE_ADMIN_AUTH_REQUIRED]','en'),/Admin.*\[TASK_SAVE_ADMIN_AUTH_REQUIRED\]/);
});
