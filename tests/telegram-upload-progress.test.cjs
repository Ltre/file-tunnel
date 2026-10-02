'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const diagnostics = require('node:diagnostics_channel');
const { Readable } = require('node:stream');
const { observeTelegramUpload } = require('../server/telegram-upload-progress');
const { buildTelegramDocumentsMultipart } = require('../server/telegram-multipart');

test('真实 fetch 按写入连接的文件字节连续反馈，排除 multipart 头并区分等待响应', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-progress-'));
    const files = [{ name: '封面.webp', type: 'image/webp', size: 200000 }, { name: '日本語.md', type: 'text/plain', size: 300000 }];
    files.forEach((file, index) => { file.path = path.join(directory, String(index)); fs.writeFileSync(file.path, Buffer.alloc(file.size, index + 1)); });
    const multipart = buildTelegramDocumentsMultipart({ chatId: '-100', files });
    let release, completed, received = 0;
    const bodyReceived = new Promise(resolve => { completed = resolve; });
    const responseAllowed = new Promise(resolve => { release = resolve; });
    const server = http.createServer(async (req, res) => {
        for await (const chunk of req) received += chunk.length;
        completed(); await responseAllowed;
        res.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const updates = [], url = `http://127.0.0.1:${server.address().port}/sendMediaGroup`;
    const observer = observeTelegramUpload(url, multipart.payloadRanges, update => updates.push(update));
    t.after(async () => { release(); observer.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
    const body = Readable.from((async function* () {
        for await (const chunk of multipart.body) { await new Promise(resolve => setTimeout(resolve, 35)); yield chunk; }
    })());
    const response = observer.run(() => fetch(url, { method: 'POST', headers: { 'Content-Type': multipart.contentType, 'Content-Length': String(multipart.contentLength) }, body, duplex: 'half' }));
    await bodyReceived;
    assert.equal(received, multipart.contentLength);
    assert.equal(observer.snapshot().sentBodyBytes, received);
    assert.equal(observer.snapshot().sentFileBytes, 500000);
    assert.ok(observer.snapshot().bodySentAt > 0);
    assert.ok(updates.some(update => update.bytes > 0 && update.bytes < 500000), '确认响应前应出现部分文件字节进度');
    assert.deepEqual(updates.at(-1), { bytes: 500000, total: 500000, name: '', complete: true });
    release(); await (await response).text();
});

test('同地址并行请求按异步上下文隔离，CONNECT 和其它调用不计入，close 后停止记录', () => {
    const url = 'https://api.telegram.org/bot123:test/sendDocument';
    const a = observeTelegramUpload(url, [{ start: 10, end: 30, name: 'a' }]);
    const b = observeTelegramUpload(url, [{ start: 10, end: 30, name: 'b' }]);
    const create = diagnostics.channel('undici:request:create'), chunk = diagnostics.channel('undici:request:bodyChunkSent');
    const requestA = { method: 'POST', origin: 'https://api.telegram.org', path: '/bot123:test/sendDocument' }, requestB = { ...requestA };
    a.run(() => {
        create.publish({ request: requestA });
        const connect = { ...requestA, method: 'CONNECT' }, unrelated = { ...requestA, path: '/bot123:test/getFile' };
        create.publish({ request: connect }); create.publish({ request: unrelated });
        chunk.publish({ request: connect, chunk: Buffer.alloc(100) }); chunk.publish({ request: unrelated, chunk: Buffer.alloc(100) });
    });
    b.run(() => create.publish({ request: requestB }));
    chunk.publish({ request: requestA, chunk: Buffer.alloc(15) });
    chunk.publish({ request: requestB, chunk: Buffer.alloc(28) });
    assert.equal(a.snapshot().sentFileBytes, 5); assert.equal(b.snapshot().sentFileBytes, 18);
    a.close(); chunk.publish({ request: requestA, chunk: Buffer.alloc(30) });
    assert.equal(a.snapshot().sentFileBytes, 5); b.close();
});

test('进度回调异常不影响 HTTP 客户端，没有发送事件时不虚构字节数', async () => {
    const url = 'https://example.test/sendDocument';
    const observer = observeTelegramUpload(url, [{ start: 0, end: 20 }], () => { throw new Error('observer failed'); });
    await observer.run(async () => {});
    assert.equal(observer.snapshot().sentFileBytes, null);
    const request = { method: 'POST', origin: 'https://example.test', path: '/sendDocument' };
    observer.run(() => diagnostics.channel('undici:request:create').publish({ request }));
    assert.doesNotThrow(() => diagnostics.channel('undici:request:bodyChunkSent').publish({ request, chunk: Buffer.alloc(10) }));
    assert.equal(observer.snapshot().sentFileBytes, 10); observer.close();
});
