'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function worker(fetchResponse, cached) {
    const handlers = {}, timers = new Map(), puts = [], waits = [];
    let nextTimer = 0;
    const cache = {
        async match(key) { assert.equal(key, '/index.html'); return cached?.clone(); },
        async put(key, response) { puts.push({ key, text:await response.text() }); }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../service-worker.js'), 'utf8'), {
        self:{ location:{ origin:'https://example.test' }, addEventListener(type, handler) { handlers[type] = handler; } },
        URL, Response, Promise,
        fetch:fetchResponse,
        caches:{ open:async () => cache, match:async () => cached?.clone() },
        setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
        clearTimeout(id) { timers.delete(id); }
    });
    return {
        timers, puts, waits,
        dispatch(pathname = '/', mode = 'navigate') {
            let result;
            handlers.fetch({
                request:{ method:'GET', url:'https://example.test' + pathname, mode, referrer:'' },
                waitUntil(promise) { waits.push(promise); }, respondWith(promise) { result = promise; }
            });
            return result;
        }
    };
}
const html = text => new Response(text, { headers:{ 'Content-Type':'text/html; charset=utf-8' } });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('warm PWA returns cached shell after one second and saves the eventual fresh shell', async () => {
    let resolveFetch;
    const fixture = worker(() => new Promise(resolve => { resolveFetch = resolve; }), html('cached shell'));
    const navigation = fixture.dispatch('/?pwa=1');
    await settle();
    assert.equal(fixture.timers.size, 1);
    const timer = [...fixture.timers.values()][0];
    assert.equal(timer.delay, 1000);
    timer.fn();
    assert.equal(await (await navigation).text(), 'cached shell');
    resolveFetch(html('updated shell'));
    await Promise.all(fixture.waits);
    assert.deepEqual(fixture.puts, [{ key:'/index.html', text:'updated shell' }]);
    assert.equal(fixture.timers.size, 0);
});

test('fast navigation uses the network and clears its fallback timer', async () => {
    const fixture = worker(async () => html('fresh'), html('cached'));
    assert.equal(await (await fixture.dispatch('/disk')).text(), 'fresh');
    await Promise.all(fixture.waits);
    assert.equal(fixture.timers.size, 0);
    assert.equal(fixture.puts[0].text, 'fresh');
});

test('cold navigation does not invent a fallback and redirects never replace the public shell', async () => {
    const redirected = { ok:true, status:200, redirected:true, headers:new Headers({ 'Content-Type':'text/html' }) };
    const fixture = worker(async () => redirected, null);
    assert.equal(await fixture.dispatch('/notification'), redirected);
    await Promise.all(fixture.waits);
    assert.equal(fixture.puts.length, 0);
    assert.equal(fixture.timers.size, 0);
});

test('admin, API, runtime config and explicit refresh bypass the bounded shell cache', async () => {
    for (const [pathname, mode] of [['/admin', 'navigate'], ['/api/telegram/drive/list', 'cors'], ['/runtime-config.js', 'cors'], ['/?_reload=1', 'navigate'], ['/?tunnel_reload=1', 'navigate']]) {
        const fixture = worker(async () => html(pathname), html('cached shell'));
        assert.equal(await (await fixture.dispatch(pathname, mode)).text(), pathname);
        await Promise.all(fixture.waits);
        assert.equal(fixture.puts.length, 0, pathname);
        assert.equal(fixture.timers.size, 0, pathname);
    }
});

test('temporary network and 5xx failures use a warm shell without poisoning it', async () => {
    for (const fetchResponse of [async () => { throw new Error('offline'); }, async () => new Response('upstream failure', { status:503 })]) {
        const fixture = worker(fetchResponse, html('cached shell'));
        assert.equal(await (await fixture.dispatch('/')).text(), 'cached shell');
        await Promise.all(fixture.waits);
        assert.equal(fixture.puts.length, 0);
    }
});
