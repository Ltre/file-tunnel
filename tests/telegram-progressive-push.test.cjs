'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const diagnostics = require('node:diagnostics_channel');
const { createDiskTelegram, partitionMediaGroups } = require('../server/disk-telegram');
const { createTelegramUploadScheduler } = require('../server/telegram-upload-scheduler');
const { buildTelegramDocumentsMultipart } = require('../server/telegram-multipart');
const backend = { token: '123:fixture-token', baseUrl: 'https://example.test', channelId: '-100' };
const reply = result => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const message = (id, fileId = 'remote-' + id, size) => ({ message_id: id, date: 1, media_group_id: 'group', document: { file_id: fileId, file_unique_id: 'unique-' + id, ...(size !== undefined ? { file_size: size } : {}) } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function consume(body) { const chunks = []; for await (const chunk of body) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
function fixture(t, fetchImpl, scheduler = createTelegramUploadScheduler({ pacingMs: 0, random: () => 0 })) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-progressive-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const file = { logicalId: 'logical', name: '视频.mp4', size: 8 };
    const part = { logicalFileId: 'logical', fileIndex: 0, partIndex: 1, partCount: 1, originalSize: 8, size: 8, offset: 0, name: file.name, streamFactory: () => [Buffer.from('12345678')] };
    return { telegram: createDiskTelegram({ dataDir, fetchImpl, uploadScheduler: scheduler }), file, part };
}

test('单分片 multipart 使用增长源和固定 Content-Length，严格拒绝短读和超长', async () => {
    for (const actual of [2, 4]) {
        const multipart = buildTelegramDocumentsMultipart({ chatId: '-1', files: [{ name: 'x', size: 3, streamFactory: () => [Buffer.alloc(actual)] }] });
        await assert.rejects(consume(multipart.body), /TELEGRAM_PART_SIZE_MISMATCH/);
    }
    const multipart = buildTelegramDocumentsMultipart({ chatId: '-1', files: [{ name: '日本語.md', size: 3, streamFactory: () => [Buffer.from('a'), Buffer.from('bc')] }] });
    assert.equal((await consume(multipart.body)).length, multipart.contentLength);
    assert.equal(multipart.method, 'sendDocument');
});

test('分片源尺寸错误明确返回，不伪装网络未知结果或反复重推', async t => {
    let calls = 0; const states = [];
    const { telegram, file, part } = fixture(t, async (_url, init) => { calls++; await consume(init.body); return reply(message(1)); });
    part.streamFactory = () => [Buffer.from('123')];
    await assert.rejects(telegram.pushChunk(backend, file, part, () => {}, { onState: async state => states.push(state) }), /TELEGRAM_PART_SIZE_MISMATCH/);
    assert.equal(calls, 1); assert.equal(states.at(-1), 'failed');
});

test('真实 HTTP 从第一个增量提前推送，追上增长点不 EOF，尾部全部发送后先持久化确认', async t => {
    const sourceTail = deferred(), firstTelegramByte = deferred(), serverBody = deferred(), states = [], updates = [];
    let received = 0, responseSent = false;
    const server = http.createServer(async (req, res) => {
        assert.equal(req.headers['transfer-encoding'], undefined);
        for await (const chunk of req) {
            received += chunk.length;
            if (chunk.includes(Buffer.from('first-half'))) firstTelegramByte.resolve();
        }
        assert.equal(received, Number(req.headers['content-length'])); serverBody.resolve();
        responseSent = true; res.end(JSON.stringify({ ok: true, result: message(4, 'temp', 20) }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { sourceTail.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const { telegram, file, part } = fixture(t, fetch);
    const local = { ...backend, baseUrl: `http://127.0.0.1:${server.address().port}` };
    Object.assign(part, { size: 20, originalSize: 20, streamFactory: () => (async function* () { yield Buffer.from('first-half'); await sourceTail.promise; yield Buffer.from('secondhalf'); })(), awaitSourceComplete: () => sourceTail.promise });
    const pushed = telegram.pushChunk(local, { ...file, size: 20 }, part, patch => updates.push(patch), { onState: async state => states.push(state), onConfirmed: async remote => { assert.equal(responseSent, true); states.push('durable-' + remote.fileId); } });
    await firstTelegramByte.promise;
    assert.equal(responseSent, false, '源尚未完整时 Telegram 已收到文件正文');
    assert.ok(updates.some(update => update.telegramPartBytesSent > 0 && update.telegramPartBytesSent < 20));
    await tick(); assert.equal(responseSent, false, '追上写入点必须等待而不是发送 EOF');
    sourceTail.resolve(); await serverBody.promise;
    assert.equal((await pushed).fileId, 'temp');
    assert.deepEqual(states, ['pushing', 'awaiting_response', 'durable-temp', 'push_confirmed']);
    assert.equal(updates.at(-1).telegramPartBytesSent, 20);
});

test('部分 socket 请求被证明未发送完整时，等源完整后再从头重试', async t => {
    const sourceComplete = deferred(), failed = deferred(), states = []; let sends = 0, starts = 0;
    const { telegram, file, part } = fixture(t, async (url, init) => {
        sends++;
        if (sends === 1) {
            const parsed = new URL(url), request = { method: 'POST', origin: parsed.origin, path: parsed.pathname };
            diagnostics.channel('undici:request:create').publish({ request });
            diagnostics.channel('undici:request:bodyChunkSent').publish({ request, chunk: Buffer.alloc(2) });
            failed.resolve(); throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
        }
        const bytes = await consume(init.body); assert.equal(bytes.length, Number(init.headers['Content-Length']));
        return reply(message(9, 'recovered', 8));
    });
    part.awaitSourceComplete = () => sourceComplete.promise;
    part.streamFactory = () => { starts++; return [Buffer.from('12345678')]; };
    const result = telegram.pushChunk(backend, file, part, () => {}, { onState: async state => states.push(state) });
    await failed.promise; await tick();
    assert.equal(sends, 1); assert.ok(states.includes('retry_wait'));
    sourceComplete.resolve();
    assert.equal((await result).fileId, 'recovered'); assert.equal(sends, 2); assert.equal(starts, 1);
});

test('完整请求后的响应丢失标为 unknown，绝不盲目重发', async t => {
    const states = []; let sends = 0;
    const { telegram, file, part } = fixture(t, async (url, init) => {
        sends++; const bytes = await consume(init.body), parsed = new URL(url), request = { method: 'POST', origin: parsed.origin, path: parsed.pathname };
        diagnostics.channel('undici:request:create').publish({ request });
        diagnostics.channel('undici:request:bodyChunkSent').publish({ request, chunk: bytes });
        diagnostics.channel('undici:request:bodySent').publish({ request });
        throw Object.assign(new Error('headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
    });
    await assert.rejects(telegram.pushChunk(backend, file, part, () => {}, { onState: async state => states.push(state) }), error => error.message === 'TELEGRAM_NETWORK_ERROR' && !error.details.requestIncomplete);
    assert.equal(sends, 1); assert.equal(states.at(-1), 'unknown');
});

test('HTTP200返回体损坏同样属于未知上传结果，单片和最终组都不重发', async t => {
    let calls = 0, state, finalUnknown;
    const { telegram, file, part } = fixture(t, async (_url, init) => { calls++; if (typeof init.body !== 'string') await consume(init.body); return new Response('{"ok":true', { status: 200 }); });
    await assert.rejects(telegram.pushChunk(backend, file, part, () => {}, { onState: async value => { state = value; } }), /TELEGRAM_UPLOAD_RESULT_INVALID/);
    assert.equal(state, 'unknown'); assert.equal(calls, 1);
    const parts = [1, 2].map(index => ({ ...part, partIndex: index, partCount: 2, fileId: 'temp-' + index, messageId: index }));
    await assert.rejects(telegram.finalizeGroups(backend, file, parts, { onGroupFailure: async (_index, value) => { finalUnknown = value.unknown; } }), /TELEGRAM_UPLOAD_RESULT_INVALID/);
    assert.equal(finalUnknown, true); assert.equal(calls, 2);
});

test('429服从retry_after再重新入队，不在原HTTP调用内隐式重试', async t => {
    const timestamps = [], states = []; let calls = 0;
    const { telegram, file, part } = fixture(t, async (_url, init) => {
        timestamps.push(Date.now()); calls++; await consume(init.body);
        return calls === 1 ? new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } }), { status: 429 }) : reply(message(11, 'limited', 8));
    });
    const result = await telegram.pushChunk(backend, file, part, () => {}, { onState: async (state, details) => states.push({ state, details }) });
    assert.equal(result.fileId, 'limited'); assert.equal(calls, 2); assert.ok(timestamps[1] - timestamps[0] >= 950);
    assert.equal(telegram.scheduler.snapshot().rateLimits, 1); assert.equal(states.find(item => item.state === 'retry_wait').details.errorCode, 'TELEGRAM_429');
});

test('用户取消增长source时中止请求，绝不产生确认或自动重试', async t => {
    const controller = new AbortController(), started = deferred(); let calls = 0, confirmed = 0;
    const { telegram, file, part } = fixture(t, async (_url, init) => {
        calls++; started.resolve();
        await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
    });
    const result = telegram.pushChunk(backend, file, part, () => {}, { signal: controller.signal, onConfirmed: () => { confirmed++; } });
    await started.promise; controller.abort(); await assert.rejects(result, /TELEGRAM_NETWORK_ERROR/);
    assert.equal(calls, 1); assert.equal(confirmed, 0);
});

test('确认消息必须先持久化，持久化失败仍向上保留完整清理上下文', async t => {
    const { telegram, file, part } = fixture(t, async (_url, init) => { await consume(init.body); return reply(message(22, 'safe', 8)); });
    let bound;
    await assert.rejects(telegram.pushChunk(backend, file, part, () => {}, {
        onConfirmed: remote => { bound = remote; throw new Error('MANIFEST_WRITE_FAILED'); },
        onState: state => { if (bound && state !== 'push_confirmed') throw new Error('INVALID_CONFIRMED_STATE_TRANSITION'); }
    }), error => error.message === 'MANIFEST_WRITE_FAILED' && error.unremovedParts[0].messageId === 22);
    assert.equal(bound.fileId, 'safe');
});

test('使用 file_id 前验证仍有效；失效时移除复用映射并使用原分片', async t => {
    const methods = []; let invalidated = 0;
    const { telegram, file, part } = fixture(t, async (url, init) => {
        const method = url.split('/').pop(); methods.push(method);
        if (method === 'getFile') return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Wrong file identifier' }), { status: 400 });
        await consume(init.body); return reply(message(23));
    });
    const result = await telegram.pushChunk(backend, file, { ...part, reuseFileId: 'old' }, () => {}, { onReuseRejected: () => { invalidated++; } });
    assert.equal(result.messageId, 23); assert.equal(invalidated, 1); assert.deepEqual(methods, ['getFile', 'sendDocument']);
});

test('多个复用分片的getFile校验同样受chat并发上限约束', async t => {
    const held = deferred(); let active = 0, maxActive = 0, checks = 0, sends = 0;
    const scheduler = createTelegramUploadScheduler({ globalLimit: 4, chatLimit: 2, pacingMs: 0 });
    const { telegram, file, part } = fixture(t, async (url, init) => {
        active++; maxActive = Math.max(maxActive, active);
        try {
            if (url.endsWith('/getFile')) { checks++; await held.promise; return reply({ file_path: 'valid.bin', file_size: 8 }); }
            sends++; assert.equal(typeof init.body, 'string'); return reply(message(100 + sends, 'reused-' + sends, 8));
        } finally { active--; }
    }, scheduler);
    const pending = Array.from({ length: 6 }, (_, index) => telegram.pushChunk(backend, file, { ...part, reuseFileId: 'cached-' + index }, () => {}, { uploadId: 'upload-' + index }));
    await tick(); assert.equal(checks, 2); assert.equal(maxActive, 2); assert.equal(sends, 0);
    held.resolve(); await Promise.all(pending);
    assert.equal(checks, 6); assert.equal(sends, 6); assert.equal(maxActive, 2);
});

test('复用校验429在scheduler之外等待后再入队，读请求响应丢失可安全重试', async t => {
    const retried = deferred(), methods = [], retryDetails = []; let checks = 0;
    const { telegram, file, part } = fixture(t, async (url, init) => {
        const method = url.split('/').pop(); methods.push(method);
        if (method === 'getFile') {
            checks++;
            if (checks === 1) return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } }), { status: 429 });
            if (checks === 2) throw Object.assign(new Error('read response lost'), { code: 'ECONNRESET' });
            return reply({ file_path: 'valid.bin', file_size: 8 });
        }
        assert.equal(typeof init.body, 'string'); return reply(message(101, 'reused', 8));
    });
    const pending = telegram.pushChunk(backend, file, { ...part, reuseFileId: 'cached' }, () => {}, { onRetry: details => { retryDetails.push(details); retried.resolve(); } });
    await retried.promise; await tick(); assert.equal(telegram.scheduler.snapshot().inflight, 0);
    const remote = await pending;
    assert.equal(remote.fileId, 'reused'); assert.equal(telegram.scheduler.snapshot().rateLimits, 1);
    assert.deepEqual(methods, ['getFile', 'getFile', 'getFile', 'sendDocument']);
    assert.equal(retryDetails.length, 2); assert.equal(retryDetails.every(details => details.stage === 'reuse-validation'), true);
});

test('最终媒体组 1、11、21 片划分无单项尾组', () => {
    for (const [count, expected] of [[1, [1]], [2, [2]], [10, [10]], [11, [9, 2]], [12, [10, 2]], [20, [10, 10]], [21, [10, 9, 2]]]) assert.deepEqual(partitionMediaGroups(Array.from({ length: count }, (_, index) => index)).map(group => group.length), expected);
});

test('最终组采用新响应 file_id 并逐组持久化；后续失败不删 temp，重启只发剩余组', async t => {
    const parts = Array.from({ length: 11 }, (_, index) => ({ logicalFileId: 'logical', fileIndex: 0, partIndex: index + 1, partCount: 11, originalSize: 11, size: 1, offset: index, fileId: 'temp-' + index, messageId: index + 1 }));
    const groups = [], methods = [], started = []; let calls = 0, failSecond = true;
    const { telegram, file } = fixture(t, async (url, init) => {
        methods.push(url.split('/').pop()); const payload = JSON.parse(init.body); calls++;
        assert.equal(payload.media.some(item => item.media.startsWith('attach:')), false, '最终组不能再次上传正文');
        for (const item of payload.media) { assert.match(item.caption, /logical_file_id: logical/); assert.doesNotMatch(item.caption, /(?:^|\n)(?:file_id|message_id|album_id):/); }
        if (calls === 2 && failSecond) return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'permission denied' }), { status: 403 });
        return reply(payload.media.map((_item, index) => message(100 + calls * 10 + index, 'final-' + calls + '-' + index, 1)));
    });
    const context = { groups, onGroupStarted: async index => started.push(index), onGroupConfirmed: async (group, groupIndex) => groups.push({ groupIndex, parts: group }) };
    await assert.rejects(telegram.finalizeGroups(backend, { ...file, size: 11 }, parts, context), /TELEGRAM_403/);
    assert.equal(groups.length, 1); assert.equal(groups[0].parts.length, 9); assert.match(groups[0].parts[0].fileId, /^final-/);
    failSecond = false; const result = await telegram.finalizeGroups(backend, { ...file, size: 11 }, parts, context);
    assert.equal(result.length, 11); assert.deepEqual(started, [0, 1, 1]);
    assert.deepEqual(methods, ['sendMediaGroup', 'sendMediaGroup', 'sendMediaGroup']);
    assert.equal(groups.length, 2);
});

