'use strict';
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { buildTelegramDocumentsMultipart } = require('./telegram-multipart');
const MAX_TELEGRAM_PART_SIZE = 20 * 1024 * 1024;
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
function createDiskTelegram({ fetchImpl = fetch, getBaseUrl = () => 'https://api.telegram.org' }) {
    async function call(backend, method, payload, init) {
        if (!backend?.token) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
        let response;
        try {
            response = await fetchImpl(backend.baseUrl + '/bot' + backend.token + '/' + method, init || { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) });
        } catch (_) { throw new Error('TELEGRAM_NETWORK_ERROR'); }
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.ok) {
            const error = new Error('TELEGRAM_' + (data?.error_code || response.status || 'ERROR'));
            // Never pass URLs or bot credentials to an operation or client.
            error.telegramDescription = String(data?.description || '').replace(/bot\d+:[\w-]+/g, '[redacted]').slice(0, 200);
            throw error;
        }
        return data.result;
    }
    const missingMessage = error => /message (?:to delete )?not found|message identifier is not specified/i.test(error.telegramDescription || '');
    async function deleteMessageIds(backend, channelId, values) {
        const ids = [...new Set(values.map(Number).filter(Number.isSafeInteger))];
        if (!ids.length) throw new Error('TELEGRAM_MESSAGE_MISSING');
        for (let offset = 0; offset < ids.length; offset += 100) {
            const batch = ids.slice(offset, offset + 100);
            try { await call(backend, 'deleteMessages', { chat_id: channelId, message_ids: batch }); }
            catch (error) {
                const fallback = /method not found|METHOD_INVALID/i.test(error.telegramDescription || '') || missingMessage(error) || /message (?:can'?t|cannot) be deleted/i.test(error.telegramDescription || '');
                if (!fallback) throw error;
                for (const messageId of batch) {
                    try { await call(backend, 'deleteMessage', { chat_id: channelId, message_id: messageId }); }
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
        : [{ fileId: item.fileId, fileUniqueId: item.fileUniqueId, messageId: item.messageId, mediaGroupId: item.mediaGroupId || '', partIndex: 1, partCount: 1, size: item.size, offset: 0 }];
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
                        const suffix = `.part${String(index + 1).padStart(width, '0')}-of-${String(partCount).padStart(width, '0')}`;
                        return { logicalIndex, logicalFileId: file.logicalId, partIndex: index + 1, partCount, originalSize: file.size, offset: start, start, end: size ? start + size - 1 : undefined, size, path: file.path, type: partCount === 1 ? file.type : 'application/octet-stream', name: partCount === 1 ? file.name : (file.name.slice(0, Math.max(1, 180 - suffix.length)) + suffix) };
                    })
                };
            });
            const remotes = plans.map((plan, index) => index < completed.length ? storedParts(completed[index]) : []);
            const physical = plans.slice(completed.length).flatMap(plan => plan.parts);
            try {
                for (let offset = 0; offset < physical.length; offset += 10) {
                    const batch = physical.slice(offset, offset + 10).map(part => ({ ...part, caption: diskCaption(files[part.logicalIndex], backend, context, part) }));
                    const label = batch.length === 1 ? `分片 ${batch[0].partIndex}/${batch[0].partCount}` : `第 ${offset + 1}—${Math.min(offset + 10, physical.length)} 个分片`;
                    update({ phase: 'telegram-upload', percent: total ? done / total * 100 : null, processedBytes: done, totalBytes: total, message: '正在上传到 Telegram：' + label });
                    const multipart = buildTelegramDocumentsMultipart({ chatId: backend.channelId, files: batch, onProgress: (bytes, _total, name) => update({ phase: 'telegram-upload', message: '正在上传到 Telegram：' + name, processedBytes: done + bytes, totalBytes: total, percent: total ? (done + bytes) / total * 100 : null }) });
                    const sent = await call(backend, multipart.method, null, { method: 'POST', headers: { 'Content-Type': multipart.contentType, 'Content-Length': String(multipart.contentLength) }, body: multipart.body, duplex: 'half', signal: AbortSignal.timeout(30 * 60 * 1000) });
                    const messages = Array.isArray(sent) ? sent : [sent];
                    if (messages.length !== batch.length || messages.some(message => !message?.document?.file_id)) throw new Error('TELEGRAM_UPLOAD_RESULT_INVALID');
                    const accepted = messages.map((message, index) => ({ fileId: message.document.file_id, fileUniqueId: message.document.file_unique_id, messageId: message.message_id, mediaGroupId: message.media_group_id || '', logicalFileId: batch[index].logicalFileId, partIndex: batch[index].partIndex, partCount: batch[index].partCount, originalSize: batch[index].originalSize, size: batch[index].size, offset: batch[index].offset }));
                    accepted.forEach((remote, index) => remotes[batch[index].logicalIndex].push(remote));
                    const batchBytes = batch.reduce((sum, file) => sum + file.size, 0);
                    for (let index = 0; index < batch.length; index++) {
                        const remote = accepted[index];
                        update({ phase: 'telegram-caption', percent: null, processedBytes: done + batchBytes, totalBytes: total, message: `正在补充文件定位备注：${files[batch[index].logicalIndex].name}（${remote.partIndex}/${remote.partCount}）` });
                        try { await call(backend, 'editMessageCaption', { chat_id: backend.channelId, message_id: remote.messageId, caption: diskCaption(files[batch[index].logicalIndex], backend, context, remote) }); }
                        catch (_) { remote.captionWarning = 'TELEGRAM_CAPTION_UPDATE_FAILED'; }
                    }
                    done += batchBytes;
                    while (completed.length < plans.length && remotes[completed.length].length === plans[completed.length].partCount) {
                        const parts = remotes[completed.length].slice().sort((left, right) => left.partIndex - right.partIndex);
                        const first = parts[0];
                        completed.push({ ...first, parts, partCount: parts.length, originalSize: plans[completed.length].file.size, captionWarning: parts.some(part => part.captionWarning) ? 'TELEGRAM_CAPTION_UPDATE_FAILED' : '' });
                    }
                    update({ phase: 'telegram-response', percent: null, processedBytes: done, totalBytes: total, message: 'Telegram 已确认本批分片，正在更新逻辑文件索引' });
                }
            } catch (error) {
                const incomplete = remotes.slice(completed.length).flatMap(parts => parts.map(part => part.messageId));
                if (incomplete.length) await deleteMessageIds(backend, backend.channelId, incomplete).catch(() => {});
                throw error;
            }
            return completed;
        },
        async read(backend, item) {
            const parts = storedParts(item);
            const first = await readPart(backend, parts[0]);
            async function* combine() {
                for await (const chunk of first) yield chunk;
                for (let index = 1; index < parts.length; index++) {
                    const source = await readPart(backend, parts[index]);
                    for await (const chunk of source) yield chunk;
                }
            }
            return Readable.from(combine());
        },
        async check(backend, item) {
            for (const part of storedParts(item)) await call(backend, 'getFile', { file_id: part.fileId });
            return true;
        },
        async remove(backend, item) {
            await deleteMessageIds(backend, item.channelId, storedParts(item).map(part => part.messageId));
        }
    };
}
module.exports = { createDiskTelegram, diskCaption, MAX_TELEGRAM_PART_SIZE };
