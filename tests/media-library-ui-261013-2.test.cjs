'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('client/media-library.js', 'utf8');
const turn = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class Node {
    constructor(tag = 'div', text = '') { this.tagName = tag.toUpperCase(); this.textContent = text; this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.value = ''; this.isConnected = true;
        this.style = { setProperty(key,value) { this[key] = value; } };
        const classes = () => new Set((this.className || '').split(' ').filter(Boolean));
        this.classList = { contains: name => classes().has(name), add: name => { const values = classes(); values.add(name); this.className = [...values].join(' '); },
            remove: name => { const values = classes(); values.delete(name); this.className = [...values].join(' '); }, toggle: (name,on) => { const values = classes(); const enabled = on ?? !values.has(name); enabled ? values.add(name) : values.delete(name); this.className = [...values].join(' '); return enabled; } }; }
    append(...nodes) { this.children.push(...nodes); for (const node of nodes) node.parentNode = this; } add(node) { this.append(node); if (this.children.length === 1) this.value = node.value; }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); } setAttribute(key, value) { this.attrs[key] = value; }
    get firstChild() { return this.children[0]; } get firstElementChild() { return this.children[0]; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(n => n !== this); }
    replaceWith(node) { const index = this.parentNode.children.indexOf(this); this.parentNode.children[index] = node; node.parentNode = this.parentNode; }
    insertBefore(node, anchor) { node.remove(); const index = this.children.indexOf(anchor); this.children.splice(index < 0 ? this.children.length : index, 0, node); node.parentNode = this; }
    showModal() { this.open = true; } close() { this.open = false; this.emit('close'); }
    addEventListener(key, fn) { (this.listeners[key] ||= new Set()).add(fn); } removeEventListener(key, fn) { this.listeners[key]?.delete(fn); }
    emit(key, ...args) { for (const fn of this.listeners[key] || []) fn(...args); }
    pause() { this.paused=true; }
    play() { this.paused=false;this.playCalls=(this.playCalls||0)+1;return Promise.resolve(); }
    load() { this.loadCalls=(this.loadCalls||0)+1;this.readyState=1;this.currentTime=0;this.duration=this.src?.includes('/cache/')?2:10; }
    querySelectorAll(selector) {
        const all = this.children.flatMap(n => [n, ...n.querySelectorAll('*')]);
        return all.filter(n => {
            const cls = selector.match(/\.([\w-]+)/)?.[1], tag = selector.match(/^[a-z]+/)?.[0];
            const attr = selector.match(/\[data-([\w-]+)(?:="([^"]*)")?\]/);
            return (!tag || n.tagName === tag.toUpperCase()) && (!cls || (n.className || '').split(' ').includes(cls)) && (!attr || n.dataset[attr[1].replace(/-([a-z])/g, (_,v) => v.toUpperCase())] === (attr[2] ?? n.dataset[attr[1].replace(/-([a-z])/g, (_,v) => v.toUpperCase())]) && n.dataset[attr[1].replace(/-([a-z])/g, (_,v) => v.toUpperCase())] !== undefined);
        });
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function fixture(handler = async () => ({})) {
    const ids = new Map(); const get = id => ids.get(id) || null;
    for (const id of ['ml-main', 'ml-notice', 'ml-dialog', 'ml-results', 'ml-dialog-body', 'ml-dialog-title', 'ml-dialog-actions', 'ml-frames-dialog', 'ml-frames-title', 'ml-frame-progress', 'ml-frame-batches', 'ml-frame-grid', 'ml-frame-count', 'ml-frame-action-status']) ids.set(id, new Node());
    const calls = [], opened = [], window = { open() { const page = { opener: window, location: { replace(url) { page.url = url; } }, close() { page.closed = true; } }; opened.push(page); return page; } };
    const intervals=[],prompts=[],confirmations=[];
    const body = new Node('body');
    const context = vm.createContext({ window, document: { body, getElementById: get, createElement: tag => new Node(tag), querySelectorAll: () => [], activeElement: null },
        Option: class extends Node { constructor(text, value) { super('option', text); this.value = value; } }, URL, URLSearchParams, location: { origin: 'http://localhost' },
        prompt: (...args) => {prompts.push(args);return '立即出现的新会话';}, setTimeout, clearTimeout, setInterval: fn => {intervals.push(fn);return intervals.length;},clearInterval(){}, requestAnimationFrame: fn => fn(), AbortController, DOMException,
        confirm: text => {confirmations.push(text);return true;},
        fetch: async (route, options) => { calls.push({ route, options }); const value = await handler(route, options); return { ok: !value?.fixtureStatus || value.fixtureStatus<400, json: async () => value }; } });
    const end = source.lastIndexOf("    document.querySelectorAll('[data-tab]')");
    vm.runInContext(source.slice(0, end) + `
        window.test = { dialog, openFramePreview, refresh, collectCandidate, collectCompressedVersion, compressionViewer, renderCompressionView, transcodeDialog, submitFrames, openFrameGallery, renderFrameGallery, seekMediaFrame, waitMediaMetadata, renderResults, renderImports, renderSessions, rememberRecord, deleteCandidates,
            selectFrames(ids) {for(const id of ids)frameSelection.add(id);},
            set(value) { data = value; }, setSession(id) { sessionId = id; }, setTab(value) { tab=value; }, data() { return data; }, changeTab,
            setView(value) { resultView=value; },
            stubRender(fn) { render = fn; } };
    })();`, context);
    return { ...window.test, ids, calls, opened, window, intervals, prompts, confirmations, body };
}
const snapshot = () => ({ config: { workspace: {}, collection: {} }, imports: [{ id: 'video', name: '视频', state: 'ready', duration: 10 }],
    sessions: [{ id: 'old', name: '旧会话', state: 'active' }], batches: [], results: [], collections: [], jobs: [], caches: [], events: [] });

test('deleted Clip results do not resurrect completed job placeholders; queued and failed jobs remain visible',()=>{
    const f=fixture(),state=snapshot();state.jobs=['completed','queued','failed'].map(status=>({id:status,type:'clip',state:status,context:{sessionId:'old',start:3,end:6},progress:status==='completed'?100:0}));
    f.set(state);f.setSession('old');f.renderResults();assert.deepEqual(f.ids.get('ml-results').children.map(row=>row.dataset.jobId),['queued','failed']);
});

test('screenshot label and timestamp each toggle once and stop propagation; checkbox retains native change handling',()=>{
    const f=fixture(),state=snapshot();state.results=[{id:'image',sessionId:'old',kind:'image',cacheReady:true,cacheId:'cache',actualMs:0}];f.set(state);f.openFrameGallery('old');
    const row=f.ids.get('ml-frame-grid').children[0],info=row.children[1],caption=info.children[0],checkbox=caption.children[0],timestamp=info.children[1];let stopped=0,prevented=0;
    const event=()=>({stopPropagation(){stopped++;},preventDefault(){prevented++;}});
    caption.onclick(event());assert.equal(checkbox.checked,true);timestamp.onclick(event());assert.equal(checkbox.checked,false);
    checkbox.checked=true;checkbox.onclick(event());checkbox.onchange(event());assert.equal(checkbox.checked,true);assert.equal(stopped,4);assert.equal(prevented,2);
});

test('bulk deletion confirms once, continues after a busy item, keeps failed selection and reports actual outcomes',async()=>{
    const state=snapshot();state.results=['a','blocked','c'].map(id=>({id,sessionId:'old',kind:'image',cacheReady:true,cacheId:id,actualMs:0}));
    const f=fixture(async(route,options)=>{if(options?.method==='DELETE'&&route.endsWith('/blocked'))return {fixtureStatus:409,error:'MEDIA_CACHE_IN_USE'};return route.endsWith('/state')?state:{};});
    f.set(state);f.setSession('old');f.openFrameGallery('old');f.selectFrames(['a','blocked','c']);
    const result=await f.deleteCandidates([...state.results]);assert.equal(result.deleted,2);assert.equal(result.failed.length,1);assert.equal(f.confirmations.length,1);
    assert.deepEqual(state.results.map(item=>item.id),['blocked']);assert.match(f.ids.get('ml-frame-count').textContent,/已选 1 张/);assert.match(f.ids.get('ml-frame-action-status').textContent,/已删除 2\/3/);
});

test('single-image preview exposes collection/delete actions and advances after deletion, closing only when no images remain',async()=>{
    const state=snapshot();state.results=['a','b'].map((id,i)=>({id,sessionId:'old',kind:'image',cacheReady:true,cacheId:id,actualMs:i*1000}));
    const f=fixture(async route=>route.endsWith('/state')?state:{});f.set(state);f.setSession('old');f.openFrameGallery('old');f.openFramePreview(state.results[0]);
    const modal=f.ids.get('ml-dialog'),actions=f.ids.get('ml-dialog-actions');assert.equal(actions.children[3].attrs['aria-label'],'收藏截图');
    await actions.children[4].onclick();assert.equal(modal.open,true);assert.match(f.ids.get('ml-dialog-body').children[0].children[0].src,/b$/);
    await actions.children[4].onclick();assert.equal(modal.open,false);assert.equal(f.ids.get('ml-frames-dialog').open,true);
});

test('screenshot preview navigates the session timeline by keyboard/buttons/swipes and disposes handlers on close or replacement', async () => {
    const f = fixture(), state = snapshot();
    state.results = [
        {id:'late',sessionId:'old',kind:'image',actualMs:2000,cacheId:'late-cache',cacheReady:true},
        {id:'first',sessionId:'old',kind:'image',actualMs:0,cacheId:'first-cache',cacheReady:true},
        {id:'expired',sessionId:'old',kind:'image',actualMs:500,cacheReady:false},
        {id:'middle',sessionId:'old',kind:'image',actualMs:1000,cacheId:'middle-cache',cacheReady:true},
        {id:'reference',sessionId:'old',kind:'image',actualMs:1500,cacheReady:true,reference:true},
        {id:'other',sessionId:'other',kind:'image',actualMs:1500,cacheReady:true}
    ]; f.set(state); f.openFramePreview(state.results[1]);
    const modal = f.ids.get('ml-dialog'), stage = f.ids.get('ml-dialog-body').children[0], image = stage.children[0], actions = f.ids.get('ml-dialog-actions');
    const previous = actions.children[1], next = actions.children[2], key = (value,target) => modal.emit('keydown',{key:value,target,preventDefault(){}});
    assert.equal(previous.disabled,true); assert.equal(actions.children[0].textContent,'1 / 3');
    await next.onclick(); assert.match(image.src,/middle-cache$/); key('ArrowRight'); assert.match(image.src,/late-cache$/); assert.equal(next.disabled,true);
    key('ArrowLeft',{tagName:'INPUT'}); assert.match(image.src,/late-cache$/);
    const point = (x,y=0) => ({isPrimary:true,pointerType:'touch',pointerId:1,clientX:x,clientY:y});
    stage.onpointerdown(point(0)); stage.onpointerup(point(100)); assert.match(image.src,/middle-cache$/);
    stage.onpointerdown(point(0)); stage.onpointerup(point(20,100)); assert.match(image.src,/middle-cache$/);
    stage.onpointerdown(point(100)); stage.onpointercancel(); stage.onpointerup(point(0)); assert.match(image.src,/middle-cache$/);
    await previous.onclick(); assert.match(image.src,/first-cache$/); assert.equal(previous.disabled,true);
    modal.close(); assert.equal(modal.listeners.keydown.size,0); assert.equal(modal.classList.contains('ml-image-dialog'),false);
    f.openFramePreview(state.results[2+1]); f.dialog('其它操作',new Node()); assert.equal(modal.listeners.keydown.size,0);
    assert.equal(modal.classList.contains('ml-image-dialog'),false);
});

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
    let info = f.ids.get('ml-results').children[0]; assert.ok(info.querySelector('.ml-collection-progress').textContent.includes('收藏到网盘'));
    assert.equal(info.querySelectorAll('a').some(n => n.textContent === '▤'), false);
    f.rememberRecord('collections', { id: 'saved', resultId: 'clip', state: 'ready', location: { path: 'collection' }, file: { userId: 'alice', diskSpace: '中文分区', fileId: 'file' } });
    f.renderResults(); info = f.ids.get('ml-results').children[0];
    const link = info.querySelectorAll('a').find(n => n.textContent === '▤'); assert.ok(link); const params = new URL(link.href, 'http://localhost').searchParams;
    assert.equal(params.get('disk_account'), 'alice'); assert.equal(params.get('disk_space'), '中文分区'); assert.equal(params.get('disk_file'), 'file');
});

