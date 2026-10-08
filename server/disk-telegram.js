'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { buildTelegramDocumentsMultipart } = require('./telegram-multipart');
const { openDiskRepository } = require('./disk-repository');
const { MAX_TELEGRAM_PART_SIZE, MAX_TELEGRAM_BATCH_SIZE } = require('./disk-limits');
const { createDiskUploadLog, networkDetails } = require('./disk-upload-log');
const { observeTelegramUpload } = require('./telegram-upload-progress');
const { telegramUploadScheduler } = require('./telegram-upload-scheduler');
const DELETE_WINDOW_MS = (47 * 60 + 57) * 60 * 1000;
// Telegram guarantees file links for at least one hour. Keep a shorter,
// process-local lease so each media Range does not first repeat getFile.
const FILE_PATH_LEASE_MS = 45 * 60 * 1000;
const messageMedia = message => message?.document || message?.video || message?.audio || message?.animation || message?.voice || message?.video_note;
// A consumed Readable only proves local byte production. DNS/connect failures
// prove that no HTTP request reached Telegram, even if fetch buffered that body.
function connectionFailedBeforeRequest(error, seen = new Set()) {
    if (!error || seen.has(error)) return false;
    seen.add(error);
    if (Array.isArray(error.errors) && error.errors.length) return error.errors.every(item => connectionFailedBeforeRequest(item, new Set(seen)));
    if (/^(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT)$/.test(String(error.code || ''))) return true;
    if (/^(?:ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)$/.test(String(error.code || '')) && error.syscall === 'connect') return true;
    return connectionFailedBeforeRequest(error.cause, seen);
}
const rejectedFileIdentifier = error => error.message === 'TELEGRAM_400' && /wrong (?:remote )?file identifier|file[_ ]?id.*(?:invalid|wrong)|file reference.*(?:expired|invalid)/i.test(error.telegramDescription || '');
const rejectedDocumentAlbum = error => rejectedFileIdentifier(error) || (error.message === 'TELEGRAM_400' && /type ["']?(?:animation|sticker|video|audio)["']? can't be used in sendMediaGroup|document.*(?:type.*(?:unsupported|invalid)|can't be grouped)/i.test(error.telegramDescription || ''));
function partSizeFailure(error, seen = new Set()) {
    if (!error || seen.has(error)) return false;
    seen.add(error);
    if (error.code === 'TELEGRAM_PART_SIZE_MISMATCH' || error.message === 'TELEGRAM_PART_SIZE_MISMATCH') return true;
    return partSizeFailure(error.cause, seen);
}
function diskCaption(file, backend, context = {}, remote = {}) {
    if(file.contentCandidateId || file.contentId) {
        const fields=['Telegram Content Object', 'content_id: '+(file.contentId || file.contentCandidateId),
        'physical_revision: '+(file.physicalRevision || 1),
        'part: '+(remote.partIndex || 1)+'/'+(remote.partCount || file.parts?.length || 1), 'original_size: '+file.size,
        'channel_id: '+backend.channelId,
        ...(remote.fileId ? ['file_id: '+remote.fileId,'message_id: '+remote.messageId] : [])];
        let caption=fields.join('\n');
        if(caption.length>1024)throw new Error('CONTENT_CAPTION_TOO_LONG');
        for(const field of [...(remote.sha256?['part_sha256: '+remote.sha256]:[]),'original_name: '+String(file.name || '').slice(0,180)]) {
            const available=1024-caption.length-1;if(available<=0)break;
            caption+='\n'+field.slice(0,available);
        }
        return caption;
    }
    const fields = ['网盘文件', 'user_id: ' + (context.userId || ''), 'disk_space: ' + (context.diskSpace || ''), 'name: ' + file.name, 'channel_id: ' + backend.channelId];
    if (file.logicalId || remote.logicalFileId) fields.push('logical_file_id: ' + (file.logicalId || remote.logicalFileId));
    if (remote.partCount) fields.push('part: ' + remote.partIndex + '/' + remote.partCount, 'original_size: ' + (remote.originalSize || file.size || 0));
    if (remote.fileId) fields.push('file_id: ' + remote.fileId, 'message_id: ' + remote.messageId, 'album_id: ' + (remote.mediaGroupId || ''));
    return fields.join('\n').slice(0, 1024);
}
function diskThumbnailCaption(file, backend, context = {}) {
    if(file.contentCandidateId || file.contentId) return ['Content Object thumbnail','content_id: '+(file.contentId || file.contentCandidateId),'physical_revision: '+(file.physicalRevision || 1),'channel_id: '+backend.channelId].join('\n');
    return ['网盘视频封面', 'user_id: ' + (context.userId || ''), 'disk_space: ' + (context.diskSpace || ''), 'name: ' + file.name, 'channel_id: ' + backend.channelId, 'logical_file_id: ' + (file.logicalId || '')].join('\n').slice(0, 1024);
}
function partitionMediaGroups(parts) {
    if (!Array.isArray(parts) || !parts.length) throw new Error('TELEGRAM_PARTS_INVALID');
    if (parts.length === 1) return [parts.slice()];
    const groups = [];
    for (let offset = 0; offset < parts.length;) {
        const remaining = parts.length - offset;
        const count = remaining === 11 ? 9 : Math.min(10, remaining);
        groups.push(parts.slice(offset, offset + count)); offset += count;
    }
    return groups;
}
function createDiskTelegram({ fetchImpl = fetch, getBaseUrl = () => 'https://api.telegram.org', dataDir = path.join(__dirname, '..', '.tunnel-data'), now = Date.now, resolveChatIdentifier = value => value, uploadScheduler = telegramUploadScheduler }) {
    const repository = openDiskRepository(dataDir);
    let anchorGuard = physical => repository.content.allowed(physical);
    const placeholdersInFlight = new Map();
    const filePaths = new Map(), filePathRequests = new Map();
    const log = createDiskUploadLog(dataDir);
    async function call(backend, method, payload, init, retry = 0, trace = {}) {
        if (!backend?.token) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
        if (payload && !init) {
            payload = { ...payload };
            for (const key of ['chat_id', 'from_chat_id']) if (payload[key]) payload[key] = resolveChatIdentifier(payload[key]);
        }
        let response, data;
        const started = Date.now(), requestId = crypto.randomUUID();
        const { signal: cancelSignal, timeoutMs, onUploadProgress, payloadRanges, managedRetry, ...traceFields } = trace;
        const fields = { ...traceFields, requestId, method, retry, channelId: backend.channelId, messageId: payload?.message_id, requestBytes: Number(init?.headers?.['Content-Length']) || undefined };
        log('telegram.request', fields);
        const url = backend.baseUrl + '/bot' + backend.token + '/' + method;
        const transfer = init?.body ? observeTelegramUpload(url, payloadRanges, onUploadProgress) : null;
        const heartbeat = transfer ? setInterval(() => {
            const snapshot = transfer.snapshot();
            log('telegram.request-progress', { ...fields, ...snapshot, elapsedMs: Date.now() - started,
                idleMs: Date.now() - (snapshot.lastSentAt || started), waitingForResponse: Boolean(snapshot.bodySentAt) });
        }, 10000) : null;
        heartbeat?.unref?.();
        try {
            const timeoutSignal = AbortSignal.timeout(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 30 * 60 * 1000) : init ? 30 * 60 * 1000 : 45000);
            const signal = cancelSignal && typeof AbortSignal.any === 'function' ? AbortSignal.any([timeoutSignal, cancelSignal]) : (cancelSignal || timeoutSignal);
            const request = () => fetchImpl(url, init ? { ...init, signal } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
            response = await (transfer ? transfer.run(request) : request());
            log('telegram.headers', { ...fields, status: response.status, elapsedMs: Date.now() - started });
            try { data = await response.json(); }
            catch (error) { if (error instanceof SyntaxError) { data = null; log('telegram.invalid-json', fields); } else throw error; }
        } catch (cause) {
            if (managedRetry && partSizeFailure(cause)) {
                const error = new Error('TELEGRAM_PART_SIZE_MISMATCH');
                error.details = { stage: 'source-read', requestId, method, elapsedMs: Date.now() - started, ...(transfer?.snapshot() || {}) };
                log('telegram.source-invalid', { ...fields, ...error.details }); throw error;
            }
            const error = new Error('TELEGRAM_NETWORK_ERROR');
            const snapshot = transfer?.snapshot() || {};
            error.details = { ...networkDetails(cause), stage: response ? 'response-body' : 'request', requestId, method, elapsedMs: Date.now() - started, ...snapshot, requestNotAccepted: !response && !cancelSignal?.aborted && connectionFailedBeforeRequest(cause) };
            // Only diagnostics from this exact request can prove incomplete
            // transmission. A produced/read byte counter is not evidence.
            if (managedRetry && !response && !cancelSignal?.aborted && snapshot.sentFileBytes !== null && Number.isFinite(snapshot.sentFileBytes) && snapshot.sentBodyBytes < fields.requestBytes) error.details.requestIncomplete = true;
            log('telegram.network-error', { ...fields, ...error.details });
            throw error;
        } finally { clearInterval(heartbeat); transfer?.close(); }
        log('telegram.response', { ...fields, status: response.status, ok: Boolean(data?.ok), errorCode: data?.error_code, description: networkDetails({ message: data?.description }).message, elapsedMs: Date.now() - started });
        if (response.ok && !data) {
            const error = new Error('TELEGRAM_UPLOAD_RESULT_INVALID'); error.details = { requestId, method, reason: 'invalid-json' }; throw error;
        }
        if (!response.ok || !data?.ok) {
            const error = new Error('TELEGRAM_' + (data?.error_code || response.status || 'ERROR'));
            // Never pass URLs or bot credentials to an operation or client.
            error.telegramDescription = networkDetails({ message: data?.description }).message.slice(0, 200);
            error.details = { requestId, method, status: response.status, telegramDescription: error.telegramDescription };
            error.retryAfter = Math.min(managedRetry ? 86400 : 60, Math.max(1, Number(data?.parameters?.retry_after) || 1));
            if (!managedRetry && !init && error.message === 'TELEGRAM_429' && retry < 3) {
                await new Promise(resolve => setTimeout(resolve, error.retryAfter * 1000));
                return call(backend, method, payload, undefined, retry + 1, trace);
            }
            throw error;
        }
        return data.result;
    }
    const missingMessage = error => /message (?:to (?:delete|edit) )?not found/i.test(error.telegramDescription || '');
    const notModified = error => /message is not modified/i.test(error.telegramDescription || '');
    async function deleteMessageIds(backend, channelId, values, trace = {}) {
        const ids = [...new Set(values.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
        if (!ids.length) throw new Error('TELEGRAM_MESSAGE_MISSING');
        for (let offset = 0; offset < ids.length; offset += 100) {
            const batch = ids.slice(offset, offset + 100);
            try { await call(backend, 'deleteMessages', { chat_id: channelId, message_ids: batch }, undefined, 0, trace); }
            catch (error) {
                const fallback = /method not found|METHOD_INVALID/i.test(error.telegramDescription || '') || missingMessage(error) || /message (?:can'?t|cannot) be deleted/i.test(error.telegramDescription || '');
                if (!fallback) throw error;
                for (const messageId of batch) {
                    try { await call(backend, 'deleteMessage', { chat_id: channelId, message_id: messageId }, undefined, 0, trace); }
                    catch (singleError) {
                        if (missingMessage(singleError)) continue;
                        if (/message (?:can'?t|cannot) be deleted/i.test(singleError.telegramDescription || '')) throw new Error('TELEGRAM_DELETE_NOT_PERMITTED');
                        throw singleError;
                    }
                }
            }
        }
    }
    const storedParts = item => Array.isArray(item.parts) && item.parts.length
        ? item.parts.slice().sort((left, right) => Number(left.partIndex) - Number(right.partIndex))
        : [{ fileId: item.fileId, fileUniqueId: item.fileUniqueId, messageId: item.messageId, messageDate: item.messageDate || item.createdAt, mediaGroupId: item.mediaGroupId || '', partIndex: 1, partCount: 1, size: item.size, offset: 0 }];
    function validatedParts(item) {
        const parts = storedParts(item);
        let offset = 0;
        for (let index = 0; index < parts.length; index++) {
            const part = parts[index];
            if (!part.fileId || part.partIndex !== index + 1 || (part.partCount && part.partCount !== parts.length) || part.offset !== offset || !Number.isSafeInteger(part.size) || part.size < 0) throw new Error('TELEGRAM_PARTS_INVALID');
            if ((part.logicalFileId && (item.id || item.logicalFileId) && part.logicalFileId !== (item.id || item.logicalFileId)) || (part.originalSize !== undefined && part.originalSize !== item.size)) throw new Error('TELEGRAM_PARTS_INVALID');
            offset += part.size;
        }
        if ((item.partCount && item.partCount !== parts.length) || offset !== item.size) throw new Error('TELEGRAM_PARTS_INVALID');
        return parts;
    }
    async function fileLocation(backend, part, refresh = false) {
        const cacheable = backend.baseUrl === 'https://api.telegram.org';
        const key = crypto.createHash('sha256').update(String(backend.baseUrl) + '\0' + String(backend.token) + '\0' + String(part.fileId)).digest('hex');
        if (refresh) filePaths.delete(key);
        const cached = cacheable && filePaths.get(key);
        if (cached && cached.expiresAt > now()) return { ...cached.file, cacheHit: true, key };
        if (filePathRequests.has(key)) return filePathRequests.get(key);
        const pending = call(backend, 'getFile', { file_id: part.fileId }).then(file => {
            if (!file?.file_path) throw new Error('TELEGRAM_FILE_PATH_MISSING');
            if (cacheable) {
                if (filePaths.size >= 4096) {
                    for (const [id, entry] of filePaths) if (entry.expiresAt <= now()) filePaths.delete(id);
                    if (filePaths.size >= 4096) filePaths.delete(filePaths.keys().next().value);
                }
                filePaths.set(key, { file, expiresAt: now() + FILE_PATH_LEASE_MS });
            }
            return { ...file, cacheHit: false, key };
        }).finally(() => filePathRequests.delete(key));
        filePathRequests.set(key, pending);
        return pending;
    }
    async function placeholder(backend, channelId, renew = false) {
        // file_id is bot-specific; never share it between unrelated configured bots.
        const key = crypto.createHash('sha256').update(backend.baseUrl + '\0' + backend.token).digest('hex');
        if (placeholdersInFlight.has(key)) return placeholdersInFlight.get(key);
        const pending = (async () => {
            const saved = repository.load('placeholders').find(item => item.id === key);
            if (saved?.fileId && !renew) return saved.fileId;
            fs.mkdirSync(dataDir, { recursive: true });
            const filePath = path.join(dataDir, 'tg-1byte-placeholder.bin');
            fs.writeFileSync(filePath, Buffer.from([0]));
            const multipart = buildTelegramDocumentsMultipart({ chatId: channelId, files: [{ path: filePath, name: 'deleted.bin', size: 1 }], disableContentTypeDetection: true });
            const result = await call(backend, multipart.method, null, { method: 'POST', headers: { 'Content-Type': multipart.contentType, 'Content-Length': String(multipart.contentLength) }, body: multipart.body, duplex: 'half', signal: AbortSignal.timeout(45000) });
            if (!result?.document?.file_id) throw new Error('TELEGRAM_UPLOAD_RESULT_INVALID');
            try {
                const state = repository.loadWithRevision('placeholders');
                const entries = state.items.filter(item => item.id !== key);
                entries.push({ id:key, fileId:result.document.file_id });
                repository.replaceMany([{ table:'placeholders', items:entries, keyOf:item => item.id, base:state.revisions }]);
                return result.document.file_id;
            } finally {
                await call(backend, 'deleteMessage', { chat_id: channelId, message_id: result.message_id }).catch(() => {});
            }
        })();
        placeholdersInFlight.set(key, pending);
        try { return await pending; } finally { placeholdersInFlight.delete(key); }
    }
    async function replaceDeleted(backend, item, part) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const fileId = await placeholder(backend, item.channelId, attempt > 0);
            try {
                await call(backend, 'editMessageMedia', { chat_id: item.channelId, message_id: part.messageId, media: { type: 'document', media: fileId, caption: item.name + ' 已删除' } });
                return;
            } catch (error) {
                if (missingMessage(error) || notModified(error)) return;
                if (!attempt && /wrong file identifier|file_id|file reference.*expired/i.test(error.telegramDescription || '')) continue;
                throw error;
            }
        }
    }
    async function readPart(backend, part, options = {}) {
        options.signal?.throwIfAborted();
        let file = await fileLocation(backend, part);
        options.signal?.throwIfAborted();
        const start = Math.max(0, Number(options.start) || 0), end = Number.isSafeInteger(options.end) ? options.end : Number(part.size) - 1;
        if (backend.baseUrl !== 'https://api.telegram.org' && path.isAbsolute(file.file_path)) return fs.createReadStream(file.file_path, { start, end, signal: options.signal });
        let response;
        const headers = start > 0 || end < Number(part.size) - 1 ? { Range: `bytes=${start}-${end}` } : undefined;
        const timeout = AbortSignal.timeout(30 * 60 * 1000), signal = options.signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, options.signal]) : (options.signal || timeout);
        const requestFile = async () => {
            const started = Date.now();
            try {
                response = await fetchImpl(backend.baseUrl + '/file/bot' + backend.token + '/' + file.file_path, { headers, signal });
                log('telegram.file-headers', { fileKey: file.key.slice(0, 12), status: response.status, range: Boolean(headers), cacheHit: file.cacheHit, elapsedMs: Date.now() - started });
            } catch (cause) {
                log('telegram.file-network-error', { fileKey: file.key.slice(0, 12), range: Boolean(headers), elapsedMs: Date.now() - started, error: networkDetails(cause) });
                const error = new Error('TELEGRAM_DOWNLOAD_NETWORK');
                error.details = { ...networkDetails(cause), stage: 'file-download', elapsedMs: Date.now() - started };
                throw error;
            }
        };
        await requestFile();
        if (file.cacheHit && [403, 404].includes(response.status)) {
            await response.body?.cancel?.().catch(() => {});
            file = await fileLocation(backend, part, true);
            await requestFile();
        }
        if (!response.ok || !response.body) throw new Error('TELEGRAM_DOWNLOAD_FAILED');
        const stream = Readable.fromWeb(response.body);
        if (!headers) return stream;
        if (response.status === 206) {
            const contentRange = /^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/i.exec(String(response.headers.get('content-range') || ''));
            if (!contentRange || Number(contentRange[1]) !== start || Number(contentRange[2]) !== end) {
                stream.destroy();
                throw new Error('TELEGRAM_RANGE_INVALID');
            }
            return stream;
        }
        // Some Bot API proxies ignore Range. Keep correctness by discarding the
        // prefix while the cache records this exact aligned window.
        async function* sliceFallback() {
            let skipped = 0, emitted = 0, wanted = end - start + 1;
            for await (const chunk of stream) {
                if (skipped + chunk.length <= start) { skipped += chunk.length; continue; }
                const from = Math.max(0, start - skipped), take = Math.min(chunk.length - from, wanted - emitted);
                if (take > 0) { emitted += take; yield chunk.subarray(from, from + take); }
                skipped += chunk.length; if (emitted >= wanted) { stream.destroy(); break; }
            }
            if (emitted !== wanted) throw new Error('TELEGRAM_PART_SIZE_MISMATCH');
        }
        return Readable.from(sliceFallback());
    }
    function progressiveRemote(part, message) {
        const media = message?.document || {};
        return { fileId: media.file_id || '', fileUniqueId: media.file_unique_id || '', messageId: message?.message_id,
            messageDate: message?.date ? message.date * 1000 : now(), mediaType: 'document', mediaGroupId: message?.media_group_id || '',
            logicalFileId: part.logicalFileId, fileIndex: part.fileIndex, partIndex: part.partIndex, partCount: part.partCount,
            originalSize: part.originalSize, size: part.size, offset: part.offset, sha256: part.sha256 || '' };
    }
    function validProgressiveMessage(part, message) {
        return Boolean(message?.document?.file_id && Number.isSafeInteger(message?.message_id) && message.message_id > 0
            && (message.document.file_size === undefined || message.document.file_size === part.size));
    }
    const retryablePush = error => error.message === 'TELEGRAM_429'
        || (error.message === 'TELEGRAM_NETWORK_ERROR' && (error.details?.requestNotAccepted || error.details?.requestIncomplete));
    const unknownUploadResult = error => error.message === 'TELEGRAM_UPLOAD_RESULT_INVALID'
        || (error.message === 'TELEGRAM_NETWORK_ERROR' && !retryablePush(error));
    function retainRemote(error, parts) {
        error.unremovedParts = [...new Map([...(error.unremovedParts || []), ...parts].filter(part => Number.isSafeInteger(part?.messageId) && part.messageId > 0).map(part => [part.messageId, part])).values()];
        return error;
    }
    async function pushChunk(backend, file, part, update = () => {}, context = {}) {
        if (!Number.isSafeInteger(part?.size) || part.size < 0 || part.size > MAX_TELEGRAM_PART_SIZE) throw new Error('TELEGRAM_PARTS_INVALID');
        const trace = { uploadId: context.uploadId, operationId: context.operationId, fileId: part.logicalFileId || file.logicalId, part: part.partIndex, count: part.partCount, managedRetry: true };
        let reuseFileId = part.reuseFileId || '';
        if (reuseFileId && !context.reuseValidated) {
            try {
                let saved;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        // Cache verification is part of the upload workload:
                        // it must not create an unscheduled burst across jobs.
                        saved = await uploadScheduler.enqueue(backend, () => call(backend, 'getFile', { file_id: reuseFileId }, undefined, 0,
                            { ...trace, attempt, reuseValidation: true, signal: context.signal }),
                        { signal: context.signal, taskKey: context.uploadId || context.operationId });
                        break;
                    } catch (error) {
                        // getFile does not create messages, so even a lost
                        // response can safely be retried outside the slot.
                        const transient = error.message === 'TELEGRAM_429' || error.message === 'TELEGRAM_NETWORK_ERROR'
                            || error.message === 'TELEGRAM_UPLOAD_RESULT_INVALID' || /^TELEGRAM_5\d\d$/.test(error.message);
                        if (context.signal?.aborted || !transient || attempt >= 3) throw error;
                        const delayMs = uploadScheduler.feedback(backend, error, attempt);
                        await context.onRetry?.({ attempt, retryAt: now() + delayMs, delayMs, errorCode: error.message, stage: 'reuse-validation' });
                    }
                }
                if (!saved?.file_path || (saved.file_size !== undefined && saved.file_size !== part.size)) throw new Error('TELEGRAM_REUSE_INVALID');
            } catch (error) {
                if (!rejectedFileIdentifier(error) && error.message !== 'TELEGRAM_REUSE_INVALID') throw error;
                await context.onReuseRejected?.(part); reuseFileId = '';
            }
        }
        for (let attempt = 1; attempt <= 3; attempt++) {
            let multipart, message, produced = 0, pushed = null, lastBytes = 0, lastAt = now(), speed = 0, stateWrite = Promise.resolve();
            const attemptController = new AbortController();
            const onAbort = () => attemptController.abort(context.signal.reason);
            context.signal?.addEventListener('abort', onAbort, { once: true });
            if (context.signal?.aborted) onAbort();
            try {
                message = await uploadScheduler.enqueue(backend, async () => {
                    await context.onState?.('pushing', { attempt, attemptedAt: now(), reuse: Boolean(reuseFileId) });
                    update({ phase: 'telegram-upload', telegramFileIndex: Number(part.fileIndex || 0) + 1, telegramFileName: file.name,
                        telegramPartIndex: part.partIndex, telegramPartCount: part.partCount, telegramPartBytesSent: 0,
                        telegramFileSize: file.size, telegramPartSize: part.size, telegramBytesPerSecond: 0,
                        message: `正在推送第 ${part.partIndex}/${part.partCount} 个分片：${file.name}` });
                    if (reuseFileId) return call(backend, 'sendDocument', { chat_id: backend.channelId, document: reuseFileId,
                        caption: diskCaption(file, backend, context, part), disable_content_type_detection: true }, undefined, 0,
                    { ...trace, attempt, reused: true, signal: context.signal });
                    multipart = buildTelegramDocumentsMultipart({ chatId: backend.channelId, files: [{ ...part, signal: attemptController.signal, caption: diskCaption(file, backend, context, part) }], disableContentTypeDetection: true,
                        onProgress: bytes => { produced = bytes; } });
                    return call(backend, 'sendDocument', null, { method: 'POST', headers: { 'Content-Type': multipart.contentType, 'Content-Length': String(multipart.contentLength) }, body: multipart.body, duplex: 'half' }, 0,
                        { ...trace, attempt, signal: attemptController.signal, timeoutMs: context.timeoutMs, payloadRanges: multipart.payloadRanges,
                            onUploadProgress: ({ bytes, complete }) => {
                                pushed = bytes;
                                const measuredAt = now(), elapsed = measuredAt - lastAt;
                                if (elapsed > 0) { const measured = Math.max(0, bytes - lastBytes) * 1000 / elapsed; speed = speed ? speed * 0.7 + measured * 0.3 : measured; }
                                lastBytes = bytes; lastAt = measuredAt;
                                update({ phase: complete ? 'telegram-response' : 'telegram-upload', telegramPartBytesSent: bytes, telegramBytesPerSecond: speed,
                                    telegramFileIndex: Number(part.fileIndex || 0) + 1, telegramFileName: file.name, telegramPartIndex: part.partIndex, telegramPartCount: part.partCount,
                                    message: complete ? `第 ${part.partIndex}/${part.partCount} 个分片已推送，等待 Telegram 确认` : `正在推送第 ${part.partIndex}/${part.partCount} 个分片：${file.name}` });
                                if (complete) { stateWrite = stateWrite.then(() => context.onState?.('awaiting_response', { attempt, telegramPushedBytes: bytes, bodyCompleteAt: measuredAt })); stateWrite.catch(() => {}); }
                            } });
                }, { signal: context.signal, taskKey: context.uploadId || context.operationId });
                await stateWrite;
                if (!validProgressiveMessage(part, message) || (!reuseFileId && (produced !== part.size || (pushed !== null && pushed !== part.size)))) {
                    const messages = Array.isArray(message) ? message : message ? [message] : [];
                    const error = new Error('TELEGRAM_UPLOAD_RESULT_INVALID'); error.details = { expectedMessages: 1, receivedMessages: messages.length, expectedBytes: part.size, producedBytes: produced };
                    throw retainRemote(error, messages.map((item, index) => ({ ...progressiveRemote(part, item), ...(index ? { resultUnmapped: true } : {}) })));
                }
                // The reader must finish writer/SHA/manifest validation before a
                // file_id can advance this logical part to confirmed.
                await part.awaitSourceComplete?.(context.signal);
                const remote = progressiveRemote(part, message);
                try { await context.onConfirmed?.(remote); await context.onState?.('push_confirmed', { attempt, telegramPushedBytes: part.size }); }
                catch (error) { throw retainRemote(error, [remote]); }
                update({ phase: 'telegram-response', telegramPartBytesSent: part.size, telegramPartIndex: part.partIndex, telegramPartCount: part.partCount,
                    telegramFileIndex: Number(part.fileIndex || 0) + 1, telegramFileName: file.name, message: `第 ${part.partIndex}/${part.partCount} 个分片推送已确认` });
                log('telegram.chunk-confirmed', { ...trace, managedRetry: undefined, attempt, messageId: remote.messageId, bytes: remote.size });
                return remote;
            } catch (error) {
                attemptController.abort(); multipart?.body.destroy();
                await stateWrite.catch(() => {});
                if (message) retainRemote(error, (Array.isArray(message) ? message : [message]).map(item => progressiveRemote(part, item)));
                if (context.signal?.aborted) throw error;
                if (reuseFileId && rejectedFileIdentifier(error) && attempt < 3 && (part.path || part.streamFactory)) {
                    await context.onReuseRejected?.(part); reuseFileId = ''; continue;
                }
                if (retryablePush(error) && attempt < 3 && !error.unremovedParts?.length) {
                    const delayMs = uploadScheduler.feedback(backend, error, attempt);
                    await context.onState?.('retry_wait', { attempt, retryAt: now() + delayMs, errorCode: error.message, details: error.details });
                    await context.onRetry?.({ attempt, retryAt: now() + delayMs, delayMs, errorCode: error.message });
                    update({ phase: 'telegram-wait', telegramPartBytesSent: 0, message: `分片推送失败，正在重试（第 ${attempt}/2 次）` });
                    // Retry only after the browser source is fully verified. No
                    // second growing request races the failed first attempt.
                    await part.awaitSourceComplete?.(context.signal);
                    log('telegram.chunk-retry', { ...trace, managedRetry: undefined, attempt, delayMs, error: error.message, details: error.details });
                    continue;
                }
                if (error.unremovedParts?.length) {
                    // A successful remote response followed by a failed durable
                    // save is not a failed/unconfirmed chunk. The store already
                    // binds these IDs in memory; changing it to failed would
                    // reject that transition and erase the original save error.
                    log('telegram.chunk-confirmation-save-failed', { ...trace, managedRetry: undefined, attempt, error: error.message,
                        messageIds: error.unremovedParts.map(part => part.messageId) });
                    context.onFailure?.(error); throw error;
                }
                const unknown = unknownUploadResult(error);
                await context.onState?.(unknown ? 'unknown' : 'failed', { attempt, errorCode: error.message, details: error.details });
                log('telegram.chunk-failed', { ...trace, managedRetry: undefined, attempt, unknown, error: error.message, details: error.details });
                context.onFailure?.(error); throw error;
            } finally {
                context.signal?.removeEventListener('abort', onAbort);
                attemptController.abort(); multipart?.body.destroy();
            }
        }
    }
    async function finalizeGroups(backend, file, parts, context = {}) {
        const ordered = parts.slice().sort((left, right) => left.partIndex - right.partIndex);
        if (ordered.some((part, index) => !part.fileId || !Number.isSafeInteger(part.messageId) || part.partIndex !== index + 1 || part.partCount !== ordered.length)) throw new Error('TELEGRAM_PARTS_INVALID');
        const planned = partitionMediaGroups(ordered), finals = [];
        const saved = context.groups || context.finalGroups || [];
        for (let groupIndex = 0; groupIndex < planned.length; groupIndex++) {
            const group = planned[groupIndex], prior = saved.find(item => (item.groupIndex ?? item.index) === groupIndex);
            const priorParts = prior?.parts || prior?.remotes;
            if (prior?.status === 'unknown' || prior?.unknownResult || (['submitting', 'finalizing'].includes(prior?.status) && !priorParts?.length)) throw new Error('UPLOAD_FINAL_RESULT_UNKNOWN');
            if (priorParts?.length) {
                if (!Array.isArray(priorParts) || priorParts.length !== group.length || priorParts.some((part, index) => !part.fileId || !Number.isSafeInteger(part.messageId) || part.partIndex !== group[index].partIndex || part.size !== group[index].size)) throw new Error('TELEGRAM_PARTS_INVALID');
                finals.push(...priorParts); continue;
            }
            if (group.length === 1) { await context.onGroupConfirmed?.(group, groupIndex); finals.push(...group); continue; }
            let messages;
            for (let attempt = 1; attempt <= 3; attempt++) {
                const trace = { uploadId: context.uploadId, operationId: context.operationId, fileId: file.logicalId, groupIndex, attempt, managedRetry: true, signal: context.signal };
                try {
                    messages = await uploadScheduler.enqueue(backend, async () => {
                        await context.onGroupStarted?.(groupIndex, { attempt, partIndexes: group.map(part => part.partIndex) });
                        context.update?.({ phase: 'telegram-finalizing', finalizationGroupIndex: groupIndex + 1, finalizationGroupCount: planned.length,
                            message: `正在提交最终媒体组 · ${groupIndex + 1}/${planned.length}` });
                        return call(backend, 'sendMediaGroup', { chat_id: backend.channelId, media: group.map(part => ({ type: 'document', media: part.fileId,
                            // This is a new message: temporary IDs are about to
                            // be cleaned up and must not leak into its caption.
                            // The returned final IDs are authoritative in SQL.
                            caption: diskCaption(file, backend, context, { logicalFileId: part.logicalFileId,
                                partIndex: part.partIndex, partCount: part.partCount, originalSize: part.originalSize }), disable_content_type_detection: true })) }, undefined, 0, trace);
                    }, { signal: context.signal, taskKey: context.uploadId || context.operationId, cost: group.length });
                    break;
                } catch (error) {
                    if (context.signal?.aborted) throw error;
                    if (retryablePush(error) && attempt < 3) { const delayMs = uploadScheduler.feedback(backend, error, attempt); await context.onGroupRetry?.(groupIndex, { attempt, retryAt: now() + delayMs, errorCode: error.message }); continue; }
                    await context.onGroupFailure?.(groupIndex, { unknown: unknownUploadResult(error), errorCode: error.message, details: error.details });
                    error.finalParts = finals; throw error;
                }
            }
            const received = Array.isArray(messages) ? messages : [];
            const remotes = received.map((message, index) => progressiveRemote(group[index] || group[0], message));
            if (received.length !== group.length || new Set(received.map(message => message?.message_id)).size !== received.length || received.some((message, index) => !validProgressiveMessage(group[index] || group[0], message))) {
                const error = new Error('TELEGRAM_UPLOAD_RESULT_INVALID'); error.finalParts = finals; error.details = { expectedMessages: group.length, receivedMessages: received.length };
                throw retainRemote(error, remotes);
            }
            try { await context.onGroupConfirmed?.(remotes, groupIndex); }
            catch (error) { error.finalParts = finals; throw retainRemote(error, remotes); }
            finals.push(...remotes);
            log('telegram.final-group-confirmed', { uploadId: context.uploadId, operationId: context.operationId, fileId: file.logicalId, groupIndex, parts: remotes.map(part => ({ part: part.partIndex, messageId: part.messageId, bytes: part.size })) });
        }
        return finals;
    }
    async function uploadPhysical(backend, files, parts, update = () => {}, context = {}) {
        const queue = parts.map(part => ({ ...part }));
        const total = Number(context.totalBytes) || files.reduce((sum, file) => sum + Number(file.size || 0), 0);
        const confirmedBefore = Number(context.confirmedBytes) || 0;
        const accepted = [];
        const invalidResultParts = [];
        const remoteFromMessage = (part, message) => {
            const media = messageMedia(message) || {};
            return { fileId: media.file_id || '', fileUniqueId: media.file_unique_id || '', messageId: message.message_id, messageDate: message.date ? message.date * 1000 : now(), mediaType: ['document', 'video', 'audio', 'animation', 'voice', 'video_note'].find(type => message[type]), mediaGroupId: message.media_group_id || '', logicalFileId: part.logicalFileId, fileIndex: part.fileIndex, partIndex: part.partIndex, partCount: part.partCount, originalSize: part.originalSize, size: part.size, offset: part.offset, sha256: part.sha256 || '' };
        };
        try { for (let batchIndex = 0; batchIndex < queue.length;) {
            let bytes = 0, count = 0;
            while (batchIndex + count < queue.length && count < 10 && bytes + queue[batchIndex + count].size <= MAX_TELEGRAM_BATCH_SIZE) bytes += queue[batchIndex + count++].size;
            if (!count) count = 1;
            const batch = queue.slice(batchIndex, batchIndex + count).map(part => ({ ...part, caption: diskCaption(files[part.fileIndex], backend, context, part) }));
            const trace = { uploadId: context.uploadId, operationId: context.operationId, signal: context.signal, batch: Number(context.batch || 0) + batchIndex + 1, parts: batch.map(part => ({ fileId: part.logicalFileId, part: part.partIndex, count: part.partCount, bytes: part.size })) };
            if (batch.some(part => part.reuseFileId) && !batch.every(part => part.reuseFileId)) {
                for (const part of batch) accepted.push(...await uploadPhysical(backend, files, [part], update, { ...context, confirmedBytes: confirmedBefore + accepted.reduce((sum, item) => sum + item.size, 0) }));
                batchIndex += batch.length; continue;
            }
            let result, split = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                let produced = 0;
                const reused = batch.every(part => part.reuseFileId);
                const multipart = reused ? null : buildTelegramDocumentsMultipart({ chatId: backend.channelId, files: batch, disableContentTypeDetection: true, onProgress: (sentBytes, _total, name) => {
                    produced = sentBytes;
                    update({ phase: 'telegram-upload', message: `正在上传到 Telegram：${name}`, processedBytes: confirmedBefore + accepted.reduce((sum, item) => sum + item.size, 0) + sentBytes, totalBytes: total, percent: total ? Math.min(99, (confirmedBefore + accepted.reduce((sum, item) => sum + item.size, 0) + sentBytes) / total * 100) : null });
                } });
                multipart?.body.once('end', () => {
                    // Produced bytes are not proof that Telegram accepted the
                    // request; keep the task visibly waiting for confirmation.
                    // Local stream completion is diagnostic only. The socket's
                    // bodySent event is the actual transition to response wait.
                    log('telegram.request-body-produced', { uploadId: context.uploadId, operationId: context.operationId, batch: trace.batch, producedBytes: produced });
                });
                try {
                    if (reused) {
                        result = batch.length === 1
                            ? await call(backend, 'sendDocument', { chat_id: backend.channelId, document: batch[0].reuseFileId, caption: batch[0].caption }, undefined, 0, { ...trace, attempt: attempt + 1, reused: true })
                            : await call(backend, 'sendMediaGroup', { chat_id: backend.channelId, media: batch.map(part => ({ type: 'document', media: part.reuseFileId, caption: part.caption, disable_content_type_detection: true })) }, undefined, 0, { ...trace, attempt: attempt + 1, reused: true });
                    } else result = await call(backend, multipart.method, null, { method: 'POST', headers: { 'Content-Type': multipart.contentType, 'Content-Length': String(multipart.contentLength) }, body: multipart.body, duplex: 'half' }, 0, { ...trace, attempt: attempt + 1, payloadRanges: multipart.payloadRanges,
                        onUploadProgress: ({ bytes, complete, name }) => {
                            const sent = confirmedBefore + accepted.reduce((sum, item) => sum + item.size, 0) + bytes;
                            update({ phase: complete ? 'telegram-response' : 'telegram-upload', telegramBytesSent: sent,
                                message: complete ? `请求体已发送，正在等待 Telegram 确认 ${batch.length} 个分片` : `正在发送到 Telegram：${name || batch[0].name}` });
                        }
                    });
                    break;
                } catch (error) {
                    multipart?.body.destroy();
                    if (batch.length > 1 && (error.message === 'TELEGRAM_413' || rejectedDocumentAlbum(error))) {
                        log('telegram.pipeline-album-fallback', { ...trace, signal: undefined, reason: error.message, telegramDescription: error.telegramDescription });
                        for (const part of batch) accepted.push(...await uploadPhysical(backend, files, [part], update, { ...context, confirmedBytes: confirmedBefore + accepted.reduce((sum, item) => sum + item.size, 0) }));
                        batchIndex += batch.length; split = true; break;
                    }
                    if (reused && batch.length === 1 && batch[0].path && rejectedFileIdentifier(error) && attempt < 2) {
                        const part = batch[0];
                        await context.onReuseRejected?.(part);
                        log('telegram.pipeline-reuse-fallback', { uploadId: context.uploadId, operationId: context.operationId, fileId: part.logicalFileId, part: part.partIndex, telegramDescription: error.telegramDescription });
                        delete part.reuseFileId; delete part.reuseFileUniqueId;
                        continue;
                    }
                    // Explicit Telegram rejection and proven pre-connect failures
                    // are safe to retry; socket/response failures may have accepted it.
                    const retryable = error.message === 'TELEGRAM_429' || (error.message === 'TELEGRAM_NETWORK_ERROR' && error.details?.requestNotAccepted);
                    if (retryable && attempt < 2) {
                        const delay = error.message === 'TELEGRAM_429' ? error.retryAfter * 1000 : 500 * (attempt + 1);
                        log('telegram.pipeline-batch-retry', { uploadId: context.uploadId, operationId: context.operationId, attempt: attempt + 1, delay, producedBytes: produced, error: error.message, details: error.details });
                        await new Promise(resolve => setTimeout(resolve, delay)); continue;
                    }
                    log('telegram.pipeline-batch-failed', { uploadId: context.uploadId, operationId: context.operationId, attempt: attempt + 1, producedBytes: produced, error: error.message, details: error.details });
                    throw error;
                }
            }
            if (split) continue;
            const messages = Array.isArray(result) ? result : [result];
            if (messages.length !== batch.length || messages.some(message => !messageMedia(message)?.file_id || !Number.isSafeInteger(message?.message_id) || message.message_id <= 0)) {
                for (let index = 0; index < messages.length; index++) {
                    const message = messages[index];
                    if (!Number.isSafeInteger(message?.message_id) || message.message_id <= 0) continue;
                    invalidResultParts.push({ ...remoteFromMessage(batch[index] || batch[0], message), ...(batch[index] ? {} : { resultUnmapped: true }) });
                }
                const error = new Error('TELEGRAM_UPLOAD_RESULT_INVALID');
                error.details = { expectedMessages: batch.length, receivedMessages: messages.length };
                throw error;
            }
            for (let index = 0; index < batch.length; index++) {
                const part = batch[index], remote = remoteFromMessage(part, messages[index]);
                if (!part.reuseFileId && !files[part.fileIndex].contentCandidateId && !files[part.fileIndex].contentId) {
                    try { await call(backend, 'editMessageCaption', { chat_id: backend.channelId, message_id: remote.messageId, caption: diskCaption(files[part.fileIndex], backend, context, remote) }, undefined, 0, { ...trace, fileId: remote.logicalFileId }); }
                    catch (_) { remote.captionWarning = 'TELEGRAM_CAPTION_UPDATE_FAILED'; }
                }
                accepted.push(remote);
                log('telegram.pipeline-part-confirmed', { uploadId: context.uploadId, operationId: context.operationId, fileId: remote.logicalFileId, part: remote.partIndex, messageId: remote.messageId, bytes: remote.size });
            }
            batchIndex += batch.length;
        } } catch (error) {
            // Recursive album fallbacks may have accepted messages that never
            // reached the caller's store. Preserve their complete cleanup context
            // until Telegram confirms deletion, without replacing the first error.
            const unresolved = [...accepted, ...invalidResultParts, ...(error.unremovedParts || [])];
            error.unremovedParts = [...new Map(unresolved.filter(part => Number.isSafeInteger(part?.messageId) && part.messageId > 0).map(part => [part.messageId, part])).values()];
            // Cleanup may need more Telegram requests. Publish the fatal cause
            // first so clients stop uploading / waiting while cleanup continues.
            context.onFailure?.(error);
            const messageIds = error.unremovedParts.map(part => part.messageId);
            if (messageIds.length) {
                try {
                    await deleteMessageIds(backend, backend.channelId, messageIds, { uploadId: context.uploadId, operationId: context.operationId, rollback: 'uploadPhysical' });
                    error.unremovedParts = [];
                    log('telegram.pipeline-rollback-complete', { uploadId: context.uploadId, operationId: context.operationId, messages: messageIds.length });
                } catch (cleanupError) {
                    log('telegram.pipeline-rollback-failed', { uploadId: context.uploadId, operationId: context.operationId, messages: messageIds.length, error: cleanupError.message });
                }
            }
            throw error;
        }
        return accepted;
    }
    return {
        call,
        uploadPhysical,
        pushChunk,
        finalizeGroups,
        scheduler: uploadScheduler,
        async uploadThumbnail(backend, file, thumbnail, context = {}) {
            const upload = { path: thumbnail.path, name: `${file.name}.cover.jpg`.slice(0, 180), size: thumbnail.size, type: thumbnail.type || 'image/jpeg', caption: diskThumbnailCaption(file, backend, context) };
            const multipart = buildTelegramDocumentsMultipart({ chatId: backend.channelId, files: [upload], disableContentTypeDetection: true });
            let message;
            try {
                message = await call(backend, multipart.method, null, { method: 'POST', headers: { 'Content-Type': multipart.contentType, 'Content-Length': String(multipart.contentLength) }, body: multipart.body, duplex: 'half' }, 0, { uploadId: context.uploadId, operationId: context.operationId, fileId: file.logicalId, thumbnail: true, signal: context.signal,
                    timeoutMs: context.timeoutMs || 60000, payloadRanges: multipart.payloadRanges, onUploadProgress: context.onProgress });
            } catch (error) { multipart.body.destroy(); throw error; }
            const media = messageMedia(message);
            if (!media?.file_id || !Number.isSafeInteger(message?.message_id)) throw new Error('TELEGRAM_UPLOAD_RESULT_INVALID');
            const remote = { fileId: media.file_id, fileUniqueId: media.file_unique_id || '', messageId: message.message_id, messageDate: message.date ? message.date * 1000 : now(), mediaType: ['document', 'video', 'audio', 'animation'].find(type => message[type]) || 'document', size: thumbnail.size, type: thumbnail.type || 'image/jpeg' };
            log('telegram.thumbnail-confirmed', { uploadId: context.uploadId, operationId: context.operationId, fileId: file.logicalId, messageId: remote.messageId, bytes: remote.size });
            return remote;
        },
        parts: validatedParts,
        prefetchPartLocation: async (backend, part) => { await fileLocation(backend, part); },
        readPart,
        async validate(token, channelId) {
            if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(String(token || '')) || !String(channelId || '').trim()) throw new Error('STORAGE_CREDENTIALS_INVALID');
            const backend = { token, channelId, baseUrl: getBaseUrl() };
            const me = await call(backend, 'getMe', {});
            const chat = await call(backend, 'getChat', { chat_id: channelId });
            if (chat.type !== 'channel') throw new Error('STORAGE_CHANNEL_REQUIRED');
            const member = await call(backend, 'getChatMember', { chat_id: chat.id, user_id: me.id });
            if (member.status !== 'creator' && !(member.status === 'administrator' && member.can_post_messages && member.can_delete_messages)) throw new Error('STORAGE_CHANNEL_PERMISSION');
            return { ...backend, channelId: String(chat.id) };
        },
        async upload(backend, files, update, completed = [], context = {}) {
            const total = files.reduce((sum, file) => sum + file.size, 0);
            let done = completed.reduce((sum, item, index) => sum + (files[index]?.size || 0), 0);
            const plans = files.map((file, logicalIndex) => {
                const partCount = Math.max(1, Math.ceil(file.size / MAX_TELEGRAM_PART_SIZE));
                const width = Math.max(2, String(partCount).length);
                return {
                    file, logicalIndex, partCount,
                    parts: Array.from({ length: partCount }, (_, index) => {
                        const start = index * MAX_TELEGRAM_PART_SIZE;
                        const size = Math.min(MAX_TELEGRAM_PART_SIZE, file.size - start);
                        const chunk = file.chunks?.[index];
                        if (file.chunks && (!chunk || chunk.offset !== start || chunk.size !== size)) throw new Error('TELEGRAM_PARTS_INVALID');
                        const suffix = `.part${String(index + 1).padStart(width, '0')}-of-${String(partCount).padStart(width, '0')}`;
                        const streamStart = chunk ? 0 : start;
                        return { logicalIndex, logicalFileId: file.logicalId, partIndex: index + 1, partCount, originalSize: file.size, offset: start, start: streamStart, end: size ? streamStart + size - 1 : undefined, size, path: chunk?.path || file.path, type: partCount === 1 ? file.type : 'application/octet-stream', name: partCount === 1 ? file.name : (file.name.slice(0, Math.max(1, 180 - suffix.length)) + suffix) };
                    })
                };
            });
            const remotes = plans.map((plan, index) => index < completed.length ? storedParts(completed[index]) : []);
            const physical = plans.slice(completed.length).flatMap(plan => plan.parts);
            const batches = [];
            for (const part of physical) {
                let batch = batches.at(-1);
                if (!batch || batch.length === 10 || batch.reduce((sum, entry) => sum + entry.size, 0) + part.size > MAX_TELEGRAM_BATCH_SIZE) batches.push(batch = []);
                batch.push(part);
            }
            const unindexedMessages = new Set();
            const rateRetries = new Map();
            const connectionRetries = new Map();
            try {
                for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                    const batch = batches[batchIndex].map(part => ({ ...part, caption: diskCaption(files[part.logicalIndex], backend, context, part) }));
                    const label = `第 ${batchIndex + 1}/${batches.length} 批（${batch.length} 个分片）`;
                    update({ phase: 'telegram-upload', percent: total ? done / total * 100 : null, processedBytes: done, totalBytes: total, message: '正在上传到 Telegram：' + label });
                    const trace = { uploadId: context.uploadId, operationId: context.operationId, batch: batchIndex + 1, parts: batch.map(part => ({ fileId: part.logicalFileId, part: part.partIndex, count: part.partCount, bytes: part.size })) };
                    let produced = 0, lastProgressAt = Date.now();
                    const multipart = buildTelegramDocumentsMultipart({ chatId: backend.channelId, files: batch, disableContentTypeDetection: true, onProgress: (bytes, _total, name, index, fileBytes) => {
                        produced = bytes; lastProgressAt = Date.now();
                        if (fileBytes === batch[index].size) log('telegram.part-body-produced', { ...trace, fileId: batch[index].logicalFileId, part: batch[index].partIndex, fileBytes, producedBytes: produced });
                        update({ phase: 'telegram-upload', message: '正在上传到 Telegram：' + name, processedBytes: done + bytes, totalBytes: total, percent: total ? (done + bytes) / total * 100 : null });
                    } });
                    const heartbeat = setInterval(() => log('telegram.progress', { ...trace, producedBytes: produced, confirmedBytes: done, idleMs: Date.now() - lastProgressAt }), 10000);
                    heartbeat.unref?.();
                    let sent;
                    try { sent = await call(backend, multipart.method, null, { method: 'POST', headers: { 'Content-Type': multipart.contentType, 'Content-Length': String(multipart.contentLength) }, body: multipart.body, duplex: 'half', signal: AbortSignal.timeout(30 * 60 * 1000) }, 0, { ...trace, signal: context.signal }); }
                    catch (error) {
                        log('telegram.batch-failed', { ...trace, producedBytes: produced, confirmedBytes: done, error: error.message, details: error.details });
                        multipart.body.destroy();
                        if (error.message === 'TELEGRAM_429' && (rateRetries.get(batchIndex) || 0) < 3) {
                            rateRetries.set(batchIndex, (rateRetries.get(batchIndex) || 0) + 1);
                            update({ phase: 'telegram-wait', percent: null, processedBytes: done, totalBytes: total, message: `Telegram 限流，等待 ${error.retryAfter} 秒后继续` });
                            await new Promise(resolve => setTimeout(resolve, error.retryAfter * 1000));
                            batchIndex--; continue;
                        }
                        if (batch.length > 1 && (error.message === 'TELEGRAM_413' || rejectedDocumentAlbum(error))) {
                            log('telegram.album-fallback', { ...trace, reason: error.message, telegramDescription: error.telegramDescription });
                            const middle = Math.ceil(batch.length / 2);
                            const replacements = error.message === 'TELEGRAM_413' ? [batch.slice(0, middle), batch.slice(middle)] : batch.map(part => [part]);
                            batches.splice(batchIndex, 1, ...replacements);
                            batchIndex--; continue;
                        }
                        if (error.message === 'TELEGRAM_NETWORK_ERROR' && error.details?.requestNotAccepted && (connectionRetries.get(batchIndex) || 0) < 2) {
                            const attempt = (connectionRetries.get(batchIndex) || 0) + 1;
                            connectionRetries.set(batchIndex, attempt);
                            log('telegram.batch-retry', { ...trace, attempt, producedBytes: produced, details: error.details });
                            await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                            batchIndex--; continue;
                        }
                        throw error;
                    }
                    finally { clearInterval(heartbeat); }
                    const messages = Array.isArray(sent) ? sent : [sent];
                    messages.forEach(message => { if (message?.message_id) unindexedMessages.add(message.message_id); });
                    if (messages.length !== batch.length || messages.some(message => !messageMedia(message)?.file_id || !Number.isSafeInteger(message?.message_id) || message.message_id <= 0)) {
                        const error = new Error('TELEGRAM_UPLOAD_RESULT_INVALID');
                        error.details = { expectedMessages: batch.length, receivedMessages: messages.length, mediaTypes: messages.map(message => ['document', 'video', 'audio', 'animation', 'voice', 'video_note'].filter(type => message?.[type])) };
                        throw error;
                    }
                    const accepted = messages.map((message, index) => ({ fileId: messageMedia(message).file_id, fileUniqueId: messageMedia(message).file_unique_id, messageId: message.message_id, messageDate: message.date ? message.date * 1000 : now(), mediaType: ['document', 'video', 'audio', 'animation', 'voice', 'video_note'].find(type => message[type]), mediaGroupId: message.media_group_id || '', logicalFileId: batch[index].logicalFileId, partIndex: batch[index].partIndex, partCount: batch[index].partCount, originalSize: batch[index].originalSize, size: batch[index].size, offset: batch[index].offset }));
                    accepted.forEach((remote, index) => remotes[batch[index].logicalIndex].push(remote));
                    accepted.forEach(remote => log('telegram.part-confirmed', { ...trace, fileId: remote.logicalFileId, part: remote.partIndex, messageId: remote.messageId, albumId: remote.mediaGroupId, bytes: remote.size }));
                    accepted.forEach(remote => unindexedMessages.delete(remote.messageId));
                    const batchBytes = batch.reduce((sum, file) => sum + file.size, 0);
                    for (let index = 0; index < batch.length; index++) {
                        const remote = accepted[index];
                        if(files[batch[index].logicalIndex].contentCandidateId || files[batch[index].logicalIndex].contentId)continue;
                        update({ phase: 'telegram-caption', percent: null, processedBytes: done + batchBytes, totalBytes: total, message: `正在补充文件定位备注：${files[batch[index].logicalIndex].name}（${remote.partIndex}/${remote.partCount}）` });
                        try { await call(backend, 'editMessageCaption', { chat_id: backend.channelId, message_id: remote.messageId, caption: diskCaption(files[batch[index].logicalIndex], backend, context, remote) }, undefined, 0, { ...trace, fileId: remote.logicalFileId }); }
                        catch (_) { remote.captionWarning = 'TELEGRAM_CAPTION_UPDATE_FAILED'; }
                    }
                    done += batchBytes;
                    while (completed.length < plans.length && remotes[completed.length].length === plans[completed.length].partCount) {
                        const parts = remotes[completed.length].slice().sort((left, right) => left.partIndex - right.partIndex);
                        const first = parts[0];
                        completed.push({ ...first, parts, partCount: parts.length, size: plans[completed.length].file.size, originalSize: plans[completed.length].file.size, captionWarning: parts.some(part => part.captionWarning) ? 'TELEGRAM_CAPTION_UPDATE_FAILED' : '' });
                    }
                    update({ phase: 'telegram-response', percent: null, processedBytes: done, totalBytes: total, message: 'Telegram 已确认本批分片，正在更新逻辑文件索引' });
                }
            } catch (error) {
                const incomplete = [...unindexedMessages, ...remotes.slice(completed.length).flatMap(parts => parts.map(part => part.messageId))];
                const trace = { uploadId: context.uploadId, operationId: context.operationId, messageIds: incomplete };
                if (incomplete.length) {
                    log('telegram.cleanup-start', trace);
                    try { await deleteMessageIds(backend, backend.channelId, incomplete, trace); log('telegram.cleanup-complete', trace); }
                    catch (cleanupError) { log('telegram.cleanup-failed', { ...trace, error: cleanupError.message, details: cleanupError.details }); }
                }
                throw error;
            }
            return completed;
        },
        async read(backend, item) {
            const parts = validatedParts(item);
            const first = await readPart(backend, parts[0]);
            async function* combine() {
                for (let index = 0; index < parts.length; index++) {
                    const source = index === 0 ? first : await readPart(backend, parts[index]);
                    let bytes = 0;
                    for await (const chunk of source) {
                        bytes += chunk.length;
                        if (bytes > parts[index].size) throw new Error('TELEGRAM_PART_SIZE_MISMATCH');
                        yield chunk;
                    }
                    if (bytes !== parts[index].size) throw new Error('TELEGRAM_PART_SIZE_MISMATCH');
                }
            }
            return Readable.from(combine());
        },
        async check(backend, item) {
            for (const part of validatedParts(item)) await call(backend, 'getFile', { file_id: part.fileId });
            if (item.thumbnail?.fileId) await call(backend, 'getFile', { file_id: item.thumbnail.fileId });
            return true;
        },
        async cleanupTemporaryMessages(backend, item, context = {}) {
            const channelId = resolveChatIdentifier(item.channelId || backend.channelId);
            if(!anchorGuard({...item,channelId})) throw new Error('CONTENT_ANCHOR_IN_USE');
            const scheduledBackend = { ...backend, channelId };
            const parts = [...new Map(storedParts(item).filter(part => part?.messageId).map(part => [Number(part.messageId), part])).values()];
            if (!parts.length || parts.some(part => !Number.isSafeInteger(part.messageId) || part.messageId <= 0)) throw new Error('TELEGRAM_MESSAGE_MISSING');
            const protectedIds = new Set((context.finalMessageIds || []).map(Number));
            if (parts.some(part => protectedIds.has(part.messageId))) throw new Error('TELEGRAM_TEMP_CLEANUP_INVALID');
            const fresh = parts.filter(part => now() - Number(part.messageDate || item.createdAt || now()) < DELETE_WINDOW_MS);
            const old = parts.filter(part => !fresh.includes(part));
            const taskKey = context.taskKey || 'cleanup-' + (context.uploadId || context.operationId || item.operationId || item.messageId);
            for (let offset = 0; offset < fresh.length; offset += 100) {
                const batch = fresh.slice(offset, offset + 100), ids = batch.map(part => part.messageId);
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        await uploadScheduler.enqueue(scheduledBackend, () => deleteMessageIds(backend, channelId, ids,
                            { uploadId: context.uploadId, operationId: context.operationId || item.operationId, cleanup: true, batch: Math.floor(offset / 100) + 1,
                                attempt, managedRetry: true, signal: context.signal }), { signal: context.signal, taskKey, priority: 10 });
                        await context.onCleanupBatchConfirmed?.(ids);
                        break;
                    } catch (error) {
                        // Deletion is idempotent, unlike message creation. Even
                        // an ambiguous lost delete response may safely retry;
                        // missing messages are handled by deleteMessageIds.
                        if (!context.signal?.aborted && (error.message === 'TELEGRAM_429' || error.message === 'TELEGRAM_NETWORK_ERROR') && attempt < 3) {
                            const delayMs = uploadScheduler.feedback(scheduledBackend, error, attempt);
                            await context.onCleanupRetry?.({ attempt, delayMs, retryAt: now() + delayMs, messageIds: ids });
                            continue;
                        }
                        throw error;
                    }
                }
            }
            if (old.length) {
                // Expired temporary messages retain the existing 47h57m
                // placeholder replacement behavior. Do not change user delete.
                await uploadScheduler.enqueue(scheduledBackend, () => this.remove(backend, { ...item, channelId, parts: old, thumbnail: null }),
                    { signal: context.signal, taskKey, priority: 10 });
                await context.onCleanupBatchConfirmed?.(old.map(part => part.messageId));
            }
        },
        async remove(backend, item) {
            if(!anchorGuard(item)) throw new Error('CONTENT_ANCHOR_IN_USE');
            let failure;
            const stored = [...storedParts(item), ...(item.thumbnail?.messageId ? [item.thumbnail] : [])];
            for (const part of stored) {
                try {
                    if (!Number.isSafeInteger(part.messageId) || part.messageId <= 0) throw new Error('TELEGRAM_MESSAGE_MISSING');
                    if (now() - Number(part.messageDate || item.createdAt || now()) >= DELETE_WINDOW_MS) await replaceDeleted(backend, item, part);
                    else {
                        try { await call(backend, 'deleteMessage', { chat_id: item.channelId, message_id: part.messageId }); }
                        catch (error) {
                            if (missingMessage(error)) continue;
                            if (/message (?:can'?t|cannot) be deleted/i.test(error.telegramDescription || '')) await replaceDeleted(backend, item, part);
                            else throw error;
                        }
                    }
                } catch (error) { failure ||= error; }
            }
            if (failure) throw failure;
        },
        async syncCaption(backend, item, context = {}, update = () => {}) {
            if(item.contentId) return;
            let failure;
            for (const part of storedParts(item)) {
                update({ phase: 'telegram-caption', percent: null, message: `正在同步 Telegram 备注：${item.name}（${part.partIndex}/${part.partCount}）` });
                try { await call(backend, 'editMessageCaption', { chat_id: item.channelId, message_id: part.messageId, caption: diskCaption({ ...item, logicalId: item.id }, { ...backend, channelId: item.channelId }, context, { ...part, logicalFileId: item.id, originalSize: item.size }) }); }
                catch (error) { if (!notModified(error)) failure ||= error; }
            }
            if (failure) throw failure;
        },
        setAnchorGuard(guard) { anchorGuard=guard; }
    };
}
module.exports = { createDiskTelegram, diskCaption, partitionMediaGroups, MAX_TELEGRAM_PART_SIZE };
