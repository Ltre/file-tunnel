'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
function database() {
    const values = new Map(); let tail=Promise.resolve();
    return { open() { const request = {}; queueMicrotask(() => {
        request.result = { createObjectStore() {}, transaction(_key, mode) {
            let pending = 0, timer, working, release; const previous=tail; tail=new Promise(done=>{release=done;});
            const tx = { objectStore: () => ({ get: id => read(() => working.get(id)), getAll: () => read(() => [...working.values()]), put: value => read(() => working.set(value.id, structuredClone(value))) }) };
            function read(fn) { const item = {}; pending++; clearImmediate(timer); previous.then(() => { working ||= new Map(values); item.result = structuredClone(fn()); item.onsuccess?.(); if (!--pending) timer = setImmediate(() => { if (mode === 'readwrite') { values.clear(); for (const pair of working) values.set(...pair); } tx.oncomplete?.(); release(); }); }); return item; }
            return tx;
        } }; request.onupgradeneeded?.(); request.onsuccess?.();
    }); return request; } };
}
function browser() {
    const files = new Map(), calls = [], task = { id:'task', completedAt:1000, outputFileSize:5, outputFileName:'片段.mp4', hasFile:true, status:'completed' };
    let failure = null;
    const context = { URL, URLSearchParams, crypto:crypto.webcrypto, indexedDB:database(), setTimeout, clearTimeout, AbortController,
        fetch: async (url, options = {}) => {
            calls.push({url,options}); const path = String(url).split('?')[0];
            if (path.startsWith('/api/telegram/drive/')) {
                if (failure) return new Response(JSON.stringify({error:failure}),{status:failure==='LOGIN_REQUIRED'?401:503});
                const file = files.get(decodeURIComponent(path.split('/').pop()));
                return new Response(JSON.stringify(file || {error:'FILE_NOT_FOUND'}),{status:file?200:404});
            }
            return new Response(JSON.stringify(task));
        }
    }; context.window=context;
    vm.runInNewContext(fs.readFileSync('client/disk-pending-save.js','utf8'),context);
    const api=context.DiskPendingSave;
    const target={accountId:'saved-account',accountName:'原保存账号',partitionId:'partition',partitionName:'原分区',diskSpace:'space-key',path:'保存目录'};
    const hooks={ chooseAccount:async()=>({id:target.accountId}), chooseTarget:async()=>target, confirm:async()=>true, transferServer:async()=>({items:[{id:'saved-file'}]}) };
    async function completed() { const record=await api.prepareServer({source:'sns',task}); await api.update(record.id,{target}); files.set('saved-file',{id:'saved-file',name:task.outputFileName,folderPath:target.path}); await api.complete(record.id,{items:[{id:'saved-file'}]}); return record; }
    return {api,files,calls,task,target,hooks,completed,fail:value=>{failure=value;}};
}
test('deleted saved files do not reuse a completed local receipt as proof of an existing destination',async()=>{
    const f=browser(), old=await f.completed(); f.files.delete('saved-file');
    const next=await f.api.prepareServer({source:'sns',task:f.task});
    assert.equal(next.status,'pending'); assert.notEqual(next.id,old.id); assert.equal(next.target,null);
});
test('a file moved out of its saved directory permits a new independent transfer',async()=>{
    const f=browser(), old=await f.completed(); f.files.get('saved-file').folderPath='别处';
    const next=await f.api.prepareServer({source:'sns',task:f.task}); assert.notEqual(next.id,old.id); assert.equal(next.status,'pending');
});
test('an unreadable receipt never announces successful completion or becomes a fresh upload',async()=>{
    const f=browser(), record=await f.completed(); f.fail('LOGIN_REQUIRED'); let completed=0, uploaded=0;
    await assert.rejects(f.api.resume(record.id,{...f.hooks,onCompleted:()=>completed++,transferServer:()=>uploaded++}));
    assert.equal(completed,0); assert.equal(uploaded,0); assert.equal((await f.api.get(record.id)).status,'completed');
});
test('saved file inspection uses the original account and partition rather than the active account',async()=>{
    const f=browser(), record=await f.completed(); let completed=0;
    await f.api.resume(record.id,{...f.hooks,onCompleted:()=>completed++}); assert.equal(completed,1);
    const check=f.calls.find(call=>String(call.url).includes('/files/saved-file')); assert.ok(check);
    assert.equal(check.options.headers['X-Disk-Account'],f.target.accountId); assert.equal(new URL(check.url,'http://localhost').searchParams.get('disk_space'),f.target.diskSpace);
});
test('an empty successful HTTP/operation result is not enough to mark a transfer completed',async()=>{
    const f=browser(), record=await f.api.prepareServer({source:'sns',task:f.task}); let completed=0;
    await assert.rejects(f.api.resume(record.id,{...f.hooks,transferServer:async()=>({}),onCompleted:()=>completed++}));
    assert.equal(completed,0); assert.equal((await f.api.get(record.id)).status,'verification-required');
});
test('recovering an uncertain transfer checks historical server completion against the current file before announcing success',async()=>{
    const f=browser(), record=await f.completed(); await f.api.update(record.id,{status:'verification-required'}); f.files.delete('saved-file');
    let transfers=0, completed;
    await f.api.resume(record.id,{...f.hooks,lookup:async()=>({status:'completed',result:{items:[{id:'saved-file'}]}}),
        transferServer:async()=>{transfers++;return {items:[{id:'new-file'}]};},onCompleted:value=>{completed=value;}});
    assert.equal(transfers,1); assert.notEqual(completed.id,record.id); assert.equal((await f.api.get(record.id)).status,'superseded');
});
test('concurrent retries after a deleted file share one new pending identity even without Web Locks',async()=>{
    const f=browser();await f.completed();f.files.delete('saved-file');
    const [first,second]=await Promise.all([f.api.prepareServer({source:'sns',task:f.task}),f.api.prepareServer({source:'sns',task:f.task})]);
    assert.equal(first.id,second.id);assert.equal(first.status,'pending');
});