test('frame seek resolves only after seeked and the requested decoded frame is presented', async () => {
    const f = fixture(), video = new Node('video'); let next, cancelled;
    video.requestVideoFrameCallback = callback => { next = callback; return 1; }; video.cancelVideoFrameCallback = id => { cancelled = id; };
    let done = false; const seeking = f.seekMediaFrame(video, .46, .44).then(() => { done = true; });
    video.emit('seeked'); next(0, { mediaTime: .4 }); await turn(); assert.equal(done, false);
    next(0, { mediaTime: .44 }); await seeking; assert.equal(video.currentTime, .46); assert.equal(cancelled, 1);
});

test('Clip list has two structural rows with inline remarks and right-hand actions; generation detail disappears on completion', () => {
    const f = fixture(), state = snapshot(); f.set(state); f.setSession('old'); f.setView('list');
    const job = { id: 'clip-new', type: 'clip', state: 'running', createdAt: 123, context: { sessionId: 'old', start: 767, end: 794 }, progress: 42, detail: '正在截取视频' };
    state.jobs.push(job); f.renderResults();
    let card = f.ids.get('ml-results').children[0]; assert.equal(card.children[0].children.length, 2);
    assert.match(card.querySelector('.ml-collection-progress').textContent, /42%.*正在截取视频/);
    state.results.push({ id: job.id, kind: 'clip', sessionId: 'old', startMs: 767000, endMs: 794000, extractedAt: 123, cacheReady: true, version: 1 }); f.renderResults();
    card = f.ids.get('ml-results').children[0]; assert.equal(f.ids.get('ml-results').children.length, 1);
    assert.equal(card.children[0].children.length, 2); assert.equal(card.querySelector('.ml-clip-remark').children[0].tagName, 'INPUT');
    assert.match(card.querySelector('label').children[1].textContent, /Clip 00:12:47.000～00:13:14.000/);
    assert.equal(card.querySelector('.ml-collection-progress').textContent, '未收藏');
    assert.equal(card.querySelector('.ml-actions').children.at(-1).textContent, '压缩');
});

