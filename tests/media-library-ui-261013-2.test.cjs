'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('client/media-library.js', 'utf8');
const turn = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class Node {
    constructor(tag = 'div', text = '') { this.tagName = tag.toUpperCase(); this.textContent = text; this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.value = ''; this.isConnected = true;
        this.classList = { toggle() {}, add() {}, remove() {} }; }
    append(...nodes) { this.children.push(...nodes); } add(node) { this.append(node); if (this.children.length === 1) this.value = node.value; }
    replaceChildren(...nodes) { this.children = nodes; } setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(key, fn) { (this.listeners[key] ||= new Set()).add(fn); } removeEventListener(key, fn) { this.listeners[key]?.delete(fn); }
    emit(key, ...args) { for (const fn of this.listeners[key] || []) fn(...args); }
    pause() { this.paused=true; }
    play() { this.paused=false;this.playCalls=(this.playCalls||0)+1;return Promise.resolve(); }
    load() { this.loadCalls=(this.loadCalls||0)+1;this.readyState=1;this.currentTime=0;this.duration=this.src?.includes('/cache/')?2:10; }
    querySelectorAll(selector) { return this.children.flatMap(n => [n, ...n.querySelectorAll(selector)]).filter(n => selector === 'button' && n.tagName === 'BUTTON'); }
    querySelector() { return null; }
}
function fixture(handler = async () => ({})) {
    const ids = new Map(); const get = id => ids.get(id) || null;
    for (const id of ['ml-main', 'ml-notice', 'ml-dialog', 'ml-results']) ids.set(id, new Node());
    const calls = [], opened = [], window = { open() { const page = { opener: window, location: { replace(url) { page.url = url; } }, close() { page.closed = true; } }; opened.push(page); return page; } };
    const intervals=[],prompts=[];
    const context = vm.createContext({ window, document: { getElementById: get, createElement: tag => new Node(tag), querySelectorAll: () => [], activeElement: null },
        Option: class extends Node { constructor(text, value) { super('option', text); this.value = value; } }, URL, URLSearchParams, location: { origin: 'http://localhost' },
        prompt: (...args) => {prompts.push(args);return '立即出现的新会话';}, setTimeout, clearTimeout, setInterval: fn => {intervals.push(fn);return intervals.length;},clearInterval(){}, requestAnimationFrame: fn => fn(), AbortController, DOMException,
        fetch: async (route, options) => { calls.push({ route, options }); const value = await handler(route, options); return { ok: true, json: async () => value }; } });
    const end = source.lastIndexOf("    document.querySelectorAll('[data-tab]')");
    vm.runInContext(source.slice(0, end) + `
        window.test = { refresh, collectCandidate, seekMediaFrame, waitMediaMetadata, renderResults, renderImports, renderSessions, rememberRecord,
            set(value) { data = value; }, setSession(id) { sessionId = id; }, setTab(value) { tab=value; }, data() { return data; }, changeTab,
            stubRender(fn) { render = fn; } };
    })();`, context);
    return { ...window.test, ids, calls, opened, window, intervals, prompts };
}
const snapshot = () => ({ config: { workspace: {}, collection: {} }, imports: [{ id: 'video', name: '视频', state: 'ready', duration: 10 }],
    sessions: [{ id: 'old', name: '旧会话', state: 'active' }], results: [], collections: [], jobs: [], caches: [], events: [] });

test('creating a session renders the returned session immediately; an older poll cannot erase it', async () => {
    const slow = deferred(), state = snapshot(), created = { id: 'new', name: '新会话', state: 'active', importId: 'video' }; let reads = 0;
    const f = fixture(async route => route.endsWith('/sessions') ? created : ++reads === 1 ? slow.promise : { ...snapshot(), sessions: [created, ...snapshot().sessions] });
    f.set(state); let rendered;
    f.stubRender(() => { rendered = f.data().sessions.map(s => s.id); });
    const polling = f.refresh();
    const entry = f.renderImports().querySelectorAll('button').find(n => n.textContent === '新建提取会话');
    await entry.onclick(); assert.ok(rendered.includes('new')); assert.equal(f.data().sessions[0].id, 'new'); assert.equal(f.prompts[0][1],state.imports[0].name);
    slow.resolve(snapshot()); await polling; await turn();
    assert.equal(f.data().sessions[0].id, 'new');
    assert.equal(f.calls.filter(c => c.route.endsWith('/state')).length, 2);
});

