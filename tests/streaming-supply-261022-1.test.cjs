'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStreamingBroker } = require('../server/streaming-sources');
test('a responsive alternative supplier is asked before an unresponsive primary times out', async t => {
    const broker = createStreamingBroker({ timeout: 500, hedgeMs: 5 }); t.after(() => broker.close());
    const first = broker.poll('slow'), second = broker.poll('fast');
    const reading = broker.read({ kind: 'tunnel' }, ['slow', 'fast'], 0, 3); reading.catch(() => {});
    await first;
    const result = await Promise.race([second.then(tasks => ({ tasks })), new Promise(resolve => setTimeout(() => resolve(null), 80))]);
    assert.ok(result, 'the fast peer must be consulted while the first request is still pending');
    broker.provide('fast', result.tasks[0].requestId, Buffer.from('tiny'));
    const stream = await reading, chunks = []; for await (const chunk of stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'tiny');
});