test('a dirty Clip remark survives polling while collection feedback and its disk link still update', () => {
    const f = fixture(), state = snapshot(); f.set(state); f.setSession('old'); f.setView('list');
    const clip = { id: 'clip', kind: 'clip', sessionId: 'old', cacheReady: true }; state.results.push(clip); f.renderResults();
    const card = f.ids.get('ml-results').children[0], note = card.querySelector('.ml-clip-remark').children[0]; note.value = '正在输入，不能丢失'; note.oninput();
    state.collections.push({ id: 'saved', resultId: clip.id, state: 'ready', location: {}, file: { userId: 'alice', fileId: 'disk-file' } });
    f.renderResults(); f.renderResults();
    assert.equal(f.ids.get('ml-results').children[0], card); assert.equal(note.value, '正在输入，不能丢失');
    assert.match(card.querySelector('.ml-collection-progress').textContent, /已收藏/);
    assert.equal(card.querySelectorAll('a').filter(n => n.textContent === '▤').length, 1);
});

test('editing a remark does not freeze another Clip generation card or leave its completed progress visible', () => {
    const f = fixture(), state = snapshot(); f.set(state); f.setSession('old'); f.setView('list');
    state.results.push({ id: 'edited', kind: 'clip', sessionId: 'old', cacheReady: true });
    state.jobs.push({ id: 'next', type: 'clip', state: 'queued', context: { sessionId: 'old', start: 1, end: 2 }, progress: 0 }); f.renderResults();
    const box = f.ids.get('ml-results').querySelector('[data-result-id="edited"]'), note = box.querySelector('.ml-clip-remark').children[0]; note.value = '保留草稿'; note.oninput();
    state.jobs[0].state = 'running'; state.jobs[0].progress = 62; state.jobs[0].detail = '生成中'; f.renderResults();
    assert.match(f.ids.get('ml-results').querySelector('[data-job-id="next"]').querySelector('.ml-collection-progress').textContent, /62%/);
    state.results.push({ id: 'next', kind: 'clip', sessionId: 'old', cacheReady: true, startMs: 1000, endMs: 2000 }); f.renderResults();
    assert.equal(f.ids.get('ml-results').querySelector('[data-job-id="next"]'), null);
    assert.equal(f.ids.get('ml-results').querySelector('[data-result-id="edited"]'), box); assert.equal(note.value, '保留草稿');
    assert.equal(f.ids.get('ml-results').querySelector('[data-result-id="next"]').querySelector('.ml-collection-progress').textContent, '未收藏');
});