test('forced refresh waits for an existing poll and performs a fresh read rather than silently skipping it', async () => {
    const slow = deferred(); let reads = 0;
    const f = fixture(async () => ++reads === 1 ? slow.promise : { ...snapshot(), sessions: [{ id: 'new', state: 'active' }] });
    const first = f.refresh(), second = f.refresh(true); slow.resolve(snapshot()); await Promise.all([first, second]);
    assert.equal(reads, 2); assert.equal(f.data().sessions[0].id, 'new');
});

test('download page opens before the asynchronous link request and preserves signed passthrough parameters', async () => {
    const slow = deferred(), f = fixture(async () => slow.promise); f.set(snapshot());
    const button = f.renderImports().querySelectorAll('button').find(n => n.textContent === '去原下载页创建任务');
    const pending = button.onclick(); assert.equal(f.opened.length, 1); assert.equal(f.opened[0].opener, null);
    slow.resolve({ url: '/sns-dl?media_import=id&media_bind=token&url=https%3A%2F%2Fexample.test' }); await pending;
    assert.match(f.opened[0].url, /^http:\/\/localhost\/sns-dl\?media_import=id&media_bind=token/);
});

test('queued Clip card appears before completion; the same task becomes a result without duplicate cards', () => {
    const f = fixture(), state = snapshot(); f.set(state); f.setSession('old');
    f.rememberRecord('jobs', { id: 'clip', type: 'clip', state: 'queued', progress: 0, context: { sessionId: 'old', start: 1, end: 2 } });
    f.renderResults(); let cards = f.ids.get('ml-results').children; assert.equal(cards.length, 1); assert.equal(cards[0].dataset.jobId, 'clip');
    f.rememberRecord('results', { id: 'clip', kind: 'clip', sessionId: 'old', startMs: 1000, endMs: 2000, cacheReady: true });
    f.renderResults(); cards = f.ids.get('ml-results').children; assert.equal(cards.length, 1); assert.equal(cards[0].dataset.resultId, 'clip');
});

test('per-card collection needs no checkbox and renders progress; navigation link exists only after confirmed disk save', async () => {
    const slow = deferred(), f = fixture(async () => slow.promise), state = snapshot();
    state.results = [{ id: 'clip', kind: 'clip', sessionId: 'old', cacheReady: true }]; f.set(state); f.setSession('old'); f.renderResults();
    const button = f.ids.get('ml-results').querySelectorAll('button').find(n => n.attrs['aria-label'] === '收藏');
    const pending = button.onclick(); await turn(); assert.equal(f.calls.length, 1); assert.match(f.calls[0].route, /\/results\/clip\/collect$/);
    slow.resolve({ id: 'saved', resultId: 'clip', state: 'queued' }); await pending;
    let info = f.ids.get('ml-results').children[0].children.at(-1); assert.ok(info.children.some(n => n.textContent.includes('收藏到网盘')));
    assert.equal(info.children.at(-1).children.some(n => n.tagName === 'A' && n.textContent === '▤'), false);
    f.rememberRecord('collections', { id: 'saved', resultId: 'clip', state: 'ready', location: { path: 'collection' }, file: { userId: 'alice', diskSpace: '中文分区', fileId: 'file' } });
    f.renderResults(); info = f.ids.get('ml-results').children[0].children.at(-1);
    const link = info.children.at(-1).children.find(n => n.tagName === 'A' && n.textContent === '▤'); assert.ok(link); const params = new URL(link.href, 'http://localhost').searchParams;
    assert.equal(params.get('disk_account'), 'alice'); assert.equal(params.get('disk_space'), '中文分区'); assert.equal(params.get('disk_file'), 'file');
});

test('frame seek resolves only after seeked and the requested decoded frame is presented', async () => {
    const f = fixture(), video = new Node('video'); let next, cancelled;
    video.requestVideoFrameCallback = callback => { next = callback; return 1; }; video.cancelVideoFrameCallback = id => { cancelled = id; };
    let done = false; const seeking = f.seekMediaFrame(video, .46, .44).then(() => { done = true; });
    video.emit('seeked'); next(0, { mediaTime: .4 }); await turn(); assert.equal(done, false);
    next(0, { mediaTime: .44 }); await seeking; assert.equal(video.currentTime, .46); assert.equal(cancelled, 1);
});

