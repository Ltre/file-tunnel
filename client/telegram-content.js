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
    let chats = [], activeChat = null, busy = false;

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

    async function openChat(chat) {
        activeChat = chat; renderChats(); composer.hidden = false;
        title.textContent = chat.title; meta.textContent = `${chat.type} · ${chat.id}`;
        messages.replaceChildren(el('p', 'empty', '正在从 Telegram 读取消息归档…'));
        try {
            const result = await request(`/api/telegram-content/chats/${encodeURIComponent(chat.id)}/messages?limit=80`);
            messages.replaceChildren(...result.messages.map(renderMessage));
            if (!result.messages.length) messages.append(el('p', 'empty', '暂无消息。'));
            messages.scrollTop = messages.scrollHeight;
        } catch (error) { messages.replaceChildren(el('p', 'empty', `读取失败：${error.message}`)); }
    }

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
            if (text) await request(`/api/telegram-content/chats/${encodeURIComponent(activeChat.id)}/messages`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ text }) });
            for (let index = 0; index < files.length; index++) {
                const file = files[index]; status.textContent = `正在发送附件 ${index + 1}/${files.length}：${file.name}`;
                const query = new URLSearchParams({ name:file.name, type:file.type || 'application/octet-stream', mode:mode.value, caption:'' });
                await request(`/api/telegram-content/chats/${encodeURIComponent(activeChat.id)}/attachments?${query}`, { method:'PUT', headers:{ 'Content-Type':'application/octet-stream' }, body:file });
            }
            input.value = ''; attachments.value = ''; selected.textContent = ''; status.textContent = '发送完成。';
            await openChat(activeChat); await loadChats();
        } catch (error) { status.textContent = `发送失败：${error.message}`; }
        finally { busy = false; }
    };
    document.getElementById('refreshChats').onclick = loadChats;
    loadChats();
})();
