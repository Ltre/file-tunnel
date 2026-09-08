'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { buildTelegramDocumentsMultipart } = require('./telegram-multipart');
const { readJson, writeJson } = require('./disk-data');
const { MAX_TELEGRAM_PART_SIZE, MAX_TELEGRAM_BATCH_SIZE } = require('./disk-limits');
const { createDiskUploadLog, networkDetails } = require('./disk-upload-log');
const DELETE_WINDOW_MS = (47 * 60 + 57) * 60 * 1000;
const messageMedia = message => message?.document || message?.video || message?.audio || message?.animation || message?.voice || message?.video_note;
function diskCaption(file, backend, context = {}, remote = {}) {
    const fields = ['网盘文件', 'user_id: ' + (context.userId || ''), 'disk_space: ' + (context.diskSpace || ''), 'name: ' + file.name, 'channel_id: ' + backend.channelId];
    if (file.logicalId || remote.logicalFileId) fields.push('logical_file_id: ' + (file.logicalId || remote.logicalFileId));
    if (remote.partCount) fields.push('part: ' + remote.partIndex + '/' + remote.partCount, 'original_size: ' + (remote.originalSize || file.size || 0));
    if (remote.fileId) fields.push('file_id: ' + remote.fileId, 'message_id: ' + remote.messageId, 'album_id: ' + (remote.mediaGroupId || ''));
    const heading = fields.join('\n');
    const folder = '/' + (file.folderPath || '');
    const room = Math.max(0, 1024 - heading.length - 8);
    const shortened = folder.length > room ? Array.from(folder.slice(0, Math.max(0, room - 1))).join('') + '…' : folder;
    return heading + '\npath: ' + shortened;
}
function createDiskTelegram({ fetchImpl = fetch, getBaseUrl = () => 'https://api.telegram.org', dataDir = path.join(__dirname, '..', '.tunnel-data'), now = Date.now }) {
    const placeholderPath = path.join(dataDir, 'tg-1byte-file.id');
    const placeholdersInFlight = new Map();
    const log = createDiskUploadLog(dataDir);
    async function call(backend, method, payload, init, retry = 0, trace = {}) {
        if (!backend?.token) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
        let response, data;
        const started = Date.now(), requestId = crypto.randomUUID();
        const fields = { ...trace, requestId, method, retry, channelId: backend.channelId, messageId: payload?.message_id, requestBytes: Number(init?.headers?.['Content-Length']) || undefined };
        log('telegram.request', fields);
        try {
            response = await fetchImpl(backend.baseUrl + '/bot' + backend.token + '/' + method, init || { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) });
            log('telegram.headers', { ...fields, status: response.status, elapsedMs: Date.now() - started });
            try { data = await response.json(); }
            catch (error) { if (error instanceof SyntaxError) { data = null; log('telegram.invalid-json', fields); } else throw error; }
        } catch (cause) {
            const error = new Error('TELEGRAM_NETWORK_ERROR');
            error.details = { ...networkDetails(cause), stage: response ? 'response-body' : 'request', requestId, method, elapsedMs: Date.now() - started };
            log('telegram.network-error', { ...fields, ...error.details });
            throw error;
        }
        log('telegram.response', { ...fields, status: response.status, ok: Boolean(data?.ok), errorCode: data?.error_code, description: networkDetails({ message: data?.description }).message, elapsedMs: Date.now() - started });
        if (response.ok && !data) {
            const error = new Error('TELEGRAM_UPLOAD_RESULT_INVALID'); error.details = { requestId, method, reason: 'invalid-json' }; throw error;
        }
        if (!response.ok || !data?.ok) {
            const error = new Error('TELEGRAM_' + (data?.error_code || response.status || 'ERROR'));
            // Never pass URLs or bot credentials to an operation or client.
            error.telegramDescription = String(data?.description || '').replace(/bot\d+:[\w-]+/g, '[redacted]').slice(0, 200);
            error.retryAfter = Math.min(60, Math.max(1, Number(data?.parameters?.retry_after) || 1));
            if (!init && error.message === 'TELEGRAM_429' && retry < 3) {
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
    async function placeholder(backend, channelId, renew = false) {
        // file_id is bot-specific; never share it between unrelated configured bots.
        const key = crypto.createHash('sha256').update(backend.baseUrl + '\0' + backend.token).digest('hex');
        if (placeholdersInFlight.has(key)) return placeholdersInFlight.get(key);
        const pending = (async () => {
            const saved = readJson(placeholderPath, {});
            if (saved[key]?.file_id && !renew) return saved[key].file_id;
            fs.mkdirSync(dataDir, { recursive: true });
            const filePath = path.join(dataDir, 'tg-1byte-placeholder.bin');
            fs.writeFileSync(filePath, Buffer.from([0]));
            const multipart = buildTelegramDocumentsMultipart({ chatId: channelId, files: [{ path: filePath, name: 'deleted.bin', size: 1 }], disableContentTypeDetection: true });
            const result = await call(backend, multipart.method, null, { method: 'POST', headers: { 'Content-Type': multipart.contentType, 'Content-Length': String(multipart.contentLength) }, body: multipart.body, duplex: 'half', signal: AbortSignal.timeout(45000) });
            if (!result?.document?.file_id) throw new Error('TELEGRAM_UPLOAD_RESULT_INVALID');
            const latest = readJson(placeholderPath, {});
            latest[key] = { file_id: result.document.file_id };
            writeJson(placeholderPath, latest);
            await call(backend, 'deleteMessage', { chat_id: channelId, message_id: result.message_id }).catch(() => {});
            return result.document.file_id;
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
    async function readPart(backend, part) {
        const file = await call(backend, 'getFile', { file_id: part.fileId });
        if (!file?.file_path) throw new Error('TELEGRAM_FILE_PATH_MISSING');
        if (backend.baseUrl !== 'https://api.telegram.org' && path.isAbsolute(file.file_path)) return fs.createReadStream(file.file_path);
        let response;
        try { response = await fetchImpl(backend.baseUrl + '/file/bot' + backend.token + '/' + file.file_path, { signal: AbortSignal.timeout(30 * 60 * 1000) }); }
        catch (_) { throw new Error('TELEGRAM_DOWNLOAD_NETWORK'); }
        if (!response.ok || !response.body) throw new Error('TELEGRAM_DOWNLOAD_FAILED');
        return Readable.fromWeb(response.body);
    }
    return {
        call,
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
                    try { sent = await call(backend, multipart.method, null, { method: 'POST', headers: { 'Content-Type': multipart.contentType, 'Content-Length': String(multipart.contentLength) }, body: multipart.body, duplex: 'half', signal: AbortSignal.timeout(30 * 60 * 1000) }, 0, trace); }
                    catch (error) {
                        log('telegram.batch-failed', { ...trace, producedBytes: produced, confirmedBytes: done, error: error.message, details: error.details });
                        multipart.body.destroy();
                        if (error.message === 'TELEGRAM_429' && (rateRetries.get(batchIndex) || 0) < 3) {
                            rateRetries.set(batchIndex, (rateRetries.get(batchIndex) || 0) + 1);
                            update({ phase: 'telegram-wait', percent: null, processedBytes: done, totalBytes: total, message: `Telegram 限流，等待 ${error.retryAfter} 秒后继续` });
                            await new Promise(resolve => setTimeout(resolve, error.retryAfter * 1000));
                            batchIndex--; continue;
                        }
                        if (error.message === 'TELEGRAM_413' && batch.length > 1) {
                            const middle = Math.ceil(batch.length / 2);
                            batches.splice(batchIndex, 1, batch.slice(0, middle), batch.slice(middle));
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
            return true;
        },
        async remove(backend, item) {
            let failure;
            for (const part of storedParts(item)) {
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
            let failure;
            for (const part of storedParts(item)) {
                update({ phase: 'telegram-caption', percent: null, message: `正在同步 Telegram 备注：${item.name}（${part.partIndex}/${part.partCount}）` });
                try { await call(backend, 'editMessageCaption', { chat_id: item.channelId, message_id: part.messageId, caption: diskCaption({ ...item, logicalId: item.id }, { ...backend, channelId: item.channelId }, context, { ...part, logicalFileId: item.id, originalSize: item.size }) }); }
                catch (error) { if (!notModified(error)) failure ||= error; }
            }
            if (failure) throw failure;
        }
    };
}
module.exports = { createDiskTelegram, diskCaption, MAX_TELEGRAM_PART_SIZE };
