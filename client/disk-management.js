'use strict';
(function () {
    const api = '/api/telegram/disk-admin';
    const $ = id => document.getElementById(id);
    const state = { overview: null, selected: null, path: '' };
    const text = value => String(value ?? '');
    const bytes = value => {
        let size = Number(value) || 0; const units = ['B', 'KB', 'MB', 'GB', 'TB']; let index = 0;
        while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
        return `${size.toFixed(index ? 1 : 0)} ${units[index]}`;
    };
    const time = value => Number(value) ? new Date(Number(value)).toLocaleString('zh-CN') : '—';
    async function request(path, options = {}) {
        const response = await fetch(api + path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, cache: 'no-store' });
        if (response.status === 401) { location.href = '/admin-auth.html?next=' + encodeURIComponent(location.pathname); throw new Error('管理会话已失效'); }
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP_${response.status}`);
        return response.json();
    }
    const clear = node => node.replaceChildren();
    function el(tag, className, content) {
        const node = document.createElement(tag); if (className) node.className = className;
        if (content !== undefined) node.textContent = content; return node;
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
            const data = await request('/storage-contents?' + query); renderContents(data); $('pageStatus').textContent = '';
        } catch (error) { $('pageStatus').textContent = '加载失败：' + error.message; }
    }
    function renderContents(data) {
        const bread = $('contentBreadcrumbs'); clear(bread); const parts = state.path.split('/').filter(Boolean);
        for (let index = 0; index <= parts.length; index++) {
            const button = el('button', '', index ? parts[index - 1] : '根目录'); button.onclick = () => selectSpace(state.selected, parts.slice(0, index).join('/')); bread.append(button);
        }
        const rows = [...(data.folders || []).map(folder => ({ ...folder, kind: 'directory' })), ...(data.files || [])];
        $('contentSummary').textContent = `${data.folders?.length || 0} 个目录，${data.files?.length || 0} 个文件；来源系统：${state.selected.appLabel}（${state.selected.appId}）`;
        renderFileTable($('contentTable'), rows, true);
    }
    function renderFileTable(target, rows, navigable) {
        clear(target); if (!rows.length) { target.append(el('div', 'empty', '没有内容。')); return; }
        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>名称</th><th>类型 / 状态</th><th>大小</th><th>所属用户 / 分区</th><th>来源</th><th>时间</th></tr></thead>';
        const body = document.createElement('tbody');
        for (const item of rows) {
            const row = document.createElement('tr'), nameCell = document.createElement('td');
            if (navigable && item.kind === 'directory') { const button = el('button', 'name-button', '📁 ' + item.name); button.onclick = () => selectSpace(state.selected, item.path); nameCell.append(button); }
            else nameCell.textContent = (item.kind === 'directory' ? '📁 ' : '📄 ') + item.name;
            const status = item.reviewStatus || 'active';
            const labels = { active: '正常', blocked: '已屏蔽（仅本人可见）', deleted: '实体已删除（保留占位）' };
            const statusCell = el('td', 'status-' + status, item.kind === 'directory' ? '目录' : `${item.type || '文件'} · ${labels[status] || status}`);
            row.append(nameCell, statusCell, el('td', '', item.kind === 'directory' ? '—' : bytes(item.size)), el('td', '', item.userId ? `${item.user?.username || item.user?.name || item.userId} / ${item.diskSpace || '默认分区'}` : state.selected?.userId || '—'), el('td', '', item.appId || item.sourceAppId || state.selected?.appId || '—'), el('td', '', time(item.createdAt || item.updatedAt)));
            body.append(row);
        }
        table.append(body); target.append(table);
    }
    async function renderReviews() {
        const data = await request('/reviews'), target = $('reviewTable'); clear(target);
        if (!data.files.length) { target.append(el('div', 'empty', '暂无待审文件流水。')); return; }
        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>文件</th><th>用户 / 分区</th><th>来源</th><th>大小 / 时间</th><th>状态</th><th>审核操作</th></tr></thead>';
        const body = document.createElement('tbody');
        for (const file of data.files) {
            const row = document.createElement('tr');
            const status = file.reviewStatus || 'active', statusText = status === 'blocked' ? '已屏蔽' : status === 'deleted' ? '实体已删除' : '正常';
            const actions = el('td', 'review-actions');
            const block = el('button', '', status === 'blocked' ? '已屏蔽' : '屏蔽'); block.disabled = status !== 'active'; block.onclick = () => review(file, 'block');
            const remove = el('button', 'danger', status === 'deleted' ? '已删除实体' : '删除实体'); remove.disabled = status === 'deleted'; remove.onclick = () => review(file, 'delete'); actions.append(block, remove);
            row.append(el('td', '', `${file.name}\n${file.folderPath || '根目录'}`), el('td', '', `${file.user?.username || file.user?.name || file.userId}\n${file.diskSpace || '默认分区'}`), el('td', '', file.appId), el('td', '', `${bytes(file.size)}\n${time(file.createdAt)}`), el('td', 'status-' + status, statusText), actions); body.append(row);
        }
        table.append(body); target.append(table);
    }
    async function review(file, action) {
        const words = action === 'block' ? '屏蔽后文件仅用户本人可见，且所有既有分享都会立即失效。' : '将从 Telegram 删除文件实体，并永久保留“已删除”占位供用户自行清理。';
        if (!confirm(`${words}\n\n文件：${file.name}\n确定继续？`)) return;
        $('pageStatus').textContent = action === 'block' ? '正在屏蔽文件…' : '正在删除 Telegram 文件实体…';
        try {
            await request('/reviews/' + encodeURIComponent(file.id), { method: 'PATCH', body: JSON.stringify({ user_id: file.userId, disk_space: file.diskSpace || '', action }) });
            await refresh(); $('pageStatus').textContent = '审核操作已完成。';
        } catch (error) { $('pageStatus').textContent = '审核失败：' + error.message; }
    }
    async function refresh() {
        $('refreshBtn').disabled = true;
        try {
            state.overview = await request('/storage-overview'); renderTree(); await renderReviews();
            if (state.selected) await selectSpace(state.selected, state.path);
        } catch (error) { $('pageStatus').textContent = '刷新失败：' + error.message; }
        finally { $('refreshBtn').disabled = false; }
    }
    $('refreshBtn').onclick = refresh; refresh();
})();
