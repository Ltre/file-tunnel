'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { createFixture } = require('./support/disk-content-admin-fixture.cjs');
async function fixture(t) {
    t.mock.method(console, 'info', () => {});
    const f = await createFixture(); t.after(() => f.close());
    f.get = async (url, admin = true) => {
        const response = await fetch(f.base + '/api/telegram/disk-admin' + url, { headers: admin ? { 'X-Test-Admin': '1' } : {} });
        return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json() };
    };
    return f;
}
test('后台按状态分页读取清理与租约，不执行清理；普通用户不能访问', async t => {
    const f = await fixture(t);
    for (const url of ['/content-objects?state=DELETING', '/content-reference-files?q=相同.har', '/content-objects/' + f.sharedId])
        assert.equal((await f.get(url, false)).status, 401);
    const response = await f.get('/content-objects?state=DELETING&limit=1&offset=0');
    assert.equal(response.status, 200); assert.equal(response.cache, 'no-store');
    assert.equal(response.data.total, 1); assert.equal(response.data.contents[0].id, f.deletingId);
    assert.equal(response.data.cleanup[0].error, 'MOCK_TELEGRAM_UNAVAILABLE'); assert.equal(response.data.cleanup[0].attempts, 1);
    assert.equal(response.data.counts.DELETE_PENDING, 1); assert.equal(response.data.cleanup_mode, 'observe');
    const pending = await f.get('/content-objects?state=DELETE_PENDING');
    assert.equal(pending.data.contents[0].active_leases, 1); assert.equal(pending.data.contents[0].reference_count, 0);
    const both = await f.get('/content-objects?state=DELETING,DELETE_PENDING&limit=1&offset=1');
    assert.equal(both.data.total, 2); assert.equal(both.data.contents.length, 1);
    assert.ok(both.data.cleanup.every(task => task.content_id === both.data.contents[0].id));
    assert.equal(f.remoteCalls, 0); assert.equal(f.content.resolve(f.deletingId).state, 'DELETING');
    const browser = await fetch(f.base + '/api/telegram/drive/content-reference-files?q=相同.har'); assert.equal(browser.status, 404);
});
test('任意文件查找区分同名位置，全部引用跨账号跨分区且链接准确编码', async t => {
    const f = await fixture(t);
    const results = await f.get('/content-reference-files?' + new URLSearchParams({ q: '相同.har' }));
    assert.equal(results.status, 200); assert.equal(results.data.total, 3);
    assert.deepEqual(new Set(results.data.files.map(file => file.content_id)), new Set([f.sharedId]));
    const details = await f.get('/content-objects/' + f.sharedId);
    assert.equal(details.data.references.length, 3);
    const photo = details.data.references.find(file => file.scope === '相册&照片');
    assert.equal(photo.full_path, '/日本語 & 测试/留档/相同.har'); assert.equal(photo.user.username, 'alice');
    const url = new URL(photo.location_url, f.base);
    assert.equal(url.pathname, '/disk-management'); assert.equal(url.searchParams.get('user_id'), 'alice');
    assert.equal(url.searchParams.get('disk_space'), '相册&照片'); assert.equal(url.searchParams.get('path'), '日本語 & 测试/留档'); assert.equal(url.searchParams.get('file_id'), 'file-photo');
    assert.doesNotMatch(JSON.stringify(details.data), /DO-NOT-EXPOSE-PASSKEY|publicKey|encryptedToken|expectedDigest|nonce/);
    const byId = await f.get('/content-reference-files?q=file-b'); assert.equal(byId.data.total, 1); assert.equal(byId.data.files[0].owner_id, 'bob');
    const marker = await f.get('/content-reference-files?q=audit-marker'); assert.equal(marker.data.files[0].content_id, null);
    const pending = await f.get('/content-objects/' + f.pendingId); assert.equal(pending.data.references.length, 0); assert.equal(pending.data.leases.length, 1);
    const targetFolder = await f.get('/storage-contents?' + url.searchParams);
    assert.equal(targetFolder.status, 200); assert.equal(targetFolder.data.files[0].id, 'file-photo');
    assert.equal(f.remoteCalls, 0);
});
test('查询参数合法性、字面文件名匹配、缺失 Content 和旧列表兼容', async t => {
    const f = await fixture(t);
    for (const url of ['/content-objects?state=DROP', '/content-objects?limit=0', '/content-objects?limit=101', '/content-objects?offset=-1', '/content-reference-files?q=', '/content-reference-files?q=x&offset=bad'])
        assert.equal((await f.get(url)).data.error, 'CONTENT_QUERY_INVALID');
    assert.equal((await f.get('/content-reference-files?q=%25')).data.total, 0, '百分号不是 LIKE 通配符');
    assert.equal((await f.get('/content-objects/missing')).status, 404);
    const old = await f.get('/content-objects'); assert.ok(old.data.contents.some(item => item.id === f.sharedId)); assert.ok(Array.isArray(old.data.captions));
    assert.equal(f.remoteCalls, 0);
});
test('删除逻辑文件后仍保留原 Content 审计指针并可查询其他引用', async t => {
    const f = await fixture(t);
    const before = f.repository.load('files');
    f.repository.replace('files', before.map(file => file.id === 'file-a' ? { ...file, reviewStatus: 'deleted' } : file), file => file.id);
    const result = await f.get('/content-reference-files?q=file-a');
    assert.equal(result.data.files[0].content_id, f.sharedId);
    assert.equal(result.data.files[0].review_status, 'deleted');
    const detail = await f.get('/content-objects/' + f.sharedId);
    assert.equal(detail.data.references.length, 2);
    assert.deepEqual(new Set(detail.data.references.map(file => file.logical_file_id)), new Set(['file-b', 'file-photo']));
});
test('分享转存只新建独立 Logical 引用，来源撤销与自有资源限制生效', async t => {
    const f = await fixture(t);
    const source = await fetch(f.base + '/api/telegram/drive/shares', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-User': 'bob' },
        body: JSON.stringify({ items: [{ kind: 'file', id: 'file-b' }] }) });
    assert.equal(source.status, 201);
    const createdShare = await source.json(), token = createdShare.url.split('/').at(-1);
    const copy = async user => fetch(f.base + '/api/telegram/drive/shares/' + token + '/copy', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Test-User': user },
        body: JSON.stringify({ selection: { kind: 'file', id: 'file-b' }, diskSpace: '', destinationPath: '' }) });
    const self = await copy('bob'); assert.equal(self.status, 422); assert.equal((await self.json()).error, 'CONTENT_COPY_SELF_OWNED');
    const result = await copy('alice'); assert.equal(result.status, 201, await result.clone().text());
    const copied = (await result.json()).copied[0];
    const alice = f.repository.load('files').find(file => file.id === copied.id);
    assert.equal(alice.ownerId, 'alice'); assert.equal(alice.contentId, f.sharedId);
    const revoked = await fetch(f.base + '/api/telegram/drive/shares/' + createdShare.id, { method: 'DELETE', headers: { 'X-Test-User': 'bob' } });
    assert.equal(revoked.status, 200);
    assert.equal(f.repository.load('files').find(file => file.id === copied.id).contentId, f.sharedId);
    const refs = await f.get('/content-objects/' + f.sharedId);
    assert.equal(refs.data.references.length, 4);
});
test('协同文件转存后属于受邀者，踢出成员不撤销已转存的引用', async t => {
    const f = await fixture(t);
    const send = (url, user, body, method = 'POST') => fetch(f.base + '/api/telegram/drive' + url, {
        method, headers: { 'X-Test-User': user, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const invitation = await send('/collaborations/invitations', 'bob', { kind: 'file', fileId: 'file-b' });
    assert.equal(invitation.status, 201, await invitation.clone().text());
    const created = await invitation.json(), token = created.url.split('/').at(-1);
    const joined = await send('/collaborations/join', 'alice', { token });
    assert.equal(joined.status, 200, await joined.clone().text());
    const copy = await send('/collaborations/' + created.collaboration.id + '/copy', 'alice',
        { selection: { kind: 'file', id: 'file-b' }, diskSpace: '', destinationPath: '' });
    assert.equal(copy.status, 201, await copy.clone().text());
    const copiedId = (await copy.json()).copied[0].id;
    const kick = await send('/collaborations/' + created.collaboration.id + '/members/alice', 'bob', undefined, 'DELETE');
    assert.equal(kick.status, 200);
    const file = f.repository.load('files').find(entry => entry.id === copiedId);
    assert.equal(file.ownerId, 'alice'); assert.equal(file.contentId, f.sharedId);
});
test('后台普通文件搜索、上传内容哈希查询和技术信息不会泄露账号密钥', async t => {
    const f = await fixture(t);
    const search = await f.get('/storage-search?q=' + encodeURIComponent('相同.har'));
    assert.equal(search.status, 200); assert.equal(search.data.total, 3);
    const response = await fetch(f.base + '/api/telegram/disk-admin/content-reference-by-upload', {
        method: 'POST', headers: { 'X-Test-Admin': '1', 'Content-Type': 'application/octet-stream' }, body: Buffer.from('shared-fixture')
    });
    assert.equal(response.status, 200);
    const byContent = await response.json();
    assert.equal(byContent.matches[0].content.id, f.sharedId);
    assert.equal(byContent.matches[0].references.length, 3);
    const technical = await f.get('/files/file-b/technical?user_id=bob');
    assert.equal(technical.status, 200);
    assert.equal(technical.data.logicalFile.id, 'file-b');
    assert.equal(technical.data.content.content.id, f.sharedId);
    assert.doesNotMatch(JSON.stringify(technical.data), /DO-NOT-EXPOSE-PASSKEY|encryptedToken|secretAccessKey/);
});
test('中文分区通过查询参数访问，跨分区复制和移动共享 Content 且失败不改变来源', async t => {
    const f = await fixture(t);
    const send = (space, body) => fetch(f.base + '/api/telegram/drive/spaces/transfer?disk_space=' + encodeURIComponent(space), {
        method: 'POST', headers: { 'X-Test-User': 'alice', 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const source = (await (await fetch(f.base + '/api/telegram/drive/list?disk_space=' + encodeURIComponent('相册&照片') + '&path=' + encodeURIComponent('日本語 & 测试/留档'),
        { headers: { 'X-Test-User': 'alice' } })).json()).files[0];
    assert.equal(source.id, 'file-photo');
    const copiedResponse = await send('相册&照片', { mode: 'copy', targetSpace: '', items: [{ kind: 'file', id: source.id }] });
    assert.equal(copiedResponse.status, 200, await copiedResponse.clone().text());
    const copied = (await copiedResponse.json()).copied[0];
    assert.equal(f.api.spaces.get('').get('alice', copied.id).contentId, f.sharedId);
    assert.equal(f.api.spaces.get('相册&照片').get('alice', source.id).contentId, f.sharedId);
    const before = f.repository.content.resolve(f.sharedId);
    const conflict = await send('相册&照片', { mode: 'move', targetSpace: '', items: [{ kind: 'file', id: source.id }] });
    assert.notEqual(conflict.status, 200, '目标根目录同名时不得删除来源');
    assert.ok(f.api.spaces.get('相册&照片').get('alice', source.id));
    f.api.spaces.get('').createDirectory('alice', '迁移目标', 20);
    const movedResponse = await send('相册&照片', { mode: 'move', targetSpace: '', destinationPath: '迁移目标', items: [{ kind: 'file', id: source.id }] });
    assert.equal(movedResponse.status, 200, await movedResponse.clone().text());
    assert.equal(f.api.spaces.get('相册&照片').get('alice', source.id), null);
    assert.equal(f.api.spaces.get('').get('alice', (await movedResponse.json()).copied[0].id).contentId, f.sharedId);
    assert.equal(f.repository.content.resolve(f.sharedId).id, before.id);
    assert.equal(f.remoteCalls, 0);
});
test('静态开放文件阻止改名、删除和协同内容替换；停止开放后允许改名', async t => {
    const f = await fixture(t), prefix = f.base + '/api/telegram/drive';
    const send = (url, method, body) => fetch(prefix + url, { method, headers: { 'X-Test-User': 'alice', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    const opened = await send('/static-resources/settings', 'POST', { item: { kind: 'file', id: 'file-a' }, preset: 'day' });
    assert.equal(opened.status, 201, await opened.clone().text());
    assert.equal((await send('/files/file-a', 'PATCH', { name: '改变.har' })).status, 409);
    assert.equal((await send('/files/file-a', 'DELETE')).status, 409);
    assert.equal((await send('/files/file-a/repair', 'POST')).status, 409);
    const stopped = await send('/static-resources/stop', 'POST', { item: { kind: 'file', id: 'file-a' } });
    assert.equal(stopped.status, 200);
    const changed = await send('/files/file-a', 'PATCH', { name: '改变.har' });
    assert.equal(changed.status, 202);
});
test('静态开放目录禁止移动删除；停用父级后独立子文件仍开放', async t => {
    const f = await fixture(t), prefix = f.base + '/api/telegram/drive';
    const send = (url, method, body) => fetch(prefix + url, { method, headers: { 'X-Test-User': 'alice', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    const folder = '资料/同名';
    const parent = await send('/static-resources/settings', 'POST', { item: { kind: 'directory', path: folder }, preset: 'month' });
    assert.equal(parent.status, 201, await parent.clone().text());
    const child = await send('/static-resources/settings', 'POST', { item: { kind: 'file', id: 'file-a' }, preset: 'week' });
    assert.equal(child.status, 201);
    assert.equal((await send('/directories', 'PATCH', { path: folder, name: '已改名' })).status, 409);
    assert.equal((await send('/directories?path=' + encodeURIComponent(folder) + '&recursive=true', 'DELETE')).status, 409);
    assert.equal((await send('/static-resources/stop', 'POST', { item: { kind: 'directory', path: folder } })).status, 200);
    assert.equal((await (await send('/static-resources', 'GET')).json()).links.filter(link => !link.revokedAt).length, 1);
    assert.equal((await send('/directories', 'PATCH', { path: folder, name: '仍不允许改名' })).status, 409);
});
