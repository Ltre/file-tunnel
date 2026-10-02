'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createDiskTelegram } = require('../server/disk-telegram');
const { buildTelegramDocumentsMultipart } = require('../server/telegram-multipart');

const backend = { token: '123:fixture-token', baseUrl: 'https://example.test', channelId: '-1' };
const reply = result => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const reject = (description, status = 400) => new Response(JSON.stringify({ ok: false, error_code: status, description }), { status });
const albumError = 'Bad Request: failed to send message #1 with the error message "Wrong file identifier/HTTP URL specified"';
const message = (id, fileId = 'remote-' + id) => ({ message_id: id, date: 1, document: { file_id: fileId, file_unique_id: 'unique-' + id } });
async function consume(body) {
    const chunks = []; for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}
function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-telegram-recovery-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const files = [{ logicalId: 'webp', name: 'cover.webp', type: 'image/webp', size: 3 }, { logicalId: 'winmd', name: 'types.winmd', type: 'application/octet-stream', size: 3 }];
    const parts = files.map((file, index) => {
        const filename = path.join(dataDir, String(index)); fs.writeFileSync(filename, index ? 'def' : 'abc');
        return { fileIndex: index, logicalFileId: file.logicalId, partIndex: 1, partCount: 1, originalSize: 3, offset: 0, start: 0, end: 2, size: 3, path: filename, name: file.name, type: file.type };
    });
    return { dataDir, files, parts };
}

test('文档相册每项显式禁用内容探测，保留 attach 对应及完整 multipart 长度', async t => {
    const { parts } = fixture(t);
    const multipart = buildTelegramDocumentsMultipart({ chatId: '-1', files: parts, disableContentTypeDetection: true });
    const body = await consume(multipart.body), media = JSON.parse(/name="media"\r\n\r\n([^\r]+)/.exec(body.toString())[1]);
    assert.equal(body.length, multipart.contentLength);
    assert.deepEqual(media.map(item => [item.type, item.media, item.disable_content_type_detection]), [['document', 'attach://file0', true], ['document', 'attach://file1', true]]);
    assert.match(body.toString(), /filename="cover\.webp"/);
    assert.match(body.toString(), /filename="types\.winmd"/);
});

for (const methodName of ['uploadPhysical', 'upload']) {
    test(`${methodName} 对明确文档相册 400 拆单，并保持消息与逻辑文件对应`, async t => {
        const { dataDir, files, parts } = fixture(t), methods = []; let sent = 0;
        const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, init) => {
            const method = url.split('/').pop(); methods.push(method);
            if (method === 'sendMediaGroup') { await consume(init.body); return reject(albumError); }
            if (method === 'sendDocument') { const body = (await consume(init.body)).toString(); assert.match(body, /name="disable_content_type_detection"\r\n\r\ntrue/); return reply(message(++sent)); }
            if (method === 'editMessageCaption') return reply(true);
            throw new Error('unexpected method ' + method);
        } });
        const result = methodName === 'uploadPhysical'
            ? await telegram.uploadPhysical(backend, files, parts)
            : await telegram.upload(backend, files.map((file, index) => ({ ...file, path: parts[index].path })), () => {});
        assert.deepEqual(methods.filter(method => method.startsWith('send')), ['sendMediaGroup', 'sendDocument', 'sendDocument']);
        assert.deepEqual(result.map(remote => remote.logicalFileId), ['webp', 'winmd']);
        assert.deepEqual(result.map(remote => remote.messageId), [1, 2]);
    });
}

test('相册降级后后续单发失败，回滚已确认的消息', async t => {
    const { dataDir, files, parts } = fixture(t), deleted = []; let sent = 0;
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, init) => {
        const method = url.split('/').pop();
        if (method === 'sendMediaGroup') { await consume(init.body); return reject(albumError); }
        if (method === 'sendDocument') { await consume(init.body); return ++sent === 1 ? reply(message(11)) : reject('Bad Request: file must be non-empty'); }
        if (method === 'editMessageCaption') return reply(true);
        if (method === 'deleteMessages') { deleted.push(...JSON.parse(init.body).message_ids); return reply(true); }
        throw new Error('unexpected method ' + method);
    } });
    await assert.rejects(telegram.uploadPhysical(backend, files, parts), /TELEGRAM_400/);
    assert.deepEqual(deleted, [11]);
    assert.equal(sent, 2, '单发的 400 不能继续反复重试');
});

