'use strict';
(function () {
    const list = document.getElementById('telegramChatList');
    const messages = document.getElementById('telegramMessages');
    const composer = document.getElementById('telegramComposer');
    const title = document.getElementById('activeChatTitle');
    const meta = document.getElementById('activeChatMeta');
    const input = document.getElementById('telegramMessageInput');
    const attachments = document.getElementById('telegramAttachments');
    const mode = document.getElementById('telegramAttachmentMode');
    const selected = document.getElementById('selectedAttachments');
    const status = document.getElementById('telegramContentStatus');
    let chats = [], activeChat = null, busy = false, loadingPage = 0, openSequence = 0, anchorTimer = 0;
    let paging = { firstAnchor:'', lastAnchor:'', hasBefore:false, hasAfter:false };
    const MAX_RENDERED_MESSAGES = 160;
    const loadedMessageIds = new Set();
    const anchorKey = chatId => `telegramContentBrowseAnchor:v1:${chatId}`;

    async function request(url, options) {
        const response = await fetch(url, options);
        if (response.status === 401) { location.href = `/admin-auth?next=${encodeURIComponent(location.pathname)}`; throw new Error('管理会话已失效'); }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        return payload;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function renderChats() {
        list.replaceChildren();
        const groups = [['channel','频道'], ['group','群组'], ['private','私聊']];
        for (const [type, label] of groups) {
            const values = chats.filter(chat => chat.type === type);
            if (!values.length) continue;
            const section = el('section', 'chat-group');
            section.append(el('h2', '', `${label} · ${values.length}`));
            for (const chat of values) {
                const button = el('button', `chat-item${activeChat?.id === chat.id ? ' active' : ''}`);
                button.type = 'button';
                button.append(el('strong', '', chat.title), el('small', '', chat.username ? `@${chat.username} · ${chat.id}` : chat.id));
                button.onclick = () => openChat(chat);
                section.append(button);
            }
            list.append(section);
        }
        if (!list.children.length) list.append(el('p', 'empty', '尚未收到任何非网盘托管频道消息。'));
    }

    function mediaElement(record) {
        if (!record.media) return null;
        const url = `/api/telegram-content/messages/${encodeURIComponent(record.id)}/media`;
        if (record.media.kind === 'photo' || record.media.kind === 'sticker') {
            const image = document.createElement('img'); image.src = url; image.alt = record.media.fileName || '图片'; image.loading = 'lazy'; return image;
        }
        if (['video','animation','video_note'].includes(record.media.kind)) {
            const video = document.createElement('video'); video.src = url; video.controls = true; video.preload = 'metadata'; video.playsInline = true; return video;
        }
        if (['audio','voice'].includes(record.media.kind)) {
            const audio = document.createElement('audio'); audio.src = url; audio.controls = true; audio.preload = 'metadata'; return audio;
        }
        const link = el('a', 'document-link', record.media.fileName || '下载附件'); link.href = url; link.target = '_blank'; return link;
    }

    function renderMessage(record) {
        const bubble = el('section', `message ${record.direction === 'outgoing' ? 'outgoing' : 'incoming'}`);
        bubble.dataset.messageId = record.id;
        if (record.unavailable) bubble.append(el('div', 'message-text', `归档暂时无法读取：${record.error || '未知错误'}`));
        else {
            const media = mediaElement(record); if (media) bubble.append(media);
            const value = record.message?.text || '';
            const caption = record.message?.caption || '';
            if (value) bubble.append(el('div', 'message-text', value));
            if (caption) bubble.append(el('div', 'message-caption', caption));
            if (!media && !value && !caption) bubble.append(el('div', 'message-text', `[${record.kind} 消息]`));
        }
        const time = document.createElement('time');
        time.dateTime = new Date(record.date * 1000).toISOString();
        time.textContent = new Date(record.date * 1000).toLocaleString();
        bubble.append(time); return bubble;
    }

    function saveBrowseAnchor() {
        if (!activeChat) return;
        const bounds = messages.getBoundingClientRect();
        const center = bounds.top + bounds.height / 2;
        let closest = null, distance = Infinity;
        for (const node of messages.querySelectorAll('.message[data-message-id]')) {
            const rect = node.getBoundingClientRect();
            const nextDistance = Math.abs(rect.top + rect.height / 2 - center);
            if (nextDistance < distance) { closest = node; distance = nextDistance; }
        }
        if (closest?.dataset.messageId) localStorage.setItem(anchorKey(activeChat.id), closest.dataset.messageId);
    }

    function scheduleBrowseAnchor() {
        clearTimeout(anchorTimer);
        anchorTimer = setTimeout(saveBrowseAnchor, 180);
    }

    function trimRenderedMessages(direction) {
        const nodes = [...messages.querySelectorAll('.message[data-message-id]')];
        if (nodes.length <= MAX_RENDERED_MESSAGES) return;
        const oldHeight = messages.scrollHeight, removeFromStart = direction === 'after';
        for (const node of removeFromStart ? nodes.slice(0, nodes.length - MAX_RENDERED_MESSAGES) : nodes.slice(MAX_RENDERED_MESSAGES)) {
            loadedMessageIds.delete(node.dataset.messageId);
            node.remove();
        }
        const remaining = messages.querySelectorAll('.message[data-message-id]');
        paging.firstAnchor = remaining[0]?.dataset.messageId || paging.firstAnchor;
        paging.lastAnchor = remaining[remaining.length - 1]?.dataset.messageId || paging.lastAnchor;
        if (removeFromStart) {
            paging.hasBefore = true;
            messages.scrollTop = Math.max(0, messages.scrollTop - (oldHeight - messages.scrollHeight));
        } else paging.hasAfter = true;
    }

    async function loadMessagePage(direction, requestedAnchor = '') {
        if (!activeChat || loadingPage === openSequence) return;
        if (direction === 'before' && !paging.hasBefore) return;
        if (direction === 'after' && !paging.hasAfter) return;
        const chatId = activeChat.id, sequence = openSequence;
        const anchor = requestedAnchor || (direction === 'before' ? paging.firstAnchor : direction === 'after' ? paging.lastAnchor : '');
        loadingPage = sequence;
        messages.classList.add('is-loading-page');
        try {
            const query = new URLSearchParams({ limit:'40', direction, ...(anchor ? { anchor } : {}) });
            const result = await request(`/api/telegram-content/chats/${encodeURIComponent(chatId)}/messages?${query}`);
            if (!activeChat || activeChat.id !== chatId || sequence !== openSequence) return;
            const records = (result.messages || []).filter(record => !loadedMessageIds.has(record.id));
            const nodes = records.map(record => { loadedMessageIds.add(record.id); return renderMessage(record); });
            if (direction === 'before') {
                const oldHeight = messages.scrollHeight, oldTop = messages.scrollTop;
                messages.prepend(...nodes);
                messages.scrollTop = oldTop + messages.scrollHeight - oldHeight;
                paging.firstAnchor = result.paging?.firstAnchor || paging.firstAnchor;
                paging.hasBefore = Boolean(result.paging?.hasBefore);
                trimRenderedMessages('before');
            } else if (direction === 'after') {
                messages.append(...nodes);
                paging.lastAnchor = result.paging?.lastAnchor || paging.lastAnchor;
                paging.hasAfter = Boolean(result.paging?.hasAfter);
                trimRenderedMessages('after');
            } else {
                messages.replaceChildren(...nodes);
                paging = { ...paging, ...(result.paging || {}) };
                if (!nodes.length) messages.append(el('p', 'empty', '暂无消息。'));
                const target = requestedAnchor && messages.querySelector(`[data-message-id="${CSS.escape(requestedAnchor)}"]`);
                if (target && result.paging?.requestedAnchor) target.scrollIntoView({ block:'center' });
                else messages.scrollTop = messages.scrollHeight;
            }
        } finally {
            if (loadingPage === sequence) {
                loadingPage = 0;
                messages.classList.remove('is-loading-page');
            }
        }
    }

    async function openChat(chat, { latest = false } = {}) {
        activeChat = chat; renderChats(); composer.hidden = false;
        title.textContent = chat.title; meta.textContent = `${chat.type} · ${chat.id}`;
        messages.replaceChildren(el('p', 'empty', '正在从 Telegram 读取消息归档…'));
        loadedMessageIds.clear(); paging = { firstAnchor:'', lastAnchor:'', hasBefore:false, hasAfter:false }; openSequence++;
        try {
            const savedAnchor = latest ? '' : localStorage.getItem(anchorKey(chat.id)) || '';
            await loadMessagePage(savedAnchor ? 'around' : 'latest', savedAnchor);
        } catch (error) { messages.replaceChildren(el('p', 'empty', `读取失败：${error.message}`)); }
    }

    messages.addEventListener('scroll', () => {
        scheduleBrowseAnchor();
        if (messages.scrollTop < 120) loadMessagePage('before').catch(error => { status.textContent = `读取更早消息失败：${error.message}`; });
        if (messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120) loadMessagePage('after').catch(error => { status.textContent = `读取更新消息失败：${error.message}`; });
    }, { passive:true });

    async function loadChats() {
        try { chats = (await request('/api/telegram-content/chats')).chats || []; renderChats(); }
        catch (error) { list.replaceChildren(el('p', 'empty', `读取失败：${error.message}`)); }
    }

    attachments.onchange = () => { selected.textContent = [...attachments.files].map(file => `${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`).join('、'); };
    composer.onsubmit = async event => {
        event.preventDefault();
        if (!activeChat || busy) return;
        const text = input.value.trim(), files = [...attachments.files];
        if (!text && !files.length) { status.textContent = '请输入消息或选择附件。'; return; }
        busy = true; status.textContent = '正在发送…';
        try {
            if (text && !files.length) await request(`/api/telegram-content/chats/${encodeURIComponent(activeChat.id)}/messages`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ text }) });
            const attachmentCaption = text.slice(0, 1024);
            for (let index = 0; index < files.length; index++) {
                const file = files[index]; status.textContent = `正在发送附件 ${index + 1}/${files.length}：${file.name}`;
                const query = new URLSearchParams({ name:file.name, type:file.type || 'application/octet-stream', mode:mode.value, caption:index === 0 ? attachmentCaption : '' });
                await request(`/api/telegram-content/chats/${encodeURIComponent(activeChat.id)}/attachments?${query}`, { method:'PUT', headers:{ 'Content-Type':'application/octet-stream' }, body:file });
            }
            input.value = ''; attachments.value = ''; selected.textContent = ''; status.textContent = '发送完成。';
            await openChat(activeChat, { latest:true }); await loadChats();
        } catch (error) { status.textContent = `发送失败：${error.message}`; }
        finally { busy = false; }
    };
    document.getElementById('refreshChats').onclick = loadChats;
    loadChats();
})();