test('一片直接持久化复用原消息，不调用 sendMediaGroup', async t => {
    const { telegram, file, part } = fixture(t, () => { throw new Error('must not call'); }); let saved;
    const remote = { ...part, fileId: 'single', messageId: 22 };
    const result = await telegram.finalizeGroups(backend, file, [remote], { onGroupConfirmed: async value => { saved = value; } });
    assert.equal(result[0].messageId, 22); assert.equal(saved[0].fileId, 'single');
});

test('最终组响应丢失只记录 unknown，保持已经确认的 temp/final 数据', async t => {
    let calls = 0, unknown;
    const { telegram, file, part } = fixture(t, () => { calls++; throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); });
    const parts = [1, 2].map(index => ({ ...part, partIndex: index, partCount: 2, fileId: 'temp-' + index, messageId: index }));
    await assert.rejects(telegram.finalizeGroups(backend, file, parts, { onGroupFailure: async (_index, result) => { unknown = result.unknown; } }), /TELEGRAM_NETWORK_ERROR/);
    assert.equal(calls, 1); assert.equal(unknown, true); assert.deepEqual(parts.map(part => part.fileId), ['temp-1', 'temp-2']);
});

test('真实manifest的确认组remotes恢复，未确认finalizing/unknown intent拒绝重发', async t => {
    const { telegram, file, part } = fixture(t, () => { throw new Error('must not call'); });
    const parts = [1, 2].map(index => ({ ...part, partIndex: index, partCount: 2, fileId: 'temp-' + index, messageId: index }));
    const confirmed = parts.map(item => ({ ...item, fileId: 'final-' + item.partIndex, messageId: 40 + item.partIndex }));
    const result = await telegram.finalizeGroups(backend, file, parts, { groups: [{ index: 0, status: 'confirmed', remotes: confirmed }] });
    assert.deepEqual(result.map(item => item.fileId), ['final-1', 'final-2']);
    for (const status of ['unknown', 'finalizing', 'submitting']) await assert.rejects(telegram.finalizeGroups(backend, file, parts, { groups: [{ index: 0, status, remotes: [] }] }), /UPLOAD_FINAL_RESULT_UNKNOWN/);
});

