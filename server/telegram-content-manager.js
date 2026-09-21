'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { buildTelegramDocumentsMultipart, buildTelegramSingleFileMultipart } = require('./telegram-multipart');

const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;
const ARCHIVE_CACHE_TTL = 3 * 24 * 60 * 60 * 1000;
const ARCHIVE_READ_CONCURRENCY = 6;

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive:true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    try { fs.renameSync(temporary, filePath); }
    catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        fs.copyFileSync(temporary, filePath);
        fs.rmSync(temporary, { force:true });
    }
}

function mediaFromMessage(message = {}) {
    if (Array.isArray(message.photo) && message.photo.length) {
        const value = message.photo[message.photo.length - 1];
        return { kind:'photo', fileId:value.file_id, fileUniqueId:value.file_unique_id, size:Number(value.file_size) || 0, mimeType:'image/jpeg' };
    }
    for (const kind of ['video', 'animation', 'audio', 'voice', 'video_note', 'document', 'sticker']) {
        const value = message[kind];
        if (!value?.file_id) continue;
        return {
            kind, fileId:value.file_id, fileUniqueId:value.file_unique_id,
            size:Number(value.file_size) || 0, mimeType:value.mime_type || '',
            fileName:value.file_name || '', width:Number(value.width) || 0,
            height:Number(value.height) || 0, duration:Number(value.duration) || 0
        };
    }
    return null;
}

function chatRecord(chat = {}) {
    const type = chat.type === 'private' ? 'private' : chat.type === 'channel' ? 'channel' : 'group';
    return {
        id:String(chat.id || ''), type,
        title:String(chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || chat.id || '未知 Chat'),
        username:String(chat.username || ''), updatedAt:Date.now()
    };
}

