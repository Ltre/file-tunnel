(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const client = window.DiskClient;
    let grant = null, currentPath = '', loadVersion = 0, moving = false, picking = false, copying = false;
    let dragged = null, touchDrag = null, suppressClickUntil = 0;
    const embedded = window.parent !== window && new URLSearchParams(location.search).get('embedded') === '1';
    document.body.classList.toggle('embedded', embedded);
    $('returnHome').hidden = embedded;
    const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
    const request = (url, options) => client.raw(url, options);
    const json = (method, body) => client.json(method, body);
    const base = '/api/telegram/drive';
    const scoped = path => `${base}/collaboration-scope/${encodeURIComponent(grant.id)}${path}`;
    const navigation = new URLSearchParams(location.search);
    const requestedPath = navigation.get('path');
    let focusFileId = navigation.get('file_id') || '';
    const safeDirectoryPath = (value, root) => {
        if (typeof value !== 'string' || value.length > 2048 || value.includes('\\') || value.startsWith('/') || value.endsWith('/') || value.includes('//')) return root;
        const parts = value.split('/');
        if (parts.length > 20 || parts.some(part => !part || part !== part.trim() || part === '.' || part === '..' || part.length > 100 || /[\\/:*?"<>|\u0000-\u001f]/.test(part))) return root;
        return !root || value === root || value.startsWith(root + '/') ? value : root;
    };
    const relative = path => {
        const value = String(path || '');
        return grant.path && within(value) ? value.slice(grant.path.length).replace(/^\//, '') : value;
    };
    const within = path => !grant.path || path === grant.path || path.startsWith(grant.path + '/');
    const child = (parent, name) => [parent, name].filter(Boolean).join('/');
    const canEdit = () => grant?.role === 'editor' || grant?.role === 'owner';
    const run = async task => { try { status('正在处理…'); await task(); status('操作已完成'); await load(); } catch (error) { status(error.message || '操作失败', true); } };
    const button = (label, action) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.onclick = action; return node; };
    function openActionDialog({ title, body, confirmText = '确定', validate = () => true }) {
        const dialog = document.createElement('dialog'); dialog.className = 'collab-action-dialog';
        const heading = document.createElement('h2'); heading.textContent = title;
        const content = document.createElement('div'); content.className = 'collab-dialog-body'; content.append(...(Array.isArray(body) ? body : [body]));
        const error = document.createElement('p'); error.className = 'error'; error.setAttribute('role', 'alert');
        const actions = document.createElement('footer');
        let done = false;
        return new Promise(resolve => {
            const finish = result => { if (done) return; done = true; dialog.close(); dialog.remove(); resolve(result); };
            const cancel = button('取消', () => finish(null));
            const accept = button(confirmText, async () => {
                if (accept.disabled) return; accept.disabled = true; error.textContent = '';
                try { const result = await validate(); if (!done && result !== false) finish(result); }
                catch (cause) { if (!done) error.textContent = cause.message || '操作失败'; }
                finally { accept.disabled = false; }
            });
            accept.className = 'primary'; actions.append(cancel, accept); dialog.append(heading, content, error, actions);
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
            dialog.addEventListener('click', event => { if (event.target === dialog) finish(null); });
            document.body.append(dialog); dialog.showModal();
        });
    }
    function validDestination(item, destination) {
        return canEdit() && grant?.kind === 'directory' && within(destination) &&
            !(item.kind === 'directory' && (destination === item.path || destination.startsWith(item.path + '/'))) &&
            destination !== (item.kind === 'directory' ? item.path.split('/').slice(0, -1).join('/') : item.folderPath || currentPath);
    }
    async function moveItem(item, destination, { confirmed = false } = {}) {
        if (moving || !validDestination(item, destination)) return;
        moving = true;
        try {
            const text = document.createElement('p'); text.textContent = `确定要把“${item.name}”移动到 ${grant.name}/${relative(destination)} 吗？`;
            if (!confirmed && await openActionDialog({ title: '确认移动', body: text, confirmText: '移动' }) === null) return;
            await run(async () => {
                if (item.kind === 'directory') await client.request('/directories', json('PATCH', { path: item.path, destinationPath: destination }));
                else await client.request('/files/' + encodeURIComponent(item.id), json('PATCH', { folderPath: destination }));
            });
        } finally { moving = false; }
    }
    async function chooseMove(item) {
        if (!canEdit() || moving || picking) return;
        picking = true;
        let created = false;
        try {
            status('正在加载目录选择器…');
            const destination = await window.DiskDirectoryPicker.choose({ items: [item], title: `移动“${item.name}”`, confirmText: '移动',
                rootPath: grant.path, rootName: grant.name, initialPath: currentPath,
                loadDirectories: () => request('/directories'), createDirectory: path => client.request('/directories', json('POST', { path })),
                openDialog: openActionDialog, onCreateDirectory: () => { created = true; }, showError: error => status(error.message, true) });
            if (destination !== null) {
                if (!validDestination(item, destination)) return status('项目已经在该目录中，或目标为自身 / 子目录。');
                await moveItem(item, destination, { confirmed: true });
            } else { if (created) await load(); status(''); }
        } catch (error) { status(error.message, true); } finally { picking = false; }
    }
    function endDrag() {
        clearTimeout(touchDrag?.timer); if (touchDrag?.frame) cancelAnimationFrame(touchDrag.frame);
        touchDrag?.ghost?.remove(); touchDrag = null; dragged = null;
        document.querySelectorAll('.drop-target,.dragging').forEach(node => node.classList.remove('drop-target', 'dragging'));
    }
    function highlightDrop(x, y) {
        document.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target'));
        const target = document.elementFromPoint(x, y)?.closest('[data-drop-path]');
        if (target && dragged && validDestination(dragged, target.dataset.dropPath)) { target.classList.add('drop-target'); return target; }
        return null;
    }
    function installDrop(node, path) {
        node.dataset.dropPath = path;
        node.addEventListener('dragover', event => {
            if (!dragged) return;
            event.preventDefault(); event.stopPropagation();
            const allowed = validDestination(dragged, node.dataset.dropPath);
            event.dataTransfer.dropEffect = allowed ? 'move' : 'none'; node.classList.toggle('drop-target', allowed);
        });
        node.addEventListener('dragleave', event => { if (!node.contains(event.relatedTarget)) node.classList.remove('drop-target'); });
        node.addEventListener('drop', event => {
            if (!dragged) return;
            event.preventDefault(); event.stopPropagation(); const item = dragged; endDrag();
            moveItem(item, node.dataset.dropPath).catch(error => status(error.message, true));
        });
    }
    function installDrag(node, item) {
        if (grant.kind !== 'directory' || !canEdit()) return;
        node.draggable = true;
        node.addEventListener('pointerdown', event => { node.draggable = event.pointerType !== 'touch'; });
        node.addEventListener('dragstart', event => {
            if (moving || picking || event.target.closest('.actions')) { event.preventDefault(); return; }
            dragged = item; node.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-drop2tunnel-collaboration', item.id || item.path);
        });
        node.addEventListener('dragend', endDrag);
        node.addEventListener('contextmenu', event => { if (!event.target.closest('.actions')) event.preventDefault(); });
        node.addEventListener('touchstart', event => {
            // Touch uses our long-press gesture; never start the browser's native HTML drag.
            node.draggable = false;
            endDrag();
            if (moving || picking || event.touches.length !== 1 || event.target.closest('.actions')) return;
            const point = event.touches[0];
            const state = touchDrag = { x: point.clientX, y: point.clientY, active: false, item };
            state.timer = setTimeout(() => {
                if (touchDrag !== state) return;
                state.active = true; dragged = item; node.classList.add('dragging');
                const ghost = state.ghost = document.createElement('div'); ghost.className = 'collab-drag-label'; ghost.textContent = '移动：' + item.name; document.body.append(ghost);
                const tick = () => {
                    if (touchDrag !== state) return;
                    ghost.style.left = state.x + 'px'; ghost.style.top = state.y + 'px';
                    const rect = $('list').getBoundingClientRect();
                    if (state.y > rect.top && state.y < rect.bottom && state.x > rect.left && state.x < rect.right) {
                        if (state.y < rect.top + 36) $('list').scrollTop -= 12;
                        else if (state.y > rect.bottom - 36) $('list').scrollTop += 12;
                    }
                    highlightDrop(state.x, state.y); state.frame = requestAnimationFrame(tick);
                };
                tick();
            }, 430);
        }, { passive: true });
        node.addEventListener('touchmove', event => {
            if (!touchDrag) return;
            if (event.touches.length !== 1) { endDrag(); return; }
            const point = event.touches[0], state = touchDrag;
            if (!state.active && Math.hypot(point.clientX - state.x, point.clientY - state.y) > 8) { endDrag(); return; }
            if (state.active) { event.preventDefault(); event.stopPropagation(); state.x = point.clientX; state.y = point.clientY; }
        }, { passive: false });
        node.addEventListener('touchend', event => {
            const state = touchDrag;
            if (!state) return;
            if (!state.active) { endDrag(); return; }
            event.preventDefault(); event.stopPropagation(); suppressClickUntil = Date.now() + 700;
            const target = highlightDrop(state.x, state.y), destination = target?.dataset.dropPath;
            endDrag(); if (destination !== undefined) moveItem(state.item, destination).catch(error => status(error.message, true));
        }, { passive: false });
        node.addEventListener('touchcancel', endDrag);
    }
    function renderBreadcrumbs() {
        const nav = $('breadcrumbs'); nav.replaceChildren();
        const root = button(grant.name || '协同目录', () => navigate(grant.path)); nav.append(root);
        if (grant.kind === 'file') return;
        if (canEdit()) installDrop(root, grant.path);
        let path = grant.path;
        for (const segment of relative(currentPath).split('/').filter(Boolean)) {
            nav.append(' › '); path = child(path, segment);
            const destination = path, target = button(segment, () => navigate(destination)); if (canEdit()) installDrop(target, destination); nav.append(target);
        }
    }
    function preview(file) {
        const body = $('previewBody'); body.replaceChildren(); $('previewName').textContent = file.name;
        const url = client.streamUrl(file, { purpose: 'collaboration-preview', fresh: true });
        let media;
        if (String(file.type).startsWith('image/')) media = document.createElement('img');
        else if (String(file.type).startsWith('video/')) media = document.createElement('video');
        else if (String(file.type).startsWith('audio/')) media = document.createElement('audio');
        else { window.open(scoped(`/files/${encodeURIComponent(file.id)}/download`), '_blank', 'noopener'); return; }
        media.src = url; if (media.tagName !== 'IMG') { media.controls = true; media.preload = 'metadata'; }
        body.append(media); $('preview').showModal();
    }
    async function waitDestinationDirectory(scope, response) {
        if (response.status === 'completed') return response.result;
        if (!response.operation_id) return response;
        for (let attempt = 0; attempt < 120; attempt++) {
            const operation = await request(scope + '/operations/' + encodeURIComponent(response.operation_id));
            if (operation.status === 'completed') return operation.result;
            if (['failed', 'cancelled'].includes(operation.status)) throw new Error(operation.error || '创建目录失败');
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error('创建目录超时，请刷新目标协同项目检查结果');
    }
    async function copyToAnotherCollaboration(item) {
        if (copying) return;
        copying = true;
        try {
            const entries = (await request(`${base}/collaborations`)).collaborations || [];
            const targets = entries.filter(entry => !entry.owned && entry.kind === 'directory' && entry.role === 'editor' && entry.id !== grant.id);
            if (!targets.length) return status('没有可写的其它协同项目。');
            const explanation = document.createElement('p'); explanation.textContent = '选择有编辑权限的协同项目；本次只复制内容，来源项目不会被移动或删除。';
            const label = document.createElement('label'); label.textContent = '目标协同项目';
            const select = document.createElement('select'); select.setAttribute('aria-label', '目标协同项目');
            for (const entry of targets) {
                const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.name;
                select.append(option);
            }
            label.append(select);
            const selectedId = await openActionDialog({ title:'复制到另一个协同项目', body:[explanation, label], confirmText:'选择目标目录', validate:() => select.value });
            if (!selectedId) return;
            const target = (await request(`${base}/collaborations/${encodeURIComponent(selectedId)}`)).collaboration;
            if (!target || target.owned || target.kind !== 'directory' || target.role !== 'editor' || target.id === grant.id)
                throw new Error('目标协同项目已不可写，请重新选择');
            const scope = `${base}/collaboration-scope/${encodeURIComponent(target.id)}`;
            const destinationPath = await window.DiskDirectoryPicker.choose({
                title:`复制“${item.name}”到 ${target.name}`, confirmText:'复制', rootPath:target.path, rootName:target.name, initialPath:target.path,
                loadDirectories:() => request(scope + '/directories'),
                createDirectory:async path => waitDestinationDirectory(scope, await request(scope + '/directories', json('POST', { path }))),
                openDialog:openActionDialog, showError:error => status(error.message || '目标目录选择失败', true)
            });
            if (destinationPath === null) return;
            status('正在复制到目标协同项目…');
            const result = await request(`${base}/cross-scope/copy`, json('POST', {
                mode:'copy',
                source:{ kind:'collaboration', collaborationId:grant.id,
                    selection:item.kind === 'directory' ? { kind:'directory', path:item.path } : { kind:'file', id:item.id } },
                target:{ kind:'collaboration', collaborationId:target.id, destinationPath }
            }));
            status(`已复制 ${result.copied?.length || 0} 个文件到“${target.name}”/${result.destination || ''}；来源项目仍保留。`);
        } catch (error) { status('复制失败：' + (error.message || '操作失败'), true); }
        finally { copying = false; }
    }
    function row(item, directory = false) {
        item = { ...item, kind: directory ? 'directory' : 'file' };
        const line = document.createElement('div'); line.className = 'row';
        if (!directory) line.dataset.fileId = String(item.id || '');
        installDrag(line, item); if (directory && canEdit()) installDrop(line, item.path);
        const icon = document.createElement('span'); icon.className = 'icon'; icon.textContent = directory ? '📁' : /^image\//.test(item.type) ? '🖼' : /^video\//.test(item.type) ? '🎞' : /^audio\//.test(item.type) ? '♫' : '📄';
        if (!directory && item.thumbnailAvailable) { const thumbnail = document.createElement('img'); thumbnail.src = scoped(`/files/${encodeURIComponent(item.id)}/thumbnail`); thumbnail.alt = ''; thumbnail.style.cssText = 'display:block;width:40px;height:40px;object-fit:cover;border-radius:6px'; icon.replaceChildren(thumbnail); }
        const name = document.createElement('div'); name.className = 'name'; name.append(button(item.name, () => directory ? navigate(item.path) : preview(item)));
        const meta = document.createElement('small'); meta.textContent = directory ? '目录' : `${(Number(item.size || 0) / 1024 / 1024).toFixed(2)} MB`;
        const actions = document.createElement('div'); actions.className = 'actions';
        if (!directory) actions.append(button('下载', () => { window.location.href = scoped(`/files/${encodeURIComponent(item.id)}/download`); }));
        if (!grant.owned) actions.append(button('转存到我的网盘', async () => {
            try {
                const target = await window.DiskCopyPicker.choose(`转存“${item.name}”到自己的网盘`);
                if (!target) return;
                const result = await request(`${base}/collaborations/${encodeURIComponent(grant.id)}/copy`,
                    json('POST', { selection: directory ? { kind: 'directory', path: item.path } : { kind: 'file', id: item.id }, ...target }));
                status(`已转存 ${result.copied.length} 个文件到自己的网盘：/${result.destination}`);
            } catch (error) { status(error.message === 'CONTENT_COPY_SELF_OWNED' ? '这是您自己拥有的资源，无需转存。' : '转存失败：' + error.message, true); }
        }));
        if (!grant.owned) actions.append(button('复制到另一个协同项目', () => copyToAnotherCollaboration(item)));
        if (canEdit() && !directory) actions.append(button('替换内容', () => {
            const chooser = document.createElement('input'); chooser.type = 'file'; chooser.hidden = true;
            chooser.onchange = () => {
                const replacement = chooser.files?.[0]; chooser.remove();
                if (!replacement || !confirm(`使用“${replacement.name}”替换“${item.name}”的内容？文件名称保持不变。`)) return;
                run(() => client.request('/files/' + encodeURIComponent(item.id) + '/repair', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Disk-File-Size': String(replacement.size), 'X-Disk-File-Type': replacement.type || item.type || 'application/octet-stream' }, body: replacement }));
            };
            document.body.append(chooser); chooser.click();
        }));
        if (canEdit()) actions.append(button('改名', () => run(async () => {
            const next = prompt('新的名称', item.name); if (!next || next === item.name) return;
            if (directory) await client.request('/directories', json('PATCH', { path: item.path, name: next }));
            else await client.request('/files/' + encodeURIComponent(item.id), json('PATCH', { name: next }));
        })));
        if (canEdit() && grant.kind === 'directory') {
            actions.append(button('移动', () => chooseMove(item)));
        }
        if (canEdit() && !(grant.kind === 'file' && item.id === grant.fileId)) actions.append(button('删除', () => run(async () => {
            if (!confirm(`确定删除“${item.name}”？`)) return;
            if (directory) await client.request('/directories?path=' + encodeURIComponent(item.path) + '&recursive=true', { method: 'DELETE' });
            else await client.request('/files/' + encodeURIComponent(item.id), { method: 'DELETE' });
        })));
        line.append(icon, name, meta, actions); return line;
    }
    async function load() {
        if (!grant) return;
        const version = ++loadVersion;
        const fresh = await request(`${base}/collaborations/${encodeURIComponent(grant.id)}`);
        if (version !== loadVersion) return;
        grant = fresh.collaboration;
        if (!canEdit()) endDrag();
        $('uploadBtn').hidden = !canEdit();
        $('mkdirBtn').hidden = !canEdit();
        $('title').textContent = `Telegram 网盘 · ${canEdit() ? '协同编辑' : '协同查看（只读）'}：${grant.name}`;
        if (grant.kind === 'file') {
            const file = await request(`/files/${encodeURIComponent(grant.fileId)}`);
            if (version !== loadVersion) return;
            $('toolbar').hidden = true; $('list').replaceChildren(row(file)); renderBreadcrumbs(); status(''); return;
        }
        if (!within(currentPath)) currentPath = grant.path;
        const data = await request('/list?path=' + encodeURIComponent(currentPath));
        if (version !== loadVersion) return;
        renderBreadcrumbs(); $('list').replaceChildren(...(data.folders || []).map(item => row(item, true)), ...(data.files || []).map(item => row(item)));
        if (focusFileId) {
            const match = [...$('list').children].find(line => line.dataset?.fileId === focusFileId);
            if (match) { focusFileId = ''; match.scrollIntoView?.({ block:'center', behavior:'smooth' }); match.classList.add('collab-located'); }
        }
        if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
            const url = new URL(location.pathname + location.search, location.origin);
            if (currentPath && currentPath !== grant.path) url.searchParams.set('path', currentPath);
            else url.searchParams.delete('path');
            history.replaceState(null, '', url.pathname + url.search);
        }
        $('list').dataset.dropPath = currentPath;
        if (!(data.folders?.length || data.files?.length)) $('list').textContent = '此目录暂无文件';
        status('');
    }
    function navigate(path) { if (!within(path)) return; currentPath = path; load().catch(error => status(error.message, true)); }
    function closePreview() { const body = $('previewBody'); body.querySelectorAll('audio,video').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); }); body.replaceChildren(); $('preview').close(); }
    installDrop($('list'), '');
    document.addEventListener('click', event => {
        // Suppress the touch release's synthetic click, never the confirmation dialog's buttons.
        if (Date.now() < suppressClickUntil && event.target.closest('#list,#breadcrumbs')) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    document.addEventListener('keydown', event => {
        if (embedded && event.key === 'Escape' && !document.querySelector('dialog[open]')) {
            event.preventDefault(); window.parent.postMessage({ type: 'disk-collaboration:close' }, location.origin);
        }
    });
    window.addEventListener('pagehide', () => { endDrag(); closePreview(); client.stop(); });
    $('previewClose').onclick = closePreview;
    $('preview').addEventListener('cancel', event => { event.preventDefault(); closePreview(); });
    $('refreshBtn').onclick = () => load().catch(error => status(error.message, true));
    $('mkdirBtn').onclick = () => { if (!canEdit()) return; run(async () => { const name = prompt('新目录名称'); if (!name) return; await client.request('/directories', json('POST', { path: child(currentPath, name) })); }); };
    $('uploadBtn').onclick = () => { if (canEdit()) $('fileInput').click(); };
    $('fileInput').onchange = event => { const files = [...event.target.files]; event.target.value = ''; if (!canEdit() || !files.length) return; run(async () => { await client.upload(files, currentPath); }); };
    client.subscribe(jobs => { const pending = jobs.find(job => job.status === 'running' || job.status === 'queued'); if (pending) status(`${pending.title || '网盘任务'} · ${pending.phase || ''} · ${Number.isFinite(pending.percent) ? Math.round(pending.percent) + '%' : '处理中'}`); });
    function showInvitation(invitation, token) {
        $('toolbar').hidden = true; $('breadcrumbs').replaceChildren();
        const card = document.createElement('article'); card.className = 'invitation-card';
        const heading = document.createElement('h2'); heading.textContent = '协同编辑邀请';
        const description = document.createElement('p'); description.textContent = `${invitation.ownerName} 邀请你协同编辑${invitation.kind === 'directory' ? '目录' : '文件'}“${invitation.name}”。`;
        const details = document.createElement('p'); details.textContent = invitation.kind === 'directory'
            ? `包含 ${invitation.fileCount} 个文件、${invitation.folderCount} 个子目录 · 总大小 ${formatSize(invitation.size)}`
            : `文件大小：${formatSize(invitation.size)}`;
        const actions = document.createElement('div'); actions.className = 'invitation-actions';
        const accept = button('确认加入协同编辑', async () => {
            accept.disabled = true; cancel.disabled = true;
            try {
                grant = (await request(`${base}/collaborations/join`, json('POST', { token }))).collaboration;
                history.replaceState(null, '', `/disk-collab/view/${encodeURIComponent(grant.id)}`);
                card.remove(); currentPath = grant.path; client.setCollaboration(grant.id); $('toolbar').hidden = false; await load();
            } catch (error) { accept.disabled = false; cancel.disabled = false; status(error.message || '加入协同失败', true); }
        });
        const cancel = button('取消', () => { card.remove(); status('已取消，本账号没有加入协同编辑。'); });
        actions.append(accept, cancel); card.append(heading, description, details, actions); $('list').replaceChildren(card);
        status('请确认邀请内容后再加入。');
    }
    const formatSize = value => { const size = Number(value) || 0; return size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`; };
    async function init() {
        const parts = location.pathname.split('/').filter(Boolean);
        try {
            if (parts[1] === 'view') {
                grant = (await request(`${base}/collaborations/${encodeURIComponent(parts[2] || '')}`)).collaboration;
            } else {
                const token = parts[1] || '';
                const invitation = (await request(`${base}/collaborations/invitations/${encodeURIComponent(token)}/preview`)).invitation;
                if (!invitation.owned) { showInvitation(invitation, token); return; }
                // Owners locate their own project in the normal drive; do not consume the invitation.
                location.replace('/disk?collaboration=' + encodeURIComponent(invitation.id));
                return;
            }
            currentPath = grant.kind === 'directory' && requestedPath ? safeDirectoryPath(requestedPath, grant.path) : grant.path;
            client.setCollaboration(grant.id);
            try {
                if (currentPath !== grant.path) await request('/directories/properties?path=' + encodeURIComponent(currentPath));
                await load();
            }
            catch (error) {
                if (currentPath === grant.path || !['DIRECTORY_NOT_FOUND', 'COLLABORATION_OUT_OF_SCOPE'].includes(error.message)) throw error;
                currentPath = grant.path;
                await load();
                status('搜索结果所在目录已变化，已返回协同根目录。');
            }
        } catch (error) {
            status(error.message === 'LOGIN_REQUIRED' ? '请先在功能首页登录 Telegram 网盘账号，然后返回此页面重试。' : `无法打开协同编辑：${error.message}`, true);
            $('list').innerHTML = '<div class="error-panel">' + (embedded ? '请关闭协同浮层并在原网盘登录。' : '<a href="/">前往功能首页</a>') + ' · <button type="button" id="retryJoin">重试</button></div>';
            $('retryJoin').onclick = () => location.reload();
            $('toolbar').hidden = true;
        }
    }
    init();
})();
