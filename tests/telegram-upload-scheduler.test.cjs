'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramUploadScheduler } = require('../server/telegram-upload-scheduler');
const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const backend = { baseUrl: 'https://test', token: 'one', channelId: '-100' };

test('调度全局4、bot4、chat2，阻塞chat不能占住其它chat名额', async () => {
    const scheduler = createTelegramUploadScheduler({ pacingMs: 0 }), waits = [], running = new Map(); let maxGlobal = 0, maxSameChat = 0;
    const requests = Array.from({ length: 12 }, (_, index) => {
        const chat = index < 6 ? '-100' : '-200', done = gate(); waits.push(done);
        return scheduler.enqueue({ ...backend, channelId: chat }, async () => {
            running.set(chat, (running.get(chat) || 0) + 1);
            maxGlobal = Math.max(maxGlobal, [...running.values()].reduce((sum, value) => sum + value, 0)); maxSameChat = Math.max(maxSameChat, running.get(chat));
            await done.promise; running.set(chat, running.get(chat) - 1);
        }, { taskKey: index % 2 ? 'b' : 'a' });
    });
    await tick(); assert.equal(scheduler.snapshot().inflight, 4); assert.equal(running.get('-100'), 2); assert.equal(running.get('-200'), 2);
    waits.forEach(item => item.resolve()); await Promise.all(requests);
    assert.equal(maxGlobal, 4); assert.equal(maxSameChat, 2);
});

test('等待队列按任务公平轮转，不让同一上传任务独占后续slot', async () => {
    const scheduler = createTelegramUploadScheduler({ globalLimit: 1, pacingMs: 0 }), held = gate(), order = [];
    const first = scheduler.enqueue(backend, () => held.promise, { taskKey: 'a' }); await tick();
    const queued = ['a', 'a', 'b', 'b'].map(taskKey => scheduler.enqueue(backend, () => { order.push(taskKey); }, { taskKey }));
    held.resolve(); await Promise.all([first, ...queued]); assert.deepEqual(order, ['b', 'a', 'b', 'a']);
});

test('20个任务持续补入请求仍逐轮公平调度，不让前几个任务饿死其余任务', async () => {
    const scheduler = createTelegramUploadScheduler({ globalLimit: 1, pacingMs: 0 }), held = gate(), done = gate();
    const owners = Array.from({ length: 20 }, (_, index) => 'upload-' + index), counts = new Map(), order = [], pending = [];
    const first = scheduler.enqueue(backend, () => held.promise, { taskKey: 'initial' }); await tick();
    const add = owner => pending.push(scheduler.enqueue(backend, () => {
        order.push(owner); counts.set(owner, (counts.get(owner) || 0) + 1);
        if (counts.get(owner) < 4) add(owner);
        if (order.length === owners.length * 4) done.resolve();
    }, { taskKey: owner }));
    owners.forEach(add); held.resolve(); await done.promise; await Promise.all([first, ...pending]);
    assert.deepEqual(order, Array.from({ length: 4 }, () => owners).flat());
    assert.equal(scheduler.snapshot().queueLength, 0); assert.equal(scheduler.snapshot().inflight, 0);
});

test('清理任务保持低优先级，普通上传先执行且普通队列排空后清理不会遗漏', async () => {
    const scheduler = createTelegramUploadScheduler({ globalLimit: 1, pacingMs: 0 }), held = gate(), order = [];
    const first = scheduler.enqueue(backend, () => held.promise, { taskKey: 'initial' }); await tick();
    const cleanup = scheduler.enqueue(backend, () => order.push('cleanup'), { taskKey: 'cleanup', priority: 10 });
    const uploads = ['a', 'b', 'c'].map(taskKey => scheduler.enqueue(backend, () => order.push(taskKey), { taskKey }));
    held.resolve(); await Promise.all([first, cleanup, ...uploads]);
    assert.deepEqual(order, ['a', 'b', 'c', 'cleanup']);
});

test('持续新建的owner不能永久抢在旧任务已等待的下一轮之前', async () => {
    const scheduler = createTelegramUploadScheduler({ globalLimit: 1, pacingMs: 0 }), held = gate(), order = [], pending = [];
    const first = scheduler.enqueue(backend, () => held.promise, { taskKey: 'existing' }); await tick();
    const existing = scheduler.enqueue(backend, () => order.push('existing'), { taskKey: 'existing' });
    const add = index => pending.push(scheduler.enqueue(backend, () => {
        order.push('new-' + index); if (index < 30) add(index + 1);
    }, { taskKey: 'new-' + index }));
    add(0); held.resolve(); await existing;
    assert.deepEqual(order.slice(0, 2), ['new-0', 'existing']);
    while (order.length < 32) await tick(); await Promise.all([first, existing, ...pending]);
});

test('同一chat数字ID在不同bot之间独立并发，bot上限仍独立生效', async () => {
    const scheduler = createTelegramUploadScheduler({ pacingMs: 0 }), held = gate(), started = [];
    const requests = ['one', 'one', 'one', 'two', 'two', 'two'].map(token => scheduler.enqueue({ ...backend, token }, async () => { started.push(token); await held.promise; }));
    await tick(); assert.equal(started.filter(token => token === 'one').length, 2); assert.equal(started.filter(token => token === 'two').length, 2);
    assert.equal(scheduler.snapshot().activeBots, 2); held.resolve(); await Promise.all(requests);
});

test('queued取消立即移出队列，不执行任务且不影响运行项', async () => {
    const scheduler = createTelegramUploadScheduler({ globalLimit: 1, pacingMs: 0 }), held = gate(), controller = new AbortController();
    const first = scheduler.enqueue(backend, () => held.promise);
    const second = scheduler.enqueue(backend, () => { throw new Error('must not run'); }, { signal: controller.signal });
    controller.abort(); await assert.rejects(second, /OPERATION_CANCELLED/); assert.equal(scheduler.snapshot().queueLength, 0);
    held.resolve(); await first;
});

test('单chat pacing及429 retry_after+backoff+jitter均释放slot等待', async () => {
    let now = 0, sequence = 0; const timers = new Map();
    const scheduler = createTelegramUploadScheduler({ now: () => now, random: () => 0.5,
        setTimer: (callback, milliseconds) => { const id = ++sequence; timers.set(id, { callback, at: now + milliseconds }); return id; }, clearTimer: id => timers.delete(id) });
    const order = [], first = scheduler.enqueue(backend, () => order.push('first')); await first; await tick();
    const second = scheduler.enqueue(backend, () => order.push('second')); await tick();
    assert.deepEqual(order, ['first']); assert.equal(scheduler.snapshot().inflight, 0);
    const delay = scheduler.feedback(backend, Object.assign(new Error('TELEGRAM_429'), { retryAfter: 3 }), 1);
    assert.equal(delay, 3250); assert.equal(scheduler.snapshot().rateLimits, 1);
    now = 3000; for (const [id, item] of [...timers]) if (item.at <= now) { timers.delete(id); item.callback(); } await tick(); assert.deepEqual(order, ['first']);
    now = 3250; for (const [id, item] of [...timers]) if (item.at <= now) { timers.delete(id); item.callback(); }
    await second; assert.deepEqual(order, ['first', 'second']);
});
