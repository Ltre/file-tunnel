'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const express = require('express'), { createAdminFormStore, createAdminFormRouter } = require('../server/admin-form-cache');
function fixture(t) {
    const directory = path.resolve(__dirname, '../.npm-cache/admin-forms-' + randomUUID());
    assert.ok(directory.startsWith(path.resolve(__dirname, '../.npm-cache') + path.sep));
    fs.mkdirSync(directory, { recursive: true });
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return { directory, store: createAdminFormStore(directory) };
}
const data = (clientKey = randomUUID()) => ({ clientKey, form: { url: 'https://example.invalid/media', mode: 'custom', remark: '原始备注', cacheFiles: true }, analysis: { title: 'Fixture', formats: [{ id: '137', kind: 'video' }, { id: '140', kind: 'audio' }, { id: '18', kind: 'video_audio' }] }, ids: ['137', '140'] });
test('cloud forms use independent files and durable counters, preserve every candidate and make repeated initial saves idempotent', async t => {
    const { directory, store } = fixture(t), first = data();
    const [a, retry, b] = await Promise.all([store.save('sns-dl', null, first), store.save('sns-dl', null, first), store.save('sns-dl', null, data())]);
    assert.equal(a.id, retry.id); assert.equal(a.revision, retry.revision); assert.notEqual(a.id, b.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'admin-forms/sns-dl/' + a.id + '.json'))).analysis.formats, first.analysis.formats);
    assert.equal((await store.list('youtube-premium-dl')).length, 0);
    await store.remove('sns-dl', b.id, b.revision);
    const restarted = createAdminFormStore(directory), next = await restarted.save('sns-dl', null, data());
    assert.equal(next.id, b.id); assert.equal((await restarted.get('sns-dl', a.id)).form.remark, '原始备注');
});
test('late saves and deletes cannot overwrite or remove a newer snapshot', async t => {
    const { store } = fixture(t), input = data(), saved = await store.save('youtube-premium-dl', null, input);
    const changed = await store.save('youtube-premium-dl', saved.id, { ...input, revision: saved.revision, form: { ...input.form, remark: '新版本' } });
    await assert.rejects(store.save('youtube-premium-dl', saved.id, { ...input, revision: saved.revision }), error => error.status === 409);
    await assert.rejects(store.remove('youtube-premium-dl', saved.id, saved.revision), error => error.status === 409);
    assert.equal((await store.get('youtube-premium-dl', saved.id)).form.remark, '新版本');
    await store.remove('youtube-premium-dl', changed.id, changed.revision);
    await store.remove('youtube-premium-dl', changed.id, changed.revision);
    assert.deepEqual(await store.list('youtube-premium-dl'), []);
});
test('first arrival keeps its requested tab number; collisions use the smallest hole free on both devices and server', async t => {
    const { store } = fixture(t);
    for (const id of [4,5,6,8,14]) assert.equal((await store.save('sns-dl', null, { ...data(), preferredId:id })).id,id);
    const input={ ...data(),preferredId:5,localIds:[1,2,3,8,10,11,13] };
    const [a,b]=await Promise.all([store.save('sns-dl',null,input),store.save('sns-dl',null,{...input,clientKey:randomUUID()})]);
    assert.equal(a.id,7);assert.equal(b.id,9);
    await store.remove('sns-dl',a.id,a.revision);
    assert.equal((await store.save('sns-dl',null,input)).id,7);
    await assert.rejects(store.remove('sns-dl',7,a.revision),error=>error.status===409);
    assert.equal((await store.get('sns-dl',5)).id,5);
});
test('default options and whitespace do not create empty server snapshots; a note-only draft is valid', async t => {
    const { store } = fixture(t);
    for(const form of [{mode:'default',cacheFiles:true},{url:'  ',remark:'\n'}]) await assert.rejects(store.save('sns-dl',null,{...data(),form}),error=>error.status===400&&error.message==='admin-form-empty');
    assert.equal((await store.list('sns-dl')).length,0);
    assert.equal((await store.save('sns-dl',null,{...data(),form:{remark:'待填写链接'}})).form.remark,'待填写链接');
});
test('administrator authorization and validation guard the real routes', async t => {
    const { directory } = fixture(t), app = express(); app.use(express.json({ limit: '3mb' }));
    app.use('/api/admin-forms', (req, res, next) => req.headers.authorization === 'fixture' ? next() : res.sendStatus(401), createAdminFormRouter({ dataDir: directory }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const base = 'http://127.0.0.1:' + server.address().port + '/api/admin-forms/';
    assert.equal((await fetch(base + 'sns-dl')).status, 401);
    const headers = { authorization: 'fixture', 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + 'unknown', { headers })).status, 400);
    assert.equal((await fetch(base + 'sns-dl/0', { headers })).status, 400);
    const response = await fetch(base + 'sns-dl', { method: 'POST', headers, body: JSON.stringify(data()) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).form.analysis.formats.length, 3);
    assert.equal((await fetch(base + 'sns-dl', { method: 'POST', headers, body: JSON.stringify({ ...data(), form: { url: {} } }) })).status, 400);
});
