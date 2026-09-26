(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const client = window.DiskClient;
    let grant = null, currentPath = '';
    const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
    const request = (url, options) => client.raw(url, options);
    const json = (method, body) => client.json(method, body);
    const base = '/api/telegram/drive';
    const scoped = path => `${base}/collaboration-scope/${encodeURIComponent(grant.id)}${path}`;
    const relative = path => {
        const value = String(path || '');
        return grant.path && value.startsWith(grant.path) ? value.slice(grant.path.length).replace(/^\//, '') : value;
    };
    const within = path => !grant.path || path === grant.path || path.startsWith(grant.path + '/');
    const child = (parent, name) => [parent, name].filter(Boolean).join('/');
    const run = async task => { try { status('正在处理…'); await task(); status('操作已完成'); await load(); } catch (error) { status(error.message || '操作失败', true); } };
    const button = (label, action) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.onclick = action; return node; };
    function renderBreadcrumbs() {
        const nav = $('breadcrumbs'); nav.replaceChildren();
        const root = button(grant.name || '协同目录', () => navigate(grant.path)); nav.append(root);
        if (grant.kind === 'file') return;
        let path = grant.path;
        for (const segment of relative(currentPath).split('/').filter(Boolean)) {
            nav.append(' › '); path = child(path, segment);
            const destination = path; nav.append(button(segment, () => navigate(destination)));
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
    function row(item, directory = false) {
        const line = document.createElement('div'); line.className = 'row';
        const icon = document.createElement('span'); icon.className = 'icon'; icon.textContent = directory ? '📁' : /^image\//.test(item.type) ? '🖼' : /^video\//.test(item.type) ? '🎞' : /^audio\//.test(item.type) ? '♫' : '📄';
        if (!directory && item.thumbnailAvailable) { const thumbnail = document.createElement('img'); thumbnail.src = scoped(`/files/${encodeURIComponent(item.id)}/thumbnail`); thumbnail.alt = ''; thumbnail.style.cssText = 'display:block;width:40px;height:40px;object-fit:cover;border-radius:6px'; icon.replaceChildren(thumbnail); }
        const name = document.createElement('div'); name.className = 'name'; name.append(button(item.name, () => directory ? navigate(item.path) : preview(item)));
        const meta = document.createElement('small'); meta.textContent = directory ? '目录' : `${(Number(item.size || 0) / 1024 / 1024).toFixed(2)} MB`;
        const actions = document.createElement('div'); actions.className = 'actions';
        if (!directory) actions.append(button('下载', () => { window.location.href = scoped(`/files/${encodeURIComponent(item.id)}/download`); }));
        if (!directory) actions.append(button('替换内容', () => {
            const chooser = document.createElement('input'); chooser.type = 'file'; chooser.hidden = true;
            chooser.onchange = () => {
                const replacement = chooser.files?.[0]; chooser.remove();
                if (!replacement || !confirm(`使用“${replacement.name}”替换“${item.name}”的内容？文件名称保持不变。`)) return;
                run(() => client.request('/files/' + encodeURIComponent(item.id) + '/repair', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Disk-File-Size': String(replacement.size), 'X-Disk-File-Type': replacement.type || item.type || 'application/octet-stream' }, body: replacement }));
            };
            document.body.append(chooser); chooser.click();
        }));
        actions.append(button('改名', () => run(async () => {
            const next = prompt('新的名称', item.name); if (!next || next === item.name) return;
            if (directory) await client.request('/directories', json('PATCH', { path: item.path, name: next }));
            else await client.request('/files/' + encodeURIComponent(item.id), json('PATCH', { name: next }));
        })));
        if (grant.kind === 'directory') {
            actions.append(button('移动', () => run(async () => {
                const suggested = relative(directory ? item.path : item.folderPath || currentPath);
                const next = prompt('目标目录（相对于受邀目录；留空表示协同根目录）', suggested);
                if (next === null) return;
                const destination = child(grant.path, next.replace(/^\/+|\/+$/g, ''));
                if (!within(destination)) throw new Error('目标目录超出协同范围');
                if (directory) await client.request('/directories', json('PATCH', { path: item.path, destinationPath: destination }));
                else await client.request('/files/' + encodeURIComponent(item.id), json('PATCH', { folderPath: destination }));
            })));
        }
        if (!(grant.kind === 'file' && item.id === grant.fileId)) actions.append(button('删除', () => run(async () => {
            if (!confirm(`确定删除“${item.name}”？`)) return;
            if (directory) await client.request('/directories?path=' + encodeURIComponent(item.path) + '&recursive=true', { method: 'DELETE' });
            else await client.request('/files/' + encodeURIComponent(item.id), { method: 'DELETE' });
        })));
        line.append(icon, name, meta, actions); return line;
    }
    async function load() {
        if (!grant) return;
        const fresh = await request(`${base}/collaborations/${encodeURIComponent(grant.id)}`);
        grant = fresh.collaboration;
        $('title').textContent = `Telegram 网盘 · 协同编辑：${grant.name}`;
        if (grant.kind === 'file') {
            const file = await request(`/files/${encodeURIComponent(grant.fileId)}`);
            $('toolbar').hidden = true; $('list').replaceChildren(row(file)); renderBreadcrumbs(); status(''); return;
        }
        if (!within(currentPath)) currentPath = grant.path;
        const data = await request('/list?path=' + encodeURIComponent(currentPath));
        renderBreadcrumbs(); $('list').replaceChildren(...(data.folders || []).map(item => row(item, true)), ...(data.files || []).map(item => row(item)));
        if (!(data.folders?.length || data.files?.length)) $('list').textContent = '此目录暂无文件';
        status('');
    }
    function navigate(path) { if (!within(path)) return; currentPath = path; load().catch(error => status(error.message, true)); }
    function closePreview() { const body = $('previewBody'); body.querySelectorAll('audio,video').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); }); body.replaceChildren(); $('preview').close(); }
    $('previewClose').onclick = closePreview;
    $('preview').addEventListener('cancel', event => { event.preventDefault(); closePreview(); });
    $('refreshBtn').onclick = () => load().catch(error => status(error.message, true));
    $('mkdirBtn').onclick = () => run(async () => { const name = prompt('新目录名称'); if (!name) return; await client.request('/directories', json('POST', { path: child(currentPath, name) })); });
    $('uploadBtn').onclick = () => $('fileInput').click();
    $('fileInput').onchange = event => { const files = [...event.target.files]; event.target.value = ''; if (!files.length) return; run(async () => { await client.upload(files, currentPath); }); };
    client.subscribe(jobs => { const pending = jobs.find(job => job.status === 'running' || job.status === 'queued'); if (pending) status(`${pending.title || '网盘任务'} · ${pending.phase || ''} · ${Number.isFinite(pending.percent) ? Math.round(pending.percent) + '%' : '处理中'}`); });
    async function init() {
        const parts = location.pathname.split('/').filter(Boolean);
        try {
            if (parts[1] === 'view') {
                grant = (await request(`${base}/collaborations/${encodeURIComponent(parts[2] || '')}`)).collaboration;
            } else {
                grant = (await request(`${base}/collaborations/join`, json('POST', { token: parts[1] || '' }))).collaboration;
                history.replaceState(null, '', `/disk-collab/view/${encodeURIComponent(grant.id)}`);
            }
            currentPath = grant.path;
            client.setCollaboration(grant.id);
            await load();
        } catch (error) {
            status(error.message === 'LOGIN_REQUIRED' ? '请先在功能首页登录 Telegram 网盘账号，然后返回此页面重试。' : `无法打开协同编辑：${error.message}`, true);
            $('list').innerHTML = '<div class="error-panel"><a href="/">前往功能首页</a> · <button type="button" id="retryJoin">重试</button></div>';
            $('retryJoin').onclick = () => location.reload();
            $('toolbar').hidden = true;
        }
    }
    init();
})();
