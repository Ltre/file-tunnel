'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { createFixture } = require('./support/disk-content-admin-fixture.cjs');

function client(fetch, origin = 'http://fixture.test') {
    const window = {};
    vm.runInNewContext(fs.readFileSync('client/disk-client.js', 'utf8'), {
        window, fetch, location: { origin }, URL, AbortController,
        localStorage: { getItem() { return null; }, setItem() {} },
        setInterval() {}, setTimeout, clearTimeout
    });
    return window.DiskClient;
}
async function until(predicate) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(predicate(), '任务列表应在操作返回后主动刷新，不依赖一分钟的空闲轮询');
}

test('挂载协同目录 A 移出到原生分区后，源协同任务立即显示完整明细且重试不重复', async t => {
    const f = await createFixture(); t.after(() => f.close());
    const call = async (route, body, user = 'alice', method = body ? 'POST' : 'GET') => {
        const response = await fetch(f.base + '/api/telegram/drive' + route, {
            method, headers: { 'X-Test-User': user, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
    };
    const drive = f.api.spaces.get('');
    drive.createDirectory('bob', 'src/A/内部', 30);
    drive.moveFile('bob', 'file-b', 'src/A/内部', 30);
    drive.createDirectory('alice', '本地/挂载位置', 30);
    const invite = await call('/collaborations/invitations', { kind: 'directory', path: 'src' }, 'bob');
    await call('/collaborations/join', { token: invite.url.split('/').at(-1) });
    const { mount } = await call('/mounts', { parentPath: '本地/挂载位置', name: '本地 src 别名', collaborationId: invite.collaboration.id });
    const { partition } = await call('/spaces', { name: '目标分区' });
    f.api.spaces.get(partition.scopeKey).createDirectory('alice', 'PATH/TO', 30);
    const seen = [], api = client((url, options = {}) => fetch(f.base + url, {
        ...options, headers: { ...options.headers, 'X-Test-User': 'alice' }
    }), f.base);
    t.after(() => api.stop()); api.subscribe(jobs => seen.push(Array.from(jobs)));
    api.setMount(mount.id); await api.refresh(true);
    const input = {
        mode: 'move', requestId: 'mounted-directory-move-origin',
        source: { kind: 'collaboration', collaborationId: invite.collaboration.id, selection: { kind: 'directory', path: 'src/A' } },
        target: { kind: 'native', partitionId: partition.id, destinationPath: 'PATH/TO' }
    };
    const result = await api.raw('/cross-scope/move', api.json('POST', input));
    assert.equal(result.state, 'COMPLETED'); assert.equal(result.destination, 'PATH/TO/A');
    assert.equal(drive.getDirectory('bob', 'src/A'), null);
    await until(() => seen.at(-1)?.some(job => job.requestId === input.requestId));
    const job = seen.at(-1).find(job => job.requestId === input.requestId);
    assert.equal(job.status, 'completed'); assert.equal(job.historyOrigin.collaborationId, invite.collaboration.id);
    assert.equal(job.transferDetails.source.name, 'src');
    assert.deepEqual(job.transferDetails.source.entries.map(item => ({ ...item })), [{ kind: 'directory', name: 'A', path: '/A' }]);
    assert.equal(job.transferDetails.target.name, '目标分区'); assert.equal(job.transferDetails.target.directory, '/PATH/TO');
    const again = await api.raw('/cross-scope/move', api.json('POST', input)); assert.deepEqual(again, result);
    const sourceJobs = (await call('/mount-scope/' + mount.id + '/operations')).operations.filter(item => item.requestId === input.requestId);
    assert.equal(sourceJobs.length, 1);
    for (const route of ['/operations', '/operations?disk_space=' + partition.scopeKey]) {
        assert.ok(!(await call(route)).operations.some(item => item.requestId === input.requestId));
    }
    assert.ok(!(await call('/operations', null, 'bob')).operations.some(item => item.requestId === input.requestId));
    const unrelated = await call('/collaborations/invitations', { kind: 'directory', path: 'backup' }, 'bob');
    await call('/collaborations/join', { token: unrelated.url.split('/').at(-1) });
    assert.ok(!(await call('/collaboration-scope/' + unrelated.collaboration.id + '/operations')).operations.some(item => item.requestId === input.requestId));
    await call('/collaborations/' + invite.collaboration.id + '/members/alice', null, 'bob', 'DELETE');
    const blocked = await fetch(f.base + '/api/telegram/drive/mount-scope/' + mount.id + '/operations', { headers: { 'X-Test-User': 'alice' } });
    assert.equal(blocked.ok, false); assert.ok((await blocked.json()).error);
});

test('转移完成时已有旧任务轮询在途，仍重新查询并显示已提交明细', async t => {
    for (const route of ['/cross-scope/copy', '/cross-scope/move', '/spaces/transfer']) await t.test(route, async () => {
        const seen = [], calls = []; let releaseOld, committed = false;
        const job = { operation_id: 'history-' + route, type: 'transfer-history', status: 'completed', requestId: 'fresh-history' };
        const api = client(async (url, options = {}) => {
            calls.push({ url, method: options.method || 'GET' });
            if (options.method === 'POST') { committed = true; return { ok: true, json: async () => ({ state: 'COMPLETED' }) }; }
            if (!releaseOld) return new Promise(resolve => { releaseOld = () => resolve({ ok: true, json: async () => ({ operations: [] }) }); });
            return { ok: true, json: async () => ({ operations: committed ? [job] : [] }) };
        });
        api.subscribe(jobs => seen.push(Array.from(jobs)));
        api.setMount('source-mount');
        await until(() => releaseOld);
        await api.raw(route, api.json('POST', { requestId: 'stable-transfer' }));
        releaseOld(); await until(() => seen.at(-1)?.some(item => item.operation_id === job.operation_id));
        assert.ok(calls.filter(call => call.method === 'GET').length >= 2);
        assert.ok(calls.filter(call => call.method === 'GET').every(call => call.url.includes('/mount-scope/source-mount/operations')));
        api.stop();
    });
});

test('服务端返回转移错误时仍刷新源任务，失败原因保持原样', async () => {
    let failed = false; const seen = [];
    const api = client(async (_url, options = {}) => options.method === 'POST'
        ? (failed = true, { ok: false, status: 409, json: async () => ({ error: 'CONTENT_WRITE_CONFLICT' }) })
        : { ok: true, json: async () => ({ operations: failed ? [{ operation_id: 'failed-history', type: 'transfer-history', status: 'failed', errorCode: 'CONTENT_WRITE_CONFLICT' }] : [] }) });
    api.subscribe(jobs => seen.push(Array.from(jobs))); api.setMount('source-mount'); await api.refresh(true);
    await assert.rejects(api.raw('/cross-scope/move', api.json('POST', {})), /CONTENT_WRITE_CONFLICT/);
    await until(() => seen.at(-1)?.some(job => job.operation_id === 'failed-history'));
    assert.equal(seen.at(-1)[0].status, 'failed'); api.stop();
});
