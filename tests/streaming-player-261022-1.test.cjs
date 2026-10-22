'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');

class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = { setProperty() {} }; this.events = {}; this.paused = true; this.currentTime = 0; this.duration = 120; this.readyState = 0; this.className = ''; this.hidden = false; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    set innerHTML(value) {
        this.children = [...value.matchAll(/class="([^"]+)"/g)].map(match => { const el = new Element(); el.className = match[1]; return el; });
    }
    get classList() { return { contains: name => this.className.split(' ').includes(name), toggle: (name, enabled) => { const set = new Set(this.className.split(' ')); if (enabled ?? !set.has(name)) set.add(name); else set.delete(name); this.className = [...set].join(' '); }, remove: name => { this.className = this.className.split(' ').filter(v => v !== name).join(' '); } }; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) { return this.children.flatMap(node => [node, ...node.querySelectorAll(selector)]).filter(node => selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : node.tagName.toLowerCase() === selector); }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    addEventListener(name, run) { (this.events[name] ||= []).push(run); }
    emit(name) { this['on' + name]?.(); for (const run of this.events[name] || []) run(); }
    play() { this.paused = false; this.emit('playing'); return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    remove() {}
}
function fixture({ deferredTicket = false, kind = 'image', reportStarts = false } = {}) {
    let time = 0, resolveTicket; const calls = [], timers = [], elements = [];
    const events = new Map(), window = { addEventListener(name, run) { events.set(name, run); }, removeEventListener(name) { events.delete(name); } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../client/streaming-player.js'), 'utf8'), {
        window, document: { createElement(tag) { const el = new Element(tag); elements.push(el); return el; } },
        performance: { now: () => time }, Date, AbortController, URL, fetch: async () => ({ ok: true, text: async () => 'text' }),
        setInterval: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clearInterval() {}, setTimeout, clearTimeout
    });
    const state = { id: 'station', visibility: 'public', loop: true, configVersion: 1, serverTime: 1,
        items: [{ id: 'a', name: 'a', kind, start: 0, duration: kind === 'audio' ? 120 : undefined, stay: 10 }, { id: 'b', name: 'b', kind: 'image', stay: 10 }],
        playback: { itemId: 'a', position: 0, status: reportStarts ? 'stopped' : 'playing', version: 1 } };
    const player = window.StreamingPlayer.create({ stationId: 'station', watchId: 'watch',
        request: async (route, method, body) => { calls.push({ route, body }); if (route.endsWith('/ticket')) {
            if (deferredTicket && body.itemId === 'a') return new Promise(resolve => { resolveTicket = resolve; });
            return { url: '/media/' + body.itemId, expiresAt: Date.now() + 600000 };
        } return reportStarts && route.endsWith('/report') ? { station: { ...state, serverTime: 2, playback: { ...state.playback, status: 'playing', version: 2 } } } : {}; }, subscribe: () => () => {} });
    player.apply(state);
    return { player, state, calls, elements, flush: async () => { await new Promise(setImmediate); },
        tick(ms) { time += ms; for (const timer of timers) if (timer.ms === 250) timer.run(); },
        page(name, event = {}) { events.get(name)?.(event); },
        release() { resolveTicket({ url: '/media/a', expiresAt: Date.now() + 600000 }); } };
}
test('audio starts audible and mute is visibly reported', async () => {
    const f = fixture({ kind: 'audio' }); await f.flush(); const audio = f.elements.find(el => el.tagName === 'AUDIO');
    assert.equal(audio.muted, false);
    const mute = f.elements.find(el => el.tagName === 'BUTTON' && el.textContent === '静音'); mute.onclick();
    assert.match(f.player.element.querySelector('.sc-play-status').textContent, /已静音/); f.player.close();
});
test('the first viewer starts from the report response without clicking Start watching', async () => {
    const f = fixture({ kind: 'audio', reportStarts: true }); await f.flush();
    const audio = f.elements.find(el => el.tagName === 'AUDIO'); audio.readyState = 4; audio.emit('canplay'); await f.flush();
    assert.equal(audio.paused, false); assert.equal(audio.muted, false); f.player.close();
});
test('a delayed current ticket is requested once rather than restarted by each clock tick', async () => {
    const f = fixture({ deferredTicket: true });
    for (let i = 0; i < 8; i++) f.tick(250);
    assert.equal(f.calls.filter(call => call.route.endsWith('/ticket') && call.body.itemId === 'a').length, 1);
    f.release(); await f.flush(); f.player.close();
});
test('an image gets its full dwell after thirty seconds of loading and the next item is prefetched', async () => {
    const f = fixture(); await f.flush(); f.tick(30000);
    f.elements.find(el => el.tagName === 'IMG').emit('load'); await f.flush();
    assert.equal(f.player.element.querySelector('.sc-countdown').textContent, '10');
    f.tick(5000); await f.flush();
    assert.ok(f.calls.some(call => call.route.endsWith('/ticket') && call.body.itemId === 'b')); f.player.close();
});

test('natural global transitions retain a delayed local item while explicit controls replace it', async () => {
    const f = fixture(); await f.flush();
    f.player.apply({ ...f.state, serverTime: 2, playback: { ...f.state.playback, itemId: 'b', position: 5, version: 2 } });
    assert.equal(f.calls.filter(call => call.route.endsWith('/ticket') && call.body.itemId === 'b').length, 0);
    f.elements.find(el => el.tagName === 'IMG').emit('load'); await f.flush();
    f.player.apply({ ...f.state, serverTime: 3, playback: { ...f.state.playback, itemId: 'b', position: 0, version: 3, controlVersion: 1 } });
    await f.flush(); assert.ok(f.calls.some(call => call.route.endsWith('/ticket') && call.body.itemId === 'b')); f.player.close();
});
test('close aborts pending loads and prevents late media from restarting audio', async () => {
    const f = fixture({ kind: 'audio' }); await f.flush(); const audio = f.elements.find(el => el.tagName === 'AUDIO'); f.player.close();
    audio.readyState = 4; audio.emit('canplay'); await f.flush(); assert.equal(audio.paused, true);
    assert.equal(f.calls.filter(call => call.route.endsWith('/unwatch')).length, 1);
});
test('ready next-item buffers are handed over without a second ticket or a new media request', async () => {
    const f = fixture(); await f.flush(); f.elements.find(el => el.tagName === 'IMG').emit('load'); await f.flush();
    f.tick(5000); await f.flush(); const buffered = f.elements.filter(el => el.tagName === 'IMG')[1]; buffered.emit('load'); await f.flush();
    f.tick(5000); await f.flush();
    assert.equal(f.player.element.querySelector('.sc-media').children[0], buffered);
    assert.equal(f.calls.filter(call => call.route.endsWith('/ticket') && call.body.itemId === 'b').length, 1);
    assert.equal(f.player.element.querySelector('.sc-countdown').textContent, '10'); f.player.close();
});
test('a page in the back-forward cache does not advance its cursor before joining again', async () => {
    const f = fixture(); await f.flush(); f.elements.find(el => el.tagName === 'IMG').emit('load'); await f.flush(); f.tick(2000);
    f.page('pagehide'); f.tick(60000);
    assert.equal(f.player.element.querySelector('.sc-countdown').textContent, '8');
    assert.equal(f.calls.filter(call => call.route.endsWith('/ticket') && call.body.itemId === 'b').length, 0); f.player.close();
});