test('metadata readiness precedes seeking and source switches cancel pending metadata/frame waits', async () => {
    const f=fixture(),video=new Node('video');video.readyState=0;
    let ready=false;const metadata=f.waitMediaMetadata(video).then(()=>{ready=true;});await turn();assert.equal(ready,false);
    video.readyState=1;video.emit('loadedmetadata');await metadata;assert.equal(ready,true);
    const abort=new AbortController(),seek=f.seekMediaFrame(video,.46,.44,abort.signal);abort.abort();await assert.rejects(seek,{name:'AbortError'});
    video.readyState=0;const stop=new AbortController(),waiting=f.waitMediaMetadata(video,stop.signal);stop.abort();await assert.rejects(waiting,{name:'AbortError'});
    assert.equal(video.listeners.seeked.size,0);assert.equal(video.listeners.loadedmetadata.size,0);
});

test('work segment shows return action only on completion; overlapping polls cannot reload it after returning to the original',async()=>{
    const state=snapshot();state.sessions[0].importId='video';state.jobs=[{id:'segment',state:'completed',result:{cacheId:'cached-segment'}}];
    const completed=structuredClone(state);
    const f=fixture(async route=>route.endsWith('/segment')?{id:'segment',state:'queued',context:{start:.37}}:completed);f.set(state);f.setSession('old');f.setTab('sessions');
    const panel=f.renderSessions(),buttons=panel.querySelectorAll('button'),original=buttons.find(n=>n.textContent==='返回原视频');
    const descendants=n=>[n,...n.children.flatMap(descendants)];const player=descendants(panel).find(n=>n.tagName==='VIDEO');
    assert.equal(original.hidden,true);await buttons.find(n=>n.textContent==='缓存工作片段并播放').onclick();assert.equal(original.hidden,true);
    await Promise.all([f.intervals[0](),f.intervals[0]()]);assert.equal(player.loadCalls,1);assert.match(player.src,/\/cache\/cached-segment$/);assert.equal(original.hidden,false);
    player.currentTime=.5;await original.onclick();assert.match(player.src,/\/files\/video$/);assert.equal(player.duration,10);assert.equal(player.loadCalls,2);assert.equal(original.hidden,true);
    assert.ok(Math.abs(player.currentTime-.87)<1e-9);
    await f.intervals[0]();assert.equal(player.loadCalls,2,'a late completion cannot switch back to the segment');
});

test('work segment feedback appears while submitting and follows real queued/running/cancelled progress near its button', async () => {
    const gate=deferred(), state=snapshot(); state.sessions[0].importId='video'; let remote={...snapshot(),jobs:[]};
    const f=fixture(async route=>route.endsWith('/segment')?gate.promise:remote); f.set(state);f.setSession('old');f.setTab('sessions');
    const panel=f.renderSessions(), descendants=n=>[n,...n.children.flatMap(descendants)];
    const action=panel.querySelectorAll('button').find(n=>n.textContent==='缓存工作片段并播放'), feedback=descendants(panel).find(n=>n.className==='ml-segment-feedback');
    const submitted=action.onclick(); assert.equal(feedback.hidden,false);assert.match(feedback.children[1].textContent,/提交/);
    gate.resolve({id:'segment',state:'queued',progress:0,context:{start:0}});await submitted;assert.match(feedback.children[0].textContent,/排队中.*0%/);
    remote={...snapshot(),jobs:[{id:'segment',state:'running',progress:42,detail:'正在完整解码检查输出片段'}]};await f.intervals[0]();
    assert.match(feedback.children[0].textContent,/42%/);assert.match(feedback.children[1].textContent,/解码/);
    remote={...snapshot(),jobs:[{id:'segment',state:'cancelled',progress:42,message:'用户已取消'}]};await f.intervals[0]();assert.match(feedback.children[0].textContent,/已取消/);
});

test('range preview starts playback on the first click and stops at the selected end',async()=>{
    const state=snapshot();state.sessions[0].importId='video';const f=fixture();f.set(state);f.setSession('old');f.setTab('sessions');
    const panel=f.renderSessions(),descendants=n=>[n,...n.children.flatMap(descendants)],player=descendants(panel).find(n=>n.tagName==='VIDEO');player.readyState=1;player.duration=10;
    const action=panel.querySelectorAll('button').find(n=>n.textContent==='预览选定范围');await action.onclick();assert.equal(player.playCalls,1);assert.equal(player.paused,false);
    const feedback=descendants(panel).find(n=>n.className==='ml-preview-feedback ml-segment-feedback');assert.equal(feedback.hidden,true);assert.equal(feedback.textContent,'');player.currentTime=10;player.emit('timeupdate');assert.equal(player.paused,true);
});
