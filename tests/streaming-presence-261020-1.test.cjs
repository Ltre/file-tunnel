'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createStreamingConsole } = require('../server/streaming-console');
async function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-presence-'));
    t.after(() => { assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); fs.rmSync(dataDir, { recursive: true, force: true }); });
    let time = 100000;
    const service = createStreamingConsole({ dataDir, now: () => time, sources: { resolve: async source => ({ source, name: 'image.png', type: 'image/png', size: 10 }) } });
    for (const id of ['A', 'B']) service.register(id, id.repeat(40), id);
    const owner = { deviceId: 'A' }, viewer = { deviceId: 'B' }, station = service.create(owner, {});
    await service.edit(station.id, owner, { configVersion: 1, items: [{ id: 'image', stay: 100, source: { kind: 'local', fileId: 'file' } }] });
    service.visibility(station.id, owner, { visibility: 'public', version: service.station(station.id).playback.version });
    const report = (watchId, actor = viewer) => service.report(station.id, actor, { watchId, status: 'paused', itemId: 'image', position: 0 });
    const command = action => service.control(station.id, owner, { action, version: service.station(station.id).playback.version });
    return { service, owner, viewer, station, report, command, time: ms => { time += ms; }, view: () => service.view(station.id, viewer) };
}
test('first viewer starts, existing viewers preserve manual pause, only zero-to-one resumes', async t => {
    const f = await fixture(t); f.report('watch-one'); assert.equal(f.view().playback.status, 'playing');
    f.time(5000); f.command('pause'); const position = f.view().playback.position;
    f.report('watch-two'); assert.equal(f.view().playback.status, 'paused');
    f.service.unwatch(f.station.id, f.viewer, 'watch-one'); assert.equal(f.view().viewerCount, 1);
    f.report('watch-two'); assert.equal(f.view().playback.status, 'paused');
    f.service.unwatch(f.station.id, f.viewer, 'watch-two'); assert.equal(f.view().viewerCount, 0);
    f.time(100000); f.report('watch-three'); assert.equal(f.view().playback.status, 'playing'); assert.equal(f.view().playback.position, position);
});
test('last viewer leaves or expires: clock freezes; new zero-to-one may restart a stopped station', async t => {
    const f = await fixture(t); f.report('watch-one'); f.time(5000); f.service.unwatch(f.station.id, f.viewer, 'watch-one');
    f.time(100000); assert.equal(f.view().playback.position, 5); assert.equal(f.view().playback.status, 'paused');
    f.report('watch-two'); f.command('stop'); f.report('watch-three'); assert.equal(f.view().playback.status, 'stopped');
    for (const id of ['watch-two', 'watch-three']) f.service.unwatch(f.station.id, f.viewer, id);
    f.report('watch-four'); assert.equal(f.view().playback.status, 'playing'); assert.equal(f.view().playback.position, 0);
    f.time(100000); f.service.tick(); assert.equal(f.view().playback.status, 'paused'); assert.equal(f.view().playback.position, 45);
});
test('management and lists are not viewers, and offline or kicked visitors cannot start playback', async t => {
    const f = await fixture(t); f.view(); f.service.list(f.owner, 'local'); assert.equal(f.view().viewerCount, 0);
    f.service.access(f.station.id, f.owner, 'B', false); assert.throws(() => f.report('blocked'), /KICKED/);
    f.service.visibility(f.station.id, f.owner, { visibility: 'offline', version: f.service.station(f.station.id).playback.version });
    assert.throws(() => f.report('owner-view', f.owner), /OFFLINE/);
});
test('a report arriving after its explicit leave cannot revive a closed viewing instance', async t => {
    const f = await fixture(t);
    f.service.unwatch(f.station.id, f.viewer, 'closed-before-report');
    assert.throws(() => f.report('closed-before-report'), /WATCH_ENDED/);
    assert.equal(f.view().viewerCount, 0);
    f.report('fresh-instance'); assert.equal(f.view().playback.status, 'playing');
});
test('a nonloop ended station stays stopped with viewers and restarts on the next zero-to-one', async t => {
    const f = await fixture(t);
    await f.service.edit(f.station.id, f.owner, { configVersion: 2, loop: false, items: [{ id: 'image', stay: 100 }] });
    f.report('existing');
    for (let i = 0; i < 3; i++) { f.time(40000); f.report('existing'); }
    assert.equal(f.view().playback.status, 'stopped');
    f.report('newcomer'); assert.equal(f.view().playback.status, 'stopped');
    f.service.unwatch(f.station.id, f.viewer, 'existing'); f.service.unwatch(f.station.id, f.viewer, 'newcomer');
    f.report('fresh'); assert.equal(f.view().playback.status, 'playing'); assert.equal(f.view().playback.position, 0);
});

test('closing the creator does not pause a viewer that is buffering, and a delayed first join starts without an admin command', async t => {
    const f=await fixture(t);f.report('creator-view',f.owner);
    f.service.report(f.station.id,f.viewer,{watchId:'buffering-view',status:'buffering',itemId:'image',position:0});
    f.service.unwatch(f.station.id,f.owner,'creator-view');
    assert.equal(f.view().viewerCount,1);assert.equal(f.view().playback.status,'playing');
    f.service.unwatch(f.station.id,f.viewer,'buffering-view');
    assert.equal(f.view().playback.status,'paused');f.time(2000);
    f.service.report(f.station.id,f.viewer,{watchId:'delayed-join',status:'buffering',itemId:'image',position:0});
    assert.equal(f.view().playback.status,'playing','a successful retried join must start the station without 全台播放');
});