test('compression collection immediately reports submission, real upload progress and final disk destination without resetting playback', async () => {
    const slow = deferred(), f = fixture(async () => slow.promise), state = snapshot(), variant = { id: 'variant', resultId: 'clip', cacheReady: true, cacheId: 'cache', quality: { width: 320, height: 180 }, ordinal: 1 };
    state.compressions = [variant]; f.set(state); f.compressionViewer({ id: 'clip' });
    const body = f.ids.get('ml-dialog-body'), video = body.querySelector('video'), button = body.querySelector('[data-compression-collect]');
    const pending = button.onclick(); assert.equal(button.disabled, true); assert.match(body.querySelector('.ml-compression-collection').children[0].textContent, /正在提交/);
    slow.resolve({ id: 'collection', compressionId: variant.id, state: 'queued' }); await pending; assert.equal(button.disabled, true);
    state.collections[0].state = 'transferring'; state.jobs.push({ id: 'job', type: 'collect', createdAt: 1, context: { collectionId: 'collection' }, state: 'running', progress: 46, detail: '正在上传正文', totalBytes: 1000, telegramBytesSent: 460, telegramBytesConfirmed: 200 });
    f.renderCompressionView(); assert.equal(body.querySelector('video'), video); assert.equal(body.querySelector('progress').value, 46);
    assert.match(body.querySelector('.ml-compression-collection').children[0].textContent, /正在上传正文/);
    state.collections[0] = { ...state.collections[0], state: 'ready', location: { path: 'collection' }, file: { userId: 'alice', diskSpace: '', fileId: 'file' } };
    f.renderCompressionView(); const line = body.querySelector('.ml-compression-collection'), link = line.querySelector('a');
    assert.match(link.textContent, /在网盘中查看/); assert.equal(new URL(link.href, 'http://local').searchParams.get('disk_file'), 'file');
    assert.equal(body.querySelector('video'), video); assert.equal(button.disabled, true); assert.equal(button.attrs['aria-busy'], 'false');
    assert.equal(body.querySelector('.ml-compression-metadata').children[1], line);
});

