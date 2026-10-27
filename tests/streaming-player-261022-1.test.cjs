'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');

class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = { setProperty(name, value) { this[name] = value; } }; this.events = {}; this.paused = true; this.currentTime = 0; this.duration = 120; this.readyState = 0; this.className = ''; this.hidden = false; }
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
function fixture({ deferredTicket = false, kind = 'image', nextKind = 'image', reportStarts = false, pendingPlayback = false, controlledTimeouts = false, onReport, onSeek, size = 0, fetchBytes } = {}) {
    let time = 0, resolveTicket; const calls = [], timers = [], elements = [], recoveries = [];
    const timeouts = new Map(); let timeoutId = 0, reportAttempt = 0;
    const events = new Map(), window = { innerWidth:390, innerHeight:800, addEventListener(name, run) { events.set(name, run); }, removeEventListener(name) { events.delete(name); } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../client/streaming-player.js'), 'utf8'), {
        window, document: { createElement(tag) { const el = new Element(tag); if (pendingPlayback && ['audio','video'].includes(tag)) el.play = () => new Promise(() => {}); elements.push(el); return el; } },
        performance: { now: () => time }, Date, AbortController, URL, Blob, fetch: fetchBytes || (async () => ({ ok: true, text: async () => 'text' })),
        setInterval: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clearInterval() {},
        setTimeout: controlledTimeouts ? (run, ms) => { timeouts.set(++timeoutId, {run, ms}); return timeoutId; } : setTimeout,
        clearTimeout: controlledTimeouts ? id => timeouts.delete(id) : clearTimeout
    });
    const state = { id: 'station', visibility: 'public', loop: true, configVersion: 1, serverTime: 1, manageable: Boolean(onSeek),
        items: [{ id: 'a', name: 'a', kind, start: 0, duration: kind === 'audio' ? 120 : undefined, stay: 10 }, { id: 'b', name: 'b', kind: nextKind, duration: nextKind === 'audio' ? 120 : undefined, stay: 10 }],
        playback: { itemId: 'a', position: 0, status: reportStarts ? 'stopped' : 'playing', version: 1 } };
    const player = window.StreamingPlayer.create({ stationId: 'station', watchId: 'watch', onSeek, onRecovery:code=>recoveries.push(code),
        request: async (route, method, body, options) => { calls.push({ route, body }); if (onReport && route.endsWith('/report')) return onReport({attempt:++reportAttempt, state, options}); if (route.endsWith('/ticket')) {
            if (deferredTicket && body.itemId === 'a') return new Promise(resolve => { resolveTicket = resolve; });
            return { url: '/media/' + body.itemId, expiresAt: Date.now() + 600000, size, type: 'audio/wav' };
        } return reportStarts && route.endsWith('/report') ? { station: { ...state, serverTime: 2, playback: { ...state.playback, status: 'playing', version: 2 } } } : {}; }, subscribe: () => () => {} });
    player.apply(state);
    return { player, state, calls, recoveries, get elements() { return elements.filter(el => !el.src?.startsWith('/client/icons/')); }, flush: async () => { await new Promise(setImmediate); },
        tick(ms) { time += ms; for (const timer of timers) if (timer.ms === 250) timer.run(); },
        timeout(ms) { for (const [id, entry] of [...timeouts]) if (entry.ms === ms) { timeouts.delete(id); entry.run(); } },
        resize(width, height) { window.innerWidth = width; window.innerHeight = height; events.get('resize')?.(); },
        hasEvent(name) { return events.has(name); },
        page(name, event = {}) { events.get(name)?.(event); },
        release() { resolveTicket({ url: '/media/a', expiresAt: Date.now() + 600000 }); } };
}
test('audio starts audible and mute is visibly reported', async () => {
    const f = fixture({ kind: 'audio' }); await f.flush(); const audio = f.elements.find(el => el.tagName === 'AUDIO');
    assert.equal(audio.muted, false);
    const mute = f.elements.find(el => el.tagName === 'BUTTON' && el.textContent === '静音'); mute.onclick();
    assert.match(f.player.element.querySelector('.sc-play-status').textContent, /已静音/); f.player.close();
});