test('相册降级后内部回滚失败，向外保留完整已确认消息并维持原始失败', async t => {
    const { dataDir, files, parts } = fixture(t), cleanup = []; let sent = 0;
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, init) => {
        const method = url.split('/').pop();
        if (method === 'sendMediaGroup') { await consume(init.body); return reject(albumError); }
        if (method === 'sendDocument') { await consume(init.body); return ++sent === 1 ? reply(message(11)) : reject('Bad Request: file must be non-empty'); }
        if (method === 'editMessageCaption') return reply(true);
        if (method === 'deleteMessages') { cleanup.push(JSON.parse(init.body).message_ids); return reject('Forbidden: cleanup unavailable', 403); }
        throw new Error('unexpected method ' + method);
    } });
    await assert.rejects(telegram.uploadPhysical(backend, files, parts), error => {
        assert.equal(error.message, 'TELEGRAM_400');
        assert.equal(error.telegramDescription, 'Bad Request: file must be non-empty');
        assert.deepEqual(error.unremovedParts.map(part => [part.messageId, part.fileId, part.fileIndex, part.logicalFileId, part.partIndex, part.offset, part.size]), [[11, 'remote-11', 0, 'webp', 1, 0, 3]]);
        return true;
    });
    assert.deepEqual(cleanup, [[11]]);
});

for (const outerCleanupSucceeds of [false, true]) {
    test(`递归子调用清理失败与父层已接受消息合并，父层删除${outerCleanupSucceeds ? '成功清空记录' : '失败保留全部记录'}`, async t => {
        const { dataDir, files, parts } = fixture(t), cleanup = []; let sent = 0;
        const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, init) => {
            const method = url.split('/').pop();
            if (method === 'sendMediaGroup') { await consume(init.body); return reject(albumError); }
            if (method === 'sendDocument') { await consume(init.body); return reply(++sent === 1 ? message(11) : { message_id: 12, date: 1 }); }
            if (method === 'editMessageCaption') return reply(true);
            if (method === 'deleteMessages') {
                cleanup.push(JSON.parse(init.body).message_ids);
                return outerCleanupSucceeds && cleanup.length === 2 ? reply(true) : reject('Forbidden: cleanup unavailable', 403);
            }
            throw new Error('unexpected method ' + method);
        } });
        await assert.rejects(telegram.uploadPhysical(backend, files, parts), error => {
            assert.equal(error.message, 'TELEGRAM_UPLOAD_RESULT_INVALID', '清理异常不能替换原始错误');
            assert.deepEqual(error.details, { expectedMessages: 1, receivedMessages: 1 });
            assert.deepEqual(error.unremovedParts.map(part => [part.messageId, part.fileIndex, part.partIndex]), outerCleanupSucceeds ? [] : [[11, 0, 1], [12, 1, 1]]);
            return true;
        });
        assert.deepEqual(cleanup, [[12], [11, 12]]);
    });
}

test('invalid-result 额外返回的消息仍保留清理上下文，不作为有效分片提交', async t => {
    const { dataDir, files, parts } = fixture(t), cleanup = [];
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, init) => {
        const method = url.split('/').pop();
        if (method === 'sendMediaGroup') { await consume(init.body); return reply([message(11), message(12), message(13)]); }
        if (method === 'deleteMessages') { cleanup.push(JSON.parse(init.body).message_ids); return reject('Forbidden: cleanup unavailable', 403); }
        throw new Error('unexpected method ' + method);
    } });
    await assert.rejects(telegram.uploadPhysical(backend, files, parts), error => {
        assert.equal(error.message, 'TELEGRAM_UPLOAD_RESULT_INVALID');
        assert.deepEqual(error.unremovedParts.map(part => part.messageId), [11, 12, 13]);
        assert.equal(error.unremovedParts[2].resultUnmapped, true);
        return true;
    });
    assert.deepEqual(cleanup, [[11, 12, 13]]);
});

test('invalid-result 包含空消息时仍清理可识别消息，避免抛出 TypeError', async t => {
    const { dataDir, files, parts } = fixture(t), cleanup = [];
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, init) => {
        const method = url.split('/').pop();
        if (method === 'sendMediaGroup') { await consume(init.body); return reply([null, message(12)]); }
        if (method === 'deleteMessages') { cleanup.push(JSON.parse(init.body).message_ids); return reply(true); }
        throw new Error('unexpected method ' + method);
    } });
    await assert.rejects(telegram.uploadPhysical(backend, files, parts), error => error.message === 'TELEGRAM_UPLOAD_RESULT_INVALID' && error.unremovedParts.length === 0);
    assert.deepEqual(cleanup, [[12]]);
});