test('compression collection submission errors stop the busy state and allow retry', async () => {
    const f = fixture(async () => { throw Error('上传失败'); }), state = snapshot();
    state.compressions = [{ id: 'v', resultId: 'clip', cacheReady: true, quality: {}, ordinal: 1 }]; f.set(state); f.compressionViewer({ id: 'clip' });
    const body = f.ids.get('ml-dialog-body'), save = body.querySelector('[data-compression-collect]'); await save.onclick();
    assert.equal(save.disabled, false); assert.equal(save.attrs['aria-busy'], 'false');
    assert.match(body.querySelector('.ml-compression-collection').children[0].textContent, /转存失败.*上传失败/);
});

test('screenshots have a dedicated time-ordered gallery, independent Clip selection and toggleable batch colors', async () => {
    const f = fixture(), state = snapshot(); f.set(state); f.setSession('old');
    state.batches.push({ id: 'b2', sessionId: 'old', ordinal: 2, createdAt: 2, state: 'completed' }, { id: 'b1', sessionId: 'old', ordinal: 1, createdAt: 1, state: 'completed' });
    state.results.push({ id: 'late', kind: 'image', sessionId: 'old', batchId: 'b1', actualMs: 5000, cacheReady: true }, { id: 'clip', kind: 'clip', sessionId: 'old', cacheReady: true },
        { id: 'early', kind: 'image', sessionId: 'old', batchId: 'b2', actualMs: 1000, cacheReady: true }, { id: 'middle', kind: 'image', sessionId: 'old', batchId: 'b1', actualMs: 3000, cacheReady: true },
        { id: 'foreign', kind: 'image', sessionId: 'another', actualMs: 0, cacheReady: true });
    f.renderResults(); assert.deepEqual(f.ids.get('ml-results').children.map(row => row.dataset.resultId), ['clip']); f.openFrameGallery('old');
    const grid = f.ids.get('ml-frame-grid'), tiles = f.ids.get('ml-frame-batches');
    assert.deepEqual(grid.children.map(row => row.dataset.resultId), ['early','middle','late']);
    assert.deepEqual(grid.children.map(row => row.querySelector('.ml-frame-batch-marker').textContent), ['批次 2','批次 1','批次 1']);
    await tiles.children[0].onclick(); assert.equal(grid.children[0].classList.contains('batch-highlighted'), false); assert.equal(grid.children[1].classList.contains('batch-highlighted'), true);
    await tiles.children[1].onclick(); assert.ok(grid.children.every(row => row.classList.contains('batch-highlighted')));
    await tiles.children[0].onclick(); assert.equal(grid.children[1].classList.contains('batch-highlighted'), false); assert.equal(grid.children[0].classList.contains('batch-highlighted'), true);
    assert.notEqual(grid.children[0].style['--ml-batch-color'], grid.children[1].style['--ml-batch-color']);
    const choose = grid.children[0].querySelector('input'); choose.checked = true; choose.onchange(); assert.match(f.ids.get('ml-frame-count').textContent, /已选 1/);
    f.renderResults(); assert.equal(f.ids.get('ml-results').querySelector('input').checked, false);
});