test('临时消息清理每批不超过100，确认回调逐批执行且拒绝删除最终ID', async t => {
    const batches = [], confirmed = [];
    const { telegram } = fixture(t, async (url, init) => { assert.match(url, /\/deleteMessages$/); batches.push(JSON.parse(init.body).message_ids); return reply(true); });
    const parts = Array.from({ length: 201 }, (_, index) => ({ messageId: index + 1, messageDate: Date.now(), fileId: 'temp-' + index, partIndex: index + 1 }));
    await telegram.cleanupTemporaryMessages(backend, { name: 'x', channelId: backend.channelId, parts }, { onCleanupBatchConfirmed: ids => confirmed.push(ids) });
    assert.deepEqual(batches.map(ids => ids.length), [100, 100, 1]); assert.deepEqual(confirmed, batches);
    await assert.rejects(telegram.cleanupTemporaryMessages(backend, { name: 'x', channelId: backend.channelId, parts: parts.slice(0, 2) }, { finalMessageIds: [2] }), /TELEGRAM_TEMP_CLEANUP_INVALID/);
    assert.equal(batches.length, 3);
});

test('临时清理429释放scheduler槽并反馈；丢失delete响应也可幂等重试', async t => {
    const retry = deferred(), times = []; let calls = 0;
    const { telegram } = fixture(t, async (_url, _init) => {
        calls++; times.push(Date.now());
        if (calls === 1) return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } }), { status: 429 });
        if (calls === 2) throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
        return reply(true);
    });
    const pending = telegram.cleanupTemporaryMessages(backend, { name: 'x', channelId: backend.channelId, parts: [{ messageId: 1, fileId: 'temp', messageDate: Date.now() }] }, { onCleanupRetry: () => retry.resolve() });
    await retry.promise; await tick(); assert.equal(telegram.scheduler.snapshot().inflight, 0);
    await pending; assert.equal(calls, 3); assert.ok(times[1] - times[0] >= 950); assert.equal(telegram.scheduler.snapshot().rateLimits, 1);
});

test('超过47小时57分的临时消息沿用占位文件替换语义', async t => {
    const methods = [], { telegram } = fixture(t, async (url, init) => {
        const method = url.split('/').pop(); methods.push(method);
        if (method === 'sendDocument') { await consume(init.body); return reply(message(40, 'placeholder')); }
        if (method === 'editMessageMedia') { const payload = JSON.parse(init.body); assert.equal(payload.message_id, 6); assert.equal(payload.media.media, 'placeholder'); assert.equal(payload.media.caption, 'old.zip 已删除'); }
        return reply(true);
    });
    await telegram.cleanupTemporaryMessages(backend, { name: 'old.zip', channelId: backend.channelId, parts: [{ messageId: 6, fileId: 'temp', messageDate: Date.now() - 48 * 60 * 60 * 1000 }] });
    assert.deepEqual(methods, ['sendDocument', 'deleteMessage', 'editMessageMedia']);
});
