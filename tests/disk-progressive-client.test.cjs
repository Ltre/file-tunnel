'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

async function until(predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(predicate(), 'client request did not start');
}
function clientHarness() {
    const window = {}, requests = [], xhrs = [], streams = [];
    let now = 1000, finished = false, finishQueued = false, operation = { operation_id: 'op', type: 'upload', status: 'running', telegramBytesSent: 0, telegramTotalBytes: 100, clientBytesReceived: 0 };
    class XHR {
        constructor() { this.events = {}; this.uploadEvents = {}; this.headers = {}; this.upload = { addEventListener: (name, fn) => { this.uploadEvents[name] = fn; } }; }
        addEventListener(name, fn) { this.events[name] = fn; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(name, value) { this.headers[name] = value; }
        send(body) { this.body = body; xhrs.push(this); }
        abort() { this.aborted = true; this.events.abort?.(); }
        progress(loaded) { now += 300; this.uploadEvents.progress({ loaded, lengthComputable: true, total: this.body.size }); }
        respond(data = {}) { this.status = 200; this.responseText = JSON.stringify(data); this.events.load(); }
    }
    class ProgressStream {
        constructor(url) { this.url = url; this.events = {}; this.closed = false; streams.push(this); }
        addEventListener(name, fn) { this.events[name] = fn; }
        close() { this.closed = true; }
        progress(data) { this.events.progress({ data: JSON.stringify(data) }); }
    }
    const fetch = async (url, options = {}) => {
        requests.push({ url, options });
        let data = {};
        if (url.endsWith('/uploads')) data = { uploadId: 'upload', operation_id: 'op', progressive: true };
        else if (url.endsWith('/finish')) { finished = !finishQueued; data = finishQueued ? { operation_id: 'op' } : { operation_id: 'op', status: 'completed', result: { items: [{ id: 'file' }] } }; }
        else if (url.includes('/operations?')) data = { operations: [{ ...operation, ...(finished ? { status: 'completed' } : {}) }] };
        else if (url.endsWith('/operations/op')) data = operation;
        return { ok: true, json: async () => data };
    };
    const FakeDate = class extends Date { static now() { return now; } };
    vm.runInNewContext(source('client/disk-client.js'), { window, fetch, XMLHttpRequest: XHR, EventSource: ProgressStream, AbortController, Date: FakeDate, setInterval() {}, setTimeout, clearTimeout, Promise, Map, Set, encodeURIComponent });
    const snapshots = [];
    window.DiskClient.subscribe(jobs => { snapshots.push(jobs.map(job => ({ ...job }))); });
    return { window, requests, xhrs, streams, snapshots, setOperation(value) { operation = value; }, queueFinish() { finishQueued = true; } };
}

test('XHR 在单个分片请求尚未结束时连续更新真实上传字节、速度和分片信息', async () => {
    const h = clientHarness(), file = { name: 'sample.bin', size: 100 }, blob = { size: 100, slice: (start, end) => ({ size: end - start }) };
    const uploading = h.window.DiskClient.upload([file], 'folder', async () => blob);
    await until(() => h.xhrs.length === 1);
    const xhr = h.xhrs[0];
    assert.equal(xhr.headers['Content-Range'], 'bytes 0-99/100');
    assert.ok(xhr.headers['X-Disk-Device-Id']); assert.equal(xhr.withCredentials, true);
    xhr.progress(20);
    let current = h.snapshots.at(-1).find(job => job.operation_id === 'op');
    assert.equal(current.clientBytesReceived, 20, 'must update before response/load');
    assert.equal(current.clientPartIndex, 1); assert.equal(current.clientPartCount, 1);
    assert.equal(current.clientFileName, 'sample.bin'); assert.ok(current.clientBytesPerSecond > 0);
    xhr.progress(70); assert.equal(h.snapshots.at(-1)[0].clientBytesReceived, 70);
    assert.equal(h.requests.some(request => request.url.endsWith('/finish')), false);
    assert.equal(JSON.parse(h.requests[0].options.body).progressive, true);
    xhr.respond(); await uploading;
    assert.ok(h.snapshots.some(snapshot => snapshot.some(job => job.clientBytesReceived === 100)));
    assert.equal(h.streams[0].closed, true);
});

test('上传 SSE 连续接收 Telegram 字节，过期轮询和服务端较低浏览器进度不能覆盖新进度', async () => {
    const h = clientHarness(), operation = { operation_id: 'op', type: 'upload', status: 'running', updatedAt: 1100, clientBytesReceived: 0, clientTotalBytes: 100, telegramBytesSent: 30, telegramTotalBytes: 100 };
    const uploading = h.window.DiskClient.upload([{ name: 'sample.bin', size: 100 }], '', async () => ({ size: 100, slice: () => ({ size: 100 }) }));
    await until(() => h.xhrs.length && h.streams.length);
    h.xhrs[0].progress(60); h.streams[0].progress(operation);
    assert.equal(h.streams[0].url, '/api/telegram/drive/uploads/upload/progress');
    let current = h.snapshots.at(-1).find(job => job.operation_id === 'op');
    assert.equal(current.clientBytesReceived, 60); assert.equal(current.telegramBytesSent, 30); assert.equal(current.percent, 30);
    h.streams[0].progress({ ...operation, updatedAt: 1200, telegramBytesSent: 45 });
    h.setOperation({ ...operation, telegramBytesSent: 10 }); await h.window.DiskClient.refresh(true);
    current = h.snapshots.at(-1).find(job => job.operation_id === 'op');
    assert.equal(current.telegramBytesSent, 45); assert.equal(current.clientBytesReceived, 60); assert.equal(current.percent, 45);
    h.streams[0].progress({ ...operation, updatedAt: 1300, telegramBytesSent: 10, phase: 'telegram-retry' });
    current = h.snapshots.at(-1).find(job => job.operation_id === 'op');
    assert.equal(current.telegramBytesSent, 10, '较新重试必须显示当前attempt的逻辑进度，不能保留失败attempt高水位');
    assert.equal(current.percent, 10); assert.equal(current.clientBytesReceived, 60);
    h.xhrs[0].respond(); await uploading;
});

test('SSE 终态失败中止 XHR 并保留真实原因，不调用用户取消 DELETE，退出登录后忽略迟到事件', async () => {
    const h = clientHarness();
    const uploading = h.window.DiskClient.upload([{ name: 'sample.bin', size: 100 }], '', async () => ({ size: 100, slice: () => ({ size: 100 }) }));
    const rejected = assert.rejects(uploading, /ECONNRESET/);
    await until(() => h.xhrs.length && h.streams.length);
    const failed = { operation_id: 'op', type: 'upload', status: 'failed', errorCode: 'ECONNRESET' };
    h.setOperation(failed); h.streams[0].progress(failed);
    await rejected;
    assert.equal(h.xhrs[0].aborted, true); assert.equal(h.streams[0].closed, true);
    assert.equal(h.requests.some(request => request.options.method === 'DELETE'), false);
    h.window.DiskClient.stop();
    h.streams[0].progress({ ...failed, status: 'running' });
    assert.equal(h.snapshots.at(-1).length, 0);
});

test('正文发送100%仍为最终组装中的运行任务，SSE completed 才结束等待并关闭连接', async () => {
    const h = clientHarness(); h.queueFinish();
    let completed = false;
    const uploading = h.window.DiskClient.upload([{ name: 'sample.bin', size: 100 }], '', async () => ({ size: 100, slice: () => ({ size: 100 }) })).then(result => { completed = true; return result; });
    await until(() => h.xhrs.length && h.streams.length);
    h.xhrs[0].respond(); await until(() => h.requests.some(request => request.url.endsWith('/finish')));
    const finalizing = { operation_id: 'op', type: 'upload', status: 'running', phase: 'finalizing', message: '正在提交最终媒体组', telegramBytesSent: 100, telegramTotalBytes: 100, finalizationGroupIndex: 1, finalizationGroupCount: 2 };
    h.setOperation(finalizing); h.streams[0].progress(finalizing);
    const current = h.snapshots.at(-1).find(job => job.operation_id === 'op');
    assert.equal(current.telegramBytesSent, 100); assert.equal(current.percent, 99); assert.equal(current.status, 'running');
    assert.equal(completed, false); assert.equal(h.streams[0].closed, false);
    const result = { items: [{ id: 'file' }] };
    h.streams[0].progress({ ...finalizing, status: 'completed', result });
    assert.equal((await uploading).items[0].id, 'file'); assert.equal(h.streams[0].closed, true);
});

test('SSE断连保留轮询兜底，XHR网络失败仍报告网络原因；普通 raw 请求继续使用fetch', async () => {
    const h = clientHarness();
    await h.window.DiskClient.raw('/me');
    assert.equal(h.xhrs.length, 0); assert.ok(h.requests.some(request => request.url.endsWith('/me')));
    const uploading = h.window.DiskClient.upload([{ name: 'sample.bin', size: 100 }], '', async () => ({ size: 100, slice: () => ({ size: 100 }) }));
    const rejected = assert.rejects(uploading, /UPLOAD_CLIENT_NETWORK_ERROR/);
    await until(() => h.xhrs.length && h.streams.length);
    const polls = h.requests.filter(request => request.url.includes('/operations?')).length;
    h.streams[0].events.error();
    await until(() => h.requests.filter(request => request.url.includes('/operations?')).length > polls);
    assert.equal(h.streams[0].closed, false, '临时SSE断连不取消上传');
    h.xhrs[0].events.error(); await rejected;
    assert.equal(h.streams[0].closed, true);
    assert.equal(h.requests.some(request => request.options.method === 'DELETE'), false);
    const failure = h.requests.find(request => request.url.endsWith('/failure'));
    assert.equal(JSON.parse(failure.options.body).errorCode, 'UPLOAD_CLIENT_NETWORK_ERROR');
});

test('双链路进度显示百分比、速度、文件分片和最终组装，不显示独立确认字节行', () => {
    const ui = source('client/disk-ui.js'), context = { formatFileSize: n => `${n} B` };
    vm.runInNewContext(ui.slice(ui.indexOf('function diskUploadProgressLines('), ui.indexOf('function initDiskLoading(')) + ';this.format = diskUploadProgressLines;', context);
    const lines = context.format({ clientBytesReceived: 30, clientTotalBytes: 100, clientBytesPerSecond: 25, clientFileIndex: 2, clientFileCount: 3, clientFileName: 'b.mp4', clientPartIndex: 1, clientPartCount: 4,
        telegramBytesSent: 20, telegramTotalBytes: 100, telegramBytesConfirmed: 0, telegramBytesPerSecond: 10, telegramFileIndex: 1, telegramFileCount: 3, telegramFileName: 'a.mp4', telegramPartIndex: 2, telegramPartCount: 5 });
    assert.match(lines.join('\n'), /浏览器 → 服务器 · 30 B\/100 B · 30.00% · 25 B\/s/);
    assert.match(lines.join('\n'), /服务器 → Telegram · 20 B\/100 B · 20.00% · 10 B\/s/);
    assert.match(lines.join('\n'), /第 2\/3 个文件：b.mp4/); assert.match(lines.join('\n'), /第 2\/5 个分片/);
    assert.doesNotMatch(lines.join('\n'), /Telegram 已确认/);
    const final = context.format({ telegramBytesSent: 100, telegramTotalBytes: 100, finalizationGroupIndex: 1, finalizationGroupCount: 2 });
    assert.match(final.join('\n'), /100.00%/); assert.match(final.join('\n'), /正在提交最终媒体组 · 1\/2/);
});

test('上传限额、未确认结果和待清理警告提供明确提示，临时清理不误报封面失败', () => {
    const ui = source('client/disk-ui.js'), context = {};
    vm.runInNewContext(ui.slice(ui.indexOf('function telegramDriveErrorText('), ui.indexOf('function telegramDriveItemKey(')) + ';this.errorText = telegramDriveErrorText;this.warningText = telegramDriveWarningText;', context);
    assert.match(context.errorText('UPLOAD_ACTIVE_LIMIT'), /20 项/);
    assert.match(context.errorText('TELEGRAM_UPLOAD_OUTCOME_UNKNOWN'), /核对频道消息/);
    assert.match(context.errorText('UPLOAD_SOURCE_INTERRUPTED'), /重新上传/);
    const unknown = context.errorText({ message: 'TELEGRAM_NETWORK_ERROR', errorDetails: { causeCode: 'ECONNRESET', requestOutcomeUnknown: true } });
    assert.match(unknown, /发送结果未确认/); assert.match(unknown, /已保留分片及消息记录/); assert.match(unknown, /勿直接重复上传/); assert.match(unknown, /ECONNRESET/);
    assert.doesNotMatch(unknown, /检查服务器网络/);
    const cleanup = context.warningText(['TELEGRAM_TEMP_CLEANUP_PENDING']);
    assert.match(cleanup, /分片消息待清理/); assert.match(cleanup, /自动重试/); assert.doesNotMatch(cleanup, /封面/);
});
