'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function normalizeChatId(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Chat ID 不能使用失去精度的数字，请以字符串填写');
    const text = String(value ?? '').trim();
    if (!/^-?\d{1,16}$/.test(text)) throw new Error('Chat ID 必须是非零数字 ID，例如 -1001234567890');
    const id = BigInt(text);
    if (!id || id > 4503599627370495n || id < -4503599627370495n) throw new Error('Chat ID 超出 Telegram 的有效范围');
    return String(id);
}
function normalizeChatIdentifier(value) {
    const text = String(value ?? '').trim();
    if (/^-?\d+$/.test(text)) return normalizeChatId(text);
    const match = /^(?:@|(?:https?:\/\/)?t\.me\/)([a-zA-Z][a-zA-Z0-9_]{4,31})\/?$/i.exec(text);
    if (!match) throw new Error('公开标识应为 @频道名 或 t.me/频道名，不支持邀请链接及消息链接');
    return '@' + match[1].toLowerCase();
}
function normalizeEntries(entries) {
    if (!Array.isArray(entries) || entries.length > 500) throw new Error('Chat 字典最多支持 500 条映射');
    const ids = new Set(), usernames = new Set();
    return entries.map((row, index) => {
        if (!row || typeof row !== 'object') throw new Error(`第 ${index + 1} 条映射格式无效`);
        const chatId = normalizeChatId(row.chatId);
        const username = row.username ? normalizeChatIdentifier(row.username) : '';
        if (username && !username.startsWith('@')) throw new Error('public 标识必须是 @频道名');
        if (ids.has(chatId)) throw new Error(`Chat ID ${chatId} 已有映射，请编辑原条目`);
        const aliases = row.aliases ?? [];
        if (!Array.isArray(aliases) || aliases.length > 20) throw new Error('每个 Chat 最多支持 20 个历史 public 别名');
        const names = [username, ...aliases.map(normalizeChatIdentifier)].filter(Boolean);
        if (names.some(name => !name.startsWith('@'))) throw new Error('历史别名必须是 @频道名');
        for (const name of names) {
            if (usernames.has(name)) throw new Error(`public 标识 ${name} 出现重复或冲突映射`);
            usernames.add(name);
        }
        const label = String(row.label ?? '').trim();
        if (label.length > 100 || /[\u0000-\u001f]/.test(label)) throw new Error('备注不得超过 100 字符或包含控制字符');
        ids.add(chatId);
        return { chatId, username, label, aliases: names.filter(name => name !== username) };
    });
}
function createTelegramChatDictionary({ dataDir }) {
    const filename = path.join(dataDir, 'telegram-chat-dictionary.json');
    let entries = [];
    function reload() {
        try {
            const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (data.version !== 1) throw new Error('不支持的 Chat 字典版本');
            entries = normalizeEntries(data.entries);
        } catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
    }
    const revision = () => crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    reload();
    return {
        list() { reload(); return { entries: structuredClone(entries), revision: revision() }; },
        lookup(value) {
            let key; try { key = normalizeChatIdentifier(value); } catch (_) { return null; }
            const entry = entries.find(item => item.chatId === key || item.username === key || item.aliases.includes(key));
            return entry ? structuredClone(entry) : null;
        },
        publicUsername(value) { return this.lookup(value)?.username || ''; },
        replace(values, expectedRevision) {
            const next = normalizeEntries(values);
            reload();
            if (expectedRevision !== revision()) { const error = new Error('Chat 字典已被修改，请重新加载后再保存'); error.status = 409; throw error; }
            fs.mkdirSync(dataDir, { recursive: true });
            const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
            try {
                fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries: next }, null, 2), { mode: 0o600, flag: 'wx' });
                fs.renameSync(temporary, filename);
            } finally { fs.rmSync(temporary, { force: true }); }
            entries = next;
            return { entries: structuredClone(entries), revision: revision() };
        }
    };
}
function registerTelegramChatDictionaryRoutes(app, requireAuth, dictionary) {
    app.get('/api/telegram/chat-dictionary', requireAuth, (req, res) => {
        try { res.set('Cache-Control', 'no-store').json(dictionary.list()); }
        catch (_) { res.status(500).json({ error: 'Chat 字典读取失败，请检查服务器字典文件' }); }
    });
    app.put('/api/telegram/chat-dictionary', requireAuth, (req, res) => {
        try { res.set('Cache-Control', 'no-store').json({ ok: true, ...dictionary.replace(req.body?.entries, req.body?.revision) }); }
        catch (error) { res.status(error.status || (error.code ? 500 : 422)).json({ error: error.code ? 'Chat 字典保存失败，请检查服务器日志' : error.message }); }
    });
}
function createTelegramChatResolver({ dictionary, getChat, now = Date.now, verificationTimeoutMs = 10000 }) {
    const pending = new Map(), verified = new Map();
    return {
        async resolve(input, { token = '', baseUrl = '', strict = false } = {}) {
            const original = String(input || '').trim();
            try {
                const identifier = normalizeChatIdentifier(original);
                // Numeric IDs are already canonical. Reverse lookup is display-only.
                if (!identifier.startsWith('@')) return { identifier, chatId: identifier };
                const mapped = dictionary.lookup(identifier)?.chatId || '';
                // An old public name may have been reassigned to another Chat.
                // Only fresh upload targets can resolve it without a dictionary.
                if (!mapped && !strict) return { identifier: original, chatId: '' };
                const target = mapped || identifier;
                const key = JSON.stringify([token, baseUrl, identifier, target]);
                const saved = verified.get(key);
                if (saved && now() - saved.at < (saved.chatId ? 5 * 60 * 1000 : 30000) && (saved.chatId || !strict)) return { identifier: saved.chatId ? identifier : original, chatId: saved.chatId };
                let task = pending.get(key);
                if (!task) {
                    task = Promise.resolve().then(async () => {
                        const controller = new AbortController();
                        let timer;
                        try {
                            const timeout = new Promise((_, reject) => {
                                timer = setTimeout(() => { controller.abort(); reject(new Error('TELEGRAM_CHAT_RESOLVE_TIMEOUT')); }, verificationTimeoutMs);
                            });
                            const chat = await Promise.race([getChat(target, { token, baseUrl, signal: controller.signal }), timeout]);
                            const chatId = normalizeChatId(chat?.id);
                            if (mapped && chatId !== mapped) throw new Error('TELEGRAM_CHAT_MAPPING_MISMATCH');
                            if (verified.size > 1000) verified.clear();
                            verified.set(key, { chatId, at: now() });
                            return chatId;
                        } catch (error) {
                            if (error.message !== 'TELEGRAM_CHAT_MAPPING_MISMATCH') {
                                if (verified.size > 1000) verified.clear();
                                verified.set(key, { chatId: '', at: now() });
                            }
                            throw error;
                        } finally { clearTimeout(timer); }
                    }).finally(() => pending.delete(key));
                    pending.set(key, task);
                }
                return { identifier, chatId: await task };
            } catch (error) {
                if (strict || error.message === 'TELEGRAM_CHAT_MAPPING_MISMATCH') throw error;
                // Missing dictionaries or inaccessible chats never erase old sources.
                return { identifier: original, chatId: '' };
            }
        }
    };
}

module.exports = { normalizeChatId, normalizeChatIdentifier, normalizeEntries, createTelegramChatDictionary, createTelegramChatResolver, registerTelegramChatDictionaryRoutes };
