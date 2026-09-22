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
const STOPPED_SERVICE_NOTICE = '该 Bot 已停止服务';
const DAY_MS = 24 * 60 * 60 * 1000;
const MEMBER_PERMISSION_KEYS = [
    'can_send_messages', 'can_send_audios', 'can_send_documents', 'can_send_photos',
    'can_send_videos', 'can_send_video_notes', 'can_send_voice_notes', 'can_send_polls',
    'can_send_other_messages', 'can_add_web_page_previews', 'can_react_to_messages', 'can_edit_tag',
    'can_change_info', 'can_invite_users', 'can_pin_messages', 'can_manage_topics'
];
const ADMIN_RIGHT_KEYS = [
    'can_manage_chat', 'can_delete_messages', 'can_manage_video_chats', 'can_restrict_members',
    'can_promote_members', 'can_change_info', 'can_invite_users', 'can_post_stories',
    'can_edit_stories', 'can_delete_stories', 'can_post_messages', 'can_edit_messages',
    'can_pin_messages', 'can_manage_topics', 'can_manage_direct_messages', 'can_manage_tags',
    'can_send_welcome_messages'
];

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
    const policiesPath = path.join(dataDir, 'telegram-content-policies.json');
    const tempDir = path.join(dataDir, 'telegram-content-tmp');
    const cacheDir = path.join(dataDir, 'telegram-content-cache');
    const getBackend = options.getBackend;
    const telegram = options.telegram;
    const createVideoThumbnail = options.createVideoThumbnail;
    const archiveReads = new Map();
    const stoppedNoticeWrites = new Map();
    let writeQueue = Promise.resolve();
    let policyWriteQueue = Promise.resolve();
    let botIdentityCache = null;

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

    function loadPolicies() {
        try {
            const parsed = JSON.parse(fs.readFileSync(policiesPath, 'utf8'));
            return { version:1, chats:parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {} };
        } catch (_) { return { version:1, chats:{} }; }
    }

    function mutatePolicies(callback) {
        let result;
        policyWriteQueue = policyWriteQueue.then(() => {
            const policies = loadPolicies();
            result = callback(policies);
            atomicWrite(policiesPath, policies);
        });
        return policyWriteQueue.then(() => result);
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

    async function observeChat(chat, eventDate = 0) {
        if (!chat?.id || isStorageChat(chat)) return null;
        const record = chatRecord(chat);
        await mutate(index => {
            const previous = index.chats[record.id] || {};
            index.chats[record.id] = {
                ...previous, ...record,
                lastMessageAt:Math.max(Number(previous.lastMessageAt) || 0, Number(eventDate) || 0)
            };
        });
        return record;
    }

    function knownChat(chatId) {
        const chat = load().chats[String(chatId)] || null;
        if (!chat) {
            const error = new Error('该 Chat 尚未被 Telegram 内容管理功能记录');
            error.status = 404;
            throw error;
        }
        return chat;
    }

    const callBotApi = (method, payload) => telegram.call(backendFor(), method, payload);

    async function botIdentity() {
        if (botIdentityCache && Date.now() - botIdentityCache.cachedAt < 5 * 60 * 1000) return botIdentityCache.value;
        const value = await callBotApi('getMe', {});
        botIdentityCache = { cachedAt:Date.now(), value };
        return value;
    }

    async function botAdminCapacity(chatId, type = '') {
        const bot = await botIdentity();
        const member = await callBotApi('getChatMember', { chat_id:chatId, user_id:bot.id });
        const canPromote = member.status === 'creator' || (member.status === 'administrator' && member.can_promote_members === true);
        const maxAdminRights = {};
        for (const key of ADMIN_RIGHT_KEYS) {
            const applicable = type === 'channel'
                ? !['can_pin_messages', 'can_manage_topics', 'can_manage_tags'].includes(key)
                : !['can_post_messages', 'can_edit_messages', 'can_manage_direct_messages'].includes(key);
            maxAdminRights[key] = Boolean(applicable && canPromote && (member.status === 'creator' || member[key] === true));
        }
        return { id:String(bot.id), username:bot.username || '', status:member.status, canPromote, maxAdminRights };
    }

    function validUserId(value) {
        const userId = Number(value);
        if (!Number.isSafeInteger(userId) || userId <= 0) {
            const error = new Error('Telegram User ID 必须是正整数');
            error.status = 422;
            throw error;
        }
        return userId;
    }

    async function managementState(chatId) {
        const chat = knownChat(chatId);
        const policies = loadPolicies();
        const bot = await botAdminCapacity(chat.id, chat.type);
        return { chat, policy:policies.chats[chat.id] || {}, bot };
    }

    async function inspectMember(chatId, rawUserId) {
        const chat = knownChat(chatId);
        if (chat.type === 'private') throw Object.assign(new Error('私聊不支持成员权限管理'), { status:422 });
        const userId = validUserId(rawUserId);
        const [member, bot] = await Promise.all([
            callBotApi('getChatMember', { chat_id:chat.id, user_id:userId }),
            botAdminCapacity(chat.id, chat.type)
        ]);
        const adminRights = Object.fromEntries(ADMIN_RIGHT_KEYS.map(key => [key, member.status === 'creator' || member[key] === true]));
        return { member, adminRights, bot };
    }

    async function setPolicy(chatId, patch = {}) {
        const chat = knownChat(chatId);
        return mutatePolicies(policies => {
            const current = policies.chats[chat.id] || {};
            const next = { ...current, updatedAt:Date.now() };
            if (chat.type === 'private' && Object.hasOwn(patch, 'serviceStopped')) {
                next.serviceStopped = patch.serviceStopped === true;
                if (!next.serviceStopped) next.lastStoppedNoticeAt = 0;
            }
            if (chat.type !== 'private' && Object.hasOwn(patch, 'rejectNewMembers')) next.rejectNewMembers = patch.rejectNewMembers === true;
            policies.chats[chat.id] = next;
            return next;
        });
    }

    async function performManagementAction(chatId, input = {}) {
        const chat = knownChat(chatId);
        if (chat.type === 'private') throw Object.assign(new Error('私聊不支持该成员管理操作'), { status:422 });
        const action = String(input.action || '');
        const userId = validUserId(input.userId);
        if (action === 'restrict') {
            if (chat.type !== 'group') throw Object.assign(new Error('只有群组支持限制成员权限'), { status:422 });
            const source = input.permissions && typeof input.permissions === 'object' ? input.permissions : {};
            const permissions = Object.fromEntries(MEMBER_PERMISSION_KEYS.map(key => [key, source[key] === true]));
            await callBotApi('restrictChatMember', { chat_id:chat.id, user_id:userId, permissions, use_independent_chat_permissions:true });
            return { ok:true, action, permissions };
        }
        if (action === 'remove') {
            await callBotApi('banChatMember', { chat_id:chat.id, user_id:userId, revoke_messages:true });
            if (input.ban !== true) await callBotApi('unbanChatMember', { chat_id:chat.id, user_id:userId, only_if_banned:true });
            return { ok:true, action, banned:input.ban === true };
        }
        if (action === 'promote') {
            const [capacity, currentMember] = await Promise.all([
                botAdminCapacity(chat.id, chat.type),
                callBotApi('getChatMember', { chat_id:chat.id, user_id:userId })
            ]);
            if (!capacity.canPromote) throw Object.assign(new Error('Bot 当前没有任命或编辑管理员的权限'), { status:409 });
            if (currentMember.status === 'creator' || (currentMember.status === 'administrator' && currentMember.can_be_edited !== true)) {
                throw Object.assign(new Error('Bot 无法编辑该管理员：该用户不是由 Bot 可管理的管理员'), { status:409 });
            }
            const source = input.rights && typeof input.rights === 'object' ? input.rights : {};
            const rights = {};
            for (const key of ADMIN_RIGHT_KEYS) {
                if (source[key] === true && !capacity.maxAdminRights[key]) {
                    throw Object.assign(new Error(`Bot 无法授予权限：${key}`), { status:422 });
                }
                rights[key] = source[key] === true;
            }
            await callBotApi('promoteChatMember', { chat_id:chat.id, user_id:userId, ...rights });
            return { ok:true, action, rights };
        }
        if (action === 'demote') {
            const currentMember = await callBotApi('getChatMember', { chat_id:chat.id, user_id:userId });
            if (currentMember.status === 'creator' || (currentMember.status === 'administrator' && currentMember.can_be_edited !== true)) {
                throw Object.assign(new Error('Bot 无法移除该管理员身份'), { status:409 });
            }
            await callBotApi('promoteChatMember', {
                chat_id:chat.id, user_id:userId,
                ...Object.fromEntries(ADMIN_RIGHT_KEYS.map(key => [key, false]))
            });
            return { ok:true, action };
        }
        throw Object.assign(new Error('不支持的 Telegram 管理操作'), { status:422 });
    }

    async function processUpdate(update = {}) {
        const contentMessage = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
        const memberUpdate = update.chat_member || update.my_chat_member;
        const joinRequest = update.chat_join_request;
        const chat = contentMessage?.chat || memberUpdate?.chat || joinRequest?.chat;
        if (!chat?.id || isStorageChat(chat)) return { handled:false };
        await observeChat(chat, contentMessage?.date || memberUpdate?.date || joinRequest?.date || 0);
        const policy = loadPolicies().chats[String(chat.id)] || {};
        if (chat.type === 'private' && policy.serviceStopped && update.message && !update.message.from?.is_bot) {
            const lastNoticeAt = Number(policy.lastStoppedNoticeAt) || 0;
            if (Date.now() - lastNoticeAt >= DAY_MS) {
                const key = String(chat.id);
                if (!stoppedNoticeWrites.has(key)) {
                    const sending = (async () => {
                        const result = await callBotApi('sendMessage', { chat_id:chat.id, text:STOPPED_SERVICE_NOTICE });
                        await mutatePolicies(policies => {
                            const next = policies.chats[key] || {};
                            policies.chats[key] = { ...next, serviceStopped:true, lastStoppedNoticeAt:Date.now(), updatedAt:Date.now() };
                        });
                        await archive(result, 'outgoing').catch(() => {});
                    })().finally(() => stoppedNoticeWrites.delete(key));
                    stoppedNoticeWrites.set(key, sending);
                    await sending;
                }
            }
            return { handled:true, reason:'service-stopped' };
        }
        if (chat.type !== 'private' && policy.rejectNewMembers) {
            const ids = new Set();
            for (const user of contentMessage?.new_chat_members || []) if (user?.id) ids.add(Number(user.id));
            if (update.chat_member) {
                const previous = String(update.chat_member.old_chat_member?.status || '');
                const next = String(update.chat_member.new_chat_member?.status || '');
                if (['left', 'kicked'].includes(previous) && ['member', 'restricted'].includes(next)) ids.add(Number(update.chat_member.new_chat_member?.user?.id));
            }
            if (joinRequest?.from?.id) ids.add(Number(joinRequest.from.id));
            const bot = await botIdentity().catch(() => null);
            ids.delete(Number(bot?.id));
            const results = await Promise.allSettled([...ids].filter(Number.isSafeInteger).map(userId => callBotApi('banChatMember', {
                chat_id:chat.id, user_id:userId, revoke_messages:true
            })));
            const rejected = [...ids].filter((_, index) => results[index]?.status === 'fulfilled');
            return { handled:false, rejectedNewMembers:rejected };
        }
        return { handled:false };
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
        app.get('/api/telegram-content/chats/:chatId/management', requireAuth, async (req, res) => {
            try {
                res.setHeader('Cache-Control', 'no-store');
                res.json(await managementState(req.params.chatId));
            } catch (error) { res.status(Number(error.status) || 502).json({ error:error.message }); }
        });
        app.get('/api/telegram-content/chats/:chatId/members/:userId', requireAuth, async (req, res) => {
            try {
                res.setHeader('Cache-Control', 'no-store');
                res.json(await inspectMember(req.params.chatId, req.params.userId));
            } catch (error) { res.status(Number(error.status) || 502).json({ error:error.message }); }
        });
        app.patch('/api/telegram-content/chats/:chatId/policy', requireAuth, async (req, res) => {
            try {
                res.setHeader('Cache-Control', 'no-store');
                res.json({ policy:await setPolicy(req.params.chatId, req.body || {}) });
            } catch (error) { res.status(Number(error.status) || 502).json({ error:error.message }); }
        });
        app.post('/api/telegram-content/chats/:chatId/actions', requireAuth, async (req, res) => {
            try {
                res.setHeader('Cache-Control', 'no-store');
                res.json(await performManagementAction(req.params.chatId, req.body || {}));
            } catch (error) { res.status(Number(error.status) || 502).json({ error:error.message }); }
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

    return {
        archiveIncoming:message => archive(message, 'incoming'), archiveOutgoing:message => archive(message, 'outgoing'),
        isStorageChat, registerRoutes, listMessages, listMessagePage, observeChat, processUpdate,
        managementState, inspectMember, setPolicy, performManagementAction
    };
}

module.exports = { createTelegramContentManager, mediaFromMessage, chatRecord, MEMBER_PERMISSION_KEYS, ADMIN_RIGHT_KEYS };