for (const [page, source] of [['sns-dl','sns'], ['youtube-premium-dl','youtube']]) {
    test(`${page} binds its actual transfer button to saved receipt state and destination details`, async () => {
        const f = browser(), record = await f.api.prepareServer({ source, task:f.task });
        f.files.set('saved-file', { id:'saved-file', folderPath:f.target.path, name:f.task.outputFileName });
        await f.api.update(record.id, { target:f.target }); await f.api.complete(record.id, { items:[{id:'saved-file'}] });
        const html = fs.readFileSync('pages/' + page + '.html','utf8'), start = html.indexOf('            const saveToDisk =');
        const button = () => ({ isConnected:true, addEventListener(_name, action) { this.onclick=action; } });
        let displayed;
        const context = { window:{DiskPendingSave:f.api}, task:f.task, makeAction:(_title,action) => ({...button(),onclick:action}), document:{createElement:button},
            actions:{append:value=>{displayed=value;},appendChild:value=>{displayed=value;}} };
        vm.runInNewContext(html.slice(start, html.indexOf('\n        }', start)), context);
        for (let attempt=0; attempt<20 && displayed.textContent!=='已转存到网盘'; attempt++) await new Promise(setImmediate);
        assert.equal(displayed.textContent,'已转存到网盘');
        for (const detail of [f.target.accountName,f.target.accountId,f.target.partitionName,'/'+f.target.path]) assert.ok(displayed.title.includes(detail));
    });
}