test('复用相册被拒绝后拆单；失效 file_id 明确拒绝后清理索引并重新上传本地原字节', async t => {
    const { dataDir, files, parts } = fixture(t), requests = [], rejected = [];
    const reused = parts.map((part, index) => ({ ...part, reuseFileId: 'cached-' + index }));
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, init) => {
        const method = url.split('/').pop(), json = typeof init.body === 'string'; requests.push([method, json]);
        if (method === 'sendMediaGroup') return reject(albumError);
        if (method === 'sendDocument' && json) return JSON.parse(init.body).document === 'cached-0' ? reject('Bad Request: wrong file identifier/HTTP URL specified') : reply(message(12, 'cached-1'));
        if (method === 'sendDocument') { assert.match((await consume(init.body)).toString(), /\r\nabc\r\n/); return reply(message(11)); }
        if (method === 'editMessageCaption') return reply(true);
        throw new Error('unexpected method ' + method);
    } });
    const result = await telegram.uploadPhysical(backend, files, reused, () => {}, { onReuseRejected: part => rejected.push([part.logicalFileId, part.reuseFileId]) });
    assert.deepEqual(rejected, [['webp', 'cached-0']]);
    assert.deepEqual(result.map(remote => remote.fileId), ['remote-11', 'cached-1']);
    assert.deepEqual(requests.filter(([method]) => method.startsWith('send')), [['sendMediaGroup', true], ['sendDocument', true], ['sendDocument', false], ['sendDocument', true]]);
    assert.equal(reused[0].reuseFileId, 'cached-0', '传入的分片计划不得原地修改');
});

test('无本地字节的复用单发失败保留错误，不能伪造重新上传', async t => {
    const { dataDir, files, parts } = fixture(t); let requests = 0;
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async () => { requests++; return reject('Bad Request: wrong file identifier/HTTP URL specified'); } });
    await assert.rejects(telegram.uploadPhysical(backend, files, [{ ...parts[0], path: undefined, reuseFileId: 'cached' }]), /TELEGRAM_400/);
    assert.equal(requests, 1);
});

test('权限、参数等其它相册 400 不触发拆单', async t => {
    const { dataDir, files, parts } = fixture(t); let requests = 0;
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async (_url, init) => { requests++; await consume(init.body); return reject('Bad Request: chat not found'); } });
    await assert.rejects(telegram.uploadPhysical(backend, files, parts), /TELEGRAM_400/);
    assert.equal(requests, 1);
});

for (const methodName of ['uploadPhysical', 'upload']) {
    test(`${methodName} 即使本地已产生字节，明确 connect 失败仍可安全重试`, async t => {
        const { dataDir, files, parts } = fixture(t), bodies = []; let requests = 0;
        const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, init) => {
            if (url.endsWith('/editMessageCaption')) return reply(true);
            bodies.push((await consume(init.body)).toString());
            if (++requests === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
            return reply(message(1));
        } });
        const result = methodName === 'uploadPhysical'
            ? await telegram.uploadPhysical(backend, files, [parts[0]])
            : await telegram.upload(backend, [{ ...files[0], path: parts[0].path }], () => {});
        assert.equal(result.length, 1); assert.equal(requests, 2);
        assert.ok(bodies.every(body => /\r\nabc\r\n/.test(body)), '每次重试必须重建可读请求体');
        const rows = fs.readFileSync(path.join(dataDir, 'disk-upload.log'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.ok(rows.some(row => row.event.endsWith('batch-retry') && row.producedBytes === 3 && row.details.requestNotAccepted));
    });
}

test('纯 DNS/connect 故障只做有界重试', async t => {
    const { dataDir, files, parts } = fixture(t); let requests = 0;
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async (_url, init) => {
        requests++; await consume(init.body);
        throw new TypeError('fetch failed', { cause: new AggregateError([Object.assign(new Error('dns'), { code: 'ENOTFOUND' }), Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })]) });
    } });
    await assert.rejects(telegram.uploadPhysical(backend, files, [parts[0]]), error => error.message === 'TELEGRAM_NETWORK_ERROR' && error.details.requestNotAccepted);
    assert.equal(requests, 3);
});

