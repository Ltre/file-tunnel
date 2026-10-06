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