test('real authenticated drive metadata invalidates deleted or moved receipts and permits one new backend transfer', async t => {
    const fixture = await require('./support/pending-save-261012-fixture.cjs').createFixture({ serverTransfers: true });
    t.after(() => fixture.close());
    const jar = new Map(), calls = []; let offline = false;
    const cookie = () => [...jar].map(([name, value]) => name + '=' + value).join('; ');
    async function http(route, options = {}) {
        const headers = new Headers(options.headers); headers.set('Cookie', cookie());
        if (options.method && options.method !== 'GET') headers.set('Origin', fixture.base);
        const response = await fetch(new URL(route, fixture.base), { ...options, headers });
        for (const value of response.headers.getSetCookie()) { const pair = value.split(';')[0], at = pair.indexOf('='); if (/Max-Age=0(?:;|$)/.test(value)) jar.delete(pair.slice(0, at)); else jar.set(pair.slice(0, at), pair.slice(at + 1)); }
        return response;
    }
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    async function request(route, options = {}) {
        const response = await http('/api/telegram/drive' + route, options), value = await response.json();
        assert.equal(response.ok, true, JSON.stringify(value));
        if (!value.operation_id) return value;
        for (let attempt = 0; attempt < 100; attempt++) {
            const operation = await (await http('/api/telegram/drive/operations/' + value.operation_id + new URL(route, fixture.base).search, { headers: options.headers })).json();
            if (operation.status === 'completed') return operation.result;
            assert.ok(['queued','running'].includes(operation.status), JSON.stringify(operation));
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw Error('fixture operation did not complete');
    }
    await (await http('/fixture-login', json('POST', { id: 'alice' }))).text();
    const space = await request('/spaces', json('POST', { name: '回执验证分区' })), partition = space.partition;
    const task = await (await http('/api/sns-dl/tasks/sns-fixture')).json();
    // Keep Alice's proof, but make Bob the selected account in the same cookie
    // jar. Inspection must still read Alice's original non-default partition.
    await (await http('/fixture-login', json('POST', { id: 'bob' }))).text();
    assert.equal((await (await http('/api/telegram/drive/me')).json()).identity.id, 'bob');
    const scope = '?disk_space=' + encodeURIComponent(space.diskSpace), headers = { 'X-Disk-Account': 'alice' };
    const drive = fixture.api.spaces.get(space.diskSpace);
    function runtime() {
        const context = { URL, URLSearchParams, crypto: crypto.webcrypto, indexedDB: database(), setTimeout, clearTimeout, AbortController,
            fetch: async (route, options = {}) => {
                if (offline && String(route).startsWith('/api/telegram/drive/files/')) throw TypeError('fetch failed');
                const response = await http(route, options); calls.push({ route, options, status: response.status }); return response;
            }
        }; context.window = context;
        vm.runInNewContext(fs.readFileSync('client/disk-pending-save.js','utf8'), context); return context.DiskPendingSave;
    }
    for (const mutation of ['delete','move']) {
        const api = runtime(), directory = '原保存位置-' + mutation;
        const saved = drive.putMetadataObject(fixture.auth.user('alice'), directory, task.outputFileName, 'text/plain');
        const record = await api.prepareServer({ source: 'sns', task });
        const target = { accountId:'alice', accountName:'验收甲账号', partitionId:partition.id, partitionName:partition.name, diskSpace:space.diskSpace, path:directory };
        await api.update(record.id, { target }); await api.complete(record.id, { items: [{ id: saved.id }] });
        const completed = await api.get(record.id);
        assert.equal((await api.inspectSaved(completed, { force:true })).state, 'saved');
        const check = calls.find(call => String(call.route).includes('/files/' + saved.id));
        assert.equal(check.options.headers['X-Disk-Account'], 'alice'); assert.equal(new URL(check.route, fixture.base).searchParams.get('disk_space'), space.diskSpace);
        if (mutation === 'delete') await request('/files/' + saved.id + scope, { method:'DELETE', headers });
        else {
            await request('/directories' + scope, { ...json('POST', { path:'已移动的位置' }), headers:{ ...headers, 'Content-Type':'application/json' } });
            await request('/files/' + saved.id + scope, { ...json('PATCH', { folderPath:'已移动的位置' }), headers:{ ...headers, 'Content-Type':'application/json' } });
        }
        assert.equal((await api.inspectSaved(completed, { force:true })).state, mutation === 'delete' ? 'missing' : 'moved');
        const next = await api.prepareServer({ source:'sns', task });
        assert.notEqual(next.id, record.id); assert.equal(next.status, 'pending'); assert.equal((await api.get(record.id)).status, 'superseded');
        let submissions = 0;
        await api.resume(next.id, { chooseAccount:async () => ({id:'alice'}), chooseTarget:async () => target, confirm:async () => true,
            transferServer: async current => { submissions++; return request('/task-saves' + scope, { ...json('POST', { pendingSaveId:current.id, source:'sns', taskId:task.id, version:current.version, partitionId:partition.id, folderPath:directory }), headers:{ ...headers, 'Content-Type':'application/json' } }); }
        });
        assert.equal(submissions, 1); assert.equal((await api.get(next.id)).status, 'completed');
        assert.equal((await api.inspectSaved(await api.get(next.id), { force:true })).state, 'saved');
    }
    const api = runtime(), saved = drive.putMetadataObject(fixture.auth.user('alice'), '权限核验', '权限.txt', 'text/plain');
    const record = await api.prepareServer({ source:'sns', task });
    await api.update(record.id, { target:{ accountId:'alice', partitionId:partition.id, partitionName:partition.name, diskSpace:space.diskSpace, path:'权限核验' } });
    await api.complete(record.id, { items:[{id:saved.id}] });
    const statsBefore = await (await http('/fixture-stats')).json();
    offline = true;
    assert.equal((await api.inspectSaved(await api.get(record.id), { force:true })).state, 'unknown');
    assert.equal((await api.prepareServer({ source:'sns', task })).id, record.id);
    await assert.rejects(api.resume(record.id, { transferServer:() => { throw Error('must not submit'); } }));
    offline = false; jar.delete(fixture.sessions.accountCookie('alice'));
    assert.equal((await api.inspectSaved(await api.get(record.id), { force:true })).state, 'login-required');
    assert.equal((await api.prepareServer({ source:'sns', task })).id, record.id);
    await assert.rejects(api.resume(record.id, { transferServer:() => { throw Error('must not submit'); } }));
    assert.equal((await api.get(record.id)).status, 'completed');
    const statsAfter = await (await http('/fixture-stats')).json();
    assert.equal(statsAfter.serverTransfersStarted, statsBefore.serverTransfersStarted); assert.equal(statsAfter.browserUploads, 0); assert.equal(statsAfter.browserReads, 0);
});
