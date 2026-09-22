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
    const manageButton = document.getElementById('telegramManageChat');
    const management = document.getElementById('telegramChatManagement');
    const webhookStatus = document.getElementById('telegramWebhookStatus');
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

    async function loadMessagePage(direction, requestedAnchor = '', force = false) {
        if (!activeChat || loadingPage === openSequence) return;
        if (direction === 'before' && !paging.hasBefore) return;
        if (direction === 'after' && !paging.hasAfter && !force) return;
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
        manageButton.hidden = false;
        management.hidden = true;
        management.replaceChildren();
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

    const permissionLabels = {
        can_send_messages:'发送文本消息', can_send_audios:'发送音频', can_send_documents:'发送文件',
        can_send_photos:'发送图片', can_send_videos:'发送视频', can_send_video_notes:'发送视频留言',
        can_send_voice_notes:'发送语音', can_send_polls:'发送投票', can_send_other_messages:'发送其它消息',
        can_add_web_page_previews:'添加网页预览', can_react_to_messages:'添加消息反应', can_edit_tag:'编辑自己的标签',
        can_change_info:'修改群信息', can_invite_users:'邀请用户',
        can_pin_messages:'置顶消息', can_manage_topics:'管理话题'
    };
    const adminLabels = {
        can_manage_chat:'管理 Chat', can_delete_messages:'删除消息', can_manage_video_chats:'管理视频聊天',
        can_restrict_members:'限制成员', can_promote_members:'任命管理员', can_change_info:'修改 Chat 信息',
        can_invite_users:'邀请用户', can_post_stories:'发布故事', can_edit_stories:'编辑故事',
        can_delete_stories:'删除故事', can_post_messages:'发布频道消息', can_edit_messages:'编辑频道消息',
        can_pin_messages:'置顶消息', can_manage_topics:'管理话题', can_manage_direct_messages:'管理频道私信',
        can_manage_tags:'管理成员标签', can_send_welcome_messages:'管理欢迎消息'
    };

    function checkboxGrid(labels, values = {}, available = null) {
        const grid = el('div', 'permission-grid');
        for (const [key, labelText] of Object.entries(labels)) {
            if (available && !(key in available)) continue;
            const label = el('label', 'permission-option');
            const inputNode = document.createElement('input');
            inputNode.type = 'checkbox'; inputNode.name = key; inputNode.checked = values[key] === true;
            if (available && available[key] !== true) inputNode.disabled = true;
            label.append(inputNode, document.createTextNode(labelText)); grid.append(label);
        }
        return grid;
    }

    function numericUserInput(placeholder = 'Telegram User ID') {
        const node = document.createElement('input');
        node.type = 'text'; node.inputMode = 'numeric'; node.autocomplete = 'off'; node.placeholder = placeholder;
        return node;
    }

    async function managementRequest(path, body) {
        return request(`/api/telegram-content/chats/${encodeURIComponent(activeChat.id)}${path}`, {
            method:body === undefined ? 'GET' : path === '/policy' ? 'PATCH' : 'POST',
            ...(body === undefined ? {} : { headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) })
        });
    }

    async function renderManagement() {
        if (!activeChat) return;
        management.hidden = false;
        management.replaceChildren(el('p', 'management-status', '正在读取 Bot 权限和 Chat 策略…'));
        try {
            const state = await managementRequest('/management');
            if (!activeChat || activeChat.id !== state.chat.id) return;
            management.replaceChildren();
            const head = el('div', 'management-head');
            head.append(el('strong', '', `${state.chat.type === 'private' ? '私聊服务' : '群组 / 频道'}管理`));
            const close = el('button', '', '收起'); close.type = 'button'; close.onclick = () => { management.hidden = true; };
            head.append(close); management.append(head);
            const operationStatus = el('div', 'management-status'); management.append(operationStatus);

            if (state.chat.type === 'private') {
                const card = el('section', 'management-card');
                card.append(el('h3', '', state.policy.serviceStopped ? '已停止服务该用户' : '正在正常服务该用户'));
                card.append(el('p', '', '停止后，该用户继续发送消息时，Bot 每 24 小时最多回复一次“该 Bot 已停止服务”。'));
                const toggle = el('button', state.policy.serviceStopped ? '' : 'danger', state.policy.serviceStopped ? '恢复服务该用户' : '停止服务该用户');
                toggle.type = 'button';
                toggle.onclick = async () => {
                    if (!state.policy.serviceStopped && !confirm('确定停止服务该用户吗？')) return;
                    try { await managementRequest('/policy', { serviceStopped:!state.policy.serviceStopped }); await renderManagement(); }
                    catch (error) { operationStatus.textContent = `操作失败：${error.message}`; }
                };
                card.append(toggle); management.append(card); return;
            }

            const admission = el('section', 'management-card');
            admission.append(el('h3', '', '新成员加入策略'), el('p', '', state.policy.rejectNewMembers ? '已禁止新用户加入；Webhook 收到新成员事件后将立即移除并 Ban。' : '当前允许新用户加入。'));
            const admissionButton = el('button', state.policy.rejectNewMembers ? '' : 'danger', state.policy.rejectNewMembers ? '恢复接受新用户' : '不再接受新用户进群/进频道');
            admissionButton.type = 'button'; admissionButton.onclick = async () => {
                if (!state.policy.rejectNewMembers && !confirm('启用后，所有新加入用户都会被立即移除并 Ban，确定继续吗？')) return;
                try { await managementRequest('/policy', { rejectNewMembers:!state.policy.rejectNewMembers }); await renderManagement(); }
                catch (error) { operationStatus.textContent = `操作失败：${error.message}`; }
            };
            admission.append(admissionButton); management.append(admission);

            if (state.chat.type === 'group') {
                const restrict = el('form', 'management-card');
                restrict.append(el('h3', '', '限制用户权限'), el('p', '', '勾选限制后仍然允许的权限；未勾选项将被限制。'));
                const userId = numericUserInput(); const permissions = checkboxGrid(permissionLabels);
                const submit = el('button', '', '应用限制'); submit.type = 'submit';
                restrict.append(userId, permissions, submit);
                restrict.onsubmit = async event => {
                    event.preventDefault();
                    const values = Object.fromEntries([...permissions.querySelectorAll('input')].map(node => [node.name, node.checked]));
                    try { await managementRequest('/actions', { action:'restrict', userId:userId.value, permissions:values }); operationStatus.textContent = '用户权限已更新。'; }
                    catch (error) { operationStatus.textContent = `限制失败：${error.message}`; }
                };
                management.append(restrict);
            }

            const remove = el('form', 'management-card');
            remove.append(el('h3', '', '移除用户'));
            const removeUserId = numericUserInput(); const banLabel = el('label', 'inline-option');
            const ban = document.createElement('input'); ban.type = 'checkbox'; banLabel.append(ban, document.createTextNode('同时 Ban，禁止重新加入'));
            const removeSubmit = el('button', 'danger', '移除用户'); removeSubmit.type = 'submit';
            remove.append(removeUserId, banLabel, removeSubmit);
            remove.onsubmit = async event => {
                event.preventDefault(); if (!confirm(`确定移除用户 ${removeUserId.value || ''} 吗？`)) return;
                try { await managementRequest('/actions', { action:'remove', userId:removeUserId.value, ban:ban.checked }); operationStatus.textContent = '用户已移除。'; }
                catch (error) { operationStatus.textContent = `移除失败：${error.message}`; }
            };
            management.append(remove);

            const admin = el('section', 'management-card'); admin.append(el('h3', '', '设为 / 编辑 / 移除管理员'));
            const availableRights = state.bot.maxAdminRights || {};
            const max = Object.entries(adminLabels).filter(([key]) => availableRights[key]).map(([, label]) => label);
            admin.append(el('p', 'bot-capacity', `Bot 当前最大可授予范围：${max.join('、') || '无（Bot 需要“任命管理员”权限）'}`));
            const adminUserId = numericUserInput(); const inspect = el('button', '', '先查询当前身份与权限'); inspect.type = 'button';
            const memberStatus = el('div', 'member-status', '必须先查询，再保存管理员权限。');
            const rights = checkboxGrid(adminLabels, {}, availableRights); let inspectedUserId = '';
            inspect.onclick = async () => {
                try {
                    const result = await managementRequest(`/members/${encodeURIComponent(adminUserId.value.trim())}`);
                    inspectedUserId = adminUserId.value.trim();
                    memberStatus.textContent = `当前身份：${result.member.status}　用户：${result.member.user?.username ? '@' + result.member.user.username : result.member.user?.first_name || inspectedUserId}`;
                    for (const node of rights.querySelectorAll('input')) node.checked = result.adminRights?.[node.name] === true;
                } catch (error) { inspectedUserId = ''; memberStatus.textContent = `查询失败：${error.message}`; }
            };
            const adminActions = el('div', 'management-actions');
            const saveAdmin = el('button', 'primary', '保存管理员权限'); saveAdmin.type = 'button';
            saveAdmin.onclick = async () => {
                if (!inspectedUserId || inspectedUserId !== adminUserId.value.trim()) return void (memberStatus.textContent = '请先查询该用户的当前身份和权限。');
                const values = Object.fromEntries([...rights.querySelectorAll('input')].map(node => [node.name, node.checked && !node.disabled]));
                try { await managementRequest('/actions', { action:'promote', userId:inspectedUserId, rights:values }); memberStatus.textContent = '管理员权限已保存。'; }
                catch (error) { memberStatus.textContent = `保存失败：${error.message}`; }
            };
            const demote = el('button', 'danger', '移除管理员'); demote.type = 'button';
            demote.onclick = async () => {
                if (!inspectedUserId || inspectedUserId !== adminUserId.value.trim()) return void (memberStatus.textContent = '请先查询该用户的当前身份。');
                if (!confirm(`确定移除用户 ${inspectedUserId} 的管理员身份吗？`)) return;
                try { await managementRequest('/actions', { action:'demote', userId:inspectedUserId }); memberStatus.textContent = '管理员身份已移除。'; }
                catch (error) { memberStatus.textContent = `移除失败：${error.message}`; }
            };
            adminActions.append(saveAdmin, demote); admin.append(adminUserId, inspect, memberStatus, rights, adminActions); management.append(admin);
        } catch (error) {
            management.replaceChildren(el('p', 'management-status', `管理功能读取失败：${error.message}`));
        }
    }

    async function syncWebhookSubscriptions() {
        webhookStatus.textContent = '· 正在检查频道/群组消息订阅…';
        try {
            await request('/api/telegram-content/webhook-subscriptions', { method:'POST' });
            webhookStatus.textContent = '· 频道/群组新消息订阅已就绪';
        } catch (error) { webhookStatus.textContent = `· 订阅未同步：${error.message}`; }
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
    manageButton.onclick = renderManagement;
    syncWebhookSubscriptions();
    loadChats();
    setInterval(() => {
        if (document.hidden) return;
        loadChats();
        if (activeChat && messages.scrollHeight - messages.scrollTop - messages.clientHeight < 160) {
            loadMessagePage('after', '', true).catch(error => { status.textContent = `读取新消息失败：${error.message}`; });
        }
    }, 6000);
})();
