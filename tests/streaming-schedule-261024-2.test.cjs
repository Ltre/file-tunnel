'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../client/streaming-console.js'), 'utf8');

function runtime(translate = value => value) {
    const timers = new Map(); let clock = 0, sequence = 0;
    const context = { t:translate, performance:{now:() => clock},
        setInterval:run => { timers.set(++sequence, run); return sequence; }, clearInterval:id => timers.delete(id) };
    const start = source.indexOf('    function programWaits(');
    vm.runInNewContext(source.slice(start, source.indexOf('    async function watcher(', start)) + ';this.api={programWaits, programWaitText, watchSchedule};', context);
    return {...context.api, timers, advance(seconds) { clock += seconds * 1000; for (const run of [...timers.values()]) run(); }};
}
const item = (id, stay) => ({id, kind:'image', stay});
const station = changes => ({visibility:'public', loop:false, items:[item('a', 10), {id:'b',kind:'video',duration:50,start:20}, item('c', 120)], playback:{status:'playing',itemId:'a',position:4}, ...changes});

test('watch playlist waits use remaining global progress and each following item duration minus start', () => {
    const f = runtime(), waits = f.programWaits(station());
    assert.equal(waits.has('a'), false);
    assert.equal(waits.get('b').seconds, 6);
    assert.equal(waits.get('c').seconds, 36);
    assert.equal(f.programWaits(station(), 5).get('c').seconds, 31);
    assert.equal(f.programWaits(station(), 7).get('b').state, 'syncing');
    assert.equal(f.programWaits(station(), 7).get('c').seconds, 29);
});

test('looping waits wrap to earlier items while a non-looping station marks earlier items completed', () => {
    const f = runtime(), value = station({playback:{status:'playing',itemId:'b',position:7}});
    assert.equal(f.programWaits(value).get('a').state, 'finished');
    assert.equal(f.programWaits({...value,loop:true}).get('a').seconds, 143);
    assert.equal(f.programWaits({...value,loop:true}).get('c').seconds, 23);
});

test('unavailable items are excluded from the schedule and an unknown duration does not produce invented times', () => {
    const f = runtime(), value = station();
    value.items[1].unavailable = 'STREAM_SOURCE_DELETED';
    const waits = f.programWaits(value);
    assert.equal(waits.get('b').state, 'unavailable');
    assert.equal(waits.get('c').seconds, 6);
    delete value.items[1].unavailable; value.items[1].duration = null;
    assert.equal(f.programWaits(value).get('b').seconds, 6);
    assert.equal(f.programWaits(value).get('c').state, 'duration');
});

test('paused, stopped, offline and locked stations show their actual state instead of counting down', () => {
    const f = runtime();
    for (const state of ['paused', 'stopped']) assert.equal(f.programWaits(station({playback:{status:state,itemId:'a',position:4}}), 100).get('b').state, state);
    assert.equal(f.programWaits(station({visibility:'offline'})).get('b').state, 'offline');
    assert.equal(f.programWaits(station({locked:true})).get('b').state, 'locked');
});

test('wait formatting preserves seconds below a minute and localized hour/minute parameters', () => {
    const f = runtime();
    assert.equal(f.programWaitText({state:'scheduled',seconds:23}), '23秒后放送');
    assert.equal(f.programWaitText({state:'scheduled',seconds:59.5}), '60秒后放送');
    assert.equal(f.programWaitText({state:'scheduled',seconds:60}), '1分后放送');
    assert.equal(f.programWaitText({state:'scheduled',seconds:5640}), '1小时34分后放送');
    assert.equal(runtime(value => value === '{0}小时{1}分后放送' ? 'In {0} h {1} m' : value).programWaitText({state:'scheduled',seconds:5640}), 'In 1 h 34 m');
});

test('watch schedule updates existing small labels without network work and releases its timer on cleanup', () => {
    const f = runtime(), node = {}, rows = new Map([['b',node]]), state = {value:station(),receivedAt:0}; let active = true;
    const stop = f.watchSchedule(rows, state, () => active);
    assert.equal(node.textContent, '6秒后放送'); assert.equal(f.timers.size, 1);
    f.advance(2); assert.equal(node.textContent, '4秒后放送');
    state.value = station({playback:{status:'paused',itemId:'a',position:6}}); state.receivedAt = 2000;
    f.advance(1); assert.equal(node.textContent, '全台已暂停');
    stop(); assert.equal(f.timers.size, 0);
    f.watchSchedule(rows, state, () => active); active = false; f.advance(1); assert.equal(f.timers.size, 0);
});
