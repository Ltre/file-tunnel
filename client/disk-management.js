'use strict';
(function () {
    const api = '/api/telegram/disk-admin';
    const $ = id => document.getElementById(id);
    const state = { overview: null, selected: null, path: '', cleanupOffset: 0, cleanupGeneration: 0, lookupGeneration: 0, detailGeneration: 0, detailId: '' };
    const initialLocation = new URLSearchParams(location.search);
    const text = value => String(value ?? '');
    const bytes = value => {
        let size = Number(value) || 0; const units = ['B', 'KB', 'MB', 'GB', 'TB']; let index = 0;
        while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
        return `${size.toFixed(index ? 1 : 0)} ${units[index]}`;
    };
    const time = value => Number(value) ? new Date(Number(value)).toLocaleString('zh-CN') : '—';
    async function request(path, options = {}) {
        const response = await fetch(api + path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, cache: 'no-store' });
        if (response.status === 401) { location.href = '/admin-auth.html?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('管理会话已失效'); }
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP_${response.status}`);
        return response.json();
    }
    const clear = node => node.replaceChildren();
    function el(tag, className, content) {
        const node = document.createElement(tag); if (className) node.className = className;
        if (content !== undefined) node.textContent = content; return node;
    }
    const fileUrl = item => api + '/files/' + encodeURIComponent(item.id) + '/download?' + new URLSearchParams({ user_id: item.userId, disk_space: item.diskSpace || '' });
    const previewable = item => item.kind !== 'directory' && item.reviewStatus !== 'deleted' && (/^(image|audio|video|text)\//.test(item.type || '') || item.type === 'application/pdf');
    let previewUrl = '';
    function closePreview() {
        $('diskAdminPreview').hidden = true; $('diskAdminPreviewBody').replaceChildren();
        if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = '';
    }
    async function preview(item) {
        if (!previewable(item)) return;
        closePreview(); $('diskAdminPreview').hidden = false; $('diskAdminPreviewName').textContent = item.name;
        $('diskAdminPreviewStatus').textContent = '正在打开按需分片预览…';
        try {
            const type = item.type || 'application/octet-stream'; let media;
            if (type.startsWith('text/')) {
                const response = await fetch(fileUrl(item), { cache: 'no-store' });
                if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP_${response.status}`);
                const blob = await response.blob(); media = el('pre'); media.textContent = await blob.slice(0, 2 * 1024 * 1024).text();
                previewUrl = URL.createObjectURL(blob);
            }
            else {
                if (type.startsWith('image/')) media = el('img');
                else if (type.startsWith('audio/')) { media = el('audio'); media.controls = true; media.autoplay = true; }
                else if (type.startsWith('video/')) { media = el('video'); media.controls = true; media.autoplay = true; }
                else { media = el('iframe'); media.setAttribute('sandbox', ''); media.title = item.name; }
                media.src = fileUrl(item);
            }
            $('diskAdminPreviewBody').replaceChildren(media); $('diskAdminPreviewStatus').textContent = /^(audio|video)\//.test(type) ? `按播放位置请求 Telegram 分片 · ${bytes(item.size)}` : `预览已加载 · ${bytes(item.size)}`;
        } catch (error) { $('diskAdminPreviewStatus').textContent = '预览失败：' + error.message; }
    }
    function thumbnail(item) {
        const button = el('button', 'disk-admin-thumb'); button.type = 'button';
        button.title = previewable(item) ? '预览原文件' : (item.reviewStatus === 'deleted' ? '文件实体已删除' : '此类型暂不支持预览');
        button.disabled = !previewable(item);
        if (item.kind === 'directory') button.textContent = '📁';
        else if (String(item.type || '').startsWith('image/') && item.reviewStatus !== 'deleted') {
            const image = el('img'); image.loading = 'lazy'; image.alt = item.name; image.src = fileUrl(item); button.append(image);
        } else button.textContent = String(item.type || '').startsWith('video/') ? '🎞' : String(item.type || '').startsWith('audio/') ? '♫' : '📄';
        button.onclick = () => preview(item); return button;
    }
    function renderTree() {
        const root = $('storageTree'); clear(root);
        for (const system of state.overview?.systems || []) {
            const systemNode = document.createElement('details'); systemNode.open = system.appId === 'system';
            const systemSummary = document.createElement('summary');
            const strong = el('strong', '', system.label || system.appId); const appId = el('span', 'muted', system.appId === 'system' ? ' · 本站网页登录' : ` · app_id: ${system.appId}`);
            systemSummary.append(strong, appId); systemNode.append(systemSummary);
            for (const user of system.users || []) {
                const userNode = document.createElement('details'); userNode.className = 'user';
                const userSummary = document.createElement('summary');
                userSummary.append(el('span', '', user.username || user.name || '网盘用户'), el('span', 'muted', ` · ${user.userId}${user.telegramId ? ' · TG ' + user.telegramId : ''} · ${user.provider || '通用账号'}`));
                userNode.append(userSummary);
                for (const space of user.spaces || []) {
                    const button = el('button', 'space', `${space.diskSpace || '默认分区'} · 来源：${system.label || system.appId} · ${space.fileCount} 个文件 · ${bytes(space.size)}`);
                    const selected = state.selected && state.selected.appId === system.appId && state.selected.userId === user.userId && state.selected.diskSpace === space.diskSpace;
                    if (selected) { button.classList.add('active'); systemNode.open = true; userNode.open = true; }
                    button.onclick = () => selectSpace({ appId: system.appId, appLabel: system.label, userId: user.userId, user, ...space });
                    userNode.append(button);
                }
                systemNode.append(userNode);
            }
            root.append(systemNode);
        }
        if (!root.children.length) root.append(el('div', 'empty', '尚无网盘用户。'));
    }
    async function selectSpace(selected, path = '') {
        state.selected = selected; state.path = path; renderTree();
        $('contentTitle').textContent = `${selected.appLabel} / ${selected.user.username || selected.user.name || selected.userId} / ${selected.diskSpace || '默认分区'}`;
        $('pageStatus').textContent = '正在加载目录…';
        try {
            const query = new URLSearchParams({ user_id: selected.userId, disk_space: selected.diskSpace || '', app_id: selected.appId, path });
            const data = await request('/storage-contents?' + query);
            if (state.selected !== selected || state.path !== path) return;
            renderContents(data); $('pageStatus').textContent = '';
        } catch (error) { if (state.selected === selected && state.path === path) $('pageStatus').textContent = '加载失败：' + error.message; }
    }
    function renderContents(data) {
        const bread = $('contentBreadcrumbs'); clear(bread); const parts = state.path.split('/').filter(Boolean);
        for (let index = 0; index <= parts.length; index++) {
            const button = el('button', '', index ? parts[index - 1] : '根目录'); button.onclick = () => selectSpace(state.selected, parts.slice(0, index).join('/')); bread.append(button);
        }
        const context = { userId: state.selected.userId, diskSpace: state.selected.diskSpace || '', appId: state.selected.appId, user: state.selected.user };
        const rows = [...(data.folders || []).map(folder => ({ ...folder, ...context, kind: 'directory' })), ...(data.files || []).map(file => ({ ...file, ...context }))];
        $('contentSummary').textContent = `${data.folders?.length || 0} 个目录，${data.files?.length || 0} 个文件；来源系统：${state.selected.appLabel}（${state.selected.appId}）`;
        renderFileTable($('contentTable'), rows, true);
        const fileId = initialLocation.get('file_id');
        if (fileId) {
            const row = [...$('contentTable').querySelectorAll('[data-file-id]')].find(node => node.dataset.fileId === fileId);
            if (row) { row.classList.add('diagnostic-highlight'); row.scrollIntoView({ block: 'center' }); setTimeout(() => row.classList.remove('diagnostic-highlight'), 3000); initialLocation.delete('file_id'); }
        }
    }
    function renderFileTable(target, rows, navigable) {
        clear(target); if (!rows.length) { target.append(el('div', 'empty', '没有内容。')); return; }
        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>缩略图</th><th>名称</th><th>类型 / 状态</th><th>大小</th><th>所属用户 / 分区</th><th>来源</th><th>时间</th><th>管理操作</th></tr></thead>';
        const body = document.createElement('tbody');
        for (const item of rows) {
            const row = document.createElement('tr'), nameCell = document.createElement('td');
            if (item.kind !== 'directory') row.dataset.fileId = item.id;
            if (navigable && item.kind === 'directory' && item.reviewStatus !== 'deleted') { const button = el('button', 'name-button', '📁 ' + item.name); button.onclick = () => selectSpace(state.selected, item.path); nameCell.append(button); }
            else if (previewable(item)) { const button = el('button', 'name-button', '📄 ' + item.name); button.onclick = () => preview(item); nameCell.append(button); }
            else nameCell.textContent = (item.kind === 'directory' ? '📁 ' : '📄 ') + item.name;
            const status = item.reviewStatus || 'active';
            const labels = { active: '正常', blocked: '已屏蔽（仅本人可见）', deleted: '实体已删除（保留占位）' };
            const statusCell = el('td', 'status-' + status, item.kind === 'directory' ? `目录 · ${labels[status] || status}` : `${item.type || '文件'} · ${labels[status] || status}`);
            const actions = moderationButtons(item);
            const thumbCell = el('td'); thumbCell.append(thumbnail(item));
            row.append(thumbCell, nameCell, statusCell, el('td', '', item.kind === 'directory' ? bytes(item.size) : bytes(item.size)), el('td', '', item.userId ? `${item.user?.username || item.user?.name || item.userId} / ${item.diskSpace || '默认分区'}` : state.selected?.userId || '—'), el('td', '', item.appId || item.sourceAppId || state.selected?.appId || '—'), el('td', '', time(item.createdAt || item.updatedAt)), actions);
            body.append(row);
        }
        table.append(body); target.append(table);
    }
    async function renderReviews() {
        const data = await request('/reviews'), target = $('reviewTable'); clear(target);
        if (!data.files.length) { target.append(el('div', 'empty', '暂无待审文件流水。')); return; }
        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>缩略图</th><th>文件</th><th>用户 / 分区</th><th>来源</th><th>大小 / 时间</th><th>状态</th><th>审核操作</th></tr></thead>';
        const body = document.createElement('tbody');
        for (const file of data.files) {
            const row = document.createElement('tr');
            const status = file.reviewStatus || 'active', statusText = status === 'blocked' ? '已屏蔽' : status === 'deleted' ? '实体已删除' : '正常';
            const nameCell = el('td');
            if (previewable(file)) { const button = el('button', 'name-button', file.name); button.onclick = () => preview(file); nameCell.append(button, document.createElement('br'), document.createTextNode(file.folderPath || '根目录')); }
            else nameCell.textContent = `${file.name}\n${file.folderPath || '根目录'}`;
            const thumbCell = el('td'); thumbCell.append(thumbnail(file));
            row.append(thumbCell, nameCell, el('td', '', `${file.user?.username || file.user?.name || file.userId}\n${file.diskSpace || '默认分区'}`), el('td', '', file.appId), el('td', '', `${bytes(file.size)}\n${time(file.createdAt)}`), el('td', 'status-' + status, statusText), moderationButtons(file)); body.append(row);
        }
        table.append(body); target.append(table);
    }
    function moderationButtons(item) {
        const actions = el('td', 'review-actions'), status = item.reviewStatus || 'active';
        if (status === 'active') { const block = el('button', '', '屏蔽'); block.onclick = () => review(item, 'block'); actions.append(block); }
        if (status === 'blocked') { const unblock = el('button', '', '取消屏蔽'); unblock.onclick = () => review(item, 'unblock'); actions.append(unblock); }
        const remove = el('button', 'danger', status === 'deleted' ? '已永久删除' : '删除实体'); remove.disabled = status === 'deleted'; remove.onclick = () => review(item, 'delete'); actions.append(remove);
        if (item.kind !== 'directory') {
            const lookup = el('button', '', '查询同内容引用'); lookup.type = 'button'; lookup.onclick = () => lookupFiles(item.id, 0, item); actions.append(lookup);
        }
        return actions;
    }
    const stateLabels = { READY: '可用', BROKEN: '正文异常', DELETE_PENDING: '等待安全清理', DELETING: '清理中 / 待重试', DELETED: '已清理' };
    function badge(value) { return el('span', 'content-state content-state-' + value, `${value} · ${stateLabels[value] || value}`); }
    function button(label, action) { const node = el('button', 'diagnostic-btn', label); node.type = 'button'; node.onclick = action; return node; }
    function positionCard(file) {
        const card = el('article', 'reference-card');
        const owner = file.user?.username || file.user?.name || file.owner_id;
        card.append(el('div', 'reference-owner', owner + ' · ' + (file.scope || '默认分区')),
            el('div', 'muted', `User ID：${file.owner_id}${file.user?.telegramId ? ' · TG ' + file.user.telegramId : ''}`),
            el('code', 'reference-path', file.full_path),
            el('div', 'muted', `文件 ID：${file.logical_file_id} · ${bytes(file.size)}${file.review_status === 'blocked' ? ' · 已屏蔽' : file.review_status === 'deleted' ? ' · 审核删除占位' : ''}`));
        const link = el('a', 'reference-location', '打开所在目录 ↗');
        link.href = file.location_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = file.full_path; card.append(link);
        return card;
    }
    function pagination(target, data, change) {
        clear(target); target.hidden = data.total <= data.limit;
        if (target.hidden) return;
        const prev = button('上一页', () => change(Math.max(0, data.offset - data.limit)));
        const next = button('下一页', () => change(data.offset + data.limit));
        prev.disabled = data.offset === 0; next.disabled = data.offset + data.limit >= data.total;
        target.append(prev, el('span', 'muted', `${Math.floor(data.offset / data.limit) + 1} / ${Math.max(1, Math.ceil(data.total / data.limit))} · ${data.total} 项`), next);
    }
    function cleanupTask(task) {
        const node = el('div', 'cleanup-detail');
        node.append(el('div', '', `${task.purpose} · ${task.state} · 尝试 ${task.attempts} 次 · revision ${task.revision ?? '—'}`),
            el('div', 'muted', task.state === 'CLAIMED' ? `本次领取：${time(task.claimed_at)}` : task.state === 'COMPLETED' ? '远端清理已完成' : `下次检查 / 重试：${time(task.retry_at)}`));
        if (task.error) node.append(el('div', 'cleanup-error', task.error));
        return node;
    }
    async function loadCleanup(offset = state.cleanupOffset) {
        const generation = ++state.cleanupGeneration;
        state.cleanupOffset = offset; $('contentCleanupRefresh').disabled = true; $('contentCleanupStatus').textContent = '正在读取清理状态…';
        try {
            const data = await request('/content-objects?' + new URLSearchParams({ state: $('contentCleanupState').value, limit: 50, offset }));
            if (generation !== state.cleanupGeneration) return;
            // Counts may shrink while the worker finishes a previous page.
            if (offset && !data.contents.length && data.total) return loadCleanup(Math.floor((data.total - 1) / data.limit) * data.limit);
            $('contentCleanupCounts').textContent = `DELETING ${data.counts.DELETING || 0} · DELETE_PENDING ${data.counts.DELETE_PENDING || 0}`;
            $('contentCleanupMode').textContent = data.cleanup_mode === 'observe' ? '当前为 observe：远端清理已暂停' : '当前为 execute：服务器自动处理清理队列';
            const target = $('contentCleanupList'); clear(target);
            for (const item of data.contents) {
                const card = el('article', 'content-object-card'), head = el('div', 'content-object-head');
                head.append(el('h3', '', item.original_name || '未命名正文'), badge(item.state));
                card.append(head, el('code', 'content-object-id', item.id),
                    el('div', 'content-object-meta', `${bytes(item.size)} · ${item.reference_count} 个引用 · ${item.active_leases} 个有效租约`),
                    el('div', 'muted', `创建：${time(item.created_at)} · 清理可执行时间：${time(item.cleanup_after)}`));
                for (const task of data.cleanup.filter(task => task.content_id === item.id)) card.append(cleanupTask(task));
                card.append(button('查看引用与清理详情', () => showContentDetail(item.id))); target.append(card);
            }
            if (!data.contents.length) target.append(el('div', 'lookup-empty', '当前筛选下没有待清理 Content Object。'));
            pagination($('contentCleanupPages'), data, loadCleanup); $('contentCleanupStatus').textContent = '';
        } catch (error) { if (generation === state.cleanupGeneration) $('contentCleanupStatus').textContent = '读取失败：' + error.message; }
        finally { if (generation === state.cleanupGeneration) $('contentCleanupRefresh').disabled = false; }
    }
    async function lookupFiles(q, offset = 0, selected = null) {
        const generation = ++state.lookupGeneration;
        ++state.detailGeneration; state.detailId = ''; $('contentReferenceResult').hidden = true;
        $('contentReferenceQuery').value = q; $('contentReferenceSearchBtn').disabled = true;
        $('contentReferenceStatus').textContent = '正在定位文件…';
        try {
            const data = await request('/content-reference-files?' + new URLSearchParams({ q, limit: 30, offset }));
            if (generation !== state.lookupGeneration) return;
            const target = $('contentReferenceMatches'); clear(target);
            for (const file of data.files) {
                const card = positionCard(file);
                const inspect = button(file.content_id ? `查看全部 ${file.reference_count} 个引用` : '没有活动 Content 绑定', () => showContentDetail(file.content_id, file));
                inspect.disabled = !file.content_id; card.append(inspect); target.append(card);
            }
            $('contentReferenceStatus').textContent = data.total ? `找到 ${data.total} 个文件；同名文件按账号及完整路径区分。` : '没有找到匹配文件。已彻底删除的 Logical 可从删除跟踪列表查看历史 Content。';
            pagination($('contentReferencePages'), data, next => lookupFiles(q, next));
            const chosen = selected ? data.files.find(file => file.logical_file_id === selected.id && file.owner_id === selected.userId && file.scope === (selected.diskSpace || '')) : data.total === 1 ? data.files[0] : null;
            if (chosen?.content_id) await showContentDetail(chosen.content_id, chosen);
            else if (selected) $('referenceTitle').scrollIntoView({ block: 'start' });
        } catch (error) { if (generation === state.lookupGeneration) $('contentReferenceStatus').textContent = '查询失败：' + error.message; }
        finally { if (generation === state.lookupGeneration) $('contentReferenceSearchBtn').disabled = false; }
    }
    async function showContentDetail(id, file = null, scroll = true) {
        const generation = ++state.detailGeneration, target = $('contentReferenceResult');
        state.detailId = id; target.hidden = false; clear(target); target.append(el('div', 'muted', '正在读取全部引用与清理详情…'));
        if (scroll) target.scrollIntoView({ block: 'start' });
        try {
            const data = await request('/content-objects/' + encodeURIComponent(id));
            if (generation !== state.detailGeneration) return;
            clear(target); const item = data.content;
            target.append(el('h3', '', file ? `指定文件：${file.full_path}` : `Content：${item.original_name || id}`), badge(item.state),
                el('div', 'content-object-meta', `${bytes(item.size)} · ${data.references.length} 个活动引用 · ${data.leases.length} 个有效租约 · ${item.hash_status}`),
                el('code', 'content-object-id', 'Content ID：' + item.id), el('code', 'content-object-id', 'Content Key：' + (item.content_key || '历史正文尚未验证完整 SHA')),
                button('刷新引用与详情', () => showContentDetail(id, file, false)));
            const groups = new Map();
            for (const ref of data.references) { const key = JSON.stringify([ref.owner_id, ref.scope]); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(ref); }
            for (const refs of groups.values()) {
                const user = refs[0].user;
                target.append(el('h4', 'reference-group-title', `${user.username || user.name || user.id} / ${refs[0].scope || '默认分区'} · ${refs.length} 个位置`));
                const grid = el('div', 'reference-grid'); refs.forEach(ref => grid.append(positionCard(ref))); target.append(grid);
            }
            if (!data.references.length) target.append(el('p', 'lookup-empty', '没有任何活动文件引用。频道消息是否已清理，请结合下面的清理任务和租约查看；审计行仍存在不代表能够复用。'));
            if (data.cleanup.length) { target.append(el('h4', 'reference-group-title', '清理任务')); data.cleanup.forEach(task => target.append(cleanupTask(task))); }
            if (data.leases.length) {
                target.append(el('h4', 'reference-group-title', '有效在途租约（临时保护，不是文件副本）'));
                data.leases.forEach(lease => target.append(el('div', 'cleanup-detail', `${lease.kind} · revision ${lease.revision} · 用户 ${lease.viewer_id || '系统'} · 到期 ${time(lease.expires_at)}${lease.upload_id ? ' · 任务 ' + lease.upload_id : ''}`)));
            }
            const physical = el('details'), summary = el('summary', '', `物理消息记录（含历史 revision）· ${data.anchors.length} 条`), wrap = el('div', 'table-wrap'), table = el('table');
            table.innerHTML = '<thead><tr><th>Chat ID</th><th>Message ID</th><th>Revision</th><th>角色</th><th>状态</th></tr></thead>';
            const body = el('tbody');
            for (const anchor of data.anchors) { const row = el('tr'); [anchor.channel_id, anchor.message_id, anchor.revision, anchor.role, anchor.state].forEach(value => row.append(el('td', '', value))); body.append(row); }
            table.append(body); wrap.append(table); physical.append(summary, wrap); target.append(physical);
        } catch (error) { if (generation === state.detailGeneration) { clear(target); target.append(el('div', 'diagnostic-status', '读取失败：' + error.message)); } }
    }
    async function review(item, action) {
        const words = action === 'block' ? '屏蔽后内容仅用户本人可见，且不可分享。' : action === 'unblock' ? '取消屏蔽后，内容可再次分享。' : '将从 Telegram 删除文件实体，并永久保留“已删除”占位；此操作不可恢复。';
        if (!confirm(`${words}\n\n${item.kind === 'directory' ? '目录' : '文件'}：${item.name}\n确定继续？`)) return;
        $('pageStatus').textContent = action === 'block' ? '正在屏蔽…' : action === 'unblock' ? '正在取消屏蔽…' : '正在删除 Telegram 文件实体…';
        try {
            const endpoint = item.kind === 'directory' ? '/directories/review' : '/reviews/' + encodeURIComponent(item.id);
            await request(endpoint, { method: 'PATCH', body: JSON.stringify({ user_id: item.userId, disk_space: item.diskSpace || '', path: item.path || '', action }) });
            await refresh(); $('pageStatus').textContent = '审核操作已完成。';
        } catch (error) { $('pageStatus').textContent = '审核失败：' + error.message; }
    }
    async function refresh() {
        $('refreshBtn').disabled = true;
        try {
            state.overview = await request('/storage-overview'); renderTree(); await renderReviews();
            if (!state.selected && initialLocation.has('user_id')) {
                for (const system of state.overview.systems) {
                    const user = system.users.find(user => user.userId === initialLocation.get('user_id'));
                    const space = user?.spaces.find(space => (space.diskSpace || '') === (initialLocation.get('disk_space') || ''));
                    if (space) { state.selected = { appId: system.appId, appLabel: system.label, userId: user.userId, user, ...space }; state.path = initialLocation.get('path') || ''; break; }
                }
                if (!state.selected) $('pageStatus').textContent = '链接指定的用户或分区已不存在，请从左侧重新选择。';
            }
            if (state.selected) await selectSpace(state.selected, state.path);
            await loadCleanup();
            if (state.detailId) await showContentDetail(state.detailId, null, false);
        } catch (error) { $('pageStatus').textContent = '刷新失败：' + error.message; }
        finally { $('refreshBtn').disabled = false; }
    }
    $('diskAdminPreviewClose').onclick = closePreview;
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('diskAdminPreview').hidden) closePreview(); });
    $('contentReferenceForm').onsubmit = event => { event.preventDefault(); lookupFiles($('contentReferenceQuery').value.trim()); };
    $('contentCleanupRefresh').onclick = () => loadCleanup();
    $('contentCleanupState').onchange = () => loadCleanup(0);
    $('refreshBtn').onclick = refresh; refresh();
})();