test('page fullscreen rotates without native APIs, retains playback controls, and cleans up on exit', async () => {
    const f = fixture({ kind:'audio' }); await f.flush(); const host = f.player.element;
    let nativeCalls = 0; host.requestFullscreen = () => { nativeCalls++; throw Error('native fullscreen must not be called'); };
    const enter = host.querySelector('.sc-window-only'), rotate = host.querySelector('.sc-rotate-fullscreen'), exit = host.querySelector('.sc-exit-fullscreen');
    const media = f.elements.find(el => el.tagName === 'AUDIO'); media.readyState = 4; media.emit('canplay'); await f.flush();
    enter.onclick(); assert.equal(nativeCalls, 0); assert.equal(host.classList.contains('sc-media-fullscreen'), true); assert.equal(f.hasEvent('resize'), true);
    assert.equal(host.style['--sc-fullscreen-width'], '390px'); assert.equal(host.style['--sc-fullscreen-height'], '800px');
    assert.equal(rotate['aria-label'], '切换横屏'); rotate.onclick();
    assert.equal(host.classList.contains('sc-fullscreen-rotated'), true); assert.equal(host.style['--sc-fullscreen-width'], '800px'); assert.equal(rotate['aria-label'], '切换竖屏');
    const controls = host.querySelector('.sc-local-controls');
    assert.ok(controls.children.some(node => node.dataset.icon === '❚❚')); assert.ok(controls.children.some(node => node.dataset.icon === '🔇'));
    assert.ok(controls.children.some(node => node.tagName === 'LABEL' && node.children.some(child => child.type === 'range')));
    assert.equal(exit.children[0].src, '/client/icons/quit-fullscreen.png'); assert.ok(host.querySelector('.sc-play-status')); assert.ok(host.querySelector('.sc-buffering'));
    assert.equal(media.paused, false, 'presentation changes must not restart or pause playback');
    f.resize(900, 400); assert.equal(host.classList.contains('sc-fullscreen-rotated'), false); assert.equal(host.style['--sc-fullscreen-width'], '900px');
    exit.onclick(); assert.equal(host.classList.contains('sc-media-fullscreen'), false); assert.equal(f.hasEvent('resize'), false);
    enter.onclick(); rotate.onclick(); assert.equal(host.classList.contains('sc-fullscreen-rotated'), true);
    f.player.exitFullscreen(); assert.equal(host.classList.contains('sc-fullscreen-rotated'), false); assert.equal(f.hasEvent('resize'), false);
    enter.onclick(); f.player.close(); assert.equal(host.classList.contains('sc-media-fullscreen'), false); assert.equal(f.hasEvent('resize'), false);
});

test('an administrator pause overrides buffering while a media ticket is still loading', async () => {
    const f = fixture({ deferredTicket: true });
    f.player.apply({ ...f.state, serverTime: 2, playback: { ...f.state.playback, status: 'paused', version: 2, controlVersion: 1 } });
    assert.equal(f.player.element.querySelector('.sc-buffering').textContent, '已被管理员暂停');
    assert.doesNotMatch(f.player.element.querySelector('.sc-play-status').textContent, /缓冲/);
    f.player.close();
});

test('changing local control presentation retains the player and its viewing membership', async () => {
    const f = fixture({ onSeek:async () => {} }); await f.flush();
    const element = f.player.element, ticketCount = f.calls.filter(call => call.route.endsWith('/ticket')).length;
    f.player.setController(undefined); assert.equal(element.querySelector('.sc-seek').hidden, true);
    f.player.setController(async () => {}); assert.equal(element.querySelector('.sc-seek').hidden, false);
    assert.equal(f.player.element, element); assert.equal(f.calls.filter(call => call.route.endsWith('/ticket')).length, ticketCount);
    assert.equal(f.calls.filter(call => call.route.endsWith('/unwatch')).length, 0); f.player.close();
});
test('the first viewer starts from the report response without clicking Start watching', async () => {
    const f = fixture({ kind: 'audio', reportStarts: true }); await f.flush();
    const audio = f.elements.find(el => el.tagName === 'AUDIO'); audio.readyState = 4; audio.emit('canplay'); await f.flush();
    assert.equal(audio.paused, false); assert.equal(audio.muted, false); f.player.close();
});

test('resuming global playback waits visibly for media rather than falsely reporting a global pause', async () => {
    const f = fixture({ kind: 'audio', pendingPlayback: true }); await f.flush();
    f.player.apply({ ...f.state, serverTime: 2, playback: { ...f.state.playback, status: 'paused', version: 2 } });
    const audio = f.elements.find(el => el.tagName === 'AUDIO'); audio.readyState = 4; audio.emit('canplay'); await f.flush();
    f.player.apply({ ...f.state, serverTime: 3, playback: { ...f.state.playback, status: 'playing', version: 3 } });
    assert.doesNotMatch(f.player.element.querySelector('.sc-play-status').textContent, /全台已暂停|已被管理员暂停/);
    assert.equal(f.player.element.querySelector('.sc-buffering').hidden, false);
    assert.equal(f.player.element.querySelector('.sc-buffering').textContent, '正在缓冲'); f.player.close();
});

