'use strict';
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { buildTelegramDocumentsMultipart } = require('./telegram-multipart');
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
        async upload(backend, files, update, completed = []) {
            const total = files.reduce((sum, file) => sum + file.size, 0);
            let done = completed.reduce((sum, item, index) => sum + (files[index]?.size || 0), 0);
            for (let offset = completed.length; offset < files.length; offset += 10) {
                update({ phase: 'telegram-upload', percent: total ? done / total * 100 : null, processedBytes: done, totalBytes: total, message: '正在上传到 Telegram：第 ' + (offset + 1) + '—' + Math.min(offset + 10, files.length) + ' 个文件' });
                const batch = files.slice(offset, offset + 10);
                const multipart = buildTelegramDocumentsMultipart({ chatId: backend.channelId, files: batch, onProgress: (bytes, _total, name) => update({ phase: 'telegram-upload', message: '正在上传到 Telegram：' + name, processedBytes: done + bytes, totalBytes: total, percent: total ? (done + bytes) / total * 100 : null }) });
                const sent = await call(backend, multipart.method, null, { method: 'POST', headers: { 'Content-Type': multipart.contentType, 'Content-Length': String(multipart.contentLength) }, body: multipart.body, duplex: 'half', signal: AbortSignal.timeout(30 * 60 * 1000) });
                const messages = Array.isArray(sent) ? sent : [sent];
                if (messages.length !== batch.length || messages.some(message => !message?.document?.file_id)) throw new Error('TELEGRAM_UPLOAD_RESULT_INVALID');
                completed.push(...messages.map(message => ({ fileId: message.document.file_id, fileUniqueId: message.document.file_unique_id, messageId: message.message_id, mediaGroupId: message.media_group_id || '' })));
                done += batch.reduce((sum, file) => sum + file.size, 0);
                update({ phase: 'telegram-response', percent: null, message: 'Telegram 已确认本批文件，正在更新索引' });
            }
            return completed;
        },
        async read(backend, item) {
            const file = await call(backend, 'getFile', { file_id: item.fileId });
            if (!file?.file_path) throw new Error('TELEGRAM_FILE_PATH_MISSING');
            if (backend.baseUrl !== 'https://api.telegram.org' && path.isAbsolute(file.file_path)) return fs.createReadStream(file.file_path);
            let response;
            try { response = await fetchImpl(backend.baseUrl + '/file/bot' + backend.token + '/' + file.file_path, { signal: AbortSignal.timeout(30 * 60 * 1000) }); }
            catch (_) { throw new Error('TELEGRAM_DOWNLOAD_NETWORK'); }
            if (!response.ok || !response.body) throw new Error('TELEGRAM_DOWNLOAD_FAILED');
            return Readable.fromWeb(response.body);
        },
        async remove(backend, item) {
            if (!item.messageId) throw new Error('TELEGRAM_MESSAGE_MISSING');
            try { await call(backend, 'deleteMessage', { chat_id: item.channelId, message_id: item.messageId }); }
            catch (error) { if (!/message to delete not found/i.test(error.telegramDescription || '')) throw error; }
        }
    };
}
module.exports = { createDiskTelegram };
