'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

test('网页 ZIP Runtime 按路径纠正外链 JavaScript MIME', () => {
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(root, 'client/web-zip-runtime.js'), 'utf8'), { window });
    const runtimeType = window.WebZipRuntime._test.runtimeType;
    assert.equal(runtimeType('assets/app.js', 'application/octet-stream'), 'text/javascript; charset=utf-8');
    assert.equal(runtimeType('modules/main.mjs', 'text/plain'), 'text/javascript; charset=utf-8');
    assert.equal(runtimeType('assets/custom.bin', 'application/x-custom'), 'application/x-custom');

    const worker = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
    assert.match(worker, /getWebZipRuntimeContentType\(filePath, file\.type\)/);
    assert.match(worker, /'X-Content-Type-Options': 'nosniff'/);
    assert.match(worker, /instant-tunnel-v60/);
});

test('音轨修复接口提交后返回队列任务，并提供独立状态查询', () => {
    const server = fs.readFileSync(path.join(root, 'server/audio-track-repair.js'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'client/audio-track-repair.js'), 'utf8');
    assert.match(server, /res\.status\(job\.status === 'completed' \? 200 : 202\)/);
    assert.match(server, /audio-repair\/status/);
    assert.match(server, /status:'queued'/);
    assert.match(client, /beginPolling\(state, request\)/);
    assert.match(client, /已加入后端转码队列/);
});