test('响应头超时、socket 重置、响应体故障、混合 AggregateError 均不能盲目重发', async t => {
    const { dataDir, files, parts } = fixture(t);
    for (const scenario of ['headers-timeout', 'socket-before-body', 'socket-after-body', 'response-body', 'mixed-aggregate', 'cached-json', 'unspecified-timeout', 'unspecified-network']) {
        let requests = 0;
        const telegram = createDiskTelegram({ dataDir, fetchImpl: async (_url, init) => {
            requests++;
            if (scenario === 'headers-timeout' || scenario === 'socket-after-body' || scenario === 'response-body') await consume(init.body);
            const cause = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
            if (scenario === 'response-body') return { ok: true, status: 200, json: async () => { throw Object.assign(new Error('dns during response'), { code: 'ENOTFOUND' }); } };
            if (scenario === 'mixed-aggregate') throw new TypeError('fetch failed', { cause: new AggregateError([Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }), cause]) });
            if (scenario === 'headers-timeout') throw new TypeError('fetch failed', { cause: Object.assign(new Error('headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
            if (scenario === 'unspecified-timeout') throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
            if (scenario === 'unspecified-network') throw new TypeError('fetch failed');
            throw new TypeError('fetch failed', { cause });
        } });
        const part = scenario === 'cached-json' ? { ...parts[0], reuseFileId: 'cached' } : parts[0];
        await assert.rejects(telegram.uploadPhysical(backend, files, [part]), error => error.message === 'TELEGRAM_NETWORK_ERROR' && !error.details.requestNotAccepted, scenario);
        assert.equal(requests, 1, scenario);
    }
});

test('已经取消的上传即使随后报告 connect 失败，也不能继续重试', async t => {
    const { dataDir, files, parts } = fixture(t);
    for (const methodName of ['uploadPhysical', 'upload']) {
        const controller = new AbortController(); let requests = 0;
        const telegram = createDiskTelegram({ dataDir, fetchImpl: async () => {
            requests++; controller.abort();
            throw Object.assign(new Error('dns failed after cancellation'), { code: 'ENOTFOUND' });
        } });
        const promise = methodName === 'uploadPhysical'
            ? telegram.uploadPhysical(backend, files, [parts[0]], () => {}, { signal: controller.signal })
            : telegram.upload(backend, [{ ...files[0], path: parts[0].path }], () => {}, [], { signal: controller.signal });
        await assert.rejects(promise, error => error.message === 'TELEGRAM_NETWORK_ERROR' && !error.details.requestNotAccepted);
        assert.equal(requests, 1, methodName);
    }
});

test('Telegram 错误描述与 details 脱敏后保留请求定位信息', async t => {
    const { dataDir } = fixture(t);
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async () => reject('Bad Request: wrong file identifier https://example.test/bot123:fixture-token/file 123:fixture-token') });
    await assert.rejects(telegram.call(backend, 'getFile', { file_id: 'fixture' }), error => {
        assert.equal(error.message, 'TELEGRAM_400');
        assert.equal(error.details.method, 'getFile'); assert.ok(error.details.requestId);
        assert.equal(error.details.telegramDescription, error.telegramDescription);
        assert.ok(!JSON.stringify(error.details).includes(backend.token));
        assert.ok(!error.telegramDescription.includes('https://')); return true;
    });
});

test('封面等待响应采用独立有界超时，不盲目重发', async t => {
    const { dataDir, files, parts } = fixture(t); let requests = 0;
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async (_url, init) => {
        requests++; await consume(init.body);
        await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    } });
    // AbortSignal.timeout is unref'd, so keep the test process alive explicitly.
    const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
    const started = Date.now();
    await assert.rejects(telegram.uploadThumbnail(backend, files[0], { path: parts[0].path, size: 3, type: 'image/jpeg' }, { timeoutMs: 30 }), error => {
        assert.equal(error.message, 'TELEGRAM_NETWORK_ERROR');
        assert.equal(error.details.name, 'TimeoutError');
        assert.equal(error.details.method, 'sendDocument');
        assert.equal(error.details.requestNotAccepted, false);
        return true;
    });
    assert.equal(requests, 1); assert.ok(Date.now() - started < 2000);
});

test('致命错误先通知流水线，再等待内部远程清理', async t => {
    const { dataDir, files, parts } = fixture(t), order = []; let sends = 0;
    const telegram = createDiskTelegram({ dataDir, fetchImpl: async (url, init) => {
        if (url.endsWith('/sendMediaGroup')) { await consume(init.body); return reject(albumError); }
        if (url.endsWith('/sendDocument')) { await consume(init.body); return ++sends === 1 ? reply(message(11)) : reject('Bad Request: invalid file'); }
        if (url.endsWith('/editMessageCaption')) return reply(true);
        if (url.endsWith('/deleteMessages')) { order.push('cleanup'); return reply(true); }
        throw new Error('unexpected request');
    } });
    await assert.rejects(telegram.uploadPhysical(backend, files, parts, () => {}, { onFailure: error => { order.push('failure'); assert.equal(error.message, 'TELEGRAM_400'); } }), /TELEGRAM_400/);
    assert.ok(order.indexOf('failure') < order.indexOf('cleanup'));
});