function createTelegramContentManager(options = {}) {
    const dataDir = options.dataDir;
    const indexPath = path.join(dataDir, 'telegram-content-index.json');
    const tempDir = path.join(dataDir, 'telegram-content-tmp');
    const cacheDir = path.join(dataDir, 'telegram-content-cache');
    const getBackend = options.getBackend;
    const telegram = options.telegram;
    const createVideoThumbnail = options.createVideoThumbnail;
    const archiveReads = new Map();
    let writeQueue = Promise.resolve();

    const archiveCacheKey = pointer => crypto.createHash('sha256')
        .update(String(pointer?.fileUniqueId || pointer?.fileId || pointer?.archiveId || ''))
        .digest('hex');
    const archiveCachePath = pointer => path.join(cacheDir, `${archiveCacheKey(pointer)}.json`);

    function readArchiveCache(pointer) {
        try {
            const filePath = archiveCachePath(pointer);
            const stat = fs.statSync(filePath);
            if (!stat.isFile() || Date.now() - stat.mtimeMs >= ARCHIVE_CACHE_TTL) return null;
            const cached = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return cached?.document?.message ? cached.document : null;
        } catch (_) { return null; }
    }

    function writeArchiveCache(pointer, document) {
        fs.mkdirSync(cacheDir, { recursive:true });
        atomicWrite(archiveCachePath(pointer), { version:1, cachedAt:Date.now(), document });
    }

    fs.promises.mkdir(cacheDir, { recursive:true }).then(async () => {
        const entries = await fs.promises.readdir(cacheDir, { withFileTypes:true });
        await Promise.allSettled(entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(async entry => {
            const filePath = path.join(cacheDir, entry.name);
            const stat = await fs.promises.stat(filePath);
            if (Date.now() - stat.mtimeMs >= ARCHIVE_CACHE_TTL) await fs.promises.rm(filePath, { force:true });
        }));
    }).catch(() => {});

    function load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
            return { version:1, chats:parsed.chats || {}, messages:Array.isArray(parsed.messages) ? parsed.messages : [] };
        } catch (_) { return { version:1, chats:{}, messages:[] }; }
    }

    function mutate(callback) {
        writeQueue = writeQueue.then(() => {
            const index = load();
            callback(index);
            if (index.messages.length > 100000) index.messages.splice(0, index.messages.length - 100000);
            atomicWrite(indexPath, index);
        });
        return writeQueue;
    }

    function backendFor(channelId = '') {
        const backend = getBackend(channelId);
        if (!backend?.token || !backend?.channelId) throw new Error('Telegram 网盘托管频道尚未配置');
        return backend;
    }

    function isStorageChat(chatOrId) {
        const chat = chatOrId && typeof chatOrId === 'object' ? chatOrId : { id:chatOrId };
        const key = String(chat.id || '');
        const username = String(chat.username || '').replace(/^@/, '').toLowerCase();
        return options.getStorageChannelIds().some(value => {
            const configured = String(value || '');
            return configured === key || (username && configured.replace(/^@/, '').toLowerCase() === username);
        });
    }

    async function uploadArchive(message, direction) {
        const backend = backendFor();
        fs.mkdirSync(tempDir, { recursive:true });
        const archiveId = crypto.randomUUID();
        const filePath = path.join(tempDir, `${archiveId}.json`);
        const document = { schema:1, direction, archivedAt:Date.now(), message };
        fs.writeFileSync(filePath, JSON.stringify(document));
        const stat = fs.statSync(filePath);
        try {
            const multipart = buildTelegramDocumentsMultipart({
                chatId:backend.channelId,
                caption:`Bot 内容归档\nsource_chat_id: ${message.chat?.id || ''}\nsource_message_id: ${message.message_id || ''}`,
                files:[{ path:filePath, name:`telegram-message-${archiveId}.json`, type:'application/json', size:stat.size }],
                disableContentTypeDetection:true
            });
            const result = await telegram.call(backend, multipart.method, null, {
                method:'POST', headers:{ 'Content-Type':multipart.contentType, 'Content-Length':String(multipart.contentLength) },
                body:multipart.body, duplex:'half'
            }, 0, { operationId:`telegram-content-${archiveId}` });
            if (!result?.document?.file_id) throw new Error('Telegram 消息归档失败');
            return {
                archiveId, channelId:String(backend.channelId), fileId:result.document.file_id,
                fileUniqueId:result.document.file_unique_id || '', size:stat.size,
                storageMessageId:Number(result.message_id) || 0
            };
        } finally { fs.rmSync(filePath, { force:true }); }
    }

    async function archive(message, direction = 'incoming') {
        if (!message?.chat?.id || isStorageChat(message.chat)) return null;
        const archivePointer = await uploadArchive(message, direction);
        writeArchiveCache(archivePointer, { schema:1, direction, archivedAt:Date.now(), message });
        const chat = chatRecord(message.chat);
        const media = mediaFromMessage(message);
        const record = {
            id:archivePointer.archiveId, chatId:chat.id, direction,
            telegramMessageId:Number(message.message_id) || 0,
            date:Number(message.date) || Math.floor(Date.now() / 1000),
            kind:media?.kind || (message.text ? 'text' : message.location ? 'location' : message.contact ? 'contact' : 'other'),
            media:media || null, archive:archivePointer
        };
        await mutate(index => {
            index.chats[chat.id] = { ...(index.chats[chat.id] || {}), ...chat, lastMessageAt:record.date };
            const duplicate = index.messages.findIndex(item => item.chatId === record.chatId && item.telegramMessageId === record.telegramMessageId && item.direction === direction);
            if (duplicate >= 0) index.messages[duplicate] = record;
            else index.messages.push(record);
        });
        return record;
    }

    async function readArchive(pointer) {
        const cached = readArchiveCache(pointer);
        if (cached) return cached;
        const key = archiveCacheKey(pointer);
        if (archiveReads.has(key)) return archiveReads.get(key);
        const reading = (async () => {
            const backend = backendFor(pointer.channelId);
            const stream = await telegram.readPart(backend, { fileId:pointer.fileId, size:pointer.size }, { start:0, end:pointer.size - 1 });
            const chunks = []; let bytes = 0;
            for await (const chunk of stream) {
                bytes += chunk.length;
                if (bytes > MAX_ARCHIVE_BYTES) throw new Error('Telegram 消息归档异常过大');
                chunks.push(chunk);
            }
            const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            writeArchiveCache(pointer, document);
            return document;
        })().finally(() => archiveReads.delete(key));
        archiveReads.set(key, reading);
        return reading;
    }

    const compareRecords = (a, b) => Number(a.date) - Number(b.date)
        || Number(a.telegramMessageId) - Number(b.telegramMessageId)
        || String(a.id).localeCompare(String(b.id));

    async function hydrateRecords(records) {
        const hydrated = new Array(records.length);
        let cursor = 0;
        const worker = async () => {
            while (cursor < records.length) {
                const index = cursor++;
                const record = records[index];
                try {
                    const archived = await readArchive(record.archive);
                    hydrated[index] = { ...record, message:archived.message };
                } catch (error) {
                    hydrated[index] = { ...record, unavailable:true, error:error.message };
                }
            }
        };
        await Promise.all(Array.from({ length:Math.min(ARCHIVE_READ_CONCURRENCY, records.length) }, worker));
        return hydrated;
    }

    async function listMessagePage(chatId, { anchor = '', direction = 'latest', limit = 40 } = {}) {
        const index = load();
        const records = index.messages.filter(item => item.chatId === String(chatId)).sort(compareRecords);
        const pageSize = Math.min(80, Math.max(1, Number(limit) || 40));
        const anchorIndex = anchor ? records.findIndex(item => item.id === anchor) : -1;
        let start = 0, end = records.length;
        if (direction === 'before' && anchorIndex >= 0) {
            end = anchorIndex; start = Math.max(0, end - pageSize);
        } else if (direction === 'after' && anchorIndex >= 0) {
            start = anchorIndex + 1; end = Math.min(records.length, start + pageSize);
        } else if (direction === 'around' && anchorIndex >= 0) {
            start = Math.max(0, anchorIndex - Math.floor(pageSize / 2));
            end = Math.min(records.length, start + pageSize);
            start = Math.max(0, end - pageSize);
        } else {
            start = Math.max(0, records.length - pageSize); end = records.length;
        }
        const selected = records.slice(start, end);
        return {
            messages:await hydrateRecords(selected),
            paging:{
                firstAnchor:selected[0]?.id || '', lastAnchor:selected.at(-1)?.id || '',
                hasBefore:start > 0, hasAfter:end < records.length,
                requestedAnchor:anchorIndex >= 0 ? anchor : ''
            }
        };
    }

    async function listMessages(chatId, before = Infinity, limit = 60) {
        const records = load().messages.filter(item => item.chatId === String(chatId) && item.date < before)
            .sort(compareRecords).slice(-Math.min(100, Math.max(1, limit)));
        return hydrateRecords(records);
    }

    async function sendText(chatId, text) {
        const backend = backendFor();
        const result = await telegram.call(backend, 'sendMessage', { chat_id:chatId, text:String(text || '').slice(0, 4096) });
        await archive(result, 'outgoing');
        return result;
    }

    async function sendAttachment(chatId, file, mode = 'raw', caption = '') {
        const backend = backendFor();
        const mimeType = String(file.type || 'application/octet-stream');
        const isVideo = mimeType.startsWith('video/');
        const isPhoto = mimeType.startsWith('image/');
        let thumbnail = null;
        let multipart;
        try {
            if (isVideo) {
                thumbnail = await createVideoThumbnail(file).catch(() => null);
                multipart = buildTelegramSingleFileMultipart({
                    method:'sendVideo', fieldName:'video', chatId, caption,
                    fields:{ supports_streaming:'true', ...(thumbnail ? { thumbnail:'attach://thumbnail' } : {}) },
                    attachments:thumbnail ? [{ ...thumbnail, fieldName:'thumbnail' }] : [], file
                });
            } else if (mode === 'preview' && isPhoto) {
                multipart = buildTelegramSingleFileMultipart({ method:'sendPhoto', fieldName:'photo', chatId, caption, file });
            } else {
                multipart = buildTelegramDocumentsMultipart({ chatId, caption, files:[file], disableContentTypeDetection:true });
            }
            const result = await telegram.call(backend, multipart.method, null, {
                method:'POST', headers:{ 'Content-Type':multipart.contentType, 'Content-Length':String(multipart.contentLength) },
                body:multipart.body, duplex:'half'
            });
            await archive(result, 'outgoing');
            return result;
        } finally { thumbnail?.cleanup?.(); }
    }

    function registerRoutes(app, requireAuth) {
        app.get('/api/telegram-content/chats', requireAuth, (req, res) => {
            const chats = Object.values(load().chats).sort((a, b) => Number(b.lastMessageAt) - Number(a.lastMessageAt));
            res.setHeader('Cache-Control', 'no-store');
            res.json({ chats });
        });
        app.get('/api/telegram-content/chats/:chatId/messages', requireAuth, async (req, res) => {
            try {
                res.setHeader('Cache-Control', 'no-store');
                res.json(await listMessagePage(req.params.chatId, {
                    anchor:String(req.query.anchor || ''), direction:String(req.query.direction || 'latest'), limit:Number(req.query.limit) || 40
                }));
            }
            catch (error) { res.status(502).json({ error:error.message }); }
        });
        app.post('/api/telegram-content/chats/:chatId/messages', requireAuth, async (req, res) => {
            try {
                const text = String(req.body?.text || '').trim();
                if (!text) return res.status(422).json({ error:'消息内容不能为空' });
                res.status(201).json({ message:await sendText(req.params.chatId, text) });
            } catch (error) { res.status(502).json({ error:error.message }); }
        });
        app.put('/api/telegram-content/chats/:chatId/attachments', requireAuth, async (req, res) => {
            fs.mkdirSync(tempDir, { recursive:true });
            const name = String(req.query.name || 'attachment.bin').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'attachment.bin';
            const filePath = path.join(tempDir, `send-${crypto.randomUUID()}-${name}`);
            let bytes = 0;
            req.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > MAX_ATTACHMENT_BYTES) req.destroy(new Error('附件超过 2GB 限制'));
            });
            try {
                await pipeline(req, fs.createWriteStream(filePath));
                const result = await sendAttachment(req.params.chatId, {
                    path:filePath, name, type:String(req.query.type || req.get('content-type') || 'application/octet-stream'), size:bytes
                }, req.query.mode === 'preview' ? 'preview' : 'raw', String(req.query.caption || '').slice(0, 1024));
                res.status(201).json({ message:result });
            } catch (error) { if (!res.headersSent) res.status(502).json({ error:error.message }); }
            finally { fs.rmSync(filePath, { force:true }); }
        });
        app.get('/api/telegram-content/messages/:messageId/media', requireAuth, async (req, res) => {
            try {
                const record = load().messages.find(item => item.id === req.params.messageId);
                if (!record?.media?.fileId) return res.status(404).end();
                const backend = backendFor(record.archive.channelId);
                const size = Number(record.media.size);
                if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Telegram 媒体缺少可验证的文件大小');
                const match = String(req.get('range') || '').match(/^bytes=(\d*)-(\d*)$/i);
                let start = 0, end = size - 1;
                if (match) {
                    if (!match[1]) {
                        const suffix = Math.max(0, Number(match[2]) || 0);
                        start = Math.max(0, size - suffix);
                    } else {
                        start = Number(match[1]);
                        end = match[2] ? Number(match[2]) : size - 1;
                    }
                    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
                        res.setHeader('Content-Range', `bytes */${size}`);
                        return res.status(416).end();
                    }
                    end = Math.min(end, size - 1);
                    res.status(206);
                    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
                }
                const stream = await telegram.readPart(backend, { fileId:record.media.fileId, size }, { start, end });
                res.type(record.media.mimeType || 'application/octet-stream');
                res.setHeader('Accept-Ranges', 'bytes');
                res.setHeader('Content-Length', String(end - start + 1));
                if (record.media.fileName) res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(record.media.fileName)}`);
                stream.on('error', error => res.destroy(error));
                stream.pipe(res);
            } catch (error) { if (!res.headersSent) res.status(502).json({ error:error.message }); }
        });
    }

    return { archiveIncoming:message => archive(message, 'incoming'), archiveOutgoing:message => archive(message, 'outgoing'), isStorageChat, registerRoutes, listMessages, listMessagePage };
}

module.exports = { createTelegramContentManager, mediaFromMessage, chatRecord };