test('a failed initial viewing report retries before the normal fifteen second heartbeat', async () => {
    const f = fixture({ reportStarts:true, controlledTimeouts:true, onReport:({attempt,state}) => {
        if(attempt===1)throw Error('NETWORK_FAILURE');
        return {station:{...state,serverTime:2,playback:{...state.playback,status:'playing',version:2}}};
    }}); await f.flush(); f.timeout(2000); await f.flush();
    assert.equal(f.calls.filter(call=>call.route.endsWith('/report')).length,2);
    assert.equal(f.player.snapshot().playback.status,'playing');f.player.close();
});

test('a hung viewing report is aborted and cannot block joining forever or retry after close', async () => {
    let signal;const f=fixture({controlledTimeouts:true,onReport:({options})=>new Promise((_resolve,reject)=>{
        signal=options?.signal;signal?.addEventListener('abort',()=>reject(Object.assign(Error('Aborted'),{name:'AbortError'})),{once:true});
    })});await f.flush();f.timeout(10000);await f.flush();
    assert.equal(signal?.aborted,true);f.timeout(2000);await f.flush();
    assert.equal(f.calls.filter(call=>call.route.endsWith('/report')).length,2);f.player.close();
    assert.equal(signal.aborted,true);f.timeout(10000);f.timeout(4000);await f.flush();
    assert.equal(f.calls.filter(call=>call.route.endsWith('/report')).length,2);
});
test('a delayed current ticket is requested once rather than restarted by each clock tick', async () => {
    const f = fixture({ deferredTicket: true });
    assert.equal(f.player.element.querySelector('.sc-buffering').hidden, false);
    for (let i = 0; i < 8; i++) f.tick(250);
    assert.equal(f.calls.filter(call => call.route.endsWith('/ticket') && call.body.itemId === 'a').length, 1);
    f.release(); await f.flush(); f.elements.find(el => el.tagName === 'IMG').emit('load'); await f.flush(); assert.equal(f.player.element.querySelector('.sc-buffering').hidden, true); f.player.close();
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
test('only a controller gets the draggable station progress and seek targets the displayed item', async () => {
    const seeks = [], f = fixture({ kind: 'audio', onSeek: async (...args) => seeks.push(args) }); await f.flush();
    const audio = f.elements.find(el => el.tagName === 'AUDIO'); audio.readyState = 4; audio.emit('canplay'); await f.flush();
    const bar = f.player.element.querySelector('.sc-seek'), slider = bar.children[0]; assert.equal(bar.hidden, false);
    slider.value = 33; slider.oninput(); await slider.onchange(); assert.deepEqual(seeks, [['a', 33]]);
    f.player.apply({ ...f.state, manageable: false, serverTime: 2 }); assert.equal(bar.hidden, true); f.player.close();
});
test('current audio is buffered on this device and switches to its retained bytes only when needed', async () => {
    const requests = [], f = fixture({ kind: 'audio', size: 12, fetchBytes: async (url, options) => { requests.push({ url, options }); return { status: 206, arrayBuffer: async () => new Uint8Array(12).buffer }; } });
    await f.flush(); const audio = f.elements.find(el => el.tagName === 'AUDIO'); audio.readyState = 4; audio.emit('canplay'); await f.flush();
    f.tick(250); await f.flush(); assert.equal(requests.length, 1); assert.equal(requests[0].options.headers.Range, 'bytes=0-11'); assert.equal(audio.src, '/media/a');
    audio.currentTime = 4; audio.emit('waiting'); assert.match(audio.src, /^blob:/); audio.emit('loadedmetadata'); assert.equal(audio.currentTime, 4);
    audio.emit('canplay'); await f.flush(); f.tick(6000); assert.equal(requests.length, 1); f.player.close(); assert.equal(requests[0].options.signal.aborted, true);
});

test('a network error after playback started renews the media ticket and retains the local cursor', async () => {
    const f = fixture({ kind: 'audio' }); await f.flush();
    const audio = f.elements.find(el => el.tagName === 'AUDIO'); audio.readyState = 4; audio.emit('canplay'); await f.flush();
    audio.currentTime = 8; f.tick(250); audio.error = {code:2}; audio.emit('error');
    await f.flush(); f.tick(3000); await f.flush();
    assert.equal(f.calls.filter(call => call.route.endsWith('/ticket') && call.body.itemId === 'a').length, 2, 'an interrupted native request must not leave the viewer stuck until refresh');
    const replacement = f.elements.filter(el => el.tagName === 'AUDIO').at(-1); replacement.readyState=4; replacement.emit('canplay'); await f.flush();
    assert.equal(replacement.currentTime,8); assert.deepEqual(f.recoveries,['STREAM_MEDIA_NETWORK_FAILED']); f.player.close();
});

test('a codec failure is distinguished from source/network failures and does not retry automatically', async () => {
    const f = fixture({ kind:'audio' }); await f.flush();
    const audio=f.elements.find(el=>el.tagName==='AUDIO');audio.error={code:3};audio.emit('error');await f.flush();
    assert.match(f.player.element.querySelector('.sc-play-status').textContent,/STREAM_MEDIA_DECODE_FAILED/);
    f.tick(3000);await f.flush();assert.equal(f.calls.filter(call=>call.route.endsWith('/ticket')).length,1);f.player.close();
});

test('an HTTP access denial hidden by a native media error stops viewing instead of retrying',async()=>{
    let probes=0;const f=fixture({kind:'audio',fetchBytes:async(_url,options)=>{probes++;assert.equal(options.headers.Range,'bytes=0-0');return {ok:false,headers:new Map([['Content-Type','application/json']]),json:async()=>({error:'STREAM_KICKED'})};}});
    await f.flush();const audio=f.elements.find(el=>el.tagName==='AUDIO');audio.readyState=4;audio.emit('canplay');await f.flush();audio.error={code:2};audio.emit('error');await f.flush();
    assert.equal(probes,1,'the initial readiness listener must not diagnose a later failure twice');assert.match(f.player.element.querySelector('.sc-play-status').textContent,/STREAM_KICKED/);
    f.tick(10000);await f.flush();assert.equal(f.calls.filter(call=>call.route.endsWith('/ticket')).length,1);assert.equal(audio.paused,true);f.player.close();
});

test('repeated transient media failures have bounded retries and late diagnosis cannot revive a closed player',async()=>{
    const f=fixture({kind:'audio',fetchBytes:async()=>({ok:false,headers:new Map([['Content-Type','application/json']]),json:async()=>({error:'STREAM_PROVIDER_TIMEOUT'})})});await f.flush();
    for(let attempt=0;attempt<4;attempt++){const audio=f.elements.filter(el=>el.tagName==='AUDIO').at(-1);audio.error={code:2};audio.emit('error');await f.flush();f.tick(2000*2**attempt);await f.flush();}
    assert.equal(f.calls.filter(call=>call.route.endsWith('/ticket')).length,4);f.player.close();
    let release;const closed=fixture({kind:'audio',fetchBytes:()=>new Promise(resolve=>{release=()=>resolve({ok:false,headers:new Map([['Content-Type','application/json']]),json:async()=>({error:'STREAM_PROVIDER_TIMEOUT'})});})});
    await closed.flush();closed.elements.find(el=>el.tagName==='AUDIO').emit('error');closed.player.close();release();await closed.flush();closed.tick(10000);await closed.flush();
    assert.equal(closed.calls.filter(call=>call.route.endsWith('/ticket')).length,1);
});

test('handover to a ready prefetched audio does not read the temporarily detached media cursor',async()=>{
    let reads=0;const f=fixture({kind:'audio',nextKind:'audio',size:12,fetchBytes:async()=>{reads++;return {status:206,arrayBuffer:async()=>new Uint8Array(12).buffer};}});await f.flush();
    const first=f.elements.find(el=>el.tagName==='AUDIO');first.readyState=4;first.emit('canplay');await f.flush();f.tick(250);await f.flush();
    first.currentTime=119;f.tick(250);await f.flush();const next=f.elements.filter(el=>el.tagName==='AUDIO').at(-1);next.readyState=4;next.emit('canplay');await f.flush();
    first.currentTime=120;f.tick(250);await f.flush();f.tick(250);await f.flush();
    assert.equal(f.player.element.querySelector('.sc-media').children[0],next);assert.equal(reads,2);f.player.close();
});
