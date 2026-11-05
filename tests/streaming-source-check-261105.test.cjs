'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createStreamingSources } = require('../server/streaming-sources');
test('source checks sample bounded first and last blocks and detect truncated reads', async () => {
    const reads = [], disk = { stat: () => ({ name: 'large.mp4', type: 'video/mp4', size: 2 ** 30 }),
        read: async (_source, start, end, signal) => { reads.push({ start, end, signal }); return Readable.from([Buffer.alloc(end - start + 1)]); } };
    const sources = createStreamingSources({ disk, tunnel: {} });
    await sources.check({ kind: 'disk' }, 'source-device');
    assert.deepEqual(reads.map(({start,end}) => [start,end]), [[0,65535],[2 ** 30 - 65536,2 ** 30 - 1]]);
    assert.ok(reads.every(read => read.signal.aborted));
    disk.read = async () => Readable.from([Buffer.alloc(1)]);
    await assert.rejects(sources.check({kind:'disk'}), /STREAM_READ_INVALID/);
    disk.stat = () => ({name:'empty.png',type:'image/png',size:0});
    await assert.rejects(sources.check({kind:'disk'}), /STREAM_MEDIA_UNAVAILABLE/);
    sources.broker.close();
});
