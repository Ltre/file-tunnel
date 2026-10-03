'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '../client/disk-client.js'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '../server/disk-api.js'), 'utf8');
const operations = fs.readFileSync(path.join(__dirname, '../server/disk-operations.js'), 'utf8');

test('Browser → Server 用户进度以 Node 实际接收字节为准', () => {
    assert.match(api, /clientBytesReceived:\s*received \+ bytes/);
    assert.match(api, /clientSpeedBps/);
    assert.match(api, /const instant = \(bytes - speedBytes\) \* 1000 \/ elapsed/);
    assert.doesNotMatch(client, /loaded => reportClientProgress/);
    assert.doesNotMatch(client, /clientSpeed = clientSpeed/);
    assert.match(client, /Actual received bytes and speed[\s\S]*Node's receivePart\(\)/);
});

test('活跃上传通过 operation SSE 即时接收服务端快照', () => {
    assert.match(operations, /subscribe\(id, scope, listener\)/);
    assert.match(api, /Content-Type':'text\/event-stream; charset=utf-8'/);
    assert.match(api, /X-Accel-Buffering':'no'/);
    assert.match(client, /new EventSource\(baseUrl\(\) \+ '\/operations\/'/);
    assert.match(client, /applyLiveOperation\(JSON\.parse\(event\.data\)\)/);
});

test('服务端 operation 存在后不再被 XHR 本地字节覆盖', () => {
    const start = client.indexOf('const visibleJobs =');
    const end = client.indexOf('const emit =', start);
    const source = client.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.doesNotMatch(source, /clientFields/);
    assert.match(source, /server operation exists it is authoritative/);
});