test('submitting extraction opens the gallery immediately, reports progress, and flashes only new frames once the batch completes', async () => {
    const slow = deferred(), f = fixture(async () => slow.promise), state = snapshot(); f.set(state); f.setSession('old');
    state.batches.push({ id: 'old-batch', sessionId: 'old', createdAt: 1, state: 'completed' }); state.results.push({ id: 'existing', kind: 'image', sessionId: 'old', batchId: 'old-batch', actualMs: 0, cacheReady: true });
    const pending = f.submitFrames('old', { count: 1 }); assert.equal(f.ids.get('ml-frames-dialog').open, true); assert.match(f.ids.get('ml-frame-progress').children[0].textContent, /正在提交/);
    slow.resolve({ batch: { id: 'new-batch', sessionId: 'old', ordinal: 2, createdAt: 2, state: 'queued', times: [1], actualCount: 0 }, job: { id: 'job', type: 'frames', state: 'queued', context: { batchId: 'new-batch' }, progress: 0 } }); await pending;
    state.results.push({ id: 'new', kind: 'image', sessionId: 'old', batchId: 'new-batch', actualMs: 1000, cacheReady: true }); state.jobs[0].progress = 50; state.jobs[0].detail = '正在解码'; f.renderResults();
    const grid = f.ids.get('ml-frame-grid'), fresh = grid.querySelector('[data-result-id="new"]'); assert.equal(fresh.classList.contains('ml-frame-new'), false);
    assert.equal(f.ids.get('ml-frame-progress').querySelector('progress').value, 50);
    state.batches.find(batch => batch.id === 'new-batch').state = 'completed'; f.renderResults(); assert.equal(fresh.classList.contains('ml-frame-new'), true);
    assert.equal(grid.querySelector('[data-result-id="existing"]').classList.contains('ml-frame-new'), false);
    await new Promise(resolve => setTimeout(resolve, 1150)); assert.equal(fresh.classList.contains('ml-frame-new'), false);
    f.renderResults(); assert.equal(fresh.classList.contains('ml-frame-new'), false);
});

test('a submitted compression appears immediately as the newest placeholder, follows progress and becomes one completed version', async () => {
    const queued = { id: 'new', type: 'transcode', createdAt: 3, context: { resultId: 'clip', ordinal: 3, params: { width: 960, height: 540 } }, state: 'queued', progress: 0 };
    const f = fixture(async () => queued), state = snapshot(); state.compressions = [1,2].map(ordinal => ({ id: 'v'+ordinal, resultId: 'clip', ordinal, createdAt: ordinal, quality: { width: 1280, height: 720 }, cacheReady: true })); f.set(state); f.compressionViewer({ id: 'clip' });
    const previousVideo = f.ids.get('ml-dialog-body').querySelector('video'); await previousVideo.play();
    f.transcodeDialog({ id: 'clip' }); const form = f.body.children.at(-1); await form.querySelectorAll('button').find(button => button.textContent === '提交转码').onclick(); assert.equal(previousVideo.paused, true);
    let entries = f.ids.get('ml-dialog-body').querySelectorAll('.ml-compression-entry'); assert.deepEqual(entries.map(node => node.dataset.compressionId), ['new','v2','v1']);
    assert.match(entries[0].textContent, /压3.*960×540/); assert.equal(entries[0].querySelector('progress').value, 0);
    state.jobs[0].state = 'running'; state.jobs[0].progress = 37; state.jobs[0].detail = '正在压缩视频'; f.renderCompressionView();
    entries = f.ids.get('ml-dialog-body').querySelectorAll('.ml-compression-entry'); assert.equal(entries[0].querySelector('progress').value, 37);
    state.compressions.push({ id: queued.id, resultId: 'clip', ordinal: 3, createdAt: 5, quality: { width: 960, height: 540 }, cacheReady: true }); state.jobs[0].state = 'completed'; f.renderCompressionView();
    entries = f.ids.get('ml-dialog-body').querySelectorAll('.ml-compression-entry'); assert.equal(entries.length, 3); assert.equal(entries[0].querySelector('progress'), null); assert.ok(entries[0].querySelector('img'));
    const right = f.ids.get('ml-dialog-body').querySelector('.ml-compression-detail'); assert.ok(right.querySelector('video'));
    assert.equal(right.querySelector('a').className, right.querySelector('button').className);
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
